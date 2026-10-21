// tauri.macos.conf.json is a JSON merge patch: its `windows` array replaces
// the base one whole, so the main window is written twice (ATA-230).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const config = (name) => JSON.parse(readFileSync(new URL(`../src-tauri/${name}`, import.meta.url), "utf8"));

test("the macOS main window is the base one, transparent", () => {
  const [base] = config("tauri.conf.json").app.windows;
  const [mac] = config("tauri.macos.conf.json").app.windows;
  const { additionalBrowserArgs: _, ...shared } = base;
  assert.deepEqual(mac, { ...shared, transparent: true });
});
