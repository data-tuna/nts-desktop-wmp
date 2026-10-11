// Rebuilds house.wmz, the skin that ships with the app, from house.wms and
// the layered SVGs in art/. Each bitmap is one SVG rendered with some of its
// layers shown: the key colour (#FF00FF) plus the layers named below.
//
//   npm run build:house
//
// The same sources give the same files (the zip bytes may differ with
// Node's zlib), and tests/house.test.mjs checks that the files in the
// committed house.wmz match what its sources build.
import { Resvg } from "@resvg/resvg-js";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { crc32, deflateRawSync } from "node:zlib";

const dir = new URL(".", import.meta.url);

/** Each bitmap: its SVG and the layers it shows. No layers: all of them. */
const BITMAPS = {
  "body.bmp": ["body.svg"],
  "dial.bmp": ["dial.svg", "mask"],
  "gloss.bmp": ["dial.svg", "gloss"],
  "transport.bmp": ["transport.svg", "up"],
  "transport_hover.bmp": ["transport.svg", "hover"],
  "transport_down.bmp": ["transport.svg", "down"],
  "transport_off.bmp": ["transport.svg", "disabled"],
  "transport_map.bmp": ["transport.svg", "map"],
  "play.bmp": ["playpause.svg", "play-up"],
  "play_hover.bmp": ["playpause.svg", "play-hover"],
  "play_down.bmp": ["playpause.svg", "play-down"],
  "pause.bmp": ["playpause.svg", "pause-up"],
  "pause_hover.bmp": ["playpause.svg", "pause-hover"],
  "pause_down.bmp": ["playpause.svg", "pause-down"],
  "volume.bmp": ["volume.svg", "track"],
  "volume_fill.bmp": ["volume.svg", "fill"],
  "thumb.bmp": ["thumb.svg", "up"],
  "thumb_hover.bmp": ["thumb.svg", "hover"],
  "thumb_down.bmp": ["thumb.svg", "down"],
};

/** The SVG with every Inkscape layer not in `layers` (or "key") hidden. */
export function showLayers(svg, layers) {
  const shown = new Set(["key", ...layers]);
  const found = new Set();
  const out = svg.replace(/<g\b[^>]*\binkscape:groupmode="layer"[^>]*>/g, (tag) => {
    const id = /\bid="([^"]+)"/.exec(tag)?.[1];
    found.add(id);
    // Inkscape may have written its own style (display:inline): replace it.
    return !layers.length || shown.has(id) ? tag : tag.replace(/\sstyle="[^"]*"/, "").replace("<g", '<g style="display:none"');
  });
  for (const id of shown) if (!found.has(id)) throw new Error(`no layer "${id}"`);
  return out;
}

/** A 24-bit bottom-up BMP. Every pixel must be opaque: transparency in a
 * skin is the key colour, never alpha. */
function bmp(width, height, rgba) {
  const stride = Math.ceil((width * 3) / 4) * 4;
  const out = Buffer.alloc(54 + stride * height);
  out.write("BM", 0);
  out.writeUInt32LE(out.length, 2);
  out.writeUInt32LE(54, 10);
  out.writeUInt32LE(40, 14);
  out.writeInt32LE(width, 18);
  out.writeInt32LE(height, 22);
  out.writeUInt16LE(1, 26);
  out.writeUInt16LE(24, 28);
  out.writeUInt32LE(stride * height, 34);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (rgba[i + 3] !== 255) throw new Error(`pixel ${x},${y} is not opaque`);
      const o = 54 + (height - 1 - y) * stride + x * 3;
      out[o] = rgba[i + 2];
      out[o + 1] = rgba[i + 1];
      out[o + 2] = rgba[i];
    }
  return out;
}

/** The skin's files, in zip order: the .wms, then the bitmaps. */
export function files() {
  const read = (name) => readFileSync(new URL(name, dir), "utf8").replace(/\r\n/g, "\n");
  const out = [["house.wms", Buffer.from(read("house.wms"))]];
  for (const [name, [svg, ...layers]] of Object.entries(BITMAPS)) {
    try {
      const img = new Resvg(showLayers(read(`art/${svg}`), layers)).render();
      out.push([name, bmp(img.width, img.height, img.pixels)]);
    } catch (e) {
      throw new Error(`${name} from ${svg}: ${e.message}`);
    }
  }
  return out;
}

/** A deflated zip with fixed timestamps, so the same files give the same bytes. */
export function zip(entries) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const [name, raw] of entries) {
    const data = deflateRawSync(raw, { level: 9 });
    const n = Buffer.from(name);
    // Version 2.0, deflate, 1980-01-01 00:00, CRC, sizes, name length.
    const common = Buffer.alloc(26);
    common.writeUInt16LE(20, 0);
    common.writeUInt16LE(8, 4);
    common.writeUInt16LE(0x21, 8);
    common.writeUInt32LE(crc32(raw), 10);
    common.writeUInt32LE(data.length, 14);
    common.writeUInt32LE(raw.length, 18);
    common.writeUInt16LE(n.length, 22);
    const local = Buffer.alloc(4);
    local.writeUInt32LE(0x04034b50);
    const dirEntry = Buffer.alloc(46);
    dirEntry.writeUInt32LE(0x02014b50, 0);
    dirEntry.writeUInt16LE(20, 4);
    common.copy(dirEntry, 6);
    dirEntry.writeUInt32LE(offset, 42);
    parts.push(local, common, n, data);
    central.push(dirEntry, n);
    offset += 30 + n.length + data.length;
  }
  const dirBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(dirBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, dirBytes, end]);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = zip(files());
  writeFileSync(new URL("house.wmz", dir), out);
  console.log(`house.wmz: ${out.length} bytes`);
}
