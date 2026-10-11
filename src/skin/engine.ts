// The skin engine, static half: draws a skin's first view as it looks before
// any of its scripts run, and drives play, stop and volume through the named
// controls. Scripts, `wmpprop:` bindings beyond the player's own state, and
// the WMP object model come with the script runtime (ATA-110).
//
// Everything is painted back to front on one canvas the size of the view, so
// the window shape is the opaque pixels of the skin's images, and a subview's
// clippingColor is a compositing step. Element semantics follow Microsoft's
// skin reference (learn.microsoft.com/windows/win32/wmp/skin-programming-reference).
import { constants, type Node } from "./wms.ts";
import { css, keyed, mappedElement, parseColor, rgbAt, runs, type Pixels } from "./pixels.ts";

export type Img = Pixels & { bitmap: CanvasImageSource };
export type State = { playing: boolean; time: number; title: string };
export type Send = (msg: { type: string; [k: string]: unknown }) => void;

type Kind = "container" | "button" | "group" | "element" | "slider" | "custom" | "progress" | "text" | "effects" | "none";

// Drawn later or never: video and playlists need media, popups need scripts.
const NOT_YET = new Set(["video", "wmpvideo", "playlist", "itemsplaylist", "dropdownplaylist", "popup"]);
// Elements with nothing to draw.
const SILENT = new Set(["player", "network", "mediacenter", "equalizersettings", "videosettings", "theme"]);

function kindOf(tag: string): Kind {
  if (tag === "view" || tag === "subview") return "container";
  if (tag === "buttongroup") return "group";
  if (tag === "customslider") return "custom";
  if (tag === "progressbar") return "progress";
  if (tag === "effects" || tag === "wmpeffects") return "effects";
  if (tag.endsWith("button")) return "button"; // button, imagebutton, playbutton, …
  if (tag.endsWith("element")) return "element"; // buttonelement, playelement, …
  if (tag.endsWith("slider")) return "slider"; // slider, seekslider, volumeslider, …
  if (tag.endsWith("text")) return "text"; // text, statustext, currentpositiontext, …
  return "none";
}

const fmt = (t: number) => `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(Math.floor(t % 60)).padStart(2, "0")}`;

class El {
  readonly kind: Kind;
  readonly kids: El[] = [];
  /** For the named variants: "play" for playbutton or playelement, and so on. */
  readonly role: string;
  /** Negative values draw behind the parent's background, showing through
   * its transparencyColor. */
  readonly z: number;
  hover = false;
  down = false;
  /** A slider's value while the user drags it. */
  dragValue: number | null = null;
  private memo = new Map<string, number>();
  // Reused offscreen canvases, one per purpose.
  private canvases = new Map<string, HTMLCanvasElement>();

  constructor(
    readonly node: Node,
    readonly parent: El | null,
    readonly skin: Skin,
  ) {
    this.kind = kindOf(node.tag);
    this.z = skin.num(this, "zindex") ?? 0;
    // A plain slider bound to the volume is a volume slider, and so on.
    const bound = /^wmpprop:player\.(?:settings\.(volume|balance)|controls\.(currentposition))$/i.exec(node.attrs.value ?? "");
    this.role = bound ? (bound[1] ?? "seek").toLowerCase() : node.tag.replace(/(button|element|slider|text)$/, "");
    if (NOT_YET.has(node.tag)) skin.log(`<${node.tag}> is not drawn yet`);
    if (this.kind === "none" || this.kind === "element" && parent?.kind !== "group") return;
    const adopt = (child: Node) => {
      // An unknown wrapper is skipped, but what it wraps is still drawn.
      if (kindOf(child.tag) === "none" && !SILENT.has(child.tag) && !NOT_YET.has(child.tag)) {
        skin.log(`unknown element <${child.tag}>, skipped`);
        child.children.forEach(adopt);
      } else this.kids.push(new El(child, this, skin));
    };
    node.children.forEach(adopt);
    this.kids.sort((a, b) => a.z - b.z); // stable: equal zIndex keeps document order
  }

  attr(name: string): string | undefined {
    return this.node.attrs[name];
  }

  img(name: string): Img | undefined {
    return this.skin.image(this.attr(name));
  }

