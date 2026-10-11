// Usage: node tools/escape.mjs <port> [webview|frame]
// ATA-107: tries to reach Tauri from where skin code runs, and runs the same
// calls from the trusted page as a control. "webview" attacks from the skin
// webview (the chosen host); "frame" from a sandboxed srcdoc frame inside the
// trusted page (the host ATA-103 used; dev builds only). Every attack tries
// to resize the window to 321x123, and the window's size is read after each.
import { connect } from "./cdp.mjs";

const [port, mode = "webview"] = process.argv.slice(2);
const main = await connect(port, "main");
const APP_URL = main.url;
const TARGET = { label: "main", value: { Logical: { width: 321, height: 123 } } };
const HOME = { label: "main", value: { Logical: { width: 234, height: 201 } } };

const size = () => main.evaluate(`__TAURI_INTERNALS__.invoke("plugin:window|inner_size", { label: "main" }).then((s) => s.width + "x" + s.height)`);
const restore = () => main.evaluate(`__TAURI_INTERNALS__.invoke("plugin:window|set_size", ${JSON.stringify(HOME)})`);
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

// Capture the request Tauri's own invoke sends, invoke key and all, so the
// attacker can replay it as if the key had leaked.
const captured = await main.evaluate(`(async () => {
  let c;
  const real = window.fetch;
  window.fetch = (input, init) => {
    const url = String(input);
    if (url.includes("ipc.localhost") && !c) c = { url, headers: Object.fromEntries(new Headers(init.headers)), body: init.body };
    return real(input, init);
  };
  await __TAURI_INTERNALS__.invoke("plugin:window|set_size", ${JSON.stringify(HOME)});
  window.fetch = real;
  return c;
})()`);
const key = captured.headers["tauri-invoke-key"];

// Each attack is an async expression run in the attacker's context.
const q = JSON.stringify;
const ATTACKS = {
  "read the parent / opener": `(async () => ({
    parentIsSelf: window.parent === window, topIsSelf: window.top === window, opener: String(window.opener),
    parentTitle: (() => { try { return window.parent === window ? "(no parent)" : parent.document.title; } catch (e) { return e.name + ": " + e.message; } })(),
    parentInternals: (() => { try { return window.parent === window ? "(no parent)" : typeof parent.__TAURI_INTERNALS__; } catch (e) { return e.name + ": " + e.message; } })(),
    readAppPage: await fetch(${q(APP_URL)}).then((r) => r.text()).then((t) => "read " + t.length + " bytes", (e) => e.name + ": " + e.message),
  }))()`,
  "what Tauri injected": `({ origin: location.origin, __TAURI_INTERNALS__: typeof window.__TAURI_INTERNALS__, ipc: typeof window.ipc, chromeWebview: typeof window.chrome?.webview })`,
  "replay IPC, no key": replay(false),
  "replay IPC, with key": replay(true),
  "__TAURI_INTERNALS__.invoke set_size": invoke("plugin:window|set_size", TARGET),
  "__TAURI_INTERNALS__.invoke skin_send (app command)": invoke("skin_send", { msg: { type: "state", playing: false, time: 0, title: "pwned", level: 0 } }),
  "__TAURI_INTERNALS__.invoke app version": invoke("plugin:app|version", {}),
  "forced postMessage fallback": `(async () => {
    if (!window.__TAURI_INTERNALS__) return "no __TAURI_INTERNALS__";
    const real = window.fetch;
    window.fetch = (u, i) => (String(u).includes("ipc.localhost") ? Promise.reject(new TypeError("blocked")) : real(u, i));
    try {
      return await Promise.race([
        __TAURI_INTERNALS__.invoke("plugin:window|set_size", ${q(TARGET)}).then((v) => "resolved " + JSON.stringify(v), (e) => "rejected: " + e),
        new Promise((r) => setTimeout(() => r("no reply in 3 s"), 3000)),
      ]);
    } finally { window.fetch = real; }
  })()`,
  "raw window.ipc.postMessage, with key": `(() => {
    const ipc = window.ipc ?? window.chrome?.webview;
    if (!ipc) return "no window.ipc";
    ipc.postMessage(JSON.stringify({ cmd: "plugin:window|set_size", callback: 1, error: 2, options: {}, payload: ${q(TARGET)}, __TAURI_INVOKE_KEY__: ${q(key)} }));
    return "posted";
  })()`,
  "navigate to the app's page": `(() => { setTimeout(() => { try { (window.top === window ? location : top.location).href = ${q(APP_URL)}; } catch (e) { window.__nav = e.name + ": " + e.message; } }, 50); return "navigating"; })()`,
  "window.open the app's page": `(() => { const w = window.open(${q(APP_URL)}); return w ? "opened" : "null"; })()`,
};

function replay(withKey) {
  const headers = { ...captured.headers };
  if (!withKey) delete headers["tauri-invoke-key"];
  return `fetch(${q(captured.url)}, { method: "POST", headers: ${q(headers)}, body: ${q(q(TARGET))} })
    .then(async (r) => r.status + " " + (await r.text()).slice(0, 160), (e) => e.name + ": " + e.message)`;
}
function invoke(cmd, args) {
  return `window.__TAURI_INTERNALS__ ? __TAURI_INTERNALS__.invoke(${q(cmd)}, ${q(args)}).then((v) => "resolved " + JSON.stringify(v), (e) => "rejected: " + e) : "no __TAURI_INTERNALS__"`;
}

async function attacker() {
  if (mode === "webview") {
    const skin = await connect(port, "skin");
    return { run: (expr) => skin.evaluate(expr), where: () => skin.evaluate("location.href").catch(() => "(context gone)"), close: skin.close };
  }
  await main.evaluate("frameHost()");
  await main.send("Runtime.enable");
  await pause(500);
  const { result } = await main.send("Page.getFrameTree");
  const top = result.frameTree.frame.id;
  const ctx = main.events
    .filter((e) => e.method === "Runtime.executionContextCreated")
    .map((e) => e.params.context)
    .findLast((c) => c.auxData?.isDefault && c.auxData.frameId !== top);
  return { run: (expr) => main.evaluate(expr, ctx.id), where: () => main.evaluate(`document.querySelector("iframe[sandbox]")?.contentWindow ? "frame still there; app at " + location.href : "?"`), close() {} };
}

const a = await attacker();
const rows = [];
for (const [name, expr] of Object.entries(ATTACKS)) {
  if (name === "navigate to the app's page" && mode === "webview") {
    await a.run(expr);
    await pause(1500);
    rows.push({ name, from: "attacker", result: "now at " + (await connect(port, "skin").then((s) => (s.close(), s.url)).catch((e) => e.message)), size: await size() });
    continue;
  }
  const result = await a.run(expr).catch((e) => "cdp: " + e.message);
  await pause(800);
  rows.push({ name, from: "attacker", result, size: await size() });
  await restore();
}

// Controls: the same calls from the trusted page.
for (const name of ["replay IPC, with key", "__TAURI_INTERNALS__.invoke set_size", "__TAURI_INTERNALS__.invoke skin_send (app command)", "forced postMessage fallback", "raw window.ipc.postMessage, with key"]) {
  const result = await main.evaluate(ATTACKS[name]);
  await pause(800);
  rows.push({ name, from: "trusted page (control)", result, size: await size() });
  await restore();
}

console.log(JSON.stringify({ mode, app: APP_URL, captured: { url: captured.url, headers: Object.keys(captured.headers) }, rows }, null, 1));
a.close();
// The forced fallback leaves the trusted page on postMessage IPC for good.
await main.evaluate("location.reload()");
main.close();
