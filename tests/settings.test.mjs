// Run with `npm test`. Saved settings: what a restart keeps.
import assert from "node:assert/strict";
import { test } from "node:test";
import { loadSettings } from "../src/settings.ts";

test("a saved mute is dropped; the volume is kept", () => {
  const s = loadSettings(JSON.stringify({ volume: 0.5, mute: true }));
  assert.equal(s.volume, 0.5);
  assert.equal(s.mute, false);
});

test("a missing or broken entry gives the defaults", () => {
  for (const text of [null, "not json"]) assert.deepEqual(loadSettings(text), { volume: 0.8, mute: false, balance: 0, eq: Array(10).fill(0) });
});