  canvas(purpose: string, w: number, h: number): CanvasRenderingContext2D {
    let c = this.canvases.get(purpose);
    if (!c) this.canvases.set(purpose, (c = document.createElement("canvas")));
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
    }
    const g = c.getContext("2d")!;
    g.clearRect(0, 0, w, h);
    return g;
  }

  // Geometry, worked out on first use: `jscript:` expressions in one
  // element's attributes may read another's.
  geo(name: "left" | "top" | "width" | "height"): number {
    let v = this.memo.get(name);
    if (v === undefined) {
      this.memo.set(name, 0); // an expression that loops back to itself reads 0
      v = Math.round(this.skin.num(this, name) ?? this.natural(name));
      this.memo.set(name, v);
    }
    return v;
  }
  get x() { return this.geo("left"); }
  get y() { return this.geo("top"); }
  get w() { return this.geo("width"); }
  get h() { return this.geo("height"); }

  /** The size an element takes when its attributes do not give one. */
  private natural(name: string): number {
    if (name === "left" || name === "top") return 0;
    const pick = (img: Img | undefined) => img && (name === "width" ? img.width : img.height);
    let size: number | undefined;
    if (this.kind === "container" || this.kind === "slider" || this.kind === "progress")
      size = pick(this.img("backgroundimage")) ?? (this.kind === "slider" ? pick(this.img("thumbimage")) : undefined);
    else if (this.kind === "button") size = pick(this.img("image"));
    else if (this.kind === "group") size = pick(this.img("mappingimage")) ?? pick(this.img("image"));
    else if (this.kind === "custom") size = pick(this.img("positionimage"));
    else if (this.kind === "text") {
      const g = this.skin.measure;
      g.font = this.font();
      size = name === "width" ? Math.ceil(g.measureText(this.text()).width) + 2 : Math.ceil(this.fontPx() * 1.25);
    }
    // Anything else, and a subview with no image, fills its parent.
    return size ?? (this.parent ? this.parent.geo(name as "width" | "height") : 0);
  }

  get visible(): boolean {
    return this.skin.bool(this, "visible", true);
  }

  get enabled(): boolean {
    // The named transport controls follow the player, whatever the skin says.
    const auto = this.skin.controlEnabled(this.role);
    if (auto !== null && this.interactive()) return auto;
    return this.skin.bool(this, "enabled", true) && (this.parent?.kind !== "group" || this.parent.enabled);
  }

  // Text.
  fontPx(): number {
    // Points to pixels at 96 dpi, rounded as GDI does.
    return Math.round(((this.skin.num(this, "fontsize") ?? 8) * 96) / 72);
  }

  font(): string {
    const style = (this.attr("fontstyle") ?? "").toLowerCase();
    const face = this.attr("fontface") ?? this.attr("fonttype") ?? "Tahoma";
    return `${style.includes("italic") ? "italic " : ""}${style.includes("bold") ? "bold " : ""}${this.fontPx()}px "${face}", Tahoma, sans-serif`;
  }

  text(): string {
    const s = this.skin.state;
    if (this.role === "currentposition") return fmt(s.time);
    if (this.role === "status") return s.playing ? "Playing" : "Ready";
    if (this.role === "duration") return "";
    return this.skin.str(this, "value");
  }

  // Sliders.
  range(): [number, number, number] {
    const role = this.role;
    const min = this.skin.num(this, "min") ?? (role === "balance" ? -100 : 0);
    const max = this.skin.num(this, "max") ?? 100;
    let value = this.dragValue ?? this.skin.num(this, "value");
    if (value === null) value = role === "volume" ? min + (this.skin.volume / 100) * (max - min) : role === "balance" ? (min + max) / 2 : min;
    return [min, max, Math.min(max, Math.max(min, value))];
  }

  fraction(): number {
    const [min, max, v] = this.range();
    return max > min ? (v - min) / (max - min) : 0;
  }

  vertical(): boolean {
    return (this.attr("direction") ?? "").toLowerCase() === "vertical";
  }

  /** The slider track: where the thumb's leading edge can go, and its size. */
  track(): { from: number; span: number; thumb: Img | undefined } {
    const thumb = this.img("thumbimage");
    const border = this.skin.num(this, "bordersize") ?? 0;
    const length = this.vertical() ? this.h : this.w;
    const t = thumb ? (this.vertical() ? thumb.height : thumb.width) : 0;
    return { from: border, span: Math.max(0, length - 2 * border - t), thumb };
  }

  tooltip(): string {
    return (this.down && this.attr("downtooltip")) || this.attr("uptooltip") || this.attr("tooltip") || "";
  }

  interactive(): boolean {
    return ["button", "element", "slider", "custom"].includes(this.kind);
  }

  /** The image to show for the element's state; falls back to `image`. */
  stateImage(owner: El): Img | undefined {
    const pick = (...names: string[]) => names.map((n) => owner.img(n)).find(Boolean);
    if (!this.enabled) return pick("disabledimage", "image");
    if (this.down && this.hover) return pick("hoverdownimage", "downimage", "image");
    if (this.down) return pick("downimage", "image");
    if (this.hover) return pick("hoverimage", "image");
    return pick("image");
  }

  // Painting. `g` has its origin at the parent's top-left.
  paint(g: CanvasRenderingContext2D) {
    if (!this.visible || this.kind === "none" || this.kind === "element") return;
    // Visualisations and text are drawn inside the window's shape, not part of it.
    if (this.skin.shaping && (this.kind === "effects" || this.kind === "text")) return;
    const alpha = this.skin.num(this, "alphablend");
    g.save();
    if (alpha !== null) g.globalAlpha = Math.min(1, Math.max(0, alpha / 255));
    if (this.kind === "container") this.paintContainer(g);
    else if (this.kind === "button") this.drawImage(g, this.stateImage(this), this.x, this.y);
    else if (this.kind === "group") this.paintGroup(g);
    else if (this.kind === "slider") this.paintSlider(g);
    else if (this.kind === "custom") this.paintCustom(g);
    else if (this.kind === "progress") this.paintProgress(g);
    else if (this.kind === "text") this.paintText(g);
    else if (this.kind === "effects") {
      // ponytail: a black placeholder until the visualisations (ATA-114).
      g.fillStyle = css(parseColor(this.attr("backgroundcolor")) ?? 0);
      g.fillRect(this.x, this.y, this.w, this.h);
    }
    g.restore();
  }

  /** Draws `img` with its transparencyColor (the element's, or `owner`'s) cut out. */
  drawImage(g: CanvasRenderingContext2D, img: Img | undefined, x: number, y: number, owner: El = this) {
    if (img) g.drawImage(this.skin.keyedImage(img, owner.attr("transparencycolor")), x, y);
  }

  private paintContainer(g: CanvasRenderingContext2D) {
    const { w, h } = this;
    if (w <= 0 || h <= 0) return;
    const layer = this.canvas("layer", w, h);
    const behind = this.kids.filter((k) => k.z < 0);
    for (const kid of behind) kid.paint(layer);
    const bg = this.img("backgroundimage");
    const color = parseColor(this.attr("backgroundcolor"));
    if (color !== null || bg) {
      const back = this.canvas("back", w, h);
      if (color !== null) {
        back.fillStyle = css(color);
        back.fillRect(0, 0, w, h);
      }
      if (bg) {
        const tiled = this.skin.bool(this, "backgroundtiled", false);
        const fill = (src: CanvasImageSource) => {
          if (tiled) {
            back.fillStyle = back.createPattern(src, "repeat")!;
            back.fillRect(0, 0, w, h);
          } else back.drawImage(src, 0, 0);
        };
        fill(bg.bitmap);
        // transparencyColor shows what is behind the background, children
        // with a negative zIndex included.
        const clear = [this.attr("transparencycolor"), this.attr("clippingcolor")].map(parseColor).filter((c) => c !== null);
        if (clear.length) {
          back.globalCompositeOperation = "destination-out";
          fill(this.skin.maskImage(bg, clear));
          back.globalCompositeOperation = "source-over";
        }
      }
      layer.drawImage(back.canvas, 0, 0);
    }
    for (const kid of this.kids) if (kid.z >= 0) kid.paint(layer);
    // clippingColor cuts the children too.
    const clipColor = parseColor(this.attr("clippingcolor"));
    const clipImg = this.img("clippingimage") ?? bg;
    if (clipColor !== null && clipImg) {
      layer.globalCompositeOperation = "destination-out";
      layer.drawImage(this.skin.maskImage(clipImg, [clipColor]), 0, 0);
      layer.globalCompositeOperation = "source-over";
    }
    g.drawImage(layer.canvas, this.x, this.y);
  }

  /** A button group draws `image` whole, then each element in a state other
   * than up from that state's image, inside the element's mapped area. */
  private paintGroup(g: CanvasRenderingContext2D) {
    const map = this.img("mappingimage");
    if (this.skin.bool(this, "showbackground", true)) this.drawImage(g, this.img("image"), this.x, this.y);
    if (!map) return;
    for (const el of this.kids) {
      if (el.kind !== "element" || !el.visible) continue;
      const img = el.stateImage(this);
      if (!img || img === this.img("image")) continue;
      const color = parseColor(el.attr("mappingcolor"));
      if (color === null) continue;
      const part = el.canvas("part", map.width, map.height);
      part.drawImage(this.skin.keyedImage(img, this.attr("transparencycolor")), 0, 0);
      part.globalCompositeOperation = "destination-in";
      part.drawImage(this.skin.maskImage(map, [color]), 0, 0);
      part.globalCompositeOperation = "source-over";
      g.drawImage(part.canvas, this.x, this.y);
    }
  }

  private paintSlider(g: CanvasRenderingContext2D) {
    const { x, y, w, h } = this;
    const bg = this.img("backgroundimage");
    const fg = this.img("foregroundimage");
    const tiled = this.skin.bool(this, "tiled", false);
    const drawTrack = (img: Img, clip?: [number, number, number, number]) => {
      g.save();
      g.beginPath();
      g.rect(...(clip ?? [x, y, w, h]));
      g.clip();
      const src = this.skin.keyedImage(img, this.attr("transparencycolor"));
      if (tiled) {
        g.translate(x, y);
        g.fillStyle = g.createPattern(src, "repeat")!;
        g.fillRect(0, 0, w, h);
      } else g.drawImage(src, x, y, w, h);
      g.restore();
    };
    if (bg) drawTrack(bg);
    const { from, span, thumb } = this.track();
    const t = this.fraction();
    const vertical = this.vertical();
    const pos = Math.round(from + (vertical ? 1 - t : t) * span);
    if (fg) {
      // The foreground fills the track up to the thumb's middle.
      const mid = pos + (thumb ? (vertical ? thumb.height : thumb.width) / 2 : 0);
      drawTrack(fg, vertical ? [x, y + mid, w, h - mid] : [x, y, mid, h]);
    }
    if (!thumb) return;
    const img = this.stateImageThumb() ?? thumb;
    if (vertical) this.drawImage(g, img, x + Math.round((w - thumb.width) / 2), y + pos);
    else this.drawImage(g, img, x + pos, y + Math.round((h - thumb.height) / 2));
  }

  private stateImageThumb(): Img | undefined {
    if (!this.enabled) return this.img("thumbdisabledimage");
    if (this.down) return this.img("thumbdownimage") ?? this.img("thumbhoverimage");
    if (this.hover) return this.img("thumbhoverimage");
    return undefined;
  }

  /** A custom slider shows one frame of a horizontal film strip: as many
   * frames as the strip is wider than the position image. */
  private paintCustom(g: CanvasRenderingContext2D) {
    const pos = this.img("positionimage");
    const strip = (this.hover || this.down ? this.img("hoverimage") : undefined) ?? this.img("image");
    if (!pos || !strip) return;
    const frames = Math.max(1, Math.floor(strip.width / pos.width));
    const frame = Math.round(this.fraction() * (frames - 1));
    const src = this.skin.keyedImage(strip, this.attr("transparencycolor"));
    g.drawImage(src, frame * pos.width, 0, pos.width, pos.height, this.x, this.y, pos.width, pos.height);
  }

  private paintProgress(g: CanvasRenderingContext2D) {
    const bg = this.img("backgroundimage");
    const fg = this.img("foregroundimage");
    this.drawImage(g, bg, this.x, this.y);
    if (!fg) return;
    g.save();
    g.beginPath();
    g.rect(this.x, this.y, this.w * this.fraction(), this.h);
    g.clip();
    this.drawImage(g, fg, this.x, this.y);
    g.restore();
  }

  private paintText(g: CanvasRenderingContext2D) {
    const { x, y, w, h } = this;
    const bg = parseColor(this.attr("backgroundcolor"));
    if (bg !== null) {
      g.fillStyle = css(bg);
      g.fillRect(x, y, w, h);
    }
    const text = this.text();
    if (!text) return;
    g.beginPath();
    g.rect(x, y, w, h);
    g.clip();
    g.font = this.font();
    g.textBaseline = "top";
    const fgName = !this.enabled && this.attr("disabledforegroundcolor") ? "disabledforegroundcolor" : this.hover && this.attr("hoverforegroundcolor") ? "hoverforegroundcolor" : "foregroundcolor";
    g.fillStyle = css(parseColor(this.attr(fgName)) ?? 0);
    const width = g.measureText(text).width;
    const justify = (this.attr("justification") ?? "left").toLowerCase();
    let left = justify === "center" ? x + (w - width) / 2 : justify === "right" ? x + w - width : x;
    const scroll = this.skin.bool(this, "scrolling", false) && width > w;
    if (scroll) {
      // Scroll right to left by scrollingAmount px every scrollingDelay ms, with a gap.
      const step = this.skin.num(this, "scrollingamount") ?? 1;
      const delay = Math.max(16, this.skin.num(this, "scrollingdelay") ?? 100);
      const loop = width + w / 2;
      left = x - ((Math.floor(performance.now() / delay) * step) % loop);
      g.fillText(text, left + loop, y + 1);
      this.skin.animate();
    }
    g.fillText(text, left, y + 1);
    if ((this.attr("fontstyle") ?? "").toLowerCase().includes("underline")) g.fillRect(left, y + this.fontPx() + 1, width, 1);
  }

  // Hit testing, in the parent's coordinates. Returns the topmost interactive
  // element under the point, `this` for a drawn but inert part, or null.
  hit(px: number, py: number): El | null {
    if (!this.visible || this.kind === "none") return null;
    const lx = px - this.x;
    const ly = py - this.y;
    if (this.kind === "container") {
      if (lx < 0 || ly < 0 || lx >= this.w || ly >= this.h) return null;
      for (let i = this.kids.length - 1; i >= 0; i--) {
        const found = this.kids[i].hit(lx, ly);
        if (found) return found;
      }
      return null;
    }
    if (this.skin.bool(this, "passthrough", false)) return null;
    if (lx < 0 || ly < 0 || lx >= this.w || ly >= this.h) return null;
    if (this.kind === "group") {
      const map = this.img("mappingimage");
      const els = this.kids.filter((e) => e.kind === "element" && e.visible);
      const i = map ? mappedElement(map, lx, ly, els.map((e) => parseColor(e.attr("mappingcolor")))) : -1;
      if (i >= 0) return els[i];
      return this.solid(this.img("image"), lx, ly) ? this : null;
    }
    if (this.kind === "button") return this.solid(this.img("image"), lx, ly) ? this : null;
    if (this.kind === "custom") {
      const pos = this.img("positionimage");
      return pos && this.gray(pos, lx, ly) !== null ? this : null;
    }
    return this;
  }

  /** Whether (x, y) is a drawn pixel of `img`, given the transparencyColor. */
  private solid(img: Img | undefined, x: number, y: number): boolean {
    if (!img) return true;
    const rgb = rgbAt(img, x, y);
    return rgb >= 0 && rgb !== parseColor(this.attr("transparencycolor"));
  }

  /** A position image's grey level at (x, y), 0..1, or null if not grey. */
  gray(pos: Img, x: number, y: number): number | null {
    const rgb = rgbAt(pos, x, y);
    const [r, g, b] = [rgb >> 16, (rgb >> 8) & 255, rgb & 255];
    return rgb >= 0 && r === g && g === b ? r / 255 : null;
  }

  /** The slider value for a point in the parent's coordinates. */
  valueAt(px: number, py: number): number | null {
    const [min, max] = this.range();
    const lx = px - this.x;
    const ly = py - this.y;
    let t: number | null;
    if (this.kind === "custom") {
      const pos = this.img("positionimage");
      t = pos ? this.gray(pos, lx, ly) : null;
    } else {
      const { from, span, thumb } = this.track();
      const vertical = this.vertical();
      const half = thumb ? (vertical ? thumb.height : thumb.width) / 2 : 0;
      const along = (vertical ? ly : lx) - from - half;
      t = span > 0 ? Math.min(1, Math.max(0, along / span)) : 0;
      if (vertical) t = 1 - t;
    }
    return t === null ? null : min + t * (max - min);
  }

  /** Where this element's origin is in view coordinates. */
  origin(): [number, number] {
    let x = 0;
    let y = 0;
    for (let p = this.parent; p; p = p.parent) {
      if (p.parent) {
        x += p.x;
        y += p.y;
      }
    }
    return [x, y];
  }
}

