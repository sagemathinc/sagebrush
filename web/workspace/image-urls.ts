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
 * arrives, so the page can draw again. Only paths filePathOf accepts in the document's own folder are read: the folder
 * is the owner's, given by the page at clear() for each document it shows (never read from the document), and with no
 * folder nothing is read at all. */
export class ImageUrls {
  private urls = new Map<string, Held | null>();
  private loading = new Map<string, Promise<void>>();
  // (each path's version, bumped when it is let go (retain, clear): a read still on its way for it is dropped when it
  //  arrives, so nothing let go comes back)
  //  Versions come from one rising counter, and clear() starts a new floor and forgets the map, so the map holds only
  //  the paths of the document shown, and every version from before a clear() is below every one after it.)
  private ver = new Map<string, number>();
  private counter = 0;
  private floor = 0;
  // (how many clear()s: ready() waits again only after one)
  private clears = 0;
  /** true once dispose()d: nothing is read or held any more, ever (the document's page or pane is gone) */
  disposed = false;
  /** the folder of the document shown (imageFolder of its owner), or null: then no path is accepted */
  private folder: string | null = null;
  /** whether `path` is a reference this page may follow: well formed, in the shown document's own folder */
  private ok = (path: string) => filePathOf({ [FILE_KEY]: path }, this.folder) === path;
  private version = (p: string) => this.ver.get(p) ?? this.floor;
  private letGo(p: string) {
    this.ver.set(p, ++this.counter);
    const u = this.urls.get(p);
    if (u?.shown) URL.revokeObjectURL(u.shown.url);
    this.urls.delete(p);
    this.loading.delete(p);
  }
  constructor(private read: (path: string) => Promise<Uint8Array | null>, private changed: () => void) {}
  url(path: string): Shown | null {
    if (this.disposed) return null;
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
    if (this.urls.has(path) || !this.ok(path)) return;
    this.hold(path, u);
  }
  /** Every one of `paths` read again from the workspace (or found missing), for an export that is about to embed them:
   * what was held is replaced when its bytes changed or it went, and one missing before is found if it came back, so an
   * export embeds what the workspace has now, as Export all and a push do. */
  async ready(paths: string[]): Promise<void> {
    // (waits that a clear() made stale (another document shown, then perhaps this one again): see below)
    let clears = this.clears;
    await this.pass(paths);
    // (a clear() meanwhile: only the reads the document shown now has started for these same paths are waited for,
    //  never new ones, so the document before gets nothing loaded again; again after each further clear(), however
    //  many, until one wait passes with none)
    while (clears !== this.clears) {
      clears = this.clears;
      const pending = paths.map((p) => this.loading.get(p)).filter((x): x is Promise<void> => !!x);
      if (!pending.length) return;
      await Promise.all(pending);
    }
  }
  private async pass(paths: string[]): Promise<void> {
    let redraw = false;
    await Promise.all(paths.map(async (p) => {
      // (one not held yet is read now by load: no second read)
      // (its version taken before any wait: let go across either wait, nothing of it is kept)
      const v = this.version(p);
      const fresh = !this.urls.has(p) && !this.loading.has(p);
      await this.load(p);
      if (fresh || v !== this.version(p) || !this.ok(p)) return;
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
    if (this.disposed || this.urls.has(path)) return Promise.resolve();
    const going = this.loading.get(path);
    if (going) return going;
    if (!this.ok(path)) { this.urls.set(path, null); return Promise.resolve(); }
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
    if (this.disposed) return;
    const type = u.length <= IMAGE_BYTES_MAX ? imageType(u) : null;
    if (!type) { this.urls.set(path, null); return; }
    const size = imageSizeOf(type.mime, u);
    this.urls.set(path, { shown: size ? { url: URL.createObjectURL(new Blob([u as BlobPart], { type: type.mime })), ...size } : null, bytes: u });
  }
  /** Forget a path (its file changed or went), so it is read again when next shown. */
  forget(path: string) { this.letGo(path); }
  /** Whether `path` is settled: held (an image or found not one), or never to be read (not a well-formed reference). */
  settled(path: string): boolean {
    return this.urls.has(path) || !this.ok(path);
  }
  /** Let go of the images not among `paths` (those no cell refers to any more): their URLs revoked, their bytes
   * dropped, so pasting and deleting images doesn't keep them all. */
  retain(paths: string[]) {
    const keep = new Set(paths);
    for (const p of [...this.urls.keys(), ...this.loading.keys()]) if (!keep.has(p)) this.letGo(p);
  }
  /** Let go of every image (another document shown, or none): their URLs revoked and their bytes dropped, and any read
   * still on its way dropped when it arrives. `folder` is the folder of the document now shown (imageFolder of its
   * owner), or null for none: only references into it are followed from now on. */
  clear(folder: string | null = null) {
    this.folder = folder;
    this.clears++;
    for (const p of [...this.urls.keys(), ...this.loading.keys()]) this.letGo(p);
    this.floor = ++this.counter;
    this.ver.clear();
  }
  dispose() { this.disposed = true; this.clear(null); }
}
