// The WMP object model a skin's scripts and attributes see: `player`,
// `theme`, `mediacenter`, the members of the `equalizerSettings`,
// `videoSettings`, `network` and playlist elements, the ps* and os*
// constants, and our own stand-ins for the wmploc.dll resources skins name.
// Written from Microsoft's reference (learn.microsoft.com/windows/win32/wmp)
// and from what the ATA-103 skins call. Members a radio player cannot
// honour (DVD, the library, video) return safe defaults; anything else a
// skin reaches for is logged once and reads as undefined.
import type { State } from "./engine.ts";
import { EFFECTS, effectIndex } from "./effects.ts";

const PLAY_STATES = ["Undefined", "Stopped", "Paused", "Playing", "ScanForward", "ScanReverse", "Buffering", "Waiting", "MediaEnded", "Transitioning", "Ready", "Reconnecting"];
const OPEN_STATES = ["Undefined", "PlaylistChanging", "PlaylistLocating", "PlaylistConnecting", "PlaylistLoading", "PlaylistOpening", "PlaylistOpenNoMedia", "PlaylistChanged", "MediaChanging", "MediaLocating", "MediaConnecting", "MediaLoading", "MediaOpening", "MediaOpen", "BeginCodecAcquisition", "EndCodecAcquisition", "BeginLicenseAcquisition", "EndLicenseAcquisition", "BeginIndividualization", "EndIndividualization", "MediaWaiting", "OpeningUnknownURL"];

/** psUndefined = 0 … psReconnecting = 11, osUndefined = 0 … osOpeningUnknownURL = 21. */
export const CONSTANTS: Record<string, number> = Object.fromEntries([
  ...PLAY_STATES.map((name, i) => [`ps${name}`, i]),
  ...OPEN_STATES.map((name, i) => [`os${name}`, i]),
]);
export const OS_MEDIA_CHANGING = 8;
export const OS_MEDIA_OPEN = 13;

/** WMP's play state for the host's. A reconnect reads as buffering: WMP 7.1
 * has no psReconnecting, so the 2000–2002 skins have no name for 11 (ATA-218). */
export function playState(p: State["playState"]): number {
  return { stopped: 1, paused: 2, playing: 3, buffering: 6, reconnecting: 6 }[p];
}

/** What the runtime needs from the engine. */
export type Host = {
  readonly state: State;
  readonly openState: number;
  status(): string;
  elapsed(): string;
  controlEnabled(name: string): boolean | null;
  send(msg: { type: string; [k: string]: unknown }): void;
  /** Sets a player setting locally too, so bindings show it before the host's next state. */
  set(patch: Partial<State>): void;
  log(msg: string): void;
  viewId(): string;
  /** Whether a click is being handled now. */
  userAction(): boolean;
  /** Where this skin's preferences live in localStorage. */
  prefix: string;
};

/** A clock as WMP shows it: "02:05", and "1:58:00" from an hour on. */
export function clock(t: number): string {
  const s = Math.max(0, Math.floor(t));
  const two = (n: number) => String(n).padStart(2, "0");
  return s >= 3600 ? `${Math.floor(s / 3600)}:${two(Math.floor(s / 60) % 60)}:${two(s % 60)}` : `${two(Math.floor(s / 60))}:${two(s % 60)}`;
}

const clamp = (v: unknown, lo: number, hi: number) => Math.min(hi, Math.max(lo, Number(v) || 0));

/** Through COM, a script can read a property with call syntax:
 * `mediacenter.effectType()` reads `mediacenter.effectType`. IDispatch::Invoke
 * takes "a method or a property get" for a language that can't tell them
 * apart. `comCalls` rewrites every `.name()` with no arguments in skin code to
 * `.__wmpCall.name`. The object model and the elements answer `__wmpCall`
 * with `calls(obj, true)`; every other object gets it from Object.prototype,
 * with JavaScript's rules. */
