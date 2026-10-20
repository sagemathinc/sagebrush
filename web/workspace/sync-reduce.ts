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
// - Order is `seq` only; `t` is shown, never ordered by.
// - A new entry, or one moved, at a path another entry has (or one whose
//   names look the same: NFC, as the workspace's lookalike refusal) takes
//   the first free `name (2)`, `name (3)`, … there.
// - A write: `base` the current `sha256`, applied; the same `sha256`,
//   nothing; another `base` (a concurrent write), a conflict copy beside it,
//   `name (conflict, <device's first 8>).ext`, with a derived identity.  A
//   write to an identity in Trash brings it (with the folder it is in) back
//   first: the edit wins.  A write to an identity forgotten for good is a
//   conflict copy at its last path.
// - A remove puts its identity in Trash; a restore takes it out; a rename
//   of an identity in Trash takes it out to where the rename says (the
//   later op wins).
// - A folder an op needs that isn't there (removed or moved on another
//   device meanwhile) is made, with an identity derived from the op.
// - An op that can't apply (its form, an identity it doesn't carry, a move
//   into itself) changes nothing, and says why: the log is never redefined.
import { TRASH, freePath, join, kindOf, nameOf, normPath, parentOf, splitExt, within, type Kind } from "./paths";
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

/** The index: entries by identity, by path (its NFC form) and by folder, and the last path of each identity forgotten. */
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
    for (const [id, e] of this.byId) c.byId.set(id, { ...e, ...(e.trashed ? { trashed: { ...e.trashed } } : {}) });
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
const HEX16 = /^[0-9a-f]{16}$/, HEX12 = /^[0-9a-f]{12}$/, HEX64 = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KINDS = new Set(["notebook", "board", "file", "folder"]);
const enc = new TextEncoder();
const derive = (...parts: (string | number)[]) => sha256Hex(enc.encode(parts.join("\u0000"))).slice(0, 16);

/** The identity a well-formed `op` targets, or why it has none. */
function identity(op: SyncOp): string | { skip: string } {
  if (op.kind === "file" || op.kind === "folder") return typeof op.fid === "string" && HEX16.test(op.fid) ? op.fid : { skip: `a ${op.kind}'s op carries its fid` };
  return typeof op.ref === "string" && (UUID.test(op.ref) || HEX12.test(op.ref)) ? op.ref : { skip: `a ${op.kind}'s op carries its ref` };
}

/** `op` applied to `ix` (changed in place). Deterministic: the same ops in the same order give the same index, on any device and on the server. */
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
  const r = new Reducer(ix, op);
  switch (op.op) {
    case "create":
    case "adopt":
    case "mkdir":
      return r.create(id, p);
    case "write":
      return r.write(id, p);
    case "rename":
      return to === undefined ? { changed: [], skipped: "a rename says where to" } : r.rename(id, to);
    case "remove":
      return r.remove(id, to);
    case "restore":
      return r.restore(id, to);
    case "forget":
      return r.forget(id);
    default:
      // (dropVersions: the server's versions, not the index; anything else: nothing here)
      return { changed: [], skipped: `${JSON.stringify(String(op.op).slice(0, 40))} doesn't change the index` };
  }
}

/** The index from empty, `ops` in order. */
export function reduceAll(ops: Iterable<SyncOp>, ix = new SyncIndex()): SyncIndex {
  for (const op of ops) reduce(ix, op);
  return ix;
}

class Reducer {
  private changed = new Set<string>();
  // (folders made for this op: a counter, so each has its own derived identity)
  private made = 0;
  constructor(private ix: SyncIndex, private op: SyncOp) {}

  private done(skipped?: string): Outcome {
    return skipped === undefined ? { changed: [...this.changed] } : { changed: [...this.changed], skipped };
  }

  private taken = (p: string, self?: string) => {
    const id = this.ix.byKey.get(keyOf(p));
    return id !== undefined && id !== self;
  };

  /** `want`, or the first free `name (2)`, … in its folder (`self` doesn't count as taking it). */
  private free(want: string, self?: string): string | undefined {
    if (!this.taken(want, self)) return want;
    const [base, ext] = splitExt(nameOf(want));
    return freePath(parentOf(want), base, ext, (x) => this.taken(x, self));
  }