export class Skin {
  readonly canvas = document.createElement("canvas");
  readonly measure = document.createElement("canvas").getContext("2d")!;
  readonly view: El;
  state: State = { playing: false, time: 0, title: "" };
  volume = 100;
  private byId = new Map<string, El>();
  private constants: Map<string, unknown>;
  private scope: object;
  private keyCache = new WeakMap<Img, Map<string, HTMLCanvasElement>>();
  private logged = new Set<string>();
  private pressed: El | null = null;
  /** Whether the pressed button was down before the press (sticky buttons). */
  private wasDown = false;
  private hovered: El | null = null;
  private animating = false;
  /** True while painting the window shape. */
  shaping = false;
  private shapeMask: HTMLCanvasElement | null = null;

  constructor(
    theme: Node,
    private images: Map<string, Img>,
    private send: Send,
    scripts: string[] = [],
  ) {
    this.constants = constants(scripts);
    const viewNode = theme.children.find((n) => n.tag === "view");
    if (!viewNode) throw new Error("the skin has no view");
    // Expressions find elements by id, so ids are known before geometry is.
    this.scope = new Proxy(Object.create(null), {
      has: (_, k) => typeof k === "string" && (this.byId.has(k) || this.constants.has(k)),
      get: (_, k) => {
        if (typeof k !== "string") return undefined;
        const e = this.byId.get(k);
        return e ? this.api(e) : this.constants.get(k);
      },
    });
    this.view = new El(viewNode, null, this);
    const index = (e: El) => {
      const id = e.attr("id");
      if (id && !this.byId.has(id)) this.byId.set(id, e);
      e.kids.forEach(index);
    };
    index(this.view);
    this.byId.set("view", this.view);
    this.canvas.style.imageRendering = "pixelated";
    this.listen();
  }

