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
  const m = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=\s]*)$/.exec(src);
  return m ? { type: m[1], base64: m[2] } : null;
}

/** A short name for a picture, to count it once however often it is drawn. */
export const pictureKey = (src: string) => `${src.length}:${src.slice(0, 96)}:${src.slice(-96)}`;

/** The pictures of one document: each within MAX_SIDE and MAX_PIXELS, and all within LOAD_PIXELS. */
export class PixelBudget {
  used = 0;
  private seen = new Set<string>();
  constructor(readonly total = LOAD_PIXELS) {}
  /** Whether a picture of this size may be shown (and if so, it is counted,
   * once for its `key`: drawn again, as a cell is, it isn't counted again);
   * why not, if not. */
  take(size: { w: number; h: number } | null, key?: string): string | null {
    if (key && this.seen.has(key)) return null;
    if (!size || !(size.w > 0) || !(size.h > 0)) return "its size can't be read";
    if (size.w > MAX_SIDE || size.h > MAX_SIDE || size.w * size.h > MAX_PIXELS) return `it is ${size.w} × ${size.h} pixels`;
    if (this.used + size.w * size.h > this.total) return "this document's pictures are too many pixels in all";
    this.used += size.w * size.h;
    if (key) this.seen.add(key);
    return null;
  }
}
