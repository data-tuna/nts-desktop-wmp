// Usage: node tools/escape.mjs <port> [webview|frame|preview]
// ATA-107: tries to reach Tauri from where skin code runs, and runs the same
// calls from the trusted page as a control. "webview" attacks from the skin
// webview (the chosen host); "frame" from a sandboxed srcdoc frame inside the
// trusted page (the host ATA-103 used; dev builds only); "preview" from the
// skin picker's preview webview (ATA-193; open the picker and select a skin).
// The IPC attacks call our `skin_send` with a title unique to the row, and
// "reached" says whether that title arrived in the skin webview. One also
// tries `set_size`, and every row reads the window's size afterwards.
import { connect } from "./cdp.mjs";

const [port, mode = "webview"] = process.argv.slice(2);
const main = await connect(port, "main");
const skin = await connect(port, "skin");
const preview = mode === "preview" && (await connect(port, "preview"));
const APP_URL = main.url;
const REMOTE = "https://example.com/";
const q = JSON.stringify;
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const size = () => main.evaluate(`__TAURI_INTERNALS__.invoke("plugin:window|inner_size", { label: "main" }).then((s) => s.width + "x" + s.height)`);

// Every title the skin webview is sent, to tell which calls got through.
await skin.evaluate(`window.__titles = []; addEventListener("message", (e) => __titles.push(e.data?.title)); "ok"`);
const reached = (marker) => skin.evaluate(`__titles.includes(${q(marker)})`);
const send = (marker) => ({ msg: { type: "state", playing: false, time: 0, title: marker, level: 0 } });

// Capture the request Tauri's own invoke sends, invoke key and all, so the
// attacker can replay it as if the key had leaked.
const captured = await main.evaluate(`(async () => {
  let c;
  const real = window.fetch;
  window.fetch = (input, init) => {
    const url = String(input);
    if (url.includes("ipc.localhost") && !c) c = { url, headers: Object.fromEntries(new Headers(init.headers)) };
    return real(input, init);
  };
  await __TAURI_INTERNALS__.invoke("skin_send", ${q(send("capture"))});
  window.fetch = real;
  return c;
})()`);
const key = captured.headers["tauri-invoke-key"];

function replay(withKey) {
  const headers = { ...captured.headers };
  if (!withKey) delete headers["tauri-invoke-key"];
  return (m) => `fetch(${q(captured.url)}, { method: "POST", headers: ${q(headers)}, body: ${q(q(send(m)))} })
    .then(async (r) => r.status + " " + (await r.text()).slice(0, 160), (e) => e.name + ": " + e.message)`;
}
const invoke = (cmd, args) => (m) =>
  `window.__TAURI_INTERNALS__ ? __TAURI_INTERNALS__.invoke(${q(cmd)}, ${q(args ?? send(m))}).then((v) => "resolved " + JSON.stringify(v), (e) => "rejected: " + e) : "no __TAURI_INTERNALS__"`;
// Loads something and reports any content security policy violation.
const csp = (load) => `(async () => {
  const seen = [];
  const on = (e) => seen.push(e.violatedDirective + " blocked " + e.blockedURI);
  document.addEventListener("securitypolicyviolation", on);
  const result = await (${load})().catch((e) => e.name + ": " + e.message);
  await new Promise((r) => setTimeout(r, 2000));
  document.removeEventListener("securitypolicyviolation", on);
  return seen.length ? "CSP: " + seen.join("; ") : result;
})()`;
const frame = (url) => csp(`async () => { const f = document.createElement("iframe"); f.src = ${q(url)}; document.body.append(f); return "framed, no violation"; }`);

