// The script runtime: skin scripts, handlers, `jscript:` expressions,
// `wmpprop:`/`wmpenabled:` bindings and the WMP object model, driven the
// way a skin drives them. The engine paints to a canvas, so Node gets a
// stub canvas that draws nothing and measures text at 6 px a character.
// Skin scripts run as global code, so each test names its own functions.
import { test } from "node:test";
import assert from "node:assert/strict";

// Pointer listeners, so a test can click: the skin's canvas registers last.
// `drawn` logs each fillRect and fillText with its colour.
const listeners = {};
const listen = (type, f) => (listeners[type] = f);
const drawn = [];
function canvas() {
  const c = { width: 0, height: 0, style: {}, title: "", addEventListener: listen, getBoundingClientRect: () => ({ left: 0, top: 0, width: c.width, height: c.height }) };
  const g = new Proxy(
    { canvas: c },
    {
      get(t, k) {
        if (k in t) return t[k];
        if (k === "measureText") return (s) => ({ width: s.length * 6 });
        if (k === "fillRect" || k === "fillText") return (...a) => drawn.push([k, t.fillStyle, ...a]);
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
  addEventListener: listen,
  requestAnimationFrame: () => 0,
  ImageData: class {},
  localStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)) },
});
console.warn = () => {}; // the engine logs what skins do that it skips

const { Skin } = await import("../src/skin/engine.ts");
const { parse } = await import("../src/skin/wms.ts");
const { clock, resImage, resString, CONSTANTS } = await import("../src/skin/runtime.ts");

const STATE = { playState: "stopped", channel: 0, title: "NTS 1", url: "", author: "", location: "", link: "", items: ["NTS 1", "NTS 2"], time: 0, duration: 0, volume: 0.5, mute: false, balance: 0, eq: Array(10).fill(0), level: 0 };

/** A started skin from markup and scripts, the messages it sends, and a way
 * to evaluate skin code against it. */