  /** What an expression sees of an element. */
  private api(e: El) {
    return {
      get left() { return e.x; },
      get top() { return e.y; },
      get width() { return e.w; },
      get height() { return e.h; },
      get visible() { return e.visible; },
      get enabled() { return e.enabled; },
      id: e.attr("id"),
    };
  }

  log(msg: string) {
    if (this.logged.has(msg)) return;
    this.logged.add(msg);
    console.warn(`skin: ${msg}`);
  }

  image(name: string | undefined): Img | undefined {
    if (!name) return undefined;
    const img = this.images.get(name.trim().toLowerCase());
    if (!img) this.log(`missing image ${name}`);
    return img;
  }

  /** The player properties a static skin can show. */
  private prop(path: string): unknown {
    const p = path.toLowerCase();
    if (/^eq\.gainlevel\d+$/.test(p)) return 0;
    const props: Record<string, unknown> = {
      "player.controls.currentposition": this.state.time,
      "player.controls.currentpositionstring": fmt(this.state.time),
      "player.currentmedia.duration": 0,
      "player.currentmedia.durationstring": "",
      "player.currentmedia.name": this.state.title,
      "player.status": this.state.playing ? "Playing" : "Ready",
      "player.settings.volume": this.volume,
      "player.settings.balance": 0,
    };
    return props[p];
  }

