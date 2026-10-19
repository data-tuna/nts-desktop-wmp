// Pixel helpers the engine shares with its tests: colours, and which button
// of a button group sits under the pointer. No DOM here, so `node --test`
// can run it.

export type Pixels = { width: number; height: number; data: Uint8ClampedArray };

// The colour names skins use, as WMP knows them (the HTML set).
const NAMES = new Map(Object.entries({
  black: 0x000000, white: 0xffffff, red: 0xff0000, lime: 0x00ff00, green: 0x008000,
  blue: 0x0000ff, yellow: 0xffff00, magenta: 0xff00ff, fuchsia: 0xff00ff,
  cyan: 0x00ffff, aqua: 0x00ffff, gray: 0x808080, grey: 0x808080, silver: 0xc0c0c0,
  navy: 0x000080, maroon: 0x800000, purple: 0x800080, teal: 0x008080, olive: 0x808000,
}));

/** `#RRGGBB` (or `RRGGBB`, or a colour name) as 0xRRGGBB; null for "none",
 * missing or unreadable values. */
export function parseColor(s: string | undefined): number | null {
  if (!s) return null;
  const t = s.trim().toLowerCase();
  const named = NAMES.get(t);
  if (named !== undefined) return named;
  const hex = /^#?([0-9a-f]{6})$/.exec(t);
  return hex ? parseInt(hex[1], 16) : null;
}

export const css = (rgb: number) => `#${rgb.toString(16).padStart(6, "0")}`;

/** The pixel at (x, y) as 0xRRGGBB, or -1 outside the image. */
export function rgbAt(p: Pixels, x: number, y: number): number {
  x = Math.floor(x);
  y = Math.floor(y);
  if (x < 0 || y < 0 || x >= p.width || y >= p.height) return -1;
  const i = (y * p.width + x) * 4;
  return (p.data[i] << 16) | (p.data[i + 1] << 8) | p.data[i + 2];
}

/** The button group element under (x, y): the index of the first colour
 * that matches the mapping image there, or -1. */
export function mappedElement(map: Pixels, x: number, y: number, colors: (number | null)[]): number {
  const rgb = rgbAt(map, x, y);
  return rgb < 0 ? -1 : colors.indexOf(rgb);
}

/** A copy of `p` with every pixel whose colour is in `colors` made clear
 * (`keep` false) or with only those pixels kept (`keep` true). */
export function keyed(p: Pixels, colors: number[], keep = false): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(p.data);
  for (let i = 0; i < out.length; i += 4) {
    const hit = colors.includes((out[i] << 16) | (out[i + 1] << 8) | out[i + 2]);
    if (hit !== keep) out[i + 3] = 0;
  }
  return out;
}

/** Opaque pixels as one `[x, y, width, 1]` rectangle per horizontal run. */
export function runs(p: Pixels): [number, number, number, number][] {
  const rects: [number, number, number, number][] = [];
  for (let y = 0; y < p.height; y++) {
    let start = -1;
    for (let x = 0; x <= p.width; x++) {
      const solid = x < p.width && p.data[(y * p.width + x) * 4 + 3] >= 128;
      if (solid && start < 0) start = x;
      if (!solid && start >= 0) {
        rects.push([start, y, x - start, 1]);
        start = -1;
      }
    }
  }
  return rects;
}

/** What lies over a visualisation, from the view painted twice with the
 * visualisation as a solid white box and as a solid black one. `mask`'s
 * alpha is how much of the visualisation shows at each pixel; `cover` is
 * everything else there, to be added on top ("lighter"), which is exact
 * because a visualisation is opaque. Both are straight (not premultiplied)
 * RGBA, as ImageData holds. */
export function overlay(white: Uint8ClampedArray, black: Uint8ClampedArray) {
  const mask = new Uint8ClampedArray(white.length);
  const cover = new Uint8ClampedArray(white.length);
  for (let i = 0; i < white.length; i += 4) {
    const a = black[i + 3];
    // The visualisation's share: white minus black, premultiplied, in 0..255.
    const shown = (((white[i] + white[i + 1] + white[i + 2]) * white[i + 3]) / 3 - ((black[i] + black[i + 1] + black[i + 2]) * a) / 3) / 255;
    mask[i + 3] = shown;
    const rest = a - shown;
    if (rest <= 0) continue;
    for (let c = 0; c < 3; c++) cover[i + c] = (black[i + c] * a) / rest;
    cover[i + 3] = rest;
  }
  return { mask, cover };
}

/** The playlist's playing row, text and background: the skin's colours, or
 * WMP's defaults, green on near-black (ATA-191). */
export function playingColors(color: number | null, background: number | null): [number, number] {
  return [color ?? 0x00ff00, background ?? 0x222222];
}

/** `a` moved `t` of the way to `b`, channel by channel. */
export function mix(a: number, b: number, t: number): number {
  let out = 0;
  for (const s of [16, 8, 0]) out |= Math.round(((a >> s) & 255) * (1 - t) + ((b >> s) & 255) * t) << s;
  return out;
}

/** A scroll bar's thumb along a `track` px track, for `count` rows with
 * `shown` in sight from row `first`: its offset and length, or null when
 * every row fits. Never shorter than `min` px. */
export function thumb(count: number, shown: number, first: number, track: number, min = 8): { at: number; size: number } | null {
  if (count <= shown) return null;
  const size = Math.min(track, Math.max(min, Math.round((track * shown) / count)));
  return { at: Math.round(((track - size) * first) / (count - shown)), size };
}

/** The first row in sight with the thumb dragged to `at`: thumb's inverse. */
export function firstAt(at: number, count: number, shown: number, track: number, size: number): number {
  const first = track > size ? Math.round((at * (count - shown)) / (track - size)) : 0;
  return Math.max(0, Math.min(count - shown, first));
}

/** A tiled slider image of `size` px laid along a `length` px slider, as
 * [from in the image, to on the slider, px] copies. The first and last
 * `border` px are end caps drawn once; only the middle repeats. An image too
 * short to hold both caps repeats whole. */
export function tiles(length: number, size: number, border: number): [number, number, number][] {
  const b = size > 2 * border ? border : 0;
  const out: [number, number, number][] = b ? [[0, 0, b], [size - b, length - b, b]] : [];
  for (let at = b; at < length - b; at += size - 2 * b) out.push([b, at, Math.min(size - 2 * b, length - b - at)]);
  return out;
}
