// The skin engine's pure parts: unzip, .wms decoding and parsing, and the
// pixel work behind button groups. No skins here: they are never committed,
// so the fixtures are built in the tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import { deflateRawSync } from "node:zlib";
import { unzip } from "../src/skin/wmz.ts";
import { constants, decode, parse } from "../src/skin/wms.ts";
import { keyed, mappedElement, parseColor, runs } from "../src/skin/pixels.ts";

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
  assert.equal(sub.attrs.left, "42", "the first of a repeated attribute wins");
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

test("parseColor reads hex and the colour names skins use", () => {
  assert.equal(parseColor("#FF00FF"), 0xff00ff);
  assert.equal(parseColor("9aacdb"), 0x9aacdb);
  assert.equal(parseColor(" White "), 0xffffff);
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