  /** Whether a named transport control is enabled, or null for other names.
   * A live stream can play or stop; it has no previous, next or seeking. */
  controlEnabled(role: string): boolean | null {
    if (role === "play") return !this.state.playing;
    if (role === "pause" || role === "stop") return this.state.playing;
    // Tag names (prevbutton, ffwdelement, seekslider) and the
    // player.controls names that wmpenabled: uses.
    if (["prev", "previous", "next", "ffwd", "fastforward", "rew", "fastreverse", "seek"].includes(role)) return false;
    return null;
  }

  /** An attribute's value: plain, a player property, or an expression. */
  private value(e: El, name: string): { ok: boolean; v?: unknown } {
    const raw = e.attr(name);
    if (raw === undefined) return { ok: false };
    const m = /^\s*(jscript|wmpprop|wmpenabled):\s*([\s\S]*?)[\s;]*$/i.exec(raw);
    if (!m) return { ok: true, v: raw };
    const [, kind, expr] = m;
    if (kind.toLowerCase() === "wmpenabled") {
      const control = /^player\.controls\.(\w+)$/i.exec(expr);
      const v = control ? this.controlEnabled(control[1].toLowerCase()) : null;
      return v === null ? this.fail(name, raw) : { ok: true, v };
    }
    if (kind.toLowerCase() === "wmpprop") {
      const v = this.prop(expr);
      if (v !== undefined) return { ok: true, v };
    }
    try {
      // Only expressions made of element properties work before the skin's
      // scripts run; calls into those scripts fail here and are skipped.
      // An element's own properties come first: `width="jscript:parent.width-left;"`.
      return { ok: true, v: new Function("scope", "self", `with (scope) with (self) { return (${expr}); }`)(this.scope, this.api(e)) };
    } catch {
      return this.fail(name, raw);
    }
  }

