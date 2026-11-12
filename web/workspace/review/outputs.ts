// What the review page's "notebook as submitted" may show of a document's outputs, decided before the notebook
// component is made, on the one parsed document, in place (no copy of its structure).  Kept, per output: text/plain,
// a stream's and an error's text, and a PNG, JPEG or WebP picture whose header says its size; everything else (HTML,
// SVG, Markdown, LaTeX, graphs, typeset, JSON, any other picture or type) is taken out, and an output left with
// nothing shows one line instead.  A Markdown cell is shown as raw text (its source, never rendered: no picture, link,
// HTML or math of its own reaches the page) and its attachments are dropped.  Past a bound (the outputs, the
// pictures, their pixels, the text): refused whole, and nothing is shown.

export const OUTPUT_LIMITS = Object.freeze({
  outputs: 2000,
  images: 64,
  /** a picture's width and height, each, at most */
  side: 4096,
  /** all pictures' pixels together (32 MiB as RGBA) */
  pixels: 8_388_608,
  /** UTF-8 bytes of text/plain, streams and errors together */
  text: 4 * 2 ** 20,
  /** base64-decoded bytes a picture's header is looked for in */
  header: 64 * 2 ** 10,
});

const PICTURES = ["image/png", "image/jpeg", "image/webp"] as const;

const be16 = (b: Uint8Array, i: number) => (b[i] << 8) | b[i + 1];
const be32 = (b: Uint8Array, i: number) => ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3];
const le16 = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8);
const le24 = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);

/** A picture's size from its header bytes, if they are of `mime`'s kind and say it; else null. */
export function pictureSize(mime: string, b: Uint8Array): { w: number; h: number } | null {
  if (mime === "image/png") {
    const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    if (b.length < 24 || !sig.every((x, i) => b[i] === x) || String.fromCharCode(...b.subarray(12, 16)) !== "IHDR") return null;
    return { w: be32(b, 16), h: be32(b, 20) };
  }
  if (mime === "image/jpeg") {
    if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
    let i = 2;
    while (i + 3 < b.length) {
      if (b[i] !== 0xff) return null;
      const mk = b[i + 1];
      if (mk === 0xff) { i++; continue; }
      if (mk === 0xd8 || mk === 0x01 || (mk >= 0xd0 && mk <= 0xd7)) { i += 2; continue; }
      if (mk === 0xd9 || mk === 0xda) return null;
      if (mk >= 0xc0 && mk <= 0xcf && mk !== 0xc4 && mk !== 0xc8 && mk !== 0xcc) return i + 8 < b.length ? { w: be16(b, i + 7), h: be16(b, i + 5) } : null;
      i += 2 + be16(b, i + 2);
    }
    return null;
  }
  if (mime === "image/webp") {
    const tag = (i: number) => String.fromCharCode(...b.subarray(i, i + 4));
    if (b.length < 30 || tag(0) !== "RIFF" || tag(8) !== "WEBP") return null;
    const c = tag(12);
    if (c === "VP8 " && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) return { w: le16(b, 26) & 0x3fff, h: le16(b, 28) & 0x3fff };
    if (c === "VP8L" && b[20] === 0x2f) return { w: 1 + (((b[22] & 0x3f) << 8) | b[21]), h: 1 + (((b[24] & 0x0f) << 10) | (b[23] << 2) | ((b[22] & 0xc0) >> 6)) };
    if (c === "VP8X") return { w: 1 + le24(b, 24), h: 1 + le24(b, 27) };
    return null;
  }
  return null;
}

/** The first `max` bytes of a base64 text (whitespace in it allowed), or null if it isn't base64. */
export function base64Head(t: string, max = OUTPUT_LIMITS.header): Uint8Array | null {
  const want = Math.ceil(max / 3) * 4;
  let s = "";
  for (let i = 0; i < t.length && s.length < want; i++) { const c = t[i]; if (c !== " " && c !== "\n" && c !== "\r" && c !== "\t") s += c; }
  s = s.slice(0, s.length - (s.length % 4));
  try { const bin = atob(s); const out = new Uint8Array(Math.min(bin.length, max)); for (let i = 0; i < out.length; i++) out[i] = bin.charCodeAt(i); return out; }
  catch { return null; }
}

const textOf = (v: unknown) => (Array.isArray(v) ? v.join("") : typeof v === "string" ? v : "");
const utf8 = (s: string) => { let n = 0; for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); n += c < 0x80 ? 1 : c < 0x800 ? 2 : c >= 0xd800 && c < 0xdc00 && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00 ? (i++, 4) : 3; } return n; };

export type Shown = { outputs: number; images: number; pixels: number; text: number; stripped: number };
export type Refused = { refused: "outputs" | "images" | "pixels" | "text" };

/** `doc`'s outputs kept as above, in place, its Markdown cells made raw text, and what was kept counted; or why the
 * whole is refused.  `notShown`: the one line an output left with nothing shows. */
export function filterOutputs(doc: any, notShown: string): Shown | Refused {
  const n: Shown = { outputs: 0, images: 0, pixels: 0, text: 0, stripped: 0 };
  // (a picture kept only if its header, of its own kind, gives a size within the bounds, all counted)
  const picture = (mime: string, v: unknown): boolean | Refused => {
    if (!(PICTURES as readonly string[]).includes(mime) || typeof textOf(v) !== "string") return false;
    const head = base64Head(textOf(v));
    const size = head && pictureSize(mime, head);
    if (!size || size.w < 1 || size.h < 1 || size.w > OUTPUT_LIMITS.side || size.h > OUTPUT_LIMITS.side) return false;
    if (++n.images > OUTPUT_LIMITS.images) return { refused: "images" };
    n.pixels += size.w * size.h;
    if (n.pixels > OUTPUT_LIMITS.pixels) return { refused: "pixels" };
    return true;
  };
  const text = (s: string): Refused | null => ((n.text += utf8(s)) > OUTPUT_LIMITS.text ? { refused: "text" } : null);
  const cells: any[] = Array.isArray(doc?.cells) ? doc.cells : [];
  for (const c of cells) {
    if (!c || typeof c !== "object") continue;
    if (c.type === "markdown") c.type = "raw";
    if ("attachments" in c) { delete c.attachments; n.stripped++; }
    if (!Array.isArray(c.outputs)) { if (c.outputs !== undefined) delete c.outputs; continue; }
    for (let i = 0; i < c.outputs.length; i++) {
      const o = c.outputs[i];
      if (++n.outputs > OUTPUT_LIMITS.outputs) return { refused: "outputs" };
      if (o?.output_type === "stream") { const r = text(textOf(o.text)); if (r) return r; continue; }
      if (o?.output_type === "error") { const r = text(textOf(o.traceback) + textOf(o.ename) + textOf(o.evalue)); if (r) return r; continue; }
      const data = o && typeof o.data === "object" && o.data ? o.data : {};
      for (const mime of Object.keys(data)) {
        if (mime === "text/plain") { const r = text(textOf(data[mime])); if (r) return r; continue; }
        const ok = picture(mime, data[mime]);
        if (typeof ok === "object") return ok;
        if (!ok) { delete data[mime]; n.stripped++; }
      }
      if (!Object.keys(data).length) c.outputs[i] = { output_type: "display_data", data: { "text/plain": notShown }, metadata: {} };
    }
  }
  return n;
}
