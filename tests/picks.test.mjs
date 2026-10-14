// Run with `npm test`. Node strips the TypeScript types itself (22.18+).
// Copied from nts-desktop-winamp at bdc0f10 with its fixture; keep the two in step.
// The `name` and `tags` checks are this copy's own.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parsePicks } from "../src/picks.ts";

// A real /api/v2/collections/nts-picks response from 2026-10-09, trimmed to two picks and the fields read.
const fixture = JSON.parse(readFileSync(new URL("picks-fixture.json", import.meta.url), "utf8"));

test("name, location and tags; the SoundCloud page without its query string", () => {
  const [first, second] = parsePicks(fixture);
  assert.deepEqual(first, {
    url: "https://soundcloud.com/user-202286394-991268468/buried-light-100-ashtrejinkins",
    title: "Buried Light - 100% AshTreJinkins - Los Angeles (Experimental, Minimal, Beats, Minimal Talkin)",
    name: "Buried Light - 100% AshTreJinkins",
    tags: ["Experimental", "Minimal", "Beats", "Minimal Talkin"],
    artwork: "https://media3.ntslive.co.uk/resize/200x200/70a734c2-b5a5-475a-84e9-35451a1726d6_1791244800.png",
  });
  assert.equal(second.title, "POST-SUMMER DANCE RITUALS W/ JEAN-BAPTISTE DOMINICI - Paris (Electronica, Reggaeton, Arabic Pop)");
});

test("a pick with no SoundCloud copy, or no name, is skipped; bare picks keep their name", () => {
  const sc = [{ source: "soundcloud", url: "https://soundcloud.com/a/b?x=1" }];
  const body = {
    results: [
      { name: "Mixcloud only", audio_sources: [], mixcloud: "https://www.mixcloud.com/x/" },
      { name: "Elsewhere", audio_sources: [{ source: "soundcloud", url: "https://evil.example/b" }] },
      { name: " ", audio_sources: sc },
      { name: "A &amp; B", audio_sources: sc, genres: "nope" },
    ],
  };
  assert.deepEqual(parsePicks(body), [{ url: "https://soundcloud.com/a/b", title: "A & B", name: "A & B", tags: [], artwork: undefined }]);
});

test("anything not shaped like the API gives no picks", () => {
  for (const body of [null, "", [], {}, { results: {} }, { results: [null, 3, { audio_sources: {} }] }]) {
    assert.deepEqual(parsePicks(body), []);
  }
});
