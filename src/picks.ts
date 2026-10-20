// NTS Picks: the latest hand-picked episodes, each a SoundCloud track. The
// app shows no SoundCloud credit or name: Ata's call, 2026-10-20 (ATA-197,
// docs/decisions.md).
// Copied from nts-desktop-winamp's src/picks.ts at bdc0f10, parsing only:
// the Webamp playback stays behind. Fix a bug in both copies. This copy also
// keeps the episode's aliases, for the link to its page (ATA-172, ATA-198).

// The .ts extension lets `node --test` load this file directly.
import { text } from "./live.ts";

// Undocumented, like the live API. One page of 12, once per launch.
export const PICKS_API = "https://www.nts.live/api/v2/collections/nts-picks?offset=0&limit=12";

export type Pick = {
  /** The SoundCloud track page, query string dropped. */
  url: string;
  /** `<name> - <location> (<genres and moods>)` */
  title: string;
  artwork?: string;
  /** The episode's page is `/shows/<showAlias>/episodes/<episodeAlias>` on nts.live. */
  showAlias?: string;
  episodeAlias?: string;
};

export function parsePicks(body: unknown): Pick[] {
  const results = (body as { results?: unknown } | null)?.results;
  if (!Array.isArray(results)) return [];
  return results.flatMap((episode: Record<string, unknown> | null) => {
    const sources = Array.isArray(episode?.audio_sources) ? (episode.audio_sources as { url?: unknown; source?: unknown }[]) : [];
    const source = sources.find((entry) => entry?.source === "soundcloud" && typeof entry.url === "string");
    const url = (source?.url as string | undefined)?.split("?")[0];
    const name = text(episode?.name);
    // ponytail: picks with only a Mixcloud copy are skipped. Every pick had a SoundCloud one on 2026-10-09.
    if (!url?.startsWith("https://soundcloud.com/") || !name) return [];
    const location = text(episode?.location_long);
    const tags = [episode?.genres, episode?.moods].flatMap((list) =>
      Array.isArray(list) ? list.flatMap((tag: { value?: unknown } | null) => text(tag?.value) ?? []) : [],
    );
    const picture = (episode?.media as { picture_small?: unknown } | undefined)?.picture_small;
    return [
      {
        url,
        title: `${name}${location ? ` - ${location}` : ""}${tags.length ? ` (${tags.join(", ")})` : ""}`,
        artwork: typeof picture === "string" && picture.startsWith("https://") ? picture : undefined,
        showAlias: text(episode?.show_alias),
        episodeAlias: text(episode?.episode_alias),
      },
    ];
  });
}

/** The pick's episode page on nts.live, the one the tray's "Show on nts.live"
 * opens (`show_page` in lib.rs), or "" without plain-slug aliases. */
export function episodePage(pick: Pick): string {
  const slug = /^[\w-]{1,200}$/;
  return slug.test(pick.showAlias ?? "") && slug.test(pick.episodeAlias ?? "") ? `https://www.nts.live/shows/${pick.showAlias}/episodes/${pick.episodeAlias}` : "";
}
