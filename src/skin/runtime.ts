// The WMP object model a skin's scripts and attributes see: `player`,
// `theme`, `mediacenter`, the members of the `equalizerSettings`,
// `videoSettings`, `network` and playlist elements, the ps* and os*
// constants, and our own stand-ins for the wmploc.dll resources skins name.
// Written from Microsoft's reference (learn.microsoft.com/windows/win32/wmp)
// and from what the ATA-103 skins call. Members a radio player cannot
// honour (DVD, the library, video) return safe defaults; anything else a
// skin reaches for is logged once and reads as undefined.
import type { State } from "./engine.ts";

const PLAY_STATES = ["Undefined", "Stopped", "Paused", "Playing", "ScanForward", "ScanReverse", "Buffering", "Waiting", "MediaEnded", "Transitioning", "Ready", "Reconnecting"];
const OPEN_STATES = ["Undefined", "PlaylistChanging", "PlaylistLocating", "PlaylistConnecting", "PlaylistLoading", "PlaylistOpening", "PlaylistOpenNoMedia", "PlaylistChanged", "MediaChanging", "MediaLocating", "MediaConnecting", "MediaLoading", "MediaOpening", "MediaOpen", "BeginCodecAcquisition", "EndCodecAcquisition", "BeginLicenseAcquisition", "EndLicenseAcquisition", "BeginIndividualization", "EndIndividualization", "MediaWaiting", "OpeningUnknownURL"];

/** psUndefined = 0 … psReconnecting = 11, osUndefined = 0 … osOpeningUnknownURL = 21. */
export const CONSTANTS: Record<string, number> = Object.fromEntries([
  ...PLAY_STATES.map((name, i) => [`ps${name}`, i]),
  ...OPEN_STATES.map((name, i) => [`os${name}`, i]),
]);
export const OS_MEDIA_CHANGING = 8;
export const OS_MEDIA_OPEN = 13;

/** WMP's play state for the host's. */
export function playState(p: State["playState"]): number {
  return { stopped: 1, paused: 2, playing: 3, buffering: 6, reconnecting: 11 }[p];
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

const URLS = ["https://streams.radiomast.io/nts1", "https://streams.radiomast.io/nts2"];
const clamp = (v: unknown, lo: number, hi: number) => Math.min(hi, Math.max(lo, Number(v) || 0));

/** COM objects are case-insensitive (`player.PlayState`, `player.playstate`),
 * so members are kept lower-case and looked up that way. */
export function wmpObject(name: string, members: object, log: (msg: string) => void): Record<string, any> {
  Object.setPrototypeOf(members, null);
  return new Proxy(members as Record<string, any>, {
    has: (t, k) => typeof k === "string" && k.toLowerCase() in t,
    get(t, k) {
      if (typeof k !== "string") return undefined;
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
    getiteminfo: (attr: unknown) => (/^#?title$/i.test(String(attr)) ? s().title : /^type$/i.test(String(attr)) ? "broadcast" : ""),
    duration: 0,
    durationstring: "",
    imagesourcewidth: 0,
    imagesourceheight: 0,
    get sourceurl() { return URLS[s().channel] ?? ""; },
    isidentical: (other: unknown) => other === media,
  }, log);
  // The playlist is the two channels, NTS 1 and NTS 2.
  const playlist = wmpObject("player.currentPlaylist", {
    name: "",
    count: URLS.length,
    item: (i: number) => (i === s().channel ? media : wmpObject("player.currentPlaylist.item", { name: "", getiteminfo: () => "", isidentical: () => false }, log)),
    getiteminfo: () => "",
  }, log);
  const controls = wmpObject("player.controls", {
    play: () => host.send({ type: "play" }),
    pause: () => host.send({ type: "pause" }),
    stop: () => host.send({ type: "stop" }),
    next: () => host.send({ type: "next" }),
    previous: () => host.send({ type: "previous" }),
    // A live stream has no length, so it cannot seek or scan.
    fastforward: () => log("player.controls.fastForward: a live stream cannot scan"),
    fastreverse: () => log("player.controls.fastReverse: a live stream cannot scan"),
    get currentposition() { return s().time; },
    set currentposition(_: unknown) {},
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
    get url() { return URLS[s().channel] ?? ""; },
    set url(_: unknown) { log("player.URL cannot be set: the app plays NTS 1 and NTS 2"); },
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
  const mediacenter = {
    effecttype: "",
    effectpreset: 0,
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
