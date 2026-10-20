// The listener's saved settings, read from the trusted page's localStorage.

export const BANDS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];

export const clamp = (v: unknown, lo: number, hi: number, fallback: number) =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;

/** Volume, balance and EQ survive a restart. Mute does not: the app always
 * opens unmuted (ATA-196), and the channel always opens on NTS 1. */
export function loadSettings(text: string | null) {
  let saved: Record<string, unknown> = {};
  try {
    saved = JSON.parse(text ?? "{}") ?? {};
  } catch {
    // A broken entry falls back to the defaults.
  }
  const savedEq = Array.isArray(saved.eq) ? saved.eq : [];
  return {
    volume: clamp(saved.volume, 0, 1, 0.8),
    mute: false,
    balance: clamp(saved.balance, -1, 1, 0),
    eq: BANDS.map((_, i) => clamp(savedEq[i], -15, 15, 0)),
  };
}
