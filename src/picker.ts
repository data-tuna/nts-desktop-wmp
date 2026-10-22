// The skin picker: our own page, listing the skins skins/compatible.json
// marks as working. It names skins and never runs their code (ATA-112):
// the selected skin's preview is the preview webview, which Rust lays over
// the #preview pane (ATA-193).
import { invoke } from "@tauri-apps/api/core";

type SkinList = {
  skins: { path: string; page: string; size: number; cached: boolean; broken: boolean }[];
  // The local library (ATA-220, ATA-239): no page, always on disk.
  local: SkinList["skins"];
  choice: string | null;
  worn: string | null;
  fetching: boolean;
};

const list = document.getElementById("skins")!;
const localList = document.getElementById("local")!;
const source = document.getElementById("source") as HTMLSelectElement;
const random = document.getElementById("random") as HTMLInputElement;
const status = document.getElementById("status")!;
const preview = document.getElementById("preview")!;
const use = document.getElementById("use") as HTMLButtonElement;
const folder = document.getElementById("folder") as HTMLButtonElement;

const name = (path: string) => path.split("/").pop()!.replace(/\.wmz$/i, "");
const mb = (bytes: number) => `${(bytes / 1e6).toFixed(1)} MB`;
const rows = new Map<string, { li: HTMLLIElement; button: HTMLButtonElement; link: HTMLAnchorElement }>();
let busy = false;
// Why the last pick did not take, until the next one.
let failed = "";
let selected: string | null = null;

function rowsFor(skins: SkinList["skins"]) {
  return skins.map((skin) => {
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
    link.className = "size";
    if (skin.page) {
      link.href = skin.page;
      link.dataset.link = "";
    }
    if (skin.broken) link.textContent = "broken: not a zip";
    li.append(button, from, link);
    rows.set(skin.path, { li, button, link });
    return li;
  });
}

function build({ skins, local }: SkinList) {
  list.replaceChildren(...rowsFor(skins));
  buildLocal(local);
}

let localKey = "";
function buildLocal(local: SkinList["local"]) {
  localKey = JSON.stringify(local.map((s) => [s.path, s.broken]));
  const hint = document.createElement("li");
  hint.className = "hint";
  hint.textContent = "No skins yet. Click “Open skins folder…” and drop .wmz files in.";
  localList.replaceChildren(...(local.length ? rowsFor(local) : [hint]));
  source.options[1].textContent = `Local library (${local.length})`;
}

/** Shows one menu: archive.org's working skins, or the local library. */
function show(menu: string) {
  source.value = menu;
  list.hidden = menu !== "archive";
  localList.hidden = menu !== "local";
}

/** Brings the list in line with the app: what is worn, kept and cached. */
async function refresh() {
  const state = await invoke<SkinList>("list_skins");
  if (!rows.size) {
    build(state);
    show(state.worn?.startsWith("local/") ? "local" : "archive");
  }
  // Skins dropped into the folder, taken out or replaced while the picker is open.
  if (JSON.stringify(state.local.map((s) => [s.path, s.broken])) !== localKey) buildLocal(state.local);
  const { choice, worn, fetching } = state;
  random.checked = choice === null;
  random.disabled = busy;
  use.disabled = busy || !selected;
  if (!busy) status.textContent = failed || (fetching ? "Loading a skin…" : `Wearing ${worn ? name(worn) : "the house skin"}.${!choice ? "" : choice === worn ? " It stays on every launch." : ` ${name(choice)} is tried again next launch.`}`);
  for (const skin of [...state.skins, ...state.local]) {
    const row = rows.get(skin.path);
    if (!row) continue;
    row.li.setAttribute("aria-current", String(skin.path === worn));
    row.button.className = skin.path === choice ? "chosen" : "";
    row.button.disabled = busy;
    row.li.classList.toggle("selected", skin.path === selected);
    if (!skin.page) continue;
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
  document.querySelector('[aria-current="true"]')?.scrollIntoView({ block: "center" });
}

/** Shows a skin in the preview pane, downloading it if it is not cached. */
async function select(path: string) {
  // A click on the selected skin tries again only after "No preview".
  if (path === selected && preview.textContent !== "No preview") return;
  selected = path;
  use.disabled = busy;
  for (const [p, row] of rows) row.li.classList.toggle("selected", p === path);
  preview.textContent = "Loading…";
  const shown = await invoke("preview_skin", { path }).then(
    () => true,
    () => false,
  );
  if (selected === path) preview.textContent = shown ? "" : "No preview";
  // The row of a skin the preview downloaded now says so.
  if (!busy) void refresh();
}

// Rust keeps the preview webview over the pane, wherever the layout puts it.
// The pane keeps its width when the window widens, but <main> does not.
new ResizeObserver(() => {
  const { x, y, width, height } = preview.getBoundingClientRect();
  void invoke("preview_area", { x, y, width, height });
}).observe(document.querySelector("main")!);
use.addEventListener("click", () => selected && void choose(selected, name(selected)));
source.addEventListener("change", () => show(source.value));
folder.addEventListener("click", () => void invoke("open_skins_folder"));
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
void refresh().then(() => document.querySelector('[aria-current="true"]')?.scrollIntoView({ block: "center" }));
