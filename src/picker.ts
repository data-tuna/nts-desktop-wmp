// The skin picker: our own page, listing the skins skins/compatible.json
// marks as working. It names skins and never runs their code (ATA-112):
// the selected skin's preview is the preview webview, which Rust lays over
// the #preview pane (ATA-193).
import { invoke } from "@tauri-apps/api/core";

type SkinList = {
  skins: { path: string; page: string; size: number; cached: boolean }[];
  choice: string | null;
  worn: string | null;
  fetching: boolean;
};

const list = document.getElementById("skins")!;
const random = document.getElementById("random") as HTMLInputElement;
const status = document.getElementById("status")!;
const preview = document.getElementById("preview")!;
const use = document.getElementById("use") as HTMLButtonElement;

const name = (path: string) => path.split("/").pop()!.replace(/\.wmz$/i, "");
const mb = (bytes: number) => `${(bytes / 1e6).toFixed(1)} MB`;
const rows = new Map<string, { li: HTMLLIElement; button: HTMLButtonElement; link: HTMLAnchorElement }>();
let busy = false;
// Why the last pick did not take, until the next one.
let failed = "";
let selected: string | null = null;

function build({ skins }: SkinList) {
  for (const skin of skins) {
    const li = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = name(skin.path);
    button.addEventListener("click", () => void select(skin.path));
    button.addEventListener("dblclick", () => void choose(skin.path, name(skin.path)));
    const from = document.createElement("span");
    from.className = "from";
    from.textContent = skin.path.split("/")[0];
    const link = document.createElement("a");
    link.href = skin.page;
    link.dataset.link = "";
    link.className = "size";
    li.append(button, from, link);
    rows.set(skin.path, { li, button, link });
  }
  list.replaceChildren(...[...rows.values()].map((r) => r.li));
}

/** Brings the list in line with the app: what is worn, kept and cached. */
async function refresh() {
  const state = await invoke<SkinList>("list_skins");
  if (!rows.size) build(state);
  const { choice, worn, fetching } = state;
  random.checked = choice === null;
  random.disabled = busy;
  use.disabled = busy || !selected;
  if (!busy) status.textContent = failed || (fetching ? "Loading a skin…" : `Wearing ${worn ? name(worn) : "the house skin"}.${!choice ? "" : choice === worn ? " It stays on every launch." : ` ${name(choice)} is tried again next launch.`}`);
  for (const skin of state.skins) {
    const row = rows.get(skin.path);
    if (!row) continue;
    row.li.setAttribute("aria-current", String(skin.path === worn));
    row.button.className = skin.path === choice ? "chosen" : "";
    row.button.disabled = busy;
    row.li.classList.toggle("selected", skin.path === selected);
    row.button.title = skin.cached ? "Downloaded" : `Downloads ${mb(skin.size)} from archive.org`;
    row.link.textContent = skin.cached ? "archive.org" : `archive.org, ${mb(skin.size)}`;
  }
}

async function choose(path: string | null, label: string) {
  busy = true;
  failed = "";
  status.textContent = `Loading ${label}…`;
  random.disabled = true;
  use.disabled = true;
  for (const row of rows.values()) row.button.disabled = true;
  await invoke("choose_skin", { path }).catch((e) => (failed = `${label} did not load (${String(e)}), so the house skin is on.`));
  busy = false;
  await refresh();
  list.querySelector('[aria-current="true"]')?.scrollIntoView({ block: "center" });
}

/** Shows a skin in the preview pane, downloading it if it is not cached. */
async function select(path: string) {
  if (path === selected) return;
  selected = path;
  use.disabled = busy;
  for (const [p, row] of rows) row.li.classList.toggle("selected", p === path);
  preview.textContent = "Loading…";
  const shown = await invoke("preview_skin", { path }).then(
    () => true,
    () => false,
  );
  if (selected === path) preview.textContent = shown ? "" : "No preview";
}

// Rust keeps the preview webview over the pane, wherever the layout puts it.
new ResizeObserver(() => {
  const { x, y, width, height } = preview.getBoundingClientRect();
  void invoke("preview_area", { x, y, width, height });
}).observe(preview);
use.addEventListener("click", () => selected && void choose(selected, name(selected)));
random.addEventListener("change", () => void choose(null, "a random skin"));
document.addEventListener("click", (e) => {
  const a = (e.target as HTMLElement).closest<HTMLAnchorElement>("a[data-link]");
  if (!a) return;
  e.preventDefault();
  void invoke("open_link", { url: a.href });
});
// The skin webview may still change: a launch download landing, or a skin
// the engine could not load giving way to the house skin.
setInterval(() => void (busy || refresh()), 2000);
void refresh().then(() => list.querySelector('[aria-current="true"]')?.scrollIntoView({ block: "center" }));
