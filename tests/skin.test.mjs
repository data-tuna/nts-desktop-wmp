// The skin engine's pure parts: unzip, .wms decoding and parsing, and the
// pixel work behind button groups. No skins here: they are never committed,
// so the fixtures are built in the tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import { deflateRawSync } from "node:zlib";
import { unzip } from "../src/skin/wmz.ts";
import { constants, decode, parse } from "../src/skin/wms.ts";
import { average, firstAt, keyed, mappedElement, mix, overlay, parseColor, playingColors, runs, sliderAt, sliderSize, textOn, thumb, tiles } from "../src/skin/pixels.ts";

/** A zip with one entry per [name, bytes, deflate?], as skin tools write them. */
function zip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, raw, deflate] of entries) {
    const data = deflate ? deflateRawSync(raw) : raw;
    const n = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(deflate ? 8 : 0, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(n.length, 26);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(deflate ? 8 : 0, 10);
    dir.writeUInt32LE(data.length, 20);
    dir.writeUInt32LE(raw.length, 24);
    dir.writeUInt16LE(n.length, 28);
    dir.writeUInt32LE(offset, 42);
    locals.push(local, n, data);
    central.push(dir, n);
    offset += 30 + n.length + data.length;
  }
  const dirBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(dirBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, dirBytes, end]));
}

test("unzip inflates entries and keys them by lower-cased bare name", async () => {
  const wms = Buffer.from("<theme><view/></theme>".repeat(20));
  const files = await unzip(zip([["Skin/Corona.WMS", wms, true], ["Background.bmp", Buffer.from([1, 2, 3]), false]]));
  assert.deepEqual([...files.keys()], ["corona.wms", "background.bmp"]);
  assert.equal(new TextDecoder().decode(files.get("corona.wms")), wms.toString());
  assert.deepEqual([...files.get("background.bmp")], [1, 2, 3]);
  await assert.rejects(unzip(new Uint8Array(100)), /not a zip/);
});

test("decode reads UTF-16 with a BOM, UTF-8 with a BOM, and Windows-1252", () => {
  const text = "<theme author=\"©2000\">é</theme>";
  const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]);
  const be = Buffer.from(le);
  be.swap16();
  assert.equal(decode(le), text);
  assert.equal(decode(be), text);
  assert.equal(decode(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text)])), text);
  // No BOM: Windows-1252, where © is 0xA9 and é 0xE9.
  assert.equal(decode(Buffer.from(text, "latin1")), text);
  assert.equal(decode(Buffer.from([0x93, 0x80, 0x94])), "“€”");
});

test("parse folds tag and attribute names to lower case", () => {
  const theme = parse(`<!-- (c) -->
    <THEME>
      <VIEW Width="10" backgroundImage="Bg.bmp">
        <buttonGroup mappingImage="map.bmp"><PlayElement mappingColor="#00FF00"/></buttongroup>
        <Text value="after the group"/>
      </View>
    </theme>`);
  assert.equal(theme.tag, "theme");
  const view = theme.children[0];
  assert.equal(view.tag, "view");
  assert.deepEqual({ ...view.attrs }, { width: "10", backgroundimage: "Bg.bmp" });
  // </buttongroup> closes <buttonGroup>, so the text is the view's child.
  assert.deepEqual(view.children.map((n) => n.tag), ["buttongroup", "text"]);
  assert.equal(view.children[0].children[0].tag, "playelement");
});

test("parse forgives what hand-written skins do", () => {
  const theme = parse(`<?xml version="1.0"?><theme>
    <subview left="42" top="145" left="11" onClick="if(a&&b<c)go();" title='it&apos;s'>
      <button image=x.bmp />
    </SUBVIEW>
    </stray>
    <text constructor="yes"></text>
  </theme>`);
  const [sub, text] = theme.children;
  assert.equal(sub.attrs.left, "11", "the last of a repeated attribute wins");
  assert.equal(sub.attrs.onclick, "if(a&&b<c)go();");
  assert.equal(sub.attrs.title, "it's");
  assert.equal(sub.children[0].attrs.image, "x.bmp");
  assert.equal(text.attrs.constructor, "yes");
  assert.equal(parse('<theme><text value="x"/></theme>').children[0].attrs.toString, undefined);
});

test("constants reads top-level literals and nothing else", () => {
  const found = constants([
    'var leftOffset = 260;\r\nvar color = "#FF00FF" // pink\nvar on = true\n  var inner = 5;\nvar sum = leftOffset+40;\nvar neg = -2.5;\nvar octal = 010;\nvar zero = 0;\nvar off = false;',
    "var leftOffset = 1;",
  ]);
  assert.deepEqual(Object.fromEntries(found), { leftOffset: 260, color: "#FF00FF", on: true, neg: -2.5, zero: 0, off: false });
});

