// Run with `npm test`. Reconnect, channel switching and play states, against
// a stand-in for the <audio> element and mocked timers.
import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import { CHANNELS, createPlayer } from "../src/player.ts";

beforeEach(() => mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] }));
afterEach(() => mock.timers.reset());

/** An <audio> element that "plays" whatever src it was given, until told otherwise. */
function fakeAudio() {
  const listeners = {};
  const audio = {
    src: "",
    currentTime: 0,
    paused: true,
    readyState: 0,
    loads: [],
    play() {
      audio.loads.push(audio.src);
      audio.paused = false;
      audio.readyState = 4;
      return Promise.resolve();
    },
    pause: () => (audio.paused = true),
    load: () => (audio.currentTime = 0),
    removeAttribute: () => (audio.src = ""),
    addEventListener: (type, fn) => (listeners[type] = fn),
    fire: (type) => listeners[type](),
  };
  return audio;
}

const [NTS1, NTS2] = CHANNELS.map((c) => c.url);

test("play starts NTS 1; next and previous wrap around", () => {
  const audio = fakeAudio();
  const player = createPlayer(audio);
  player.play();
  assert.deepEqual(player.state(), { playState: "playing", channel: 0, title: "NTS 1", time: 0 });
  player.step(1);
  player.step(1);
  player.step(-1);
  player.step(-1);
  player.step(-1);
  assert.deepEqual(audio.loads, [NTS1, NTS2, NTS1, NTS2, NTS1, NTS2]);
  assert.equal(player.state().title, "NTS 2");
});

test("switching while stopped selects the channel without playing it", () => {
  const audio = fakeAudio();
  const player = createPlayer(audio);
  player.step(1);
  assert.deepEqual(audio.loads, []);
  assert.equal(player.state().playState, "stopped");
  player.play();
  assert.deepEqual(audio.loads, [NTS2]);
});

test("an error reloads the same channel with backoff, never the other one", () => {
  const audio = fakeAudio();
  const player = createPlayer(audio);
  player.step(1);
  player.play();
  for (const wait of [1000, 2000, 4000, 8000, 8000]) {
    audio.fire("error");
    assert.equal(player.state().playState, "reconnecting");
    mock.timers.tick(wait - 1);
    const before = audio.loads.length;
    mock.timers.tick(1);
    assert.equal(audio.loads.length, before + 1, `retry after ${wait} ms`);
  }
  assert.ok(audio.loads.every((src) => src === NTS2));
});

test("a clock that stops for 10 s reloads; a moving clock resets the backoff", () => {
  const audio = fakeAudio();
  const player = createPlayer(audio);
  player.play();
  audio.fire("ended");
  mock.timers.tick(1000);
  audio.fire("error");
  mock.timers.tick(2000);
  assert.equal(audio.loads.length, 3);
  // It plays for a while, then the clock stops without an error.
  for (let t = 1; t <= 5; t++) {
    audio.currentTime = t;
    mock.timers.tick(1000);
  }
  mock.timers.tick(10_000);
  assert.equal(player.state().playState, "reconnecting");
  mock.timers.tick(1000);
  assert.deepEqual(audio.loads, [NTS1, NTS1, NTS1, NTS1]);
});

test("pause and stop cancel a pending retry", () => {
  for (const action of ["pause", "stop"]) {
    const audio = fakeAudio();
    const player = createPlayer(audio);
    player.play();
    audio.fire("error");
    player[action]();
    mock.timers.tick(60_000);
    audio.fire("error");
    mock.timers.tick(60_000);
    assert.equal(audio.loads.length, 1, action);
    assert.equal(player.state().playState, action === "pause" ? "paused" : "stopped");
  }
});
