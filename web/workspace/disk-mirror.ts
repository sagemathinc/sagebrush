// The desktop app's workspace on disk (app/src-tauri/src/disk.rs; design: the native-storage note, approved Nov 17):
// the documents and files are real files under Workspace/ in the app's data folder, the canonical copy; this page's
// workspace (IndexedDB, in a web view that keeps nothing between launches) is a cache of them for one launch.
//   - importDisk: at the launch's first page, the tree on disk is made in the (empty) workspace, through its own
//     verbs: folders, then notebooks (.ipynb), boards (.board.json) and data files.  The disk's Trash (.Trash/) is
//     left on disk, not shown.  What can't be opened is reported (and stays on disk).
//   - DiskMirror: every change of the workspace becomes a task for the disk the moment it is committed, its contents
//     read then (so a later rename can't change what it writes): a data file's or board's new contents (its op), a
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
//     told.  What is left is the moment between disk.rs's check and its rename.
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

type Task =
  | { k: "write"; path: string; bytes: Promise<Uint8Array | null> }
  | { k: "mkdir"; path: string }
  | { k: "move"; from: string; to: string }
  | { k: "remove"; path: string };
const touches = (t: Task, p: string) => (t.k === "move" ? within(t.from, p) || within(p, t.from) || within(t.to, p) || within(p, t.to) : within(t.path, p) || within(p, t.path));
const RETRY_MS = [1000, 2000, 5000, 10000, 30000];

export type MirrorEvents = {
  /** another program's change kept: `path` on disk, this page's version at `kept` */
  conflict?: (path: string, kept: string) => void;
  /** a task failed (it stays first and is tried again), or (`e` null) the failures are over */
  error?: (path: string, e: unknown) => void;
  /** how many tasks wait (0: all on disk) */
  pending?: (n: number) => void;
};

