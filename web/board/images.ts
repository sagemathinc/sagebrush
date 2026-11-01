// Pictures on a board (design/board.md, "Images").  A note shows one by its
// name (`image`); the document's `images` gives each one's size.  Their
// bytes are kept apart from the document, in this browser's IndexedDB, named
// by a hash of their content, so that undo, saving and laying out never copy
// them.  A board leaving the browser (Download, Copy, an exported HTML file)
// carries them in `images`, as data: URLs, and opening one puts them back.

import type { BoardDoc, DocNode } from "./doc";
import { PixelBudget, dataUrl, imageSize } from "../image-size";
import { openDb } from "./idb-open";

/** A picture a note shows, by its name in the document's `images`. */
export interface ImageInfo {
  /** required: its width in pixels */
  w: number;
  /** required: its height in pixels */
  h: number;
  /** its bytes, which a file needs to show the picture: a `data:` URL (PNG, JPEG, GIF or WebP), or an `https:` address */
  // (left out while it is in this browser's IndexedDB; a board that left the browser carries it)
  src?: string;
}

/** The pictures a board takes: raster images, as a browser shows them in <img>. */
export const IMAGE_TYPES = /^image\/(png|jpeg|gif|webp)$/;
/** How large a picture is kept: a larger one is scaled down on the way in. */
const MAX_SIDE = 2400, MAX_BYTES = 2_000_000;

const DB = "sagebrush-board-images", STORE = "blobs";
let dbp: Promise<IDBDatabase | null> | null = null;
// (after an open that failed, how long before one is tried again: each use in
// between is no store at once, rather than waiting its own 3 s, as outcache)
const OPEN_RETRY_MS = 30_000;
let failedAt = -Infinity;
function db(): Promise<IDBDatabase | null> {
  if (!dbp && Date.now() - failedAt < OPEN_RETRY_MS) return Promise.resolve(null);
  return (dbp ??= new Promise((resolve) => {
    try {
      // (bounded, web/board/idb-open.ts: one that never opens is no store, as none at all is)
      // (one that didn't open: none now, and tried again by a use after OPEN_RETRY_MS)
      openDb(DB, 1, (d) => d.createObjectStore(STORE), () => { dbp = null; }).then(resolve, () => { dbp = null; failedAt = Date.now(); resolve(null); });
    } catch {
      resolve(null); // (no IndexedDB here: an exported file opened from disk, say; pictures are kept in memory)
    }
  }));
}
async function idb<T>(mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | undefined> {
  const d = await db();
  if (!d) return undefined;
  return new Promise((resolve) => {
    try {
      const r = f(d.transaction(STORE, mode).objectStore(STORE));
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => resolve(undefined);
    } catch {
      resolve(undefined);
    }
  });
}

// A name from the bytes' SHA-256 (the first 128 bits): the same picture is
// kept once, and a document cannot name its picture after another one.
async function nameOf(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (crypto?.subtle) {
    const h = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    return "i" + [...h.slice(0, 16)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  // (no crypto.subtle, outside a secure context: FNV-1a, twice)
  let a = 0x811c9dc5, b = 0x01000193 ^ bytes.length;
  for (const x of bytes) { a = Math.imul(a ^ x, 0x01000193); b = Math.imul(b ^ x, 0x5bd1e995); }
  return "i" + (a >>> 0).toString(16).padStart(8, "0") + (b >>> 0).toString(16).padStart(8, "0");
}

const toBlob = (src: string): Blob | null => {
  // (the one grammar of data: pictures, image-size.ts: any case of the type, jpg too)
  const d = dataUrl(src);
  if (!d) return null;
  try {
    const bin = atob(d.base64.replace(/\s+/g, ""));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: d.type });
  } catch {
    return null;
  }
};
const toDataUrl = (blob: Blob): Promise<string> => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(r.result as string);
  r.onerror = () => reject(r.error);
  r.readAsDataURL(blob);
});

/**
 * How many pixels a screenshot has per CSS pixel, as its file says: a PNG's
 * pHYs chunk, where a screen's 1x is 72 dpi (a macOS screenshot from a 2x
 * screen says 144).  Only a screenshot's densities count, 1.5x to 3x: 96 dpi
 * (Windows' usual) and print resolutions (300 dpi) say nothing about a
 * screen.  Null: it does not say.
 */
