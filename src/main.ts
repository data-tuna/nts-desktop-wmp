// The trusted page. It owns the audio: the <audio> element and its Web Audio
// graph never enter the skin webview, which only sends commands and gets
// state back (docs/decisions.md, ATA-107).
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { fetchLive, mergeOnAir, nextPollDelay, type OnAir } from "./live";
import { MIXTAPES_API, parseMixtapes } from "./mixtapes";
import { PICKS_API, parsePicks, type Pick } from "./picks";
import { CHANNELS, channelTitle, createPlayer, type Item } from "./player";
import { createWidget } from "./widget";
import { bands, samples } from "./skin/effects";

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
const source = ctx.createMediaElementSource(audio);
[source, gain, pan, ...eq, analyser].reduce((a, b) => (a.connect(b), b));
analyser.connect(ctx.destination);
// The visualisations read the stream before the volume, as WMP's do, so
// they move at any volume and when muted. Loud music tops out near -15 dB,
// which leaves the bars some headroom. 8192 points give 6 Hz bins, so the
// lowest bars, 8 Hz apart, each read their own.
const visAnalyser = new AnalyserNode(ctx, { fftSize: 8192, minDecibels: -90, maxDecibels: -15 });
source.connect(visAnalyser);

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
  | { type: "eq"; band: number; gain: number }
  | { type: "effects"; on: boolean };

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

/** Whether the skin shows a visualisation, which wants analyser frames. */
let effectsOn = false;
/** Whether other windows hide all of the player (Rust tells us, on Windows). */
let covered = false;

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
  else if (m.type === "effects") {
    effectsOn = m.on;
    startVis();
    // A skin sends this on its first paint: a new skin needs the card too.
    sendCard();
  }
  else if (m.type === "select") player.select(m.index);
  else if (m.type === "seek") player.seek(m.seconds);
  else {
    if (m.type === "volume") settings.volume = clamp(m.value, 0, 1, settings.volume);
    else if (m.type === "balance") settings.balance = clamp(m.value, -1, 1, settings.balance);
    else if (m.type === "mute") settings.mute = m.value;
    else if (m.type === "eq" && settings.eq[m.band] !== undefined) settings.eq[m.band] = clamp(m.gain, -15, 15, settings.eq[m.band]);
    apply();
  }
}

apply();
await listen<FromSkin>("skin", (e) => onSkin(e.payload));
await listen<boolean>("covered", (e) => (covered = e.payload));
// The tray menu (lib.rs): play, stop and the two channels.
await listen<string>("tray", ({ payload: id }) => {
  if (id === "play" || id === "stop") onSkin({ type: id });
  else if (id === "nts1" || id === "nts2") {
    player.select(id === "nts1" ? 0 : 1);
    onSkin({ type: "play" });
  }
});
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
  if (show) return { title: channelTitle(item.title, show.title), url, author: show.show, location: show.location ?? "", link: "", artwork: show.artwork };
  const pick = picks.get(item.url);
  if (pick) {
    const credit = pick.uploader ? `${pick.uploader} on SoundCloud` : "SoundCloud";
    // Credit first, so a skin that cuts long titles still shows it.
    return { title: `${credit} - ${pick.title}`, url, author: credit, location: "", link: pick.url, artwork: pick.artwork };
  }
  return { title: item.title, url, author: "", location: "", link: "", artwork: undefined };
}

// The show card, the "NTS show" visualisation (ATA-166): the show's title,
// up to 4 genres and its picture. The skin has no network, so this page
// fetches the picture and hands it over as a data: URL, once per change.
// Without the API or the picture, the card is the item's title alone.
let card = "";
let cardMsg: { type: "show"; title: string; genres: string[]; image: string | null } | null = null;
function sendCard() {
  if (cardMsg) void invoke("skin_send", { msg: cardMsg }).catch(() => {});
}
async function updateCard(i: number) {
  const item = items[i];
  const show = i < CHANNELS.length ? onAir[i] : undefined;
  const pick = picks.get(item.url);
  // A mixtape's name without its subtitle; a pick's without its location and tags.
  const title = show?.show ?? pick?.name ?? item.name ?? item.title;
  const genres = (show?.genres ?? pick?.tags ?? []).slice(0, 4);
  const artwork = show ? show.artwork : (pick?.artwork ?? item.artwork);
  const key = JSON.stringify([title, genres, artwork]);
  if (key === card) return;
  card = key;
  let image: string | null = null;
  try {
    const response = artwork ? await fetch(artwork, { signal: AbortSignal.timeout(10_000) }) : null;
    const blob = response?.ok ? await response.blob() : null;
    if (blob?.type.startsWith("image/")) image = await dataUrl(blob);
  } catch (error: unknown) {
    console.warn("show picture failed", error);
  }
  // Another item or show came along while this one loaded.
  if (key !== card) return;
  cardMsg = { type: "show", title, genres, image };
  sendCard();
}
const dataUrl = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });

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

