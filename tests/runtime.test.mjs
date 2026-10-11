// The script runtime: skin scripts, handlers, `jscript:` expressions,
// `wmpprop:`/`wmpenabled:` bindings and the WMP object model, driven the
// way a skin drives them. The engine paints to a canvas, so Node gets a
// stub canvas that draws nothing and measures text at 6 px a character.
// Skin scripts run as global code, so each test names its own functions.
import { test } from "node:test";
import assert from "node:assert/strict";

function canvas() {
  const c = { width: 0, height: 0, style: {}, title: "", addEventListener() {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: c.width, height: c.height }) };
  const g = new Proxy(
    { canvas: c },
    {
      get(t, k) {
        if (k in t) return t[k];
        if (k === "measureText") return (s) => ({ width: s.length * 6 });
        if (k === "getImageData") return (x, y, w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) });
        return () => ({});
      },
      set: (t, k, v) => ((t[k] = v), true),
    },
  );
  c.getContext = () => g;
  return c;
}
const store = new Map();
Object.assign(globalThis, {
  document: { createElement: canvas },
  window: globalThis,
  addEventListener() {},
  requestAnimationFrame: () => 0,
  ImageData: class {},
  localStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)) },
});
console.warn = () => {}; // the engine logs what skins do that it skips

const { Skin } = await import("../src/skin/engine.ts");
const { parse } = await import("../src/skin/wms.ts");
const { resImage, resString, CONSTANTS } = await import("../src/skin/runtime.ts");

const STATE = { playState: "stopped", channel: 0, title: "NTS 1", time: 0, duration: 0, volume: 0.5, mute: false, balance: 0, eq: Array(10).fill(0), level: 0 };

/** A started skin from markup and scripts, the messages it sends, and a way
 * to evaluate skin code against it. */
function load(wms, scripts = {}, state = STATE) {
  const sent = [];
  const skin = new Skin(parse(wms), new Map(), (m) => sent.push(m), new Map(Object.entries(scripts)), "test:");
  skin.setState(state);
  skin.start();
  const js = (code) => skin.run(skin.view, `return (${code});`);
  return { skin, sent, js, set: (patch) => skin.setState({ ...skin.state, ...patch }) };
}

test("jscript: attributes read other elements and the skin's functions, and follow them", () => {
  const { js } = load(
    `<theme><view width="200" height="100" scriptFile="a.js">
       <subview id="a" left="10" width="jscript:ExprWidth();" height="20"/>
       <subview id="b" left="jscript:a.left+a.width;" top="jscript:a.height+gap;" width="jscript:view.width-left;" height="5"/>
     </view></theme>`,
    { "a.js": "var gap = 3;\nfunction ExprWidth() { return 40; }" },
  );
  assert.deepEqual(js("[b.left, b.top, b.width]"), [50, 23, 150]);
  js("a.width = 70");
  assert.deepEqual(js("[b.left, b.width]"), [80, 120], "worked out again after a script moves what they read");
  js("view.width = 300");
  assert.equal(js("b.width"), 220);
});

test("plain geometry follows its alignment when the view is resized", () => {
  const { js, sent } = load(`<theme><view width="200" height="100">
       <subview id="s" left="0" top="0" width="200" height="60" horizontalAlignment="stretch" verticalAlignment="stretch"/>
       <subview id="r" left="150" top="70" width="40" height="20" horizontalAlignment="right" verticalAlignment="bottom"/>
       <subview id="c" width="20" height="10" horizontalAlignment="center"/>
     </view></theme>`);
  assert.deepEqual(js("[s.width, s.height, r.left, r.top, c.left]"), [200, 60, 150, 70, 90]);
  js("view.width = 250, view.height = 80");
  assert.deepEqual(js("[s.width, s.height, r.left, r.top, c.left]"), [250, 40, 200, 50, 115]);
  return Promise.resolve().then(() => {
    const shape = sent.filter((m) => m.type === "shape").at(-1);
    assert.deepEqual([shape.width, shape.height], [250, 80], "the window takes the new size");
  });
});

test("wmpprop: and wmpenabled: bindings follow the player's state", () => {
  const { js, set } = load(`<theme><view width="100" height="100">
       <text id="name" value="wmpprop:player.currentMedia.name"/>
       <text id="clock" value="wmpprop:player.controls.currentPositionString"/>
       <button id="pause" visible="wmpenabled:player.controls.pause"/>
       <button id="play" visible="wmpdisabled:player.controls.pause"/>
       <slider id="vol" min="0" max="100" value="wmpprop:player.settings.volume"/>
       <slider id="eq3" min="-14" max="14" value="wmpprop:eq.gainLevel3"/>
       <equalizerSettings id="eq"/>
     </view></theme>`);
  assert.deepEqual(js("[name.value, clock.value, pause.visible, play.visible, vol.value]"), ["NTS 1", "", false, true, 50]);
  set({ playState: "playing", time: 75, title: "NTS 2", channel: 1, volume: 0.2, eq: [0, 0, -6, 0, 0, 0, 0, 0, 0, 0] });
  assert.deepEqual(js("[name.value, clock.value, pause.visible, play.visible, vol.value, eq3.value]"), ["NTS 2", "01:15", true, false, 20, -6]);
});

