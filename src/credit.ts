// The pick's credit, "<uploader> on SoundCloud", which the app draws over the
// skin while a pick plays. One click opens the track's SoundCloud page.
import { invoke } from "@tauri-apps/api/core";

const button = document.getElementById("credit")!;
button.addEventListener("click", () => void invoke("open_credit"));

/** Rust calls this when the credit changes; it also runs once on load. */
async function render() {
  button.textContent = `${(await invoke<string | null>("credit")) ?? "SoundCloud"} ↗`;
  await invoke("credit_size", { width: Math.ceil(button.getBoundingClientRect().width) });
}
Object.assign(window, { render });
void render();
