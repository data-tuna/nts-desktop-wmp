// Builds skins/compatible.json: every .wmz in the archive.org item
// windowsmediaplayerskinsarchive, run through the skin engine in headless
// Edge, with what it logged and a status the app picks by.
//
//   npm run build:skin
//   node tools/compat.mjs [cache-dir]
//
// The skins are downloaded once, one at a time with a pause between them,
// into cache-dir (default %LOCALAPPDATA%\nts-wmp-compat), never into the
// repository. A rerun downloads only what is missing. Each skin's screenshot
// lands next to it as <md5>.png, for a person to look over.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { unzip } from "../src/skin/wmz.ts";
import { decode } from "../src/skin/wms.ts";
import { preview } from "./skin-preview.mjs";

const ITEM = "windowsmediaplayerskinsarchive";
const PAUSE_MS = 3000;
const PORT = 1433;
const DEVTOOLS = 9357;
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const cache = process.argv[2] ?? join(process.env.LOCALAPPDATA, "nts-wmp-compat");
mkdirSync(cache, { recursive: true });

const md5 = (bytes) => createHash("md5").update(bytes).digest("hex");
const meta = await (await fetch(`https://archive.org/metadata/${ITEM}`)).json();
const skins = meta.files.filter((f) => /\.wmz$/i.test(f.name)).sort((a, b) => a.name.localeCompare(b.name));
console.log(`${skins.length} skins in ${ITEM}`);

for (const f of skins) {
  const file = join(cache, `${f.md5}.wmz`);
  if (existsSync(file) && md5(readFileSync(file)) === f.md5) continue;
  const url = `https://archive.org/download/${ITEM}/${f.name.split("/").map(encodeURIComponent).join("/")}`;
  // One retry, after a long pause: archive.org slows down busy clients.
  for (const wait of [PAUSE_MS, 30_000]) {
    console.log(`downloading ${f.name} (${(f.size / 1e6).toFixed(1)} MB)`);
    const res = await fetch(url, { headers: { "User-Agent": "nts-desktop-wmp compatibility check" } }).catch((e) => e);
    const bytes = res.ok ? new Uint8Array(await res.arrayBuffer().catch(() => new ArrayBuffer(0))) : new Uint8Array();
    await sleep(wait);
    if (md5(bytes) === f.md5) {
      writeFileSync(file, bytes);
      break;
    }
    console.log(`  ${res.status ?? res}: got ${bytes.length} of ${f.size} bytes`);
  }
}

// What a skin needs to be playable here: a way to start and stop the stream.
const PLAY = /playbutton|playelement|controls\.play\s*\(/i;
const STOP = /stopbutton|stopelement|pausebutton|pauseelement|controls\.(stop|pause)\s*\(/i;
// Logged lines that mean part of the skin did not run or draw. Video,
// item playlists and popups are not drawn by design (AGENTS.md, Known gaps):
// a radio has no video, and the channels are in the skin's own playlist.
const FAILED = /failed|could not be worked out|missing image|missing script|cannot decode|unknown element|Uncaught/i;

let current = "";
let shape = null;
let house = false;
const server = preview(
  PORT,
  () => current,
  (msg) => {
    if (msg.type === "shape") shape = msg;
  },
  () => (house = true),
);

const profile = join(cache, "edge-profile");
rmSync(profile, { recursive: true, force: true });
const edge = spawn(EDGE, ["--headless=new", `--remote-debugging-port=${DEVTOOLS}`, `--user-data-dir=${profile}`, "--mute-audio", "about:blank"], { stdio: "ignore" });
let target;
for (let i = 0; i < 50 && !target; i++) {
  await sleep(200);
  target = await fetch(`http://127.0.0.1:${DEVTOOLS}/json`).then((r) => r.json()).then((t) => t.find((x) => x.type === "page"), () => undefined);
}
if (!target) throw new Error(`Edge did not open DevTools on port ${DEVTOOLS}`);
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r));
let id = 0;
const pending = new Map();
let logs = [];
ws.addEventListener("message", (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id) {
    pending.get(msg.id)?.(msg.result ?? {});
    return pending.delete(msg.id);
  }
  if (msg.method === "Runtime.consoleAPICalled") logs.push(msg.params.args.map((a) => a.value ?? a.description).join(" "));
  if (msg.method === "Runtime.exceptionThrown") logs.push(`Uncaught ${msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text}`);
});
const cdp = (method, params = {}) => new Promise((r) => (pending.set(++id, r), ws.send(JSON.stringify({ id, method, params }))));
const evaluate = async (expression) => (await cdp("Runtime.evaluate", { expression, returnByValue: true })).result?.value;
await cdp("Runtime.enable");
await cdp("Page.enable");

