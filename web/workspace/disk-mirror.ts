// The desktop app's workspace on disk (app/src-tauri/src/disk.rs; design: the native-storage note, approved Nov 17):
// the documents and files are real files under Workspace/ in the app's data folder, the canonical copy; this page's
// workspace (IndexedDB, in a web view that keeps nothing between launches) is a cache of them for one launch.
//   - importDisk: at the launch's first open, the tree on disk is made in the (empty) workspace, through its own
//     verbs: folders, then notebooks (.ipynb), boards (.board.json) and data files.  The disk's Trash (.Trash/) is
//     left on disk, not shown (it is restored or emptied from the disk for now).
//   - DiskMirror: from then on, every change of the workspace is written to disk at once (no batching: what a
//     crash can lose is the one write under way): a data file's or board's new contents (its op), a notebook's
//     save (docSaved, from the notebook page's "saved"), a folder made, a rename, a move to Trash and back
//     (Workspace/.Trash/), and what Trash empties.  One write at a time, in order.
//   - A file changed on disk by another program since this page read or wrote it is never written over: this
//     page's version goes beside it, as "<name> (from Sagebrush)<ext>", and `onConflict` says so.
// Folders and files are named as in the workspace; Trash, "/Trash", is ".Trash" on disk.
import { TRASH, kindOf, nameOf, parentOf, splitExt, within } from "./paths";
import { notebookFileText, boardFileText } from "./file-bytes";
import { Images } from "../board/images";

