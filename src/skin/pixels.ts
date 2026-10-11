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
export function runs(p: Pixels, threshold = 128): [number, number, number, number][] {
  const rects: [number, number, number, number][] = [];
  for (let y = 0; y < p.height; y++) {
    let start = -1;
    for (let x = 0; x <= p.width; x++) {
      const solid = x < p.width && p.data[(y * p.width + x) * 4 + 3] >= threshold;
      if (solid && start < 0) start = x;
      if (!solid && start >= 0) {
        rects.push([start, y, x - start, 1]);
        start = -1;
      }
    }
  }
  return rects;
}
