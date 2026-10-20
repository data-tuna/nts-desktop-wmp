// The stand-in for AnalyserNode that a pick's captured samples go through (ATA-199).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createAnalyser } from "../src/analyser.ts";

test("analyser: a tone lands in its bin on the AnalyserNode's dB scale, and samples map to bytes", () => {
  const size = 8192;
  const analyser = createAnalyser(size, -90, -15);
  // Amplitude 0.1, exactly on bin 100: |X|/N = 0.05 * 0.42 (Blackman) = -33.6 dB, so byte 191.
  const pcm = Float32Array.from({ length: size }, (_, n) => 0.1 * Math.sin((2 * Math.PI * 100 * n) / size));
  const out = new Uint8Array(size / 2);
  analyser.frequency(pcm, out);
  assert.ok(out[100] < 191, "smoothed: the first frame is quieter");
  for (let i = 0; i < 60; i++) analyser.frequency(pcm, out);
  assert.deepEqual([...out.subarray(97, 104)], [0, 122, 176, 191, 176, 122, 0], "Blackman's main lobe: 0.42, 0.25, 0.04");
  assert.equal(out.reduce((s, v) => s + v, 0), 176 * 2 + 191 + 122 * 2, "nothing outside it");
  const wave = new Uint8Array(4);
  analyser.time(Float32Array.from([0, 1, -1, 0.5]), wave);
  assert.deepEqual([...wave], [128, 255, 0, 192]);
});
