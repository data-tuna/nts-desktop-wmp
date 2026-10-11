// The skin picker: our own page, listing the skins skins/compatible.json
// marks as working. It names skins and never runs their code (ATA-112).
import { invoke } from "@tauri-apps/api/core";

type SkinList = { skins: { path: string; size: number; cached: boolean }[]; choice: string | null; worn: string | null };

const list = document.getElementById("skins")!;
const random = document.getElementById("random") as HTMLInputElement;
const status = document.getElementById("status")!;

const name = (path: string) => path.split("/").pop()!.replace(/\.wmz$/i, "");
const page = (path: string) => `https://archive.org/details/windowsmediaplayerskinsarchive/${path.split("/").map(encodeURIComponent).join("/")}`;
const mb = (bytes: number) => `${(bytes / 1e6).toFixed(1)} MB`;

async function choose(path: string | null, label: string) {
  status.textContent = `Loading ${label}…`;
  for (const b of list.querySelectorAll("button")) b.disabled = true;
  try {
    await invoke("choose_skin", { path });
    await render();
  } catch (e) {
    await render();
    status.textContent = `${label} did not load (${String(e)}), so the house skin is on.`;
  }
}

async function render() {
  const { skins, choice, worn } = await invoke<SkinList>("list_skins");
  random.checked = choice === null;
  status.textContent = `Wearing ${worn ? name(worn) : "the house skin"}. ${choice ? "It stays on every launch." : ""}`;
  list.replaceChildren(
    ...skins.map((skin) => {
      const li = document.createElement("li");
      li.setAttribute("aria-current", String(skin.path === worn));
      const button = document.createElement("button");
      button.type = "button";
      button.className = skin.path === choice ? "chosen" : "";
      button.textContent = name(skin.path);
      button.title = skin.cached ? "Downloaded" : `Downloads ${mb(skin.size)} from archive.org`;
      button.addEventListener("click", () => void choose(skin.path, name(skin.path)));
      const from = document.createElement("span");
      from.className = "from";
      from.textContent = skin.path.split("/")[0];
      const link = document.createElement("a");
      link.href = page(skin.path);
      link.dataset.link = "";
      link.className = "size";
      link.textContent = skin.cached ? "archive.org" : `archive.org, ${mb(skin.size)}`;
      li.append(button, from, link);
      return li;
    }),
  );
}

random.addEventListener("change", () => void choose(null, "a random skin"));
document.addEventListener("click", (e) => {
  const a = (e.target as HTMLElement).closest<HTMLAnchorElement>("a[data-link]");
  if (!a) return;
  e.preventDefault();
  void invoke("open_link", { url: a.href });
});
void render();
