// The skin script of the macOS probe skin (ATA-230): the IPC escape attempts
// of tools/escape.mjs, run from inside the skin webview, where WKWebView has
// no DevTools port to drive them from. It prints each result over the skin,
// for the runner's screenshot. Also: whether the trusted page's messages
// arrive (the control), page visibility over time, and Media Session.
(async function () {
  var rows = [];
  var seen = [];
  var states = 0;
  var title = "";
  var started = Date.now();
  var vis = ["0s " + document.visibilityState];
  addEventListener("message", function (e) {
    if (e.data && e.data.type === "state") states++, (title = e.data.title);
    if (e.data && e.data.title) seen.push(e.data.title);
  });
  document.addEventListener("visibilitychange", function () {
    vis.push(Math.round((Date.now() - started) / 1000) + "s " + document.visibilityState);
  });
  var pre = document.createElement("pre");
  pre.style.cssText = "position:fixed;inset:0;margin:0;padding:6px;background:#000;color:#9f9;font:10px/1.25 Menlo,monospace;white-space:pre-wrap;z-index:9";
  document.body.append(pre);
  function draw() {
    pre.textContent = "ATA-230 macOS probe, skin webview at " + location.href + "\n" +
      rows.map(function (r) { return (r[0] + ": " + r[1]).slice(0, 160); }).join("\n") +
      "\ncontrol: " + states + " state messages from the trusted page, last title " + JSON.stringify(title) +
      "\nvisibility: " + vis.join(", ");
  }
  setInterval(draw, 500);
  var post = function (m) {
    return fetch("/msg", { method: "POST", body: JSON.stringify(m) }).then(function (r) { return r.status; });
  };
  var settle = function (p) {
    return Promise.race([
      Promise.resolve(p).then(function (v) { return "resolved " + JSON.stringify(v); }, function (e) { return "rejected: " + e; }),
      new Promise(function (r) { setTimeout(function () { r("no reply in 3 s"); }, 3000); }),
    ]);
  };
  var row = async function (name, run) {
    var result;
    try { result = await run(); } catch (e) { result = "threw " + e; }
    rows.push([name, String(result).replace(/\s+/g, " ")]);
    draw();
  };
  var n = 0;
  var marker = function () { return "escape-" + ++n; };
  var internals = window.__TAURI_INTERNALS__;
  var invoke = function (cmd, args) {
    return function () { return internals ? settle(internals.invoke(cmd, args)) : "no __TAURI_INTERNALS__"; };
  };
  var invokeSend = function (name, how) {
    return row(name, async function () {
      var m = marker();
      var result = await how({ msg: { type: "state", playing: false, time: 0, title: m, level: 0 } });
      await new Promise(function (r) { setTimeout(r, 800); });
      return result + (seen.indexOf(m) >= 0 ? " | REACHED" : " | not reached");
    });
  };
  // Room for the rows: the window takes this size and shape, after the
  // engine has sent the skin's own.
  await new Promise(function (r) { setTimeout(r, 1500); });
  await row("/msg shape 1000x600", function () { return post({ type: "shape", width: 1000, height: 600, rects: [[0, 0, 1000, 600]] }); });
  await row("/msg unknown field", function () { return post({ type: "play", evil: 1 }); });
  await row("what Tauri injected", function () {
    return JSON.stringify({
      origin: location.origin,
      internals: typeof internals,
      ipc: typeof window.ipc,
      webkitIpc: typeof (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.ipc),
      parentIsSelf: window.parent === window,
    });
  });
  await invokeSend("invoke skin_send", function (args) { return invoke("skin_send", args)(); });
  await row("invoke set_size", invoke("plugin:window|set_size", { label: "main", value: { Logical: { width: 321, height: 123 } } }));
  await row("  window size after", function () { return innerWidth + "x" + innerHeight; });
  await row("invoke app version", invoke("plugin:app|version", {}));
  await row("invoke list_skins", invoke("list_skins", {}));
  await row("invoke choose_skin", invoke("choose_skin", { path: null }));
  await row("invoke open_link", invoke("open_link", { url: "https://www.nts.live/supporters" }));
  await row("invoke preview_area", invoke("preview_area", { x: 0, y: 0, width: 4096, height: 4096 }));
  await row("invoke now_playing", invoke("now_playing", { title: "escaped", mute: false }));
  await row("invoke pick_audio", invoke("pick_audio", { rate: 48000 }));
  await row("invoke plugin:menu|new", invoke("plugin:menu|new", { kind: "Menu", options: {} }));
  await invokeSend("fetch ipc://localhost/skin_send", function (args) {
    return settle(fetch("ipc://localhost/skin_send", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(args) }).then(function (r) { return r.status; }));
  });
  await invokeSend("raw webkit ipc postMessage", function (args) {
    var h = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.ipc;
    if (!h) return "no webkit ipc handler";
    h.postMessage(JSON.stringify({ cmd: "skin_send", callback: 1, error: 2, payload: args }));
    return "posted";
  });
  var csp = function (load) {
    return async function () {
      var hit = [];
      var on = function (e) { hit.push(e.violatedDirective + " blocked " + e.blockedURI); };
      document.addEventListener("securitypolicyviolation", on);
      var result = await load().catch(function (e) { return e.name + ": " + e.message; });
      await new Promise(function (r) { setTimeout(r, 1500); });
      document.removeEventListener("securitypolicyviolation", on);
      return hit.length ? "CSP: " + hit.join("; ") : result;
    };
  };
  var frame = function (url) {
    return csp(async function () { var f = document.createElement("iframe"); f.src = url; f.style.display = "none"; document.body.append(f); return "framed, no violation"; });
  };
  await row("fetch a remote URL (no-cors)", csp(function () { return fetch("https://example.com/", { mode: "no-cors" }).then(function (r) { return "fetched, " + r.type; }); }));
  await row("fetch the app's page", csp(function () { return fetch("tauri://localhost/").then(function (r) { return "read " + r.status; }); }));
  await row("frame a remote page", frame("https://example.com/"));
  await row("frame the app's page", frame("tauri://localhost/"));
  await row("window.open the app's page", function () { return window.open("tauri://localhost/") ? "opened" : "null"; });
  await row("Media Session", function () { return typeof navigator.mediaSession + ", MediaMetadata " + typeof window.MediaMetadata; });
  // The verdict, for check.sh: 1000 px wide if every attempt failed, 999 if
  // one got through.
  var held = rows.every(function (r) {
    var name = r[0], result = r[1];
    if (name.indexOf("/msg") === 0 || name === "what Tauri injected" || name.indexOf("  ") === 0 || name === "Media Session") return true;
    if (/^(fetch|frame) /.test(name)) return result.indexOf("CSP: ") === 0 || /not reached$/.test(result);
    if (name.indexOf("window.open") === 0) return result === "null";
    return /^(rejected|no reply)/.test(result) && !/REACHED/.test(result) || result === "posted | not reached";
  });
  await row("verdict", function () {
    var w = held ? 1000 : 999;
    return post({ type: "shape", width: w, height: 600, rects: [[0, 0, w, 600]] }).then(function () { return held ? "every attempt failed" : "SOMETHING GOT THROUGH"; });
  });
  // check.sh brings the window back with a second launch.
  await row("minimize in 2 s", function () { setTimeout(function () { post({ type: "minimize" }); }, 2000); return "sent later"; });
})();
