// What an AnalyserNode computes, for samples that never pass through Web
// Audio: a pick's, which Rust captures from the app's own output (ATA-199).
// The same Blackman window, smoothing and byte scale as the Web Audio spec's
// AnalyserNode, so the visualisations look alike on a stream and a pick.

/** An analyser over `size` samples (a power of two). `frequency` and `time`
 * fill arrays as `getByteFrequencyData` and `getByteTimeDomainData` do. */
export function createAnalyser(size: number, minDecibels: number, maxDecibels: number, smoothing = 0.8) {
  const window = Float64Array.from({ length: size }, (_, n) => 0.42 - 0.5 * Math.cos((2 * Math.PI * n) / size) + 0.08 * Math.cos((4 * Math.PI * n) / size));
  const smoothed = new Float64Array(size / 2);
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  return {
    frequency(pcm: Float32Array, out: Uint8Array) {
      for (let n = 0; n < size; n++) re[n] = pcm[n] * window[n];
      im.fill(0);
      fft(re, im);
      for (let k = 0; k < size / 2; k++) {
        smoothed[k] = smoothing * smoothed[k] + (1 - smoothing) * (Math.hypot(re[k], im[k]) / size);
        const db = 20 * Math.log10(smoothed[k]);
        out[k] = Math.max(0, Math.min(255, Math.floor((255 * (db - minDecibels)) / (maxDecibels - minDecibels))));
      }
    },
    time(pcm: Float32Array, out: Uint8Array) {
      for (let n = 0; n < size; n++) out[n] = Math.max(0, Math.min(255, Math.floor(128 * (pcm[n] + 1))));
    },
  };
}

/** In-place radix-2 FFT. */
function fft(re: Float64Array, im: Float64Array) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const half = len / 2;
    for (let k = 0; k < half; k++) {
      const wr = Math.cos((-2 * Math.PI * k) / len);
      const wi = Math.sin((-2 * Math.PI * k) / len);
      for (let i = k; i < n; i += len) {
        const xr = re[i + half] * wr - im[i + half] * wi;
        const xi = re[i + half] * wi + im[i + half] * wr;
        re[i + half] = re[i] - xr;
        im[i + half] = im[i] - xi;
        re[i] += xr;
        im[i] += xi;
      }
    }
  }
}
