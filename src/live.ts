// The NTS live API: undocumented, no key, and free to change or vanish.
// Nothing here may throw into playback; see AGENTS.md, Invariants.
// Copied from nts-desktop-winamp's src/live.ts at 6379c0e (PR #9, which
// exports `text`); fix a bug in both copies. Since then this copy also keeps
// the show and the location apart (`show`, `location`), for WMP's item info,
// and reads the show's alias for the tray's link to its page (ATA-172).

export const LIVE_API = "https://www.nts.live/api/v2/live";

/** What is on one channel, as far as the API says. */
export type OnAir = {
  /**
   * `<show> - <location>`, or just the show when the API has no location.
   * A hyphen, not an em dash: Winamp's bitmap font has no `—`.
   */
  title: string;
  show: string;
  location?: string;
  artwork?: string;
  /** `details.show_alias`: the show's page is `/shows/<alias>` on nts.live. */
  showAlias?: string;
  /** Epoch ms; undefined when the API's timestamp does not parse. */
  endsAt?: number;
  next?: { title: string; startsAt?: number };
};

/**
 * Fetch and parse the live API. Index 0 is NTS 1 and 1 is NTS 2; a channel
 * missing from the response, or not shaped as expected, is undefined.
 */
export async function fetchLive(): Promise<(OnAir | undefined)[]> {
  // The API sends `max-age=900` and its CDN honours it, so a bare request can
  // be 15 minutes stale at a show change. A per-minute query string gets a
  // fresh answer while clients in the same minute still share one.
  const minute = Math.floor(Date.now() / 60_000);
  const response = await fetch(`${LIVE_API}?m=${minute}`, {
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`NTS live API: HTTP ${response.status}`);
  return parseLive(await response.json());
}

// Ask again this often, and a few seconds after the current show ends.
const POLL_MS = 2 * 60_000;
const END_GRACE_MS = 5_000;

/**
 * Each channel's latest answer; where the API gave none (a failed request,
 * a changed shape), a known show keeps its title until it is due to end.
 */
export function mergeOnAir(
  kept: (OnAir | undefined)[],
  fresh: (OnAir | undefined)[],
  channels: number,
  now: number,
): (OnAir | undefined)[] {
  return Array.from({ length: channels }, (_, channel) => {
    const old = kept[channel];
    return fresh[channel] ?? (old?.endsAt !== undefined && old.endsAt > now ? old : undefined);
  });
}

/** Milliseconds until the next request. */
export function nextPollDelay(onAir: (OnAir | undefined)[], now: number): number {
  const ends = onAir.flatMap((show) => (show?.endsAt === undefined ? [] : [show.endsAt - now]));
  // The API still says a show is on after its end time: ask again just after
  // the next minute starts, when fetchLive's query string changes.
  if (ends.some((left) => left <= 0)) return 61_000 - (now % 60_000);
  return Math.min(POLL_MS, ...ends.map((left) => left + END_GRACE_MS));
}

export function parseLive(body: unknown): (OnAir | undefined)[] {
  const results = (body as { results?: unknown } | null)?.results;
  const list = Array.isArray(results) ? (results as Record<string, unknown>[]) : [];
  return ["1", "2"].map((channel) => {
    const result = list.find((entry) => entry?.channel_name === channel);
    const show = asBroadcast(result?.now);
    if (!show) return undefined;
    const details = show.embeds?.details;
    const location = text(details?.location_long);
    const next = asBroadcast(result?.next);
    return {
      title: location ? `${show.title} - ${location}` : show.title,
      show: show.title,
      location,
      artwork: url(details?.media?.picture_small),
      showAlias: text(details?.show_alias),
      endsAt: time(show.end_timestamp),
      next: next && { title: next.title, startsAt: time(next.start_timestamp) },
    };
  });
}

type Broadcast = {
  title: string;
  start_timestamp?: unknown;
  end_timestamp?: unknown;
  embeds?: { details?: { location_long?: unknown; media?: { picture_small?: unknown }; show_alias?: unknown } | null };
};

function asBroadcast(value: unknown): Broadcast | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const title = text((value as { broadcast_title?: unknown }).broadcast_title);
  return title ? { ...(value as Omit<Broadcast, "title">), title } : undefined;
}

/** A non-blank string, trimmed and entity-decoded; anything else is undefined. */
export function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? decodeEntities(value.trim()) : undefined;
}

function url(value: unknown): string | undefined {
  return typeof value === "string" && value.startsWith("https://") ? value : undefined;
}

function time(value: unknown): number | undefined {
  const ms = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? ms : undefined;
}

const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/**
 * `broadcast_title` arrives HTML-escaped ("CHEB MIMO &amp; NIHAL").
 * ponytail: numeric entities and the six above only; any other named entity
 * stays as written. Switch to DOMParser if one turns up in a title.
 */
export function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (entity, name: string) => {
    if (name[0] !== "#") return NAMED[name.toLowerCase()] ?? entity;
    const code = name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
  });
}
