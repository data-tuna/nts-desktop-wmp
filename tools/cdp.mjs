// Usage: node tools/cdp.mjs <port> <main|skin|preview> <js-expression>
// Evaluates an expression (it may return a promise) in one of the app's
// webviews: "main", the trusted page, "skin", the skin webview at
// http://skin.localhost, or "preview", the picker's preview webview at
// http://skin.localhost/?preview. connect() also takes "frame", for tools/escape.mjs. Start the app with WebView2's DevTools port open:
// WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=<port>.
export async function connect(port, which) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const isSkin = (t) => t.url.startsWith("http://skin.localhost");
  const isPreview = (t) => isSkin(t) && new URL(t.url).searchParams.has("preview");
  // "frame": the newest sub-frame with a target of its own (sandboxed frames run out of process).
  // "main" is the trusted page at "/", not the skin picker (picker.html).
  const isMain = (t) => !isSkin(t) && new URL(t.url).pathname === "/";
  const page = which === "frame" ? targets.findLast((t) => t.type === "iframe") : targets.find((t) => t.type === "page" && (which === "skin" ? isSkin(t) && !isPreview(t) : which === "preview" ? isPreview(t) : isMain(t)));
  if (!page) throw new Error(`no ${which} target among ${targets.map((t) => t.url).join(", ")}`);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r));
  let id = 0;
  const pending = new Map();
  const events = [];
  ws.addEventListener("message", (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id) pending.get(msg.id)?.(msg);
    else events.push(msg);
  });
  const send = (method, params) =>
    new Promise((r) => {
      pending.set(++id, r);
      ws.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression, contextId) => {
    const msg = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, contextId });
    if (msg.error) throw new Error(msg.error.message);
    const r = msg.result;
    return r.exceptionDetails ? { threw: r.exceptionDetails.exception?.description ?? r.exceptionDetails.text } : r.result.value;
  };
  return { url: page.url, send, evaluate, events, close: () => ws.close() };
}

if (import.meta.url.endsWith(process.argv[1].replaceAll("\\", "/").split("/").pop())) {
  const [port, which, expr] = process.argv.slice(2);
  const c = await connect(port, which);
  console.log(JSON.stringify(await c.evaluate(expr), null, 1));
  c.close();
}
