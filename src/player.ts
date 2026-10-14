// The playlist, and keeping its current item playing. A dropped or stuck
// stream reloads the same item with backoff; it never skips to the next one.
// Pause and stop cancel a pending retry. See AGENTS.md, Invariants.

/** A playlist row. A pick plays through `Widget`, everything else through the <audio> element. */
export type Item = { title: string; url: string; pick?: boolean; artwork?: string };

/** What plays a pick (main.ts: SoundCloud's widget). It reports a finish or an error to the caller itself. */
export type Widget = {
  /** Plays `url`: resumes it if it is the one loaded, loads it otherwise. */
  play(url: string): void;
  pause(): void;
  /** Pauses and goes back to the start. */
  stop(): void;
  /** Lets go of the loaded pick. */
  unload(): void;
  /** Jumps to `seconds` into the loaded pick. */
  seek(seconds: number): void;
  readonly playing: boolean;
  readonly time: number;
  /** The loaded pick's page, "" if none. */
  readonly url: string;
  /** The loaded pick's length in seconds, 0 until known. */
  readonly duration: number;
};

export const CHANNELS: Item[] = [
  { title: "NTS 1", url: "https://streams.radiomast.io/nts1" },
  { title: "NTS 2", url: "https://streams.radiomast.io/nts2" },
];

/** A channel's title while the live API names its show: "NTS 1: <show> - <location>".
 * The channel leads, so every skin's title says which one plays (ATA-164). */
export const channelTitle = (channel: string, show: string) => `${channel}: ${show}`;

/** 6 s of silence as an 8 kHz WAV: what the element holds while paused or
 * stopped. WebView2 leaves media shorter than about 5 s out of the session. */
export const silence = (() => {
  let url = "";
  return () => {
    if (url) return url;
    const n = 6 * 8000;
    const wav = new Uint8Array(44 + n).fill(128);
    const v = new DataView(wav.buffer);
    const tag = (at: number, text: string) => [...text].forEach((c, i) => (wav[at + i] = c.charCodeAt(0)));
    tag(0, "RIFF");
    v.setUint32(4, 36 + n, true);
    tag(8, "WAVEfmt ");
    v.setUint32(16, 16, true); // fmt chunk size
    v.setUint16(20, 1, true); // PCM
    v.setUint16(22, 1, true); // mono
    v.setUint32(24, 8000, true); // samples a second
    v.setUint32(28, 8000, true); // bytes a second
    v.setUint16(32, 1, true); // bytes a frame
    v.setUint16(34, 8, true); // bits a sample; 8-bit silence is 128
    tag(36, "data");
    v.setUint32(40, n, true);
    return (url = URL.createObjectURL(new Blob([wav], { type: "audio/wav" })));
  };
})();

// Backoff: 1 s, 2 s, 4 s, then every 8 s until the stream is back.
const RETRY_MIN_MS = 1000;
const RETRY_MAX_MS = 8000;
// A stream that stops delivering often raises no error: the clock just stops.
const STALL_MS = 10_000;

/** WMP's play states, as far as a radio needs them. */
type PlayState = "playing" | "paused" | "stopped" | "buffering" | "reconnecting";

type Media = Pick<
  HTMLMediaElement,
  "src" | "loop" | "currentTime" | "paused" | "readyState" | "play" | "pause" | "load" | "removeAttribute" | "addEventListener"
>;

/** `items` starts with the channels; the caller appends mixtapes and picks to it as they arrive. */
export function createPlayer(audio: Media, items: Item[] = [...CHANNELS], widget?: Widget) {
  let channel = 0;
  const pick = () => items[channel].pick === true;
  // Next or previous while paused moves the channel but keeps the last pick
  // loaded, so its clock and seeking belong to that pick only.
  const loaded = () => pick() && widget?.url === items[channel].url;
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
  // Drops the stream: before a retry, and while a pick plays.
  const disconnect = () => {
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
  };
  // Pause and stop swap the stream for a silent local clip: removing the src
  // ends WebView2's media session (the Play key and Windows' overlay could no
  // longer reach the app), and a paused stream keeps its connection open.
  // The clip must play for a moment to join the session; a clip that never
  // played does not, and Windows drops the app just the same.
  const hold = () => {
    audio.pause();
    audio.src = silence();
    audio.loop = true;
    audio.play().then(
      () => audio.src === silence() && audio.pause(),
      () => {},
    );
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
    audio.loop = false;
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
    const next = (((Math.trunc(i) || 0) % items.length) + items.length) % items.length;
    // The current item again (a double click on its row): leave it playing.
    if (next === channel && mode === "playing" && timer === undefined) return;
    channel = next;
    if (mode === "playing") start();
  };

  return {
    /** Does nothing while playing; during a retry it reloads now. */
    play() {
      if (mode !== "playing" || timer !== undefined) start();
    },
    /** A pick keeps its place; a stream is reloaded on Play (there is nothing to resume). */
    pause() {
      cancel();
      mode = "paused";
      hold();
      widget?.pause();
    },
    stop() {
      cancel();
      mode = "stopped";
      hold();
      widget?.stop();
    },
    /** Next (1) or previous (-1) item, wrapping around. */
    step: (by: number) => select(channel + by),
    select,
    /** Only a pick can seek; a live stream has nowhere to go. */
    seek(seconds: number) {
      if (loaded()) widget?.seek(seconds);
    },
    state() {
      const playState: PlayState =
        mode !== "playing"
          ? mode
          : timer !== undefined
            ? "reconnecting"
            : (pick() ? !widget?.playing : audio.paused || audio.readyState < 3)
              ? "buffering"
              : "playing";
      // duration 0: live streams have no length and cannot seek (WMP's convention).
      if (loaded()) return { playState, channel, title: items[channel].title, time: widget?.time ?? 0, duration: widget?.duration ?? 0 };
      return { playState, channel, title: items[channel].title, time: pick() ? 0 : audio.currentTime, duration: 0 };
    },
  };
}