  private fail(name: string, raw: string) {
    this.log(`${name}="${raw}" needs the skin's scripts, ignored`);
    return { ok: false };
  }

  num(e: El, name: string): number | null {
    const { ok, v } = this.value(e, name);
    if (!ok) return null;
    const n = typeof v === "number" ? v : parseFloat(String(v));
    return Number.isFinite(n) ? n : null;
  }

  bool(e: El, name: string, fallback: boolean): boolean {
    const { ok, v } = this.value(e, name);
    if (!ok) return fallback;
    return typeof v === "string" ? v.trim().toLowerCase() !== "false" : Boolean(v);
  }

  str(e: El, name: string): string {
    const { ok, v } = this.value(e, name);
    return ok && v !== undefined && v !== null ? String(v) : "";
  }

  /** `img` with the given colour made transparent, cached. */
  keyedImage(img: Img, color: string | undefined): CanvasImageSource {
    const rgb = parseColor(color);
    return rgb === null ? img.bitmap : this.cached(img, `key${rgb}`, () => keyed(img, [rgb]));
  }

  /** A mask for compositing: the pixels of `img` in `colors`, opaque. */
  maskImage(img: Img, colors: number[]): CanvasImageSource {
    return this.cached(img, `mask${colors.join(",")}`, () => keyed(img, colors, true));
  }

