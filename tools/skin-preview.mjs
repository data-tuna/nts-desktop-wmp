// Serves the skin page as the skin protocol does, for a browser: the page,
// engine.js (run `npm run build:skin` first), one .wmz, and a /msg sink that
// prints what the skin sends. For looking at the engine without the app.
//
//   node tools/skin-preview.mjs C:\path\to\skin.wmz [port]
//   then open http://localhost:1432/
import { createServer } from "node:http";
import { readFileSync } from "node:fs";

const [wmz, port = "1432"] = process.argv.slice(2);
if (!wmz) {
  console.error("usage: node tools/skin-preview.mjs <skin.wmz> [port]");
  process.exit(1);
}
const root = new URL("..", import.meta.url);
const files = {
  "/": ["src/skin/index.html", "text/html; charset=utf-8"],
  "/engine.js": ["dist-skin/engine.js", "text/javascript"],
};

createServer((req, res) => {
  if (req.method === "POST" && req.url === "/msg") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const msg = JSON.parse(body);
      if (msg.type === "shape") msg.rects = `${msg.rects.length} runs`;
      console.log(JSON.stringify(msg));
      res.writeHead(204).end();
    });
    return;
  }
  try {
    if (req.url === "/skin.wmz") return res.writeHead(200).end(readFileSync(wmz));
    const [path, type] = files[req.url] ?? [];
    if (!path) return res.writeHead(404).end();
    res.writeHead(200, { "Content-Type": type }).end(readFileSync(new URL(path, root)));
  } catch (e) {
    res.writeHead(500).end(String(e));
  }
}).listen(+port, () => console.log(`http://localhost:${port}/`));