export class DiskMirror {
  private q: Task[] = [];
  private running = false;
  private started = false;
  private stop: (() => void) | null = null;
  private idle: (() => void)[] = [];
  private tries = 0;
  /** the disk path a workspace path is written to: itself, or its "(from Sagebrush)" copy after a conflict */
  private redirect = new Map<string, string>();
  /** the last failure: [file, error], while there is one */
  failing: [string, unknown] | null = null;
  /** `known`: each file's stat as this page last read or wrote it (importDisk's, then each write's). */
  constructor(private ws: any, private disk: Disk, private known: Map<string, DiskStat>, private on: MirrorEvents = {}, private sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))) {}

  start() {
    this.stop = this.ws.watch((c: { ops: any[] }) => { for (const op of c.ops ?? []) this.op(op); });
    return this;
  }
  close() { this.stop?.(); this.stop = null; }
  /** How many tasks wait. */
  get pending() { return this.q.length; }

  /** A notebook's save (its id): its file's contents, read now, written. */
  docSaved(ref: string) {
    // (a task in the order of the save, its path and contents read now; once its path is known, merged into a
    // write of that file still waiting, as add does)
    const path: Promise<string | undefined> = this.ws.pathOf("notebook", ref).catch(() => undefined);
    const slot = { k: "write" as const, path: "", bytes: path.then((p) => (p ? fileBytes(this.ws, p).catch(() => null) : null)) };
    this.q.push(slot);
    this.on.pending?.(this.q.length);
    void path.then((p) => {
      const i = this.q.indexOf(slot);
      if (i < 0) return;
      if (!p) this.q.splice(i, 1);
      else {
        slot.path = p;
        for (let j = i - 1; j >= (this.running && this.started ? 1 : 0); j--) {
          const u = this.q[j];
          if (!touches(u, p)) continue;
          if (u.k === "write" && u.path === p) { u.bytes = slot.bytes; this.q.splice(i, 1); }
          break;
        }
      }
      this.on.pending?.(this.q.length);
      this.pump();
    });
  }

  /** Resolves true once no task waits (rechecked until quiet: tasks added meanwhile are waited for too), false at
   * `timeoutMs`. */
  async drain(timeoutMs: number): Promise<boolean> {
    const end = Date.now() + timeoutMs;
    while (this.q.length || this.running) {
      const left = end - Date.now();
      if (left <= 0) return false;
      await Promise.race([new Promise<void>((r) => this.idle.push(r)), this.sleep(Math.min(left, 250))]);
    }
    return true;
  }

  private add(t: Task) {
    // (a write of a file whose earlier write still waits, nothing about that file between them: that one's contents
    // replaced, in its place)
    if (t.k === "write") {
      for (let i = this.q.length - 1; i >= (this.running && this.started ? 1 : 0); i--) {
        const u = this.q[i];
        if (!touches(u, t.path)) continue;
        if (u.k === "write" && u.path === t.path) { u.bytes = t.bytes; this.on.pending?.(this.q.length); return; }
        break;
      }
    }
    this.q.push(t);
    this.on.pending?.(this.q.length);
    this.pump();
  }

  private op(op: any) {
    if (op.origin === "server") return;
    const p: string = op.path, to: string | undefined = op.to;
    switch (op.op) {
      case "create":
      case "adopt":
      case "write":
        if (op.kind === "folder") return this.add({ k: "mkdir", path: p });
        return this.add({ k: "write", path: p, bytes: fileBytes(this.ws, p).catch(() => null) });
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
    try {
      while (this.q.length) {
        const t = this.q[0];
        if (t.k === "write" && !t.path) break; // (a notebook's save whose path isn't known yet)
        this.started = true;
        try {
          await this.run(t);
          this.q.shift();
          this.tries = 0;
          if (this.failing) { this.failing = null; this.on.error?.("", null); }
        } catch (e) {
          this.failing = [t.k === "move" ? t.from : t.path, e];
          this.on.error?.(this.failing[0], e);
          await this.sleep(RETRY_MS[Math.min(this.tries++, RETRY_MS.length - 1)]);
        } finally {
          this.started = false;
          this.on.pending?.(this.q.length);
        }
      }
    } finally {
      this.running = false;
      if (!this.q.length) for (const r of this.idle.splice(0)) r();
    }
  }

  private at(p: string) { const d = toDisk(p); return this.redirect.get(d) ?? d; }
  private expect(d: string): Expect { return this.known.get(d) ?? "absent"; }

  /** A free name beside `d`: "<name> (from Sagebrush)<ext>", "… 2", … (never one that is there). */
  private async beside(d: string): Promise<string> {
    const [base, ext] = splitExt(nameOf(d)), dir = parentOf(d) === "/" ? "" : parentOf(d);
    for (let i = 1; ; i++) {
      const c = `${dir}/${base} (from Sagebrush${i > 1 ? " " + i : ""})${ext}`;
      if (!(await this.disk.stat(c))) return c;
    }
  }

  /** `bytes` written as disk path `d` (or where its writes now go): if another program changed the file, beside it
   * instead, and its later writes there too. */
  private async writeAt(d0: string, bytes: Uint8Array) {
    let d = this.redirect.get(d0) ?? d0;
    for (;;) {
      try {
        const st = await this.disk.write(d, bytes, this.expect(d));
        if (st) this.known.set(d, { ...st, sha256: st.sha256 ?? (await sha256Hex(bytes)) });
        return;
      } catch (e) {
        if (!isConflict(e)) throw e;
        const side = await this.beside(d0);
        this.redirect.set(d0, side);
        this.on.conflict?.(d0, side);
        d = side;
      }
    }
  }

  private async run(t: Task) {
    if (t.k === "mkdir") return this.disk.mkdir(toDisk(t.path));
    if (t.k === "write") {
      const bytes = await t.bytes;
      if (bytes) await this.writeAt(toDisk(t.path), bytes);
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
        // (gone, changed by another program, or something at the destination: nothing moved there, and the person
        // told; the workspace's file, if it is one, written where the workspace now has it, or beside that)
        this.on.conflict?.(from, to);
        if (!st?.dir) { const bytes = await fileBytes(this.ws, t.to).catch(() => null); if (bytes) await this.writeAt(to, bytes); }
        return;
      }
      this.redirect.delete(toDisk(t.from));
      for (const [k, v] of [...this.known]) if (within(k, from)) { this.known.delete(k); this.known.set(to + k.slice(from.length), v); }
      return;
    }
    if (t.k === "remove") {
      const d = this.at(t.path), st = await this.disk.stat(d);
      try {
        await this.disk.remove(d, st?.dir ? "any" : this.expect(d));
      } catch (e) {
        if (!isConflict(e)) throw e;
        this.on.conflict?.(d, d);
        return;
      }
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

const IMPORTED = "sb-disk-imported";
/** The desktop app's page: the disk's tree imported at the launch's first page (sessionStorage, kept by the window for
 * the launch, says it was), then every change written through, failures and conflicts on the banner, "Saving…" said
 * through `saving(n)`.  Throws if the disk can't be read at all (the page then refuses to save: nothing is kept). */
export async function diskWorkspace(ws: any, invoke: (cmd: string, args?: any, opts?: any) => Promise<any>, saving: (n: number) => void = savingPill()): Promise<DiskMirror> {
  const disk = tauriDisk(invoke), banner = diskBanner();
  // (a self-test's control, app/selftest/run.mjs: the import, or the write-through, left out, so that its two-launch
  // check is seen to fail without them; lib.rs sets it only in a self-test)
  const control = (window as any).__SB_DISK_CONTROL__;
  let known: Map<string, DiskStat>;
  if (control === "no-import") { known = new Map(); sessionStorage.setItem(IMPORTED, "1"); }
  else if (!sessionStorage.getItem(IMPORTED)) {
    const r = await importDisk(ws, disk);
    known = r.known;
    sessionStorage.setItem(IMPORTED, "1");
    console.log(`disk: imported ${r.files} files (${r.bytes} bytes) in ${r.ms} ms`);
    if (r.skipped.length) banner.set("report", `${r.skipped.length} of the files in Sagebrush's folder couldn't be opened and aren't shown (they are still on disk): ${r.skipped.slice(0, 3).map(([p, why]) => `${p} (${why})`).join(", ")}${r.skipped.length > 3 ? ", …" : ""}`);
  } else {
    known = new Map();
    for (const e of await disk.list()) if (!e.dir) { const st = await disk.stat(e.path); if (st) known.set(e.path, st); }
  }
  const m = new DiskMirror(ws, disk, known, {
    conflict: (p, kept) => banner.set("conflict", p === kept ? `${p} was changed by another program, so Sagebrush didn't change it.` : `${p} was changed by another program, so it wasn't written over: Sagebrush's version is ${kept}.`),
    error: (p, e) => banner.set("error", e === null ? null : `Couldn't save ${p} to disk: ${(e as any)?.message ?? e}. Trying again…`),
    pending: saving,
  });
  if (control !== "no-write") m.start();
  (window as any).__sbDiskError = (what: string, e: unknown) => banner.set("settings", e ? `Couldn't save ${what}: ${(e as any)?.message ?? e}` : null);
  return m;
}

/** Before the page is left (another page of the app): every change written first, the editor's own saves before.
 * True if all are on disk; false (and the person told, on the banner) if they aren't within `timeoutMs`. */
export async function beforeLeave(m: DiskMirror | null, flushEditor: () => Promise<unknown> = async () => {}, timeoutMs = 10000): Promise<boolean> {
  if (!m) return true;
  try { await flushEditor(); } catch {}
  const ok = await m.drain(timeoutMs);
  if (!ok) diskBanner().set("error", `Still saving ${m.pending} change${m.pending === 1 ? "" : "s"} to disk${m.failing ? `: ${(m.failing[1] as any)?.message ?? m.failing[1]}` : ""}. Wait for it before leaving this page.`);
  return ok;
}

/** A quit, or the window's close (disk.rs's app, lib.rs ask_quit): new changes stopped (`freeze`), the editor's own
 * saves made, the settings written, then every change written to disk; then the app quits.  If that takes longer
 * than `timeoutMs`, the person chooses: wait, or quit and lose those changes (never a quit that says nothing). */
export function drainOnQuit(opts: { mirror: () => DiskMirror | null; invoke: (cmd: string, args?: any) => Promise<any>; listen: (ev: string, f: () => void) => unknown; freeze: () => void; flushEditor?: () => Promise<unknown>; timeoutMs?: number }) {
  let busy = false;
  opts.listen("sb-quit", async () => {
    if (busy) return;
    busy = true;
    await opts.invoke("app_quit_hold").catch(() => {});
    opts.freeze();
    const shade = Object.assign(document.createElement("div"), { id: "sb-quitting" });
    shade.style.cssText = "position:fixed;inset:0;z-index:2147483001;background:rgba(0,0,0,.35);display:flex;align-items:center;justify-content:center;font:15px system-ui,sans-serif";
    const box = Object.assign(document.createElement("div"), { textContent: "Saving your changes…" });
    box.style.cssText = "background:#fff;color:#222;padding:16px 20px;border-radius:8px;max-width:30em";
    shade.append(box);
    document.body.append(shade);
    try { await opts.flushEditor?.(); } catch {}
    try { await (window as any).__sbSettingsFlush?.(); } catch {}
    const m = opts.mirror();
    for (;;) {
      if (!m || (await m.drain(opts.timeoutMs ?? 10000))) break;
      const why = m.failing ? `: ${(m.failing[1] as any)?.message ?? m.failing[1]}` : "";
      const n = m.pending;
      box.replaceChildren(`Still saving ${n} change${n === 1 ? "" : "s"} to disk${why}. `);
      const choice = await new Promise<"wait" | "quit">((r) => {
        const wait = Object.assign(document.createElement("button"), { textContent: "Wait" });
        const quit = Object.assign(document.createElement("button"), { textContent: `Quit and lose ${n} change${n === 1 ? "" : "s"}` });
        wait.onclick = () => r("wait");
        quit.onclick = () => r("quit");
        box.append(wait, " ", quit);
      });
      if (choice === "quit") break;
      box.replaceChildren("Saving your changes…");
    }
    await opts.invoke("app_quit_now");
  });
}
