// The workspace (design/workspace-files.md §2, §8.2): one tree of paths in
// this browser, notebooks, boards, data files and folders, and the verbs on
// it that the File menu, the file browser and agents all use: list, stat,
// read, write, create, mkdir, rename, duplicate, remove (to Trash),
// restore, watch.
//
// Where things are kept (§2.2): the index is "sagebrush-workspace"/entries;
// a notebook stays in "sagebrush"/notebooks under its id (IdbStore, so its
// tabs and TimeTravel are unchanged), a data file in "sagebrush"/files
// under its path (what Python's open() reads), a board in
// "sagebrush-workspace"/boards under its id.  The contents are written
// first and the entry second, and an entry is removed before its contents,
// so a failure between the two leaves contents without an entry (which
// reconcile lists again, web/workspace/migrate.ts), never an entry pointing
// at nothing that was there.  Every change here, in every tab, holds one Web
// Lock ("sagebrush-workspace"), so the steps that span the two databases
// are never interleaved with another change.
//
// There is no verb that empties Trash or removes contents for good: only a
// person does that, from the file browser (§2.4, §8.2).
import { inTx, req, hex, openWorkspaceDb } from "./db";
import { TRASH, PathError, freePath, join, kindOf, nameOf, normPath, parentOf, splitExt, within, type Kind } from "./paths";
import { IdbStore, bytesHash, openDb as openMainDb, openHistoryDb, openBoardHistoryDb } from "../notebook/stores.js";
import { isBoard } from "../board/doc";

export type Entry = {
  path: string;
  kind: Kind;
  /** the contents: a notebook's or board's id; a data file's key in "sagebrush"/files (in Trash: in "sagebrush-workspace"/trash); null for a folder */
  ref: string | null;
  /** a document's language */
  mode?: string;
  /** a data file's bytes */
  size?: number;
  created: number;
  updated: number;
  /** a data file's revision (a document's is its record's) */
  rev?: number;
  /** a data file's own id, which a rename keeps: its versions' (§2.5) */
  fid?: string;
  /** in Trash: where it was, when it was put there, and that time's own id (Undo's, CORR-989-2) */
  trashed?: { from: string; at: number; id?: string };
  /** a board made from an edited example or a board on the web: its address */
  origin?: string;
  /** a data file recovered from Trash bytes with no entry: from which Trash key, and their SHA-256 (CORR-DF0-1) */
  recovered?: { from: string; sha: string };
  /** contents reconcile could not find (shown, never dropped) */
  missing?: boolean;
};
export type Op = { seq?: number; t: number; device: string; by: string; op: string; path: string; to?: string; kind: Kind };
/** An earlier version of a data file (§2.5): its bytes are in versionBytes under `id`. */
export type Version = { id?: number; fid: string; t: number; size: number; sha256: string; by: string; device: string };
export type BoardRecord = { id: string; doc: any; rev: number; updated: number; docId?: string; origin?: string; tag?: string };
export type Limits = { maxFileBytes: number; maxBoardBytes: number; maxEntries: number; maxFolderEntries: number; maxVersions: number; maxVersionAgeMs: number; maxVersionBytes: number };
/** §6.3: one upload at most 200 MB; a board's JSON at most 64 MB; the
 * workspace at most 100,000 entries, a folder at most 10,000 of its own.  §2.5: a data file's latest 20
 * versions, none older than 30 days, all of them at most 1 GB. */
export const LIMITS: Limits = { maxFileBytes: 200 * 2 ** 20, maxBoardBytes: 64 * 2 ** 20, maxEntries: 100_000, maxFolderEntries: 10_000, maxVersions: 20, maxVersionAgeMs: 30 * 864e5, maxVersionBytes: 2 ** 30 };

export type WorkspaceErrorCode = "invalid" | "exists" | "missing" | "conflict" | "limit" | "storage";
export class WorkspaceError extends Error {
  constructor(public code: WorkspaceErrorCode, message: string, public current?: unknown) { super(message); }
}

/** What the board page keeps of a board of this browser's in localStorage, by its id (web/board/page.ts). */
export const BOARD_KEYS = {
  local: (id: string) => "sagebrush-board:local:" + id,
  here: (id: string) => "sagebrush-board:local:" + id + "#here",
  pending: (id: string) => "sagebrush-workspace-pending:" + id,
  unread: (id: string) => "sagebrush-workspace-pending-unread:" + id,
};
// The first time the person saves something of their own here (not on a
// first visit): the browser asked to keep this site's storage when space
// runs short (§6.3), once per page.  The workspace's own writes call it;
// the notebook page calls it for a notebook's saves.
let keepAsked = false;
export function askToKeep() {
  if (keepAsked) return;
  keepAsked = true;
  try { (globalThis.navigator as any)?.storage?.persist?.()?.catch?.(() => {}); } catch {}
}
const CHANNEL = "sagebrush-workspace";
const LOCK = "sagebrush-workspace";
type Change = { ops: Op[] };

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);
// (the same entry, put in Trash the same time: each time something is put
// in Trash has an id of its own, which a clock that ties can't give
// (CORR-989-2); and the same entry: a data file known by its own id (its
// key is its path), a document by its id)
const sameTrashed = (e: Entry, x: Entry) =>
  !!e.trashed?.id && e.trashed.id === x.trashed?.id &&
  e.kind === x.kind && e.created === x.created && e.fid === x.fid && (e.kind === "file" || e.ref === x.ref) && e.trashed.from === x.trashed?.from;
/** The bytes of a data file's contents as given (bytes, a buffer, or text). */
function bytesOf(c: unknown): Uint8Array {
  if (c instanceof Uint8Array) return c;
  if (c instanceof ArrayBuffer) return new Uint8Array(c);
  if (typeof c === "string") return new TextEncoder().encode(c);
  throw new WorkspaceError("invalid", "a file's contents are bytes or text");
}
// (a path made one, its errors said as the workspace's)
function path(p: unknown): string {
  try { return normPath(p); } catch (e) { throw new WorkspaceError("invalid", e instanceof PathError ? e.message : String(e)); }
}
// (every path under `p`: the keys from `p/` up to, not including, `p0`, "0"
// being the character after "/", so every name, whatever its first
// character, is in it: CORR-4A0-3)
const subtree = (p: string) => (p === "/" ? undefined : IDBKeyRange.bound(p + "/", p + "0", false, true));

export class Workspace {
  private subs = new Set<(c: Change) => void>();
  private channel: BroadcastChannel | null = null;
  private tab = hex(8);
  /** Who makes the changes from here: "person", or "agent:<name>" (§8.3); in the operation log and on versions. */
  actor = "person";

