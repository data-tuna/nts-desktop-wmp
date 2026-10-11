// Run with `npm test`. The SoundCloud widget driver, against a stub frame:
// what it posts to the widget, and how it reads the widget's events.
import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";

let onMessage;
const frame = { style: {}, setAttribute() {}, src: "", posted: [], contentWindow: null };
frame.contentWindow = { postMessage: (data) => frame.posted.push(JSON.parse(data).method) };
Object.assign(globalThis, {
  document: { createElement: () => frame, body: { append() {} } },
  window: { addEventListener: (type, f) => (onMessage = f) },
});
console.warn = () => {};
const { createWidget } = await import("../src/widget.ts");

beforeEach(() => mock.timers.enable({ apis: ["setTimeout"] }));
afterEach(() => mock.timers.reset());

const ORIGIN = "https://w.soundcloud.com";
const from = (method, value, source = frame.contentWindow) => onMessage({ origin: ORIGIN, source, data: JSON.stringify({ method, value }) });

function setup() {
  frame.posted = [];
  const events = [];
  const widget = createWidget({
    finish: () => events.push("finish"),
    error: (reason) => events.push(`error ${reason}`),
    paused: () => events.push("paused"),
    uploader: (url, name) => events.push(`uploader ${name}`),
  });
  return { widget, events };
}

test("a pick loads, plays once ready, and reports its uploader, clock and finish", () => {
  const { widget, events } = setup();
  widget.play("https://soundcloud.com/a/b");
  assert.match(frame.src, /^https:\/\/w\.soundcloud\.com\/player\/\?url=https%3A%2F%2Fsoundcloud\.com%2Fa%2Fb/);
  // Nothing counts before the new page says ready: it may be the last pick's page.
  from("play");
  assert.equal(widget.playing, false);
  // Nor anything from another origin or frame.
  onMessage({ origin: "https://evil.example", source: frame.contentWindow, data: JSON.stringify({ method: "ready" }) });
  from("ready", undefined, {});
  assert.deepEqual(frame.posted, []);
  from("ready");
  assert.equal(frame.posted.at(-1), "play");
  from("getCurrentSound", { user: { username: " NTS Latest " } });
  from("play");
  from("playProgress", { currentPosition: 12_500 });
  assert.deepEqual([widget.playing, widget.time], [true, 12.5]);
  // Play on a playing pick sends nothing: the widget would toggle to pause.
  frame.posted = [];
  widget.play("https://soundcloud.com/a/b");
  assert.deepEqual(frame.posted, []);
  from("finish");
  assert.deepEqual(events, ["uploader NTS Latest", "finish"]);
});

test("our pause is not reported back; a pause the widget makes itself is", () => {
  const { widget, events } = setup();
  widget.play("https://soundcloud.com/a/c");
  from("ready");
  from("play");
  widget.pause();
  from("pause");
  assert.deepEqual(events, []);
  widget.play("https://soundcloud.com/a/c");
  assert.equal(frame.posted.at(-1), "play", "resumes the loaded pick rather than reloading it");
  from("play");
  from("pause");
  assert.deepEqual(events, ["paused"]);
});

test("a pick that has not started in 15 s, or errors, is given up and unloaded", () => {
  const { widget, events } = setup();
  widget.play("https://soundcloud.com/a/d");
  mock.timers.tick(15_000);
  assert.deepEqual(events, ["error timeout"]);
  assert.equal(frame.src, "about:blank");
  widget.play("https://soundcloud.com/a/e");
  from("ready");
  from("play");
  mock.timers.tick(60_000);
  from("error", "gone");
  assert.deepEqual(events, ["error timeout", "error gone"]);
  assert.equal(frame.src, "about:blank");
});
