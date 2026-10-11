// The playlist, and keeping its current item playing. A dropped or stuck
// stream reloads the same item with backoff; it never skips to the next one.
// Pause and stop cancel a pending retry. See AGENTS.md, Invariants.

/** A playlist row. A pick plays through `Widget`, everything else through the <audio> element. */
export type Item = { title: string; url: string; pick?: boolean };

/** What plays a pick (main.ts: SoundCloud's widget). It reports a finish or an error to the caller itself. */
export type Widget = {
  /** Plays `url`: resumes it if it is the one loaded, loads it otherwise. */
  play(url: string): void;
  pause(): void;
  /** Pauses and goes back to the start. */
  stop(): void;
  /** Lets go of the loaded pick. */
  unload(): void;
  readonly playing: boolean;
  readonly time: number;
};

export const CHANNELS: Item[] = [
  { title: "NTS 1", url: "https://streams.radiomast.io/nts1" },
  { title: "NTS 2", url: "https://streams.radiomast.io/nts2" },
];

// Backoff: 1 s, 2 s, 4 s, then every 8 s until the stream is back.
const RETRY_MIN_MS = 1000;
const RETRY_MAX_MS = 8000;
// A stream that stops delivering often raises no error: the clock just stops.
const STALL_MS = 10_000;

/** WMP's play states, as far as a radio needs them. */
type PlayState = "playing" | "paused" | "stopped" | "buffering" | "reconnecting";

type Media = Pick<
  HTMLMediaElement,
  "src" | "currentTime" | "paused" | "readyState" | "play" | "pause" | "load" | "removeAttribute" | "addEventListener"
>;

/** `items` starts with the channels; the caller appends mixtapes and picks to it as they arrive. */
export function createPlayer(audio: Media, items: Item[] = [...CHANNELS], widget?: Widget) {
  let channel = 0;
  const pick = () => items[channel].pick === true;
  // What the listener asked for; the element may disagree while it reconnects.
  let mode: "playing" | "paused" | "stopped" = "stopped";
  let retryMs = RETRY_MIN_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastTime = 0;
  let movedAt = Date.now();

  const cancel = () => {
    clearTimeout(timer);
    timer = undefined;
  };
  // A live stream has nothing to resume, so pause drops the connection too.
  const disconnect = () => {
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
  };
  const load = () => {
    lastTime = 0;
    movedAt = Date.now();
    if (pick()) {
      disconnect();
      widget?.play(items[channel].url);
      return;
    }
    widget?.unload();
    audio.src = items[channel].url;
    audio.play().catch((e: Error) => {
      // Autoplay refused: wait for the listener's Play rather than retry forever.
      // A failed load fires "error" instead, which reconnects.
      if (e.name === "NotAllowedError") mode = "stopped";
    });
  };
  const drop = () => {
    // A pick's errors come from the widget, which stops the player.
    if (mode !== "playing" || timer !== undefined || pick()) return;
    console.warn(`${items[channel].title} dropped, reconnecting in ${retryMs} ms`);
    disconnect();
    timer = setTimeout(() => {
      timer = undefined;
      load();
    }, retryMs);
    retryMs = Math.min(retryMs * 2, RETRY_MAX_MS);
  };

  // Live streams never end on purpose.
  audio.addEventListener("error", drop);
  audio.addEventListener("ended", drop);
  setInterval(() => {
    const moved = audio.currentTime !== lastTime;
    lastTime = audio.currentTime;
    // ponytail: a stuck pick is left alone, as in the Winamp app: reloading it would start a two-hour mix over.
    if (mode !== "playing" || timer !== undefined || pick()) movedAt = Date.now();
    else if (moved) {
      // Playing again: the next drop starts a fresh backoff.
      retryMs = RETRY_MIN_MS;
      movedAt = Date.now();
    } else if (Date.now() - movedAt >= STALL_MS) drop();
  }, 1000);

  const start = () => {
    cancel();
    retryMs = RETRY_MIN_MS;
    mode = "playing";
    load();
  };

  /** Item `i`, wrapping around; it plays if the player was playing. */
  const select = (i: number) => {
    channel = (((Math.trunc(i) || 0) % items.length) + items.length) % items.length;
    if (mode === "playing") start();
  };

  return {
    /** Does nothing while playing; during a retry it reloads now. */
    play() {
      if (mode !== "playing" || timer !== undefined) start();
    },
    /** A pick keeps its place; a stream is dropped (there is nothing to resume). */
    pause() {
      cancel();
      mode = "paused";
      disconnect();
      widget?.pause();
    },
    stop() {
      cancel();
      mode = "stopped";
      disconnect();
      widget?.stop();
    },
    /** Next (1) or previous (-1) item, wrapping around. */
    step: (by: number) => select(channel + by),
    select,
    state() {
      const playState: PlayState =
        mode !== "playing"
          ? mode
          : timer !== undefined
            ? "reconnecting"
            : (pick() ? !widget?.playing : audio.paused || audio.readyState < 3)
              ? "buffering"
              : "playing";
      return { playState, channel, title: items[channel].title, time: pick() ? (widget?.time ?? 0) : audio.currentTime };
    },
  };
}
