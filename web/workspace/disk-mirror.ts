// The desktop app's workspace on disk (app/src-tauri/src/disk.rs; design: the native-storage note, approved Nov 17):
// the documents and files are real files under Workspace/ in the app's data folder, the canonical copy; this page's
// workspace (IndexedDB, in a web view that keeps nothing between launches) is a cache of them for one launch.
//   - importDisk: at the launch's first page, the tree on disk is made in the (empty) workspace, through its own
//     verbs: folders, then notebooks (.ipynb), boards (.board.json) and data files.  The disk's Trash (.Trash/) is
//     left on disk, not shown.  What can't be opened is reported (and stays on disk).
//   - DiskMirror: every change of the workspace becomes a task for the disk the moment it is committed, the reading of
//     its contents initiated then (so a later rename can't change what it writes; not an immutable snapshot: a read
//     that fails is tried again on the contents as they then are, and a move's recovery writes the workspace's
//     current file): a data file's or board's new contents (its op), a
//     notebook's save (docSaved, from the notebook page's "saved"), a folder made, a rename, a move to Trash and
//     back (Workspace/.Trash/), what Trash empties.  The tasks run one at a time, in order; a later write of the
//     same file replaces one still waiting (only the latest contents are written), never across a rename or
//     deletion of it.  The workspace's commit doesn't wait for the disk: what a crash loses is every task still
//     waiting (`pending`, which the page shows as "Saving…"); a quit or a closed window waits for them
//     (drainOnQuit), and so does leaving the page (beforeLeave).
//   - A task that fails (not a conflict) stays first, is tried again (1 s, 2 s, 5 s, 10 s, then every 30 s), and is
//     said to the person, by its file, until it succeeds: nothing after it runs before it.
//   - Every change carries what this page expects the file to be (the size, time and SHA-256 it last read or wrote,
//     or that there is none), checked by disk.rs right before the change.  A file another program changed is never
//     written over, moved or deleted: this page's version goes beside it, as "<name> (from Sagebrush)<ext>" (or
//     "… 2", "… 3": whichever is free, never one that is there), later saves of it go there too, and the person is
//     told.  What is left is the moment between disk.rs's check and its rename.  The check is a file's: a folder's
//     move or removal (emptying Trash) doesn't check what is in it.
// Folders and files are named as in the workspace; Trash, "/Trash", is ".Trash" on disk.
import { TRASH, kindOf, nameOf, parentOf, splitExt, within } from "./paths";
import { notebookFileText, boardFileText } from "./file-bytes";
import { Images } from "../board/images";

export type DiskStat = { path: string; dir: boolean; size: number; mtime: number; sha256?: string | null };
/** What the page expects a file to be (disk.rs Expect). */
export type Expect = "any" | "absent" | DiskStat;
/** The app's disk commands (disk.rs), or a test's.  A refused change's error says CONFLICT. */
export type Disk = {
  list(): Promise<DiskStat[]>;
  stat(p: string): Promise<DiskStat | null>;
  read(p: string): Promise<Uint8Array>;
  write(p: string, bytes: Uint8Array, expect: Expect): Promise<DiskStat | null>;
  mkdir(p: string): Promise<void>;
  rename(from: string, to: string, expect: Expect): Promise<void>;
  remove(p: string, expect: Expect): Promise<void>;
};
export const CONFLICT = "changed by another program";
const isConflict = (e: unknown) => String((e as any)?.message ?? e).includes(CONFLICT);
const expectHeader = (x: Expect) => (typeof x === "string" ? x : `${x.size}:${x.mtime}:${x.sha256}`);

