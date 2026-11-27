// The desktop app's workspace on disk (app/src-tauri/src/disk.rs; design: the native-storage note, approved Nov 17):
// the documents and files are real files under Workspace/ in the app's data folder, the canonical copy; this page's
// workspace (IndexedDB, in a web view that keeps nothing between launches) is a cache of them for one launch.
//   - importDisk: at the launch's first page, the tree on disk is made in the (empty) workspace, through its own
//     verbs: the disk's Trash (.Trash/) into Trash, then folders, then notebooks (.ipynb), boards (.board.json) and
//     data files.  What can't be opened is reported (and stays on disk).
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
//     said to the person, by its file, until it succeeds: nothing after it runs before it.  A task that can never
//     succeed (a name the disk can't keep even escaped: over 255 bytes) is left out and said, and the rest go on.
//   - Every change carries what this page expects the file to be (the size, time and SHA-256 it last read or wrote,
//     or that there is none), checked by disk.rs right before the change.  A file another program changed is never
//     written over, moved or deleted: this page's version goes beside it, as "<name> (from Sagebrush)<ext>" (or
//     "… 2", "… 3": whichever is free, never one that is there), later saves of it go there too, and the person is
//     told.  What is left is the moment between disk.rs's check and its rename.  The check is a file's: a folder's
//     move or removal (emptying Trash) doesn't check what is in it.
//   - The app's other windows (#1541) each have a workspace of their own, a cache of the same disk: a change one of
//     them writes is told to the rest (disk.rs "sb-disk-changed"), and each reads the disk again (pull, a task in its
//     queue, so never in the middle of its own writes), the disk's contents winning, as at a launch's start.
// Folders and files are named as in the workspace, a name the disk refuses escaped (encodeName, below); Trash, "/Trash",
// is ".Trash" on disk, and what is in it is imported into Trash at a launch's start.
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

