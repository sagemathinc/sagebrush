// How big a picture is, from its header, before a browser decodes it.  A
// small file can say it is huge (an 8 KB PNG of 8192 x 8192 pixels), and
// decoding it takes that much memory (4 bytes a pixel), so pictures from a
// document (a notebook's outputs, Markdown's data: images, a board's
// pictures) are shown only within MAX_SIDE and MAX_PIXELS each, and
// LOAD_PIXELS in all for one document; past that, a placeholder says so and
// the picture is kept as it was.  (daybreak's SEC-B00-1 follow-up.)

export const MAX_SIDE = 8192, MAX_PIXELS = 40_000_000, LOAD_PIXELS = 80_000_000;

/** A picture's size in pixels, from its bytes' header (PNG, JPEG, WebP, GIF), or null if it can't be read. */
export function imageSizeOf(type: string, b: Uint8Array): { w: number; h: number } | null {
  const u16 = (i: number) => (b[i] << 8) | b[i + 1], le16 = (i: number) => b[i] | (b[i + 1] << 8), le24 = (i: number) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);
  const u32 = (i: number) => ((b[i] << 24) >>> 0) + ((b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]);
  const ascii = (i: number, n: number) => String.fromCharCode(...b.subarray(i, i + n));
  if (type === "image/png") {
    if (b.length < 24 || b[0] !== 0x89 || ascii(1, 3) !== "PNG" || ascii(12, 4) !== "IHDR") return null;
    return { w: u32(16), h: u32(20) };
  }
  if (type === "image/jpeg") {
    if (b[0] !== 0xff || b[1] !== 0xd8) return null;
    for (let i = 2; i + 9 < b.length; ) {
      if (b[i] !== 0xff) return null;
      const m = b[i + 1];
      if (m === 0xff) { i++; continue; }
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
      // (a start of frame: its height and width)
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { w: u16(i + 7), h: u16(i + 5) };
      i += 2 + u16(i + 2);
    }
    return null;
  }
  if (type === "image/webp") {
    if (b.length < 30 || ascii(0, 4) !== "RIFF" || ascii(8, 4) !== "WEBP") return null;
    const kind = ascii(12, 4);
    if (kind === "VP8 " && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) return { w: le16(26) & 0x3fff, h: le16(28) & 0x3fff };
    if (kind === "VP8L" && b[20] === 0x2f) return { w: 1 + (b[21] | ((b[22] & 0x3f) << 8)), h: 1 + ((b[22] >> 6) | (b[23] << 2) | ((b[24] & 0x0f) << 10)) };
    if (kind === "VP8X") return { w: 1 + le24(24), h: 1 + le24(27) };
    return null;
  }
  if (type === "image/gif") {
    // (the logical screen, and every frame's place and size: a frame may be
    // larger than the screen it says, and is decoded at its own size, SEC-89C-1)
    if (b.length < 13 || ascii(0, 4) !== "GIF8") return null;
    let w = le16(6), h = le16(8), frames = 0, i = 13;
    if (b[10] & 0x80) i += 3 * (2 << (b[10] & 7));
    const skipBlocks = () => { while (i < b.length && b[i]) i += b[i] + 1; i++; };
    while (i < b.length) {
      const t = b[i];
      if (t === 0x3b) break;
      if (t === 0x21) { i += 2; skipBlocks(); continue; }
      if (t !== 0x2c || i + 10 > b.length) return null;
      w = Math.max(w, le16(i + 1) + le16(i + 5));
      h = Math.max(h, le16(i + 3) + le16(i + 7));
      frames++;
      const f = b[i + 9];
      i += 10;
      if (f & 0x80) i += 3 * (2 << (f & 7));
      i++;
      skipBlocks();
    }
    return frames ? { w, h } : null;
  }
  return null;
}

/** The same, from base64 (as a notebook's outputs and data: URLs carry them). */
export function imageSize(type: string, base64: string): { w: number; h: number } | null {
  try {
    // (a PNG's or a WebP's header is in its first bytes; a JPEG's frame may
    // come after its metadata, and a GIF's frames are all through it)
    const b64 = base64.replace(/\s/g, "");
    const s = atob(type === "image/png" || type === "image/webp" ? b64.slice(0, 64) : b64);
    return imageSizeOf(type, Uint8Array.from(s, (c) => c.charCodeAt(0)));
  } catch {
    return null;
  }
}

