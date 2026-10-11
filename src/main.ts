// The trusted page. It owns the audio: the <audio> element and its Web Audio
// graph never enter the skin webview, which only sends commands and gets
// state back (docs/decisions.md, ATA-107).
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { fetchLive, mergeOnAir, nextPollDelay, type OnAir } from "./live";
import { MIXTAPES_API, parseMixtapes } from "./mixtapes";
import { PICKS_API, parsePicks, type Pick } from "./picks";
import { CHANNELS, createPlayer, type Item } from "./player";
import { createWidget } from "./widget";

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

// The channels, then the Infinite Mixtapes, then the NTS Picks, once their APIs answer.
const items: Item[] = [...CHANNELS];
const picks = new Map<string, Pick & { uploader?: string }>();
const widget = createWidget({
  finish() {
    player.step(1);
    player.play();
  },
  error: () => player.stop(),
  paused: () => player.pause(),
  resumed: () => player.play(),
  uploader: (url, name) => {
    const pick = picks.get(url);
    if (pick) pick.uploader = name;
  },
});
const player = createPlayer(audio, items, widget);
// The show on each channel; undefined where the live API gave none.
let onAir: (OnAir | undefined)[] = [];

type FromSkin =
  | { type: "play" | "pause" | "stop" | "next" | "previous" }
  | { type: "select"; index: number }
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
  widget.setVolume(gain.gain.value);
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
  else if (m.type === "select") player.select(m.index);
  else if (m.type === "seek") {
    // ponytail: seek is accepted but a live stream has nowhere to seek to.
    // Mixtapes are live too; revisit if a seekable source ever arrives.
  } else {
    if (m.type === "volume") settings.volume = clamp(m.value, 0, 1, settings.volume);
    else if (m.type === "balance") settings.balance = clamp(m.value, -1, 1, settings.balance);
    else if (m.type === "mute") settings.mute = m.value;
    else if (m.type === "eq" && settings.eq[m.band] !== undefined) settings.eq[m.band] = clamp(m.gain, -15, 15, settings.eq[m.band]);
    apply();
  }
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

/** What a skin shows for item `i`: `title` is `player.currentMedia.name`,
 * `author` and `location` its item info, `link` the page a double click on the
 * title opens. SoundCloud's terms want the uploader and SoundCloud credited,
 * with a link back, wherever a pick plays, so a pick's title carries both. */
function info(i: number) {
  const item = items[i];
  const url = item.url;
  const show = i < CHANNELS.length ? onAir[i] : undefined;
  // The channel always leads, as in the Winamp app (Ata, 2026-10-09): "NTS 1 - <show> - <location>".
  if (show) return { title: `${item.title} - ${show.title}`, url, author: show.show, location: show.location ?? "", link: "", artwork: show.artwork };
  const pick = picks.get(item.url);
  if (pick) {
    const credit = pick.uploader ? `${pick.uploader} on SoundCloud` : "SoundCloud";
    // Credit first, so a skin that cuts long titles still shows it.
    return { title: `${credit} - ${pick.title}`, url, author: credit, location: "", link: pick.url, artwork: pick.artwork };
  }
  return { title: item.title, url, author: "", location: "", link: "", artwork: undefined };
}

// Windows' media overlay, through WebView2's Media Session.
let overlay = "";
function updateOverlay(i: number) {
  const { title, author, artwork } = info(i);
  if (!("mediaSession" in navigator) || overlay === JSON.stringify([title, author, artwork])) return;
  overlay = JSON.stringify([title, author, artwork]);
  navigator.mediaSession.metadata = new MediaMetadata({ title, artist: author, artwork: artwork ? [{ src: artwork, sizes: "200x200" }] : [] });
}
if ("mediaSession" in navigator) {
  const actions: [MediaSessionAction, FromSkin["type"]][] = [["play", "play"], ["pause", "pause"], ["stop", "stop"], ["nexttrack", "next"], ["previoustrack", "previous"]];
  for (const [action, type] of actions) navigator.mediaSession.setActionHandler(action, () => onSkin({ type } as FromSkin));
}

// ponytail: 4 updates a second covers the clock and title. The visualiser
// (ATA-114) will want levels at frame rate; measure this path then.
setInterval(() => {
  const now = player.state();
  const { artwork: _, ...shown } = info(now.channel);
  updateOverlay(now.channel);
  // duration 0: live streams have no length and cannot seek (WMP's convention).
  // ponytail: picks have a length, and SoundCloud's widget can seek; they are shown as live too until someone asks to seek a pick.
  const state = { type: "state", ...now, ...shown, items: items.map((_, i) => info(i).title), duration: 0, ...settings, level: level() };
  void invoke("skin_send", { msg: state }).catch(() => {});
}, 250);

// The show on air. Nothing here touches playback: when the API fails the
// titles fall back to "NTS 1" and "NTS 2" and the stream plays on.
async function poll() {
  let fresh: (OnAir | undefined)[] = [];
  try {
    fresh = await fetchLive();
  } catch (error: unknown) {
    console.warn("NTS live API failed", error);
  }
  const now = Date.now();
  onAir = mergeOnAir(onAir, fresh, CHANNELS.length, now);
  setTimeout(() => void poll(), nextPollDelay(onAir, now));
}
void poll();

// Mixtapes and picks, once per launch. A failure leaves just the channels.
async function list<T>(api: string, parse: (body: unknown) => T[]): Promise<T[]> {
  const response = await fetch(api, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`${api}: HTTP ${response.status}`);
  return parse(await response.json());
}
void Promise.allSettled([list(MIXTAPES_API, parseMixtapes), list(PICKS_API, parsePicks)]).then(([mixtapes, picked]) => {
  if (mixtapes.status === "fulfilled") items.push(...mixtapes.value);
  else console.warn("No Infinite Mixtapes this launch", mixtapes.reason);
  if (picked.status === "rejected") return console.warn("No NTS Picks this launch", picked.reason);
  for (const pick of picked.value) {
    picks.set(pick.url, pick);
    items.push({ title: pick.title, url: pick.url, pick: true });
  }
});

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
