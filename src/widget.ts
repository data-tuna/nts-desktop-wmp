// NTS Picks play through SoundCloud's embed widget, out of sight in the
// trusted page, as nts.live and the Winamp app play them. Never through
// `/api/v2/resolve-stream`. The widget's audio does not pass through our Web
// Audio graph (it is another origin's frame), so the EQ, balance and the
// visualiser's level do not follow a pick; volume and mute do.
// Adapted from nts-desktop-winamp's src/picks.ts at bdc0f10, which drives
// Webamp's media layer instead of player.ts.
import type { Widget } from "./player";

const WIDGET = "https://w.soundcloud.com/player/";
const WIDGET_ORIGIN = "https://w.soundcloud.com";
// A pick asked to play that has not started by then is given up on.
const START_TIMEOUT_MS = 15_000;

type Events = {
  /** The pick played to its end. */
  finish(): void;
  /** Unreachable, removed, blocked, or not started in time. */
  error(reason: unknown): void;
  /** The widget paused or played by itself (Windows' media overlay reaches it directly). */
  paused(): void;
  resumed(): void;
  /** The uploader's SoundCloud name, once the pick has loaded. */
  uploader(url: string, name: string): void;
};

export function createWidget(on: Events): Widget & { setVolume(volume: number): void } {
  const frame = document.createElement("iframe");
  frame.title = "SoundCloud player";
  frame.allow = "autoplay";
  frame.tabIndex = -1;
  frame.setAttribute("aria-hidden", "true");
  frame.style.display = "none";
  document.body.append(frame);

  let url = "";
  let ready = false;
  let playing = false;
  let wanted = false;
  // Pauses we sent that the widget has not answered yet: their "pause" events are not the widget's own.
  let echoes = 0;
  let time = 0;
  // The pick's length in seconds; 0 until the widget tells us.
  let duration = 0;
  let volume = 100;
  let startTimer: ReturnType<typeof setTimeout> | undefined;

  const send = (method: string, value?: unknown) => frame.contentWindow?.postMessage(JSON.stringify({ method, value }), WIDGET_ORIGIN);
  const started = () => {
    clearTimeout(startTimer);
    startTimer = undefined;
  };
  const expectStart = () => {
    started();
    startTimer = setTimeout(() => giveUp("timeout"), START_TIMEOUT_MS);
  };
  const giveUp = (reason: unknown) => {
    started();
    if (!url) return;
    console.warn("SoundCloud widget gave up", url, reason);
    wanted = false;
    // Play loads it again from the start.
    widget.unload();
    on.error(reason);
  };

  window.addEventListener("message", (event) => {
    if (event.origin !== WIDGET_ORIGIN || event.source !== frame.contentWindow || !url) return;
    let message: { method?: string; value?: unknown };
    try {
      message = JSON.parse(String(event.data));
    } catch {
      return;
    }
    // The frame keeps its window across src changes, so the previous pick's
    // page can still talk after a switch. The new page always sends ready first.
    if (!ready && message.method !== "ready") return;
    const value = message.value as Record<string, unknown> | undefined;
    switch (message.method) {
      case "ready":
        ready = true;
        for (const name of ["playProgress", "play", "pause", "finish", "error"]) send("addEventListener", name);
        send("setVolume", volume);
        send("getCurrentSound");
        send("getDuration");
        if (wanted) send("play");
        break;
      case "getCurrentSound": {
        const user = (value?.user as { username?: unknown } | undefined)?.username;
        if (typeof user === "string" && user.trim()) on.uploader(url, user.trim());
        break;
      }
      case "getDuration":
        duration = Number(value) / 1000 || 0;
        break;
      case "playProgress":
        time = Number(value?.currentPosition) / 1000 || 0;
        break;
      case "play":
        started();
        playing = true;
        // Some sounds report 0 until they start.
        if (!duration) send("getDuration");
        if (!wanted) {
          wanted = true;
          on.resumed();
        }
        break;
      case "pause":
        playing = false;
        if (echoes > 0) echoes--;
        else if (wanted) {
          wanted = false;
          on.paused();
        }
        break;
      case "finish":
        playing = wanted = false;
        on.finish();
        break;
      case "error":
        giveUp(value);
        break;
    }
  });

  const widget = {
    play(next: string) {
      wanted = true;
      if (next === url && ready) {
        // The widget toggles on "play": never send it to a pick that plays and stays playing.
        if (playing && echoes === 0) return started();
        expectStart();
        send("play");
        return;
      }
      expectStart();
      url = next;
      ready = playing = false;
      echoes = 0;
      time = duration = 0;
      frame.src = `${WIDGET}?url=${encodeURIComponent(url)}&auto_play=false&visual=false`;
    },
    pause() {
      started();
      wanted = false;
      if (playing) echoes++;
      send("pause");
    },
    stop() {
      widget.pause();
      send("seekTo", 0);
      time = 0;
    },
    seek(seconds: number) {
      if (!ready || !duration) return;
      time = Math.min(duration, Math.max(0, seconds));
      send("seekTo", Math.round(time * 1000));
    },
    unload() {
      started();
      if (!url) return;
      url = "";
      ready = playing = wanted = false;
      echoes = 0;
      time = duration = 0;
      // Removing the src attribute would leave the widget's page running, and playing.
      frame.src = "about:blank";
    },
    get playing() {
      return playing;
    },
    get time() {
      return time;
    },
    get duration() {
      return duration;
    },
    /** 0..1, mute included. */
    setVolume(v: number) {
      volume = Math.round(v * 100);
      send("setVolume", volume);
    },
  };
  return widget;
}
