// The images a page shows from workspace files (image-store.ts's references): blob: URLs made once each file is read
// and checked again by its bytes, with their sizes for the page's pixel budget, and their checked bytes kept for an
// export. Apart from image-store.ts so an export's chunk needs none of this (nor image-size.ts).
import { imageSizeOf } from "../image-size";
import { FILE_KEY, IMAGE_BYTES_MAX, filePathOf, imageType, sameBytes } from "./image-store";


/** A file image ready to show: its blob: URL and its size (read from its header, for the page's pixel budget). */
export type Shown = { url: string; w: number; h: number };
/** an image file held: what can be shown (null when its size can't be read from its header: not drawn), and its
 *  checked bytes, which an export embeds either way */
type Held = { shown: Shown | null; bytes: Uint8Array };
/** blob: URLs for image files, for a page that shows them: `url(path)` is synchronous (null until loaded), `load(path)`
 * reads the file, checks it again by its bytes and the cap, and makes its URL once; `changed` is called when one
 * arrives, so the page can draw again. Only paths filePathOf accepts are read. */
export class ImageUrls {
  private urls = new Map<string, Held | null>();
  private loading = new Map<string, Promise<void>>();
  // (each path's version, bumped when it is let go (retain, clear): a read still on its way for it is dropped when it
  //  arrives, so nothing let go comes back)
  private ver = new Map<string, number>();
  private version = (p: string) => this.ver.get(p) ?? 0;
  private letGo(p: string) {
    this.ver.set(p, this.version(p) + 1);
    const u = this.urls.get(p);
    if (u?.shown) URL.revokeObjectURL(u.shown.url);
    this.urls.delete(p);
    this.loading.delete(p);
  }
  constructor(private read: (path: string) => Promise<Uint8Array | null>, private changed: () => void) {}
  url(path: string): Shown | null {
    const u = this.urls.get(path);
    if (u === undefined && !this.loading.has(path)) void this.load(path);
    return u?.shown ?? null;
  }
  /** The bytes of a loaded image (checked as when it was loaded), for an export: null if not loaded or not an image. */
  bytes(path: string): Uint8Array | null {
    return this.urls.get(path)?.bytes ?? null;
  }
  /** An image saved just now: its bytes are known, so it needn't be read back. */
  put(path: string, u: Uint8Array) {
    if (this.urls.has(path) || filePathOf({ [FILE_KEY]: path }) !== path) return;
    this.hold(path, u);
  }
  /** Every one of `paths` read again from the workspace (or found missing), for an export that is about to embed them:
   * what was held is replaced when its bytes changed or it went, and one missing before is found if it came back, so an
   * export embeds what the workspace has now, as Export all and a push do. */
  async ready(paths: string[]): Promise<void> {
    let redraw = false;
    await Promise.all(paths.map(async (p) => {
      // (one not held yet is read now by load: no second read)
      const fresh = !this.urls.has(p) && !this.loading.has(p);
      await this.load(p);
      if (fresh || filePathOf({ [FILE_KEY]: p }) !== p) return;
      const v = this.version(p);
      const now = await this.read(p).catch(() => null);
      if (v !== this.version(p)) return;
      const had = this.urls.get(p);
      if (had && now && sameBytes(had.bytes, now)) return;
      if (!had && !now) return;
      if (had?.shown) URL.revokeObjectURL(had.shown.url);
      if (now) this.hold(p, now); else this.urls.set(p, null);
      redraw = true;
    }));
    if (redraw) this.changed();
  }
  load(path: string): Promise<void> {
    if (this.urls.has(path)) return Promise.resolve();
    const going = this.loading.get(path);
    if (going) return going;
    if (filePathOf({ [FILE_KEY]: path }) !== path) { this.urls.set(path, null); return Promise.resolve(); }
    const v = this.version(path);
    let p: Promise<void> | undefined;
    p = (async () => {
      let u: Uint8Array | null = null;
      try {
        u = await this.read(path).catch(() => null);
      } finally {
        if (this.loading.get(path) === p) this.loading.delete(path);
      }
      if (v !== this.version(path)) return;
      if (u) this.hold(path, u); else this.urls.set(path, null);
      this.changed();
    })();
    this.loading.set(path, p);
    return p;
  }
  private hold(path: string, u: Uint8Array) {
    const type = u.length <= IMAGE_BYTES_MAX ? imageType(u) : null;
    if (!type) { this.urls.set(path, null); return; }
    const size = imageSizeOf(type.mime, u);
    this.urls.set(path, { shown: size ? { url: URL.createObjectURL(new Blob([u as BlobPart], { type: type.mime })), ...size } : null, bytes: u });
  }
  /** Forget a path (its file changed or went), so it is read again when next shown. */
  forget(path: string) { this.letGo(path); }
  /** Let go of the images not among `paths` (those no cell refers to any more): their URLs revoked, their bytes
   * dropped, so pasting and deleting images doesn't keep them all. */
  retain(paths: string[]) {
    const keep = new Set(paths);
    for (const p of [...this.urls.keys(), ...this.loading.keys()]) if (!keep.has(p)) this.letGo(p);
  }
  /** Let go of every image (another document shown): their URLs revoked and their bytes dropped, and any read still on
   * its way dropped when it arrives. */
  clear() { for (const p of [...this.urls.keys(), ...this.loading.keys()]) this.letGo(p); }
  dispose() { this.clear(); }
}
