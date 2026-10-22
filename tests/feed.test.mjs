// Run with `npm test`. macOS's stream feed (ATA-236), against a stub
// MediaSource, SourceBuffer and fetch: how it ends, aborts and trims.
import assert from "node:assert/strict";
import { test } from "node:test";

/** What the stubs saw: SourceBuffer calls and endOfStream's argument. */
let log;
let source;
let ended;
class StubSource {
  static isTypeSupported = (type) => type === "audio/mpeg";
  readyState = "open";
  listeners = {};
  constructor() {
    source = this;
  }
  addEventListener(type, f) {
    this.listeners[type] = f;
  }
  addSourceBuffer() {
    const listeners = [];
    const done = () => queueMicrotask(() => listeners.splice(0).forEach((f) => f()));
    return {
      buffered: { length: 1, start: () => 0 },
      addEventListener: (_type, f) => listeners.push(f),
      remove: (from, to) => (log.push(`remove ${from}-${to}`), done()),
      appendBuffer: (chunk) => (log.push(`append ${chunk.length}`), done()),
    };
  }
  endOfStream(error) {
    this.readyState = "ended";
    log.push(error ? `end ${error}` : "end");
    ended();
  }
}
let signal;
let response;
Object.assign(globalThis, { MediaSource: StubSource, fetch: (_url, init) => ((signal = init.signal), Promise.resolve(response)) });
URL.createObjectURL = () => "blob:feed";
URL.revokeObjectURL = () => {};
const { feed } = await import("../src/feed.ts");

/** A body that gives `chunks`, then ends. */
const body = (chunks) => ({ getReader: () => ({ read: async () => (chunks.length ? { done: false, value: chunks.shift() } : { done: true }) }) });

/** Feeds `audio` from `response` until the stub MediaSource is ended. */
async function run(res, audio = { currentTime: 0 }) {
  log = [];
  response = res;
  const done = new Promise((resolve) => (ended = resolve));
  assert.equal(feed(audio, "https://streams.radiomast.io/nts1"), "blob:feed");
  source.listeners.sourceopen();
  await done;
  return log;
}

test("a non-OK response ends the source with a network error", async () => {
  assert.deepEqual(await run({ ok: false, status: 503 }), ["end network"]);
});

test("a stream that finishes ends the source, so the element fires ended", async () => {
  assert.deepEqual(await run({ ok: true, body: body([new Uint8Array(3), new Uint8Array(2)]) }), ["append 3", "append 2", "end"]);
});

test("audio played more than 30 s ago is removed before the next append", async () => {
  assert.deepEqual(await run({ ok: true, body: body([new Uint8Array(4)]) }, { currentTime: 40 }), ["remove 0-10", "append 4", "end"]);
});

test("the element letting go of the source aborts the fetch", async () => {
  log = [];
  response = { ok: true, body: { getReader: () => ({ read: () => new Promise(() => {}) }) } };
  feed({ currentTime: 0 }, "https://streams.radiomast.io/nts1");
  source.listeners.sourceopen();
  await new Promise((resolve) => setTimeout(resolve));
  assert.equal(signal.aborted, false);
  source.listeners.sourceclose();
  assert.equal(signal.aborted, true);
});

test("without MediaSource support for MP3, the element gets the url", () => {
  StubSource.isTypeSupported = () => false;
  assert.equal(feed({ currentTime: 0 }, "https://streams.radiomast.io/nts2"), "https://streams.radiomast.io/nts2");
});
