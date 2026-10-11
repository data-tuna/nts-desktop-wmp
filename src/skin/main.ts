// The skin page's entry: load the skin the protocol serves, run it, and keep
// it in step with the trusted page's state. The skin shapes the window itself.
import { unzip } from "./wmz.ts";
import { decode, parse } from "./wms.ts";
import { Skin, type Img, type Send, type State } from "./engine.ts";

const send: Send = (msg) => void fetch("/msg", { method: "POST", body: JSON.stringify(msg) });

async function decodeImage(bytes: Uint8Array): Promise<Img> {
  // No colour management: mapping and transparency colours must stay exact.
  const bitmap = await createImageBitmap(new Blob([bytes as BlobPart]), { colorSpaceConversion: "none", premultiplyAlpha: "none" });
  const g = new OffscreenCanvas(bitmap.width, bitmap.height).getContext("2d")!;
  g.drawImage(bitmap, 0, 0);
  const { data } = g.getImageData(0, 0, bitmap.width, bitmap.height);
  return { width: bitmap.width, height: bitmap.height, data, bitmap };
}

async function load(): Promise<Skin> {
  const res = await fetch("/skin.wmz");
  if (!res.ok) throw new Error(`no skin to load (${res.status})`);
  const files = await unzip(new Uint8Array(await res.arrayBuffer()));
  const wms = [...files.keys()].find((name) => name.endsWith(".wms"));
  if (!wms) throw new Error("the skin has no .wms file");
  const images = new Map<string, Img>();
  await Promise.all(
    [...files].filter(([name]) => /\.(bmp|gif|png|jpe?g)$/.test(name)).map(async ([name, bytes]) => {
      try {
        images.set(name, await decodeImage(bytes));
      } catch {
        console.warn(`skin: cannot decode ${name}`);
      }
    }),
  );
  const scripts = new Map([...files].filter(([name]) => name.endsWith(".js")).map(([name, bytes]) => [name, decode(bytes)]));
  // Preferences are kept per skin, by its .wms name.
  return new Skin(parse(decode(files.get(wms)!)), images, send, scripts, `pref:${wms}:`);
}

// A classic script has no top-level await.
load().then(
  (skin) => {
    document.body.append(skin.canvas);
    skin.start();
    window.addEventListener("message", (e) => {
      if (e.data?.type === "state") skin.setState(e.data as State);
    });
  },
  (e) => {
    const p = document.createElement("p");
    p.id = "error";
    p.textContent = String(e);
    document.body.append(p);
  },
);