// Each attack takes the row's marker and returns an expression to run.
const ATTACKS = {
  "read the parent / opener": () => `(async () => ({
    parentIsSelf: window.parent === window, topIsSelf: window.top === window, opener: String(window.opener),
    parentTitle: (() => { try { return window.parent === window ? "(no parent)" : parent.document.title; } catch (e) { return e.name + ": " + e.message; } })(),
    parentInternals: (() => { try { return window.parent === window ? "(no parent)" : typeof parent.__TAURI_INTERNALS__; } catch (e) { return e.name + ": " + e.message; } })(),
    readAppPage: await fetch(${q(APP_URL)}).then((r) => r.text()).then((t) => "read " + t.length + " bytes", (e) => e.name + ": " + e.message),
  }))()`,
  "what Tauri injected": () => `({ origin: location.origin, __TAURI_INTERNALS__: typeof window.__TAURI_INTERNALS__, ipc: typeof window.ipc, chromeWebview: typeof window.chrome?.webview })`,
  "replay IPC, no key": replay(false),
  "replay IPC, with key": replay(true),
  "__TAURI_INTERNALS__.invoke skin_send (app command)": invoke("skin_send"),
  "__TAURI_INTERNALS__.invoke set_size": invoke("plugin:window|set_size", { label: "main", value: { Logical: { width: 321, height: 123 } } }),
  "__TAURI_INTERNALS__.invoke app version": invoke("plugin:app|version", {}),
  // The picker's commands (ATA-112): only the picker webview may call them.
  "__TAURI_INTERNALS__.invoke list_skins": invoke("list_skins", {}),
  "__TAURI_INTERNALS__.invoke choose_skin": invoke("choose_skin", { path: null }),
  "__TAURI_INTERNALS__.invoke open_link": invoke("open_link", { url: "https://www.nts.live/supporters" }),
  "__TAURI_INTERNALS__.invoke preview_skin": invoke("preview_skin", { path: "microsoft/Classic.wmz" }),
  "__TAURI_INTERNALS__.invoke preview_area": invoke("preview_area", { x: 0, y: 0, width: 4096, height: 4096 }),
  // The trusted page's command (ATA-115).
  "__TAURI_INTERNALS__.invoke now_playing": invoke("now_playing", { title: "escaped", mute: false }),
  // The trusted page builds the visualisation menu (ATA-190); the skin may not.
  "__TAURI_INTERNALS__.invoke plugin:menu|new": invoke("plugin:menu|new", { kind: "Menu", options: {} }),
  "forced postMessage fallback": (m) => `(async () => {
    if (!window.__TAURI_INTERNALS__) return "no __TAURI_INTERNALS__";
    const real = window.fetch;
    window.fetch = (u, i) => (String(u).includes("ipc.localhost") ? Promise.reject(new TypeError("blocked")) : real(u, i));
    try {
      return await Promise.race([
        __TAURI_INTERNALS__.invoke("skin_send", ${q(send(m))}).then((v) => "resolved " + JSON.stringify(v), (e) => "rejected: " + e),
        new Promise((r) => setTimeout(() => r("no reply in 3 s"), 3000)),
      ]);
    } finally { window.fetch = real; }
  })()`,
  "raw window.ipc.postMessage, with key": (m) => `(() => {
    const ipc = window.ipc ?? window.chrome?.webview;
    if (!ipc) return "no window.ipc";
    ipc.postMessage(JSON.stringify({ cmd: "skin_send", callback: 1, error: 2, options: {}, payload: ${q(send(m))}, __TAURI_INVOKE_KEY__: ${q(key)} }));
    return "posted";
  })()`,
  "fetch a remote URL (no-cors)": () => csp(`() => fetch(${q(REMOTE)}, { mode: "no-cors" }).then((r) => "fetched, " + r.type + " response")`),
  "frame a remote page": () => frame(REMOTE),
  "frame the app's page": () => frame(APP_URL),
  "navigate to the app's page": () => `(() => { setTimeout(() => { try { (window.top === window ? location : top.location).href = ${q(APP_URL)}; } catch (e) { window.__nav = e.name + ": " + e.message; } }, 50); return "navigating"; })()`,
  "window.open the app's page": () => `(() => { const w = window.open(${q(APP_URL)}); return w ? "opened" : "null"; })()`,
};
const IPC = ["replay IPC, no key", "replay IPC, with key", "__TAURI_INTERNALS__.invoke skin_send (app command)", "forced postMessage fallback", "raw window.ipc.postMessage, with key"];

async function attacker() {
  if (mode === "webview") return (expr) => skin.evaluate(expr);
  if (mode === "preview") return (expr) => preview.evaluate(expr);
  await main.evaluate("frameHost()");
  await pause(1000);
  const frame = await connect(port, "frame");
  return (expr) => frame.evaluate(expr);
}

const run = await attacker();
const rows = [];
let n = 0;
const row = async (from, name, exec) => {
  const marker = `escape-${++n}`;
  const result = await exec(ATTACKS[name](marker)).catch((e) => "cdp: " + e.message);
  await pause(800);
  rows.push({ name, from, result, ...(IPC.includes(name) && { reached: await reached(marker) }), size: await size() });
};
for (const name of Object.keys(ATTACKS)) {
  if (name === "navigate to the app's page" && mode !== "frame") {
    await run(ATTACKS[name]());
    await pause(1500);
    const now = await connect(port, mode === "preview" ? "preview" : "skin").then((s) => (s.close(), s.url)).catch((e) => e.message);
    rows.push({ name, from: "attacker", result: "now at " + now, size: await size() });
    continue;
  }
  await row("attacker", name, run);
}
// Controls: the same calls from the trusted page.
for (const name of IPC.slice(1)) await row("trusted page (control)", name, (e) => main.evaluate(e));

console.log(q({ mode, app: APP_URL, captured: { url: captured.url, headers: Object.keys(captured.headers) }, rows }, null, 1));
skin.close();
if (preview) preview.close();
// The forced fallback leaves the trusted page on postMessage IPC for good.
await main.evaluate("location.reload()");
main.close();
