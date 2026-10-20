// The shared reducer of the workspace index's operation log
// (design/sync-client.md §3 and C4; design/sync-server.md §3): the server's
// ops, applied in its `seq` order, give every device the same index.  The
// client builds its confirmed index with it, and the server will build its
// `entries` with it (later), against the same JSON vectors
// (sync-vectors.json), so the two can't disagree.
//
// No DOM, IndexedDB or clock: only paths' rules and a synchronous SHA-256,
// so a Worker, the page and the server can all bundle it.
//
// The rules:
// - Targets are identities, never paths: a data file's or folder's `fid`, a
//   document's `ref`.  A rename, write, remove or restore applies to its
//   identity wherever it is now, so path reuse can't misdirect it.
// - Where an op puts something (create, mkdir, adopt, a write that makes
//   its file, rename, restore) is the folder its `parent` names, by
//   identity, wherever that folder is now (brought back first if it is in
//   Trash: the edit wins).  Without `parent`, or naming no folder this index
//   has, it is the folder its path names, made if it isn't there (with an
//   identity derived from the op).
// - Order is `seq` only; `t` is shown, never ordered by.
// - A new entry, or one moved, at a path another entry has (or one whose
//   names look the same: NFC, as the workspace's lookalike refusal) takes
//   the first free `name (2)`, `name (3)`, … there; a name that would be too
//   long for it is shortened first.
// - A write: `base` the current `sha256`, applied; the same `sha256`,
//   nothing; another `base` (a concurrent write), a conflict copy beside it,
//   `name (conflict, <device's first 8>).ext`, with a derived identity.  A
//   write to an identity in Trash brings it (with the folder it is in) back
//   first: the edit wins.  A write to an identity forgotten for good is a
//   conflict copy at its last path; to one never seen, a create.
// - A remove puts its identity in Trash; a restore takes it out; a rename
//   of an identity in Trash takes it out to where the rename says (the
//   later op wins).
// - A derived identity is never one this index has, has forgotten, or that
//   the op itself names: the next of a deterministic series is taken.
// - An op applies whole or not at all: one that can't (its form, an
//   identity it doesn't carry, a move into itself, a path past the
//   workspace's bounds, its own or any it would make) changes nothing, and
//   says why.  The log is never redefined.
import { MAX_DEPTH, MAX_NAME, MAX_PATH, TRASH, join, kindOf, nameOf, normPath, parentOf, splitExt, within, type Kind } from "./paths";
import { sha256Hex } from "../../src/runtime/sha256";

/** An op of the server's log (sync-server §5.2's `index` message). */
export type SyncOp = {
  seq: number;
  device: string;
  dseq: number;
  t: number;
  by: string;
  op: string;
  path: string;
  to?: string;
  kind: Kind;
  ref?: string;
  fid?: string;
  /** the folder the op puts something in (create, mkdir, adopt, write, rename, restore): its fid; absent, by the path */
  parent?: string;
  sha256?: string;
  size?: number;
  base?: string;
};

/** An entry of the reduced index. */
export type SyncEntry = {
  /** its identity: `fid` for a data file or folder, `ref` for a document */
  id: string;
  path: string;
  kind: Kind;
  ref?: string;
  fid?: string;
  sha256?: string;
  size?: number;
  /** put in Trash (the entry itself, not one inside a folder put there): from where, and when */
  trashed?: { from: string; at: number };
  created: number;
  updated: number;
  by: string;
  /** the `seq` of the last op that changed it */
  seq: number;
};

/** What one op did: the identities it changed (made, moved, written or gone), or why it did nothing. */
export type Outcome = { changed: string[]; skipped?: string };

/** The index: entries by identity, by path (its NFC form) and by folder, and the last path of each identity forgotten.  clone() copies all of it (O(entries)): once per snapshot or page, never per op. */
export class SyncIndex {
  readonly byId = new Map<string, SyncEntry>();
  readonly byKey = new Map<string, string>();
  readonly children = new Map<string, Set<string>>();
  readonly gone = new Map<string, string>();