// ponytail: textual, so it also rewrites inside string literals and breaks
// `new a.B()`. One archive skin has one in a string (tubeframe's setTimeout,
// run as code later, so unchanged); none has `new a.B()`.
export const comCalls = (code: string) => code.replace(/(?<!\.)\.(\s*[A-Za-z_$][\w$]*)\s*\(\s*\)/g, ".__wmpCall.$1");

export function calls(obj: any, com: boolean): object {
  return new Proxy(Object.create(null), {
    get(_, k) {
      const v = obj[k];
      if (typeof v === "function") return v.call(obj);
      if (com && k in obj) return v;
      throw new TypeError(`${String(k)} is not a function`);
    },
  });
}

if (!Object.prototype.hasOwnProperty("__wmpCall"))
  Object.defineProperty(Object.prototype, "__wmpCall", {
    get(this: unknown) {
      return calls(this, false);
    },
  });

/** COM objects are case-insensitive (`player.PlayState`, `player.playstate`),
 * so members are kept lower-case and looked up that way. */
export function wmpObject(name: string, members: object, log: (msg: string) => void): Record<string, any> {
  Object.setPrototypeOf(members, null);
  return new Proxy(members as Record<string, any>, {
    has: (t, k) => typeof k === "string" && k.toLowerCase() in t,
    get(t, k, proxy) {
      if (typeof k !== "string") return undefined;
      if (k === "__wmpCall") return calls(proxy, true);
      const lk = k.toLowerCase();
      if (lk in t) return t[lk];
      log(`${name}.${k} is not supported`);
      return undefined;
    },
    set(t, k, v) {
      const lk = String(k).toLowerCase();
      const d = Object.getOwnPropertyDescriptor(t, lk);
      if (d?.set || d?.writable) t[lk] = v;
      else log(`${name}.${String(k)} cannot be set, ignored`);
      return true;
    },
  });
}

/** The objects, as lower-case member tables: the engine wraps each in
 * `wmpObject`, and merges the element ones into their elements. */