  /** `ws`: the workspace's database; `main`: "sagebrush" (notebooks, files), or null where there is none. */
  constructor(readonly ws: IDBDatabase, readonly main: IDBDatabase | null, readonly device: string, readonly limits: Limits = LIMITS, private now: () => number = Date.now) {
    if (typeof BroadcastChannel === "function") {
      this.channel = new BroadcastChannel(CHANNEL);
      this.channel.onmessage = (ev) => { if (ev.data?.from !== this.tab && Array.isArray(ev.data?.ops)) this.tell({ ops: ev.data.ops }, false); };
    }
  }

  /** The workspace of this browser (both databases opened), or a WorkspaceError("storage"). */
  static async open(opts: { name?: string; mainName?: string; limits?: Limits; now?: () => number } = {}): Promise<Workspace> {
    let ws: IDBDatabase;
    try { ws = await openWorkspaceDb(opts.name); } catch (e) { throw new WorkspaceError("storage", `this browser's storage can't be opened: ${(e as Error)?.message ?? e}`); }
    const main = await openMainDb(opts.mainName ?? "sagebrush");
    const device = await inTx(ws, "meta", "readwrite", async (tx) => {
      const st = tx.objectStore("meta");
      const d = await req(st.get("device"));
      if (typeof d === "string" && /^[0-9a-f]{16}$/.test(d)) return d;
      const fresh = hex(8);
      st.put(fresh, "device");
      return fresh;
    });
    return new Workspace(ws, main, device, opts.limits ?? LIMITS, opts.now);
  }

  close() {
    this.channel?.close();
    this.ws.close();
    this.main?.close();
  }

  // ------------------------------------------------------------ reading

  /** The entries in `folder` (with `recursive`, everything under it), by path.  Trash shows only when listed itself. */
  async list(folder: string = "/", opts: { recursive?: boolean } = {}): Promise<Entry[]> {
    const f = path(folder);
    const all: Entry[] = await inTx(this.ws, "entries", "readonly", (tx) => req(tx.objectStore("entries").getAll(subtree(f))));
    return all.filter((e) => (opts.recursive || parentOf(e.path) === f) && (within(f, TRASH) || !within(e.path, TRASH)));
  }

  /** One entry, or undefined. */
  async stat(p: string): Promise<Entry | undefined> {
    const q = path(p);
    return inTx(this.ws, "entries", "readonly", (tx) => req(tx.objectStore("entries").get(q)));
  }

  /** An entry and its contents: a notebook's document, a board's document,
   * a data file's bytes, a folder's entries; with the revision to give
   * write() as `base`. */
  async read(p: string): Promise<{ entry: Entry; content: any; rev: number; tag?: string }> {
    const e = await this.mustStat(p);
    if (e.kind === "folder") return { entry: e, content: await this.list(e.path), rev: 0 };
    const c = await this.contents(e);
    if (c === undefined) throw new WorkspaceError("missing", `the contents of ${e.path} are not in this browser`);
    if (e.kind === "notebook") return { entry: e, content: c, rev: c.rev ?? 0 };
    if (e.kind === "board") return { entry: e, content: (c as BoardRecord).doc, rev: (c as BoardRecord).rev, ...((c as BoardRecord).tag ? { tag: (c as BoardRecord).tag } : {}) };
    return { entry: e, content: c, rev: e.rev ?? 0 };
  }

  // ------------------------------------------------------------ changing

  /** A folder, and any folders above it that aren't there. */
  async mkdir(p: string): Promise<Entry> {
    const q = path(p);
    if (q === "/") throw new WorkspaceError("invalid", "the top folder is always there");
    if (within(q, TRASH)) throw new WorkspaceError("invalid", "Trash holds only what was deleted");
    return this.locked(async () => {
      const ops: Op[] = [];
      const e = await inTx(this.ws, ["entries", "ops"], "readwrite", async (tx) => {
        await this.folders(tx, q, ops);
        return req(tx.objectStore("entries").get(q));
      });
      this.tell({ ops });
      return e;
    });
  }

  /** A new notebook, board or data file at `p`, its kind said by its name;
   * `content` its document or bytes (else a blank one), `mode` a document's
   * language.  A path that's taken is refused, never written over. */
  async create(p: string, opts: { content?: unknown; mode?: string } = {}): Promise<Entry> {
    const q = path(p), kind = kindOf(q);
    if (q === "/" || within(q, TRASH)) throw new WorkspaceError("invalid", `can't make ${q}`);
    return this.locked(() => this.make(q, kind, opts.content, opts.mode)).then((e) => { this.askToKeep(); return e; });
  }

  /** New contents for a notebook, board or data file; with `base` (the
   * revision read() gave), only if nothing else wrote it since: otherwise a
   * WorkspaceError("conflict") with the current contents, nothing written. */
  /** `tag` (a board): who wrote it, kept on the record (a page's session, so that page can tell its own writes from others'). `keepEmpty: false` (a data file): no version of empty bytes (Python's open("w") empties a file before writing it); a version of an empty file is kept otherwise. */
  async write(p: string, content: unknown, opts: { base?: number; tag?: string; keepEmpty?: boolean } = {}): Promise<{ entry: Entry; rev: number }> {
    return this.writeLocked(p, content, opts).then((out) => { this.askToKeep(); return out; });
  }
  private async writeLocked(p: string, content: unknown, opts: { base?: number; tag?: string; keepEmpty?: boolean }): Promise<{ entry: Entry; rev: number }> {
    return this.locked(async () => {
      const e = await this.mustStat(p);
      if (e.trashed || within(e.path, TRASH)) throw new WorkspaceError("invalid", "restore it from Trash first");
      const t = this.now();
      let rev: number, size: number | undefined;
      if (e.kind === "notebook") {
        if (!this.main) throw new WorkspaceError("storage", "this browser has no storage for notebooks");
        const doc = content as any;
        if (!doc || typeof doc !== "object" || !Array.isArray(doc.cells)) throw new WorkspaceError("invalid", "a notebook is {cells: [...]}");
        const { id: _i, rev: _r, updated: _u, ...rest } = doc;
        const out = await new IdbStore(this.main, e.ref!).save({ ...rest, name: splitExt(nameOf(e.path))[0], ...(opts.base !== undefined ? { baseRev: opts.base } : {}) });
        if (typeof out === "string") throw new WorkspaceError("storage", out);
        if (out.conflict) throw new WorkspaceError("conflict", `${e.path} was changed elsewhere`, out.conflict);
        rev = out.rev;
      } else if (e.kind === "board") {
        this.checkBoard(content);
        rev = await inTx(this.ws, "boards", "readwrite", async (tx) => {
          const st = tx.objectStore("boards"), cur: BoardRecord | undefined = await req(st.get(e.ref!));
          if (!cur) throw new WorkspaceError("missing", `the contents of ${e.path} are not in this browser`);
          if (opts.base !== undefined && cur.rev !== opts.base) throw new WorkspaceError("conflict", `${e.path} was changed elsewhere`, cur.doc);
          const { tag: _t, ...rest } = cur;
          st.put({ ...rest, doc: content, rev: cur.rev + 1, updated: t, ...(opts.tag ? { tag: opts.tag } : {}) });
          return cur.rev + 1;
        });
      } else if (e.kind === "file") {
        const b = bytesOf(content);
        if (b.length > this.limits.maxFileBytes) throw new WorkspaceError("limit", `a file is at most ${this.limits.maxFileBytes} bytes`);
        const old = await this.contents(e);
        if (opts.base !== undefined && (e.rev ?? 0) !== opts.base) throw new WorkspaceError("conflict", `${e.path} was changed elsewhere`, old);
        // (the bytes it had, kept as a version first: a write that can't keep them doesn't happen)
        // (nothing to lose, nothing kept: the same bytes again, or, asked for (Python's writes: open("w") empties a file first), empty bytes; CORR-12C-4)
        if (old !== undefined && !sameBytes(old, b) && (old.length > 0 || opts.keepEmpty !== false)) await this.keepVersion(e, old);
        await this.mainTx("files", "readwrite", (st) => st.put(b, e.ref!));
        rev = (e.rev ?? 0) + 1;
        size = b.length;
      } else throw new WorkspaceError("invalid", "a folder has no contents to write");
      const ops: Op[] = [];
      const entry = await inTx(this.ws, ["entries", "ops"], "readwrite", async (tx) => {
        const st = tx.objectStore("entries"), cur: Entry | undefined = await req(st.get(e.path));
        if (!cur || cur.ref !== e.ref) throw new WorkspaceError("conflict", `${e.path} was moved while it was written`);
        const next: Entry = { ...cur, updated: t, ...(e.kind === "file" ? { rev, size, fid: cur.fid ?? e.fid } : {}) };
        delete next.missing;
        st.put(next);
        this.log(tx, ops, { op: "write", path: e.path, kind: e.kind });
        return next;
      });
      this.tell({ ops });
      return { entry, rev };
    });
  }

