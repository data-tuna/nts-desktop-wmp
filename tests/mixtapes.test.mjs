// Run with `npm test`. Node strips the TypeScript types itself (22.18+).
// Copied from nts-desktop-winamp at 6379c0e (PR #9) with its fixture; keep the two in step.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parseMixtapes } from "../src/mixtapes.ts";

// A real /api/v2/mixtapes response from 2026-10-09, trimmed to two mixtapes and the fields read.
const fixture = JSON.parse(readFileSync(new URL("mixtapes-fixture.json", import.meta.url), "utf8"));

test("title and subtitle; the radiomast MP3 stream behind the HLS url, not the geo relay", () => {
  assert.deepEqual(parseMixtapes(fixture), [
    {
      url: "https://streams.radiomast.io/052d2e3c-389c-44cf-a91a-8f5e1854f4c6",
      title: "Poolside - Balearic, boogie, and sophisti-pop for poolsides, beaches and car stereos.",
    },
    {
      url: "https://streams.radiomast.io/dfc76352-cda6-4a95-85dd-6f6609f83ba2",
      title: "Slow Focus - Meditative, relaxing and beatless: ambient, drone and ragas.",
    },
  ]);
});

test("a mixtape with no radiomast stream, or no title, is skipped; bare ones keep their title", () => {
  const hls = "https://streams.radiomast.io/abc-123/hls.m3u8";
  const body = {
    results: [
      { title: "Geo only", audio_stream_endpoint: "https://stream-mixtape-geo.ntslive.net/mixtape9" },
      { title: "Elsewhere", audio_stream_endpoint_hls_mp3: "https://evil.example/abc/hls.m3u8" },
      { title: "AAC", audio_stream_endpoint_hls_mp3: "https://streams.radiomast.io/abc/hls.m3u8?x=1" },
      { title: " ", audio_stream_endpoint_hls_mp3: hls },
      { title: "A &amp; B", subtitle: 3, audio_stream_endpoint_hls_mp3: hls },
    ],
  };
  assert.deepEqual(parseMixtapes(body), [{ url: "https://streams.radiomast.io/abc-123", title: "A & B" }]);
});

test("anything not shaped like the API gives no mixtapes", () => {
  for (const body of [null, "", [], {}, { results: {} }, { results: [null, 3, { audio_stream_endpoint_hls_mp3: {} }] }]) {
    assert.deepEqual(parseMixtapes(body), []);
  }
});

// This copy's own (ATA-200): the picture for Album Art, https only.
test("a mixtape's picture, when it is an https url", () => {
  const hls = "https://streams.radiomast.io/abc-123/hls.m3u8";
  const picture_small = "https://media3.ntslive.co.uk/resize/200x200/a.jpeg";
  const body = {
    results: [
      { title: "A", audio_stream_endpoint_hls_mp3: hls, media: { picture_small } },
      { title: "B", audio_stream_endpoint_hls_mp3: hls, media: { picture_small: "http://media3.ntslive.co.uk/b.jpeg" } },
    ],
  };
  assert.deepEqual(
    parseMixtapes(body).map((m) => m.artwork),
    [picture_small, undefined],
  );
});
