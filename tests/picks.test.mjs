// Run with `npm test`. Node strips the TypeScript types itself (22.18+).
// Copied from nts-desktop-winamp at bdc0f10 with its fixture; keep the two in step.
// The alias checks are this copy's own.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { episodePage, parsePicks } from "../src/picks.ts";

// A real /api/v2/collections/nts-picks response from 2026-10-09, trimmed to two picks and the fields read.
const fixture = JSON.parse(readFileSync(new URL("picks-fixture.json", import.meta.url), "utf8"));

test("tags, name and location (ATA-208); the SoundCloud page without its query string", () => {
  const [first, second] = parsePicks(fixture);
  assert.deepEqual(first, {
    url: "https://soundcloud.com/user-202286394-991268468/buried-light-100-ashtrejinkins",
    title: "Experimental, Minimal, Beats, Minimal Talkin · Buried Light - 100% AshTreJinkins - Los Angeles",
    artwork: "https://media3.ntslive.co.uk/resize/200x200/70a734c2-b5a5-475a-84e9-35451a1726d6_1791244800.png",
    showAlias: "ashtrejinkins",
    episodeAlias: "ashtrejinkins-7th-october-2026",
  });
  assert.equal(second.showAlias, undefined);
  assert.equal(second.title, "Electronica, Reggaeton, Arabic Pop · POST-SUMMER DANCE RITUALS W/ JEAN-BAPTISTE DOMINICI - Paris");
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
  assert.deepEqual(parsePicks(body), [{ url: "https://soundcloud.com/a/b", title: "A & B", artwork: undefined, showAlias: undefined, episodeAlias: undefined }]);
});

test("anything not shaped like the API gives no picks", () => {
  for (const body of [null, "", [], {}, { results: {} }, { results: [null, 3, { audio_sources: {} }] }]) {
    assert.deepEqual(parsePicks(body), []);
  }
});

test("a pick links to its episode page on nts.live, never SoundCloud (ATA-198)", () => {
  const [first, second] = parsePicks(fixture);
  assert.equal(episodePage(first), "https://www.nts.live/shows/ashtrejinkins/episodes/ashtrejinkins-7th-october-2026");
  // No aliases, or ones that are not plain slugs, give no link, as the tray's does.
  assert.equal(episodePage(second), "");
  assert.equal(episodePage({ url: "", title: "", showAlias: "a/../b", episodeAlias: "c" }), "");
  assert.equal(episodePage({ url: "", title: "", showAlias: "a", episodeAlias: "c?x" }), "");
});
