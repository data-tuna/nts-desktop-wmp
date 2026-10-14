// Serves the skin page for a browser, as the skin protocol does but without
// its CSP or its message checks: the page, engine.js (run `npm run
// build:skin` first), one .wmz, and a /msg sink that prints what the skin
// sends. A stand-in host in the page answers the skin with state, as the
// trusted page does, but plays nothing. For looking at the engine without
// the app. tools/compat.mjs drives it too.
//
//   node tools/skin-preview.mjs C:\path\to\skin.wmz [port]
//   then open http://localhost:1432/ (or /?play, to start playing as the app does)
import { createServer } from "node:http";
import { readFileSync } from "node:fs";

const root = new URL("..", import.meta.url);

// The trusted page's side of the protocol, in miniature: NTS 1, NTS 2 and a
// stand-in mixtape and pick, a clock while playing, and the settings the skin sends.
const fakeHost = `<script>
(() => {
  const titles = ["NTS 1: A show - London", "NTS 2", "Poolside - a mixtape", "Someone on SoundCloud - A pick"];
  const links = ["", "", "", "https://soundcloud.com/"];
  const go = (i) => Object.assign(s, { channel: i, title: titles[i], author: i ? "" : "A show", location: i ? "" : "London", link: links[i], url: links[i], time: 0 });
  const s = { type: "state", playState: location.search.includes("play") ? "playing" : "stopped", channel: 0, title: titles[0], url: "", author: "A show", location: "London", link: "", items: titles, time: 0, duration: 0, volume: 0.8, mute: false, balance: 0, eq: Array(10).fill(0), level: 0 };
  const post = window.fetch.bind(window);
  window.fetch = (url, init) => {
    if (url === "/msg") {
      const m = JSON.parse(init.body);
      if (m.type === "play") s.playState = "playing";
      else if (m.type === "pause" || m.type === "stop") Object.assign(s, { playState: m.type === "pause" ? "paused" : "stopped", time: 0 });
      else if (m.type === "next" || m.type === "previous") go((s.channel + (m.type === "next" ? 1 : titles.length - 1)) % titles.length);
      else if (m.type === "select") go(m.index % titles.length);
      else if (m.type === "eq") s.eq[m.band] = m.gain;
      else if (["volume", "mute", "balance"].includes(m.type)) s[m.type] = m.value;
    }
    return post(url, init);
  };
  setInterval(() => {
    if (s.playState === "playing") s.time += 0.25;
    window.dispatchEvent(new MessageEvent("message", { data: { ...s, eq: [...s.eq] } }));
  }, 250);
})();
</script>`;

/** Serves the page and the skin `wmz()` names; each message the skin sends
 * goes to `onMsg`, and `onHouse` hears when the page falls back to the house skin. */
export function preview(port, wmz, onMsg, onHouse = () => {}) {
  return createServer((req, res) => {
    if (req.method === "POST" && req.url === "/msg") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        try {
          onMsg(JSON.parse(body));
          res.writeHead(204).end();
        } catch {
          res.writeHead(400).end();
        }
      });
      return;
    }
    try {
      const path = new URL(req.url, "http://x").pathname;
      if (path === "/skin.wmz") return res.writeHead(200).end(readFileSync(wmz()));
      if (path === "/house.wmz") return onHouse(), res.writeHead(200).end(readFileSync(new URL("skins/house/house.wmz", root)));
      if (path === "/engine.js") return res.writeHead(200, { "Content-Type": "text/javascript" }).end(readFileSync(new URL("dist-skin/engine.js", root)));
      if (path !== "/") return res.writeHead(404).end();
      const page = readFileSync(new URL("src/skin/index.html", root), "utf8").replace('<script src="/engine.js">', `${fakeHost}<script src="/engine.js">`);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(page);
    } catch (e) {
      res.writeHead(500).end(String(e));
    }
  }).listen(+port);
}

if (import.meta.url.endsWith(process.argv[1].replaceAll("\\", "/").split("/").pop())) {
  const [wmz, port = "1432"] = process.argv.slice(2);
  if (!wmz) {
    console.error("usage: node tools/skin-preview.mjs <skin.wmz> [port]");
    process.exit(1);
  }
  preview(port, () => wmz, (msg) => {
    if (msg.type === "shape") msg.rects = `${msg.rects.length} runs`;
    console.log(JSON.stringify(msg));
  });
  console.log(`http://localhost:${port}/`);
}
