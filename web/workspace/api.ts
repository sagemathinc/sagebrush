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
import { IdbStore, bytesHash, openDb as openMainDb } from "../notebook/stores.js";
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
  /** in Trash: where it was, and when it was put there */
  trashed?: { from: string; at: number };
  /** a board made from an edited example or a board on the web: its address */
  origin?: string;
  /** contents reconcile could not find (shown, never dropped) */
  missing?: boolean;
};
export type Op = { seq?: number; t: number; device: string; by: string; op: string; path: string; to?: string; kind: Kind };
/** An earlier version of a data file (§2.5): its bytes are in versionBytes under `id`. */
export type Version = { id?: number; fid: string; t: number; size: number; sha256: string; by: string; device: string };
export type BoardRecord = { id: string; doc: any; rev: number; updated: number; docId?: string; origin?: string };
export type Limits = { maxFileBytes: number; maxBoardBytes: number; maxEntries: number; maxVersions: number; maxVersionAgeMs: number; maxVersionBytes: number };
/** §6.3: one upload at most 200 MB; a board's JSON at most 64 MB; the
 * workspace at most 100,000 entries.  §2.5: a data file's latest 20
 * versions, none older than 30 days, all of them at most 1 GB. */
export const LIMITS: Limits = { maxFileBytes: 200 * 2 ** 20, maxBoardBytes: 64 * 2 ** 20, maxEntries: 100_000, maxVersions: 20, maxVersionAgeMs: 30 * 864e5, maxVersionBytes: 2 ** 30 };

export type WorkspaceErrorCode = "invalid" | "exists" | "missing" | "conflict" | "limit" | "storage";
export class WorkspaceError extends Error {
  constructor(public code: WorkspaceErrorCode, message: string, public current?: unknown) { super(message); }
}

