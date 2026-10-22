// macOS only (ATA-236). Given a stream's URL, WebKit's <audio> asks for it
// twice (first for bytes 0-1, as Safari does). Radiomast ignores the range
// and sends the endless stream to both, so every launch held two full-rate
// connections. Here one fetch() feeds a MediaSource, and the element gets
// its object URL instead.

// Seconds of played audio kept behind the playhead.
const KEEP_S = 30;

const updated = (buffer: SourceBuffer) =>
  new Promise((resolve) => buffer.addEventListener("updateend", resolve, { once: true }));

/** A src for `audio` that plays `url` over one connection; `url` itself
 * where MediaSource cannot play MP3. */
export function feed(audio: HTMLMediaElement, url: string): string {
  if (typeof MediaSource === "undefined" || !MediaSource.isTypeSupported("audio/mpeg")) return url;
  const source = new MediaSource();
  const abort = new AbortController();
  const src = URL.createObjectURL(source);
  // The element let go of it: another src, a pause or a reconnect.
  source.addEventListener("sourceclose", () => abort.abort(), { once: true });
  source.addEventListener(
    "sourceopen",
    async () => {
      URL.revokeObjectURL(src);
      try {
        const buffer = source.addSourceBuffer("audio/mpeg");
        // MP3 carries no timestamps: each chunk follows the last.
        buffer.mode = "sequence";
        const response = await fetch(url, { signal: abort.signal });
        if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
        const reader = response.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          const kept = buffer.buffered;
          if (kept.length && audio.currentTime - KEEP_S > kept.start(0)) {
            buffer.remove(0, audio.currentTime - KEEP_S);
            await updated(buffer);
          }
          buffer.appendBuffer(value);
          await updated(buffer);
        }
        // The stream ended: "ended" on the element, and the player reconnects.
        source.endOfStream();
      } catch {
        // A failed fetch or append: "error" on the element, as with a plain src.
        if (source.readyState === "open") source.endOfStream("network");
      }
    },
    { once: true },
  );
  return src;
}
