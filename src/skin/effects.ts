// The visualisations an `<effects>` element draws: our own bars, scope and
// an Ambience-style glow, after the look of WMP's built-in ones. They draw
// the frames the trusted page sends while one is on screen (the `vis`
// message, docs/decisions.md ATA-114). Milkdrop is Butterchurn's
// (milkdrop.ts, ATA-167). Album Art is static: it draws the picture the
// `art` message brings, and needs no frames (ATA-200). The trusted page reduces its analyser data with
// `bands` and `samples`; no DOM here, so `node --test` can run them.
import { milkdrop, PRESETS, type Milk } from "./milkdrop.ts";

/** One analyser frame: spectrum bars and waveform samples, 0..255, and the
 * newest 1024 samples for Milkdrop (none in a pick's flat frame). */
export type Frame = { bars: number[]; wave: number[]; pcm?: number[] };

/** The effect that shows the show's picture and wants no frames. */
export const ALBUM_ART = 0;

/** The effects in the order next() steps through them, by the names
 * `mediacenter.effectType` and `effectPreset` carry. */
export const EFFECTS = [
  // First: the default, and first in the menu (ATA-200).
  { type: "Album Art", preset: 0, title: "Album Art" },
  { type: "Bars and Waves", preset: 0, title: "Bars" },
  { type: "Bars and Waves", preset: 1, title: "Scope" },
  { type: "Ambience", preset: 0, title: "Ambience" },
  // WMP's next() walks an effect's presets before the next effect.
  ...PRESETS.map((_, preset) => ({ type: "Milkdrop", preset, title: "Milkdrop" })),
];

/** The effect for a type and preset: the type's first preset if the preset
 * is unknown, the first effect if the type is. */
export function effectIndex(type: string, preset: number): number {
  const t = type.trim().toLowerCase();
  const same = EFFECTS.flatMap((e, i) => (e.type.toLowerCase() === t ? [i] : []));
  return same.find((i) => EFFECTS[i].preset === preset) ?? same[0] ?? 0;
}

/** The visualisation menu (ATA-190): the effects, then Milkdrop's presets
 * for a submenu, each with its EFFECTS index, the current one checked.
 * Windows reads a lone & as a mnemonic, so the text doubles it. */
export function effectsMenu(current: number) {
  const all = EFFECTS.map((e, index) => ({ index, text: (e.type === "Milkdrop" ? PRESETS[e.preset] : e.title).replace(/&/g, "&&"), checked: index === current }));
  const milk = (i: number) => EFFECTS[i].type === "Milkdrop";
  return { effects: all.filter((e) => !milk(e.index)), milkdrop: all.filter((e) => milk(e.index)) };
}

/** `count` bars from an analyser's byte spectrum, log-spaced from 40 Hz to
 * 16 kHz, each the loudest bin it covers. */
export function bands(spectrum: Uint8Array, sampleRate: number, count: number): number[] {
  const hz = sampleRate / 2 / spectrum.length;
  const edge = (i: number) => Math.floor((40 * 400 ** (i / count)) / hz);
  return Array.from({ length: count }, (_, i) => {
    let max = 0;
    for (let k = edge(i); k < Math.max(edge(i) + 1, edge(i + 1)) && k < spectrum.length; k++) max = Math.max(max, spectrum[k]);
    return max;
  });
}

/** `count` evenly spaced samples of a waveform. */
export function samples(wave: Uint8Array, count: number): number[] {
  return Array.from({ length: count }, (_, i) => wave[Math.floor((i * wave.length) / count)]);
}

/** What an effects element keeps between frames. */
export type Memory = { peaks: number[]; trail: HTMLCanvasElement | null; milk: Milk | null };

/** Draws effect `index` into (x, y, w, h). `frame` is null when nothing
 * plays: the screen stays dark, as WMP's does. `fg` is the skin's
 * foregroundColor, if it gave one; `art` the show's picture, if any. */