export function objects(host: Host) {
  const log = (msg: string) => host.log(msg);
  const s = () => host.state;
  const media: Record<string, any> = wmpObject("player.currentMedia", {
    get name() { return s().title; },
    getiteminfo: (attr: unknown) => itemInfo(s(), String(attr)),
    get duration() { return s().duration; },
    get durationstring() { return s().duration > 0 ? clock(s().duration) : ""; },
    imagesourcewidth: 0,
    imagesourceheight: 0,
    get sourceurl() { return s().url; },
    isidentical: (other: unknown) => other === media,
  }, log);
  // The playlist: the channels, then the mixtapes and picks.
  const playlist = wmpObject("player.currentPlaylist", {
    name: "",
    get count() { return s().items.length; },
    item: (i: number) =>
      i === s().channel
        ? media
        : wmpObject("player.currentPlaylist.item", {
            name: s().items[i] ?? "",
            getiteminfo: (attr: unknown) => (/^#?title$/i.test(String(attr)) ? (s().items[i] ?? "") : ""),
            isidentical: () => false,
          }, log),
    getiteminfo: () => "",
  }, log);
  const controls = wmpObject("player.controls", {
    play: () => host.send({ type: "play" }),
    pause: () => host.send({ type: "pause" }),
    stop: () => host.send({ type: "stop" }),
    next: () => host.send({ type: "next" }),
    previous: () => host.send({ type: "previous" }),
    // A live stream has no length, so it cannot seek or scan. A pick can seek.
    fastforward: () => log("player.controls.fastForward: a live stream cannot scan"),
    fastreverse: () => log("player.controls.fastReverse: a live stream cannot scan"),
    get currentposition() { return s().time; },
    set currentposition(v: unknown) {
      if (!(s().duration > 0)) return;
      const seconds = clamp(v, 0, s().duration);
      host.set({ time: seconds });
      host.send({ type: "seek", seconds });
    },
    get currentpositionstring() { return host.elapsed(); },
    get currentitem() { return media; },
    isavailable: (name: unknown) => host.controlEnabled(String(name).toLowerCase()) ?? false,
  }, log);
  const settings = wmpObject("player.settings", {
    get volume() { return Math.round(s().volume * 100); },
    set volume(v: unknown) {
      const volume = clamp(v, 0, 100) / 100;
      host.set({ volume });
      host.send({ type: "volume", value: volume });
    },
    get balance() { return Math.round(s().balance * 100); },
    set balance(v: unknown) {
      const balance = clamp(v, -100, 100) / 100;
      host.set({ balance });
      host.send({ type: "balance", value: balance });
    },
    get mute() { return s().mute; },
    set mute(v: unknown) {
      const mute = v === true || String(v).toLowerCase() === "true";
      host.set({ mute });
      host.send({ type: "mute", value: mute });
    },
    autostart: true,
    enableerrordialogs: false,
    getmode: () => false,
    setmode: () => log("player.settings.setMode: no shuffle or loop on a radio"),
  }, log);
  const network = {
    bufferingprogress: 100,
    // A live stream has nothing left to download.
    downloadprogress: 100,
    bitrate: 256000,
    maxbitrate: 256000,
    receptionquality: 100,
    sourceprotocol: "http",
  };
  const player = {
    controls,
    settings,
    currentmedia: media,
    currentplaylist: playlist,
    network: wmpObject("player.network", network, log),
    dvd: wmpObject("player.dvd", { isavailable: () => (log("player.dvd: no DVD on a radio"), false) }, log),
    mediacollection: wmpObject("player.mediaCollection", { getall: () => (log("player.mediaCollection: no library on a radio"), wmpObject("playlist", { count: 0, item: () => undefined }, log)) }, log),
    get playstate() { return playState(s().playState); },
    get openstate() { return host.openState; },
    get status() { return host.status(); },
    get url() { return s().url; },
    set url(_: unknown) { log("player.URL cannot be set: the app plays its own playlist"); },
    // Only http(s), only from a click, and only through Rust, which checks
    // again (lib.rs): a skin's timer or onLoad opens nothing.
    launchurl: (url: unknown) => {
      if (!host.userAction()) log("player.launchURL refused: not from a click");
      else if (/^https?:\/\//i.test(String(url))) host.send({ type: "launchUrl", url: String(url) });
      else log(`player.launchURL refused ${String(url)}`);
    },
  };
  const theme = {
    openview: (id: unknown) => log(`theme.openView("${String(id)}"): only the first view is drawn`),
    closeview: () => {},
    get currentviewid() { return host.viewId(); },
    set currentviewid(id: unknown) { log(`theme.currentViewID = "${String(id)}": only the first view is drawn`); },
    // An unsaved preference reads "--", as in WMP; booleans are saved as
    // the strings JScript gave them, "True" and "False".
    loadpreference: (name: unknown) => localStorage.getItem(host.prefix + String(name)) ?? "--",
    savepreference: (name: unknown, v: unknown) => localStorage.setItem(host.prefix + String(name), typeof v === "boolean" ? (v ? "True" : "False") : String(v)),
    loadstring: (ref: unknown) => resString(String(ref), log) ?? String(ref),
    opendialog: () => (log("theme.openDialog: there is nothing to open"), ""),
    playsound: () => {},
    logstring: () => {},
  };
  // The effect is saved for the next launch (ATA-166); the first launch shows
  // Album Art (ATA-200). One the list no longer has (ATA-166's "NTS show")
  // reads as Album Art too.
  const saved = () => EFFECTS[effectIndex(localStorage.getItem("effectType") ?? "", Number(localStorage.getItem("effectPreset")) || 0)];
  const mediacenter = {
    get effecttype() {
      return saved().type;
    },
    set effecttype(v: unknown) {
      localStorage.setItem("effectType", String(v));
    },
    get effectpreset() {
      return saved().preset;
    },
    set effectpreset(v: unknown) {
      localStorage.setItem("effectPreset", String(v));
    },
    videostretchtofit: true,
    videozoom: 100,
    contrastmode: "",
  };
  const eq: Record<string, any> = {
    bypass: false,
    enabled: true,
    // ponytail: no presets; the host's EQ has none. Add them if a skin's
    // preset list matters.
    presetcount: 0,
    presettitle: () => "",
    currentpreset: 0,
    currentpresettitle: "",
    nextpreset: () => {},
    previouspreset: () => {},
    reset: () => {
      for (let band = 0; band < 10; band++) eq[`gainlevel${band + 1}`] = 0;
    },
  };
  for (let band = 0; band < 10; band++)
    Object.defineProperty(eq, `gainlevel${band + 1}`, {
      get: () => s().eq[band] ?? 0,
      set: (v: unknown) => {
        const gain = clamp(v, -15, 15);
        host.set({ eq: Array.from({ length: 10 }, (_, i) => (i === band ? gain : (s().eq[i] ?? 0))) });
        host.send({ type: "eq", band, gain });
      },
      enumerable: true,
    });
  const vs = { brightness: 0, contrast: 0, hue: 0, saturation: 0, reset: () => {} };
  return { player, theme, mediacenter, eq, vs, network };
}

/** `currentMedia.getItemInfo(attr)`: the title, the show as its author, and
 * the show's location. */
export function itemInfo(state: State, attr: string): string {
  const a = attr.toLowerCase();
  if (a === "title" || a === "#title") return state.title;
  if (a === "author" || a === "artist" || a === "wm/albumartist") return state.author;
  if (a === "location") return state.location;
  return a === "type" ? "broadcast" : "";
}

// Our own wording, for the resources the ATA-103 skins load. RT_TEXT/#132 is
// WMP's shared script: none of those skins calls a function from it (the
// `next()` and `previous()` in their markup are the effects element's own).
const STRINGS: Record<number, string> = { 2063: "Disconnected" };

/** A `res://wmploc.dll/RT_STRING/#n` (or `res://wmploc/…`) string, `""` for
 * an id we have no stand-in for, or null if `ref` is not one. */
export function resString(ref: string, log: (msg: string) => void): string | null {
  const m = /^res:\/\/wmploc(?:\.dll)?\/RT_STRING\/#(\d+)$/i.exec(ref.trim());
  if (!m) return null;
  if (!(+m[1] in STRINGS)) log(`no stand-in for ${ref}`);
  return STRINGS[+m[1]] ?? "";
}

/** The RT_TEXT script a `scriptFile` names, or null if `ref` is not one. */
export function resScript(ref: string): string | null {
  return /^res:\/\/wmploc(?:\.dll)?\/RT_TEXT\/#\d+$/i.test(ref.trim()) ? "" : null;
}

// RT_IMAGE: 9SeriesDefault's status icon. 9×9 glyphs of our own, drawn in
// light grey on transparency: playing (a file, or a stream at 1776-1781,
// WMP's reception icons), paused, stopped.
const play = (x: number, y: number) => x >= 2 && Math.abs(y - 4) <= 6 - x; // a triangle pointing right
const GLYPHS: Record<number, (x: number, y: number) => boolean> = {
  1776: play, 1777: play, 1778: play, 1779: play, 1780: play, 1781: play, 1784: play,
  2023: (x, y) => y >= 1 && y <= 7 && (x === 2 || x === 3 || x === 5 || x === 6),
  2024: (x, y) => x >= 1 && x <= 7 && y >= 1 && y <= 7,
};

/** Pixels for a `res://wmploc…/RT_IMAGE/#n`, or null if we have none. */
export function resImage(ref: string): { width: number; height: number; data: Uint8ClampedArray<ArrayBuffer> } | null {
  const m = /^res:\/\/wmploc(?:\.dll)?\/RT_IMAGE\/#(\d+)$/i.exec(ref.trim());
  const glyph = m && GLYPHS[+m[1]];
  if (!glyph) return null;
  const data = new Uint8ClampedArray(9 * 9 * 4);
  for (let y = 0; y < 9; y++) for (let x = 0; x < 9; x++) if (glyph(x, y)) data.set([0xd0, 0xd0, 0xd0, 255], (y * 9 + x) * 4);
  return { width: 9, height: 9, data };
}
