// Builds the macOS probe skin (ATA-230): the house skin with
// tools/macos/probe.js as its script, showing Bars so the trusted page
// sends analyser frames (ATA-236). Wear it with NTS_WMP_SKIN.
//
//   node tools/macos/probe.mjs <out.wmz>
import { readFileSync, writeFileSync } from "node:fs";
import { files, zip } from "../../skins/house/build.mjs";

const out = files().map(([name, bytes]) =>
  name === "house.wms" ? [name, Buffer.from(bytes.toString().replace('<view id="main"', '<view id="main" scriptFile="probe.js"').replace('<effects id="vis"', '<effects id="vis" currentEffectType="Bars and Waves"'))] : [name, bytes],
);
out.push(["probe.js", readFileSync(new URL("probe.js", import.meta.url))]);
writeFileSync(process.argv[2], zip(out));
