// Pixel helpers the engine shares with its tests: colours, and which button
// of a button group sits under the pointer. No DOM here, so `node --test`
// can run it.

export type Pixels = { width: number; height: number; data: Uint8ClampedArray };

// The 140 colour names WMP knows: Internet Explorer's list, so "lightgrey"
// but no "grey" or "lightgray" (checked against wmp.dll's table).
const NAMED = `
  aliceblue f0f8ff antiquewhite faebd7 aqua 00ffff aquamarine 7fffd4 azure f0ffff
  beige f5f5dc bisque ffe4c4 black 000000 blanchedalmond ffebcd blue 0000ff
  blueviolet 8a2be2 brown a52a2a burlywood deb887 cadetblue 5f9ea0 chartreuse 7fff00
  chocolate d2691e coral ff7f50 cornflowerblue 6495ed cornsilk fff8dc
  crimson dc143c cyan 00ffff darkblue 00008b darkcyan 008b8b darkgoldenrod b8860b
  darkgray a9a9a9 darkgreen 006400 darkkhaki bdb76b darkmagenta 8b008b
  darkolivegreen 556b2f darkorange ff8c00 darkorchid 9932cc darkred 8b0000
  darksalmon e9967a darkseagreen 8fbc8f darkslateblue 483d8b darkslategray 2f4f4f
  darkturquoise 00ced1 darkviolet 9400d3 deeppink ff1493 deepskyblue 00bfff
  dimgray 696969 dodgerblue 1e90ff firebrick b22222 floralwhite fffaf0
  forestgreen 228b22 fuchsia ff00ff gainsboro dcdcdc ghostwhite f8f8ff
  gold ffd700 goldenrod daa520 gray 808080 green 008000 greenyellow adff2f
  honeydew f0fff0 hotpink ff69b4 indianred cd5c5c indigo 4b0082 ivory fffff0
  khaki f0e68c lavender e6e6fa lavenderblush fff0f5 lawngreen 7cfc00 lemonchiffon fffacd
  lightblue add8e6 lightcoral f08080 lightcyan e0ffff lightgoldenrodyellow fafad2
  lightgreen 90ee90 lightgrey d3d3d3 lightpink ffb6c1 lightsalmon ffa07a
  lightseagreen 20b2aa lightskyblue 87cefa lightslategray 778899 lightsteelblue b0c4de
  lightyellow ffffe0 lime 00ff00 limegreen 32cd32 linen faf0e6 magenta ff00ff
  maroon 800000 mediumaquamarine 66cdaa mediumblue 0000cd mediumorchid ba55d3
  mediumpurple 9370db mediumseagreen 3cb371 mediumslateblue 7b68ee mediumspringgreen 00fa9a
  mediumturquoise 48d1cc mediumvioletred c71585 midnightblue 191970 mintcream f5fffa
  mistyrose ffe4e1 moccasin ffe4b5 navajowhite ffdead navy 000080 oldlace fdf5e6
  olive 808000 olivedrab 6b8e23 orange ffa500 orangered ff4500 orchid da70d6
  palegoldenrod eee8aa palegreen 98fb98 paleturquoise afeeee palevioletred db7093
  papayawhip ffefd5 peachpuff ffdab9 peru cd853f pink ffc0cb plum dda0dd
  powderblue b0e0e6 purple 800080 red ff0000 rosybrown bc8f8f royalblue 4169e1
  saddlebrown 8b4513 salmon fa8072 sandybrown f4a460 seagreen 2e8b57 seashell fff5ee
  sienna a0522d silver c0c0c0 skyblue 87ceeb slateblue 6a5acd slategray 708090
  snow fffafa springgreen 00ff7f steelblue 4682b4 tan d2b48c teal 008080
  thistle d8bfd8 tomato ff6347 turquoise 40e0d0 violet ee82ee wheat f5deb3
  white ffffff whitesmoke f5f5f5 yellow ffff00 yellowgreen 9acd32`;

// The 28 system colours WMP takes from GetSysColor, as Windows 10 and 11
// set them by default. Fixed, so a key colour matches on every machine.
const SYSTEM = `
  activeborder b4b4b4 activecaption 99b4d1 appworkspace ababab background 000000
  buttonface f0f0f0 buttonhighlight ffffff buttonshadow a0a0a0 buttontext 000000
  captiontext 000000 graytext 6d6d6d highlight 0078d7 highlighttext ffffff
  inactiveborder f4f7fc inactivecaption bfcddb inactivecaptiontext 000000
  infobackground ffffe1 infotext 000000 menu f0f0f0 menutext 000000
  scrollbar c8c8c8 threeddarkshadow 696969 threedface f0f0f0
  threedhighlight ffffff threedlightshadow e3e3e3 threedshadow a0a0a0
  window ffffff windowframe 646464 windowtext 000000`;

const NAMES = new Map<string, number>();
for (const table of [NAMED, SYSTEM]) {
  const words = table.trim().split(/\s+/);
  for (let i = 0; i < words.length; i += 2) NAMES.set(words[i], parseInt(words[i + 1], 16));
}

/** `#RRGGBB`, a colour name or a system colour as 0xRRGGBB; null for "none",
 * missing or unreadable values. WMP rejects a bare `RRGGBB`, and so do we.
 * `auto` is the top-left pixel of `image`, the image the colour applies to. */
export function parseColor(s: string | undefined, image?: Pixels): number | null {
  if (!s) return null;
  const t = s.trim().toLowerCase();
  if (t === "auto") {
    const rgb = image ? rgbAt(image, 0, 0) : -1;
    return rgb < 0 ? null : rgb;
  }
  const named = NAMES.get(t);
  if (named !== undefined) return named;
  const hex = /^#([0-9a-f]{6})$/.exec(t);
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

/** A slider `length` px long, inset `border` px at each end, at `t` (0..1)
 * along its track: the value's edge, and where a `size` px thumb starts. As
 * in WMP 7.1, the thumb is not taken off the track and its centre sits on
 * the edge, so at either end it overhangs by half its size. */
export function sliderAt(length: number, border: number, size: number, t: number): { edge: number; thumb: number } {
  const edge = border + Math.round(t * Math.max(0, length - 2 * border));
  return { edge, thumb: edge - Math.floor(size / 2) };
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

/** The average colour of the opaque pixels in RGBA `data`, or null if none. */
export function average(data: Uint8ClampedArray): number | null {
  const sum = [0, 0, 0];
  let n = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (!data[i + 3]) continue;
    for (let c = 0; c < 3; c++) sum[c] += data[i + c];
    n++;
  }
  return n ? sum.reduce((rgb, v) => (rgb << 8) | Math.round(v / n), 0) : null;
}

/** Black or white, whichever reads better on `rgb` (WCAG contrast); white on nothing. */
export function textOn(rgb: number | null): number {
  if (rgb === null) return 0xffffff;
  const lin = (v: number) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  const l = 0.2126 * lin(rgb >> 16) + 0.7152 * lin((rgb >> 8) & 255) + 0.0722 * lin(rgb & 255);
  // Contrast with black, (l + 0.05) / 0.05, beats contrast with white, 1.05 / (l + 0.05).
  return l > 0.179 ? 0x000000 : 0xffffff;
}