const out = [];
for (const f of skins) {
  current = join(cache, `${f.md5}.wmz`);
  if (!existsSync(current)) {
    out.push({ path: f.name, md5: f.md5, size: +f.size, status: "broken", notes: ["could not be downloaded"] });
    console.log(`broken  ${f.name}: could not be downloaded`);
    continue;
  }
  shape = null;
  house = false;
  logs = [];
  await cdp("Page.navigate", { url: `http://localhost:${PORT}/?play` });
  // Long enough for onLoad, a few timers and the first state messages.
  await sleep(2500);
  // The page falls back to the house skin when a skin will not load; the
  // reason is the warning it logged.
  const error = (await evaluate("document.getElementById('error')?.textContent ?? null")) ?? (house ? (logs.find((l) => l.startsWith("skin: ")) ?? "the engine could not load it") : null);
  const canvas = await evaluate("(() => { const c = document.querySelector('canvas'); return c ? [c.width, c.height] : null; })()");
  // Key colour left on the canvas would show in the window as pink: a
  // transparency the engine did not cut.
  const pink = await evaluate(`(() => {
    const c = document.querySelector("canvas");
    if (!c) return 0;
    const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] === 255 && d[i + 1] === 0 && d[i + 2] === 255 && d[i + 3] === 255) n++;
    return n;
  })()`);
  if (canvas) {
    const [width, height] = canvas.map((v) => Math.min(v, 4096));
    await cdp("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
    const shot = await cdp("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width, height, scale: 1 } });
    if (shot.data) writeFileSync(join(cache, `${f.md5}.png`), Buffer.from(shot.data, "base64"));
  }
  let source = "";
  try {
    const files = await unzip(new Uint8Array(readFileSync(current)));
    source = [...files].filter(([n]) => /\.(wms|js)$/.test(n)).map(([, b]) => decode(b)).join("\n");
  } catch {
    // The engine's own error says why.
  }
  const failures = [...new Set(logs.filter((l) => FAILED.test(l)))];
  const notes = [];
  if (error) notes.push(error);
  else if (!shape || !shape.rects.length) notes.push("drew nothing");
  if (!PLAY.test(source)) notes.push("no play control");
  if (!STOP.test(source)) notes.push("no stop or pause control");
  if (pink > 20) notes.push(`shows ${pink} pixels of key colour #FF00FF`);
  notes.push(...failures);
  const status = error || !shape?.rects.length ? "broken" : notes.length ? "partial" : "works";
  out.push({ path: f.name, md5: f.md5, size: +f.size, status, ...(notes.length && { notes: notes.map((n) => n.replace(/^skin: /, "").slice(0, 160)).slice(0, 8) }) });
  console.log(`${status.padEnd(7)} ${f.name}${notes.length ? `: ${notes[0].slice(0, 100)}` : ""}`);
}

ws.close();
edge.kill();
server.close();
const count = (s) => out.filter((x) => x.status === s).length;
writeFileSync(new URL("../skins/compatible.json", import.meta.url), `${JSON.stringify(out, null, 1)}\n`);
console.log(`works ${count("works")}, partial ${count("partial")}, broken ${count("broken")} of ${out.length}`);
