// Milkdrop, through Butterchurn (MIT, Jordan Berg) and its "minimal" pack of
// 29 presets (ATA-167). The skin protocol serves both as /milkdrop.js, loaded
// the first time Milkdrop shows. Butterchurn renders with WebGL 2 from the
// samples the trusted page sends in each frame: no audio reaches this webview.

/** The presets in butterchurnPresetsMinimal, by name, for the visualisation
 * menu; tests check the pack agrees. */
export const PRESETS = [
  "$$$ Royal - Mashup (197)",
  "$$$ Royal - Mashup (431)",
  "_Mig_085",
  "An AdamFX n Martin Infusion 2 flexi - Why The Sky Looks Diffrent Today - AdamFx n Martin Infusion - Tack Tile Disfunction B",
  "Eo.S. + Phat - cubetrace - v2",
  "Flexi - alien fish pond",
  "flexi - bouncing balls [double mindblob neon mix]",
  "Flexi - mindblob [shiny mix]",
  "Flexi, fishbrain, Geiss + Martin - tokamak witchery",
  "Flexi, martin + geiss - dedicated to the sherwin maxawow",
  "Geiss - Cauldron - painterly 2 (saturation remix)",
  "Geiss - Reaction Diffusion 2",
  "Geiss - Thumb Drum",
  "Idiot - Star Of Annon",
  "Krash + Illusion - Spiral Movement",
  "Martin - acid wiring",
  "martin - chain breaker",
  "martin - extreme heat",
  "martin - mandelbox explorer - high speed demo version",
  "Martin - QBikal - Surface Turbulence IIb",
  "martin - reflections on black tiles",
  "martin - witchcraft reloaded",
  "martin [shadow harlequins shape code] - fata morgana",
  "Milk Artist At our Best - FED - SlowFast Ft AdamFX n Martin - HD CosmoFX",
  "suksma - uninitialized variabowl (hydroponic chronic)",
  "Unchained & Rovastar - Wormhole Pillars (Hall of Shadows mix)",
  "Unchained - Rewop",
  "yin - 191 - Temporal singularities",
  "Zylot - Paint Spill (Music Reactive Paint Mix)",
];

type Visualizer = {
  loadPreset(preset: object, blendSeconds: number): void;
  setRendererSize(w: number, h: number): void;
  render(opts: { audioLevels: { timeByteArray: Uint8Array; timeByteArrayL: Uint8Array; timeByteArrayR: Uint8Array } }): void;
};
type Lib = {
  butterchurn: { default: { createVisualizer(ctx: null, canvas: HTMLCanvasElement, opts: object): Visualizer } };
  butterchurnPresetsMinimal: { getPresets(): Record<string, object> };
};

/** One effects element's renderer, the frame it last drew, and that drawing. */
export type Milk = { gl: HTMLCanvasElement; vis: Visualizer; preset: number; drawn: unknown; still: HTMLCanvasElement };

let lib: "loading" | "failed" | Lib | null = null;

/** Butterchurn and the presets, loading them on the first call: null until they are in. */
function load(): Lib | null {
  if (lib === null) {
    lib = "loading";
    const s = document.createElement("script");
    s.src = "/milkdrop.js";
    s.onload = () => (lib = window as unknown as Lib);
    s.onerror = () => {
      lib = "failed";
      console.warn("skin: milkdrop.js did not load");
    };
    document.head.append(s);
  }
  return typeof lib === "object" ? lib : null;
}

/** Draws Milkdrop preset `preset` into (x, y, w, h). It renders only when a
 * new frame comes, so no frames (hidden, covered, minimised, paused) means
 * no rendering. A frame without samples (a pick's flat frame) or none at
 * all leaves the background. */
export function milkdrop(g: CanvasRenderingContext2D, frame: { pcm?: number[] } | null, preset: number, [x, y, w, h]: [number, number, number, number], bg: string, mem: { milk: Milk | null }) {
  const l = frame?.pcm ? load() : null;
  if (!l || !frame?.pcm) {
    g.fillStyle = bg;
    return g.fillRect(x, y, w, h);
  }
  if (!mem.milk) {
    const gl = document.createElement("canvas");
    [gl.width, gl.height] = [w, h];
    try {
      const vis = l.butterchurn.default.createVisualizer(null, gl, { width: w, height: h, pixelRatio: 1, textureRatio: 1 });
      mem.milk = { gl, vis, preset: -1, drawn: null, still: document.createElement("canvas") };
    } catch (e) {
      // No WebGL 2: Milkdrop stays dark, and the other effects work.
      lib = "failed";
      console.warn(`skin: Milkdrop cannot start: ${String(e)}`);
      return milkdrop(g, frame, preset, [x, y, w, h], bg, mem);
    }
  }
  const m = mem.milk;
  if (m.gl.width !== w || m.gl.height !== h) {
    [m.gl.width, m.gl.height] = [w, h];
    m.vis.setRendererSize(w, h);
  }
  if (m.preset !== preset) {
    const presets = l.butterchurnPresetsMinimal.getPresets();
    m.vis.loadPreset(Object.values(presets)[preset] ?? Object.values(presets)[0], m.preset < 0 ? 0 : 1);
    m.preset = preset;
  }
  if (m.drawn !== frame) {
    m.drawn = frame;
    // Mono: the trusted page's analyser mixes the channels.
    const pcm = Uint8Array.from(frame.pcm);
    m.vis.render({ audioLevels: { timeByteArray: pcm, timeByteArrayL: pcm, timeByteArrayR: pcm } });
    // A WebGL canvas may be cleared once drawn; repaints between frames use this copy.
    [m.still.width, m.still.height] = [w, h];
    m.still.getContext("2d")!.drawImage(m.gl, 0, 0);
  }
  g.drawImage(m.still, x, y);
}