/** A width×height image filled from a function of (x, y) to 0xRRGGBB. */
function image(width, height, rgb) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const c = rgb(x, y);
      data.set([c >> 16, (c >> 8) & 255, c & 255, 255], (y * width + x) * 4);
    }
  return { width, height, data };
}

test("mapping-image hit testing finds the element by colour", () => {
  // Left half red, right half green, bottom row magenta (no element).
  const map = image(4, 3, (x, y) => (y === 2 ? 0xff00ff : x < 2 ? 0xff0000 : 0x00ff00));
  const colors = [parseColor("#00FF00"), parseColor("#ff0000")];
  assert.equal(mappedElement(map, 0, 0, colors), 1);
  assert.equal(mappedElement(map, 3.7, 1.2, colors), 0);
  assert.equal(mappedElement(map, 1, 2, colors), -1);
  assert.equal(mappedElement(map, 4, 0, colors), -1, "outside the image");
  assert.equal(mappedElement(map, -1, 0, colors), -1);
  assert.equal(mappedElement(map, 0, 0, [null, 0xff0000]), 1, "an unreadable colour matches nothing");
});

test("parseColor reads colours as WMP does", () => {
  assert.equal(parseColor("#FF00FF"), 0xff00ff);
  assert.equal(parseColor("9aacdb"), null, "WMP rejects a bare RRGGBB");
  assert.equal(parseColor("#ffff"), null);
  assert.equal(parseColor(" White "), 0xffffff);
  // WMP's 140 names, Internet Explorer's list: lightgrey, but no grey.
  assert.equal(parseColor("Chartreuse"), 0x7fff00);
  assert.equal(parseColor("lightgoldenrodyellow"), 0xfafad2);
  assert.equal(parseColor("yellowgreen"), 0x9acd32);
  assert.equal(parseColor("lightgrey"), 0xd3d3d3);
  assert.equal(parseColor("grey"), null);
  assert.equal(parseColor("lightgray"), null);
  // System colours, at Windows' defaults.
  assert.equal(parseColor("Scrollbar"), 0xc8c8c8);
  assert.equal(parseColor("buttonface"), 0xf0f0f0);
  assert.equal(parseColor("threeddarkshadow"), 0x696969);
  assert.equal(parseColor("windowtext"), 0x000000);
  // auto: the top-left pixel of the image the colour applies to.
  const img = image(2, 2, (x, y) => (x === 0 && y === 0 ? 0x123456 : 0xffffff));
  assert.equal(parseColor("auto", img), 0x123456);
  assert.equal(parseColor(" AUTO ", img), 0x123456);
  assert.equal(parseColor("auto"), null, "no image");
  assert.equal(parseColor("auto", image(0, 0, () => 0)), null, "empty image");
  assert.equal(parseColor("none"), null);
  assert.equal(parseColor("constructor"), null);
  assert.equal(parseColor(undefined), null);
});

test("keyed clears or keeps colours, and runs traces the opaque rows", () => {
  const img = image(5, 2, (x, y) => (y === 0 && (x === 0 || x === 3) ? 0xff00ff : 0x123456));
  const cleared = { ...img, data: keyed(img, [0xff00ff]) };
  assert.deepEqual(runs(cleared), [[1, 0, 2, 1], [4, 0, 1, 1], [0, 1, 5, 1]]);
  const kept = { ...img, data: keyed(img, [0xff00ff], true) };
  assert.deepEqual(runs(kept), [[0, 0, 1, 1], [3, 0, 1, 1]]);
  assert.equal(img.data[3], 255, "the source is left alone");
});

test("playlist: the playing row takes the skin's colours, else WMP's green on #222222", () => {
  // Headspace names neither, so its row is green as in WMP.
  assert.deepEqual(playingColors(null, null), [0x00ff00, 0x222222]);
  // circle names only the text, Plus! Hard Boiled only the background.
  assert.deepEqual(playingColors(0xffffff, null), [0xffffff, 0x222222]);
  assert.deepEqual(playingColors(null, 0x666666), [0x00ff00, 0x666666]);
  // The house skin names both.
  assert.deepEqual(playingColors(0xf5a540, 0x18252b), [0xf5a540, 0x18252b]);
  assert.equal(mix(0x285f03, 0xffffff, 0), 0x285f03);
  assert.equal(mix(0x000000, 0xffffff, 0.5), 0x808080);
});