  /** `from` (and, for a folder, everything in it) moved to `to`, which must
   * be free.  A document whose title was its name gets the new name.
   * `opts.still`, asked holding the lock: false, and nothing is moved
   * (undefined returned): a rename asked for earlier and since superseded,
   * as a typed title's by a rename in the file browser (CORR-0B0-1).
   * `opts.retitle` false: the title left to the page that has the document
   * open, which saves it with its other changes (written here, it would be
   * a change from elsewhere to that page: CORR-0B0-2). */
  async rename(from: string, to: string, opts?: { retitle?: boolean }): Promise<Entry>;
  async rename(from: string, to: string, opts: { still: () => boolean; retitle?: boolean }): Promise<Entry | undefined>;
  async rename(from: string, to: string, opts: { still?: () => boolean; retitle?: boolean } = {}): Promise<Entry | undefined> {
    const a = path(from), b = path(to);
    if (a === "/" || b === "/") throw new WorkspaceError("invalid", "the top folder can't be moved");
    if (within(a, TRASH) || within(b, TRASH)) throw new WorkspaceError("invalid", "use remove and restore for Trash");
    if (a === b) return this.mustStat(a);
    if (within(b, a)) throw new WorkspaceError("invalid", "a folder can't go inside itself");
    return this.locked(async () => {
      if (opts.still && !opts.still()) return undefined;
      const moved = await this.move(a, b, "rename");
      if (opts.retitle !== false) await this.retitle(moved[0], a);
      return moved[0];
    });
  }

  /** A copy of a notebook, board or data file, at `to` (else the first free `name (2)`, … beside it). */
  async duplicate(p: string, to?: string): Promise<Entry> {
    return this.locked(async () => {
      const e = await this.mustStat(p);
      if (e.kind === "folder") throw new WorkspaceError("invalid", "a folder can't be duplicated yet");
      const c = await this.contents(e);
      if (c === undefined) throw new WorkspaceError("missing", `the contents of ${e.path} are not in this browser`);
      let dest = to === undefined ? undefined : path(to);
      if (dest === undefined) {
        const folder = parentOf(e.path), taken = new Set((await this.list(folder)).map((x) => x.path));
        const [base, ext] = splitExt(nameOf(e.path));
        dest = freePath(folder, base, ext, (x) => taken.has(x));
        if (!dest) throw new WorkspaceError("limit", "no free name for the copy");
      }
      if (within(dest, TRASH) || (e.kind !== "file" && kindOf(dest) !== e.kind)) throw new WorkspaceError("invalid", `a copy of ${e.path} can't be ${dest}`);
      if (e.kind === "notebook") {
        const { id: _i, rev: _r, updated: _u, ...doc } = c;
        return this.make(dest, "notebook", doc, e.mode);
      }
      if (e.kind === "board") return this.make(dest, "board", structuredClone((c as BoardRecord).doc), e.mode, (c as BoardRecord).origin);
      return this.make(dest, "file", c);
    });
  }

  /** `p` (and what's in it) put in Trash, as `/Trash/<its name>` (or the
   * first free `name (2)`, …); nothing of its contents removed. */
  async remove(p: string): Promise<Entry> {
    const q = path(p);
    if (q === "/" || within(q, TRASH)) throw new WorkspaceError("invalid", `can't put ${q} in Trash`);
    return this.locked(async () => {
      await this.mustStat(q);
      const taken = new Set((await this.list(TRASH)).map((x) => x.path));
      const [base, ext] = splitExt(nameOf(q));
      const dest = freePath(TRASH, base, ext, (x) => taken.has(x));
      if (!dest) throw new WorkspaceError("limit", "Trash is full: empty it first");
      return (await this.move(q, dest, "remove", { from: q, at: this.now(), id: hex(8) }))[0];
    });
  }

  /** What `p` in Trash was, put back where it was (or, if that's taken now,
   * the first free `name (2)`, … there).  With `expect` (what remove
   * returned), only that same entry, put in Trash that time: checked
   * holding the lock, a WorkspaceError("missing") if it isn't the one
   * there now, nothing moved (Undo, CORR-0B0-3). */
  async restore(p: string, expect?: Entry): Promise<Entry> {
    return this.locked(async () => {
      const e = await this.mustStat(p);
      if (expect && !sameTrashed(e, expect)) throw new WorkspaceError("missing", `${nameOf(expect.trashed?.from ?? expect.path)} was already restored or deleted`);
      if (!e.trashed) throw new WorkspaceError("invalid", within(e.path, TRASH) ? "restore the folder it is in" : `${e.path} isn't in Trash`);
      const from = e.trashed.from, folder = parentOf(from);
      const taken = new Set((await this.list(folder).catch(() => [] as Entry[])).map((x) => x.path));
      const [base, ext] = splitExt(nameOf(from));
      const dest = taken.has(from) ? freePath(folder, base, ext, (x) => taken.has(x)) : from;
      if (!dest) throw new WorkspaceError("limit", `no free name in ${folder}`);
      return (await this.move(e.path, dest, "restore", null))[0];
    });
  }

