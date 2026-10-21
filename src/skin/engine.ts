// The skin engine: draws a skin's first view, runs its scripts against the
// WMP object model (runtime.ts), and drives the player through its controls.
//
// Everything is painted back to front on one canvas the size of the view, so
// the window shape is the opaque pixels of the skin's images, and a subview's
// clippingColor is a compositing step. Element semantics follow Microsoft's
// skin reference (learn.microsoft.com/windows/win32/wmp/skin-programming-reference).
import { CHANNELS } from "../player.ts";
import { constants, type Node } from "./wms.ts";
import { average, css, firstAt, keyed, mappedElement, mix, overlay, parseColor, playingColors, rgbAt, runs, sliderAt, textOn, thumb, tiles, type Pixels } from "./pixels.ts";
import { ALBUM_ART, drawEffect, EFFECTS, effectIndex, type Frame, type Memory } from "./effects.ts";
import { clock, CONSTANTS, OS_MEDIA_CHANGING, OS_MEDIA_OPEN, objects, playState, resImage, resScript, resString, wmpObject, type Host } from "./runtime.ts";

/** A text showing the current item's name, title or author. */
const TITLE = /currentmedia\.(name\b|getiteminfo\(\s*["'](title|author)["'])/i;
export type Img = Pixels & { bitmap: CanvasImageSource };
/** The host's state message (docs/decisions.md, ATA-109). */
export type State = {
  playState: "playing" | "buffering" | "reconnecting" | "paused" | "stopped";
  channel: number;
  title: string;
  /** The current item's stream or page (player.URL). */
  url: string;
  /** player.currentMedia's item info: the show and where it comes from. */
  author: string;
  location: string;
  /** The page a double click on the title opens: a pick's episode page on nts.live, or "". */
  link: string;
  /** The playlist's titles; `channel` is the current one's index. */
  items: string[];
  /** The playlist's header rows, which never play (ATA-208). */
  headers?: number[];
  time: number;
  duration: number;
  volume: number;
  mute: boolean;
  balance: number;
  eq: number[];
  level: number;
  /** Whether other windows hide the player: scrolling text stops then (ATA-191). */
  covered?: boolean;
};
export type Send = (msg: { type: string; [k: string]: unknown }) => void;

/** The playlist's scroll bar width, in px: WMP's list draws Windows' own, about this wide at 96 dpi. */
const BAR = 16;

type Kind = "container" | "button" | "group" | "element" | "slider" | "custom" | "progress" | "text" | "effects" | "playlist" | "none";

// Drawn later or never: video needs media, the other playlists and popups need menus.
const NOT_YET = new Set(["video", "wmpvideo", "itemsplaylist", "dropdownplaylist", "popup"]);
// Elements with nothing to draw.
const SILENT = new Set(["player", "network", "mediacenter", "equalizersettings", "videosettings", "theme"]);

function kindOf(tag: string): Kind {
  if (tag === "view" || tag === "subview") return "container";
  if (tag === "buttongroup") return "group";
  if (tag === "customslider") return "custom";
  if (tag === "progressbar") return "progress";
  if (tag === "effects" || tag === "wmpeffects") return "effects";
  if (tag === "playlist") return "playlist";
  if (tag.endsWith("button")) return "button"; // button, imagebutton, playbutton, …
  if (tag.endsWith("element")) return "element"; // buttonelement, playelement, …
  if (tag.endsWith("slider")) return "slider"; // slider, seekslider, volumeslider, …
  if (tag.endsWith("text")) return "text"; // text, statustext, currentpositiontext, …
  return "none";
}

const HANDLER = /^on|_onchange$|^(playstatechange|openstatechange|statuschange|mediachange|modechange|disconnect)$/;
const BINDING = /^\s*(jscript|wmpprop|wmpenabled|wmpdisabled):\s*([\s\S]*?)[\s;]*$/i;

class El {
  readonly kind: Kind;
  readonly kids: El[] = [];
  /** For the named variants: "play" for playbutton or playelement, and so on. */
  readonly role: string;
  /** Negative values draw behind the parent's background, showing through
   * its transparencyColor. */
  readonly z: number;
  hover = false;
  /** Held down by the pointer. */
  down = false;
  /** A slider's value while the user drags it. */
  dragValue: number | null = null;
  /** Properties set by script, lower-case. They win over the markup. */
  readonly props = new Map<string, unknown>();
  /** Geometry as it was at load, before any script ran: alignment moves
   * and stretches elements by how far their parent has grown since. */
  readonly design = new Map<string, number>();
  private memo = new Map<string, number>();
  private memoGen = -1;
  // Reused offscreen canvases, one per purpose.
  private canvases = new Map<string, HTMLCanvasElement>();
  api: object | null = null;
  /** An effects element's peaks and trails. */
  readonly memory: Memory = { peaks: [], trail: null, milk: null };
  move: ReturnType<typeof setTimeout> | null = null;
  /** A playlist's average colour under it, when it names no background (Skin.draw). */
  under: number | null = null;

  readonly node: Node;
  readonly parent: El | null;
  readonly skin: Skin;

  constructor(node: Node, parent: El | null, skin: Skin) {
    this.node = node;
    this.parent = parent;
    this.skin = skin;
    this.kind = kindOf(node.tag);
    this.z = skin.num(this, "zindex") ?? 0;
    // A plain slider bound to the volume is a volume slider, and so on.
    const bound = /^wmpprop:player\.(?:settings\.(volume|balance)|controls\.(currentposition))$/i.exec(node.attrs.value ?? "");
    this.role = bound ? (bound[1] ?? "seek").toLowerCase() : node.tag.replace(/(button|element|slider|text)$/, "");
    // A button whose down state is the player's mute is a mute button (9SeriesDefault's bMute).
    if (/^wmpprop:player\.settings\.mute$/i.test(node.attrs.down ?? "")) this.role = "mute";
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

  /** Whether a property is set, by the markup or by script. */
  has(name: string): boolean {
    return this.props.has(name) || this.attr(name) !== undefined;
  }

  /** A colour attribute, evaluated like any other (`jscript:NormalTextColor`).
   * `auto` reads the image it keys: the clippingImage for clippingColor,
   * else the image or the backgroundImage. */
  color(name: string): number | null {
    const value = this.skin.str(this, name) || undefined;
    if (value?.trim().toLowerCase() !== "auto") return parseColor(value);
    const image = (name === "clippingcolor" && this.img("clippingimage")) || this.img("image") || this.img("backgroundimage");
    return parseColor(value, image);
  }

  img(name: string): Img | undefined {
    return this.skin.image(this.skin.str(this, name));
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

  // Geometry. A number set by script wins; a `jscript:` expression is worked
  // out again whenever anything has changed, since it may read other
  // elements; a plain number moves with its alignment as the parent grows.
  geo(name: "left" | "top" | "width" | "height"): number {
    const set = Number(this.props.get(name) ?? NaN);
    if (Number.isFinite(set)) return Math.round(set);
    // Text with no width fits what it shows now, which changes (the clock).
    if (name === "width" && this.kind === "text" && this.attr("width") === undefined) return this.natural(name);
    if (this.memoGen !== this.skin.gen) {
      this.memo.clear();
      this.memoGen = this.skin.gen;
    }
    let v = this.memo.get(name);
    if (v === undefined) {
      this.memo.set(name, 0); // an expression that loops back to itself reads 0
      const raw = this.attr(name);
      v = Math.round(this.skin.num(this, name) ?? this.natural(name));
      if (!this.design.has(name)) this.design.set(name, v);
      else if (raw !== undefined && !BINDING.test(raw)) v += this.shift(name);
      this.memo.set(name, v);
    }
    return v;
  }
  get x() { return this.geo("left"); }
  get y() { return this.geo("top"); }
  get w() { return this.geo("width"); }
  get h() { return this.geo("height"); }

  private alignment(name: string): string {
    const horizontal = name === "left" || name === "width";
    return this.skin.str(this, horizontal ? "horizontalalignment" : "verticalalignment").trim().toLowerCase();
  }

  /** How far `horizontalAlignment` or `verticalAlignment` moves or
   * stretches this element, given how much its parent has grown since load. */
  private shift(name: "left" | "top" | "width" | "height"): number {
    const p = this.parent;
    if (!p) return 0;
    const size = name === "left" || name === "width" ? "width" : "height";
    const grown = p.geo(size) - (p.design.get(size) ?? p.geo(size));
    const align = this.alignment(name);
    if (name === size) return align === "stretch" ? grown : 0;
    return align === "right" || align === "bottom" ? grown : align === "center" ? Math.round(grown / 2) : 0;
  }

  /** The size an element takes when its attributes do not give one. */
  private natural(name: string): number {
    if (name === "left" || name === "top") {
      // Centred, with no position given: in the middle of the parent (Classic's logo).
      const size = name === "left" ? "width" : "height";
      return this.parent && this.alignment(name) === "center" ? Math.round((this.parent.geo(size) - this.geo(size)) / 2) : 0;
    }
    const pick = (img: Img | undefined) => img && (name === "width" ? img.width : img.height);
    let size: number | undefined;
    if (this.kind === "container" || this.kind === "slider" || this.kind === "progress")
      size = pick(this.img("backgroundimage")) ?? (this.kind === "slider" ? pick(this.img("thumbimage")) : undefined);
    else if (this.kind === "button") size = pick(this.img("image"));
    else if (this.kind === "group") size = pick(this.img("mappingimage")) ?? pick(this.img("image"));
    else if (this.kind === "custom") size = pick(this.img("positionimage"));
    else if (this.kind === "text") size = name === "width" ? this.textWidth() + 2 : Math.ceil(this.fontPx() * 1.25);
    // Anything else, and a subview with no image, fills its parent.
    return size ?? (this.parent ? this.parent.geo(name as "width" | "height") : 0);
  }

  textWidth(): number {
    const g = this.skin.measure;
    g.font = this.font();
    return Math.ceil(g.measureText(this.text()).width);
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
    const style = this.skin.str(this, this.hover && this.has("hoverfontstyle") ? "hoverfontstyle" : "fontstyle").toLowerCase();
    const face = this.skin.str(this, "fontface") || this.skin.str(this, "fonttype") || "Tahoma";
    return `${style.includes("italic") ? "italic " : ""}${style.includes("bold") ? "bold " : ""}${this.fontPx()}px "${face}", Tahoma, sans-serif`;
  }

  text(): string {
    if (this.role === "currentposition") return this.skin.elapsed();
    if (this.role === "status") return this.skin.status();
    if (this.role === "duration") return this.skin.state.duration > 0 ? clock(this.skin.state.duration) : "";
    return this.skin.str(this, "value");
  }

  // Sliders.
  range(): [number, number, number] {
    const role = this.role;
    const min = this.skin.num(this, "min") ?? (role === "balance" ? -100 : 0);
    const { volume, balance, time, duration } = this.skin.state;
    // A seek slider runs from 0 to the pick's length, in seconds, as WMP's does.
    const max = this.skin.num(this, "max") ?? (role === "seek" && duration > 0 ? duration : 100);
    let value = this.dragValue ?? this.skin.num(this, "value");
    if (value === null)
      value =
        role === "volume" ? min + volume * (max - min)
        : role === "balance" ? min + ((balance + 1) / 2) * (max - min)
        : role === "seek" && duration > 0 ? min + (time / duration) * (max - min)
        : min;
    return [min, max, Math.min(max, Math.max(min, value))];
  }

  fraction(): number {
    const [min, max, v] = this.range();
    return max > min ? (v - min) / (max - min) : 0;
  }

  vertical(): boolean {
    return this.skin.str(this, "direction").toLowerCase() === "vertical";
  }

  /** The slider track: the element inset by borderSize at each end. */
  track(): { from: number; span: number } {
    const border = this.skin.num(this, "bordersize") ?? 0;
    return { from: border, span: Math.max(0, (this.vertical() ? this.h : this.w) - 2 * border) };
  }

  /** Pressed, or held down: by the pointer, by its `down` property (a sticky
   * click, a script, a binding), or by the player's mute. */
  shownDown(): boolean {
    if (this.role === "mute" && !this.has("down")) return this.down || this.skin.state.mute;
    return this.down || this.skin.bool(this, "down", false);
  }

  tooltip(): string {
    const pick = (name: string) => this.skin.str(this, name);
    return (this.shownDown() && pick("downtooltip")) || pick("uptooltip") || pick("tooltip");
  }

  interactive(): boolean {
    // Text and visualisations take clicks only if the skin handles them.
    return ["button", "element", "slider", "custom"].includes(this.kind) || ((this.kind === "text" || this.kind === "effects") && this.has("onclick"));
  }

  /** The image to show for the element's state; falls back to `image`. */
  stateImage(owner: El): Img | undefined {
    const pick = (...names: string[]) => names.map((n) => owner.img(n)).find(Boolean);
    if (!this.enabled) return pick("disabledimage", "image");
    if (this.shownDown() && this.hover) return pick("hoverdownimage", "downimage", "image");
    if (this.shownDown()) return pick("downimage", "image");
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
    else if (this.kind === "playlist") {
      if (this.skin.lists) this.skin.lists.push(this);
      else this.paintPlaylist(g);
    }
    else if (this.kind === "effects") this.paintEffects(g);
    g.restore();
  }

  /** Draws `img` with its transparencyColor (the element's, or `owner`'s) cut out. */
  drawImage(g: CanvasRenderingContext2D, img: Img | undefined, x: number, y: number, owner: El = this) {
    if (img) g.drawImage(this.skin.keyedImage(img, owner.color("transparencycolor")), x, y);
  }

  private paintContainer(g: CanvasRenderingContext2D) {
    const { w, h } = this;
    if (w <= 0 || h <= 0) return;
    // Back to front: the backgroundColor, which shows through the
    // background's transparencyColor (bluegrid's black screen; with a
    // clippingColor and no backgroundColor it is black, as circle's digit
    // slots show); children with a negative zIndex, on the parent's surface
    // and not clipped to this one (Asimov_Radio's head hangs below the radio
    // that holds it); the background with its holes; the other children.
    const bg = this.img("backgroundimage");
    const clipColor = this.color("clippingcolor");
    const clipImg = this.img("clippingimage") ?? bg;
    const clip = clipColor !== null && clipImg ? this.skin.maskImage(clipImg, [clipColor]) : null;
    const cut = (c: CanvasRenderingContext2D) => {
      if (!clip) return;
      c.save();
      c.globalCompositeOperation = "destination-out";
      c.drawImage(clip, 0, 0);
      c.restore();
    };
    const color = !this.has("backgroundcolor") && clip ? 0 : this.color("backgroundcolor");
    if (color !== null) {
      // Inside this subview's own region only: the house skin's dial sits
      // on the body's ring, which shows round the dial's clipped corners.
      const fill = this.canvas("fill", w, h);
      fill.fillStyle = css(color);
      fill.fillRect(0, 0, w, h);
      cut(fill);
      g.drawImage(fill.canvas, this.x, this.y);
    }
    g.save();
    g.translate(this.x, this.y);
    for (const kid of this.kids) if (kid.z < 0) kid.paint(g);
    g.restore();
    // clippingColor cuts the background and the plain children (circle's
    // arrow buttons carry the colour), but not a child subview, which has a
    // region of its own (circle's digits sit in a clipped slot). Children
    // are painted in order, the plain ones in runs that are cut before the
    // next subview goes on.
    const layer = this.canvas("layer", w, h);
    const run = this.canvas("run", w, h);
    const flush = () => {
      cut(run);
      layer.drawImage(run.canvas, 0, 0);
      run.clearRect(0, 0, w, h);
    };
    if (bg) {
      const tiled = this.skin.bool(this, "backgroundtiled", false);
      const fill = (src: CanvasImageSource) => {
        if (tiled) {
          run.fillStyle = run.createPattern(src, "repeat")!;
          run.fillRect(0, 0, w, h);
        } else run.drawImage(src, 0, 0);
      };
      fill(bg.bitmap);
      // transparencyColor shows what is behind the background, children
      // with a negative zIndex included.
      const clear = this.color("transparencycolor");
      if (clear !== null) {
        run.globalCompositeOperation = "destination-out";
        fill(this.skin.maskImage(bg, [clear]));
        run.globalCompositeOperation = "source-over";
      }
    }
    for (const kid of this.kids) {
      if (kid.z < 0) continue;
      if (kid.kind === "container") {
        flush();
        kid.paint(layer);
      } else kid.paint(run);
    }
    flush();
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
      const color = el.color("mappingcolor");
      if (color === null) continue;
      const part = el.canvas("part", map.width, map.height);
      part.drawImage(this.skin.keyedImage(img, this.color("transparencycolor")), 0, 0);
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
    // WMP 7.1 repeats a slider image's middle; whether tiled="false" stretches it is not known.
    const tiled = this.skin.bool(this, "tiled", true);
    const vertical = this.vertical();
    const border = this.skin.num(this, "bordersize") ?? 0;
    const drawTrack = (img: Img, clip?: [number, number, number, number]) => {
      g.save();
      g.beginPath();
      g.rect(...(clip ?? [x, y, w, h]));
      g.clip();
      const src = this.skin.keyedImage(img, this.color("transparencycolor"));
      if (tiled) {
        // borderSize px at each end are caps; the middle repeats along the slider
        // only (Headspace's EQ). Across it, one copy at the image's own size.
        const [iw, ih] = [img.width, img.height];
        for (const [from, to, px] of tiles(vertical ? h : w, vertical ? ih : iw, border))
          if (vertical) g.drawImage(src, 0, from, iw, px, x, y + to, iw, px);
          else g.drawImage(src, from, 0, px, ih, x + to, y, px, ih);
      } else g.drawImage(src, x, y, w, h);
      g.restore();
    };
    if (bg) drawTrack(bg);
    const thumb = this.img("thumbimage");
    const t = this.fraction();
    const { edge, thumb: at } = sliderAt(vertical ? h : w, border, thumb ? (vertical ? thumb.height : thumb.width) : 0, vertical ? 1 - t : t);
    if (fg && t > 0) {
      // The foreground runs from the start to the edge, and takes in the far cap only when full.
      if (vertical) drawTrack(fg, t < 1 ? [x, y + edge, w, h - edge] : undefined);
      else drawTrack(fg, t < 1 ? [x, y, edge, h] : undefined);
    }
    if (!thumb) return;
    // The thumb lines up with the slider's top (or left), as WMP's does.
    const img = this.stateImageThumb() ?? thumb;
    if (vertical) this.drawImage(g, img, x, y + at);
    else this.drawImage(g, img, x + at, y);
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
    const src = this.skin.keyedImage(strip, this.color("transparencycolor"));
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

  /** The width of the text last painted, for `textwidth_onchange`. */
  private shownWidth = -1;

  private paintText(g: CanvasRenderingContext2D) {
    const { x, y, w, h } = this;
    const bg = this.color("backgroundcolor");
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
    const fgName = !this.enabled && this.has("disabledforegroundcolor") ? "disabledforegroundcolor" : this.hover && this.has("hoverforegroundcolor") ? "hoverforegroundcolor" : "foregroundcolor";
    g.fillStyle = css(this.color(fgName) ?? 0);
    const width = g.measureText(text).width;
    // Skins scroll only text too long for its box from here (TheUnit, the
    // house skin). After the paint: what it changes must not reach a paint
    // half done.
    if (Math.ceil(width) !== this.shownWidth) {
      this.shownWidth = Math.ceil(width);
      queueMicrotask(() => this.skin.fire(this, "textwidth_onchange"));
    }
    const justify = (this.skin.str(this, "justification") || "left").toLowerCase();
    const left = justify === "center" ? x + (w - width) / 2 : justify === "right" ? x + w - width : x;
    const underline = this.skin.str(this, "fontstyle").toLowerCase().includes("underline");
    // WMP scrolls the text even when it fits (ATA-216).
    if (this.skin.bool(this, "scrolling", false)) this.marquee(g, text, x, y + 1, w, width, left, underline);
    else {
      g.fillText(text, left, y + 1);
      if (underline) g.fillRect(left, y + this.fontPx() + 1, width, 1);
    }
  }

  /** Draws `text` (`width` px) scrolling through a box `w` px wide at x,
   * from `start`, by scrollingAmount px every scrollingDelay ms towards
   * scrollingDirection, repeating after a 25 px gap, and asks for the next
   * step. WMP's defaults are 6 px, 85 ms and left; it keeps them for an
   * amount under 1, a delay under 30 or another direction (ATA-216).
   * Underlines each copy if asked. Starts at `since` on the paint clock. */
  private marquee(g: CanvasRenderingContext2D, text: string, x: number, y: number, w: number, width: number, start: number, underline: boolean, since = 0) {
    const amount = this.skin.num(this, "scrollingamount");
    const step = amount !== null && amount >= 1 ? amount : 6;
    const ms = this.skin.num(this, "scrollingdelay");
    const delay = ms !== null && ms >= 30 ? ms : 85;
    const right = this.skin.str(this, "scrollingdirection").toLowerCase() === "right";
    const loop = width + 25;
    const t = this.skin.clock - since;
    const moved = (Math.floor(t / delay) * step) % loop;
    const at = right ? start + moved : start - moved;
    // Copies a loop apart, enough to fill the box, from the first in sight.
    for (let p = x + ((((at - x) % loop) + loop) % loop) - loop; p < x + w; p += loop) {
      if (p + width <= x) continue;
      g.fillText(text, p, y);
      if (underline) g.fillRect(p, y + this.fontPx(), width, 1);
    }
    this.skin.later(delay - (t % delay), this.skin.overFx(this));
  }

  /** A solid box where the visualisation goes: Skin.paint works out from
   * it what covers the visualisation, and drawFx draws it on top. */
  private paintEffects(g: CanvasRenderingContext2D) {
    const skin = this.skin;
    if (skin.finding) skin.fxFound.push(this);
    // Album Art is static: it wants no analyser frames (ATA-200).
    if (skin.effect(this) !== ALBUM_ART) skin.effectsShown = true;
    g.fillStyle = skin.fxSolid;
    g.fillRect(this.x, this.y, this.w, this.h);
  }

  /** The visualisation, from the latest frame while the player plays, at
   * (x, y) on the canvas. */
  drawFx(g: CanvasRenderingContext2D, x: number, y: number) {
    const skin = this.skin;
    const fg = this.color("foregroundcolor");
    const frame = skin.state.playState === "playing" ? skin.frame : null;
    drawEffect(g, skin.effect(this), frame, skin.art, [x, y, this.w, this.h], css(this.color("backgroundcolor") ?? 0), fg === null ? null : css(fg), this.memory);
  }

  /** The playlist's row height, in px. */
  private rowHeight(): number {
    return Math.round(this.fontPx() * 2);
  }

  /** The playlist's first row in sight, and the item it last scrolled to. */
  private scroll = 0;
  private scrolledTo = -1;
  /** The playing row and name its scrolling started for, and when: a new
   * one starts from its first word (ATA-191). */
  private rolling = "";
  private rollingSince = 0;

  /** How many whole rows the playlist shows. */
  private rows(): number {
    return Math.max(1, Math.floor(this.h / this.rowHeight()));
  }

  /** Scrolls the playlist by `by` rows. */
  scrollBy(by: number) {
    this.scroll = Math.max(0, Math.min(this.skin.state.items.length - this.rows(), this.scroll + by));
  }

  /** The scroll bar's thumb, or null when every item fits. */
  private thumb() {
    return thumb(this.skin.state.items.length, this.rows(), this.scroll, this.h);
  }

  /** A press at (px, py), in the parent's coordinates: null when it is not
   * on the scroll bar; -1 when it paged up or down on the track; else how
   * far down the thumb it grabbed it. */
  pressBar(px: number, py: number): number | null {
    const t = this.thumb();
    if (!t || px < this.x + this.w - BAR) return null;
    const ly = py - this.y;
    if (ly >= t.at && ly < t.at + t.size) return ly - t.at;
    this.scrollBy(ly < t.at ? -this.rows() : this.rows());
    return -1;
  }

  /** Moves the thumb's top to `at` px down the track. */
  dragThumb(at: number) {
    const t = this.thumb();
    if (t) this.scroll = firstAt(at, this.skin.state.items.length, this.rows(), this.h, t.size);
  }

  /** The playlist row under a point in the parent's coordinates, or -1. */
  rowAt(py: number): number {
    const i = Math.floor((py - this.y) / this.rowHeight()) + this.scroll;
    return i >= this.scroll && i < this.skin.state.items.length ? i : -1;
  }

  /** The playlist: the channels, mixtapes and picks, one row each, the
   * current one in the playing colours, scrolled into sight when it changes,
   * and its name scrolling when it does not fit. A scroll bar, in the list's
   * own colours, when they do not all fit. */
  private paintPlaylist(g: CanvasRenderingContext2D) {
    const { x, y, w, h } = this;
    const bg = this.color("backgroundcolor");
    // With none, the skin's images show through, and black where there are none.
    g.fillStyle = css(bg ?? 0);
    if (bg === null) g.globalCompositeOperation = "destination-over";
    g.fillRect(x, y, w, h);
    g.globalCompositeOperation = "source-over";
    g.beginPath();
    g.rect(x, y, w, h);
    g.clip();
    g.font = this.font();
    g.textBaseline = "middle";
    const row = this.rowHeight();
    const { items, channel } = this.skin.state;
    const rows = this.rows();
    // With no text colour named, black or white, whichever reads: WMP's
    // default is Windows' text colour, black, which is lost on dark skins.
    const fg = this.color("foregroundcolor") ?? textOn(bg ?? this.under);
    const [playingFg, playingBg] = playingColors(this.color("itemplayingcolor"), this.color("itemplayingbackgroundcolor"));
    if (`${channel}\n${items[channel]}` !== this.rolling) {
      this.rolling = `${channel}\n${items[channel]}`;
      this.rollingSince = this.skin.clock;
    }
    if (channel !== this.scrolledTo) {
      this.scrolledTo = channel;
      if (channel < this.scroll || channel >= this.scroll + rows) {
        this.scroll = 0;
        this.scrollBy(channel);
      }
    }
    const t = this.thumb();
    const inner = w - (t ? BAR : 0);
    items.forEach((title, n) => {
      const i = n - this.scroll;
      if (i < 0 || i > rows) return;
      const top = y + i * row;
      const playing = n === channel;
      if (playing) {
        g.fillStyle = css(playingBg);
        g.fillRect(x, top, inner, row);
      }
      g.fillStyle = css(playing ? playingFg : fg);
      g.save();
      g.beginPath();
      g.rect(x + 6, top, inner - 12, row);
      g.clip();
      const width = g.measureText(title).width;
      if (playing && width > inner - 12) this.marquee(g, title, x + 6, top + row / 2, inner - 12, width, x + 6, false, this.rollingSince);
      else g.fillText(title, x + 6, top + row / 2);
      g.restore();
    });
    if (!t) return;
    // No images of WMP's: a track and a thumb in the list's own colours.
    const back = bg ?? this.under ?? 0;
    g.fillStyle = css(mix(back, fg, 0.15));
    g.fillRect(x + inner, y, BAR, h);
    g.fillStyle = css(mix(back, fg, 0.55));
    g.fillRect(x + inner + 2, y + t.at + 1, BAR - 4, t.size - 2);
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
        // The background's own pixels hide the children behind it: a click
        // there is on the body, not on anemone's visualisation underneath.
        if (this.kids[i].z < 0 && this.drawnAt(lx, ly)) return this;
        const found = this.kids[i].hit(lx, ly);
        if (found) return found;
      }
      return this.drawnAt(lx, ly) ? this : null;
    }
    if (this.skin.bool(this, "passthrough", false)) return null;
    if (lx < 0 || ly < 0 || lx >= this.w || ly >= this.h) return null;
    if (this.kind === "group") {
      const map = this.img("mappingimage");
      const els = this.kids.filter((e) => e.kind === "element" && e.visible);
      const i = map ? mappedElement(map, lx, ly, els.map((e) => e.color("mappingcolor"))) : -1;
      if (i >= 0) return els[i];
      // A group with no image of its own draws nothing outside its elements:
      // Cablemusic's close buttons span the drawer tabs under them.
      const img = this.img("image");
      return img && this.solid(img, lx, ly) ? this : null;
    }
    if (this.kind === "button") {
      // An image that is all transparencyColor makes the button an invisible
      // hotspot over its box: holiday_skin's controls, Grinch's playlist button.
      const img = this.img("image");
      return this.solid(img, lx, ly) || (img !== undefined && this.skin.blank(img, this.color("transparencycolor"))) ? this : null;
    }
    if (this.kind === "custom") {
      const pos = this.img("positionimage");
      return pos && this.gray(pos, lx, ly) !== null ? this : null;
    }
    return this;
  }

  /** Whether a container's background image is drawn at (x, y): not its
   * transparencyColor, nor its clippingColor. */
  private drawnAt(x: number, y: number): boolean {
    const bg = this.img("backgroundimage");
    const rgb = bg ? rgbAt(bg, x, y) : -1;
    return rgb >= 0 && rgb !== this.color("transparencycolor") && rgb !== this.color("clippingcolor");
  }

  /** Whether (x, y) is a drawn pixel of `img`, given the transparencyColor. */
  private solid(img: Img | undefined, x: number, y: number): boolean {
    if (!img) return true;
    const rgb = rgbAt(img, x, y);
    return rgb >= 0 && rgb !== this.color("transparencycolor");
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
      const { from, span } = this.track();
      const vertical = this.vertical();
      const along = (vertical ? ly : lx) - from;
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

  /** Every element in the tree, this one first. */
  *all(): Generator<El> {
    yield this;
    for (const kid of this.kids) yield* kid.all();
  }
}

// Members every element has, beyond its attributes.
const COMMON = new Set(["left", "top", "width", "height", "visible", "enabled", "value", "down", "id", "textwidth", "moveto", "alphablendto", "setfocus"]);
// An effects element's own members.
const EFFECT_MEMBERS = ["next", "previous", "currenteffecttype", "currentpreset", "currenteffecttitle"];
// Methods by tag, for what the engine does not draw yet.
const IDLE_METHODS: Record<string, string[]> = {
  // TwinBlade sets column widths before it opens its playlist drawer.
  playlist: ["setcolumnresizemode", "getcolumnresizemode", "setcolumnwidth"],
  itemsplaylist: ["setcolumnresizemode", "getcolumnresizemode", "setcolumnwidth"],
  popup: ["appenditem", "deleteitem", "show"],
};

export class Skin {
  readonly canvas = document.createElement("canvas");
  readonly measure = document.createElement("canvas").getContext("2d")!;
  readonly view: El;
  /** The latest analyser frame from the host, and whether a visualisation
   * was on screen at the last paint (the host sends frames only then). */
  frame: Frame | null = null;
  effectsShown = false;
  // Null until the first paint, so each skin tells the host whether it
  // wants frames: a skin chosen in the picker replaces one that did.
  private effectsOn: boolean | null = null;
  /** The show's picture from the trusted page's last `art` message (ATA-200). */
  art: HTMLImageElement | null = null;
  private artGen = 0;
  /** The effects element the visualisation menu was opened on (ATA-190). */
  private menuFor: El | null = null;
  /** How the visualisations were found at the last full paint: each one's
   * place on the canvas, the part of the canvas it touches, how much of it
   * shows there and what lies over it (pixels.ts `overlay`). A frame redraws
   * only those parts, not the whole skin (ATA-116). */
  private fx: { el: El; x: number; y: number; part: [number, number, number, number]; mask: HTMLCanvasElement; cover: HTMLCanvasElement }[] = [];
  /** The colour effects elements paint while a full paint looks for them,
   * whether it is looking, and those it found. */
  fxSolid = "#fff";
  finding = false;
  /** The time a paint draws scrolling text at, the same for both its passes. */
  clock = 0;
  fxFound: El[] = [];
  /** When the next scrolling-text step is due, its timer, and whether a
   * text that steps then overlaps a visualisation. */
  private stepAt = Infinity;
  private stepTimer: ReturnType<typeof setTimeout> | undefined;
  private stepOverFx = false;
  /** The biggest repaint asked for since the last display frame. */
  private pending: "fx" | "scroll" | "all" = "fx";
  /** Where full paints are drawn and read back (see paint). */
  private readonly probe = document.createElement("canvas").getContext("2d", { willReadFrequently: true })!;
  state: State = { playState: "stopped", channel: 0, title: "", url: "", author: "", location: "", link: "", items: CHANNELS.map((c) => c.title), time: 0, duration: 0, volume: 1, mute: false, balance: 0, eq: [], level: 0 };
  /** Bumped by every change scripts or the player make; geometry is cached per generation. */
  gen = 0;
  private byId = new Map<string, El>();
  private scope: object;
  private globals: Record<string, unknown>;
  private extras: Record<string, Record<string, any>>;
  /** player.openState: open once the host names a channel. */
  openState = 0;
  private started = false;
  /** True while a click's handlers run (`player.launchURL` needs it). */
  private userAction = false;
  private players: El[] = [];
  private compiled = new Map<string, (...args: unknown[]) => unknown>();
  private keyCache = new WeakMap<Img, Map<string, HTMLCanvasElement>>();
  private blanks = new WeakMap<Img, Map<number, boolean>>();
  private resImages = new Map<string, Img | undefined>();
  private logged = new Set<string>();
  private pressed: El | null = null;
  /** The playlist whose scroll bar thumb is held, and where it was grabbed. */
  private held: { list: El; grab: number } | null = null;
  /** The playlist row a double click may open: the current pick's, when the first press landed on it. */
  private linkRow = -1;
  /** Whether the pressed button showed down before the press (sticky buttons). */
  private wasDown = false;
  private hovered: El | null = null;
  private animating = false;
  private painting = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** True while painting the window shape. */
  shaping = false;
  /** The playlists a paint reached, to draw over the rest; null outside a paint. */
  lists: El[] | null = null;
  /** The playlists drawn at the last paint, for the pointer. */
  private shown: El[] = [];
  private shapeMask: HTMLCanvasElement | null = null;
  private lastShape = "";

  private images: Map<string, Img>;
  private send: Send;
  /** Seeks the skin's scripts have sent, so a drag's end seeks only once. */
  private seeks = 0;
  /** The skin's .js files, by lower-cased name. */
  private scripts: Map<string, string>;

  /** `prefix` is where the skin's preferences live in localStorage. */
  constructor(theme: Node, images: Map<string, Img>, send: Send, scripts: Map<string, string> = new Map(), prefix = "") {
    this.images = images;
    this.send = send;
    this.scripts = scripts;
    const viewNode = theme.children.find((n) => n.tag === "view");
    if (!viewNode) throw new Error("the skin has no view");
    const skin = () => this;
    const host: Host = {
      get state() { return skin().state; },
      get openState() { return skin().openState; },
      status: () => this.status(),
      elapsed: () => this.elapsed(),
      controlEnabled: (name) => this.controlEnabled(name),
      send: (msg) => {
        if (msg.type === "seek") this.seeks++;
        this.send(msg);
      },
      userAction: () => this.userAction,
      set: (patch) => {
        this.state = { ...this.state, ...patch };
        this.changed();
      },
      log: (msg) => this.log(msg),
      viewId: () => this.view.attr("id") ?? "",
      prefix,
    };
    this.extras = objects(host);
    const log = (msg: string) => this.log(msg);
    this.globals = Object.assign(Object.create(null), {
      ...CONSTANTS,
      player: wmpObject("player", this.extras.player, log),
      theme: wmpObject("theme", this.extras.theme, log),
      mediacenter: wmpObject("mediacenter", this.extras.mediacenter, log),
    });
    // Scripts, handlers and expressions all run inside `with (scope)`: element
    // ids first, then the WMP objects. Anything else falls through to the
    // global object, where the skin's own functions and variables live.
    this.scope = new Proxy(Object.create(null), {
      has: (_, k) => typeof k === "string" && (this.byId.has(k) || k in this.globals),
      get: (_, k) => {
        if (typeof k !== "string") return undefined;
        const e = this.byId.get(k);
        return e ? this.api(e) : this.globals[k];
      },
      set: (_, k) => {
        // `view = …` and the like: WMP's objects are read-only names.
        this.log(`cannot assign to ${String(k)}`);
        return true;
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

  /** Runs the view's scripts and its onLoad, starts its timer, and paints. */
  start() {
    const files = (this.view.attr("scriptfile") ?? "").split(";").map((f) => f.trim()).filter(Boolean);
    // What skin code sees; also what DevTools can read (AGENTS.md).
    (globalThis as Record<string, unknown>).__wmpScope = this.scope;
    for (const file of files) {
      const code = resScript(file) ?? this.scripts.get(file.replace(/^.*[\\/]/, "").toLowerCase());
      if (code === undefined) {
        this.log(`missing script ${file}`);
        continue;
      }
      try {
        // Global code, so the skin's functions and variables are shared by
        // its files, its handlers and its attributes, as in WMP.
        // Inside the block, a top-level function becomes global only when
        // its declaration is reached; JScript hoists them all. Copy them out
        // first, so a statement that throws loses nothing declared below it
        // (`typeof`: the scan also finds functions in comments, and nested ones,
        // which are not in scope here).
        const hoist = [...code.matchAll(/^[ \t]*function\s+([A-Za-z_$][\w$]*)/gm)].map(([, name]) => `if (typeof ${name} == "function") globalThis.${name} = ${name};`).join(" ");
        // oxlint-disable-next-line no-eval -- skin code runs in this webview by design (ATA-107)
        (0, eval)(`with (__wmpScope) { ${hoist}\n${code}\n}`);
      } catch (e) {
        // Keep what layout needs: the file's literal constants.
        this.log(`script ${file} failed: ${String(e)}`);
        for (const [name, v] of constants([code])) (globalThis as Record<string, unknown>)[name] ??= v;
      }
    }
    // Geometry as it is at load, for alignment.
    for (const e of this.view.all()) for (const name of ["left", "top", "width", "height"] as const) if (e.kind !== "none") e.geo(name);
    this.players = [...this.view.all()].filter((e) => e.node.tag === "player");
    this.started = true;
    this.openState = this.state.title ? OS_MEDIA_OPEN : 0;
    this.fire(this.view, "onload");
    this.restartTimer();
    this.paint();
  }

  /** The element's object for scripts and expressions: its properties and
   * methods, case-insensitive, with WMP's own members on the elements that
   * stand for player objects (`<player>`, `<equalizerSettings>`, …). */
  private api(e: El): object {
    if (e.api) return e.api;
    const extra = this.extra(e);
    const methods = IDLE_METHODS[e.node.tag] ?? [];
    const member = (k: string) => {
      const lk = k.toLowerCase();
      if (extra && lk in extra) return "extra";
      if (methods.includes(lk) || COMMON.has(lk) || e.props.has(lk) || (e.kind === "effects" && EFFECT_MEMBERS.includes(lk))) return lk;
      // Handlers are not properties: `onLoad="OnLoad();"` must find the
      // skin's function, not the attribute.
      if (e.attr(lk) !== undefined && !HANDLER.test(lk)) return lk;
      if (e === this.view && ["close", "minimize", "returntomediacenter", "size", "title", "timerinterval"].includes(lk)) return lk;
      return null;
    };
    const api = new Proxy(Object.create(null), {
      has: (_, k) => typeof k === "string" && member(k) !== null,
      get: (_, k) => {
        if (typeof k !== "string") return undefined;
        const m = member(k);
        if (m === "extra") return extra![k.toLowerCase()];
        if (m === null) {
          this.log(`${e.attr("id") ?? e.node.tag}.${k} is not supported`);
          return undefined;
        }
        return this.getMember(e, m, methods);
      },
      set: (_, k, v) => {
        const lk = String(k).toLowerCase();
        if (extra && lk in extra) extra[lk] = v;
        else this.setProp(e, lk, v);
        return true;
      },
    });
    e.api = api;
    return api;
  }

  private extra(e: El): Record<string, any> | null {
    const tag = e.node.tag;
    const name = tag === "equalizersettings" ? "eq" : tag === "videosettings" ? "vs" : tag;
    const members = (this.extras as Record<string, Record<string, any>>)[name];
    return members && SILENT.has(tag) ? wmpObject(tag, members, (msg) => this.log(msg)) : null;
  }

  private getMember(e: El, name: string, methods: string[]): unknown {
    switch (name) {
      case "left": return e.x;
      case "top": return e.y;
      case "width": return e.w;
      case "height": return e.h;
      case "visible": return e.visible;
      case "enabled": return e.enabled;
      case "down": return e.shownDown();
      case "id": return e.attr("id");
      case "textwidth": return e.kind === "text" ? e.textWidth() : 0;
      case "value": return e.kind === "text" ? e.text() : ["slider", "custom", "progress"].includes(e.kind) ? e.range()[2] : this.typed(this.str(e, "value"));
      case "moveto": return (x: unknown, y: unknown, ms: unknown) => this.moveTo(e, Number(x), Number(y), Number(ms));
      case "alphablendto": return (alpha: unknown) => this.setProp(e, "alphablend", Number(alpha));
      case "setfocus": return () => {};
      case "close": return () => this.close();
      case "minimize": return () => this.send({ type: "minimize" });
      case "returntomediacenter": return () => this.log("view.returnToMediaCenter: there is no full mode");
      case "size": return () => this.log("view.size: resizing by hand is not supported");
    }
    if (e.kind === "effects") {
      const i = this.effect(e);
      switch (name) {
        case "next": return () => this.stepEffect(e, 1);
        case "previous": return () => this.stepEffect(e, -1);
        case "currenteffecttype": return EFFECTS[i].type;
        case "currentpreset": return EFFECTS[i].preset;
        case "currenteffecttitle": return EFFECTS[i].title;
      }
    }
    if (methods.includes(name)) return () => this.log(`${e.node.tag}.${name} does nothing yet`);
    return this.typed(this.value(e, name).v);
  }

  /** Numbers in the markup read as numbers, as WMP's typed properties do. */
  private typed(v: unknown): unknown {
    return typeof v === "string" && /^\s*-?\d+(\.\d+)?\s*$/.test(v) ? Number(v) : v;
  }

  /** A script sets an element's property: it wins over the markup, the skin
   * repaints, and the element's `<name>_onchange` runs. */
  private setProp(e: El, name: string, v: unknown) {
    const old = e.props.has(name) ? e.props.get(name) : undefined;
    e.props.set(name, v);
    if (e === this.view && name === "timerinterval") this.restartTimer();
    this.changed();
    if (old !== v) this.fire(e, `${name}_onchange`);
  }

  /** The effect an effects element shows: its currentEffectType and
   * currentPreset, set by script or bound to `mediacenter`; with none set,
   * `mediacenter`'s, which is the listener's last choice. */
  effect(e: El): number {
    const type = this.str(e, "currenteffecttype");
    const mc = this.extras.mediacenter;
    return type ? effectIndex(type, this.num(e, "currentpreset") ?? 0) : effectIndex(mc.effecttype, mc.effectpreset);
  }

  /** effects.next() and previous(): the next effect, round the list. Each
   * property's _onchange runs, so the skin can save it to `mediacenter`. */
  private stepEffect(e: El, by: number) {
    this.setEffect(e, (this.effect(e) + by + EFFECTS.length) % EFFECTS.length);
  }

  private setEffect(e: El, index: number) {
    const { type, preset } = EFFECTS[index];
    // Saved for the next launch, whether or not the skin binds it.
    Object.assign(this.extras.mediacenter, { effecttype: type, effectpreset: preset });
    this.setProp(e, "currenteffecttype", type);
    this.setProp(e, "currentpreset", preset);
  }

  /** Slides an element to (x, y) over `ms`, then runs its onEndMove. */
  private moveTo(e: El, x: number, y: number, ms: number) {
    if (e.move) clearTimeout(e.move);
    const [x0, y0, t0] = [e.x, e.y, performance.now()];
    const step = () => {
      const t = ms > 0 ? Math.min(1, (performance.now() - t0) / ms) : 1;
      e.props.set("left", Math.round(x0 + (x - x0) * t));
      e.props.set("top", Math.round(y0 + (y - y0) * t));
      this.changed();
      if (t < 1) e.move = setTimeout(step, 16);
      else {
        e.move = null;
        this.fire(e, "onendmove");
      }
    };
    step();
  }

  private restartTimer() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const ms = this.num(this.view, "timerinterval") ?? 0;
    if (ms > 0 && this.view.has("ontimer")) this.timer = setInterval(() => this.fire(this.view, "ontimer"), ms);
  }

  private close() {
    this.fire(this.view, "onclose");
    this.send({ type: "close" });
  }

  /** Runs an element's handler attribute, if it has one. */
  fire(e: El, attr: string, args: Record<string, unknown> = {}) {
    const code = e.attr(attr);
    if (code) this.run(e, code, args);
  }

  /** Runs skin code with the element's own members in scope (`value`,
   * `down`), then element ids and the WMP objects, then the skin's globals. */
  private run(e: El, code: string, args: Record<string, unknown> = {}): unknown {
    const names = Object.keys(args);
    const key = `${names.join(",")}\n${code}`;
    try {
      let f = this.compiled.get(key);
      if (!f) this.compiled.set(key, (f = new Function("scope", "self", ...names, `with (scope) with (self) {\n${code}\n}`) as (...a: unknown[]) => unknown));
      return f(this.scope, this.api(e), ...names.map((n) => args[n]));
    } catch (err) {
      this.log(`${e.attr("id") ?? `<${e.node.tag}>`}: ${code.trim().slice(0, 60)} failed: ${String(err)}`);
    }
  }

  log(msg: string) {
    if (this.logged.has(msg)) return;
    this.logged.add(msg);
    console.warn(`skin: ${msg}`);
  }

  image(name: string | undefined): Img | undefined {
    if (!name) return undefined;
    if (/^res:/i.test(name)) return this.resImage(name);
    const img = this.images.get(name.trim().toLowerCase());
    if (!img) this.log(`missing image ${name}`);
    return img;
  }

  /** Our own stand-in for a wmploc.dll image, or nothing. */
  private resImage(ref: string): Img | undefined {
    if (!this.resImages.has(ref)) {
      const px = resImage(ref);
      let img: Img | undefined;
      if (px) {
        const c = document.createElement("canvas");
        c.width = px.width;
        c.height = px.height;
        c.getContext("2d")!.putImageData(new ImageData(px.data, px.width, px.height), 0, 0);
        img = { ...px, bitmap: c };
      } else this.log(`no stand-in for ${ref}`);
      this.resImages.set(ref, img);
    }
    return this.resImages.get(ref);
  }

  /** Whether a stream is on, or being brought back. */
  get playing(): boolean {
    return ["playing", "buffering", "reconnecting"].includes(this.state.playState);
  }

  status(): string {
    const p = this.state.playState;
    return p === "stopped" ? "Ready" : p[0].toUpperCase() + p.slice(1);
  }

  /** The elapsed time: blank while stopped, as in WMP, and while a stream
   * is paused, because pausing drops it (player.ts) and its clock reads 0.
   * A paused pick keeps its place, so shows it. */
  elapsed(): string {
    const p = this.state.playState;
    return this.playing || (p === "paused" && this.state.duration > 0) ? clock(this.state.time) : "";
  }

  /** Whether a named transport control is enabled, or null for other names.
   * Previous and next switch channels; only a pick, which has a length, can seek. */
  controlEnabled(role: string): boolean | null {
    if (role === "play") return !this.playing;
    if (role === "pause" || role === "stop") return this.playing;
    // Tag names (prevbutton, ffwdelement, seekslider) and the
    // player.controls names that wmpenabled: uses.
    if (["prev", "previous", "next"].includes(role)) return true;
    if (role === "seek" || role === "currentposition") return this.state.duration > 0;
    if (["ffwd", "fastforward", "rew", "fastreverse"].includes(role)) return false;
    return null;
  }

  /** An attribute's value: set by script, plain, a binding, or an expression. */
  private value(e: El, name: string): { ok: boolean; v?: unknown } {
    if (e.props.has(name)) {
      const v = e.props.get(name);
      return { ok: true, v: typeof v === "string" ? (resString(v, (msg) => this.log(msg)) ?? v) : v };
    }
    const raw = e.attr(name);
    if (raw === undefined) return { ok: false };
    const m = BINDING.exec(raw);
    if (!m) return { ok: true, v: resString(raw, (msg) => this.log(msg)) ?? raw };
    const [, kind, expr] = m;
    const k = kind.toLowerCase();
    if (k === "wmpenabled" || k === "wmpdisabled") {
      const control = /^player\.controls\.(\w+)$/i.exec(expr);
      const v = control ? this.controlEnabled(control[1].toLowerCase()) : null;
      return v === null ? this.fail(name, raw) : { ok: true, v: k === "wmpenabled" ? v : !v };
    }
    // wmpprop: reads the object model (`player.currentMedia.name`) or another
    // element (`bgTransports.left`), and jscript: may call the skin's
    // functions. Both are worked out again on every paint, so they follow
    // the player's state and whatever the scripts change.
    try {
      // An element's own properties come first: `width="jscript:parent.width-left;"`.
      let f = this.compiled.get(expr);
      if (!f) this.compiled.set(expr, (f = new Function("scope", "self", `with (scope) with (self) { return (${expr}); }`) as (...a: unknown[]) => unknown));
      return { ok: true, v: f(this.scope, this.api(e)) };
    } catch {
      return this.fail(name, raw);
    }
  }

  private fail(name: string, raw: string) {
    this.log(`${name}="${raw}" could not be worked out, ignored`);
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
    // A leading "false" is false, whatever follows: The_Doobie_Brothers'
    // playlist button has `down="false; jscript:pl.visible='true';"`.
    return typeof v === "string" ? !/^\s*false\b/i.test(v) : Boolean(v);
  }

  str(e: El, name: string): string {
    const { ok, v } = this.value(e, name);
    return ok && v !== undefined && v !== null ? String(v) : "";
  }

  /** Whether every pixel of `img` is `rgb`, cached. */
  blank(img: Img, rgb: number | null): boolean {
    if (rgb === null) return false;
    let byColor = this.blanks.get(img);
    if (!byColor) this.blanks.set(img, (byColor = new Map()));
    let all = byColor.get(rgb);
    if (all === undefined) {
      all = true;
      for (let y = 0; y < img.height && all; y++) for (let x = 0; x < img.width && all; x++) all = rgbAt(img, x, y) === rgb;
      byColor.set(rgb, all);
    }
    return all;
  }

  /** `img` with the given colour made transparent, cached. */
  keyedImage(img: Img, rgb: number | null): CanvasImageSource {
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

  /** Something scripts or the player changed: work geometry out again,
   * and repaint (and reshape the window, unless only the clock moved) once
   * the current handler is done. */
  changed(reshape = true) {
    this.gen++;
    if (reshape) this.shapeMask = null;
    if (this.painting) return;
    this.painting = true;
    queueMicrotask(() => {
      this.painting = false;
      this.paint();
    });
  }

  /** Paints the view onto the canvas, inside the window shape, and sends
   * the window its new shape when that changed. */
  paint(refind = true) {
    const { w, h } = this.view;
    if (w <= 0 || h <= 0) return;
    if (!this.shapeMask) {
      this.shaping = true;
      this.shapeMask = document.createElement("canvas");
      this.draw(this.shapeMask, w, h);
      this.shaping = false;
      const shape = this.shape();
      const key = JSON.stringify(shape);
      if (this.started && key !== this.lastShape) {
        this.lastShape = key;
        this.send({ type: "shape", ...shape });
      }
    }
    this.effectsShown = false;
    this.clock = performance.now();
    if (!refind && this.fx.length) {
      // Only a scrolling text moved, clear of the visualisations: what
      // covers them is as it was.
      this.fxSolid = "#000";
      this.drawShaped(this.canvas);
      this.paintFx();
      return this.effectsChanged();
    }
    this.fxFound = [];
    this.fxSolid = "#fff";
    this.finding = true;
    // On a canvas of its own: reading pixels back from the window's canvas
    // would move it off the GPU.
    const g = this.drawShaped(this.probe.canvas);
    this.finding = false;
    // The view again, with each visualisation black instead of white: the
    // difference is how much of it shows through what is drawn over it.
    const found = this.fxFound.map((el) => {
      const [x, y] = this.origin(el);
      const part: [number, number, number, number] = [Math.max(0, x), Math.max(0, y), 0, 0];
      part[2] = Math.min(w, x + el.w) - part[0];
      part[3] = Math.min(h, y + el.h) - part[1];
      return { el, x, y, part, white: part[2] > 0 && part[3] > 0 ? g.getImageData(...part).data : null };
    });
    this.fx = [];
    if (found.length) {
      this.fxSolid = "#000";
      this.drawShaped(this.probe.canvas);
      // ponytail: overlapping visualisations would read each other as cover; no skin seen has two.
      for (const { el, x, y, part, white } of found) {
        if (!white) continue;
        const { mask, cover } = overlay(white, g.getImageData(...part).data);
        const image = (name: string, data: Uint8ClampedArray<ArrayBuffer>) => {
          const c = el.canvas(name, part[2], part[3]);
          c.putImageData(new ImageData(data, part[2], part[3]), 0, 0);
          return c.canvas;
        };
        this.fx.push({ el, x, y, part, mask: image("mask", mask), cover: image("cover", cover) });
      }
    }
    if (this.canvas.width !== w || this.canvas.height !== h) [this.canvas.width, this.canvas.height] = [w, h];
    const out = this.canvas.getContext("2d")!;
    out.clearRect(0, 0, w, h);
    out.drawImage(this.probe.canvas, 0, 0);
    this.paintFx();
    this.effectsChanged();
  }

  /** Frames only while a visualisation is on screen: none while it is hidden. */
  private effectsChanged() {
    if (this.started && this.effectsShown !== this.effectsOn) {
      this.effectsOn = this.effectsShown;
      this.send({ type: "effects", on: this.effectsOn });
    }
  }

  /** An analyser frame from the host: repaint the visualisations on the
   * next display frame, if one shows it. */
  setFrame(f: Frame) {
    this.frame = f;
    if (this.effectsOn) this.animate("fx");
  }

  /** The show's picture from the host, decoded, then drawn. One that does
   * not decode leaves the background colour. */
  setArt(image: unknown) {
    const gen = ++this.artGen;
    const show = (img: HTMLImageElement | null) => {
      if (gen !== this.artGen) return;
      this.art = img;
      this.animate("fx");
    };
    if (typeof image !== "string") return show(null);
    const img = new Image();
    img.src = image;
    img.decode().then(
      () => show(img),
      () => {
        console.warn("skin: the show picture does not decode");
        show(null);
      },
    );
  }

  /** A right click: on a visualisation, the host's menu of effects for it
   * (ATA-190), and true; elsewhere false. */
  menu(ev: MouseEvent): boolean {
    const found = this.at(ev);
    if (found?.kind !== "effects") return false;
    this.menuFor = found;
    this.send({ type: "effectsMenu", effect: this.effect(found) });
    return true;
  }

  /** The effect picked in that menu, saved as next() saves it. */
  pickEffect(index: unknown) {
    if (this.menuFor && Number.isInteger(index) && EFFECTS[index as number]) this.setEffect(this.menuFor, index as number);
  }

  /** Redraws each visualisation in its part of the canvas, under what covers it. */
  private paintFx() {
    const g = this.canvas.getContext("2d")!;
    for (const { el, x, y, part, mask, cover } of this.fx) {
      const fx = el.canvas("fx", part[2], part[3]);
      el.drawFx(fx, x - part[0], y - part[1]);
      fx.globalCompositeOperation = "destination-in";
      fx.drawImage(mask, 0, 0);
      fx.globalCompositeOperation = "lighter";
      fx.drawImage(cover, 0, 0);
      fx.globalCompositeOperation = "source-over";
      g.clearRect(...part);
      g.drawImage(fx.canvas, part[0], part[1]);
    }
  }

  /** Where an element's top-left is on the canvas. */
  private origin(el: El): [number, number] {
    let [x, y] = [0, 0];
    for (let e: El | null = el; e && e !== this.view; e = e.parent) [x, y] = [x + e.x, y + e.y];
    return [x, y];
  }

  /** Whether an element overlaps a visualisation's part of the canvas. */
  overFx(el: El): boolean {
    const [x, y] = this.origin(el);
    return this.fx.some(({ part: [px, py, pw, ph] }) => x < px + pw && px < x + el.w && y < py + ph && py < y + el.h);
  }

  /** Paints the view onto `c`, inside the window shape. */
  private drawShaped(c: HTMLCanvasElement): CanvasRenderingContext2D {
    const g = this.draw(c, this.view.w, this.view.h);
    g.globalCompositeOperation = "destination-in";
    g.drawImage(this.shapeMask!, 0, 0);
    g.globalCompositeOperation = "source-over";
    return g;
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
    this.lists = [];
    this.view.paint(g);
    g.restore();
    // WMP's playlist is a window of its own, so it lies over every image in
    // the view, whatever its zIndex or place in the markup: 9SeriesDefault's
    // panel bitmaps come after its list, HOB's list has zIndex -2, and Hard
    // Boiled's drawer frame covers its list. Skins hide the list while a
    // drawer slides for this reason (9SeriesDefault's onEndMove).
    const lists = this.lists;
    this.lists = null;
    // What lies under a list with no background, for its text colour, read
    // where reading is cheap: the full paint's probe canvas.
    if (c === this.probe.canvas)
      for (const list of lists) {
        const [x, y] = this.origin(list);
        const [x0, y0, x1, y1] = [Math.max(0, x), Math.max(0, y), Math.min(w, x + list.w), Math.min(h, y + list.h)];
        if (list.color("backgroundcolor") === null && x1 > x0 && y1 > y0) list.under = average(g.getImageData(x0, y0, x1 - x0, y1 - y0).data);
      }
    // A window is part of the shape, even over a subview's clippingColor:
    // TEDDY's list sits in a hole in its drawer.
    for (const list of lists) {
      const [x, y] = this.origin(list);
      g.save();
      if (this.shaping) g.fillRect(x, y, list.w, list.h);
      else {
        g.translate(x - list.x, y - list.y);
        list.paint(g);
      }
      g.restore();
    }
    this.shown = lists;
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
    const before = { ps: playState(old.playState), status: this.status(), title: old.title, channel: old.channel };
    this.state = s;
    // Repaint for what skins show, not for the level or a sub-second clock.
    const shown = (t: State) => JSON.stringify([t.playState, t.channel, t.title, t.author, t.location, t.items, t.volume, t.mute, t.balance, t.eq, t.covered]);
    if (shown(old) !== shown(s)) this.changed();
    else if (Math.floor(old.time) !== Math.floor(s.time)) this.changed(false);
    if (this.started) this.events(before);
  }

  /** The `<player>` events that follow from a new state, in WMP's order:
   * the open state, then the play state. A channel switch passes through
   * osMediaChanging, as a new item does in WMP. */
  private events(before: { ps: number; status: string; title: string; channel: number }) {
    const players = this.players;
    const fire = (name: string, value?: unknown) => {
      for (const p of players) {
        this.fire(p, `${name}_onchange`);
        if (name === "openstate" || name === "playstate") this.fire(p, `${name}change`, { NewState: value });
      }
    };
    const s = this.state;
    const open = s.title ? OS_MEDIA_OPEN : 0;
    if (s.title !== before.title || s.channel !== before.channel) {
      if (before.title && open) {
        this.openState = OS_MEDIA_CHANGING;
        fire("openstate", OS_MEDIA_CHANGING);
      }
      this.openState = open;
      fire("openstate", open);
      for (const p of players) this.fire(p, "mediachange", { Item: this.extras.player.currentmedia });
      fire("url");
    }
    if (playState(s.playState) !== before.ps) fire("playstate", playState(s.playState));
    if (this.status() !== before.status) {
      fire("status");
      for (const p of players) this.fire(p, "statuschange");
    }
  }

  /** Repaint everything in `ms`, or sooner if already due: a scrolling
   * text's next step, rather than every display frame (ATA-116). None while
   * the player is covered; minimised, Rust hides the webview, which stops it. */
  later(ms: number, overFx: boolean) {
    if (this.state.covered) return;
    this.stepOverFx ||= overFx;
    const at = performance.now() + ms;
    if (at >= this.stepAt) return;
    clearTimeout(this.stepTimer);
    this.stepAt = at;
    this.stepTimer = setTimeout(() => {
      this.stepAt = Infinity;
      this.animate(this.stepOverFx ? "all" : "scroll");
      this.stepOverFx = false;
    }, ms);
  }

  /** Something on screen moves: repaint on the next frame. "fx": only the
   * visualisations; "scroll": everything, but what covers the visualisations
   * is as it was; "all": everything. */
  animate(what: "fx" | "scroll" | "all" = "all") {
    const order = ["fx", "scroll", "all"];
    if (order.indexOf(what) > order.indexOf(this.pending)) this.pending = what;
    if (this.animating) return;
    this.animating = true;
    requestAnimationFrame(() => {
      this.animating = false;
      const what = this.pending;
      this.pending = "fx";
      if (what === "all") this.paint();
      else if (what === "scroll") this.paint(false);
      else this.paintFx();
    });
  }

  /** The pointer in view coordinates. */
  private point(ev: MouseEvent): [number, number] {
    const r = this.canvas.getBoundingClientRect();
    return [((ev.clientX - r.left) * this.canvas.width) / r.width, ((ev.clientY - r.top) * this.canvas.height) / r.height];
  }

  private at(ev: MouseEvent): El | null {
    const [x, y] = this.point(ev);
    // The playlists first, since they lie over everything (draw).
    for (const list of [...this.shown].reverse()) {
      const [lx, ly] = this.origin(list);
      if (x >= lx && y >= ly && x < lx + list.w && y < ly + list.h) return list;
    }
    return this.view.hit(x + this.view.x, y + this.view.y);
  }

  private listen() {
    const c = this.canvas;
    c.addEventListener("mousemove", (ev) => {
      if (this.held) {
        const { list, grab } = this.held;
        list.dragThumb(this.point(ev)[1] - list.origin()[1] - list.y - grab);
        this.paint();
        return;
      }
      if (this.pressed && (this.pressed.kind === "slider" || this.pressed.kind === "custom")) {
        this.slide(this.pressed, ev, false);
        return;
      }
      const found = this.at(ev);
      this.hover(found?.interactive() && found.enabled ? found : null);
    });
    c.addEventListener("mouseleave", () => this.hover(null));
    c.addEventListener("mousedown", (ev) => {
      if (ev.button !== 0) return;
      const found = this.at(ev);
      if (found?.interactive() && !found.enabled) return;
      if (found?.interactive()) {
        this.pressed = found;
        this.wasDown = found.shownDown();
        if (found.kind === "slider" || found.kind === "custom") this.slide(found, ev, false);
        found.down = true;
        this.fire(found, "onmousedown");
        this.paint();
      } else if (found?.kind === "playlist") {
        const [px, py] = this.point(ev);
        const [ox, oy] = found.origin();
        const grab = found.pressBar(px - ox, py - oy);
        if (grab === null) this.pick(found, ev);
        else {
          if (grab >= 0) this.held = { list: found, grab };
          // A double click on the bar scrolls; it never opens a pick's page.
          this.linkRow = -1;
          this.paint();
        }
      } else if (found || this.opaque(ev)) {
        // The body of the skin: move the window.
        this.send({ type: "drag" });
      }
    });
    c.addEventListener("wheel", (ev) => {
      const found = this.at(ev);
      if (found?.kind !== "playlist") return;
      found.scrollBy(Math.sign(ev.deltaY));
      this.paint();
    });
    c.addEventListener("dblclick", (ev) => {
      const found = this.at(ev);
      if (found?.interactive() && found.enabled) this.byUser(() => this.fire(found, "ondblclick"));
      // A pick links to its episode page on nts.live: a double click on
      // the title, or on the pick's playlist row. A press still drags the window.
      else if (this.state.link && (found?.kind === "playlist" ? found.rowAt(this.point(ev)[1] - found.origin()[1]) === this.linkRow : found?.kind === "text" && TITLE.test(found.attr("value") ?? "")))
        this.send({ type: "launchUrl", url: this.state.link });
    });
    window.addEventListener("mouseup", (ev) => {
      this.held = null;
      const e = this.pressed;
      if (!e) return;
      this.pressed = null;
      e.down = false;
      if (e.kind === "slider" || e.kind === "custom") this.slide(e, ev, true);
      else {
        const inside = this.at(ev) === e;
        // A sticky button toggles its down property on a click, before its
        // onClick reads it. One whose down follows the player (a `wmpprop:`
        // binding, or a mute button's own) goes back to it after the
        // handler, which has set what it shows.
        const bound = BINDING.test(e.attr("down") ?? "") || (e.role === "mute" && !e.has("down"));
        if (inside && this.bool(e, "sticky", false)) this.setProp(e, "down", !this.wasDown);
        if (inside) this.click(e);
        if (bound) e.props.delete("down");
      }
      this.changed();
    });
  }

  private hover(target: El | null) {
    if (target === this.hovered) return;
    const was = this.hovered;
    if (was) was.hover = false;
    if (target) target.hover = true;
    this.hovered = target;
    this.canvas.title = target?.tooltip() ?? "";
    this.canvas.style.cursor = target && this.str(target, "cursor").toLowerCase() === "hand" ? "pointer" : "default";
    if (was) this.fire(was, "onmouseout");
    if (target) this.fire(target, "onmouseover");
    this.paint();
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
    if (v !== null && v !== e.dragValue) {
      e.dragValue = v;
      // Whatever the slider's own range, the protocol wants 0..1 and -1..1.
      const t = e.fraction();
      // Set locally too, so the slider holds still until the host's next state.
      if (e.role === "volume") {
        this.state.volume = t;
        this.send({ type: "volume", value: t });
      } else if (e.role === "balance") {
        this.state.balance = t * 2 - 1;
        this.send({ type: "balance", value: t * 2 - 1 });
      }
      this.fire(e, "value_onchange");
    }
    if (done) {
      const seeks = this.seeks;
      this.fire(e, "ondragend");
      this.fire(e, "onmouseup");
      // A seek goes out once, when the drag ends, unless the skin's onDragEnd
      // (Classic) or onMouseUp (QuantumRedshift) sent it. Television's misspells
      // currentPosition and sends none.
      if (e.role === "seek" && this.state.duration > 0 && this.seeks === seeks) {
        const seconds = e.fraction() * this.state.duration;
        // Set locally too, so the thumb stays where it was dropped.
        this.state.time = seconds;
        this.send({ type: "seek", seconds });
      }
      // A slider that follows nothing keeps the dropped value, as in WMP
      // (TwinBlade's seek bar); value_onchange already ran during the drag.
      if (e.dragValue !== null && !BINDING.test(e.attr("value") ?? "") && !["volume", "balance", "seek"].includes(e.role)) e.props.set("value", e.dragValue);
      // Back to the player's value.
      e.dragValue = null;
    }
    this.paint();
  }

  /** Runs `f` as the user's own action: only then may a skin open a link. */
  private byUser(f: () => void) {
    this.userAction = true;
    try {
      f();
    } finally {
      this.userAction = false;
    }
  }

  /** A click on a playlist row selects that item, playing it if the player was playing. */
  private pick(list: El, ev: MouseEvent) {
    const i = list.rowAt(this.point(ev)[1] - list.origin()[1]);
    if (i < 0 || this.state.headers?.includes(i)) return;
    this.send({ type: "select", index: i });
    // A double click opens a pick only if its row was already the current pick
    // at the first press: one that starts it should not open its page as well.
    if (!(ev.detail > 1)) this.linkRow = i === this.state.channel && this.state.link ? i : -1;
    // Set locally too, so the row shows as current before the host's next state.
    this.state.channel = i;
    this.paint();
  }

  private click(e: El) {
    this.byUser(() => this.clicked(e));
  }

  private clicked(e: El) {
    const role = e.role;
    if (["play", "pause", "stop", "next"].includes(role)) this.send({ type: role });
    else if (role === "prev" || role === "previous") this.send({ type: "previous" });
    else if (role === "close") this.close();
    else if (role === "minimize") this.send({ type: "minimize" });
    // A mute button with an onClick mutes through it (`player.settings.mute=down`).
    else if (role === "mute" && !e.has("onclick")) this.send({ type: "mute", value: !this.state.mute });
    this.fire(e, "onclick");
  }
}