test("playlist: the scroll bar's thumb shows how much is in sight, and dragging it scrolls", () => {
  assert.equal(thumb(5, 5, 0, 140), null, "no bar when every row fits");
  // 20 rows, 7 in sight, a 140 px track: a 49 px thumb with 91 px to travel.
  assert.deepEqual(thumb(20, 7, 0, 140), { at: 0, size: 49 });
  assert.deepEqual(thumb(20, 7, 13, 140), { at: 91, size: 49 });
  assert.deepEqual(thumb(20, 7, 6, 140), { at: 42, size: 49 });
  assert.deepEqual(thumb(500, 2, 0, 48), { at: 0, size: 8 }, "never shorter than 8 px");
  for (const first of [0, 1, 6, 12, 13]) assert.equal(firstAt(thumb(20, 7, first, 140).at, 20, 7, 140, 49), first);
  assert.equal(firstAt(-30, 20, 7, 140, 49), 0, "dragged above the track");
  assert.equal(firstAt(500, 20, 7, 140, 49), 13, "dragged below it");
});

test("slider: the thumb's centre sits on the value's edge, and the track keeps its length", () => {
  // A 100 px slider, a 10 px thumb, no border: the thumb overhangs each end by half.
  assert.deepEqual(sliderAt(100, 0, 10, 0), { edge: 0, thumb: -5 }, "minimum");
  assert.deepEqual(sliderAt(100, 0, 10, 0.5), { edge: 50, thumb: 45 }, "middle");
  assert.deepEqual(sliderAt(100, 0, 10, 1), { edge: 100, thumb: 95 }, "maximum");
  // borderSize 7 on 76 px (Headspace's EQ), a 9 px thumb: the track runs 7..69.
  assert.deepEqual(sliderAt(76, 7, 9, 0), { edge: 7, thumb: 3 });
  assert.deepEqual(sliderAt(76, 7, 9, 0.5), { edge: 38, thumb: 34 });
  assert.deepEqual(sliderAt(76, 7, 9, 1), { edge: 69, thumb: 65 });
});

test("slider: a tiled image keeps borderSize px at each end as caps and repeats only the middle", () => {
  // Headspace's EQ: a 15 px image, borderSize 7, on a 76 px slider. Cap, a
  // 62 px bar of the image's one middle row, then the bottom cap.
  const eq = tiles(76, 15, 7);
  assert.deepEqual(eq.slice(0, 2), [[0, 0, 7], [8, 69, 7]]);
  assert.equal(eq.length, 2 + 62);
  assert.ok(eq.slice(2).every(([from, , px], i) => from === 7 && px === 1 && eq[i + 2][1] === 7 + i));
  // No border: the whole image repeats, the last copy cut short.
  assert.deepEqual(tiles(25, 10, 0), [[0, 0, 10], [0, 10, 10], [0, 20, 5]]);
  // An image too short for both caps repeats whole.
  assert.deepEqual(tiles(5, 2, 7), [[0, 0, 2], [0, 2, 2], [0, 4, 1]]);
});

test("slider: with no size of its own, it takes the largest background or foreground image, never the thumb", () => {
  const size = (images) => sliderSize((name) => images[name]);
  assert.deepEqual(size({ backgroundimage: { width: 80, height: 10 } }), { width: 80, height: 10 }, "background only");
  const both = { backgroundimage: { width: 60, height: 12 }, foregroundimage: { width: 50, height: 16 } };
  assert.deepEqual(size(both), { width: 60, height: 16 }, "the largest of each");
  assert.deepEqual(size({ ...both, thumbimage: { width: 70, height: 20 } }), { width: 60, height: 16 }, "a thumb larger than both does not count");
  assert.deepEqual(size({ thumbimage: { width: 9, height: 17 } }), undefined, "a thumb alone gives no size");
  assert.deepEqual(size({ backgroundimage: { width: 10, height: 10 }, disabledimage: { width: 12, height: 8 }, foregroundhoverimage: { width: 4, height: 14 } }), { width: 12, height: 14 });
});

test("effects: bars are log-spaced spectrum peaks, the wave is evenly sampled, and unknown effects fall back", async () => {
  const { bands, samples, effectIndex } = await import("../src/skin/effects.ts");
  // 1024 bins at 48 kHz: 23.4 Hz each. A tone at bin 100 (2.3 kHz) lands in one bar only.
  const spectrum = new Uint8Array(1024);
  spectrum[100] = 200;
  const bars = bands(spectrum, 48000, 32);
  assert.equal(bars.length, 32);
  assert.deepEqual(bars.filter((v) => v), [200]);
  assert.ok(bars.indexOf(200) > 16 && bars.indexOf(200) < 24, "2.3 kHz sits two-thirds of the way up a 40 Hz-16 kHz log scale");
  assert.equal(bands(new Uint8Array(1024).fill(9), 48000, 32).every((v) => v === 9), true, "no bar is empty");
  // The app's 8192-point analyser: no two bars read the same bin, at either rate.
  for (const rate of [44100, 48000])
    for (let k = 0; k < 4096; k++) {
      const one = new Uint8Array(4096);
      one[k] = 1;
      assert.ok(bands(one, rate, 32).filter((v) => v).length <= 1, `bin ${k} at ${rate} Hz lights more than one bar`);
    }
  assert.deepEqual(samples(Uint8Array.from({ length: 8 }, (_, i) => i), 4), [0, 2, 4, 6]);
  assert.equal(effectIndex("Bars and Waves", 1), 2);
  assert.equal(effectIndex("ambience", 7), 3, "unknown preset: the type's first");
  assert.equal(effectIndex("", 0), 0);
  assert.equal(effectIndex("{some-clsid}", 3), 0);
});