  /** The entries, by path. */
  entries(): SyncEntry[] {
    return [...this.byId.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }

  /** An independent copy. */
  clone(): SyncIndex {
    const c = new SyncIndex();
    for (const [id, e] of this.byId) c.byId.set(id, copy(e));
    for (const [k, id] of this.byKey) c.byKey.set(k, id);
    for (const [k, s] of this.children) c.children.set(k, new Set(s));
    for (const [id, p] of this.gone) c.gone.set(id, p);
    return c;
  }

  at(path: string): SyncEntry | undefined {
    const id = this.byKey.get(keyOf(path));
    return id === undefined ? undefined : this.byId.get(id);
  }
}

// (a path's key: lookalike names, the same NFC form, are one path, as the workspace's refusal has it)
const keyOf = (p: string) => p.normalize("NFC");
const copy = (e: SyncEntry): SyncEntry => ({ ...e, ...(e.trashed ? { trashed: { ...e.trashed } } : {}) });
const HEX16 = /^[0-9a-f]{16}$/, HEX12 = /^[0-9a-f]{12}$/, HEX64 = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KINDS = new Set(["notebook", "board", "file", "folder"]);
// (ops that put something in a folder, and so may say which)
const PLACING = new Set(["create", "adopt", "mkdir", "write", "rename", "restore"]);
const enc = new TextEncoder();
const derive = (...parts: (string | number)[]) => sha256Hex(enc.encode(parts.join("\u0000"))).slice(0, 16);
/** Whether `p` is a path the workspace can hold, exactly as it is. */
const valid = (p: string) => {
  try {
    return normPath(p) === p;
  } catch {
    return false;
  }
};
/** Whether an entry may be at `p` (astra's CORR-7F4-1): never the root or Trash itself, and in Trash only
 * as what was put there (`intoTrash`: directly in Trash), never anywhere else in it. */
const placeable = (p: string, intoTrash: boolean) => p !== "/" && p !== TRASH && (intoTrash ? parentOf(p) === TRASH : !within(p, TRASH));
/** How many names `p` has ("/" none). */
const depth = (p: string) => {
  let n = 0;
  for (let i = 0; i < p.length; i++) if (p.charCodeAt(i) === 47) n++;
  return p === "/" ? 0 : n;
};
/** `base` cut so that `base + tail` is a name the workspace can hold (never through a surrogate pair). */
function fit(base: string, tail: string): string {
  if (base.length + tail.length <= MAX_NAME) return base + tail;
  let b = base.slice(0, Math.max(0, MAX_NAME - tail.length));
  if (/[\ud800-\udbff]$/.test(b)) b = b.slice(0, -1);
  return b + tail;
}

/** The identity a well-formed `op` targets, or why it has none. */
function identity(op: SyncOp): string | { skip: string } {
  if (op.kind === "file" || op.kind === "folder") return typeof op.fid === "string" && HEX16.test(op.fid) ? op.fid : { skip: `a ${op.kind}'s op carries its fid` };
  return typeof op.ref === "string" && (UUID.test(op.ref) || HEX12.test(op.ref)) ? op.ref : { skip: `a ${op.kind}'s op carries its ref` };
}

/** Why an op stops: everything it changed is put back. */
class Skip extends Error {}

/** `op` applied to `ix` (changed in place), whole or not at all. Deterministic: the same ops in the same order give the same index, on any device and on the server. */
export function reduce(ix: SyncIndex, op: SyncOp): Outcome {
  if (!op || typeof op !== "object" || !Number.isSafeInteger(op.seq) || !Number.isSafeInteger(op.dseq) || typeof op.device !== "string" || !HEX16.test(op.device) || !KINDS.has(op.kind)) return { changed: [], skipped: "not an op" };
  let p: string, to: string | undefined;
  try {
    p = normPath(op.path);
    to = op.to === undefined ? undefined : normPath(op.to);
  } catch (err) {
    return { changed: [], skipped: `a path: ${(err as Error).message}` };
  }
  const id = identity(op);
  if (typeof id !== "string") return { changed: [], skipped: id.skip };
  if (op.parent !== undefined && !(PLACING.has(op.op) && typeof op.parent === "string" && HEX16.test(op.parent))) return { changed: [], skipped: "parent is a folder's fid, on an op that puts something in one" };
  const r = new Reducer(ix, op, id);
  try {
    switch (op.op) {
      case "create":
      case "adopt":
      case "mkdir":
        r.create(p);
        break;
      case "write":
        r.write(p);
        break;
      case "rename":
        if (to === undefined) throw new Skip("a rename says where to");
        r.rename(to);
        break;
      case "remove":
        r.remove(to);
        break;
      case "restore":
        r.restore(to);
        break;
      case "forget":
        r.forget();
        break;
      default:
        // (dropVersions: the server's versions, not the index; anything else: nothing here)
        throw new Skip(`${JSON.stringify(String(op.op).slice(0, 40))} doesn't change the index`);
    }
  } catch (err) {
    r.undo();
    return { changed: [], skipped: err instanceof Skip ? err.message : `not applied: ${String(err).slice(0, 200)}` };
  }
  return { changed: r.changes() };
}

/** The index from empty, `ops` in order. */
export function reduceAll(ops: Iterable<SyncOp>, ix = new SyncIndex()): SyncIndex {
  for (const op of ops) reduce(ix, op);
  return ix;
}

class Reducer {
  private changed = new Set<string>();
  // (what puts each change back, in order: undone last first)
  private log: (() => void)[] = [];
  // (folders made for this op: a counter, so each has its own derived identity)
  private made = 0;
  constructor(private ix: SyncIndex, private op: SyncOp, private id: string) {}