export type DiskStat = { path: string; dir: boolean; size: number; mtime: number };
/** The app's disk commands (disk.rs), or a test's. */
export type Disk = {
  list(): Promise<DiskStat[]>;
  stat(p: string): Promise<DiskStat | null>;
  read(p: string): Promise<Uint8Array>;
  write(p: string, bytes: Uint8Array): Promise<DiskStat | null>;
  mkdir(p: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  remove(p: string): Promise<void>;
};

/** The desktop app's: disk.rs through Tauri's IPC. */
export function tauriDisk(invoke: (cmd: string, args?: any, opts?: any) => Promise<any>): Disk {
  return {
    list: () => invoke("disk_list"),
    stat: (path) => invoke("disk_stat", { path }),
    read: async (path) => new Uint8Array(await invoke("disk_read", { path })),
    write: (path, bytes) => invoke("disk_write", bytes, { headers: { "Sagebrush-Path": encodeURIComponent(path) } }),
    mkdir: (path) => invoke("disk_mkdir", { path }),
    rename: (from, to) => invoke("disk_rename", { from, to }),
    remove: (path) => invoke("disk_remove", { path }),
  };
}

const DISK_TRASH = "/.Trash";
/** A workspace path's on disk, and back. */
export const toDisk = (p: string) => (within(p, TRASH) ? DISK_TRASH + p.slice(TRASH.length) : p);
export const fromDisk = (p: string) => (within(p, DISK_TRASH) ? TRASH + p.slice(DISK_TRASH.length) : p);

const enc = new TextEncoder(), dec = new TextDecoder();
const same = (a: DiskStat | null | undefined, b: DiskStat | null | undefined) => !!a && !!b && a.size === b.size && a.mtime === b.mtime;

/** What the workspace has at `p` as the bytes of its file: a notebook's .ipynb, a board's file, a data file's bytes. */
export async function fileBytes(ws: any, p: string): Promise<Uint8Array | null> {
  const { entry, content } = await ws.read(p);
  if (entry.kind === "notebook") return enc.encode(notebookFileText(content));
  if (entry.kind === "board") {
    // (its pictures in it, as Download and the export write it)
    const images = new Images();
    try { return enc.encode(await boardFileText(content, images)); } finally { images.dispose(); }
  }
  if (entry.kind === "file") return content instanceof Uint8Array ? content : typeof content === "string" ? enc.encode(content) : new Uint8Array(content);
  return null;
}

/** The disk's tree made in `ws` (an empty workspace: this launch's): folders, then files.  Returns what was
 * read (each file's stat, by path, for DiskMirror), what couldn't be imported and why, and how long it took. */
export async function importDisk(ws: any, disk: Disk, now: () => number = () => performance.now()): Promise<{ known: Map<string, DiskStat>; skipped: [string, string][]; files: number; bytes: number; ms: number }> {
  const t0 = now(), known = new Map<string, DiskStat>(), skipped: [string, string][] = [];
  const all = (await disk.list()).filter((e) => !within(e.path, DISK_TRASH));
  let files = 0, bytes = 0;
  for (const e of all.filter((e) => e.dir).sort((a, b) => a.path.length - b.path.length)) {
    try { await ws.mkdir(e.path); } catch (err: any) { skipped.push([e.path, err?.message ?? String(err)]); }
  }
  for (const e of all.filter((e) => !e.dir)) {
    try {
      const b = await disk.read(e.path), kind = kindOf(e.path);
      const content = kind === "file" ? b : JSON.parse(dec.decode(b));
      await ws.create(e.path, { content });
      known.set(e.path, e);
      files++;
      bytes += e.size;
    } catch (err: any) { skipped.push([e.path, err?.message ?? String(err)]); }
  }
  return { known, skipped, files, bytes, ms: Math.round(now() - t0) };
}

export class DiskMirror {
  private queue: Promise<void> = Promise.resolve();
  private stop: (() => void) | null = null;
  /** `known`: each file's stat as this page last read or wrote it (importDisk's, then each write's). */
  constructor(private ws: any, private disk: Disk, private known: Map<string, DiskStat>, private onConflict: (path: string, kept: string) => void = () => {}, private onError: (path: string, e: unknown) => void = (p, e) => console.warn("disk:", p, e)) {}

  start() {
    this.stop = this.ws.watch((c: { ops: any[] }) => { for (const op of c.ops ?? []) this.op(op); });
    return this;
  }
  close() { this.stop?.(); this.stop = null; }
  /** Every write asked so far done (or failed, and said). */
  flushed(): Promise<void> { return this.queue; }

  /** A notebook's save (its id): its file written. */
  docSaved(ref: string) {
    this.then(async () => {
      const p = await this.ws.pathOf("notebook", ref);
      if (p) await this.writeOut(p);
    }, ref);
  }

  private then(f: () => Promise<void>, what: string) {
    this.queue = this.queue.then(f).catch((e) => this.onError(what, e));
  }

  private op(op: any) {
    if (op.origin === "server") return;
    const p: string = op.path, to: string | undefined = op.to;
    switch (op.op) {
      case "create":
      case "adopt":
      case "write":
        if (op.kind !== "folder") return this.then(() => this.writeOut(to ?? p), p);
        return this.then(() => this.disk.mkdir(toDisk(p)), p);
      case "mkdir":
        return this.then(() => this.disk.mkdir(toDisk(p)), p);
      case "rename":
      case "remove":
      case "restore":
        if (to) return this.then(() => this.move(p, to), p);
        return;
      case "emptyTrash":
      case "discard":
      case "forget":
        if (within(p, TRASH) && p !== TRASH) return this.then(() => this.disk.remove(toDisk(p)), p);
        return;
    }
  }

  private async move(from: string, to: string) {
    await this.disk.rename(toDisk(from), toDisk(to));
    for (const [k, v] of [...this.known]) if (within(k, toDisk(from))) { this.known.delete(k); this.known.set(toDisk(to) + k.slice(toDisk(from).length), v); }
  }

  /** The workspace's `p` written to its file, unless another program changed that file since this page last read
   * or wrote it: then beside it. */
  private async writeOut(p: string) {
    const bytes = await fileBytes(this.ws, p).catch(() => null);
    if (!bytes) return;
    let at = toDisk(p);
    const now = await this.disk.stat(at);
    if (now && !now.dir && !same(now, this.known.get(at))) {
      const [base, ext] = splitExt(nameOf(at));
      at = (parentOf(at) === "/" ? "" : parentOf(at)) + "/" + base + " (from Sagebrush)" + ext;
      this.onConflict(toDisk(p), at);
    }
    const st = await this.disk.write(at, bytes);
    if (st) this.known.set(at, st);
  }
}

const IMPORTED = "sb-disk-imported";
/** The desktop app's page: the disk's tree imported at the launch's first page (sessionStorage, kept by the window
 * for the launch, says it was), then every change written through.  `say`: one line for the person (a conflict). */
export async function diskWorkspace(ws: any, invoke: (cmd: string, args?: any, opts?: any) => Promise<any>, say: (text: string) => void): Promise<DiskMirror> {
  const disk = tauriDisk(invoke);
  let known: Map<string, DiskStat>;
  if (!sessionStorage.getItem(IMPORTED)) {
    const r = await importDisk(ws, disk);
    known = r.known;
    sessionStorage.setItem(IMPORTED, "1");
    console.log(`disk: imported ${r.files} files (${r.bytes} bytes) in ${r.ms} ms${r.skipped.length ? `; not imported: ${r.skipped.slice(0, 5).map(([p, why]) => `${p} (${why})`).join(", ")}` : ""}`);
  } else known = new Map((await disk.list()).filter((e) => !e.dir).map((e) => [e.path, e]));
  return new DiskMirror(ws, disk, known, (p, kept) => say(`${p} was changed by another program, so it wasn't written over: Sagebrush's version is ${kept}`)).start();
}