const CHANNEL = "sagebrush-workspace";
const LOCK = "sagebrush-workspace";
type Change = { ops: Op[] };

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
// (every path at and under `p`, in the entries' key order)
const subtree = (p: string) => (p === "/" ? undefined : IDBKeyRange.bound(p + "/", p + "/￿"));

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
  async read(p: string): Promise<{ entry: Entry; content: any; rev: number }> {
    const e = await this.mustStat(p);
    if (e.kind === "folder") return { entry: e, content: await this.list(e.path), rev: 0 };
    const c = await this.contents(e);
    if (c === undefined) throw new WorkspaceError("missing", `the contents of ${e.path} are not in this browser`);
    if (e.kind === "notebook") return { entry: e, content: c, rev: c.rev ?? 0 };
    if (e.kind === "board") return { entry: e, content: (c as BoardRecord).doc, rev: (c as BoardRecord).rev };
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
    return this.locked(() => this.make(q, kind, opts.content, opts.mode));
  }

  /** New contents for a notebook, board or data file; with `base` (the
   * revision read() gave), only if nothing else wrote it since: otherwise a
   * WorkspaceError("conflict") with the current contents, nothing written. */
  async write(p: string, content: unknown, opts: { base?: number } = {}): Promise<{ entry: Entry; rev: number }> {
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
          st.put({ ...cur, doc: content, rev: cur.rev + 1, updated: t });
          return cur.rev + 1;
        });
      } else if (e.kind === "file") {
        const b = bytesOf(content);
        if (b.length > this.limits.maxFileBytes) throw new WorkspaceError("limit", `a file is at most ${this.limits.maxFileBytes} bytes`);
        const old = await this.contents(e);
        if (opts.base !== undefined && (e.rev ?? 0) !== opts.base) throw new WorkspaceError("conflict", `${e.path} was changed elsewhere`, old);
        // (the bytes it had, kept as a version first: a write that can't keep them doesn't happen)
        if (old !== undefined) await this.keepVersion(e, old);
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
   * be free.  A document whose title was its name gets the new name. */
  async rename(from: string, to: string): Promise<Entry> {
    const a = path(from), b = path(to);
    if (a === "/" || b === "/") throw new WorkspaceError("invalid", "the top folder can't be moved");
    if (within(a, TRASH) || within(b, TRASH)) throw new WorkspaceError("invalid", "use remove and restore for Trash");
    if (a === b) return this.mustStat(a);
    if (within(b, a)) throw new WorkspaceError("invalid", "a folder can't go inside itself");
    return this.locked(async () => {
      const moved = await this.move(a, b, "rename");
      await this.retitle(moved[0], a);
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
      return (await this.move(q, dest, "remove", { from: q, at: this.now() }))[0];
    });
  }

  /** What `p` in Trash was, put back where it was (or, if that's taken now, the first free `name (2)`, … there). */
  async restore(p: string): Promise<Entry> {
    return this.locked(async () => {
      const e = await this.mustStat(p);
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

  /** A data file's kept versions, oldest first (§2.5); `version(p, i)` reads one's bytes.  (Notebooks' and boards' TimeTravel comes with the pages, step 1b.) */
  async history(p: string): Promise<Version[]> {
    const e = await this.mustStat(p);
    if (e.kind !== "file") throw new WorkspaceError("invalid", "history() is for data files here; a document's is its TimeTravel");
    if (!e.fid) return [];
    return inTx(this.ws, "versions", "readonly", (tx) => req(tx.objectStore("versions").index("byFile").getAll(IDBKeyRange.bound([e.fid, -Infinity], [e.fid, Infinity]))));
  }

  /** The bytes of a data file's version `i` (an index into history()). */
  async version(p: string, i: number): Promise<Uint8Array> {
    const v = (await this.history(p))[i];
    if (!v) throw new WorkspaceError("missing", `${path(p)} has no version ${i}`);
    const b = await inTx(this.ws, "versionBytes", "readonly", (tx) => req(tx.objectStore("versionBytes").get(v.id!)));
    if (b === undefined) throw new WorkspaceError("missing", `the bytes of that version are gone`);
    return b;
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
        // (this file's: past the count or the age)
        const mine: Version[] = await req(vs.index("byFile").getAll(IDBKeyRange.bound([fid, -Infinity], [fid, Infinity])));
        mine.forEach((v, i) => { if (v.id !== id && (i < mine.length - this.limits.maxVersions || v.t < t - this.limits.maxVersionAgeMs)) drop(v); });
        // (everyone's, oldest first, past the bytes)
        if (total > this.limits.maxVersionBytes) {
          const gone = new Set(mine.filter((v) => v.id !== id && (mine.indexOf(v) < mine.length - this.limits.maxVersions || v.t < t - this.limits.maxVersionAgeMs)).map((v) => v.id));
          const old: Version[] = await req(vs.index("byTime").getAll());
          for (const v of old) {
            if (total <= this.limits.maxVersionBytes) break;
            if (v.id === id || gone.has(v.id)) continue;
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

  /** `f` holding the workspace's lock: one change at a time in all of this browser's tabs. */
  locked<T>(f: () => Promise<T>): Promise<T> {
    const locks = (globalThis.navigator as any)?.locks;
    return locks ? locks.request(LOCK, f) : f();
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
      undo = () => this.mainTx("files", "readwrite", (st) => st.delete(q));
    }
    const ops: Op[] = [];
    try {
      const entry = await inTx(this.ws, ["entries", "ops"], "readwrite", async (tx) => {
        const st = tx.objectStore("entries");
        if ((await req(st.getKey(q))) !== undefined) throw new WorkspaceError("exists", `${q} is there already`);
        await this.folders(tx, parentOf(q), ops);
        await this.room(st, 1);
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
  async adopt(folder: string, base: string, ext: string, fields: Omit<Entry, "path" | "created" | "updated"> & { created?: number; updated?: number }): Promise<Entry> {
    const ops: Op[] = [];
    const entry = await inTx(this.ws, ["entries", "ops"], "readwrite", async (tx) => {
      const st = tx.objectStore("entries");
      const taken = new Set((await req(st.getAllKeys(subtree(folder)))) as string[]);
      const p = freePath(folder, base, ext, (x) => taken.has(x));
      if (!p) throw new WorkspaceError("limit", `no free name in ${folder}`);
      await this.folders(tx, folder, ops);
      await this.room(st, 1);
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
        await this.room(st, 1);
        const t = this.now();
        st.put({ path: at, kind: "folder", ref: null, created: t, updated: t } satisfies Entry);
        this.log(tx, ops, { op: "mkdir", path: at, kind: "folder" });
      }
    }
  }

  private async room(st: IDBObjectStore, n: number) {
    if ((await req(st.count())) + n > this.limits.maxEntries) throw new WorkspaceError("limit", `a workspace holds at most ${this.limits.maxEntries} entries`);
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