  /** Changes made from here or in another tab of this browser: `f({ops})`; returns how to stop. */
  watch(f: (c: Change) => void): () => void {
    this.subs.add(f);
    return () => this.subs.delete(f);
  }

  /** The operation log, oldest first, from `after` (a seq). */
  async ops(after = 0): Promise<Op[]> {
    return inTx(this.ws, "ops", "readonly", (tx) => req(tx.objectStore("ops").getAll(IDBKeyRange.lowerBound(after, true))));
  }

  /** A data file's kept versions, in the order they were kept (§2.5); `version(p, i)` reads one's bytes.  (Notebooks' and boards' TimeTravel comes with the pages, step 1b.) */
  async history(p: string): Promise<Version[]> {
    const e = await this.mustStat(p);
    if (e.kind !== "file") throw new WorkspaceError("invalid", "history() is for data files here; a document's is its TimeTravel");
    if (!e.fid) return [];
    const vs: Version[] = await inTx(this.ws, "versions", "readonly", (tx) => req(tx.objectStore("versions").index("byFile").getAll(IDBKeyRange.bound([e.fid, -Infinity], [e.fid, Infinity]))));
    // (in the order they were kept: the ids count up, whatever the clock did)
    return vs.sort((x, y) => x.id! - y.id!);
  }

  /** The bytes of a data file's version `i` (an index into history()). */
  async version(p: string, i: number): Promise<Uint8Array> {
    const v = (await this.history(p))[i];
    if (!v) throw new WorkspaceError("missing", `${path(p)} has no version ${i}`);
    const b = await inTx(this.ws, "versionBytes", "readonly", (tx) => req(tx.objectStore("versionBytes").get(v.id!)));
    if (b === undefined) throw new WorkspaceError("missing", `the bytes of that version are gone`);
    return b;
  }

  /** Old versions of data files dropped for good (§2.5): those of `p` (a
   * file, every file in a folder, or with "/" every version kept), each
   * file keeping its latest `keep` (default none).  Only a person may, from
   * the file browser or the Storage panel after confirming: a workspace
   * acting for an agent (actor "agent:…") is refused, and the agent surfaces
   * (window.sagebrush.workspace, MCP, the endpoint) don't offer it.  Logged.
   * Returns the bytes freed. */
  /** The bytes of `p`'s version `id` (as history() lists it): a
   * WorkspaceError("missing") if it isn't one of this file's, or is gone. */
  async versionById(p: string, id: number): Promise<Uint8Array> {
    const e = await this.mustStat(p);
    if (e.kind !== "file" || !e.fid) throw new WorkspaceError("missing", `${path(p)} has no versions`);
    return inTx(this.ws, ["versions", "versionBytes"], "readonly", async (tx) => {
      const v: Version | undefined = await req(tx.objectStore("versions").get(id));
      if (!v || v.fid !== e.fid) throw new WorkspaceError("missing", `that version of ${e.path} is gone`);
      const b = await req(tx.objectStore("versionBytes").get(id));
      if (b === undefined) throw new WorkspaceError("missing", "the bytes of that version are gone");
      return b as Uint8Array;
    });
  }
  async dropVersions(p: string, opts: { keep?: number } = {}): Promise<number> {
    const q = path(p), keep = Math.max(0, Math.floor(opts.keep ?? 0));
    if (this.actor !== "person") throw new WorkspaceError("invalid", "only a person can drop old versions");
    return this.locked(async () => {
      let fids: Set<string> | null = null, kind: Kind = "folder";
      if (q !== "/") {
        const e = await this.mustStat(q);
        kind = e.kind;
        const files = e.kind === "folder" ? (await this.list(q, { recursive: true })).filter((x) => x.kind === "file") : e.kind === "file" ? [e] : [];
        fids = new Set(files.map((x) => x.fid).filter((x): x is string => !!x));
      }
      const ops: Op[] = [];
      const freed = await inTx(this.ws, ["versions", "versionBytes", "meta", "ops"], "readwrite", async (tx) => {
        const vs = tx.objectStore("versions"), vb = tx.objectStore("versionBytes"), meta = tx.objectStore("meta");
        const all: Version[] = await req(vs.index("byFile").getAll());
        const byFid = new Map<string, Version[]>();
        for (const v of all) if (!fids || fids.has(v.fid)) byFid.set(v.fid, [...(byFid.get(v.fid) ?? []), v]);
        let freed = 0;
        for (const list of byFid.values()) {
          list.sort((x, y) => x.id! - y.id!);
          for (const v of list.slice(0, Math.max(0, list.length - keep))) {
            vs.delete(v.id!);
            vb.delete(v.id!);
            freed += v.size;
          }
        }
        const total = ((await req(meta.get("versionBytes"))) as number | undefined) ?? 0;
        meta.put(Math.max(0, total - freed), "versionBytes");
        this.log(tx, ops, { op: "dropVersions", path: q, kind });
        return freed;
      });
      this.tell({ ops });
      return freed;
    });
  }

  /** The old versions kept of `p`'s data files (a file, a folder's, or
   * with "/" all of them, Trash's too): how many, and their bytes; what
   * dropVersions(p) would free.  Read only: the versions' records, never
   * their bytes. */
  async versionsUsage(p = "/"): Promise<{ count: number; bytes: number }> {
    const q = path(p);
    let fids: Set<string> | null = null;
    if (q !== "/") {
      const e = await this.mustStat(q);
      const files = e.kind === "folder" ? (await this.list(q, { recursive: true })).filter((x) => x.kind === "file") : e.kind === "file" ? [e] : [];
      fids = new Set(files.map((x) => x.fid).filter((x): x is string => !!x));
      if (!fids.size) return { count: 0, bytes: 0 };
    }
    // (all of them: their count and the running total kept with them, no
    // record read; a folder's: each file's, at most maxVersions each)
    return inTx(this.ws, ["versions", "meta"], "readonly", async (tx) => {
      const vs = tx.objectStore("versions");
      if (!fids) return { count: (await req(vs.count())) as number, bytes: (((await req(tx.objectStore("meta").get("versionBytes"))) as number | undefined) ?? 0) };
      let count = 0, bytes = 0;
      for (const fid of fids) {
        const list: Version[] = await req(vs.index("byFile").getAll(IDBKeyRange.bound([fid, -Infinity], [fid, Infinity])));
        for (const v of list) { count++; bytes += v.size; }
      }
      return { count, bytes };
    });
  }

