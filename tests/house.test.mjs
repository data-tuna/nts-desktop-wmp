// The house skin: the committed house.wmz is what its sources build, and
// every image its .wms names is in it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { files, showLayers } from "../skins/house/build.mjs";
import { unzip } from "../src/skin/wmz.ts";
import { decode, parse } from "../src/skin/wms.ts";

const built = files();
const committed = await unzip(new Uint8Array(readFileSync(new URL("../skins/house/house.wmz", import.meta.url))));

test("house.wmz matches its sources (run npm run build:house)", () => {
  assert.deepEqual([...committed.keys()], built.map(([name]) => name));
  for (const [name, bytes] of built) assert.ok(Buffer.from(committed.get(name)).equals(bytes), `${name} differs`);
});

test("every image the .wms names is in the skin, and every bitmap is used", () => {
  const named = new Set();
  const walk = (node) => {
    for (const v of Object.values(node.attrs)) if (/\.bmp$/i.test(v)) named.add(v.toLowerCase());
    node.children.forEach(walk);
  };
  walk(parse(decode(committed.get("house.wms"))));
  const bitmaps = [...committed.keys()].filter((n) => n.endsWith(".bmp"));
  assert.deepEqual([...named].sort(), bitmaps.sort());
});

test("showLayers hides the layers not asked for and refuses unknown ones", () => {
  const svg = '<svg><g inkscape:groupmode="layer" id="key"/><g inkscape:groupmode="layer" id="up"/><g inkscape:groupmode="layer" id="down"/></svg>';
  assert.equal(showLayers(svg, ["up"]), '<svg><g inkscape:groupmode="layer" id="key"/><g inkscape:groupmode="layer" id="up"/><g style="display:none" inkscape:groupmode="layer" id="down"/></svg>');
  assert.equal(showLayers(svg, []), svg);
  assert.throws(() => showLayers(svg, ["hover"]), /no layer "hover"/);
});