// The tray's tooltip and check mark, its link to the show's page on nts.live, and while a pick
// plays its credit, which the app draws over the skin and lists in the tray (lib.rs, now_playing).
let tray = "";
function updateTray(title: string, i: number, playState: string) {
  const pick = picks.get(items[i].url);
  const credit = pick && playState !== "stopped" ? { name: pick.uploader ?? "", url: pick.url } : null;
  // The tray checks the channel that is current; a mixtape or pick checks neither.
  const channel = i < CHANNELS.length ? i : null;
  // A channel links to its show, a pick to its episode, a mixtape to nothing (ATA-172).
  const show = i < CHANNELS.length ? onAir[i] : undefined;
  const page = show?.showAlias
    ? { show: show.showAlias }
    : pick?.showAlias && pick.episodeAlias
      ? { show: pick.showAlias, episode: pick.episodeAlias }
      : null;
  if (tray === JSON.stringify([title, credit, channel, page])) return;
  tray = JSON.stringify([title, credit, channel, page]);
  void invoke("now_playing", { title, credit, channel, page }).catch((e: unknown) => console.warn("now_playing", e));
}

// 4 updates a second covers the clock and title. The visualisation gets its
// own frames, below.
setInterval(() => {
  const now = player.state();
  const { artwork: _, ...shown } = info(now.channel);
  updateOverlay(now.channel);
  void updateCard(now.channel);
  updateTray(shown.title, now.channel, now.playState);
  const state = { type: "state", ...now, ...shown, items: items.map((_, i) => info(i).title), ...settings, level: level() };
  void invoke("skin_send", { msg: state }).catch(() => {});
  startVis();
}, 250);

// Analyser frames for the skin's visualisation, 20 a second (ATA-122), only
// while one is on screen, no other window covers the player and the stream
// plays. The loop asks for display frames only then: idle, it cost about 4 %
// of a core (ATA-116). The state tick above starts it again. Rust hides the
// webviews while the window is minimised, so requestAnimationFrame, and the
// frames, stop then.
const spectrum = new Uint8Array(visAnalyser.frequencyBinCount);
const wave = new Uint8Array(visAnalyser.fftSize);
let lastFrame = 0;
let flatSent = false;
let visLooping = false;
function startVis() {
  if (visLooping) return;
  visLooping = true;
  requestAnimationFrame(visFrame);
}
function visFrame(now: number) {
  visLooping = false;
  const { playState, channel } = player.state();
  if (!effectsOn || covered || playState !== "playing") return;
  // A pick plays outside our Web Audio graph: one flat frame clears the last
  // stream frame, then nothing until a stream plays. Silence, not the
  // analyser's data, which still holds the stream's last moments.
  if (items[channel]?.pick) {
    if (!flatSent) void invoke("skin_send", { msg: { type: "vis", bars: Array(32).fill(0), wave: Array(96).fill(128) } }).catch(() => {});
    flatSent = true;
    return;
  }
  startVis();
  // 45, not 50: at 60 Hz the third display frame comes 50 ms on, give or take.
  if (now - lastFrame < 45) return;
  flatSent = false;
  lastFrame = now;
  visAnalyser.getByteFrequencyData(spectrum);
  // The scope shows the newest 2048 samples (43 ms at 48 kHz): all 8192
  // would alias at 96 points, and a shorter buffer gets the oldest ones.
  visAnalyser.getByteTimeDomainData(wave);
  // Milkdrop gets the newest 1024 as they are: Butterchurn reads its levels from them (ATA-167).
  const msg = { type: "vis", bars: bands(spectrum, ctx.sampleRate, 32), wave: samples(wave.subarray(-2048), 96), pcm: Array.from(wave.subarray(-1024)) };
  void invoke("skin_send", { msg }).catch(() => {});
}

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
