// Only release builds may update themselves (ATA-204): the endpoint lives in
// the config the release workflow passes, never in the one local builds use.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const config = (name) => JSON.parse(readFileSync(new URL(`../src-tauri/${name}`, import.meta.url), "utf8"));

test("only tauri.release.conf.json has the updater endpoint", () => {
  assert.equal(config("tauri.conf.json").plugins.updater.endpoints, undefined);
  assert.deepEqual(config("tauri.release.conf.json").plugins.updater.endpoints, [
    "https://github.com/data-tuna/nts-desktop-wmp/releases/latest/download/latest.json",
  ]);
});