  changes(): string[] {
    return [...this.changed];
  }

  undo() {
    for (let i = this.log.length - 1; i >= 0; i--) this.log[i]();
    this.log = [];
    this.changed.clear();
  }

  // ---- the maps, each change logged

  private rawPut(e: SyncEntry) {
    const k = keyOf(e.path), pk = keyOf(parentOf(e.path));
    this.ix.byId.set(e.id, e);
    this.ix.byKey.set(k, e.id);
    let s = this.ix.children.get(pk);
    if (!s) this.ix.children.set(pk, (s = new Set()));
    s.add(e.id);
  }

  private rawDel(e: SyncEntry) {
    const k = keyOf(e.path), pk = keyOf(parentOf(e.path));
    this.ix.byId.delete(e.id);
    if (this.ix.byKey.get(k) === e.id) this.ix.byKey.delete(k);
    const s = this.ix.children.get(pk);
    if (s) {
      s.delete(e.id);
      if (!s.size) this.ix.children.delete(pk);
    }
  }

  /** `e` added: its path one the workspace can hold, free, in a folder that is there; its identity not one the index has. */
  private put(e: SyncEntry) {
    if (!valid(e.path)) throw new Skip(`${e.path.slice(0, 80)}… is past the workspace's bounds`);
    if (!placeable(e.path, !!e.trashed)) throw new Skip(`nothing can be at ${e.path}`);
    if (this.ix.byId.has(e.id)) throw new Skip(`${e.id} is already there`);
    if (this.ix.byKey.has(keyOf(e.path))) throw new Skip(`${e.path} is taken`);
    const up = parentOf(e.path);
    if (up !== "/" && up !== TRASH && this.ix.at(up)?.kind !== "folder") throw new Skip(`no folder ${up}`);
    this.rawPut(e);
    const was = this.ix.gone.get(e.id);
    this.ix.gone.delete(e.id);
    this.log.push(() => {
      this.rawDel(e);
      if (was !== undefined) this.ix.gone.set(e.id, was);
    });
    this.changed.add(e.id);
  }

  /** `e` taken out (as it is now: put back as it was). */
  private unput(e: SyncEntry) {
    const was = copy(e);
    this.rawDel(e);
    this.log.push(() => this.rawPut(was));
    this.changed.add(e.id);
  }

