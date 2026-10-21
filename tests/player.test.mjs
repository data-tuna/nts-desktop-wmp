// Run with `npm test`. Reconnect, channel switching and play states, against
// a stand-in for the <audio> element and mocked timers.
import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import { readFileSync } from "node:fs";
import { parsePicks } from "../src/picks.ts";
import { CHANNELS, channelTitle, createPlayer, playlist, silence } from "../src/player.ts";

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
      // The silent clip pause and stop hold is not a stream load.
      if (audio.src === silence()) return Promise.resolve();
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
  assert.deepEqual(player.state(), { playState: "playing", channel: 0, title: "NTS 1", time: 0, duration: 0 });
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

test("the silent clip is a 6 s WAV", async () => {
  const wav = new Uint8Array(await (await fetch(silence())).arrayBuffer());
  const text = (a, b) => String.fromCharCode(...wav.slice(a, b));
  assert.equal(text(0, 4) + text(8, 16) + text(36, 40), "RIFFWAVEfmt data");
  assert.equal(wav.length, 44 + 6 * 8000);
  assert.ok(wav.slice(44).every((b) => b === 128));
});

test("pause and stop hold a silent clip, not the stream; play loads afresh", () => {
  for (const action of ["pause", "stop"]) {
    const audio = fakeAudio();
    const player = createPlayer(audio);
    player.play();
    player[action]();
    assert.equal(audio.src, silence(), action);
    assert.equal(audio.loop, true, action);
    assert.equal(audio.paused, true, action);
    // Paused, a stalled clock is not a drop.
    mock.timers.tick(30_000);
    assert.equal(audio.loads.length, 1, action);
    player.play();
    assert.deepEqual(audio.loads, [NTS1, NTS1], action);
  }
});

test("play while playing keeps the stream; a refused autoplay stops instead of looping", async () => {
  const audio = fakeAudio();
  const player = createPlayer(audio);
  player.play();
  player.play();
  assert.equal(audio.loads.length, 1);

  const refused = fakeAudio();
  refused.play = () => Promise.reject(Object.assign(new Error("autoplay"), { name: "NotAllowedError" }));
  const blocked = createPlayer(refused);
  blocked.play();
  await Promise.resolve();
  assert.equal(blocked.state().playState, "stopped");
  mock.timers.tick(60_000);
  assert.equal(blocked.state().playState, "stopped");
});

/** A SoundCloud widget stand-in that records what it was told. */
function fakeWidget() {
  const w = { calls: [], playing: false, time: 0, duration: 0, url: "" };
  for (const name of ["play", "pause", "stop", "unload", "seek"]) w[name] = (url) => w.calls.push(url ? `${name} ${url}` : name);
  const { play, unload } = w;
  w.play = (url) => ((w.url = url), play(url));
  w.unload = () => ((w.url = ""), unload());
  return w;
}

test("mixtapes and picks join the playlist; a pick plays through the widget, a stream lets go of it", () => {
  const audio = fakeAudio();
  const widget = fakeWidget();
  const items = [...CHANNELS, { title: "Poolside", url: "https://streams.radiomast.io/poolside" }, { title: "A pick", url: "https://soundcloud.com/a/b", pick: true }];
  const player = createPlayer(audio, items, widget);
  player.play();
  player.select(3);
  assert.equal(player.state().playState, "buffering");
  widget.playing = true;
  widget.time = 12;
  widget.duration = 7080;
  assert.deepEqual(player.state(), { playState: "playing", channel: 3, title: "A pick", time: 12, duration: 7080 });
  player.seek(600);
  assert.equal(audio.src, "", "the stream stops while a pick plays");
  player.pause();
  player.play();
  player.step(1);
  assert.deepEqual(audio.loads, [NTS1, NTS1]);
  assert.deepEqual(widget.calls, ["unload", "play https://soundcloud.com/a/b", "seek 600", "pause", "play https://soundcloud.com/a/b", "unload"]);
  // A stream has no length and nowhere to seek to.
  player.seek(10);
  assert.equal(widget.calls.at(-1), "unload");
  assert.equal(player.state().duration, 0);
  player.step(-2);
  assert.deepEqual(audio.loads.at(-1), "https://streams.radiomast.io/poolside");
});