/** The desktop app's: disk.rs through Tauri's IPC. */
export function tauriDisk(invoke: (cmd: string, args?: any, opts?: any) => Promise<any>): Disk {
  return {
    list: () => invoke("disk_list"),
    stat: (path) => invoke("disk_stat", { path }),
    read: async (path) => new Uint8Array(await invoke("disk_read", { path })),
    write: (path, bytes, expect) => invoke("disk_write", bytes, { headers: { "Sagebrush-Path": encodeURIComponent(path), "Sagebrush-Expect": expectHeader(expect) } }),
    mkdir: (path) => invoke("disk_mkdir", { path }),
    rename: (from, to, expect) => invoke("disk_rename", { from, to, expect: expectHeader(expect) }),
    remove: (path, expect) => invoke("disk_remove", { path, expect: expectHeader(expect) }),
  };
}

const DISK_TRASH = "/.Trash";
/** A workspace path's on disk, and back. */
export const toDisk = (p: string) => (within(p, TRASH) ? DISK_TRASH + p.slice(TRASH.length) : p);
export const fromDisk = (p: string) => (within(p, DISK_TRASH) ? TRASH + p.slice(DISK_TRASH.length) : p);

const enc = new TextEncoder(), dec = new TextDecoder();
export async function sha256Hex(b: Uint8Array): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", b))].map((x) => x.toString(16).padStart(2, "0")).join("");
}

/** What the workspace has at `p` as the bytes of its file: a notebook's .ipynb, a board's file (its pictures in it,
 * as Download writes it), a data file's bytes; null for a folder or nothing. */
export async function fileBytes(ws: any, p: string): Promise<Uint8Array | null> {
  const { entry, content } = await ws.read(p);
  if (entry.kind === "notebook") return enc.encode(notebookFileText(content));
  if (entry.kind === "board") {
    const images = new Images();
    try { return enc.encode(await boardFileText(content, images)); } finally { images.dispose(); }
  }
  if (entry.kind === "file") return content instanceof Uint8Array ? content : typeof content === "string" ? enc.encode(content) : new Uint8Array(content);
  return null;
}

/** The disk's tree made in `ws` (an empty workspace: this launch's): folders, then files.  Returns each file's stat
 * as read (with its SHA-256, for DiskMirror), what couldn't be imported and why, and how long it took. */
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
      known.set(e.path, { ...e, sha256: await sha256Hex(b) });
      files++;
      bytes += e.size;
    } catch (err: any) { skipped.push([e.path, err?.message ?? String(err)]); }
  }
  return { known, skipped, files, bytes, ms: Math.round(now() - t0) };
}

type Write = { k: "write"; path: string; bytes: Promise<Uint8Array | null>; capture: () => Promise<Uint8Array | null> };
type Task = Write | { k: "mkdir"; path: string } | { k: "move"; from: string; to: string } | { k: "remove"; path: string };
const touches = (t: Task, p: string) => (t.k === "move" ? within(t.from, p) || within(p, t.from) || within(t.to, p) || within(p, t.to) : !!t.path && (within(t.path, p) || within(p, t.path)));
const RETRY_MS = [1000, 2000, 5000, 10000, 30000];
const isMissing = (e: unknown) => (e as any)?.code === "missing";
/** A write's contents that couldn't be read (as against its disk write failing: then the contents read are kept). */
class CaptureError extends Error {
  constructor(readonly cause: unknown) { super((cause as any)?.message ?? String(cause)); }
}
/** a promise whose rejection is kept for its awaiter, not reported as unhandled meanwhile */
const kept = <T>(p: Promise<T>) => { p.catch(() => {}); return p; };

export type MirrorEvents = {
  /** another program's change kept: `path` on disk, this page's version at `kept` (once it is there) */
  conflict?: (path: string, kept: string) => void;
  /** a task failed (it stays first and is tried again), or (`e` null) the failures are over */
  error?: (path: string, e: unknown) => void;
  /** how many tasks wait (coalesced: a file's writes one task) */
  pending?: (n: number) => void;
  /** what it knows changed (after a task: kept for the launch's next page) */
  state?: (m: DiskMirror) => void;
};
export type MirrorState = { known: [string, DiskStat][]; redirect: [string, string][] };

/** The mirror's state kept for the launch's next page, in the window's IndexedDB (with the workspace it describes;
 * the web view keeps it for the launch only). */
