// NTS Infinite Mixtapes: endless themed streams. They are live MP3 streams
// like NTS 1 and NTS 2, so they play and reconnect the same way.
// Copied from nts-desktop-winamp's src/mixtapes.ts (PR #9), without the
// Webamp playlist code; fix a bug in both copies.

// The .ts extension lets `node --test` load this file directly.
import { text } from "./live.ts";

// Undocumented, like the live API. Once per launch.
const MIXTAPES_API = "https://www.nts.live/api/v2/mixtapes";

// The API's MP3 url (stream-mixtape-geo.ntslive.net) redirects without CORS
// headers, like the channels' relay. Its HLS MP3 url names the same radiomast
// stream, which starts at streams.radiomast.io: drop the `/hls.m3u8`.
const RADIOMAST_HLS = /^(https:\/\/streams\.radiomast\.io\/[\w-]+)\/hls\.m3u8$/;

export type Mixtape = { url: string; title: string };

/** Fetch and parse the mixtapes. Callers treat a failure as no mixtapes. */
export async function fetchMixtapes(): Promise<Mixtape[]> {
  const response = await fetch(MIXTAPES_API, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`NTS mixtapes API: HTTP ${response.status}`);
  return parseMixtapes(await response.json());
}

export function parseMixtapes(body: unknown): Mixtape[] {
  const results = (body as { results?: unknown } | null)?.results;
  if (!Array.isArray(results)) return [];
  return results.flatMap((mixtape: Record<string, unknown> | null) => {
    const hls = mixtape?.audio_stream_endpoint_hls_mp3;
    const url = typeof hls === "string" ? RADIOMAST_HLS.exec(hls)?.[1] : undefined;
    const title = text(mixtape?.title);
    if (!url || !title) return [];
    const subtitle = text(mixtape?.subtitle);
    return [{ url, title: subtitle ? `${title} - ${subtitle}` : title }];
  });
}