export function density(b: Uint8Array): number | null {
  const u32 = (i: number) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
  if (!(b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47)) return null;
  // the signature, then chunks (length, type, data, CRC); pHYs comes before IDAT
  for (let i = 8; i + 8 <= b.length; ) {
    const len = u32(i), type = String.fromCharCode(b[i + 4], b[i + 5], b[i + 6], b[i + 7]);
    if (type === "pHYs") {
      if (len < 9 || i + 17 > b.length || b[i + 16] !== 1 || u32(i + 8) !== u32(i + 12)) return null;
      const dpi = u32(i + 8) * 0.0254;
      return dpi >= 100 && dpi <= 230 ? Math.round((dpi / 72) * 4) / 4 : null;
    }
    if (type === "IDAT" || type === "IEND") return null;
    i += 12 + len;
  }
  return null;
}

/**
 * A picture as a board keeps it: one of the raster types, at most 2400
 * pixels on a side and about 2 MB (a larger one is scaled down and saved
 * again, as WebP, or JPEG where the browser cannot write WebP).  Null: not
 * a picture a board takes.  Also its natural width in CSS pixels (`cssW`):
 * its pixels over its density, from the file, or else, for a paste, from
 * the screen it was surely taken on (a 2x screenshot shows at the size it
 * had on the screen, sharp, not twice that and blurry).
 */
export async function prepare(file: Blob, opts: { paste?: boolean } = {}): Promise<{ blob: Blob; w: number; h: number; cssW: number } | null> {
  if (!IMAGE_TYPES.test(file.type)) return null;
  let bmp: ImageBitmap;
  try {
    bmp = await createImageBitmap(file);
  } catch {
    return null;
  }
  const { width: w, height: h } = bmp;
  let dens = density(new Uint8Array(await file.slice(0, 1 << 16).arrayBuffer()));
  if (dens === null) dens = opts.paste ? globalThis.devicePixelRatio || 1 : 1;
  const cssW = Math.max(1, Math.round(w / Math.min(4, Math.max(1, dens))));
  // (an animated GIF stays as it is)
  if (file.type === "image/gif" || (Math.max(w, h) <= MAX_SIDE && file.size <= MAX_BYTES)) {
    bmp.close();
    return { blob: file, w, h, cssW };
  }
  const k = Math.min(1, MAX_SIDE / Math.max(w, h));
  const cw = Math.max(1, Math.round(w * k)), ch = Math.max(1, Math.round(h * k));
  const c = document.createElement("canvas");
  c.width = cw;
  c.height = ch;
  c.getContext("2d")!.drawImage(bmp, 0, 0, cw, ch);
  bmp.close();
  const encode = (type: string) => new Promise<Blob | null>((r) => c.toBlob(r, type, 0.9));
  let blob = await encode("image/webp");
  if (!blob || blob.type !== "image/webp") blob = await encode("image/jpeg");
  return blob ? { blob, w: cw, h: ch, cssW } : null;
}

/** The pictures of the boards in this browser: object URLs to show them, and their bytes. */
/** Where pictures' bytes are kept, by name (the SHA-256 of their content):
 * what a board needs of a host's store (Images: this browser's IndexedDB). */
export interface ImageStore {
  url(name: string): string | undefined;
  put(blob: Blob): Promise<string>;
  /** have these at hand to show */
  ensure(names: Iterable<string>): Promise<unknown>;
  /** take in the pictures a document carries (data: URLs), under their own
   * names, counted in its pictures' pixels if given (image-size.ts) */
  absorb(d: BoardDoc, pixels?: PixelBudget): Promise<unknown>;
  /** the document with its pictures in it (data: URLs), as a file carries it */
  inline(d: BoardDoc): Promise<BoardDoc>;
}

export class Images {
  private urls = new Map<string, string>();
  private blobs = new Map<string, Blob>();

  /** Lets every picture go, their object URLs revoked (an Images made for one use, as the export's per board). */
  dispose(): void {
    for (const u of this.urls.values()) URL.revokeObjectURL(u);
    this.urls.clear();
    this.blobs.clear();
  }