export const idbState = {
  open(): Promise<IDBDatabase> {
    return new Promise((ok, no) => { const r = indexedDB.open("sagebrush-disk", 1); r.onupgradeneeded = () => r.result.createObjectStore("kv"); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
  },
  async load(): Promise<MirrorState | null> {
    const db = await this.open();
    try { return await new Promise((ok, no) => { const q = db.transaction("kv").objectStore("kv").get("state"); q.onsuccess = () => ok(q.result ?? null); q.onerror = () => no(q.error); }); } finally { db.close(); }
  },
  async save(st: MirrorState): Promise<void> {
    const db = await this.open();
    try { await new Promise<void>((ok, no) => { const tx = db.transaction("kv", "readwrite"); tx.objectStore("kv").put(st, "state"); tx.oncomplete = () => ok(); tx.onerror = () => no(tx.error); }); } finally { db.close(); }
  },
};

/** A later page of the launch (the workspace already this launch's): the files on disk that changed since this launch
 * last read or wrote them (their size or modification time not the kept ones), or that weren't known, imported, the
 * disk's contents winning, as at the launch's start; what is kept updated.  (A change keeping both size and time isn't
 * seen here; disk.rs still sees it by its SHA-256 before anything is written over it.) */
export async function reconcileDisk(ws: any, disk: Disk, st: MirrorState): Promise<{ known: Map<string, DiskStat>; imported: string[]; skipped: [string, string][] }> {
  const known = new Map(st.known), imported: string[] = [], skipped: [string, string][] = [];
  const redirected = new Set(st.redirect.map(([, side]) => side));
  for (const e of await disk.list()) {
    if (e.dir || within(e.path, DISK_TRASH) || redirected.has(e.path)) continue;
    const k = known.get(e.path);
    if (k && k.size === e.size && k.mtime === e.mtime) continue;
    try {
      const b = await disk.read(e.path), kind = kindOf(e.path);
      const content = kind === "file" ? b : JSON.parse(dec.decode(b));
      if (await ws.stat(e.path)) await ws.write(e.path, content); else await ws.create(e.path, { content });
      known.set(e.path, { ...e, sha256: await sha256Hex(b) });
      imported.push(e.path);
    } catch (err: any) { skipped.push([e.path, err?.message ?? String(err)]); }
  }
  return { known, imported, skipped };
}

export class DiskMirror {
  private q: Task[] = [];
  private running = false;
  private started = false;
  private stop: (() => void) | null = null;
  // (the drains waiting for the queue to empty: each removes itself when it gives up, so nothing is kept per wait)
  private idle = new Set<() => void>();
  private tries = 0;
  /** the disk path a workspace path is written to: itself, or its "(from Sagebrush)" copy after a conflict */
  private redirect = new Map<string, string>();
  /** the last failure: [file, error], while there is one */
  failing: [string, unknown] | null = null;
  /** what it knows, kept for the launch's next page (diskWorkspace: idbState), the latest of it: resolves once it is,
   * rejects if that failed (keepAll waits for it) */
  persist: () => Promise<void> = async () => {};
  /** `known`: each file's stat as this page last read or wrote it (importDisk's, then each write's). */
  constructor(private ws: any, private disk: Disk, private known: Map<string, DiskStat>, public on: MirrorEvents = {}, private sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)), redirect: [string, string][] = []) {
    this.redirect = new Map(redirect);
  }
  /** What this page knows of the disk (each file as it last read or wrote it, and the conflicts' copies), for the
   * launch's next page (diskState): never rebuilt from the disk, which another program may have changed. */
  state(): MirrorState { return { known: [...this.known], redirect: [...this.redirect] }; }

  start() {
    this.stop = this.ws.watch((c: { ops: any[] }) => { for (const op of c.ops ?? []) this.op(op); });
    return this;
  }
  close() { this.stop?.(); this.stop = null; }
  /** How many tasks wait (coalesced). */
  get pending() { return this.q.length; }

  private changed() {
    this.on.pending?.(this.q.length);
    if (!this.q.length && !this.running) { const w = [...this.idle]; this.idle.clear(); for (const f of w) f(); }
  }
  /** What it knows of the disk changed (a file written, moved or removed, a conflict's copy): for the launch's next
   * page (on.state).  A task waiting or done changes nothing here. */
  private knew() { this.on.state?.(this); }
  /** How many drains wait (tests). */
  get waiting() { return this.idle.size; }

  /** A notebook's save (its id): its file's contents, read now, written.  (Its path is read with them; once known, the
   * task merges into a write of that file still waiting, as add does.)  A notebook that isn't in the workspace (one
   * opened from a file on the computer) has nothing to write here. */
  docSaved(ref: string) {
    const slot: Write = { k: "write", path: "", bytes: Promise.resolve(null), capture: async () => {
      const p: string | undefined = await this.ws.pathOf("notebook", ref);
      if (!p) return null;
      slot.path = p;
      return fileBytes(this.ws, p);
    } };
    slot.bytes = kept(slot.capture());
    this.q.push(slot);
    this.changed();
    void slot.bytes.then(() => {
      const i = this.q.indexOf(slot);
      if (i < 0 || !slot.path) return;
      for (let j = i - 1; j >= (this.running && this.started ? 1 : 0); j--) {
        const u = this.q[j];
        if (!touches(u, slot.path)) continue;
        if (u.k === "write" && u.path === slot.path) { u.bytes = slot.bytes; u.capture = slot.capture; this.q.splice(i, 1); this.changed(); }
        break;
      }
    }, () => {});
    this.pump();
  }

  /** Resolves true once no task waits (tasks added meanwhile waited for too), false at `timeoutMs`. */
  async drain(timeoutMs: number): Promise<boolean> {
    if (!this.q.length && !this.running) return true;
    return new Promise<boolean>((r) => {
      const done = () => { clearTimeout(timer); r(true); };
      const timer = setTimeout(() => { this.idle.delete(done); r(false); }, Math.max(0, timeoutMs));
      this.idle.add(done);
    });
  }

  private add(t: Task) {
    // (a write of a file whose earlier write still waits, nothing about that file between them: that one's contents
    // replaced, in its place)
    if (t.k === "write") {
      for (let i = this.q.length - 1; i >= (this.running && this.started ? 1 : 0); i--) {
        const u = this.q[i];
        if (!touches(u, t.path)) continue;
        if (u.k === "write" && u.path === t.path) { u.bytes = t.bytes; u.capture = t.capture; this.changed(); return; }
        break;
      }
    }
    this.q.push(t);
    this.changed();
    this.pump();
  }
  private write(p: string): Write {
    const capture = () => fileBytes(this.ws, p);
    return { k: "write", path: p, bytes: kept(capture()), capture };
  }

  private op(op: any) {
    if (op.origin === "server") return;
    const p: string = op.path, to: string | undefined = op.to;
    switch (op.op) {
      case "create":
      case "adopt":
      case "write":
        if (op.kind === "folder") return this.add({ k: "mkdir", path: p });
        return this.add(this.write(p));
      case "mkdir":
        return this.add({ k: "mkdir", path: p });
      case "rename":
      case "remove":
      case "restore":
        if (to) return this.add({ k: "move", from: p, to });
        return;
      case "emptyTrash":
      case "discard":
      case "forget":
        if (within(p, TRASH) && p !== TRASH) return this.add({ k: "remove", path: p });
        return;
    }
  }

  private async pump() {
    if (this.running) return;
    this.running = true;
    this.changed();
    try {
      while (this.q.length) {
        const t = this.q[0];
        this.started = true;
        try {
          await this.run(t);
          this.q.shift();
          this.tries = 0;
          if (this.failing) { this.failing = null; this.on.error?.("", null); }
        } catch (e) {
          // (a file's contents that can't be read any more because a later task renames or removes it: that task
          // writes it where it went; else the failure stays first, said, and is tried again, its contents read again)
          if (t.k === "write" && e instanceof CaptureError && isMissing(e.cause) && this.q.slice(1).some((u) => u.k !== "write" && touches(u, t.path))) { this.q.shift(); continue; }
          this.failing = [t.k === "move" ? t.from : t.path || "a notebook", e];
          this.on.error?.(this.failing[0], e);
          await this.sleep(RETRY_MS[Math.min(this.tries++, RETRY_MS.length - 1)]);
          // (only contents that couldn't be read are read again: contents read are kept, whatever happens to the file)
          if (t.k === "write" && e instanceof CaptureError) t.bytes = kept(t.capture());
        } finally {
          this.started = false;
          this.changed();
        }
      }
    } finally {
      this.running = false;
      this.changed();
    }
  }

  private at(p: string) { const d = toDisk(p); return this.redirect.get(d) ?? d; }
  /** The redirects of `p` and what is in it ended, and what this page knew of the files there (it was moved or
   * removed: a file made there later is a new one). */
  private unredirect(p: string) {
    const d = toDisk(p);
    for (const k of [...this.redirect.keys()]) if (within(k, d)) this.redirect.delete(k);
    for (const k of [...this.known.keys()]) if (within(k, d)) this.known.delete(k);
    this.knew();
  }
  private expect(d: string): Expect { return this.known.get(d) ?? "absent"; }

  /** A free name beside `d`: "<name> (from Sagebrush)<ext>", "… 2", … (never one that is there). */
  private async beside(d: string): Promise<string> {
    const [base, ext] = splitExt(nameOf(d)), dir = parentOf(d) === "/" ? "" : parentOf(d);
    for (let i = 1; ; i++) {
      const c = `${dir}/${base} (from Sagebrush${i > 1 ? " " + i : ""})${ext}`;
      if (!(await this.disk.stat(c))) return c;
    }
  }

  /** `bytes` written as disk path `d0` (or where its writes now go): if another program changed the file, beside it
   * instead, and its later writes there too; the person told once that copy is there. */
  private async writeAt(d0: string, bytes: Uint8Array) {
    let d = this.redirect.get(d0) ?? d0;
    for (;;) {
      try {
        const st = await this.disk.write(d, bytes, this.expect(d));
        if (st) this.known.set(d, { ...st, sha256: st.sha256 ?? (await sha256Hex(bytes)) });
        this.knew();
        if (d !== d0 && !this.told.has(d)) { this.told.add(d); this.on.conflict?.(d0, d); }
        return;
      } catch (e) {
        if (!isConflict(e)) throw e;
        d = await this.beside(d0);
        this.redirect.set(d0, d);
      }
    }
  }
  private told = new Set<string>();

  private async run(t: Task) {
    if (t.k === "mkdir") return this.disk.mkdir(toDisk(t.path));
    if (t.k === "write") {
      let bytes: Uint8Array | null;
      try { bytes = await t.bytes; } catch (e) { throw new CaptureError(e); }
      if (bytes && t.path) await this.writeAt(toDisk(t.path), bytes);
      return;
    }
    if (t.k === "move") {
      const from = this.at(t.from), to = toDisk(t.to);
      const st = await this.disk.stat(from);
      try {
        if (!st) throw new Error(CONFLICT);
        await this.disk.rename(from, to, st.dir ? "any" : this.expect(from));
      } catch (e) {
        if (!isConflict(e)) throw e;
        // (gone, changed by another program, or something at the destination: nothing moved there; the workspace's
        // file, if it is one, written where the workspace now has it, or beside that, and the person told)
        if (st?.dir) { this.unredirect(t.from); this.on.conflict?.(from, from); return; }
        const bytes = await fileBytes(this.ws, t.to);
        this.unredirect(t.from);
        if (bytes) await this.writeAt(to, bytes);
        if (!this.told.has(to)) this.on.conflict?.(from, this.redirect.get(to) ?? to);
        return;
      }
      for (const [k, v] of [...this.known]) if (within(k, from)) { this.known.delete(k); this.known.set(to + k.slice(from.length), v); }
      this.unredirect(t.from);
      return;
    }
    if (t.k === "remove") {
      // (emptying Trash: a person's explicit deletion; a file changed by another program meanwhile is kept, but a
      // folder's contents are deleted whatever they are: its files aren't checked one by one)
      const d = this.at(t.path), st = await this.disk.stat(d);
      try {
        await this.disk.remove(d, st?.dir ? "any" : this.expect(d));
      } catch (e) {
        if (!isConflict(e)) throw e;
        this.unredirect(t.path);
        this.on.conflict?.(d, d);
        return;
      }
      this.unredirect(t.path);
      for (const k of [...this.known.keys()]) if (within(k, d)) this.known.delete(k);
    }
  }
}