test("onLoad, player events and _onchange handlers run as JScript", () => {
  const { js, set } = load(
    `<theme><view width="100" height="100" scriptFile="b.js;res://wmploc.dll/RT_TEXT/#132" onLoad="EvLoad();">
       <player PlayState_onchange="EvPlay();" openstatechange="EvOpen(NewState);"/>
       <text id="t" value="" value_onchange="changes++;"/>
       <button id="d1"/><button id="d2"/>
     </view></theme>`,
    { "b.js": "var log = [], changes = 0;\nfunction EvLoad() { log.push('load'); }\nfunction EvPlay() { log.push('play ' + player.PlayState); t.value = player.status; }\nfunction EvOpen(s) { log.push('open ' + s); }" },
  );
  set({ playState: "playing" });
  set({ channel: 1, title: "NTS 2" });
  assert.deepEqual(js("log"), ["load", `play ${CONSTANTS.psPlaying}`, `open ${CONSTANTS.osMediaChanging}`, `open ${CONSTANTS.osMediaOpen}`]);
  assert.deepEqual(js("[t.value, changes]"), ["Playing", 1]);
  // Skins build element names at run time.
  js(`eval("d" + 2 + ".down = true")`);
  assert.deepEqual(js("[d1.down, d2.down]"), [false, true]);
});

test("a handler sees its element's own members first, case-insensitively", () => {
  const { skin, js } = load(`<theme><view width="100" height="100">
       <button id="b" upToolTip="Hi" onclick="seen = [upToolTip, Down, player.PlayState];"/>
     </view></theme>`);
  skin.fire(skin.byId.get("b"), "onclick");
  assert.deepEqual(js("seen"), ["Hi", false, CONSTANTS.psStopped]);
  js("b.Down = true");
  assert.deepEqual(js("[b.UPTOOLTIP, b.down]"), ["Hi", true]);
});

test("the player objects send the protocol's messages and update bindings at once", () => {
  const { js, sent } = load(`<theme><view width="100" height="100"><equalizerSettings id="eq"/></view></theme>`);
  js("player.settings.volume = 150");
  js("player.settings.mute = true");
  js("eq.gainLevel2 = -20");
  js("player.controls.play(), player.controls.next()");
  js("player.launchURL('http://www.mediabay.com/'), player.launchURL('file:///C:/x')");
  const msgs = sent.filter((m) => m.type !== "shape");
  assert.deepEqual(msgs, [
    { type: "volume", value: 1 },
    { type: "mute", value: true },
    { type: "eq", band: 1, gain: -15 },
    { type: "play" },
    { type: "next" },
    { type: "launchUrl", url: "http://www.mediabay.com/" },
  ]);
  assert.deepEqual(js("[player.settings.volume, player.settings.mute, eq.gainLevel2]"), [100, true, -15]);
  assert.equal(js("player.dvd.isAvailable('dvd')"), false, "what a radio cannot do reads as a safe default");
});

test("preferences read '--' until saved, and booleans save as JScript wrote them", () => {
  const { js } = load(`<theme><view width="1" height="1"/></theme>`);
  assert.equal(js("theme.loadPreference('headup')"), "--");
  js("theme.savePreference('headup', false), theme.savePreference('sign', 3)");
  assert.deepEqual(js("[theme.loadPreference('headup'), theme.loadPreference('sign')]"), ["False", "3"]);
});

test("the view timer and moveTo run their handlers", async () => {
  const { js } = load(
    `<theme><view width="100" height="100" timerInterval="10" onTimer="ticks++;">
       <subview id="m" left="0" top="40" width="10" height="10" onEndMove="moved = [left, top];"/>
     </view></theme>`,
    { "c.js": "" },
  );
  js("(ticks = 0, moved = null, m.moveTo(20, 0, 30))");
  await new Promise((r) => setTimeout(r, 120));
  assert.ok(js("ticks") >= 3);
  assert.deepEqual(js("moved"), [20, 0]);
  js("view.timerInterval = 0");
});

test("wmploc stand-ins: our own strings and glyphs, nothing for the rest", () => {
  const log = [];
  assert.equal(resString("res://wmploc.dll/RT_STRING/#2063", (m) => log.push(m)), "Disconnected");
  assert.equal(resString("res://wmploc/RT_STRING/#2070", (m) => log.push(m)), "");
  assert.equal(resString("Play", (m) => log.push(m)), null);
  assert.equal(log.length, 1);
  const play = resImage("res://wmploc/RT_IMAGE/#1784");
  assert.equal(play.width, 9);
  assert.ok(play.data.some((v) => v === 255));
  assert.equal(resImage("res://wmploc/RT_IMAGE/#9999"), null);
});