/** A data: URL's type and base64, or null. */
export function dataUrl(src: string): { type: string; base64: string } | null {
  // (the grammar a browser takes: the type in any case, and jpg for jpeg; one
  // parser for every place a data: picture is shown or counted, SEC-A48-1)
  const m = /^data:image\/(png|jpe?g|webp|gif);base64,([A-Za-z0-9+/=\s]*)$/i.exec(src);
  return m ? { type: "image/" + m[1].toLowerCase().replace("jpg", "jpeg"), base64: m[2] } : null;
}

// ---- SVG pictures (a board's, and a code item's stored preview: P9a) ------------------------------
//
// An SVG is a board picture only as an image: an <img>'s src, an SVG file's <image> href, a CSS
// background, never put into a page (no innerHTML, no inline <svg>, no <object>, no navigation to it).
// A browser shows an image-context SVG in its secure mode: no script, no interaction, nothing loaded
// from elsewhere (SVG 2, section 2.3).  It is kept in one form, a base64 data: URL, within SVG_MAX_B64
// characters encoded and SVG_MAX_BYTES decoded, checked before it is decoded; its text must be UTF-8.
// Its size is read from its root <svg>'s width and height, both plain lengths (numbers, or px), the size a
// browser gives it: that is layout, not a check of what it draws; one whose size can't be read so is refused.

/** An SVG picture's bounds: base64 characters in its data: URL, and bytes of its text. */
export const SVG_MAX_B64 = 2_800_000, SVG_MAX_BYTES = 2_000_000;
const SVG_URL = /^data:image\/svg\+xml;base64,([A-Za-z0-9+/]*={0,2})$/;

// (a length: a number, unitless or px; anything else, a percentage, another unit or a character
// reference, is not read, and then the SVG is refused: a browser may size it otherwise, astra's SVG-SIZE-1)
const svgLength = (v: string): number | null => {
  const m = /^\s*(\d*\.?\d+(?:e[+-]?\d+)?)\s*(px)?\s*$/i.exec(v);
  const x = m ? Number(m[1]) : NaN;
  return Number.isFinite(x) && x > 0 ? x : null;
};

/** An SVG's size from its text: its root <svg>'s width and height, both there and plain lengths, rounded
 * up; null if its root isn't an <svg> or it hasn't both.  (Never from its viewBox: a browser sizes such an
 * SVG otherwise, 300 × 150 shaped by it, daybreak3's SVG-VIEWBOX-SIZE-1.) */