  /** `e` with `changes`, as a new record (so the old one is what undo puts back). */
  private update(e: SyncEntry, changes: Partial<SyncEntry>): SyncEntry {
    this.unput(e);
    const n = { ...copy(e), ...changes, updated: this.op.t, seq: this.op.seq };
    this.put(n);
    return n;
  }

  // ---- identities and names

  /** The first of a deterministic series of identities from `parts` that this index doesn't have, hasn't forgotten, and the op doesn't name. */
  private fresh(...parts: (string | number)[]): string {
    for (let n = 0; n < 1000; n++) {
      const id = n === 0 ? derive(...parts) : derive(...parts, "again", n);
      if (id !== this.id && id !== this.op.parent && !this.ix.byId.has(id) && !this.ix.gone.has(id)) return id;
    }
    throw new Skip("no free identity");
  }

  private taken = (p: string, self?: string) => {
    const id = this.ix.byKey.get(keyOf(p));
    return id !== undefined && id !== self;
  };

  /** In `folder`, `base + tag + ext` or the first free `… (2)`, …, each name shortened to fit (`self` doesn't count as taking one). */
  private free(folder: string, base: string, ext: string, tag = "", self?: string): string {
    for (let i = 1; i <= 10000; i++) {
      const p = join(folder, fit(base, tag + (i === 1 ? "" : ` (${i})`) + ext));
      if (!this.taken(p, self)) return p;
    }
    throw new Skip(`no free name in ${folder}`);
  }

  // ---- folders

  /** The folder at path `f`, made (with its own folders) if it isn't there; a path a file or document has gives way to `name (2)`, …. Its path as it is. */
  private folderAt(f: string): string {
    if (f === "/" || f === TRASH) return f;
    if (within(f, TRASH)) throw new Skip(`can't make ${f}`);
    const up = this.folderAt(parentOf(f));
    const want = join(up, nameOf(f)), there = this.ix.at(want);
    if (there?.kind === "folder") return there.path;
    const [base, ext] = splitExt(nameOf(f));
    const p = this.free(up, base, ext);
    const fid = this.fresh("folder", this.op.device, this.op.dseq, ++this.made);
    this.put({ id: fid, path: p, kind: "folder", fid, created: this.op.t, updated: this.op.t, by: this.op.by, seq: this.op.seq });
    return p;
  }

  /** The folder the op puts `want` in: its `parent`, by identity (brought back if in Trash), else by `want`'s path. */
  private folderFor(want: string): string {
    const f = this.op.parent === undefined ? undefined : this.ix.byId.get(this.op.parent);
    if (f?.kind !== "folder") return this.folderAt(parentOf(want));
    const top = this.trashTop(f);
    if (top) this.bringBack(top);
    return this.ix.byId.get(f.id)!.path;
  }

  /** Where `want` lands: its folder had or made, then a free name there. */
  private place(want: string, self?: string, folder = this.folderFor(want)): string {
    const [base, ext] = splitExt(nameOf(want));
    const p = join(folder, nameOf(want));
    return valid(p) && !this.taken(p, self) ? p : this.free(folder, base, ext, "", self);
  }

