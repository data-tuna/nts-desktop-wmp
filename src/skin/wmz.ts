// A .wmz is a plain zip. Read its central directory and inflate each entry
// with the platform's DecompressionStream: no zip library needed.

/** The skin's files, keyed by lower-cased name: skins name their files in
 * whatever case they like ("Background.bmp" for "background.bmp"). */
export type Files = Map<string, Uint8Array>;

export async function unzip(zip: Uint8Array): Promise<Files> {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  // The end-of-central-directory record sits in the last 22 + 65535 bytes.
  let end = zip.length - 22;
  while (end >= Math.max(0, zip.length - 22 - 0xffff) && view.getUint32(end, true) !== 0x06054b50) end--;
  if (end < 0 || view.getUint32(end, true) !== 0x06054b50) throw new Error("not a zip file");
  const count = view.getUint16(end + 10, true);
  let p = view.getUint32(end + 16, true);
  const files: Files = new Map();
  for (let i = 0; i < count; i++) {
    if (view.getUint32(p, true) !== 0x02014b50) throw new Error("bad zip directory");
    const method = view.getUint16(p + 10, true);
    const size = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const local = view.getUint32(p + 42, true);
    const name = new TextDecoder().decode(zip.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith("/")) continue;
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const data = zip.subarray(start, start + size);
    // Skins keep their files at the root; drop any folder so lookups by bare name work.
    const key = name.slice(name.lastIndexOf("/") + 1).toLowerCase();
    if (method === 0) files.set(key, data);
    else if (method === 8) files.set(key, await inflate(data));
    else console.warn(`wmz: ${name} uses compression method ${method}, skipped`);
  }
  return files;
}

async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