export function svgSize(text: string): { w: number; h: number } | null {
  // (before the root: a BOM, an XML declaration, comments and white space; a DOCTYPE is refused)
  let t = text.replace(/^\uFEFF/, "").slice(0, 65536);
  for (;;) {
    const s = t.replace(/^\s+/, "");
    if (s.startsWith("<?xml")) { const e = s.indexOf("?>"); if (e < 0) return null; t = s.slice(e + 2); continue; }
    if (s.startsWith("<!--")) { const e = s.indexOf("-->"); if (e < 0) return null; t = s.slice(e + 3); continue; }
    t = s;
    break;
  }
  const m = /^<svg(?=[\s/>])((?:[^>"']|"[^"]*"|'[^']*')*)>/.exec(t);
  if (!m) return null;
  const attrs = new Map<string, string>();
  for (const a of m[1].matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) if (!attrs.has(a[1])) attrs.set(a[1], a[2] ?? a[3]);
  const aw = attrs.get("width"), ah = attrs.get("height");
  const w = aw === undefined ? null : svgLength(aw), h = ah === undefined ? null : svgLength(ah);
  if (!w || !h) return null;
  const W = Math.ceil(w), H = Math.ceil(h);
  return Number.isFinite(W) && Number.isFinite(H) ? { w: W, h: H } : null;
}

/** The bytes base64 of this length and padding decodes to, read before it is decoded. */
export const b64Bytes = (b: string) => Math.floor((b.length * 3) / 4) - (b.endsWith("==") ? 2 : b.endsWith("=") ? 1 : 0);

/** An SVG's text from its base64 (canonical), within the bounds and as UTF-8; null if not. */
export function svgText(base64: string): string | null {
  // (the bounds before it is decoded: its length, and the bytes that length decodes to)
  if (base64.length > SVG_MAX_B64 || b64Bytes(base64) > SVG_MAX_BYTES || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) return null;
  try {
    const bin = atob(base64);
    // (its one form: the base64 its bytes encode to, so no other spelling of them, daybreak3's SVG-BASE64-CANON-1)
    if (bin.length > SVG_MAX_BYTES || btoa(bin) !== base64) return null;
    return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  } catch {
    return null;
  }
}

/** A board picture's data: URL (a raster one, as dataUrl reads it, or an SVG one in its one form, base64,
 * within the bounds): its type and base64, or null. */
export function pictureUrl(src: string): { type: string; base64: string } | null {
  const r = dataUrl(src);
  if (r) return r;
  if (src.length > SVG_MAX_B64 + 40) return null;
  const m = SVG_URL.exec(src);
  return m ? { type: "image/svg+xml", base64: m[1] } : null;
}

/** A board picture's size from its type and base64 (an SVG's from its root, as svgSize reads it). */
export function pictureSize(type: string, base64: string): { w: number; h: number } | null {
  if (type !== "image/svg+xml") return imageSize(type, base64);
  const t = svgText(base64);
  return t === null ? null : svgSize(t);
}

const b64utf8 = (t: string) => { const b = new TextEncoder().encode(t); let s = ""; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(s); };
/** An SVG as a board picture's data: URL in its one form (base64), from its text or from a data: URL a
 * browser takes (base64, or percent-encoded text, any case of the type); null if it isn't one, is past
 * the bounds, or its size can't be read. */
export function svgDataUrl(input: string): string | null {
  let text: string | null;
  if (input.length > 3 * SVG_MAX_BYTES + 64) return null;
  const m = /^data:image\/svg\+xml(?:;charset=utf-8)?(;base64)?,([\s\S]*)$/i.exec(input);
  if (!m) text = input;
  else if (m[1]) {
    // (base64 in another spelling of the same bytes, other pad bits or no padding: read in its one form)
    const b = m[2].replace(/\s/g, "");
    let c: string | null = null;
    if (b.length <= SVG_MAX_B64 && b64Bytes(b) <= SVG_MAX_BYTES && /^[A-Za-z0-9+/]*={0,2}$/.test(b)) try { c = btoa(atob(b)); } catch { /* not base64 */ }
    text = c === null ? null : svgText(c);
  }
  else { try { text = decodeURIComponent(m[2]); } catch { return null; } }
  if (text === null || new TextEncoder().encode(text).length > SVG_MAX_BYTES || !svgSize(text)) return null;
  const b = b64utf8(text);
  return b.length <= SVG_MAX_B64 ? `data:image/svg+xml;base64,${b}` : null;
}

/** A picture's name, to count it once however often it is drawn: all of it
 * (a part could be the same for another picture, SEC-71A-1).  (The string
 * is the one already in memory: kept, not copied.) */
export const pictureKey = (src: string) => src;

/** The pictures of one document: each within MAX_SIDE and MAX_PIXELS, and all within LOAD_PIXELS. */
export class PixelBudget {
  used = 0;
  private seen = new Set<string>();
  constructor(readonly total = LOAD_PIXELS) {}
  /** Whether a picture of this size may be shown (and if so, it is counted,
   * once for its `key`: drawn again, as a cell is, it isn't counted again);
   * why not, if not. */
  take(size: { w: number; h: number } | null, key?: string): string | null {
    // (each picture within the bounds, whether counted already or not)
    if (!size || !(size.w > 0) || !(size.h > 0)) return "its size can't be read";
    if (size.w > MAX_SIDE || size.h > MAX_SIDE || size.w * size.h > MAX_PIXELS) return `it is ${size.w} × ${size.h} pixels`;
    if (key && this.seen.has(key)) return null;
    if (this.used + size.w * size.h > this.total) return "this document's pictures are too many pixels in all";
    this.used += size.w * size.h;
    if (key) this.seen.add(key);
    return null;
  }
}