export function drawEffect(g: CanvasRenderingContext2D, index: number, frame: Frame | null, art: HTMLImageElement | null, box: [number, number, number, number], bg: string, fg: string | null, mem: Memory) {
  const [x, y, w, h] = box;
  if (w <= 0 || h <= 0) return;
  g.save();
  g.beginPath();
  g.rect(x, y, w, h);
  g.clip();
  const title = EFFECTS[index].title;
  if (title === "Ambience") ambience(g, frame, box, bg, mem);
  else if (title === "Milkdrop") milkdrop(g, frame, EFFECTS[index].preset, box, bg, mem);
  else {
    g.fillStyle = bg;
    g.fillRect(x, y, w, h);
    // The picture covers the area, centred, as WMP's Album Art did.
    if (index === ALBUM_ART && art) {
      const s = Math.max(w / art.width, h / art.height);
      g.drawImage(art, x + (w - art.width * s) / 2, y + (h - art.height * s) / 2, art.width * s, art.height * s);
    } else if (title === "Bars") bars(g, frame, box, fg, mem);
    else if (title === "Scope" && frame) scope(g, frame, box, fg);
  }
  g.restore();
}

function bars(g: CanvasRenderingContext2D, frame: Frame | null, [x, y, w, h]: [number, number, number, number], fg: string | null, mem: Memory) {
  if (!frame) {
    mem.peaks = [];
    return;
  }
  const values = frame.bars;
  const n = values.length;
  const step = w / n;
  const gap = step >= 3 ? 1 : 0;
  // Green to yellow to red, bottom to top, unless the skin names a colour.
  const ramp = g.createLinearGradient(0, y + h, 0, y);
  ramp.addColorStop(0, fg ?? "#00c000");
  ramp.addColorStop(0.6, fg ?? "#e0e000");
  ramp.addColorStop(1, fg ?? "#ff2000");
  g.fillStyle = ramp;
  values.forEach((v, i) => {
    const bh = Math.round((v / 255) * h);
    const bx = Math.round(x + i * step);
    const bw = Math.max(1, Math.round(x + (i + 1) * step) - bx - gap);
    g.fillRect(bx, y + h - bh, bw, bh);
    // Peak caps fall back slowly: the full height in 1.7 s at 20 frames a second.
    mem.peaks[i] = Math.max(bh, (mem.peaks[i] ?? 0) - h / 33);
    if (mem.peaks[i] >= 1) g.fillRect(bx, Math.round(y + h - mem.peaks[i]) - 1, bw, 1);
  });
}

function scope(g: CanvasRenderingContext2D, frame: Frame, [x, y, w, h]: [number, number, number, number], fg: string | null) {
  const n = frame.wave.length;
  if (n < 2) return;
  g.strokeStyle = fg ?? "#40ff60";
  g.lineWidth = 1;
  g.beginPath();
  frame.wave.forEach((v, i) => {
    const px = x + (i / (n - 1)) * w;
    const py = y + h / 2 + ((v - 128) / 128) * (h / 2);
    if (i) g.lineTo(px, py);
    else g.moveTo(px, py);
  });
  g.stroke();
}

/** Soft coloured lights that drift and swell with the music, leaving trails. */
function ambience(g: CanvasRenderingContext2D, frame: Frame | null, [x, y, w, h]: [number, number, number, number], bg: string, mem: Memory) {
  if (!mem.trail) mem.trail = document.createElement("canvas");
  const c = mem.trail;
  if (c.width !== w || c.height !== h) {
    c.width = w;
    c.height = h;
  }
  const t = c.getContext("2d")!;
  t.globalCompositeOperation = "source-over";
  // At 20 frames a second, the same fade per second as 0.12 was at 30.
  t.globalAlpha = frame ? 0.175 : 1;
  t.fillStyle = bg;
  t.fillRect(0, 0, w, h);
  t.globalAlpha = 1;
  if (frame) {
    const now = performance.now() / 1000;
    const lights = 5;
    const per = Math.max(1, Math.floor(frame.bars.length / lights));
    t.globalCompositeOperation = "lighter";
    for (let k = 0; k < lights; k++) {
      const level = Math.max(...frame.bars.slice(k * per, (k + 1) * per), 0) / 255;
      const cx = w / 2 + Math.sin(now * (0.3 + k * 0.11) + k * 2) * w * 0.35;
      const cy = h / 2 + Math.cos(now * (0.23 + k * 0.07) + k) * h * 0.35;
      const r = Math.max(2, level * Math.min(w, h) * 0.35);
      const hue = (now * 20 + k * 72) % 360;
      const glow = t.createRadialGradient(cx, cy, 0, cx, cy, r);
      glow.addColorStop(0, `hsla(${hue}, 90%, 55%, ${0.1 + level * 0.3})`);
      glow.addColorStop(1, `hsla(${hue}, 90%, 50%, 0)`);
      t.fillStyle = glow;
      t.fillRect(cx - r, cy - r, 2 * r, 2 * r);
    }
  }
  g.drawImage(c, x, y);
}