// ---- the page's side: the banner, the launch's import, a quit or a page left waiting for the disk

/** The banner of the app's window, for what the person must know about the disk: the latest of each kind (a
 * failure, which stays until it's over; a conflict or a report, which stays until dismissed). */
export function diskBanner(doc: Document = document) {
  let el = doc.getElementById("sb-disk-banner");
  if (!el) {
    el = Object.assign(doc.createElement("div"), { id: "sb-disk-banner", role: "alert" });
    el.style.cssText = "position:fixed;left:0;right:0;top:0;z-index:2147483000;background:#7a2a12;color:#fff;font:14px system-ui,sans-serif;padding:6px 12px;display:none";
    doc.body.append(el);
  }
  const lines = new Map<string, string>();
  const draw = () => {
    el!.replaceChildren(...[...lines].map(([k, text]) => {
      const row = doc.createElement("div");
      row.dataset.kind = k;
      row.append(text + " ");
      if (k !== "error") {
        const x = Object.assign(doc.createElement("button"), { textContent: "Dismiss" });
        x.onclick = () => { lines.delete(k); draw(); };
        row.append(x);
      }
      return row;
    }));
    el!.style.display = lines.size ? "block" : "none";
  };
  return { set(kind: "error" | "conflict" | "report" | "settings", text: string | null) { if (text) lines.set(kind, text); else lines.delete(kind); draw(); }, el };
}