  /** What this browser's workspace holds, for the Storage panel (§6.3):
   * notebooks and boards (how many), data files (how many, their bytes),
   * old versions, and Trash (its entries, and its data files' bytes). */
  async usage(): Promise<{ documents: number; files: { count: number; bytes: number }; versions: { count: number; bytes: number }; trash: { count: number; bytes: number } }> {
    const all = await inTx(this.ws, "entries", "readonly", (tx) => req(tx.objectStore("entries").getAll())) as Entry[];
    const out = { documents: 0, files: { count: 0, bytes: 0 }, versions: await this.versionsUsage("/"), trash: { count: 0, bytes: 0 } };
    for (const e of all) {
      if (within(e.path, TRASH)) {
        if (e.path !== TRASH && parentOf(e.path) === TRASH) out.trash.count++;
        if (e.kind === "file") out.trash.bytes += e.size ?? 0;
      } else if (e.kind === "file") { out.files.count++; out.files.bytes += e.size ?? 0; }
      else if (e.kind === "notebook" || e.kind === "board") out.documents++;
    }
    return out;
  }

  /** (askToKeep, for the person's own writes; never for an agent's, or the migration's, which writes through adopt) */
  private askToKeep() {
    if (this.actor === "person") askToKeep();
  }

  /** Entries in Trash removed for good (§2.4): `paths` (each with what is
   * in it), or everything in Trash.  Their contents go too: a notebook's
   * record and its TimeTravel, a board's record and its TimeTravel, a data
   * file's bytes and its versions.  Only a person may, from the file
   * browser after confirming: refused for an agent's workspace, and not
   * offered to agents.  The entries go first, so a failure part way leaves
   * contents without entries (listed again by reconcile), never entries
   * without contents.  Logged.  Returns how many entries went. */
  async emptyTrash(paths?: string[]): Promise<number> {
    if (this.actor !== "person") throw new WorkspaceError("invalid", "only a person can empty Trash");
    const tops = paths?.map((p) => path(p)) ?? [TRASH];
    for (const t of tops) if (!within(t, TRASH) || (paths && t === TRASH)) throw new WorkspaceError("invalid", `${t} isn't in Trash`);
    return this.locked(async () => {
      const ops: Op[] = [];
      const gone: Entry[] = await inTx(this.ws, ["entries", "ops"], "readwrite", async (tx) => {
        const st = tx.objectStore("entries"), out: Entry[] = [];
        for (const t of tops) {
          const top: Entry | undefined = t === TRASH ? undefined : await req(st.get(t));
          if (t !== TRASH && !top) continue;
          const under: Entry[] = await req(st.getAll(subtree(t)));
          for (const e of [...(top ? [top] : []), ...under]) {
            st.delete(e.path);
            out.push(e);
          }
          this.log(tx, ops, { op: "emptyTrash", path: t, kind: top?.kind ?? "folder" });
        }
        return out;
      });
      // (then their contents, and their histories)
      const hdb = gone.some((e) => e.kind === "notebook") ? await openHistoryDb() : null;
      const bdb = gone.some((e) => e.kind === "board") ? await openBoardHistoryDb() : null;
      const fids = new Set(gone.filter((e) => e.kind === "file" && e.fid).map((e) => e.fid!));
      for (const e of gone) {
        if (e.ref === null) continue;
        try {
          if (e.kind === "notebook") {
            await this.mainTx("notebooks", "readwrite", (st) => st.delete(e.ref!));
            if (hdb) await inTx(hdb, "history", "readwrite", async (tx) => { tx.objectStore("history").delete(IDBKeyRange.bound([e.ref, -Infinity], [e.ref, Infinity])); });
          } else if (e.kind === "board") {
            await inTx(this.ws, "boards", "readwrite", async (tx) => { tx.objectStore("boards").delete(e.ref!); });
            // (its TimeTravel: by the board's source, "board:local:<id>", with its name in this browser after it)
            const pre = "board:local:" + e.ref;
            if (bdb) await inTx(bdb, "history", "readwrite", async (tx) => { tx.objectStore("history").delete(IDBKeyRange.bound([pre, -Infinity], [pre + ":\uffff", Infinity])); });
            // (and what the board page keeps of it in localStorage: the copy
            // from before the workspace, its mark as written here, a closed
            // page's changes; none of them bring it back, or vouch for a
            // board under its id)
            try {
              const ls = (globalThis as any).localStorage as Storage | undefined;
              for (const k of Object.values(BOARD_KEYS)) ls?.removeItem(k(e.ref));
            } catch {}
          } else if (e.kind === "file") {
            await inTx(this.ws, "trash", "readwrite", async (tx) => { tx.objectStore("trash").delete(e.ref!); });
          }
        } catch (err) { console.warn("workspace: emptying Trash:", err); }
      }
      if (fids.size) {
        await inTx(this.ws, ["versions", "versionBytes", "meta"], "readwrite", async (tx) => {
          const vs = tx.objectStore("versions"), vb = tx.objectStore("versionBytes"), meta = tx.objectStore("meta");
          let freed = 0;
          for (const fid of fids) {
            const list: Version[] = await req(vs.index("byFile").getAll(IDBKeyRange.bound([fid, -Infinity], [fid, Infinity])));
            for (const v of list) { vs.delete(v.id!); vb.delete(v.id!); freed += v.size; }
          }
          const total = ((await req(meta.get("versionBytes"))) as number | undefined) ?? 0;
          meta.put(Math.max(0, total - freed), "versionBytes");
        });
      }
      hdb?.close();
      bdb?.close();
      this.tell({ ops });
      return gone.length;
    });
  }

  // ------------------------------------------------------------ for the pages

  /** The path of the entry naming these contents (a board's or notebook's id, a data file's key), or undefined. */
  async pathOf(kind: Exclude<Kind, "folder">, ref: string): Promise<string | undefined> {
    return inTx(this.ws, "entries", "readonly", (tx) => req(tx.objectStore("entries").index("byRef").getKey([kind, ref]))) as Promise<string | undefined>;
  }

  /** A data file written at `p`: made if it isn't there, else written over (its old bytes kept as a version, §2.5).  What Python's writes and the Files panel's uploads go through. */
  async putFile(p: string, bytes: unknown, opts: { keepEmpty?: boolean } = {}): Promise<Entry> {
    const q = path(p);
    const e = await this.stat(q);
    if (!e) return this.create(q, { content: bytes }).catch(async (err) => {
      // (made meanwhile, by another tab: written over instead)
      if (err instanceof WorkspaceError && err.code === "exists" && (await this.stat(q))) return (await this.write(q, bytes, opts)).entry;
      throw err;
    });
    if (e.kind !== "file") throw new WorkspaceError("exists", `${q} is a ${e.kind}, not a file`);
    return (await this.write(q, bytes, opts)).entry;
  }

