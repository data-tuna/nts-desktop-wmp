// The trusted page. It owns the audio: the <audio> element and its Web Audio
// graph never enter the skin webview, which only sends commands and gets
// state back (docs/decisions.md, ATA-107).
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

const STREAM = "https://streams.radiomast.io/nts1";
const BANDS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];

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

type FromSkin =
  | { type: "play" | "stop" }
  | { type: "volume" | "balance"; value: number }
  | { type: "seek"; seconds: number }
  | { type: "eq"; band: number; gain: number };

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

function onSkin(m: FromSkin) {
  if (m.type === "play") {
    void ctx.resume();
    audio.src = STREAM;
    void audio.play();
  } else if (m.type === "stop") {
    // A live stream has nothing to resume: drop the connection.
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
  } else if (m.type === "volume") gain.gain.value = clamp(m.value, 0, 1);
  else if (m.type === "balance") pan.pan.value = clamp(m.value, -1, 1);
  else if (m.type === "eq" && eq[m.band]) eq[m.band].gain.value = clamp(m.gain, -15, 15);
  // ponytail: seek is accepted but a live stream has nowhere to seek to.
  // Mixtapes are live too; revisit if a seekable source ever arrives.
}

await listen<FromSkin>("skin", (e) => onSkin(e.payload));

const buf = new Float32Array(analyser.fftSize);
function level() {
  analyser.getFloatTimeDomainData(buf);
  return Math.sqrt(buf.reduce((s, v) => s + v * v, 0) / buf.length);
}

// ponytail: 4 updates a second covers the clock and title. The visualiser
// (ATA-114) will want levels at frame rate; measure this path then.
setInterval(() => {
  const state = { type: "state", playing: !audio.paused, time: audio.currentTime, title: "NTS 1", level: level() };
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