/** "Saving…" at the window's lower right while changes wait for the disk. */
export function savingPill(doc: Document = document) {
  return (n: number) => {
    let el = doc.getElementById("sb-disk-saving");
    if (!el) {
      el = Object.assign(doc.createElement("div"), { id: "sb-disk-saving", role: "status" });
      el.style.cssText = "position:fixed;right:10px;bottom:10px;z-index:2147483000;background:#333;color:#fff;font:12px system-ui,sans-serif;padding:3px 8px;border-radius:10px;opacity:.85";
      doc.body.append(el);
    }
    el.textContent = n ? `Saving… (${n})` : "";
    el.style.display = n ? "block" : "none";
  };
}

/** One write of the mirror's state at a time, always of its latest: a change while one is written makes one more
 * (never a queue of snapshots); `flush` resolves once the latest is written, or rejects with the last failure. */
export function stateSaver(save: (st: MirrorState) => Promise<void>) {
  let get: (() => MirrorState) | null = null, running: Promise<void> | null = null, failed: unknown = null;
  const run = async () => {
    while (get) {
      const st = get();
      get = null;
      try { await save(st); failed = null; } catch (e) { failed = e; console.warn("disk state:", e); }
    }
    running = null;
  };
  return {
    dirty(f: () => MirrorState) { get = f; if (!running) running = run(); },
    async flush() { while (running) await running; if (failed) throw failed; },
  };
}

