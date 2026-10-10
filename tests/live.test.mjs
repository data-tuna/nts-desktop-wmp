// Run with `npm test`. Node strips the TypeScript types itself (22.18+).
// Copied from nts-desktop-winamp with its fixture; keep the two in step.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { decodeEntities, mergeOnAir, nextPollDelay, parseLive } from "../src/live.ts";

// A real /api/v2/live response from 2026-10-09, trimmed to the fields read.
const fixture = JSON.parse(readFileSync(new URL("live-fixture.json", import.meta.url), "utf8"));

test("titles, locations, artwork, end times and next shows", () => {
  const [nts1, nts2] = parseLive(fixture);
  assert.equal(nts1.title, "THE NTS BREAKFAST SHOW w/ CHEB MIMO & NIHAL - London");
  assert.equal(nts1.endsAt, Date.parse("2026-10-09T10:00:00Z"));
  assert.match(nts1.artwork, /^https:\/\/media3\.ntslive\.co\.uk\/resize\/200x200\//);
  assert.deepEqual(nts1.next, { title: "SOUP TO NUTS w/ ARCHITECT", startsAt: Date.parse("2026-10-09T10:00:00Z") });
  assert.equal(nts2.title, "The weirdness of dancing w/ JULES FRANCIS - Paris");
});

test("a show with no location or artwork keeps its title", () => {
  const body = { results: [{ channel_name: "2", now: { broadcast_title: "In Focus", embeds: { details: null } } }] };
  assert.deepEqual(parseLive(body), [undefined, { title: "In Focus", artwork: undefined, endsAt: undefined, next: undefined }]);
});

test("anything not shaped like the API gives no shows", () => {
  for (const body of [null, "", [], {}, { results: {} }, { results: [null, { channel_name: "1", now: { broadcast_title: 3 } }] }]) {
    assert.deepEqual(parseLive(body), [undefined, undefined]);
  }
});

test("HTML entities", () => {
  assert.equal(decodeEntities("A &amp; B &#39;C&#x27; &quot;D&quot; &lt;3"), "A & B 'C' \"D\" <3");
  assert.equal(decodeEntities("&eacute; &#0; &bogus"), "&eacute; &#0; &bogus");
});

const now = Date.parse("2026-10-09T09:59:30Z");
const show = (title, endsAt) => ({ title, endsAt });

test("a failed request keeps a show that has not ended, and drops one that has", () => {
  const kept = [show("A", now + 60_000), show("B", now - 1)];
  assert.deepEqual(mergeOnAir(kept, [], 2, now), [kept[0], undefined]);
  assert.deepEqual(mergeOnAir([show("A")], [], 2, now), [undefined, undefined]);
  assert.deepEqual(mergeOnAir(kept, [show("C", now + 1)], 2, now), [show("C", now + 1), undefined]);
});

test("next request: end + 5 s, capped at 2 min; a stale answer waits for the next minute", () => {
  assert.equal(nextPollDelay([show("A", now + 30_000), show("B", now + 3_600_000)], now), 35_000);
  assert.equal(nextPollDelay([show("A", now + 3_600_000)], now), 120_000);
  assert.equal(nextPollDelay([show("A"), undefined], now), 120_000);
  assert.equal(nextPollDelay([], now), 120_000);
  // 09:59:30 with a show past its end: ask at 10:00:01.
  assert.equal(nextPollDelay([show("A", now - 1), show("B", now + 30_000)], now), 31_000);
  for (let second = 0; second < 60; second++) {
    const delay = nextPollDelay([show("A", 0)], now + second * 1000);
    assert.ok(delay >= 1_000 && delay <= 61_000, `${delay}`);
  }
});
