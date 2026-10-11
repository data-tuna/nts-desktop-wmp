// The .wms file: XML-ish, written by hand in 2000. It may be UTF-16 with a
// BOM or Windows-1252, its tag and attribute names are case-insensitive
// (`<buttonGroup>…</buttongroup>`), attributes can repeat, and script
// attributes hold raw `&&` and `<`. DOMParser rejects all of that, so this is
// a forgiving tokenizer instead.

export type Node = {
  /** Lower-cased. */
  tag: string;
  /** Lower-cased names. When a name repeats, the last value wins, as in WMP. */
  attrs: Record<string, string>;
  children: Node[];
};

export function decode(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return new TextDecoder().decode(bytes.subarray(3));
  // Windows-1252 is Latin-1 except for 0x80-0x9F. Mapped here because not
  // every TextDecoder knows the difference (Node's falls back to Latin-1).
  let out = "";
  for (const b of bytes) out += b >= 0x80 && b < 0xa0 ? CP1252[b - 0x80] : String.fromCharCode(b);
  return out;
}

// 0x80-0x9F; the five holes keep their Latin-1 control characters.
const CP1252 = "€‚ƒ„…†‡ˆ‰Š‹ŒŽ" +
  "‘’“”•–—˜™š›œžŸ";

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function unescape(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) => {
    if (e[0] === "#") return String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : +e.slice(1));
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** Parses the document and returns its root element (normally `theme`). */
export function parse(text: string): Node {
  const root: Node = { tag: "#document", attrs: {}, children: [] };
  const stack = [root];
  let i = 0;
  while (i < text.length) {
    const lt = text.indexOf("<", i);
    if (lt < 0) break;
    if (text.startsWith("<!--", lt)) {
      const end = text.indexOf("-->", lt + 4);
      i = end < 0 ? text.length : end + 3;
    } else if (text.startsWith("<![CDATA[", lt)) {
      const end = text.indexOf("]]>", lt);
      i = end < 0 ? text.length : end + 3;
    } else if (text[lt + 1] === "?" || text[lt + 1] === "!") {
      const end = text.indexOf(">", lt);
      i = end < 0 ? text.length : end + 1;
    } else if (text[lt + 1] === "/") {
      const end = text.indexOf(">", lt);
      const tag = text.slice(lt + 2, end < 0 ? undefined : end).trim().toLowerCase();
      // Close the nearest open element of that name; ignore a stray close tag.
      let at = stack.length - 1;
      while (at > 0 && stack[at].tag !== tag) at--;
      if (at > 0) stack.length = at;
      i = end < 0 ? text.length : end + 1;
    } else {
      i = openTag(text, lt + 1, stack);
    }
  }
  return root.children.find((n) => n.tag === "theme") ?? root.children[0] ?? root;
}

const NAME = /[^\s/>=]/;

function openTag(text: string, start: number, stack: Node[]): number {
  let i = start;
  while (i < text.length && NAME.test(text[i])) i++;
  // No prototype, so an attribute named "constructor" is just an attribute.
  const node: Node = { tag: text.slice(start, i).toLowerCase(), attrs: Object.create(null), children: [] };
  stack[stack.length - 1].children.push(node);
  for (;;) {
    while (i < text.length && /\s/.test(text[i])) i++;
    if (i >= text.length) return i;
    if (text[i] === ">") {
      stack.push(node);
      return i + 1;
    }
    if (text.startsWith("/>", i)) return i + 2;
    const nameStart = i;
    while (i < text.length && NAME.test(text[i])) i++;
    if (i === nameStart) {
      i++; // a stray "/" or "="
      continue;
    }
    const name = text.slice(nameStart, i).toLowerCase();
    while (/\s/.test(text[i] ?? "")) i++;
    let value = "";
    if (text[i] === "=") {
      i++;
      while (/\s/.test(text[i] ?? "")) i++;
      const q = text[i];
      if (q === '"' || q === "'") {
        const end = text.indexOf(q, i + 1);
        value = text.slice(i + 1, end < 0 ? undefined : end);
        i = end < 0 ? text.length : end + 1;
      } else {
        const vStart = i;
        while (i < text.length && !/[\s>]/.test(text[i])) i++;
        value = text.slice(vStart, i);
      }
    }
    node.attrs[name] = unescape(value);
  }
}

/** The literal constants a skin's scripts declare at the top level
 * (`var leftOffset = 260;`). Skins lay views out with them, and reading a
 * literal runs none of the script. */
export function constants(scripts: string[]): Map<string, unknown> {
  const found = new Map<string, unknown>();
  const line = /^var\s+([A-Za-z_$][\w$]*)\s*=\s*(-?(?:0|[1-9]\d*)(?:\.\d+)?|"[^"\\]*"|'[^'\\]*'|true|false)\s*;?[ \t]*(?:\/\/[^\r\n]*)?\r?$/gm;
  for (const script of scripts)
    for (const [, name, literal] of script.matchAll(line))
      if (!found.has(name)) found.set(name, /^['"]/.test(literal) ? literal.slice(1, -1) : literal === "true" || (literal !== "false" && Number(literal)));
  return found;
}