const IMPORTED = "sb-disk-imported";
/** The desktop app's page: the disk's tree imported at the launch's first page (sessionStorage, kept by the window for
 * the launch, says it was), then every change written through, failures and conflicts on the banner, "Saving…" said
 * through `saving(n)`.  Throws if the disk can't be read at all (the page then refuses to save: nothing is kept). */
export async function diskWorkspace(ws: any, invoke: (cmd: string, args?: any, opts?: any) => Promise<any>, saving: (n: number) => void = savingPill()): Promise<DiskMirror> {
  const disk = tauriDisk(invoke), banner = diskBanner();
  // (a self-test's control, app/selftest/run.mjs: the import, or the write-through, left out, so that its two-launch
  // check is seen to fail without them; lib.rs sets it only in a self-test)
  const control = (window as any).__SB_DISK_CONTROL__;
  let known: Map<string, DiskStat> | undefined;
  if (control === "no-import") { known = new Map(); sessionStorage.setItem(IMPORTED, "1"); }
  else if (!sessionStorage.getItem(IMPORTED)) {
    const r = await importDisk(ws, disk);
    known = r.known;
    sessionStorage.setItem(IMPORTED, "1");
    console.log(`disk: imported ${r.files} files (${r.bytes} bytes) in ${r.ms} ms`);
    if (r.skipped.length) banner.set("report", `${r.skipped.length} of the files in Sagebrush's folder couldn't be opened and aren't shown (they are still on disk): ${r.skipped.slice(0, 3).map(([p, why]) => `${p} (${why})`).join(", ")}${r.skipped.length > 3 ? ", …" : ""}`);
  }
  let redirect: [string, string][] = [];
  if (control !== "no-import" && known === undefined) {
    // (a later page of the launch: what the launch knows, from the window's IndexedDB, and the disk's changes since)
    const st = (await idbState.load().catch(() => null)) ?? { known: [], redirect: [] };
    const r = await reconcileDisk(ws, disk, st);
    known = r.known;
    redirect = st.redirect;
    if (r.imported.length) banner.set("report", `Changed by another program, and brought in: ${r.imported.slice(0, 3).join(", ")}${r.imported.length > 3 ? ", …" : ""}`);
    if (r.skipped.length) banner.set("report", `${r.skipped.length} changed files in Sagebrush's folder couldn't be opened: ${r.skipped.slice(0, 3).map(([p, why]) => `${p} (${why})`).join(", ")}`);
  }
  const saver = stateSaver((st) => idbState.save(st));
  const m = new DiskMirror(ws, disk, known!, {
    state: (mm) => saver.dirty(() => mm.state()),
    conflict: (p, kept) => banner.set("conflict", p === kept ? `${p} was changed by another program, so Sagebrush didn't change it.` : `${p} was changed by another program, so it wasn't written over: Sagebrush's version is ${kept}.`),
    error: (p, e) => banner.set("error", e === null ? null : `Couldn't save ${p} to disk: ${(e as any)?.message ?? e}. Trying again…`),
    pending: saving,
  }, undefined, redirect);
  if (control !== "no-write") m.start();
  m.persist = () => saver.flush();
  saver.dirty(() => m.state());
  (window as any).__sbDiskError = (what: string, e: unknown) => banner.set("settings", e ? `Couldn't save ${what}: ${(e as any)?.message ?? e}` : null);
  // (settings.json that couldn't be read when the app started: kept aside, said; disk.rs settings_script)
  const problem = (window as any).__sbSettingsProblem;
  if (typeof problem === "string" && problem) banner.set("report", problem);
  return m;
}