  /** An entry dropped from the index, its contents already removed by the
   * page (a notebook deleted from the Open dialog, as before Trash is in
   * the UI).  For the pages only: not offered to agents. */
  async forget(p: string): Promise<void> {
    const q = path(p);
    if (this.actor !== "person") throw new WorkspaceError("invalid", "only the page itself forgets entries");
    return this.locked(async () => {
      const ops: Op[] = [];
      await inTx(this.ws, ["entries", "ops"], "readwrite", async (tx) => {
        const st = tx.objectStore("entries"), e: Entry | undefined = await req(st.get(q));
        if (!e) return;
        if (e.kind === "folder" && (await req(st.count(subtree(q)))) > 0) throw new WorkspaceError("invalid", `${q} isn't empty`);
        st.delete(q);
        this.log(tx, ops, { op: "forget", path: q, kind: e.kind });
      });
      this.tell({ ops });
    });
  }

  /** The workspace as an agent sees it (§8.2): the verbs, its changes
   * credited to `actor` ("agent:<name>"), and none of what only a person
   * does (dropVersions, forget). */
  forAgent(actor: string) {
    if (!/^agent:[\w.-]{1,64}$/.test(actor)) throw new WorkspaceError("invalid", "an agent is agent:<name>");
    const as: Workspace = Object.create(this);
    as.actor = actor;
    const verbs = ["list", "stat", "read", "write", "create", "mkdir", "rename", "duplicate", "remove", "restore", "history", "version", "watch", "ops"] as const;
    const bound: Record<string, unknown> = Object.fromEntries(verbs.map((v) => [v, (as as any)[v].bind(as)]));
    // (an agent writes with base only: a board's tag says which page session wrote it, and isn't an agent's to claim)
    bound.write = (p: string, content: unknown, opts: { base?: number } = {}) => as.write(p, content, opts?.base !== undefined ? { base: opts.base } : {});
    return Object.freeze(bound) as Pick<Workspace, (typeof verbs)[number]>;
  }

  // ------------------------------------------------------------ inside

  /** `bytes`, what the data file `e` had, kept as its version (§2.5), and
   * the oldest versions dropped past the bounds (never this one): the
   * file's latest maxVersions, none older than maxVersionAgeMs, all of them
   * within maxVersionBytes.  Bytes that can't be kept are an error. */
  async keepVersion(e: Entry, bytes: Uint8Array) {
    const fid = e.fid;
    if (!fid) return;
    if (bytes.length > this.limits.maxVersionBytes) throw new WorkspaceError("limit", `${e.path}'s present bytes are too large to keep as a version, so it isn't written over`);
    const t = this.now(), sha256 = await bytesHash(bytes);
    try {
      await inTx(this.ws, ["versions", "versionBytes", "meta"], "readwrite", async (tx) => {
        const vs = tx.objectStore("versions"), vb = tx.objectStore("versionBytes"), meta = tx.objectStore("meta");
        const id = (await req(vs.add({ fid, t, size: bytes.length, sha256, by: this.actor, device: this.device } satisfies Version))) as number;
        vb.put(bytes, id);
        let total = ((await req(meta.get("versionBytes"))) as number | undefined ?? 0) + bytes.length;
        const drop = (v: Version) => { vs.delete(v.id!); vb.delete(v.id!); total -= v.size; };
        // (this file's others, oldest first, by the order they were kept (the
        // ids count up; a clock set back doesn't reorder them): past the
        // count left beside the one just kept, or past the age.  The one just
        // kept is counted apart, so the count is always right: CORR-BEF-1)
        const others = ((await req(vs.index("byFile").getAll(IDBKeyRange.bound([fid, -Infinity], [fid, Infinity])))) as Version[]).filter((v) => v.id !== id).sort((x, y) => x.id! - y.id!);
        const room = Math.max(0, this.limits.maxVersions - 1);
        others.forEach((v, i) => { if (i < others.length - room || v.t < t - this.limits.maxVersionAgeMs) drop(v); });
        // (everyone's, oldest first, past the bytes; deletes made above are already out of this read)
        if (total > this.limits.maxVersionBytes) {
          const old: Version[] = await req(vs.getAll());
          for (const v of old) {
            if (total <= this.limits.maxVersionBytes) break;
            if (v.id === id) continue;
            drop(v);
          }
        }
        meta.put(Math.max(0, total), "versionBytes");
      });
    } catch (err) {
      if (err instanceof WorkspaceError) throw err;
      throw new WorkspaceError("storage", `${e.path}'s present bytes couldn't be kept as a version (${(err as Error)?.name ?? err}), so it isn't written over`);
    }
  }

  /** `f` holding the workspace's lock: one change at a time in all of this
   * browser's tabs.  Without Web Locks there is no such lock, and changes
   * that span the two databases could interleave and undo each other's
   * bytes, so none are made (CORR-4A0-5): a WorkspaceError("storage"). */
  async locked<T>(f: () => Promise<T>): Promise<T> {
    const locks = (globalThis.navigator as any)?.locks;
    if (!locks || typeof locks.request !== "function") throw new WorkspaceError("storage", "this browser has no Web Locks, which changes to the workspace need: nothing was changed");
    return locks.request(LOCK, f);
  }

  async mustStat(p: string): Promise<Entry> {
    const e = await this.stat(p);
    if (!e) throw new WorkspaceError("missing", `${path(p)} isn't in this workspace`);
    return e;
  }

  /** An entry's contents: a notebook's record, a board's record, a data file's bytes; undefined if not there. */
  async contents(e: Entry): Promise<any> {
    if (e.kind === "notebook") return this.mainTx("notebooks", "readonly", (st) => st.get(e.ref!));
    if (e.kind === "board") return inTx(this.ws, "boards", "readonly", (tx) => req(tx.objectStore("boards").get(e.ref!)));
    if (e.kind === "file") {
      if (e.trashed || within(e.path, TRASH)) return inTx(this.ws, "trash", "readonly", (tx) => req(tx.objectStore("trash").get(e.ref!)));
      return this.mainTx("files", "readonly", (st) => st.get(e.ref!));
    }
    return undefined;
  }

