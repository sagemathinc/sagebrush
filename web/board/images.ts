// Pictures on a board (design/board.md, "Images").  A note shows one by its
// name (`image`); the document's `images` gives each one's size.  Their
// bytes are kept apart from the document, in this browser's IndexedDB, named
// by a hash of their content, so that undo, saving and laying out never copy
// them.  A board leaving the browser (Download, Copy, an exported HTML file)
// carries them in `images`, as data: URLs, and opening one puts them back.

import type { BoardDoc, DocNode } from "./doc";

export interface ImageInfo {
  /** its size in pixels */
  w: number;
  h: number;
  /** where its bytes are, when not in this browser: a data: URL (a board
   * that left the browser), or an https: address */
  src?: string;
}

/** The pictures a board takes: raster images, as a browser shows them in <img>. */
export const IMAGE_TYPES = /^image\/(png|jpeg|gif|webp)$/;
/** How large a picture is kept: a larger one is scaled down on the way in. */
const MAX_SIDE = 2400, MAX_BYTES = 2_000_000;

const DB = "sagebrush-board-images", STORE = "blobs";
let dbp: Promise<IDBDatabase | null> | null = null;
function db(): Promise<IDBDatabase | null> {
  return (dbp ??= new Promise((resolve) => {
    try {
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(STORE);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => resolve(null);
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

const toBlob = (dataUrl: string): Blob | null => {
  const m = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=\s]*)$/.exec(dataUrl);
  if (!m) return null;
  try {
    const bin = atob(m[2].replace(/\s+/g, ""));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: m[1] });
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
 * A picture as a board keeps it: one of the raster types, at most 2400
 * pixels on a side and about 2 MB (a larger one is scaled down and saved
 * again, as WebP, or JPEG where the browser cannot write WebP).  Null: not
 * a picture a board takes.
 */
export async function prepare(file: Blob): Promise<{ blob: Blob; w: number; h: number } | null> {
  if (!IMAGE_TYPES.test(file.type)) return null;
  let bmp: ImageBitmap;
  try {
    bmp = await createImageBitmap(file);
  } catch {
    return null;
  }
  const { width: w, height: h } = bmp;
  // (an animated GIF stays as it is)
  if (file.type === "image/gif" || (Math.max(w, h) <= MAX_SIDE && file.size <= MAX_BYTES)) {
    bmp.close();
    return { blob: file, w, h };
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
  return blob ? { blob, w: cw, h: ch } : null;
}

/** The pictures of the boards in this browser: object URLs to show them, and their bytes. */
export class Images {
  private urls = new Map<string, string>();
  private blobs = new Map<string, Blob>();

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
  async absorb(d: BoardDoc): Promise<boolean> {
    const carried = Object.entries(d.images ?? {}).filter(([, v]) => v.src?.startsWith("data:"));
    if (!carried.length) return false;
    const rename = new Map<string, string>();
    for (const [name, v] of carried) {
      const blob = toBlob(v.src!);
      delete d.images![name];
      if (!blob) continue;
      const real = await this.put(blob);
      d.images![real] = { w: v.w, h: v.h };
      if (real !== name) rename.set(name, real);
    }
    if (rename.size) {
      const walk = (ns: DocNode[] | undefined) => {
        for (const n of ns ?? []) {
          if (n.kind === "group") walk(n.children);
          else if (n.image && rename.has(n.image)) n.image = rename.get(n.image);
        }
      };
      walk(d.nodes);
      for (const p of d.pages ?? []) walk(p.nodes);
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