function load(wms, scripts = {}, state = STATE, images = new Map()) {
  const sent = [];
  const skin = new Skin(parse(wms), images, (m) => sent.push(m), new Map(Object.entries(scripts)), "test:");
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

test("a sticky mute button flips down for its onClick, then follows the player again", async () => {
  const { js, set } = load(`<theme><view width="20" height="20">
       <muteButton id="m" left="0" top="0" width="20" height="20" sticky="true" onclick="seen = down;"/>
     </view></theme>`);
  const click = () => {
    const at = { button: 0, clientX: 5, clientY: 5 };
    listeners.mousedown(at);
    listeners.mouseup(at);
  };
  click();
  assert.equal(js("seen"), true, "onClick reads the flipped state");
  set({ mute: true });
  set({ mute: false });
  assert.equal(js("m.down"), false, "the player's mute shows again after the click");
  set({ mute: true });
  assert.equal(js("m.down"), true);
});

test("9SeriesDefault's mute button and the tray's Mute follow the same setting", () => {
  // bMute as 9SeriesDefault has it, outside its button group.
  const { js, sent, set } = load(`<theme><view width="20" height="20">
       <button id="bMute" left="0" top="0" width="20" height="20" sticky="true"
         onClick="jscript:player.settings.mute=down;" down="wmpprop:player.settings.mute"/>
     </view></theme>`);
  const click = () => {
    const at = { button: 0, clientX: 5, clientY: 5 };
    listeners.mousedown(at);
    listeners.mouseup(at);
  };
  const mutes = () => sent.filter((m) => m.type === "mute").map((m) => m.value);
  click();
  assert.deepEqual(mutes(), [true], "a click mutes");
  assert.equal(js("bMute.down"), true);
  set({ mute: false }); // the tray unmutes
  assert.equal(js("bMute.down"), false, "the button follows the tray");
  set({ mute: true }); // the tray mutes
  assert.equal(js("bMute.down"), true);
  click();
  assert.deepEqual(mutes(), [true, false], "a click on the down button unmutes");
  assert.equal(js("bMute.down"), false);
});

test("a statement that throws keeps the functions declared below it", () => {
  const { js } = load(`<theme><view width="1" height="1" scriptFile="t.js" onLoad="ThrowLoaded = true;"/></theme>`, {
    "t.js": "/*\nfunction CommentedOut() {}\n*/\nvar a = 1;\nmediacenter.missing.member;\nfunction DeclaredBelowThrow() { return 7; }\n\tfunction Indented() { function NestedInIndented() {} return 8; }",
  });
  assert.equal(js("DeclaredBelowThrow()"), 7);
  assert.equal(js("Indented()"), 8, "indented declarations too");
  assert.equal(js("typeof NestedInIndented"), "undefined", "but not functions nested in them");
  assert.equal(js("ThrowLoaded"), true);
});

test("player.launchURL opens links only from a click", () => {
  const { js, sent } = load(
    `<theme><view width="20" height="20" onLoad="player.launchURL('https://onload.example/')">
       <button left="0" top="0" width="20" height="20" onclick="player.launchURL('http://www.mediabay.com/'); player.launchURL('file:///C:/x')"/>
     </view></theme>`,
  );
  js("player.launchURL('https://script.example/')");
  const at = { button: 0, clientX: 5, clientY: 5 };
  listeners.mousedown(at);
  listeners.mouseup(at);
  assert.deepEqual(sent.filter((m) => m.type === "launchUrl"), [{ type: "launchUrl", url: "http://www.mediabay.com/" }]);
});

test("a wmploc string a script sets reads as our stand-in", () => {
  const { js } = load(`<theme><view width="1" height="1"><button id="q"/></view></theme>`);
  js("q.upToolTip = 'res://wmploc/RT_STRING/#2063'");
  assert.equal(js("q.upToolTip"), "Disconnected");
});

test("the player objects send the protocol's messages and update bindings at once", () => {
  const { js, sent } = load(`<theme><view width="100" height="100"><equalizerSettings id="eq"/></view></theme>`);
  js("player.settings.volume = 150");
  js("player.settings.mute = true");
  js("eq.gainLevel2 = -20");
  js("player.controls.play(), player.controls.next()");
  const msgs = sent.filter((m) => m.type !== "shape" && m.type !== "effects");
  assert.deepEqual(msgs, [
    { type: "volume", value: 1 },
    { type: "mute", value: true },
    { type: "eq", band: 1, gain: -15 },
    { type: "play" },
    { type: "next" },
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

test("effects start on Bars, step through the visualisations, save them through their _onchange, and ask for frames only while shown", async () => {
  store.clear();
  const { js, sent } = load(`<theme><view width="100" height="100">
       <effects id="vis" width="50" height="40"
         currentEffectType="wmpprop:mediacenter.effectType" currentEffectType_onchange="mediacenter.effectType=currentEffectType;"
         currentPreset="wmpprop:mediacenter.effectPreset" currentPreset_onchange="mediacenter.effectPreset=currentPreset;"/>
     </view></theme>`);
  assert.deepEqual(js("[vis.currentEffectType, vis.currentPreset, vis.currentEffectTitle]"), ["Bars and Waves", 0, "Bars"]);
  js("vis.next()");
  assert.deepEqual(js("[vis.currentEffectTitle, mediacenter.effectType, mediacenter.effectPreset]"), ["Scope", "Bars and Waves", 1]);
  js("vis.next()");
  assert.deepEqual(js("[vis.currentEffectTitle, mediacenter.effectType, mediacenter.effectPreset]"), ["Ambience", "Ambience", 0]);
  js("vis.next()");
  assert.deepEqual(js("[vis.currentEffectTitle, mediacenter.effectType, mediacenter.effectPreset]"), ["Milkdrop", "Milkdrop", 0]);
  js("vis.next()");
  assert.deepEqual(js("[vis.currentEffectTitle, vis.currentPreset]"), ["Milkdrop", 1], "next() moves to Milkdrop's next preset");
  js("vis.currentPreset = 28");
  js("vis.next()");
  assert.equal(js("vis.currentEffectTitle"), "Bars", "round the list");
  js("vis.previous()");
  js("vis.previous()");
  assert.deepEqual(js("[vis.currentEffectTitle, vis.currentPreset]"), ["Milkdrop", 27]);
  for (let i = 0; i < 28; i++) js("vis.previous()");
  assert.equal(js("vis.currentEffectTitle"), "Ambience");
  const effects = () => sent.filter((m) => m.type === "effects").map((m) => m.on);
  await Promise.resolve();
  assert.deepEqual(effects(), [true]);
  js("vis.visible = false");
  await Promise.resolve();
  assert.deepEqual(effects(), [true, false], "hidden: no more frames");
  // The next launch, in a skin that binds nothing: the last choice.
  assert.equal(load(`<theme><view width="100" height="100"><effects id="vis2" width="50" height="40"/></view></theme>`).js("vis2.currentEffectTitle"), "Ambience");
  store.clear();
});

test("a skin with no visualisation tells the host on its first paint, so frames for the last skin stop", async () => {
  const { sent } = load(`<theme><view width="100" height="100"/></theme>`);
  await Promise.resolve();
  assert.deepEqual(sent.filter((m) => m.type === "effects"), [{ type: "effects", on: false }]);
});

test("a saved effect the list no longer has, ATA-166's show card, loads as Bars", () => {
  store.clear();
  store.set("effectType", "NTS show");
  store.set("effectPreset", "0");
  const { js } = load(`<theme><view width="100" height="100">
       <effects id="vis" width="50" height="40" currentEffectType="wmpprop:mediacenter.effectType" currentPreset="wmpprop:mediacenter.effectPreset"/>
     </view></theme>`);
  assert.deepEqual(js("[vis.currentEffectType, vis.currentPreset, vis.currentEffectTitle, mediacenter.effectType]"), ["Bars and Waves", 0, "Bars", "Bars and Waves"]);
  store.clear();
});

test("a right click on a visualisation asks the host for the effects menu; the pick is shown and saved", () => {
  store.clear();
  const { skin, js, sent } = load(`<theme><view width="100" height="100">
       <effects id="vis" left="0" top="0" width="50" height="40"/>
     </view></theme>`);
  assert.equal(skin.menu({ clientX: 80, clientY: 80 }), false, "elsewhere: the skin picker");
  assert.equal(skin.menu({ clientX: 10, clientY: 10 }), true);
  assert.deepEqual(sent.at(-1), { type: "effectsMenu", effect: 0 });
  skin.pickEffect(3 + 5);
  assert.deepEqual(js("[vis.currentEffectTitle, vis.currentPreset, mediacenter.effectType, mediacenter.effectPreset]"), ["Milkdrop", 5, "Milkdrop", 5]);
  for (const bad of [-1, 1.5, 999, "3", null]) skin.pickEffect(bad);
  assert.equal(js("vis.currentPreset"), 5, "anything but an index is ignored");
  skin.menu({ clientX: 10, clientY: 10 });
  assert.deepEqual(sent.at(-1), { type: "effectsMenu", effect: 8 });
  store.clear();
});

test("a click on a subview's drawn pixels stays there; through its transparency it reaches the visualisation behind", () => {
  // 20×20: the left half the transparency colour, the right half drawn.
  const data = new Uint8ClampedArray(20 * 20 * 4);
  for (let i = 0; i < 400; i++) data.set(i % 20 < 10 ? [0, 255, 0, 255] : [200, 0, 0, 255], i * 4);
  const { js, sent } = load(
    `<theme><view width="20" height="20">
       <effects id="vis" zIndex="-1" width="20" height="20" onClick="clicks++;"/>
       <subview backgroundImage="body.bmp" transparencyColor="#00FF00"/>
     </view></theme>`,
    {},
    STATE,
    new Map([["body.bmp", { width: 20, height: 20, data, bitmap: {} }]]),
  );
  js("clicks = 0");
  const click = (x) => {
    const at = { button: 0, clientX: x, clientY: 5 };
    listeners.mousedown(at);
    listeners.mouseup(at);
  };
  click(5);
  assert.equal(js("clicks"), 1, "through the hole");
  click(15);
  assert.equal(js("clicks"), 1, "not through the body");
  assert.equal(sent.at(-1).type, "drag", "the body moves the window");
});

test("now playing: the media's name and item info, the playlist, and a pick's link on a double click", () => {
  const items = ["NTS 1: A show - London", "NTS 2", "Poolside", "A pick - London"];
  const { skin, js, sent, set } = load(`<theme><view width="100" height="60">
       <text id="name" left="0" top="0" width="100" height="10" value="wmpprop:player.currentMedia.name"/>
       <text id="len" left="0" top="10" width="100" height="10" value="wmpprop:player.currentMedia.durationString"/>
       <playlist id="pl" left="0" top="20" width="100" height="24" fontSize="6"/>
     </view></theme>`);
  set({ title: items[0], url: "https://streams.radiomast.io/nts1", author: "A show", location: "London", items });
  assert.deepEqual(js(`[name.value, player.currentMedia.getItemInfo("Author"), player.currentMedia.getItemInfo("location"), player.currentMedia.getItemInfo("Title"), player.URL]`), [items[0], "A show", "London", items[0], "https://streams.radiomast.io/nts1"]);
  assert.deepEqual(js("[player.currentPlaylist.count, player.currentPlaylist.item(2).name]"), [4, "Poolside"]);
  const title = { button: 0, clientX: 5, clientY: 5 };
  const len = { button: 0, clientX: 5, clientY: 15 };
  // A channel has no link; a press on the title drags the window.
  listeners.mousedown(title);
  listeners.mouseup(title);
  listeners.dblclick(title);
  assert.deepEqual(sent.filter((m) => m.type === "drag").length, 1);
  set({ channel: 3, title: items[3], url: "https://www.nts.live/shows/a/episodes/b", author: "", location: "", link: "https://www.nts.live/shows/a/episodes/b" });
  // During a pick a press still drags; only a double click on the title opens the page, not on another currentMedia text.
  listeners.mousedown(title);
  listeners.dblclick(len);
  assert.deepEqual(sent.filter((m) => m.type === "launchUrl"), []);
  listeners.dblclick(title);
  assert.deepEqual(sent.filter((m) => m.type === "launchUrl"), [{ type: "launchUrl", url: "https://www.nts.live/shows/a/episodes/b" }]);
  assert.equal(js("player.currentMedia.sourceURL"), "https://www.nts.live/shows/a/episodes/b");
  // Painting scrolls the current item (3) into sight: the first row is no longer NTS 1.
  skin.paint();
  const row = { button: 0, clientX: 5, clientY: 25 };
  listeners.mousedown(row);
  listeners.mouseup(row);
  assert.deepEqual(sent.filter((m) => m.type === "select"), [{ type: "select", index: 3 }]);
  // A double click on the pick's own row opens it too.
  listeners.dblclick(row);
  assert.equal(sent.filter((m) => m.type === "launchUrl").length, 2);
});

test("a double click that starts a pick from its row does not open its page", () => {
  const items = ["NTS 1", "NTS 2", "Pick A", "Pick B"];
  const { sent, set } = load(`<theme><view width="100" height="200">
       <playlist id="pl" left="0" top="0" width="100" height="200" fontSize="6"/>
     </view></theme>`);
  set({ channel: 2, title: items[2], link: "https://www.nts.live/shows/a/episodes/a", items });
  // Rows are 16 px: 6 pt is 8 px, doubled.
  const rowB = (detail) => ({ button: 0, clientX: 5, clientY: 3 * 16 + 8, detail });
  const at = sent.length;
  listeners.mousedown(rowB(1));
  listeners.mouseup(rowB(1));
  // The host's state lands between the two presses, as it does every 250 ms.
  set({ channel: 3, title: items[3], link: "https://www.nts.live/shows/b/episodes/b" });
  listeners.mousedown(rowB(2));
  listeners.mouseup(rowB(2));
  listeners.dblclick(rowB(2));
  assert.deepEqual(sent.slice(at).filter((m) => m.type === "launchUrl"), []);
  // Now that B is current, a double click on its row opens it.
  listeners.mousedown(rowB(1));
  listeners.dblclick(rowB(2));
  assert.deepEqual(sent.slice(at).filter((m) => m.type === "launchUrl"), [{ type: "launchUrl", url: "https://www.nts.live/shows/b/episodes/b" }]);
});

test("the playlist marks the current row in the skin's playing colours, or WMP's green on #222222", () => {
  const items = ["NTS 1: A show", "NTS 2", "Poolside"];
  // The rows a paint draws: each row's text and the colour it is drawn in, and the row backgrounds.
  const rows = (skin) => {
    drawn.length = 0;
    skin.paint();
    return drawn.filter(([k, style, a]) => k === "fillText" ? items.includes(a) : k === "fillRect" && a === 0 && style).map(([k, style, a, y]) => (k === "fillText" ? [a, style] : [`row at ${y}`, style]));
  };
  const plain = load(`<theme><view width="100" height="60">
       <playlist id="pl" left="0" top="0" width="100" height="48" fontSize="6" backgroundColor="#000000" foregroundColor="#FFFFFF"/>
     </view></theme>`, {}, { ...STATE, items });
  // 16 px rows: the background, then the current row in WMP's colours, as on Headspace.
  assert.deepEqual(rows(plain.skin), [["row at 0", "#000000"], ["row at 0", "#222222"], ["NTS 1: A show", "#00ff00"], ["NTS 2", "#ffffff"], ["Poolside", "#ffffff"]]);
  plain.set({ channel: 2 });
  assert.deepEqual(rows(plain.skin), [["row at 0", "#000000"], ["NTS 1: A show", "#ffffff"], ["NTS 2", "#ffffff"], ["row at 32", "#222222"], ["Poolside", "#00ff00"]]);
  const coloured = load(`<theme><view width="100" height="60">
       <playlist id="pl" left="0" top="0" width="100" height="48" fontSize="6" foregroundColor="#FFFFFF" itemPlayingColor="#FF0000"/>
     </view></theme>`, {}, { ...STATE, items, channel: 1 });
  // A skin's own playing colour wins; the row behind it is WMP's. With no
  // backgroundColor, black goes only where no image lies under the list.
  assert.deepEqual(rows(coloured.skin), [["row at 0", "#000000"], ["NTS 1: A show", "#ffffff"], ["row at 16", "#222222"], ["NTS 2", "#ff0000"], ["Poolside", "#ffffff"]]);
});

test("the playlist's scroll bar: dragging the thumb and clicking the track scroll the list", () => {
  const items = Array.from({ length: 20 }, (_, i) => `Item ${i}`);
  const { skin } = load(`<theme><view width="100" height="48">
       <playlist id="pl" left="0" top="0" width="100" height="48" fontSize="6" backgroundColor="#000000" foregroundColor="#FFFFFF"/>
     </view></theme>`, {}, { ...STATE, items });
  // Three 16 px rows of 20: an 8 px thumb on a 48 px track, in the bar's 16 px at the right.
  const first = () => {
    drawn.length = 0;
    skin.paint();
    return drawn.find(([k, , a]) => k === "fillText" && items.includes(a))[2];
  };
  const bar = () => drawn.filter(([k, , x]) => k === "fillRect" && x >= 84).map(([, style, x, y, w, h]) => [style, x, y, w, h]);
  first();
  assert.deepEqual(bar(), [["#262626", 84, 0, 16, 48], ["#8c8c8c", 86, 1, 12, 6]]);
  const at = (y) => ({ button: 0, clientX: 92, clientY: y, detail: 1 });
  // Grab the thumb 4 px down and drag it 20 px: 20 of 40 px to travel is row 9 of 17 (8.5, rounded).
  listeners.mousedown(at(4));
  listeners.mousemove(at(24));
  listeners.mouseup(at(24));
  assert.equal(first(), "Item 9");
  // A press on the track below the thumb pages down by three rows, above it up.
  listeners.mousedown(at(46));
  listeners.mouseup(at(46));
  assert.equal(first(), "Item 12");
  listeners.mousedown(at(2));
  listeners.mouseup(at(2));
  assert.equal(first(), "Item 9");
  // The wheel still scrolls, and a press on the bar selects nothing.
  listeners.wheel({ clientX: 40, clientY: 20, deltaY: 1 });
  assert.equal(first(), "Item 10");
  assert.equal(skin.state.channel, 0);
});

test("a long name on the playing row scrolls right to left; other rows are cut off", () => {
  const long = "A show with a name far too long for the list";
  const items = ["NTS 1", long, `Not playing: ${long}`];
  const { skin } = load(`<theme><view width="100" height="48">
       <playlist id="pl" left="0" top="0" width="100" height="48" fontSize="6"/>
     </view></theme>`, {}, { ...STATE, items, channel: 1 });
  const texts = () => {
    drawn.length = 0;
    skin.paint();
    return drawn.filter(([k]) => k === "fillText").map(([, , a, x]) => [a, x]);
  };
  // 6 px a character: 264 px of text in an 88 px box. Two copies, a loop (264 + 44 px) apart.
  const shown = texts().filter(([a]) => a === long);
  assert.equal(shown.length, 2);
  assert.equal(shown[0][1] - shown[1][1], 264 + 44);
  assert.equal(shown[1][1], 6, "it starts from its first word");
  assert.deepEqual(texts().filter(([a]) => a !== long), [["NTS 1", 6], [`Not playing: ${long}`, 6]]);
  assert.ok(skin.stepAt < Infinity, "the next step is due");
});

test("a double click on the scroll bar never opens a pick's page", () => {
  const items = Array.from({ length: 20 }, (_, i) => `Pick ${i}`);
  const { sent } = load(`<theme><view width="100" height="48">
       <playlist id="pl" left="0" top="0" width="100" height="48" fontSize="6"/>
     </view></theme>`, {}, { ...STATE, items, channel: 19, title: items[19], link: "https://www.nts.live/shows/a/episodes/a" });
  // The pick is on the bottom row of the last page: one press on it arms the link.
  const at = (x, detail) => ({ button: 0, clientX: x, clientY: 44, detail });
  listeners.mousedown(at(40, 1));
  listeners.mouseup(at(40, 1));
  // Then a double click on the thumb, level with it.
  listeners.mousedown(at(92, 1));
  listeners.mouseup(at(92, 1));
  listeners.mousedown(at(92, 2));
  listeners.mouseup(at(92, 2));
  listeners.dblclick(at(92, 2));
  assert.deepEqual(sent.filter((m) => m.type === "launchUrl"), []);
});

test("scrolling stops while other windows cover the player, and starts again after", () => {
  const { skin, set } = load(`<theme><view width="100" height="48">
       <playlist id="pl" left="0" top="0" width="100" height="48" fontSize="6"/>
     </view></theme>`, {}, { ...STATE, items: ["A show with a name far too long for the list"], covered: true });
  skin.paint();
  assert.equal(skin.stepAt, Infinity);
  set({ covered: false });
  skin.paint();
  assert.ok(skin.stepAt < Infinity);
});


test("clocks read as WMP's: minutes and seconds, then hours from an hour on", () => {
  assert.deepEqual([0, 5.9, 75, 3599, 3600, 7080, 36_061].map(clock), ["00:00", "00:05", "01:15", "59:59", "1:00:00", "1:58:00", "10:01:01"]);
});

test("a pick has a length: its clock and length show, and the seek slider and currentPosition jump in it", () => {
  const { js, sent, set } = load(`<theme><view width="100" height="40">
       <text id="pos" left="0" top="0" width="100" height="10" value="wmpprop:player.controls.currentPositionString"/>
       <text id="len" left="0" top="10" width="100" height="10" value="wmpprop:player.currentMedia.durationString"/>
       <seekslider id="bar" left="0" top="20" width="100" height="10"/>
     </view></theme>`);
  const seeks = () => sent.filter((m) => m.type === "seek");
  // A live stream: no length, the slider is disabled and a drag sends nothing.
  set({ playState: "playing", time: 30 });
  assert.deepEqual(js("[pos.value, len.value, bar.enabled, player.currentMedia.duration]"), ["00:30", "", false, 0]);
  const half = { button: 0, clientX: 50, clientY: 25 };
  listeners.mousedown(half);
  listeners.mouseup(half);
  js("player.controls.currentPosition = 10");
  assert.deepEqual(seeks(), []);
  // A pick of 1:58:00.
  set({ time: 750, duration: 7080 });
  assert.deepEqual(js("[pos.value, len.value, bar.enabled, player.currentMedia.duration]"), ["12:30", "1:58:00", true, 7080]);
  listeners.mousedown(half);
  listeners.mouseup(half);
  assert.equal(seeks().length, 1, "one seek, when the drag ends");
  assert.equal(seeks()[0].seconds, 3540);
  js("player.controls.currentPosition = 60");
  assert.deepEqual(seeks().at(-1), { type: "seek", seconds: 60 });
  assert.equal(js("pos.value"), "01:00", "shown before the host answers");
  // Paused, a pick keeps its place and its clock.
  set({ playState: "paused" });
  assert.equal(js("pos.value"), "01:00");
});

test("a seek slider whose skin handles onDragEnd seeks once, through the skin's script", () => {
  const { sent, set } = load(`<theme><view width="100" height="20">
       <slider id="pos" left="0" top="0" width="100" height="10" min="0" max="wmpprop:player.currentMedia.duration"
               value="wmpprop:player.controls.currentPosition" onDragEnd="player.controls.currentposition=value;"/>
     </view></theme>`);
  set({ playState: "playing", time: 0, duration: 1000 });
  const at = { button: 0, clientX: 25, clientY: 5 };
  listeners.mousedown(at);
  listeners.mouseup(at);
  assert.deepEqual(sent.filter((m) => m.type === "seek"), [{ type: "seek", seconds: 250 }]);
});

test("a seek slider whose onDragEnd sends no seek (Television's misspelt currentpostion) still seeks once", () => {
  const { sent, set } = load(`<theme><view width="100" height="20">
       <slider id="seek" left="0" top="0" width="100" height="10" min="0" max="wmpprop:player.currentMedia.duration"
               value="wmpprop:player.controls.currentPosition" onDragEnd="player.controls.currentpostion=value;"/>
     </view></theme>`);
  set({ playState: "playing", time: 0, duration: 1000 });
  const at = { button: 0, clientX: 50, clientY: 5 };
  listeners.mousedown(at);
  listeners.mouseup(at);
  assert.deepEqual(sent.filter((m) => m.type === "seek"), [{ type: "seek", seconds: 500 }]);
});

test("a slider that seeks only from onMouseUp (Kenwood_MP7's progressMain) seeks once on a pick, and not on a stream", () => {
  const { js, sent, set } = load(`<theme><view width="100" height="20">
       <slider id="progressMain" left="0" top="0" width="100" height="10" bordersize="0" direction="horizontal" min="0" max="wmpprop:player.currentMedia.duration"
               slide="false" onmouseup="player.controls.currentPosition=progressMain.value;" enabled="true"/>
     </view></theme>`);
  const at = { button: 0, clientX: 75, clientY: 5 };
  set({ playState: "playing", time: 0, duration: 0 });
  listeners.mousedown(at);
  listeners.mouseup(at);
  assert.deepEqual(sent.filter((m) => m.type === "seek"), [], "a live stream cannot seek");
  set({ duration: 1000 });
  listeners.mousedown(at);
  listeners.mouseup(at);
  assert.deepEqual(sent.filter((m) => m.type === "seek"), [{ type: "seek", seconds: 750 }]);
  // It follows nothing, so the thumb stays where it was dropped.
  set({ time: 760 });
  assert.equal(js("progressMain.value"), 750);
});

test("a seek slider whose onMouseUp seeks (anime's) seeks once, not again from the engine", () => {
  const { sent, set } = load(`<theme><view width="100" height="20">
       <slider id="seek" left="0" top="0" width="100" height="10" min="0" max="wmpprop:player.currentMedia.duration"
               onmouseup = "player.controls.currentPosition = seek.value; " value="wmpprop:player.controls.currentposition" onDragEnd="player.controls.currentpostion=value;"/>
     </view></theme>`);
  set({ playState: "playing", time: 0, duration: 1000 });
  const at = { button: 0, clientX: 50, clientY: 5 };
  listeners.mousedown(at);
  listeners.mouseup(at);
  assert.deepEqual(sent.filter((m) => m.type === "seek"), [{ type: "seek", seconds: 500 }]);
});

test("the playlist lies over every image in the view, whatever its zIndex or place, and takes the pointer there (ATA-198)", () => {
  const items = ["NTS 1", "NTS 2"];
  // A subview drawn all over, after the list in the markup, and a list behind its parent's background.
  const data = new Uint8ClampedArray(100 * 60 * 4).fill(200);
  const { skin, sent } = load(
    `<theme><view width="100" height="60">
       <subview id="box" width="100" height="60">
         <playlist id="pl" zIndex="-2" left="0" top="0" width="100" height="40" fontSize="6"/>
       </subview>
       <subview id="over" width="100" height="60" backgroundColor="#FF0000" backgroundImage="body.bmp"/>
     </view></theme>`,
    {},
    { ...STATE, items },
    new Map([["body.bmp", { width: 100, height: 60, data, bitmap: {} }]]),
  );
  drawn.length = 0;
  skin.paint();
  const red = drawn.findIndex(([k, style]) => k === "fillRect" && style === "#ff0000");
  const text = drawn.findIndex(([k, , a]) => k === "fillText" && a === "NTS 2");
  assert.ok(red >= 0 && text > red, "the list's rows are drawn after the subview over it");
  const row = { button: 0, clientX: 5, clientY: 16 + 8 };
  listeners.mousedown(row);
  listeners.mouseup(row);
  assert.deepEqual(sent.filter((m) => m.type === "select"), [{ type: "select", index: 1 }]);
  assert.equal(sent.filter((m) => m.type === "drag").length, 0, "the press is on the list, not the body over it");
});

test("a boolean attribute that starts with false is false, whatever follows (The_Doobie_Brothers' playlist button)", () => {
  const { js } = load(`<theme><view width="10" height="10">
       <button id="b" sticky="true" down="false; jscript:pl.visible='true';"/>
       <button id="c" down="true"/>
     </view></theme>`);
  assert.deepEqual(js("[b.down, c.down]"), [false, true]);
});

test("a shown playlist is part of the window shape, even over a hole in a subview (TEDDY's list)", () => {
  const { skin, js } = load(`<theme><view width="100" height="60">
       <subview id="drawer" left="10" top="5" width="80" height="50" clippingColor="#B3ABAB">
         <playlist id="pl" left="3" top="4" width="60" height="30" fontSize="6"/>
       </subview>
     </view></theme>`);
  // The shape pass fills the list's place on the canvas; painting the list fills its own box.
  const shaped = () => {
    drawn.length = 0;
    skin.changed();
    skin.paint();
    return drawn.some(([k, , ...a]) => k === "fillRect" && a.join() === "13,9,60,30");
  };
  assert.equal(shaped(), true);
  js("pl.visible = false");
  assert.equal(shaped(), false, "a hidden list leaves the shape alone");
});

test("a playlist that names a light background and no text colour draws its rows in black (Primitive)", () => {
  const items = ["NTS 1", "NTS 2"];
  const { skin } = load(`<theme><view width="100" height="60">
       <playlist id="pl" left="0" top="0" width="100" height="48" fontSize="6" backgroundColor="#F7C473"/>
     </view></theme>`, {}, { ...STATE, items, channel: 0 });
  drawn.length = 0;
  skin.paint();
  assert.deepEqual(drawn.filter(([k, , a]) => k === "fillText" && a === "NTS 2").map(([, style]) => style), ["#000000"]);
});

test("a button group with no image takes clicks only on its elements (Cablemusic's playlist tab under its close buttons)", () => {
  // 20×20 map: the left half the close button's colour, the right half nothing mapped.
  const data = new Uint8ClampedArray(20 * 20 * 4);
  for (let i = 0; i < 400; i++) data.set(i % 20 < 10 ? [255, 0, 0, 255] : [0, 0, 0, 255], i * 4);
  const { js } = load(
    `<theme><view width="20" height="20">
       <button id="tab" width="20" height="20" onClick="tabs++;"/>
       <buttongroup mappingImage="map.bmp"><buttonelement mappingColor="#FF0000" onClick="closes++;"/></buttongroup>
     </view></theme>`,
    {},
    STATE,
    new Map([["map.bmp", { width: 20, height: 20, data, bitmap: {} }]]),
  );
  js("tabs = 0, closes = 0");
  for (const x of [5, 15]) {
    listeners.mousedown({ button: 0, clientX: x, clientY: 5 });
    listeners.mouseup({ button: 0, clientX: x, clientY: 5 });
  }
  assert.deepEqual(js("[closes, tabs]"), [1, 1]);
});

test("a button whose image is all transparencyColor is a hotspot over its box (holiday_skin, Grinch's playlist button)", () => {
  // A 2×2 tile of the transparency colour on a 16×12 button, as holiday_skin's are.
  const clear = new Uint8ClampedArray(2 * 2 * 4);
  for (let i = 0; i < 4; i++) clear.set([51, 51, 51, 255], i * 4);
  const { js } = load(
    `<theme><view width="20" height="20">
       <button id="b" image="clear.gif" tiled="true" width="16" height="12" transparencyColor="#333333" onClick="presses++;"/>
     </view></theme>`,
    {},
    STATE,
    new Map([["clear.gif", { width: 2, height: 2, data: clear, bitmap: {} }]]),
  );
  js("presses = 0");
  for (const [x, y] of [[10, 8], [18, 18]]) {
    listeners.mousedown({ button: 0, clientX: x, clientY: y });
    listeners.mouseup({ button: 0, clientX: x, clientY: y });
  }
  assert.equal(js("presses"), 1, "inside the box, not outside it");
});

test("playlist.setColumnWidth does nothing, so the code after it runs (TwinBlade's playlist drawer)", () => {
  const { js } = load(`<theme><view width="10" height="10">
       <playlist id="pl" visible="false"/>
     </view></theme>`);
  js("(pl.setColumnWidth(0, 110), pl.visible = true)");
  assert.equal(js("pl.visible"), true);
});