// ---- names: a workspace name the disk refuses (disk_fs.rs components: "\\", ":", control characters; a Windows device
// name, CON, aux.txt, COM1, …; a trailing dot or space), or that Windows itself refuses (< > " | ? *, CONIN$, CONOUT$),
// is written under an escaped name, and read back as it was.  The escape is percent-style, one fixed set of codes: "%"
// itself, each refused character, the first letter of a device's name, a trailing dot or space.  A name needing none
// of it is its own disk name, unless it holds one of those codes already (then its "%"s are escaped too, so it reads
// back as itself).  A name the disk can't keep even escaped (over 255 bytes, or not valid Unicode) throws NameError:
// the mirror then gives it a shortened disk name (shortName) and keeps that as its alias.  A disk name is read as the
// name it escapes only if escaping that name gives it back exactly; any other (one made by another program:
// "report%20final.pdf") is read as it is, and the mirror keeps its disk path (DiskMirror's alias), so the round trip
// loses nothing either way.
const CODES = /%(25|5C|3A|[01][0-9A-F]|2E|20|43|50|41|4E|4C|63|70|61|6E|6C|3C|3E|22|7C|3F|2A)/g;
const REFUSED = /[%\\:\x00-\x1f<>"|?*]/g;
const hex = (c: string) => "%" + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0");
/** Windows's device names, as disk_fs.rs windows_alias (CON, PRN, AUX, NUL, COM1–9, COM¹²³, LPT1–9, LPT¹²³, with any
 * extension, in any case, the stem's trailing spaces ignored), and CONIN$ and CONOUT$. */
const device = (c: string) => {
  const stem = [...c.split(".")[0].replace(/ +$/, "")].map((ch) => (ch < "\x80" ? ch.toUpperCase() : ch));
  const head = stem.slice(0, 3).join("");
  if (stem.length === 3) return ["CON", "PRN", "AUX", "NUL"].includes(head);
  if (stem.length === 4) return (head === "COM" || head === "LPT") && /[1-9\u00b9\u00b2\u00b3]/.test(stem[3]);
  return ["CONIN$", "CONOUT$"].includes(stem.join(""));
};
/** A name the disk can't keep as written, even escaped. */
export class NameError extends Error {}
const bytesOf = (s: string) => new TextEncoder().encode(s).length;
const LONE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
/** `n` escaped, whatever its length. */
function escapeName(n: string): string {
  CODES.lastIndex = 0;
  const looks = CODES.test(n);
  CODES.lastIndex = 0;
  if (!(looks || /[\\:\x00-\x1f<>"|?*]/.test(n) || /[. ]$/.test(n) || device(n))) return n;
  let s = n.replace(REFUSED, hex);
  if (/[. ]$/.test(s)) s = s.slice(0, -1) + hex(s.slice(-1));
  if (device(s)) s = hex(s[0]) + s.slice(1);
  return s;
}
/** A workspace name's disk name. */
export function encodeName(n: string): string {
  if (LONE.test(n)) throw new NameError(`${JSON.stringify(n)}: a name the disk can keep is valid Unicode`);
  const s = escapeName(n);
  if (bytesOf(s) > 255) throw new NameError(`${JSON.stringify(n)}: a name the disk can keep is at most 255 bytes${s === n ? "" : ", escaped"}`);
  return s;
}
/** The disk name for a name encodeName can't keep: escaped, its broken characters replaced, cut to fit with its
 * extension kept, and marked "(long name)" (DiskMirror then picks a free one and keeps it as the name's alias). */
export function shortName(n: string): string {
  const fixed = [...n].map((ch) => (LONE.test(ch) ? "_" : ch)).join(""), mark = " (long name)";
  let [base, ext] = splitExt(fixed);
  if (bytesOf(escapeName(ext)) > 40) { base = fixed; ext = ""; }
  const cps = [...base];
  // (245, not 255: room for DiskMirror's " 2", " 3", … when the name is taken)
  while (cps.length && bytesOf(escapeName(cps.join("") + mark + ext)) > 245) cps.pop();
  return encodeName(cps.join("") + mark + ext);
}
/** A disk name's workspace name, and whether it is that name's own escaping (else it's read as it is). */
export function decodeName(d: string): { name: string; exact: boolean } {
  const name = d.replace(CODES, (_, x) => String.fromCharCode(parseInt(x, 16)));
  if (name === d) return { name, exact: true };
  try { return encodeName(name) === d ? { name, exact: true } : { name: d, exact: false }; } catch { return { name: d, exact: false }; }
}
const mapNames = (p: string, f: (c: string) => string) => (p === "/" ? p : "/" + p.slice(1).split("/").map(f).join("/"));
/** A name at the top of the files: escaped as encodeName, and a folder of the person's own named ".Trash" as
 * "%2ETrash", so it is never the disk's Trash. */
const OWN_TRASH = "%2ETrash";
const encodeTop = (n: string) => (n === ".Trash" ? OWN_TRASH : encodeName(n));
/** A workspace path's on disk (Trash as .Trash, each name escaped as encodeName), and back (each name as decodeName:
 * `exact` false if one isn't an escaping, read as it is). */
export function toDisk(p: string): string {
  if (within(p, TRASH)) return mapNames(DISK_TRASH + p.slice(TRASH.length), encodeName);
  if (p === "/") return p;
  const [top, ...rest] = p.slice(1).split("/");
  return "/" + [encodeTop(top), ...rest.map(encodeName)].join("/");
}
export function fromDiskPath(d: string): { path: string; exact: boolean } {
  if (within(d, DISK_TRASH)) {
    let exact = true;
    const p = mapNames(d.slice(DISK_TRASH.length) || "/", (c) => { const r = decodeName(c); exact &&= r.exact; return r.name; });
    return { path: TRASH + (p === "/" ? "" : p), exact };
  }
  let exact = true, first = true;
  const p = mapNames(d, (c) => {
    const top = first;
    first = false;
    if (top && c === OWN_TRASH) return ".Trash";
    const r = decodeName(c);
    exact &&= r.exact;
    return r.name;
  });
  return { path: p, exact };
}
export const fromDisk = (d: string) => fromDiskPath(d).path;
/** A workspace path's disk path given the paths read as they are (alias: workspace path -> disk path; the longest
 * that holds `p` wins, the rest of `p` escaped below it). */
export function diskPathOf(p: string, alias: Map<string, string>): string {
  // (p's own path, then each folder it is in: the first with an alias is the longest)
  let best: string | undefined;
  if (alias.size) for (let q = p; ; q = parentOf(q)) { if (alias.has(q)) { best = q; break; } if (q === "/") break; }
  if (!best) return toDisk(p);
  const rest = p.slice(best.length);
  return alias.get(best)! + (rest ? mapNames(rest, encodeName) : "");
}
/** A disk path's workspace path, the aliases read back (the inverse of diskPathOf), and whether it needs an alias of
 * its own (a name read as it is): `alias`, for the caller to keep once the path is used. */
export function workspacePathOf(d: string, alias: Map<string, string>, rev: Map<string, string> = reverse(alias)): { path: string; alias: boolean } {
  let best: [string, string] | undefined;
  if (rev.size) for (let q = d; ; q = parentOf(q)) { const k = rev.get(q); if (k !== undefined) { best = [k, q]; break; } if (q === "/") break; }
  const rest = best ? d.slice(best[1].length) : "";
  const p = best ? best[0] + (rest ? mapNames(rest, (c) => decodeName(c).name) : "") : fromDisk(d);
  let same = false;
  try { same = diskPathOf(p, alias) === d; } catch {}
  return { path: p, alias: !same };
}
/** An alias map read backwards: disk path -> workspace path. */
const reverse = (alias: Map<string, string>) => new Map([...alias].map(([k, v]) => [v, k]));
/** `p`, or the first free "<name> 2<ext>", "… 3", … beside it in `ws` (a disk name read back as one already there). */
async function freeIn(ws: any, p: string): Promise<string> {
  if (!(await ws.stat(p))) return p;
  const [base, ext] = splitExt(nameOf(p)), dir = parentOf(p) === "/" ? "" : parentOf(p);
  for (let i = 2; ; i++) { const c = `${dir}/${base} ${i}${ext}`; if (!(await ws.stat(c))) return c; }
}
/** Where disk path `d` goes in `ws`: its workspace path, or a free one beside it if that is taken (two disk names
 * read back as one), the alias it needs kept only once `use` has succeeded. */
async function importAt(ws: any, d: string, alias: Map<string, string>, rev: Map<string, string>, use: (p: string) => Promise<void>): Promise<string> {
  const w = workspacePathOf(d, alias, rev), p = await freeIn(ws, w.path);
  await use(p);
  if (w.alias || p !== w.path) { alias.set(p, d); rev.set(d, p); }
  return p;
}

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

/** The disk's tree made in `ws` (an empty workspace: this launch's): the disk's Trash first, then folders, then
 * files, each disk name read back as decodeName.  Returns each file's stat as read (with its SHA-256, for DiskMirror),
 * the paths read as they are (`alias`, for DiskMirror), what couldn't be imported and why, and how long it took. */
export async function importDisk(ws: any, disk: Disk, now: () => number = () => performance.now()): Promise<{ known: Map<string, DiskStat>; alias: Map<string, string>; skipped: [string, string][]; files: number; bytes: number; ms: number }> {
  const t0 = now(), known = new Map<string, DiskStat>(), alias = new Map<string, string>(), skipped: [string, string][] = [];
  const listed = await disk.list();
  let files = 0, bytes = 0;
  const file = async (e: DiskStat, p: string) => {
    const b = await disk.read(e.path), kind = kindOf(p);
    const content = kind === "file" ? b : JSON.parse(dec.decode(b));
    await ws.create(p, { content });
    known.set(e.path, { ...e, sha256: await sha256Hex(b) });
    files++;
    bytes += e.size;
  };
  // (the disk's Trash, while the workspace is still empty: each thing in it made at the top of the files, then put in
  // Trash, where it is then /Trash/<its name>, as on disk, so a later deletion picks another name and emptying Trash
  // deletes it; put back, it goes to the top of the files: the disk doesn't keep where it was.  A folder of it that
  // only partly imports is put in Trash all the same, what didn't import reported)
  for (const top of listed.filter((e) => parentOf(e.path) === DISK_TRASH)) {
    const name = nameOf(workspacePathOf(top.path, alias).path), local = new Map<string, string>();
    let temp: string | null = null;
    try {
      temp = await freeIn(ws, "/" + name);
      const t = temp;
      // (each disk path under the Trash entry, as a path under `temp`)
      const here = (d: string) => t + (d === top.path ? "" : mapNames(d.slice(top.path.length), (c) => decodeName(c).name));
      if (top.dir) {
        await ws.mkdir(t);
        const under = listed.filter((e) => e.path.startsWith(top.path + "/"));
        for (const e of under.filter((e) => e.dir).sort((a, b) => a.path.length - b.path.length)) {
          try { await ws.mkdir(here(e.path)); local.set(e.path, here(e.path)); } catch (err: any) { skipped.push([e.path, err?.message ?? String(err)]); }
        }
        for (const e of under.filter((e) => !e.dir)) {
          try { await file(e, here(e.path)); local.set(e.path, here(e.path)); } catch (err: any) { skipped.push([e.path, err?.message ?? String(err)]); }
        }
      } else await file(top, t);
    } catch (err: any) { skipped.push([top.path, err?.message ?? String(err)]); }
    if (!temp || !(await ws.stat(temp))) continue;
    try {
      const put = await ws.remove(temp);
      const inTrash: string = put?.path ?? TRASH + "/" + nameOf(temp);
      // (each imported path's alias where its disk path isn't its escaping, now under Trash)
      for (const [d, at] of [[top.path, temp], ...local] as [string, string][]) {
        const w = inTrash + at.slice(temp.length);
        let same = false;
        try { same = diskPathOf(w, alias) === d; } catch {}
        if (!same) alias.set(w, d);
      }
    } catch (err: any) { skipped.push([top.path, err?.message ?? String(err)]); }
  }
  const all = listed.filter((e) => !within(e.path, DISK_TRASH)), rev = reverse(alias);
  for (const e of all.filter((e) => e.dir).sort((a, b) => a.path.length - b.path.length)) {
    try { await importAt(ws, e.path, alias, rev, (p) => ws.mkdir(p)); } catch (err: any) { skipped.push([e.path, err?.message ?? String(err)]); }
  }
  for (const e of all.filter((e) => !e.dir)) {
    try { await importAt(ws, e.path, alias, rev, (p) => file(e, p)); } catch (err: any) { skipped.push([e.path, err?.message ?? String(err)]); }
  }
  return { known, alias, skipped, files, bytes, ms: Math.round(now() - t0) };
}

type Write = { k: "write"; path: string; bytes: Promise<Uint8Array | null>; capture: () => Promise<Uint8Array | null> };
type Task = Write | { k: "mkdir"; path: string } | { k: "move"; from: string; to: string } | { k: "remove"; path: string } | { k: "pull"; path: "" };
const touches = (t: Task, p: string) => (t.k === "move" ? within(t.from, p) || within(p, t.from) || within(t.to, p) || within(p, t.to) : !!t.path && (within(t.path, p) || within(p, t.path)));
const RETRY_MS = [1000, 2000, 5000, 10000, 30000];
const isMissing = (e: unknown) => (e as any)?.code === "missing";
/** An error no retry can fix: disk.rs refusing a path (disk_fs.rs components, which the escaping should make
 * unreachable), or a name no disk name could be found for. */
const refused = (e: unknown) => e instanceof NameError || /not a workspace path|isn't a name Windows keeps/.test(String((e as any)?.message ?? e));
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
  /** a task that can never succeed (disk.rs refusing its path, which the escaping should make unreachable): left
   * out, said, and the tasks after it go on */
  skipped?: (path: string, e: unknown) => void;
  /** a name the disk can't keep even escaped, given a shortened disk name (`disk`, kept as its alias) */
  named?: (path: string, disk: string) => void;
  /** how many tasks wait (coalesced: a file's writes one task) */
  pending?: (n: number) => void;
  /** what it knows changed (after a task: kept for the launch's next page) */
  state?: (m: DiskMirror) => void;
  /** another window's changes read (pull): the files brought in or changed here, those gone from disk, and what
   * couldn't be read */
  pulled?: (imported: string[], gone: string[], skipped: [string, string][]) => void;
};
export type MirrorState = { known: [string, DiskStat][]; redirect: [string, string][]; alias?: [string, string][] };

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
export async function reconcileDisk(ws: any, disk: Disk, st: MirrorState): Promise<{ known: Map<string, DiskStat>; alias: Map<string, string>; imported: string[]; skipped: [string, string][] }> {
  const known = new Map(st.known), alias = new Map(st.alias ?? []), rev = reverse(alias), imported: string[] = [], skipped: [string, string][] = [];
  const redirected = new Set(st.redirect.map(([, side]) => side));
  for (const e of await disk.list()) {
    if (e.dir || within(e.path, DISK_TRASH) || redirected.has(e.path)) continue;
    const k = known.get(e.path);
    if (k && k.size === e.size && k.mtime === e.mtime) continue;
    try {
      const w = workspacePathOf(e.path, alias, rev), p = w.path;
      const b = await disk.read(e.path), kind = kindOf(p);
      const content = kind === "file" ? b : JSON.parse(dec.decode(b));
      // (the workspace's file whose disk path this is: its contents again; another disk name read back as a path
      // that is taken (by a file whose disk path is another): at a free path beside it)
      let at = p;
      if (!w.alias && (await ws.stat(p))) await ws.write(p, content);
      else { at = await freeIn(ws, p); await ws.create(at, { content }); }
      if (w.alias || at !== p) { alias.set(at, e.path); rev.set(e.path, at); }
      known.set(e.path, { ...e, sha256: await sha256Hex(b) });
      imported.push(at);
    } catch (err: any) { skipped.push([e.path, err?.message ?? String(err)]); }
  }
  return { known, alias, imported, skipped };
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
  /** the workspace paths whose disk path isn't their escaping (diskPathOf): a name read as it is, a Trash name taken */
  private alias = new Map<string, string>();
  /** the workspace paths pull is changing: their ops are the disk's, not this page's, so never written back */
  private quiet = new Map<string, number>();
  /** the last failure: [file, error], while there is one */
  failing: [string, unknown] | null = null;
  /** what it knows, kept for the launch's next page (diskWorkspace: idbState), the latest of it: resolves once it is,
   * rejects if that failed (keepAll waits for it) */
  persist: () => Promise<void> = async () => {};
  /** `known`: each file's stat as this page last read or wrote it (importDisk's, then each write's). */
  constructor(private ws: any, private disk: Disk, private known: Map<string, DiskStat>, public on: MirrorEvents = {}, private sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)), redirect: [string, string][] = [], alias: Iterable<[string, string]> = []) {
    this.redirect = new Map(redirect);
    this.alias = new Map(alias);
  }
  /** What this page knows of the disk (each file as it last read or wrote it, and the conflicts' copies), for the
   * launch's next page (diskState): never rebuilt from the disk, which another program may have changed. */
  state(): MirrorState { return { known: [...this.known], redirect: [...this.redirect], alias: [...this.alias] }; }

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

  /** Another window changed the disk (#1541): it is read again once the tasks before it are done (one read waiting
   * at most: a later call while one waits is that one). */
  pull() {
    if (this.q.some((t, i) => t.k === "pull" && !(i === 0 && this.running && this.started))) return;
    this.add({ k: "pull", path: "" });
  }
  /** `f`, a change of the workspace at `p` made from the disk: its op left out (never written back). */
  private async quietly<T>(p: string, f: () => Promise<T>): Promise<T> {
    this.quiet.set(p, (this.quiet.get(p) ?? 0) + 1);
    try { return await f(); } finally { const n = this.quiet.get(p)! - 1; if (n) this.quiet.set(p, n); else this.quiet.delete(p); }
  }
  /** The disk read again, as reconcileDisk does a later page's: each file whose size or time isn't the one this page
   * knows (and whose contents aren't either), or that it doesn't know, brought in, a folder it hasn't made, and each
   * file it knows that is gone from disk dropped from the workspace (moved or deleted in another window: its new
   * place comes in as a new file).  A path one of this page's own tasks still waits to change is left to that task
   * (which checks the disk as it always does), and so is a file whose writes from here go to a conflict's copy.  Never fails: what couldn't be read is said (on.pulled). */
  private async pullDisk() {
    const imported: string[] = [], gone: string[] = [], skipped: [string, string][] = [];
    let listed: DiskStat[];
    try { listed = await this.disk.list(); } catch (e: any) { this.on.pulled?.(imported, gone, [["/", e?.message ?? String(e)]]); return; }
    // (a conflict's copy, and the file it was the copy of, whose writes from here go to that copy: left as they are)
    const redirected = new Set([...this.redirect.keys(), ...this.redirect.values()]), mine = (p: string) => this.q.slice(1).some((u) => touches(u, p));
    let rev = reverse(this.alias);
    const on = new Set(listed.map((e) => e.path));
    for (const e of listed.sort((a, b) => a.path.length - b.path.length)) {
      if (within(e.path, DISK_TRASH) || redirected.has(e.path)) continue;
      try {
        const w = workspacePathOf(e.path, this.alias, rev), p = w.path;
        if (mine(p)) continue;
        if (e.dir) {
          if (!(await this.ws.stat(p))) await this.quietly(p, () => this.ws.mkdir(p));
          continue;
        }
        const k = this.known.get(e.path);
        if (k && k.size === e.size && k.mtime === e.mtime) continue;
        const b = await this.disk.read(e.path), sha256 = await sha256Hex(b);
        if (k?.sha256 === sha256 && (await this.ws.stat(p))) { this.known.set(e.path, { ...e, sha256 }); continue; }
        const kind = kindOf(p), content = kind === "file" ? b : JSON.parse(dec.decode(b));
        let at = p;
        if (!w.alias && (await this.ws.stat(p))) await this.quietly(p, () => this.ws.write(p, content));
        else { at = await freeIn(this.ws, p); await this.quietly(at, () => this.ws.create(at, { content })); }
        if (w.alias || at !== p) { this.alias.set(at, e.path); rev = reverse(this.alias); }
        this.known.set(e.path, { ...e, sha256 });
        imported.push(at);
      } catch (err: any) { skipped.push([e.path, err?.message ?? String(err)]); }
    }
    for (const d of [...this.known.keys()]) {
      if (on.has(d) || within(d, DISK_TRASH) || redirected.has(d)) continue;
      try {
        const p = workspacePathOf(d, this.alias, rev).path;
        if (mine(p)) continue;
        this.known.delete(d);
        if (this.alias.get(p) === d) this.alias.delete(p);
        if ((await this.ws.stat(p))?.kind === "folder") continue;
        if (await this.ws.stat(p)) { await this.quietly(p, () => this.ws.forget(p)); gone.push(p); }
      } catch (err: any) { skipped.push([d, err?.message ?? String(err)]); }
    }
    this.knew();
    this.on.pulled?.(imported, gone, skipped);
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
    if (op.origin === "server" || this.quiet.has(op.path)) return;
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
          // (a path the disk can never take: this task left out, said, and never in the way of the ones after it)
          if (refused(e)) {
            this.q.shift();
            this.tries = 0;
            if (this.failing) { this.failing = null; this.on.error?.("", null); }
            this.on.skipped?.((t.k === "move" ? t.to : t.path) || "a notebook", e);
            continue;
          }
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

  /** A workspace path's disk path (its escaping, or its alias); NameError if it has none until place gives it one. */
  private dk(p: string) { return diskPathOf(p, this.alias); }
  private dkOrNull(p: string): string | null { try { return this.dk(p); } catch (e) { if (e instanceof NameError) return null; throw e; } }
  private at(p: string) { const d = this.dk(p); return this.redirect.get(d) ?? d; }
  /** Whether disk path `d`, for workspace path `p`, is another path's (an alias's value, not one `p` is under). */
  private taken(p: string, d: string) {
    for (const [k, v] of this.alias) if (!within(p, k) && within(d, v)) return true;
    // (a conflict's copy: another path's Sagebrush version)
    for (const v of this.redirect.values()) if (within(d, v)) return true;
    return false;
  }
  /** Workspace path `p`'s disk path, given one if it needs it: its folder's first; then its name escaped, or shortened
   * (shortName) if the disk can't keep it even escaped, or the first free "<name> 2<ext>", … if that disk path is
   * another path's; any but its escaping kept as its alias (and a shortened one said). */
  private async place(p: string): Promise<string> {
    const d = this.dkOrNull(p);
    if (d !== null && !this.taken(p, d)) return d;
    const folder = parentOf(p), fd = folder === "/" ? "" : await this.place(folder);
    let name: string, short = false;
    try { name = folder === "/" ? encodeTop(nameOf(p)) : encodeName(nameOf(p)); } catch (e) { if (!(e instanceof NameError)) throw e; name = shortName(nameOf(p)); short = true; }
    let c = `${fd}/${name}`;
    const [base, ext] = splitExt(name);
    // (its own escaping is used unless it is another path's; any other name only if nothing is there at all: no
    // alias's, no conflict copy, nothing this page knows of, nothing on disk)
    for (let i = 2; this.taken(p, c) || (c !== d && (this.known.has(c) || (await this.disk.stat(c)))); i++) c = `${fd}/${base} ${i}${ext}`;
    if (c !== d) { this.alias.set(p, c); this.knew(); }
    if (short && !within(p, TRASH)) this.on.named?.(p, c);
    return c;
  }
  /** The redirects of `p` and what is in it ended, and what this page knew of the files there (it was moved or
   * removed: a file made there later is a new one). */
  private unredirect(p: string, d = this.dk(p)) {
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

  /** A free name beside disk path `d`, for a move into Trash whose name is taken on disk (a Trash from an earlier
   * launch): "<name> 2<ext>", "… 3", … (never one that is there). */
  private async freeAt(d: string): Promise<string> {
    const [base, ext] = splitExt(nameOf(d)), dir = parentOf(d) === "/" ? "" : parentOf(d);
    for (let i = 2; ; i++) {
      const c = `${dir}/${base} ${i}${ext}`;
      if (!(await this.disk.stat(c))) return c;
    }
  }
  /** The aliases of `p` and what is in it ended (it left that path: a path made there later is a new one). */
  private dropAliases(p: string) {
    for (const k of [...this.alias.keys()]) if (within(k, p)) this.alias.delete(k);
    this.knew();
  }
  /** What it knows, moved with a move of workspace path `p` (disk path `from`) to `q` (disk path `to`). */
  private moved(p: string, from: string, q: string, to: string) {
    const d = this.dkOrNull(p) ?? from;
    for (const [k, v] of [...this.known]) if (within(k, from)) { this.known.delete(k); this.known.set(to + k.slice(from.length), v); }
    for (const [k, v] of [...this.alias]) {
      if (!within(k, p)) continue;
      this.alias.delete(k);
      if (k !== p && within(v, from)) this.alias.set(q + k.slice(p.length), to + v.slice(from.length));
    }
    this.unredirect(p, d);
    if (to !== this.dkOrNull(q)) this.alias.set(q, to);
    this.knew();
  }

  private async run(t: Task) {
    if (t.k === "pull") return this.pullDisk();
    if (t.k === "mkdir") return this.disk.mkdir(await this.place(t.path));
    if (t.k === "write") {
      let bytes: Uint8Array | null;
      try { bytes = await t.bytes; } catch (e) { throw new CaptureError(e); }
      if (bytes && t.path) await this.writeAt(await this.place(t.path), bytes);
      return;
    }
    if (t.k === "move") {
      const from0 = this.dkOrNull(t.from);
      // (nothing of it on disk (a name never given a disk path): written now at its new place, a folder with what is in
      // it; no conflict to tell of)
      if (from0 === null) {
        const e = await this.ws.stat(t.to);
        if (e?.kind === "folder") {
          await this.disk.mkdir(await this.place(t.to));
          for (const x of await this.ws.list(t.to, { recursive: true })) {
            if (x.kind === "folder") await this.disk.mkdir(await this.place(x.path));
            else { const b = await fileBytes(this.ws, x.path); if (b) await this.writeAt(await this.place(x.path), b); }
          }
        } else if (e) { const b = await fileBytes(this.ws, t.to); if (b) await this.writeAt(await this.place(t.to), b); }
        return;
      }
      const from = this.redirect.get(from0) ?? from0, to = await this.place(t.to);
      const st = await this.disk.stat(from);
      try {
        if (!st) throw new Error(CONFLICT);
        await this.disk.rename(from, to, st.dir ? "any" : this.expect(from));
      } catch (e) {
        if (!isConflict(e)) throw e;
        // (into Trash, its name taken on disk (a Trash from an earlier launch): to a free name there instead, the
        // workspace's name kept as its alias, so emptying Trash deletes it; a source changed meanwhile still refuses)
        if (st && within(t.to, TRASH) && (await this.disk.stat(to))) {
          const free = await this.freeAt(to);
          try {
            await this.disk.rename(from, free, st.dir ? "any" : this.expect(from));
            this.moved(t.from, from, t.to, free);
            return;
          } catch (e2) { if (!isConflict(e2)) throw e2; }
        }
        // (gone, changed by another program, or something at the destination: nothing moved there; the workspace's
        // file, if it is one, written where the workspace now has it, or beside that, and the person told)
        if (st?.dir) { this.unredirect(t.from); this.dropAliases(t.from); this.on.conflict?.(from, from); return; }
        const bytes = await fileBytes(this.ws, t.to);
        this.unredirect(t.from);
        this.dropAliases(t.from);
        if (bytes) await this.writeAt(to, bytes);
        if (!this.told.has(to)) this.on.conflict?.(from, this.redirect.get(to) ?? to);
        return;
      }
      this.moved(t.from, from, t.to, to);
      return;
    }
    if (t.k === "remove") {
      // (emptying Trash: a person's explicit deletion; a file changed by another program meanwhile is kept, but a
      // folder's contents are deleted whatever they are: its files aren't checked one by one)
      const d0 = this.dkOrNull(t.path);
      if (d0 === null) { for (const k of [...this.alias.keys()]) if (within(k, t.path)) this.alias.delete(k); this.knew(); return; }
      const d = this.redirect.get(d0) ?? d0, st = await this.disk.stat(d);
      try {
        await this.disk.remove(d, st?.dir ? "any" : this.expect(d));
      } catch (e) {
        if (!isConflict(e)) throw e;
        this.unredirect(t.path);
        this.dropAliases(t.path);
        this.on.conflict?.(d, d);
        return;
      }
      this.unredirect(t.path);
      for (const k of [...this.known.keys()]) if (within(k, d)) this.known.delete(k);
      for (const k of [...this.alias.keys()]) if (within(k, t.path)) this.alias.delete(k);
      this.knew();
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
  return { set(kind: "error" | "conflict" | "report" | "settings" | "skipped" | "named", text: string | null) { if (text) lines.set(kind, text); else lines.delete(kind); draw(); }, el };
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
 * (never a queue of snapshots).  A write that fails keeps its state dirty: the next change, or the next `flush` (a
 * quit's Wait, leaving a page), writes it again (never a loop by itself).  `flush` resolves once the latest is
 * written, or rejects with the failure. */
export function stateSaver(save: (st: MirrorState) => Promise<void>) {
  let get: (() => MirrorState) | null = null, unsaved: (() => MirrorState) | null = null, running: Promise<void> | null = null, failed: unknown = null;
  const run = async () => {
    while (get) {
      const g = get;
      get = null;
      try { await save(g()); failed = null; unsaved = null; } catch (e) { failed = e; unsaved = g; console.warn("disk state:", e); }
    }
    running = null;
  };
  return {
    dirty(f: () => MirrorState) { get = f; if (!running) running = run(); },
    async flush() {
      if (failed && unsaved && !running) { get = unsaved; running = run(); }
      while (running) await running;
      if (failed) throw failed;
    },
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
  let known: Map<string, DiskStat> | undefined, alias: Map<string, string> = new Map();
  if (control === "no-import") { known = new Map(); sessionStorage.setItem(IMPORTED, "1"); }
  else if (!sessionStorage.getItem(IMPORTED)) {
    const r = await importDisk(ws, disk);
    known = r.known;
    alias = r.alias;
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
    alias = r.alias;
    redirect = st.redirect;
    if (r.imported.length) banner.set("report", `Changed by another program, and brought in: ${r.imported.slice(0, 3).join(", ")}${r.imported.length > 3 ? ", …" : ""}`);
    if (r.skipped.length) banner.set("report", `${r.skipped.length} changed files in Sagebrush's folder couldn't be opened: ${r.skipped.slice(0, 3).map(([p, why]) => `${p} (${why})`).join(", ")}`);
  }
  const saver = stateSaver((st) => idbState.save(st));
  const m = new DiskMirror(ws, disk, known!, {
    state: (mm) => saver.dirty(() => mm.state()),
    conflict: (p, kept) => banner.set("conflict", p === kept ? `${p} was changed by another program, so Sagebrush didn't change it.` : `${p} was changed by another program, so it wasn't written over: Sagebrush's version is ${kept}.`),
    error: (p, e) => banner.set("error", e === null ? null : `Couldn't save ${p} to disk: ${(e as any)?.message ?? e}. Trying again…`),
    skipped: (p, e) => banner.set("skipped", `Couldn't save ${p} to disk, and won't try again: ${(e as any)?.message ?? e}. It's kept here for this launch only: rename it to keep it.`),
    named: (p, d) => banner.set("named", `${p}: that name is too long for the disk, so its file there is named ${d}.`),
    pending: saving,
  }, undefined, redirect, alias);
  if (control !== "no-write") m.start();
  // (another window's changes to the disk, #1541: read again, a moment after the last one told)
  const me = (window as any).__TAURI_INTERNALS__?.metadata?.currentWebview?.label;
  let soon: ReturnType<typeof setTimeout> | null = null;
  (window as any).__TAURI__?.event?.listen?.("sb-disk-changed", (ev: any) => {
    if (!me || ev?.payload?.from === me) return;
    if (soon) clearTimeout(soon);
    soon = setTimeout(() => { soon = null; m.pull(); }, 150);
  })?.catch?.((e: unknown) => console.warn("disk: other windows' changes:", e));
  m.on.pulled = (imported, gone, skipped) => {
    if (skipped.length) banner.set("report", `${skipped.length} files another window changed couldn't be opened here: ${skipped.slice(0, 3).map(([p, why]) => `${p} (${why})`).join(", ")}`);
    if (imported.length || gone.length) console.log(`disk: another window's changes: ${imported.length} brought in, ${gone.length} gone`);
  };
  m.persist = () => saver.flush();
  saver.dirty(() => m.state());
  (window as any).__sbDiskError = (what: string, e: unknown) => banner.set("settings", e ? `Couldn't save ${what}: ${(e as any)?.message ?? e}` : null);
  // (settings.json that couldn't be read when the app started: kept aside, said; disk.rs settings_script)
  const problem = (window as any).__sbSettingsProblem;
  if (typeof problem === "string" && problem) banner.set("report", problem);
  return m;
}

/** Everything this page hasn't kept yet, made and written, within `ms`: the editor's own save (`flushEditor`), the
 * settings, the file permissions, then every change on disk.  What isn't, and why (`not`: [] if all is kept), and how many unsaved items
 * that is (`count`: each change still waiting for the disk, and the editor's save, the settings or the file permissions if not done). */
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
  // (the file permissions, kept in grants.json: web/workspace/grants-file.ts keepGrants's flush)
  await step("the file permissions", () => (window as any).__sbGrantsFlush?.());
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
