// The trusted page. It owns the audio: the <audio> element and its Web Audio
// graph never enter the skin webview, which only sends commands and gets
// state back (docs/decisions.md, ATA-107).
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { createPlayer } from "./player";

const BANDS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
const SETTINGS_KEY = "player";

const audio = new Audio();
// Without it the stream is opaque to Web Audio and plays as silence.
audio.crossOrigin = "anonymous";
const ctx = new AudioContext();
const gain = ctx.createGain();
const pan = ctx.createStereoPanner();
const eq = BANDS.map((frequency) => new BiquadFilterNode(ctx, { type: "peaking", frequency, Q: 1.4 }));
const analyser = ctx.createAnalyser();
[ctx.createMediaElementSource(audio), gain, pan, ...eq, analyser].reduce((a, b) => (a.connect(b), b));
analyser.connect(ctx.destination);

const player = createPlayer(audio);

type FromSkin =
  | { type: "play" | "pause" | "stop" | "next" | "previous" }
  | { type: "volume" | "balance"; value: number }
  | { type: "mute"; value: boolean }
  | { type: "seek"; seconds: number }
  | { type: "eq"; band: number; gain: number };

const clamp = (v: unknown, lo: number, hi: number, fallback: number) =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;

// Volume, mute, balance and EQ survive a restart. The channel does not: the
// app always opens on NTS 1.
const settings = (() => {
  let saved: Record<string, unknown> = {};
  try {
    saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}") ?? {};
  } catch {
    // A broken entry falls back to the defaults.
  }
  const savedEq = Array.isArray(saved.eq) ? saved.eq : [];
  return {
    volume: clamp(saved.volume, 0, 1, 0.8),
    mute: saved.mute === true,
    balance: clamp(saved.balance, -1, 1, 0),
    eq: BANDS.map((_, i) => clamp(savedEq[i], -15, 15, 0)),
  };
})();

function apply() {
  gain.gain.value = settings.mute ? 0 : settings.volume;
  pan.pan.value = settings.balance;
  settings.eq.forEach((g, i) => (eq[i].gain.value = g));
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

function onSkin(m: FromSkin) {
  if (m.type === "play") {
    void ctx.resume();
    player.play();
  } else if (m.type === "pause") player.pause();
  else if (m.type === "stop") player.stop();
  else if (m.type === "next") player.step(1);
  else if (m.type === "previous") player.step(-1);
  else if (m.type === "volume") settings.volume = clamp(m.value, 0, 1, settings.volume);
  else if (m.type === "balance") settings.balance = clamp(m.value, -1, 1, settings.balance);
  else if (m.type === "mute") settings.mute = m.value;
  else if (m.type === "eq" && settings.eq[m.band] !== undefined) settings.eq[m.band] = clamp(m.gain, -15, 15, 0);
  // ponytail: seek is accepted but a live stream has nowhere to seek to.
  // Mixtapes are live too; revisit if a seekable source ever arrives.
  apply();
}

apply();
await listen<FromSkin>("skin", (e) => onSkin(e.payload));
// On launch, NTS 1 plays. The browser arguments allow autoplay.
onSkin({ type: "play" });

const buf = new Float32Array(analyser.fftSize);
function level() {
  analyser.getFloatTimeDomainData(buf);
  return Math.sqrt(buf.reduce((s, v) => s + v * v, 0) / buf.length);
}

// ponytail: 4 updates a second covers the clock and title. The visualiser
// (ATA-114) will want levels at frame rate; measure this path then.
setInterval(() => {
  // duration 0: a live stream, which has no length and cannot seek (WMP's convention).
  const state = { type: "state", ...player.state(), duration: 0, ...settings, level: level() };
  void invoke("skin_send", { msg: state }).catch(() => {});
}, 250);

if (import.meta.env.DEV) {
  // ATA-107 comparison only: the other host the spike tried, a sandboxed
  // srcdoc frame inside this page. tools/escape.mjs probes it.
  Object.assign(window, {
    frameHost() {
      const f = document.createElement("iframe");
      f.sandbox.add("allow-scripts");
      f.srcdoc = "<!doctype html><title>frame host</title>";
      f.style.display = "none";
      document.body.append(f);
    },
  });
}