/** Everything this page hasn't kept yet, made and written, within `ms`: the editor's own save (`flushEditor`), the
 * settings, then every change on disk.  What isn't, and why (`not`: [] if all is kept), and how many unsaved items
 * that is (`count`: each change still waiting for the disk, and the editor's save or the settings if not done). */
export async function keepAll(m: DiskMirror | null, flushEditor: (() => Promise<unknown>) | undefined, ms: number): Promise<{ not: string[]; count: number }> {
  const end = Date.now() + ms, left = () => Math.max(0, end - Date.now()), not: string[] = [];
  const step = async (what: string, f: () => unknown) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const r = await Promise.race([Promise.resolve().then(f).then(() => "done", (e) => `${what}: ${(e as any)?.message ?? e}`), new Promise<string>((r) => (timer = setTimeout(() => r(`${what}: still not done`), left())))]);
      if (r !== "done") not.push(r);
    } finally { clearTimeout(timer); }
  };
  if (flushEditor) await step("the open document's last change", flushEditor);
  await step("the settings", () => (window as any).__sbSettingsFlush?.());
  let count = not.length;
  if (m && !(await m.drain(left()))) {
    not.push(`${m.pending} change${m.pending === 1 ? "" : "s"} to files${m.failing ? `: ${(m.failing[1] as any)?.message ?? m.failing[1]}` : ""}`);
    count += m.pending;
  } else if (m) {
    // (and what the launch knows of them, for its next page)
    const before = not.length;
    await step("the record of the files on disk", () => m.persist());
    count += not.length - before;
  }
  return { not, count };
}

