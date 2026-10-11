// The house skin: the committed house.wmz is what its sources build, and
// every image its .wms names is in it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { files, showLayers } from "../skins/house/build.mjs";
import { unzip } from "../src/skin/wmz.ts";
import { decode, parse } from "../src/skin/wms.ts";

const committed = () => unzip(new Uint8Array(readFileSync(new URL("../skins/house/house.wmz", import.meta.url))));

test("house.wmz matches its sources (run npm run build:house)", async () => {
  const built = files();
  const wmz = await committed();
  assert.deepEqual([...wmz.keys()], built.map(([name]) => name));
  for (const [name, bytes] of built) assert.ok(Buffer.from(wmz.get(name)).equals(bytes), `${name} differs`);
});

test("every image the .wms names is in the skin, and every bitmap is used", async () => {
  const wmz = await committed();
  const named = new Set();
  const walk = (node) => {
    for (const v of Object.values(node.attrs)) if (/\.bmp$/i.test(v)) named.add(v.toLowerCase());
    node.children.forEach(walk);
  };
  walk(parse(decode(wmz.get("house.wms"))));
  const bitmaps = [...wmz.keys()].filter((n) => n.endsWith(".bmp"));
  assert.deepEqual([...named].sort(), bitmaps.sort());
});

test("showLayers hides the layers not asked for and refuses unknown ones", () => {
  const svg = '<svg><g inkscape:groupmode="layer" id="key"/><g inkscape:groupmode="layer" id="up"/><g inkscape:groupmode="layer" id="down"/></svg>';
  assert.equal(showLayers(svg, ["up"]), '<svg><g inkscape:groupmode="layer" id="key"/><g inkscape:groupmode="layer" id="up"/><g style="display:none" inkscape:groupmode="layer" id="down"/></svg>');
  assert.equal(showLayers(svg, []), svg);
  const styled = '<svg><g inkscape:groupmode="layer" id="key"/><g style="display:inline" inkscape:groupmode="layer" id="up"/></svg>';
  assert.equal(showLayers(styled, ["key"]), '<svg><g inkscape:groupmode="layer" id="key"/><g style="display:none" inkscape:groupmode="layer" id="up"/></svg>');
  // As Inkscape saves it while showing another layer: the one asked for is shown anyway.
  const saved = '<svg><g style="display:none" inkscape:groupmode="layer" id="key"/><g style="display:none" inkscape:groupmode="layer" id="up"/></svg>';
  assert.equal(showLayers(saved, ["up"]), '<svg><g inkscape:groupmode="layer" id="key"/><g inkscape:groupmode="layer" id="up"/></svg>');
  assert.equal(showLayers(saved, []), '<svg><g inkscape:groupmode="layer" id="key"/><g inkscape:groupmode="layer" id="up"/></svg>', "all layers means all, whatever was saved");
  // Opacity and blend mode, which Inkscape saves beside the visibility, survive.
  const faded = '<svg><g inkscape:groupmode="layer" id="key"/><g style="display:inline;opacity:0.3;mix-blend-mode:multiply" inkscape:groupmode="layer" id="up"/></svg>';
  assert.equal(showLayers(faded, ["up"]), '<svg><g inkscape:groupmode="layer" id="key"/><g style="opacity:0.3;mix-blend-mode:multiply" inkscape:groupmode="layer" id="up"/></svg>');
  assert.throws(() => showLayers(svg, ["hover"]), /no layer "hover"/);
});