  /** One request on "sagebrush" (notebooks, files), or a WorkspaceError("storage") where there is none. */
  async mainTx<T>(store: string, mode: IDBTransactionMode, f: (st: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    if (!this.main) throw new WorkspaceError("storage", "this browser has no storage for notebooks and files");
    return inTx(this.main, store, mode, (tx) => req(f(tx.objectStore(store))));
  }

  private checkBoard(doc: unknown) {
    if (!isBoard(doc)) throw new WorkspaceError("invalid", "not a board");
    if (JSON.stringify(doc).length > this.limits.maxBoardBytes) throw new WorkspaceError("limit", `a board is at most ${this.limits.maxBoardBytes} characters of JSON`);
  }

  /** The contents written, then the entry; the contents taken back if the entry can't be. */
  async make(q: string, kind: Exclude<Kind, "folder">, content: unknown, mode?: string, origin?: string): Promise<Entry> {
    if (await this.stat(q)) throw new WorkspaceError("exists", `${q} is there already`);
    const t = this.now();
    let ref: string, size: number | undefined, undo: () => Promise<unknown>;
    if (kind === "notebook") {
      if (!this.main) throw new WorkspaceError("storage", "this browser has no storage for notebooks");
      const given = (content ?? {}) as any;
      if (typeof given !== "object" || (given.cells !== undefined && !Array.isArray(given.cells))) throw new WorkspaceError("invalid", "a notebook is {cells: [...]}");
      const { id: _i, rev: _r, updated: _u, baseRev: _b, ...doc } = given;
      ref = crypto.randomUUID();
      mode = mode ?? doc.mode ?? "python";
      const out = await new IdbStore(this.main, ref).save({ ...doc, cells: doc.cells ?? [], mode, name: splitExt(nameOf(q))[0], id: ref });
      if (typeof out === "string") throw new WorkspaceError("storage", out);
      undo = () => this.mainTx("notebooks", "readwrite", (st) => st.delete(ref));
    } else if (kind === "board") {
      const doc = content ?? { title: splitExt(nameOf(q))[0], ...(mode && mode !== "python" ? { mode } : {}), nodes: [] };
      this.checkBoard(doc);
      mode = mode ?? (doc as any).mode ?? "python";
      ref = await inTx(this.ws, "boards", "readwrite", async (tx) => {
        const st = tx.objectStore("boards");
        for (;;) {
          const id = hex(6);
          if ((await req(st.getKey(id))) === undefined) {
            st.add({ id, doc, rev: 1, updated: t, ...(origin ? { origin } : {}) } satisfies BoardRecord);
            return id;
          }
        }
      });
      undo = () => inTx(this.ws, "boards", "readwrite", async (tx) => tx.objectStore("boards").delete(ref));
    } else {
      const b = bytesOf(content ?? new Uint8Array(0));
      if (b.length > this.limits.maxFileBytes) throw new WorkspaceError("limit", `a file is at most ${this.limits.maxFileBytes} bytes`);
      // (bytes already kept at that path, with no entry, are someone's: not written over)
      if ((await this.mainTx("files", "readonly", (st) => st.getKey(q))) !== undefined) throw new WorkspaceError("exists", `${q} is there already (as a file not yet listed)`);
      await this.mainTx("files", "readwrite", (st) => st.put(b, q));
      ref = q;
      size = b.length;
      // (taken back only if no entry names them: never another's bytes)
      undo = async () => {
        const named = await inTx(this.ws, "entries", "readonly", (tx) => req(tx.objectStore("entries").index("byRef").getKey(["file", q])));
        if (named === undefined) await this.mainTx("files", "readwrite", (st) => st.delete(q));
      };
    }
    const ops: Op[] = [];
    try {
      const entry = await inTx(this.ws, ["entries", "ops"], "readwrite", async (tx) => {
        const st = tx.objectStore("entries");
        if ((await req(st.getKey(q))) !== undefined) throw new WorkspaceError("exists", `${q} is there already`);
        await this.folders(tx, parentOf(q), ops);
        await this.room(st, q);
        const e: Entry = { path: q, kind, ref, created: t, updated: t, ...(mode ? { mode } : {}), ...(kind === "file" ? { size, rev: 0, fid: hex(8) } : {}), ...(origin ? { origin } : {}) };
        st.put(e);
        this.log(tx, ops, { op: "create", path: q, kind });
        return e;
      });
      this.tell({ ops });
      return entry;
    } catch (e) {
      await undo().catch(() => {});
      throw e;
    }
  }

  /** An entry for contents that are already kept (migration, reconcile):
   * at `base + ext` in `folder`, or the first free `base (2) + ext`, …
   * Hold the lock (locked()) around it. */
  async adopt(folder: string, base: string, ext: string, fields: Omit<Entry, "path" | "created" | "updated"> & { created?: number; updated?: number }, also: { at?: string; board?: BoardRecord; meta?: [string, unknown][]; dropMeta?: string[]; dropTrash?: string[] } = {}): Promise<Entry> {
    // (with the entry, in its transaction: a board's record, records put in
    // or dropped from meta, bytes dropped from trash; all of it, or none)
    const ops: Op[] = [];
    const stores = ["entries", "ops", ...(also.board ? ["boards"] : []), ...(also.meta?.length || also.dropMeta?.length ? ["meta"] : []), ...(also.dropTrash?.length ? ["trash"] : [])];
    const entry = await inTx(this.ws, stores, "readwrite", async (tx) => {
      const st = tx.objectStore("entries");
      const taken = new Set((await req(st.getAllKeys(subtree(folder)))) as string[]);
      const p = also.at ?? freePath(folder, base, ext, (x) => taken.has(x));
      if (!p) throw new WorkspaceError("limit", `no free name in ${folder}`);
      if (also.at && (await req(st.getKey(also.at))) !== undefined) throw new WorkspaceError("exists", `${also.at} is there already`);
      if (also.board) tx.objectStore("boards").put(also.board);
      for (const [k, v] of also.meta ?? []) tx.objectStore("meta").put(v, k);
      for (const k of also.dropMeta ?? []) tx.objectStore("meta").delete(k);
      for (const k of also.dropTrash ?? []) tx.objectStore("trash").delete(k);
      await this.folders(tx, parentOf(p), ops);
      await this.room(st, p);
      const t = this.now();
      const e: Entry = { created: t, updated: t, ...fields, ...(fields.kind === "file" && !fields.fid ? { fid: hex(8) } : {}), path: p };
      st.put(e);
      this.log(tx, ops, { op: "adopt", path: p, kind: e.kind });
      return e;
    });
    this.tell({ ops });
    return entry;
  }

  /** The folders `folder` and those above it, made where missing (in `tx`); a file in the way is an error. */
  private async folders(tx: IDBTransaction, folder: string, ops: Op[]) {
    const st = tx.objectStore("entries");
    const names = folder === "/" ? [] : folder.slice(1).split("/");
    let at = "";
    for (const n of names) {
      at += "/" + n;
      const e: Entry | undefined = await req(st.get(at));
      if (e && e.kind !== "folder") throw new WorkspaceError("exists", `${at} is a ${e.kind}, not a folder`);
      if (!e) {
        await this.room(st, at);
        const t = this.now();
        st.put({ path: at, kind: "folder", ref: null, created: t, updated: t } satisfies Entry);
        this.log(tx, ops, { op: "mkdir", path: at, kind: "folder" });
      }
    }
  }

  /** Room for one more entry, `p`: in the workspace (maxEntries) and in its
   * folder (maxFolderEntries direct entries, §6.3: LIMIT-094-1).  A folder's
   * own entries are counted only when everything under it comes near the
   * bound, so the usual case costs two counts. */
  private async room(st: IDBObjectStore, p: string) {
    const total = await req(st.count());
    if (total + 1 > this.limits.maxEntries) throw new WorkspaceError("limit", `a workspace holds at most ${this.limits.maxEntries} entries`);
    await this.folderRoom(st, parentOf(p), total);
  }

  private async folderRoom(st: IDBObjectStore, folder: string, total?: number) {
    const max = this.limits.maxFolderEntries;
    const under = folder === "/" ? (total ?? (await req(st.count()))) : await req(st.count(subtree(folder)));
    if (under + 1 <= max) return;
    const keys = (await req(st.getAllKeys(subtree(folder)))) as string[];
    const direct = keys.filter((k) => k.indexOf("/", folder === "/" ? 1 : folder.length + 1) === -1).length;
    if (direct + 1 > max) throw new WorkspaceError("limit", `a folder holds at most ${max} entries: ${folder} is full`);
  }

  private log(tx: IDBTransaction, ops: Op[], op: Omit<Op, "t" | "device" | "by">) {
    const rec: Op = { ...op, t: this.now(), device: this.device, by: this.actor };
    tx.objectStore("ops").add(rec);
    ops.push(rec);
  }

  /** `a` and everything under it moved to `b` (free), data files' bytes with
   * them: to their new path in "sagebrush"/files, or into or out of
   * "sagebrush-workspace"/trash.  The bytes are copied first, the entries
   * moved in one transaction, then the old bytes removed: a failure between
   * leaves a copy, never a loss. */
  private async move(a: string, b: string, op: "rename" | "remove" | "restore", trashed?: Entry["trashed"] | null): Promise<Entry[]> {
    const t = this.now();
    const old: Entry[] = await inTx(this.ws, "entries", "readonly", async (tx) => {
      const st = tx.objectStore("entries"), top: Entry | undefined = await req(st.get(a));
      if (!top) throw new WorkspaceError("missing", `${a} isn't in this workspace`);
      return top.kind === "folder" ? [top, ...((await req(st.getAll(subtree(a)))) as Entry[])] : [top];
    });
    const to = (p: string) => b + p.slice(a.length);
    const inTrash = (p: string) => within(p, TRASH);
    // (every new path a path the workspace takes, before anything moves: CORR-4A0-4)
    for (const e of old) {
      try { normPath(to(e.path)); } catch (err) { throw new WorkspaceError("invalid", `moving ${a} to ${b} would make ${to(e.path).slice(0, 80)}…: ${(err as Error).message}`); }
    }
    // data files whose bytes move: [entry, new key]
    const files = old.filter((e) => e.kind === "file" && e.ref !== null).map((e) => [e, to(e.path)] as const);
    const copied: (() => Promise<unknown>)[] = [];
    try {
      for (const [e, key] of files) {
        const bytes = await this.contents(e);
        if (bytes === undefined) continue; // (missing contents: the entry moves alone)
        if (inTrash(key)) {
          await inTx(this.ws, "trash", "readwrite", async (tx) => { tx.objectStore("trash").put(bytes, key); });
          copied.push(() => inTx(this.ws, "trash", "readwrite", async (tx) => { tx.objectStore("trash").delete(key); }));
        } else {
          if ((await this.mainTx("files", "readonly", (st) => st.getKey(key))) !== undefined) throw new WorkspaceError("exists", `${key} is there already (as a file not yet listed)`);
          await this.mainTx("files", "readwrite", (st) => st.put(bytes, key));
          copied.push(() => this.mainTx("files", "readwrite", (st) => st.delete(key)));
        }
      }
      const ops: Op[] = [];
      const moved = await inTx(this.ws, ["entries", "ops"], "readwrite", async (tx) => {
        const st = tx.objectStore("entries");
        if ((await req(st.getKey(b))) !== undefined || (await req(st.count(subtree(b)))) > 0) throw new WorkspaceError("exists", `${b} is there already`);
        for (const e of old) {
          const now: Entry | undefined = await req(st.get(e.path));
          if (!now || now.ref !== e.ref) throw new WorkspaceError("conflict", `${e.path} changed while it was moved`);
        }
        await this.folders(tx, parentOf(b), ops);
        // (one more entry in b's folder, unless it was already there: LIMIT-094-1)
        if (parentOf(a) !== parentOf(b)) await this.folderRoom(st, parentOf(b));
        const out: Entry[] = [];
        for (const e of old) {
          st.delete(e.path);
          const n: Entry = { ...e, path: to(e.path), ...(e.kind === "file" && e.ref !== null ? { ref: to(e.path) } : {}) };
          if (e.path === a) {
            n.updated = t;
            if (trashed) n.trashed = trashed;
            else if (trashed === null) delete n.trashed;
          }
          st.put(n);
          out.push(n);
        }
        this.log(tx, ops, { op, path: a, to: b, kind: old[0].kind });
        return out;
      });
      copied.length = 0;
      // (the old bytes, now that nothing names them)
      for (const [e] of files) {
        if (inTrash(e.path)) await inTx(this.ws, "trash", "readwrite", async (tx) => { tx.objectStore("trash").delete(e.ref!); }).catch(() => {});
        else await this.mainTx("files", "readwrite", (st) => st.delete(e.ref!)).catch(() => {});
      }
      this.tell({ ops });
      return moved;
    } finally {
      for (const undo of copied) await undo().catch(() => {});
    }
  }

  /** A renamed document whose title was its old name: titled with its new one. */
  private async retitle(e: Entry, was: string) {
    const oldName = splitExt(nameOf(was))[0], newName = splitExt(nameOf(e.path))[0];
    if (oldName === newName) return;
    if (e.kind === "notebook" && this.main) {
      for (let i = 0; i < 5; i++) {
        const rec = await this.contents(e);
        if (!rec || (rec.name ?? "") !== oldName) return;
        const out = await new IdbStore(this.main, e.ref!).save({ ...rec, name: newName, baseRev: rec.rev });
        if (typeof out === "string" || !out.conflict) return;
      }
    } else if (e.kind === "board") {
      await inTx(this.ws, "boards", "readwrite", async (tx) => {
        const st = tx.objectStore("boards"), rec: BoardRecord | undefined = await req(st.get(e.ref!));
        if (rec && String(rec.doc?.title ?? "") === oldName) st.put({ ...rec, doc: { ...rec.doc, title: newName }, rev: rec.rev + 1, updated: this.now() });
      });
    }
  }

  /** Changes told to this tab's watchers, and (made here) to the other tabs. */
  tell(c: Change, broadcast = true) {
    if (!c.ops.length) return;
    if (broadcast) try { this.channel?.postMessage({ from: this.tab, ops: c.ops }); } catch {}
    for (const f of this.subs) try { f(c); } catch (e) { console.warn("workspace watcher:", e); }
  }
}