  /** The address to show a picture at (once ensure() has it). */
  url(name: string): string | undefined {
    return this.urls.get(name);
  }

  /** Keep a picture; resolves to its name. */
  async put(blob: Blob): Promise<string> {
    const name = await nameOf(blob);
    if (!this.urls.has(name)) {
      this.remember(name, blob);
      await idb("readwrite", (s) => s.put(blob, name));
    }
    return name;
  }
  private remember(name: string, blob: Blob) {
    this.blobs.set(name, blob);
    this.urls.set(name, URL.createObjectURL(blob));
  }

  /** A picture's size and type, if it is at hand (no wait: for counting before its bytes are read). */
  sizeOf(name: string): { size: number; type: string } | undefined {
    const b = this.blobs.get(name);
    return b ? { size: b.size, type: b.type } : undefined;
  }
  /** A picture as a data: URL, if this browser holds it. */
  async dataUrl(name: string): Promise<string | undefined> {
    await this.ensure([name]);
    const b = this.blobs.get(name);
    return b ? toDataUrl(b) : undefined;
  }
  /** A picture's bytes, if this browser holds them (from IndexedDB, if not at hand). */
  async blob(name: string): Promise<Blob | undefined> {
    await this.ensure([name]);
    return this.blobs.get(name);
  }

  /** Have these pictures ready to show (from IndexedDB). */
  async ensure(names: Iterable<string>): Promise<void> {
    const missing = [...new Set(names)].filter((n) => !this.urls.has(n));
    await Promise.all(missing.map(async (n) => {
      const b = await idb<Blob>("readonly", (s) => s.get(n));
      if (b instanceof Blob && !this.urls.has(n)) this.remember(n, b);
    }));
  }

  /**
   * Take in the pictures a document carries (data: URLs in `images`): kept
   * here, named by their content, and the document says only their sizes
   * (its notes renamed to match).  Resolves to whether it changed.
   */
  async absorb(d: BoardDoc, budget?: PixelBudget): Promise<boolean> {
    // (every source but an https: address: a data: URL in any case is one,
    // SEC-1D8-1; dataUrl below decides, and what it can't read is dropped)
    const carried = Object.entries(d.images ?? {}).filter(([, v]) => !!v.src && !/^https:\/\//i.test(v.src));
    if (!carried.length) return false;
    const rename = new Map<string, string>();
    // (each within the bounds its header gives, and all within the
    // document's pixels: image-size.ts; a picture past them is not taken)
    const pixels = budget ?? new PixelBudget();
    for (const [name, v] of carried) {
      const u = dataUrl(v.src!), why = pixels.take(u ? imageSize(u.type, u.base64) : null);
      const blob = why ? null : toBlob(v.src!);
      delete d.images![name];
      if (why) console.warn(`board: a picture not taken: ${why}`);
      if (!blob) continue;
      const real = await this.put(blob);
      d.images![real] = { w: v.w, h: v.h };
      if (real !== name) rename.set(name, real);
    }
    if (rename.size) {
      const walk = (ns: DocNode[] | undefined) => {
        for (const n of ns ?? []) {
          if (n.kind === "group") walk(n.children);
          else if ((n.kind === undefined || n.kind === "note") && n.image && rename.has(n.image)) n.image = rename.get(n.image);
        }
      };
      walk(d.nodes);
      for (const p of d.pages ?? []) walk(p.nodes);
      // (and the pages' backgrounds)
      for (const p of [d, ...(d.pages ?? [])]) if (p.background?.image && rename.has(p.background.image)) p.background.image = rename.get(p.background.image);
    }
    return true;
  }

  /** A copy of a document carrying its pictures (as data: URLs), to leave the browser. */
  async inline(d: BoardDoc): Promise<BoardDoc> {
    const out = JSON.parse(JSON.stringify(d)) as BoardDoc;
    if (!out.images) return out;
    await this.ensure(Object.keys(out.images));
    for (const [name, v] of Object.entries(out.images)) {
      const b = this.blobs.get(name);
      if (!v.src && b) v.src = await toDataUrl(b);
    }
    return out;
  }
}
