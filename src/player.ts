// The channels, and keeping one playing. A dropped or stuck stream reloads the
// same channel with backoff; it never skips to the other one. Pause and stop
// cancel a pending retry. See AGENTS.md, Invariants.

export const CHANNELS = [
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

export function createPlayer(audio: Media) {
  let channel = 0;
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
  const load = () => {
    lastTime = 0;
    movedAt = Date.now();
    audio.src = CHANNELS[channel].url;
    audio.play().catch((e: Error) => {
      // Autoplay refused: wait for the listener's Play rather than retry forever.
      // A failed load fires "error" instead, which reconnects.
      if (e.name === "NotAllowedError") mode = "stopped";
    });
  };
  // A live stream has nothing to resume, so pause drops the connection too.
  const disconnect = () => {
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
  };
  const drop = () => {
    if (mode !== "playing" || timer !== undefined) return;
    console.warn(`${CHANNELS[channel].title} dropped, reconnecting in ${retryMs} ms`);
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
    if (mode !== "playing" || timer !== undefined) movedAt = Date.now();
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

  return {
    /** Does nothing while playing; during a retry it reloads now. */
    play() {
      if (mode !== "playing" || timer !== undefined) start();
    },
    pause() {
      cancel();
      mode = "paused";
      disconnect();
    },
    stop() {
      cancel();
      mode = "stopped";
      disconnect();
    },
    /** Next (1) or previous (-1) channel, wrapping around. */
    step(by: number) {
      channel = (channel + by + CHANNELS.length) % CHANNELS.length;
      if (mode === "playing") start();
    },
    state() {
      const playState: PlayState =
        mode !== "playing"
          ? mode
          : timer !== undefined
            ? "reconnecting"
            : audio.paused || audio.readyState < 3
              ? "buffering"
              : "playing";
      return { playState, channel, title: CHANNELS[channel].title, time: audio.currentTime };
    },
  };
}