  private put(e: SyncEntry) {
    const k = keyOf(e.path), pk = keyOf(parentOf(e.path));
    this.ix.byId.set(e.id, e);
    this.ix.byKey.set(k, e.id);
    let s = this.ix.children.get(pk);
    if (!s) this.ix.children.set(pk, (s = new Set()));
    s.add(e.id);
    this.ix.gone.delete(e.id);
    this.changed.add(e.id);
  }

  private unput(e: SyncEntry) {
    const k = keyOf(e.path), pk = keyOf(parentOf(e.path));
    this.ix.byId.delete(e.id);
    if (this.ix.byKey.get(k) === e.id) this.ix.byKey.delete(k);
    const s = this.ix.children.get(pk);
    if (s) {
      s.delete(e.id);
      if (!s.size) this.ix.children.delete(pk);
    }
    this.changed.add(e.id);
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

  /** The folder `f`, made (with its own folders) if it isn't there; a path a file or document has gives way to `name (2)`, ….  Its path as it is, or undefined if it can't be had. */
  private folder(f: string): string | undefined {
    if (f === "/" || f === TRASH) return f;
    if (within(f, TRASH)) return undefined;
    const up = this.folder(parentOf(f));
    if (up === undefined) return undefined;
    const want = join(up, nameOf(f)), there = this.ix.at(want);
    if (there?.kind === "folder") return there.path;
    const p = this.free(want);
    if (p === undefined) return undefined;
    const fid = derive("folder", this.op.device, this.op.dseq, ++this.made);
    this.put({ id: fid, path: p, kind: "folder", fid, created: this.op.t, updated: this.op.t, by: this.op.by, seq: this.op.seq });
    return p;
  }

  /** Where `want` lands: its folder had or made, then free. */
  private place(want: string, self?: string): string | undefined {
    const f = this.folder(parentOf(want));
    return f === undefined ? undefined : this.free(join(f, nameOf(want)), self);
  }

  /** `e` (and what's in it) moved to `dest`, a free path in a folder that is there. */
  private relocate(e: SyncEntry, dest: string, trashed: SyncEntry["trashed"] | null) {
    const all = this.subtree(e), from = e.path;
    for (const x of all) this.unput(x);
    for (const x of all) {
      x.path = dest + x.path.slice(from.length);
      x.updated = this.op.t;
      x.seq = this.op.seq;
    }
    if (trashed === null) delete e.trashed;
    else if (trashed) e.trashed = trashed;
    for (const x of all) this.put(x);
  }

  /** The entry in Trash that `e` is in (itself, or the folder put there), if any. */
  private trashTop(e: SyncEntry): SyncEntry | undefined {
    if (!within(e.path, TRASH)) return undefined;
    const top = this.ix.at(join(TRASH, e.path.slice(TRASH.length + 1).split("/")[0]));
    return top?.trashed ? top : undefined;
  }

  /** `top`, in Trash, back where it was (or `to`), or the first free name there. */
  private bringBack(top: SyncEntry, to?: string): boolean {
    const want = to && !within(to, TRASH) ? to : top.trashed!.from;
    const dest = this.place(want, top.id);
    if (dest === undefined) return false;
    this.relocate(top, dest, null);
    return true;
  }

  create(id: string, p: string): Outcome {
    const op = this.op;
    if (p === "/" || within(p, TRASH)) return this.done(`can't make ${p}`);
    if ((op.op === "mkdir") !== (op.kind === "folder")) return this.done(`${op.op} of a ${op.kind}`);
    if (op.kind !== "file" && op.kind !== "folder" && kindOf(p) !== op.kind) return this.done(`a ${op.kind}'s name says so`);
    // (the same identity made again, a resend or a copy of the log: once is enough)
    if (this.ix.byId.has(id)) return this.done(`${id} is already there`);
    if (op.kind === "file" && !(typeof op.sha256 === "string" && HEX64.test(op.sha256))) return this.done("a data file's create carries its sha256");
    const dest = this.place(p);
    if (dest === undefined) return this.done(`no free name for ${p}`);
    this.put(this.entry(id, dest, op.kind, op.sha256, op.size));
    return this.done();
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

  write(id: string, p: string): Outcome {
    const op = this.op;
    if (op.kind !== "file") return this.done("only a data file is written");
    if (!(typeof op.sha256 === "string" && HEX64.test(op.sha256))) return this.done("a write carries its sha256");
    const e = this.ix.byId.get(id);
    if (!e) {
      const last = this.ix.gone.get(id);
      // (never seen here: as a create, at its path; forgotten for good: a copy where it last was)
      if (last === undefined) {
        const dest = this.place(within(p, TRASH) ? join("/", nameOf(p)) : p);
        if (dest === undefined) return this.done(`no free name for ${p}`);
        this.put(this.entry(id, dest, "file", op.sha256, op.size));
        return this.done();
      }
      return this.conflictCopy(id, within(last, TRASH) ? join("/", nameOf(last)) : last);
    }
    if (e.kind !== "file") return this.done(`${e.path} isn't a data file`);
    // (the edit wins: out of Trash first, with the folder it is in)
    const top = this.trashTop(e);
    if (top && !this.bringBack(top)) return this.done(`no free name to bring ${top.path} back`);
    if (op.sha256 === e.sha256) return this.done();
    if (op.base !== e.sha256) return this.conflictCopy(id, e.path);
    e.sha256 = op.sha256;
    e.size = Number.isSafeInteger(op.size) && op.size! >= 0 ? op.size : 0;
    e.updated = op.t;
    e.by = op.by;
    e.seq = op.seq;
    this.changed.add(id);
    return this.done();
  }

  /** The write's bytes as a copy beside `at`: `name (conflict, <device's first 8>).ext`, its identity derived from the op. */
  private conflictCopy(id: string, at: string): Outcome {
    const op = this.op, [base, ext] = splitExt(nameOf(at));
    const cid = derive(id, op.device, op.dseq);
    if (this.ix.byId.has(cid)) return this.done(`${cid} is already there`);
    const dest = this.place(join(parentOf(at), `${base} (conflict, ${op.device.slice(0, 8)})${ext}`));
    if (dest === undefined) return this.done(`no free name for a copy of ${at}`);
    this.put(this.entry(cid, dest, "file", op.sha256, op.size));
    return this.done();
  }

  rename(id: string, to: string): Outcome {
    const e = this.ix.byId.get(id);
    if (!e) return this.done(`${id} isn't there`);
    if (to === "/" || within(to, TRASH)) return this.done("a rename doesn't go into Trash: remove does");
    if (to === e.path) return this.done();
    if (e.kind === "folder" && keyOf(to) !== keyOf(e.path) && within(keyOf(to), keyOf(e.path))) return this.done(`${e.path} can't go into itself`);
    if (e.kind !== "file" && e.kind !== "folder" && kindOf(to) !== e.kind) return this.done(`a ${e.kind} keeps its kind's name`);
    const dest = this.place(to, id);
    if (dest === undefined) return this.done(`no free name for ${to}`);
    if (dest === e.path) return this.done();
    // (a rename of what is in Trash takes it out, to where the rename says: the later op wins)
    this.relocate(e, dest, null);
    return this.done();
  }

  remove(id: string, to?: string): Outcome {
    const e = this.ix.byId.get(id);
    if (!e) return this.done(`${id} isn't there`);
    if (within(e.path, TRASH)) return this.done(`${e.path} is in Trash already`);
    const want = to && parentOf(to) === TRASH ? to : join(TRASH, nameOf(e.path));
    const dest = this.free(want, id);
    if (dest === undefined) return this.done("Trash is full");
    this.relocate(e, dest, { from: e.path, at: this.op.t });
    return this.done();
  }

  restore(id: string, to?: string): Outcome {
    const e = this.ix.byId.get(id);
    if (!e) return this.done(`${id} isn't there`);
    if (!e.trashed) return this.done(within(e.path, TRASH) ? "restore the folder it is in" : `${e.path} isn't in Trash`);
    return this.bringBack(e, to) ? this.done() : this.done(`no free name to restore ${e.path}`);
  }

  forget(id: string): Outcome {
    const e = this.ix.byId.get(id);
    if (!e) return this.done(`${id} isn't there`);
    for (const x of this.subtree(e)) {
      this.unput(x);
      this.ix.gone.set(x.id, x.path);
    }
    return this.done();
  }
}