  private cached(img: Img, tag: string, make: () => Uint8ClampedArray<ArrayBuffer>): HTMLCanvasElement {
    let byTag = this.keyCache.get(img);
    if (!byTag) this.keyCache.set(img, (byTag = new Map()));
    let c = byTag.get(tag);
    if (!c) {
      c = document.createElement("canvas");
      c.width = img.width;
      c.height = img.height;
      c.getContext("2d")!.putImageData(new ImageData(make(), img.width, img.height), 0, 0);
      byTag.set(tag, c);
    }
    return c;
  }

  /** Paints the view onto the canvas, inside the window shape. */
  paint() {
    const { w, h } = this.view;
    if (!this.shapeMask) {
      this.shaping = true;
      this.shapeMask = document.createElement("canvas");
      this.draw(this.shapeMask, w, h);
      this.shaping = false;
    }
    const g = this.draw(this.canvas, w, h);
    g.globalCompositeOperation = "destination-in";
    g.drawImage(this.shapeMask, 0, 0);
    g.globalCompositeOperation = "source-over";
  }

  private draw(c: HTMLCanvasElement, w: number, h: number): CanvasRenderingContext2D {
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
    }
    const g = c.getContext("2d")!;
    g.clearRect(0, 0, w, h);
    // The view's own position is the window's, not a place on the canvas.
    g.save();
    g.translate(-this.view.x, -this.view.y);
    this.view.paint(g);
    g.restore();
    return g;
  }

  /** The view's size and its opaque pixels, for the window region: the
   * skin's images, without visualisations or text. */
  shape() {
    const { width, height } = this.shapeMask!;
    const data = this.shapeMask!.getContext("2d")!.getImageData(0, 0, width, height);
    return { width, height, rects: runs(data) };
  }

  setState(s: State) {
    const old = this.state;
    this.state = s;
    if (old.playing !== s.playing || Math.floor(old.time) !== Math.floor(s.time) || old.title !== s.title) this.paint();
  }

  /** Something on screen moves: repaint on the next frame. */
  animate() {
    if (this.animating) return;
    this.animating = true;
    requestAnimationFrame(() => {
      this.animating = false;
      this.paint();
    });
  }

  /** The pointer in view coordinates. */
  private point(ev: MouseEvent): [number, number] {
    const r = this.canvas.getBoundingClientRect();
    return [((ev.clientX - r.left) * this.canvas.width) / r.width, ((ev.clientY - r.top) * this.canvas.height) / r.height];
  }

  private at(ev: MouseEvent): El | null {
    const [x, y] = this.point(ev);
    return this.view.kids.reduceRight<El | null>((found, kid) => found ?? kid.hit(x, y), null);
  }

  private listen() {
    const c = this.canvas;
    c.addEventListener("mousemove", (ev) => {
      if (this.pressed && (this.pressed.kind === "slider" || this.pressed.kind === "custom")) {
        this.slide(this.pressed, ev, false);
        return;
      }
      const found = this.at(ev);
      const target = found?.interactive() && found.enabled ? found : null;
      if (target !== this.hovered) {
        if (this.hovered) this.hovered.hover = false;
        if (target) target.hover = true;
        this.hovered = target;
        c.title = target?.tooltip() ?? "";
        c.style.cursor = target && (target.attr("cursor") ?? "").toLowerCase() === "hand" ? "pointer" : "default";
        this.paint();
      }
    });
    c.addEventListener("mouseleave", () => {
      if (this.hovered) this.hovered.hover = false;
      this.hovered = null;
      this.paint();
    });
    c.addEventListener("mousedown", (ev) => {
      if (ev.button !== 0) return;
      const found = this.at(ev);
      if (found?.interactive() && found.enabled) {
        this.pressed = found;
        this.wasDown = found.down;
        if (found.kind === "slider" || found.kind === "custom") this.slide(found, ev, false);
        found.down = true;
        this.paint();
      } else if (found || this.opaque(ev)) {
        // The body of the skin: move the window.
        this.send({ type: "drag" });
      }
    });
    window.addEventListener("mouseup", (ev) => {
      const e = this.pressed;
      if (!e) return;
      this.pressed = null;
      if (e.kind === "slider" || e.kind === "custom") {
        this.slide(e, ev, true);
        e.down = false;
      } else {
        const sticky = this.bool(e, "sticky", false);
        const inside = this.at(ev) === e;
        // A sticky button toggles on a click and keeps its state otherwise.
        e.down = sticky && (inside ? !this.wasDown : this.wasDown);
        if (inside) this.click(e);
      }
      this.paint();
    });
  }

  /** Whether the pixel under the pointer is part of the skin. */
  private opaque(ev: MouseEvent): boolean {
    const [x, y] = this.point(ev);
    return this.canvas.getContext("2d")!.getImageData(Math.floor(x), Math.floor(y), 1, 1).data[3] > 0;
  }

  private slide(e: El, ev: MouseEvent, done: boolean) {
    const [x, y] = this.point(ev);
    const [ox, oy] = e.origin();
    const v = e.valueAt(x - ox, y - oy);
    if (v !== null) {
      e.dragValue = v;
      // Whatever the slider's own range, the protocol wants 0..1 and -1..1.
      const t = e.fraction();
      if (e.role === "volume") {
        this.volume = t * 100;
        this.send({ type: "volume", value: t });
      } else if (e.role === "balance") this.send({ type: "balance", value: t * 2 - 1 });
    }
    // Volume and balance keep the dragged value; anything else bound to the
    // player goes back to the player's value. Seeking is disabled: live.
    if (done && e.role !== "volume" && e.role !== "balance") e.dragValue = null;
    this.paint();
  }

  private click(e: El) {
    const role = e.role;
    if (role === "play") this.send({ type: "play" });
    // A live stream cannot pause: pausing stops it.
    else if (role === "stop" || role === "pause") this.send({ type: "stop" });
    else if (e.attr("onclick")) this.log(`onClick of <${e.node.tag}> needs the skin's scripts, ignored`);
  }
}
