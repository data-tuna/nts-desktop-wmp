// The visualisations an `<effects>` element draws: our own bars, scope and
// an Ambience-style glow, after the look of WMP's built-in ones. They draw
// the frames the trusted page sends while one is on screen (the `vis`
// message, docs/decisions.md ATA-114). The NTS show card is static: it
// draws the `show` message, and needs no frames (ATA-166). The trusted page
// reduces its analyser data with `bands` and `samples`; no DOM here, so
// `node --test` can run them.
import { clearRows } from "./pixels.ts";

/** One analyser frame: spectrum bars and waveform samples, 0..255. */
export type Frame = { bars: number[]; wave: number[] };

/** The show on air, from the `show` message, its picture decoded. */
export type Card = { title: string; genres: string[]; image: CanvasImageSource | null };

/** The effects in the order next() steps through them, by the names
 * `mediacenter.effectType` and `effectPreset` carry. */
export const EFFECTS = [
  { type: "Bars and Waves", preset: 0, title: "Bars" },
  { type: "Bars and Waves", preset: 1, title: "Scope" },
  { type: "Ambience", preset: 0, title: "Ambience" },
  { type: "NTS show", preset: 0, title: "NTS show" },
];
/** The card, the effect until the listener picks another. */
export const SHOW = EFFECTS.length - 1;

/** The effect for a type and preset: the type's first preset if the preset
 * is unknown, the first effect if the type is. */