test("effects: Milkdrop has one entry per preset in the pack the protocol serves, by its name", async () => {
  const { EFFECTS, effectIndex } = await import("../src/skin/effects.ts");
  const { PRESETS } = await import("../src/skin/milkdrop.ts");
  const { createRequire } = await import("node:module");
  const pack = createRequire(import.meta.url)("butterchurn-presets/lib/butterchurnPresetsMinimal.min.js");
  assert.deepEqual(Object.keys(pack.getPresets()), PRESETS);
  const milk = EFFECTS.flatMap((e, i) => (e.type === "Milkdrop" ? [i] : []));
  assert.deepEqual(milk.map((i) => EFFECTS[i].preset), [...PRESETS.keys()]);
  assert.equal(milk.at(-1), EFFECTS.length - 1, "next() from the last preset goes round to Album Art");
  assert.equal(effectIndex("milkdrop", 5), milk[5]);
});

test("overlay: a visualisation redrawn under its mask and cover matches the skin painted over it", () => {
  // Per pixel: what lies over the visualisation (straight RGBA, alpha 0..1),
  // or null outside the window shape.
  const over = [[0, 0, 0, 0], [255, 0, 0, 1], [0, 0, 255, 0.5], null];
  const paint = (fx) => over.flatMap((o) => {
    if (!o) return [0, 0, 0, 0];
    return [0, 1, 2].map((c) => o[c] * o[3] + fx * (1 - o[3])).concat(255);
  });
  const { mask, cover } = overlay(new Uint8ClampedArray(paint(255)), new Uint8ClampedArray(paint(0)));
  for (const fx of [0, 90, 200]) {
    const want = paint(fx);
    for (let i = 0; i < want.length; i += 4) {
      for (let c = 0; c < 3; c++) {
        const got = (mask[i + 3] / 255) * fx + (cover[i + c] * cover[i + 3]) / 255;
        assert.ok(Math.abs(got - want[i + c]) <= 2, `pixel ${i / 4} channel ${c}: ${got} for ${want[i + c]}`);
      }
      assert.ok(Math.abs(mask[i + 3] + cover[i + 3] - want[i + 3]) <= 1, `pixel ${i / 4} alpha`);
    }
  }
});

test("effects menu: Album Art first, Bars, Scope and Ambience, then every Milkdrop preset by name, the current one checked", async () => {
  const { EFFECTS, effectsMenu } = await import("../src/skin/effects.ts");
  const { PRESETS } = await import("../src/skin/milkdrop.ts");
  const { effects, milkdrop } = effectsMenu(5);
  assert.deepEqual(effects, [
    { index: 0, text: "Album Art", checked: false },
    { index: 1, text: "Bars", checked: false },
    { index: 2, text: "Scope", checked: false },
    { index: 3, text: "Ambience", checked: false },
  ]);
  assert.equal(milkdrop.length, PRESETS.length);
  assert.deepEqual(milkdrop.map((e) => e.index), [...PRESETS.keys()].map((i) => i + 4));
  assert.deepEqual(milkdrop.filter((e) => e.checked).map((e) => e.index), [5]);
  assert.equal(milkdrop[0].text, "$$$ Royal - Mashup (197)");
  assert.equal(milkdrop[25].text, "Unchained && Rovastar - Wormhole Pillars (Hall of Shadows mix)", "a lone & would be a mnemonic");
  assert.equal(effects.length + milkdrop.length, EFFECTS.length);
});

test("playlist: with no text colour named, black or white, whichever reads on what lies under it (ATA-198)", () => {
  // Primitive's paper and springflower's green take black; Melvin's dark blue and an unknown backdrop, white.
  assert.equal(textOn(0xf7c473), 0x000000);
  assert.equal(textOn(0x3dc22d), 0x000000);
  assert.equal(textOn(0x4848a4), 0xffffff);
  assert.equal(textOn(null), 0xffffff);
  // The average skips transparent pixels: Beck's lime art under its list.
  const data = new Uint8ClampedArray([175, 229, 2, 255, 175, 229, 4, 255, 0, 0, 0, 0]);
  assert.equal(average(data), 0xafe503);
  assert.equal(average(new Uint8ClampedArray(8)), null);
});