  /** `e` (and what's in it) moved to `dest`, free, in a folder that is there; every path checked before anything is kept. */
  // (in two phases, as a subtree may be the whole workspace, LIMIT-7F4-1: every new path checked with
  // nothing changed; then the move, which can't fail, logged as one step that moves it all back, with no
  // copy of any entry)
  private relocate(e: SyncEntry, dest: string, trashed: SyncEntry["trashed"] | null) {
    const from = e.path, all = this.subtree(e);
    if (!valid(dest)) throw new Skip(`${dest.slice(0, 80)}… is past the workspace's bounds`);
    if (!placeable(dest, !!trashed)) throw new Skip(`nothing can be put at ${dest}`);
    if (this.taken(dest, e.id)) throw new Skip(`${dest} is taken`);
    const up = parentOf(dest);
    if (up !== "/" && up !== TRASH && this.ix.at(up)?.kind !== "folder") throw new Skip(`no folder ${up}`);
    if (keyOf(dest) !== keyOf(from) && within(keyOf(dest), keyOf(from))) throw new Skip(`${from} can't go into itself`);
    // (a descendant's names are its own, already valid: only its length and depth change)
    const dLen = dest.length - from.length, dDepth = depth(dest) - depth(from);
    for (const x of all) if (x.path.length + dLen > MAX_PATH || depth(x.path) + dDepth > MAX_DEPTH) throw new Skip(`${x.path.slice(0, 80)}… would be past the workspace's bounds`);
    const was = { trashed: e.trashed, updated: new Float64Array(all.length), seq: new Float64Array(all.length) };
    const move = (a: string, b: string) => {
      for (const x of all) this.rawDel(x);
      for (const x of all) {
        x.path = b + x.path.slice(a.length);
        this.rawPut(x);
      }
    };
    move(from, dest);
    all.forEach((x, i) => {
      was.updated[i] = x.updated;
      was.seq[i] = x.seq;
      x.updated = this.op.t;
      x.seq = this.op.seq;
      this.changed.add(x.id);
    });
    if (trashed === null) delete e.trashed;
    else if (trashed) e.trashed = trashed;
    this.log.push(() => {
      move(dest, from);
      all.forEach((x, i) => {
        x.updated = was.updated[i];
        x.seq = was.seq[i];
      });
      if (was.trashed) e.trashed = was.trashed;
      else delete e.trashed;
    });
  }

  /** `e` and everything in it, `e` first, parents before their children. */
  private subtree(e: SyncEntry): SyncEntry[] {
    const out = [e];
    for (let i = 0; i < out.length; i++) {
      if (out[i].kind !== "folder") continue;
      for (const c of this.ix.children.get(keyOf(out[i].path)) ?? []) out.push(this.ix.byId.get(c)!);
    }
    return out;
  }

  /** The entry in Trash that `e` is in (itself, or the folder put there), if any. */
  private trashTop(e: SyncEntry): SyncEntry | undefined {
    if (!within(e.path, TRASH)) return undefined;
    const top = this.ix.at(join(TRASH, e.path.slice(TRASH.length + 1).split("/")[0]));
    return top?.trashed ? top : undefined;
  }

  /** `top`, in Trash, back where it was (its folder found as a restore's: by `parent` only for the op's own target), or the first free name there. */
  private bringBack(top: SyncEntry, to?: string) {
    const want = to && !within(to, TRASH) ? to : top.trashed!.from;
    const folder = top.id === this.id ? this.folderFor(want) : this.folderAt(parentOf(want));
    // (finding that folder may have moved `top`: a `parent` inside it, brought back with it)
    const now = this.ix.byId.get(top.id)!;
    if (!now.trashed) return;
    if (now.kind === "folder" && within(keyOf(folder), keyOf(now.path))) throw new Skip(`${now.path} can't go into itself`);
    this.relocate(now, this.place(want, top.id, folder), null);
  }

  // ---- the ops

  create(p: string) {
    const op = this.op;
    if (p === "/" || within(p, TRASH)) throw new Skip(`can't make ${p}`);
    if ((op.op === "mkdir") !== (op.kind === "folder")) throw new Skip(`${op.op} of a ${op.kind}`);
    if (op.kind !== "file" && op.kind !== "folder" && kindOf(p) !== op.kind) throw new Skip(`a ${op.kind}'s name says so`);
    // (the same identity made again, a resend or a copy of the log: once is enough)
    if (this.ix.byId.has(this.id)) throw new Skip(`${this.id} is already there`);
    if (op.kind === "file" && !(typeof op.sha256 === "string" && HEX64.test(op.sha256))) throw new Skip("a data file's create carries its sha256");
    this.put(this.entry(this.id, this.place(p), op.kind, op.sha256, op.size));
  }

  private entry(id: string, path: string, kind: Kind, sha256?: string, size?: number): SyncEntry {
    const op = this.op, e: SyncEntry = { id, path, kind, created: op.t, updated: op.t, by: op.by, seq: op.seq };
    if (kind === "file" || kind === "folder") e.fid = id;
    else e.ref = id;
    if (kind === "file") {
      e.sha256 = sha256;
      e.size = Number.isSafeInteger(size) && size! >= 0 ? size : 0;
    }
    return e;
  }