export function effectIndex(type: string, preset: number): number {
  const t = type.trim().toLowerCase();
  const same = EFFECTS.flatMap((e, i) => (e.type.toLowerCase() === t ? [i] : []));
  return same.find((i) => EFFECTS[i].preset === preset) ?? same[0] ?? 0;
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

/** What an effects element keeps between frames, and the card it last drew. */
export type Memory = {
  peaks: number[];
  trail: HTMLCanvasElement | null;
  /** The `overlay` mask of the last full paint, `w` × `h`, at (`dx`, `dy`) in the element. */
  cover: { mask: Uint8ClampedArray; w: number; h: number; dx: number; dy: number } | null;
  card: { of: Card | null; canvas: HTMLCanvasElement } | null;
};

/** Draws effect `index` into (x, y, w, h). `frame` is null when nothing
 * plays: the screen stays dark, as WMP's does. `fg` is the skin's
 * foregroundColor, if it gave one. */
export function drawEffect(g: CanvasRenderingContext2D, index: number, frame: Frame | null, card: Card | null, box: [number, number, number, number], bg: string, fg: string | null, mem: Memory) {
  const [x, y, w, h] = box;
  if (w <= 0 || h <= 0) return;
  g.save();
  g.beginPath();
  g.rect(x, y, w, h);
  g.clip();
  const title = EFFECTS[index].title;
  if (title === "Ambience") ambience(g, frame, box, bg, mem);
  else if (index === SHOW) showCard(g, card, box, bg, fg, mem);
  else {
    g.fillStyle = bg;
    g.fillRect(x, y, w, h);
    if (title === "Bars") bars(g, frame, box, fg, mem);
    else if (frame) scope(g, frame, box, fg);
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
    // Peak caps fall back slowly.
    mem.peaks[i] = Math.max(bh, (mem.peaks[i] ?? 0) - h / 50);
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
  t.globalAlpha = frame ? 0.12 : 1;
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

/** The show's picture, cropped to fill the area, with its title and up to
 * four genres over it, on a dark band where the skin leaves the area widest
 * clear. With no picture, the title on a plain card; before the first `show`
 * message, just the background. Drawn once per card and size, then copied.
 * ponytail: a cover that changes later (a skin sliding a panel over the
 * area) does not move the text until the next card; recheck it per paint if
 * a skin needs that. */
function showCard(g: CanvasRenderingContext2D, card: Card | null, [x, y, w, h]: [number, number, number, number], bg: string, fg: string | null, mem: Memory) {
  if (mem.card?.of !== card || mem.card.canvas.width !== w || mem.card.canvas.height !== h) {
    const c = mem.card?.canvas ?? document.createElement("canvas");
    [c.width, c.height] = [w, h];
    mem.card = { of: card, canvas: c };
    const t = c.getContext("2d")!;
    t.fillStyle = bg;
    t.fillRect(0, 0, w, h);
    if (card) drawCard(t, card, w, h, fg ?? "#fff", mem.cover && clearSpans(mem.cover, h));
  }
  g.drawImage(mem.card.canvas, x, y);
}

function drawCard(t: CanvasRenderingContext2D, card: Card, w: number, h: number, fg: string, clear: [number, number][] | null) {
  const image = card.image as (CanvasImageSource & { width: number; height: number }) | null;
  if (image) {
    const s = Math.max(w / image.width, h / image.height);
    t.drawImage(image, (w - image.width * s) / 2, (h - image.height * s) / 2, image.width * s, image.height * s);
  }
  // 9 to 14 px type, by the area's smaller side.
  const px = Math.max(9, Math.min(14, Math.round(Math.min(w, h) / 9)));
  const pad = Math.max(3, Math.round(px / 2));
  const tagPx = px - 2;
  const lay = (width: number, withTags: boolean) => {
    t.font = `bold ${px}px sans-serif`;
    const lines = wrap(t, card.title, width, h >= 6 * px ? 2 : 1);
    const wide = Math.max(0, ...lines.map((line) => t.measureText(line).width));
    t.font = `${tagPx}px sans-serif`;
    const tags = withTags && h >= 4 * px ? flow(t, card.genres.slice(0, 4), width, 2) : [];
    const rows = tags.length ? tags[tags.length - 1].row + 1 : 0;
    return { lines, tags, wide: Math.max(wide, ...tags.map((tag) => tag.x + tag.w)), block: lines.length * Math.round(px * 1.2) + rows * (tagPx + 7) };
  };
  // The widest text that fits a span the skin leaves clear: the house
  // skin's area is round, and anemone's pods cover two corners. Without the
  // genres if they would leave the title too narrow.
  const rows = clear ?? Array.from({ length: h }, (): [number, number] => [0, w]);
  const fit = (withTags: boolean) => {
    for (let width = w - 2 * pad; width >= 4 * px; width -= 4) {
      const layout = lay(width, withTags);
      const spot = place(rows, layout.block + 2 * pad, w);
      if (layout.wide <= spot.x1 - spot.x0 - 2 * pad) return { width, layout, spot };
    }
    return null;
  };
  let best = fit(true);
  if (!best || best.width < 6 * px) best = fit(false) ?? best;
  const layout = best?.layout ?? lay(w - 2 * pad, false);
  const spot = best?.spot ?? place(rows, layout.block + 2 * pad, w);
  const { lines, tags, block } = layout;
  const cx = (spot.x0 + spot.x1) / 2;
  if (image) {
    t.fillStyle = "rgba(0,0,0,0.6)";
    t.fillRect(spot.x0, spot.top, spot.x1 - spot.x0, block + 2 * pad);
  }
  let top = spot.top + pad;
  const ink = image ? "#fff" : fg;
  t.fillStyle = ink;
  t.textBaseline = "top";
  t.textAlign = "center";
  t.font = `bold ${px}px sans-serif`;
  for (const line of lines) {
    t.fillText(line, cx, top);
    top += Math.round(px * 1.2);
  }
  t.font = `${tagPx}px sans-serif`;
  t.strokeStyle = ink;
  t.lineWidth = 1;
  for (const tag of tags) {
    const row = tags.filter((other) => other.row === tag.row);
    const left = Math.round(cx - (row[row.length - 1].x + row[row.length - 1].w) / 2) + tag.x;
    const ty = top + 2 + tag.row * (tagPx + 7);
    t.strokeRect(left + 0.5, ty + 0.5, tag.w - 1, tagPx + 4);
    t.fillText(tag.text, left + tag.w / 2, ty + 3);
  }
}

/** Each of the element's `h` rows' widest uncovered run, [start, end), in its own coordinates. */
function clearSpans({ mask, w, h, dx, dy }: NonNullable<Memory["cover"]>, rows: number): [number, number][] {
  const shown = clearRows(mask, w, h);
  return Array.from({ length: rows }, (_, r) => {
    const [a, b] = shown[r - dy] ?? [0, 0];
    return [a + dx, b + dx];
  });
}

/** Where a block `rows` tall shows widest, given each row's clear span
 * [start, end): its top and the span all its rows leave clear. Of equal
 * spans, the one nearest the middle. With none (the area is too short, or
 * all covered), the middle, across the whole `width`. */
export function place(clear: [number, number][], rows: number, width: number): { top: number; x0: number; x1: number } {
  const middle = (clear.length - rows) / 2;
  let best = { top: Math.max(0, Math.round(middle)), x0: 0, x1: 0 };
  for (let top = 0; top + rows <= clear.length; top++) {
    let [x0, x1] = clear[top];
    for (let r = top + 1; r < top + rows && x1 > x0; r++) [x0, x1] = [Math.max(x0, clear[r][0]), Math.min(x1, clear[r][1])];
    const [span, bestSpan] = [Math.max(0, x1 - x0), best.x1 - best.x0];
    if (span > bestSpan || (span === bestSpan && span > 0 && Math.abs(top - middle) < Math.abs(best.top - middle))) best = { top, x0, x1 };
  }
  return best.x1 > best.x0 ? best : { ...best, x1: width };
}

/** `text` in at most `max` lines of `width` px, the last cut with an ellipsis. */
export function wrap(t: { measureText(s: string): { width: number } }, text: string, width: number, max: number): string[] {
  const fits = (s: string) => t.measureText(s).width <= width;
  const lines: string[] = [];
  let rest = text.split(/\s+/).filter(Boolean);
  while (rest.length && lines.length < max) {
    let n = 1;
    while (n < rest.length && fits(rest.slice(0, n + 1).join(" "))) n++;
    let line = rest.slice(0, lines.length === max - 1 ? rest.length : n).join(" ");
    rest = lines.length === max - 1 ? [] : rest.slice(n);
    if (!fits(line)) {
      while (line.length > 1 && !fits(`${line}…`)) line = line.slice(0, -1);
      line = `${line.trimEnd()}…`;
    }
    lines.push(line);
  }
  return lines;
}

/** Genre pills left to right in at most `rows` rows of `width` px; a pill
 * that does not fit is left out. */
export function flow(t: { measureText(s: string): { width: number } }, genres: string[], width: number, rows: number) {
  const out: { text: string; x: number; w: number; row: number }[] = [];
  let [x, row] = [0, 0];
  for (const text of genres) {
    const w = Math.ceil(t.measureText(text).width) + 6;
    const wraps = x > 0 && x + w > width;
    if (w > width || (wraps && row + 1 >= rows)) continue;
    if (wraps) [x, row] = [0, row + 1];
    out.push({ text, x, w, row });
    x += w + 4;
  }
  return out;
}