test("a stalled pick is not reloaded", () => {
  const audio = fakeAudio();
  const widget = fakeWidget();
  const player = createPlayer(audio, [...CHANNELS, { title: "A pick", url: "https://soundcloud.com/a/b", pick: true }], widget);
  player.select(2);
  player.play();
  audio.fire("error");
  mock.timers.tick(60_000);
  assert.deepEqual(widget.calls, ["play https://soundcloud.com/a/b"]);
  assert.equal(player.state().playState, "buffering");
});

test("selecting the item already playing leaves it alone", () => {
  const audio = fakeAudio();
  const player = createPlayer(audio);
  player.play();
  player.select(0);
  assert.deepEqual(audio.loads, [NTS1]);
  player.select(1);
  assert.deepEqual(audio.loads, [NTS1, NTS2]);
});

test("a channel's title leads with the channel", () => {
  assert.equal(channelTitle("NTS 1", "Pool Side Slow Focus - London"), "NTS 1: Pool Side Slow Focus - London");
  assert.equal(channelTitle("NTS 2", "A show"), "NTS 2: A show");
});

test("a paused pick's clock and seeking stay with it when the playlist moves to another pick", () => {
  const audio = fakeAudio();
  const widget = fakeWidget();
  const [a, b] = ["https://soundcloud.com/a/a", "https://soundcloud.com/a/b"];
  const player = createPlayer(audio, [...CHANNELS, { title: "Pick A", url: a, pick: true }, { title: "Pick B", url: b, pick: true }], widget);
  player.select(2);
  player.play();
  Object.assign(widget, { playing: true, time: 2712, duration: 7080 });
  player.pause();
  // Next while paused: B is current, A stays loaded.
  player.step(1);
  assert.deepEqual([player.state().title, player.state().time, player.state().duration], ["Pick B", 0, 0]);
  player.seek(100);
  assert.ok(!widget.calls.includes("seek 100"), "never seeks the other pick");
  // Back to A: its place again, and it resumes rather than reloads.
  player.step(-1);
  assert.deepEqual([player.state().time, player.state().duration], [2712, 7080]);
  player.play();
  assert.deepEqual(widget.calls.filter((c) => c.startsWith("play")), [`play ${a}`, `play ${a}`]);
});

test("the playlist is NTS 1, NTS 2, the picks in the API's order, then the mixtapes, each section under a header; a pick's title is the episode's (ATA-197, ATA-208)", () => {
  const picks = parsePicks(JSON.parse(readFileSync(new URL("picks-fixture.json", import.meta.url), "utf8")));
  const mixtape = { title: "Poolside", url: "https://streams.radiomast.io/poolside" };
  const items = playlist(picks, [mixtape]);
  assert.deepEqual(
    items.map((item) => item.title),
    [
      "NTS 1",
      "NTS 2",
      "— NTS Picks —",
      "Experimental, Minimal, Beats, Minimal Talkin · Buried Light - 100% AshTreJinkins - Los Angeles",
      "Electronica, Reggaeton, Arabic Pop · POST-SUMMER DANCE RITUALS W/ JEAN-BAPTISTE DOMINICI - Paris",
      "— Infinite Mixtapes —",
      "Poolside",
    ],
  );
  assert.deepEqual(items.map((item) => !!item.pick), [false, false, false, true, true, false, false]);
  assert.equal(items[3].url, picks[0].url);
  assert.deepEqual(playlist([], []), CHANNELS);
  assert.deepEqual(playlist([], [mixtape]).map((item) => item.title), ["NTS 1", "NTS 2", "— Infinite Mixtapes —", "Poolside"]);
});

test("a header row never plays: next and previous pass over it, a click on it does nothing (ATA-208)", () => {
  const audio = fakeAudio();
  const widget = fakeWidget();
  const items = playlist([{ title: "A pick", url: "https://soundcloud.com/a/b" }], [{ title: "Poolside", url: "https://streams.radiomast.io/poolside" }]);
  const player = createPlayer(audio, items, widget);
  player.play();
  player.select(2);
  assert.equal(player.state().channel, 0);
  player.step(1);
  player.step(1);
  assert.equal(player.state().channel, 3);
  player.step(1);
  assert.equal(player.state().channel, 5);
  player.step(-1);
  assert.equal(player.state().channel, 3);
  player.step(-1);
  player.step(-1);
  player.step(-1);
  assert.equal(player.state().channel, 5, "wraps past the channels");
  assert.ok(!audio.loads.includes(""), "never loads a header");
});