  write(p: string) {
    const op = this.op;
    if (op.kind !== "file") throw new Skip("only a data file is written");
    if (!(typeof op.sha256 === "string" && HEX64.test(op.sha256))) throw new Skip("a write carries its sha256");
    const e = this.ix.byId.get(this.id);
    if (!e) {
      const last = this.ix.gone.get(this.id);
      // (never seen here: a create, with create's rules; forgotten for good: a copy where it last was)
      if (last === undefined) return this.create(p);
      return this.conflictCopy(within(last, TRASH) ? join("/", nameOf(last)) : last);
    }
    if (e.kind !== "file") throw new Skip(`${e.path} isn't a data file`);
    // (the edit wins: out of Trash first, with the folder it is in)
    const top = this.trashTop(e);
    if (top) this.bringBack(top);
    const cur = this.ix.byId.get(this.id)!;
    if (op.sha256 === cur.sha256) return;
    if (op.base !== cur.sha256) return this.conflictCopy(cur.path);
    this.update(cur, { sha256: op.sha256, size: Number.isSafeInteger(op.size) && op.size! >= 0 ? op.size : 0, by: op.by });
  }

  /** The write's bytes as a copy beside `at`: `name (conflict, <device's first 8>).ext`, its identity derived from the op. */
  private conflictCopy(at: string) {
    const op = this.op, [base, ext] = splitExt(nameOf(at));
    const folder = this.folderAt(parentOf(at));
    const cid = this.fresh(this.id, op.device, op.dseq);
    this.put(this.entry(cid, this.free(folder, base, ext, ` (conflict, ${op.device.slice(0, 8)})`), "file", op.sha256, op.size));
  }

  rename(to: string) {
    const e = this.ix.byId.get(this.id);
    if (!e) throw new Skip(`${this.id} isn't there`);
    if (to === "/" || within(to, TRASH)) throw new Skip("a rename doesn't go into Trash: remove does");
    if (e.kind !== "file" && e.kind !== "folder" && kindOf(to) !== e.kind) throw new Skip(`a ${e.kind} keeps its kind's name`);
    if (to === e.path && this.op.parent === undefined) return;
    const folder = this.folderFor(to);
    const self = this.ix.byId.get(this.id)!;
    if (self.kind === "folder" && within(keyOf(folder), keyOf(self.path))) throw new Skip(`${self.path} can't go into itself`);
    const dest = this.place(to, this.id, folder);
    if (dest === self.path) return;
    // (a rename of what is in Trash takes it out, to where the rename says: the later op wins)
    this.relocate(self, dest, null);
  }

  remove(to?: string) {
    const e = this.ix.byId.get(this.id);
    if (!e) throw new Skip(`${this.id} isn't there`);
    if (within(e.path, TRASH)) throw new Skip(`${e.path} is in Trash already`);
    const [base, ext] = splitExt(nameOf(to && parentOf(to) === TRASH ? to : e.path));
    this.relocate(e, this.free(TRASH, base, ext, "", this.id), { from: e.path, at: this.op.t });
  }

  restore(to?: string) {
    const e = this.ix.byId.get(this.id);
    if (!e) throw new Skip(`${this.id} isn't there`);
    if (!e.trashed) throw new Skip(within(e.path, TRASH) ? "restore the folder it is in" : `${e.path} isn't in Trash`);
    this.bringBack(e, to);
  }

  forget() {
    const e = this.ix.byId.get(this.id);
    if (!e) throw new Skip(`${this.id} isn't there`);
    // (as a move: one step to put it all back, no copies; nothing here can fail)
    const all = this.subtree(e);
    for (const x of all) {
      this.rawDel(x);
      this.ix.gone.set(x.id, x.path);
      this.changed.add(x.id);
    }
    this.log.push(() => {
      for (const x of all) {
        this.ix.gone.delete(x.id);
        this.rawPut(x);
      }
    });
  }
}