/** Before the page is left (another page of the app): everything kept first (keepAll).  True if it is; false, and
 * the person told on the banner, if not within `timeoutMs`: the page stays. */
export async function beforeLeave(m: DiskMirror | null, flushEditor?: () => Promise<unknown>, timeoutMs = 10000): Promise<boolean> {
  const { not, count } = await keepAll(m, flushEditor, timeoutMs);
  if (not.length) diskBanner().set("error", `Not saved yet (${count}), so this page stays open: ${not.join("; ")}.`);
  return !not.length;
}

/** A quit, or the window's close (lib.rs ask_quit): new changes stopped (`freeze`: the page's content, never this
 * dialog, which is outside the page's body), then everything kept (keepAll), the whole of it within `timeoutMs`; then
 * the app quits.  If anything isn't kept by then, the person chooses: wait (and try again), or quit and lose it,
 * each thing named (never a quit that says nothing). */
export function drainOnQuit(opts: { mirror: () => DiskMirror | null; invoke: (cmd: string, args?: any) => Promise<any>; listen: (ev: string, f: () => void) => unknown; freeze: () => void; flushEditor?: () => Promise<unknown>; timeoutMs?: number }) {
  let busy = false;
  opts.listen("sb-quit", async () => {
    if (busy) return;
    busy = true;
    await opts.invoke("app_quit_hold").catch(() => {});
    const shade = Object.assign(document.createElement("div"), { id: "sb-quitting", role: "alertdialog" });
    shade.setAttribute("aria-modal", "true");
    shade.style.cssText = "position:fixed;inset:0;z-index:2147483001;background:rgba(0,0,0,.35);display:flex;align-items:center;justify-content:center;font:15px system-ui,sans-serif";
    const box = Object.assign(document.createElement("div"), { textContent: "Saving your changes…" });
    box.style.cssText = "background:#fff;color:#222;padding:16px 20px;border-radius:8px;max-width:32em";
    shade.append(box);
    // (beside the body, not in it: a page that freezes by making its body inert leaves this dialog working)
    document.documentElement.append(shade);
    try { opts.freeze(); } catch {}
    for (;;) {
      const { not, count } = await keepAll(opts.mirror(), opts.flushEditor, opts.timeoutMs ?? 10000);
      if (!not.length) break;
      box.replaceChildren(`Not saved yet (${count}): ${not.join("; ")}. `);
      const choice = await new Promise<"wait" | "quit">((r) => {
        const wait = Object.assign(document.createElement("button"), { textContent: "Wait" });
        const quit = Object.assign(document.createElement("button"), { textContent: `Quit and lose ${count} unsaved item${count === 1 ? "" : "s"}` });
        wait.onclick = () => r("wait");
        quit.onclick = () => r("quit");
        box.append(wait, " ", quit);
        wait.focus();
      });
      if (choice === "quit") break;
      box.replaceChildren("Saving your changes…");
    }
    await opts.invoke("app_quit_now");
  });
}
