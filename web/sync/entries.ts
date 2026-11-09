// The server's index, `entries` (design/sync-server.md §3; design/agent-endpoint.md §4; fs-sync step 1a2): the shared
// reducer (web/workspace/sync-reduce.ts), unchanged, run on the account object's SQLite.
//
// SqlIndex has exactly the surface the reducer uses (byId, byKey and gone: get, set, has, delete; children: get, set,
// delete, and the Set it gets: add, delete, has, size, iteration; at()), each map a write-back cache over its own
// table for the length of one op: a row is read once, the reducer works on the cached objects (and mutates some in
// place, and undoes through the same maps), and only what differs from what was read is written, after the op.
//
// Every row read or written is charged to a Budget (daybreak2 / daybreak3: 100,000 per alarm step, or per live op):
// the charge that would pass it throws BudgetStop *before* the read or write, which the caller turns into a rollback
// of its transaction; the reducer's own catch can't hide it, since the budget remembers that it stopped.

import { SyncIndex, reduce, type SyncEntry, type SyncOp, type Outcome } from "../workspace/sync-reduce.ts";
import { MAX_DEPTH, MAX_PATH, parentOf } from "../workspace/paths.ts";

type Sql = SqlStorage;
type Row = Record<string, ArrayBuffer | string | number | null>;

// The index's host bounds: interim (#904 r3 §1.1), registered in the limits census one by one, each its own line (so a
// new bound or a changed one is a census site to register), until slice 2 takes them from discovered capabilities.
// They are never membership values. (LIMITS and PERF on #913: 25,000 visits a step until DEV numbers show 2x headroom.)
/** rows read or written by one alarm step, or by one live batch, whatever it holds */
export const IX_VISITS_MAX = 25_000;
/** ops, and their encoded bytes, applied by one alarm step (the index page's bounds) */
export const IX_OPS_MAX = 1000;
export const IX_BYTES_MAX = 1 << 20;
/** live entries, tombstones, and entries directly in one folder (LIMITS ruling (2)) */
export const IX_ENTRIES_MAX = 100_000;
export const IX_GONE_MAX = 100_000;
export const IX_FOLDER_MAX = 10_000;
/** a page of `list`, and the rows one call may examine (astra's read condition) */
export const IX_PAGE_MAX = 1000;
export const IX_EXAMINED_MAX = 20_000;
/** rows a job reads in one page (a subtree op in steps, below) */
export const IX_JOB_PAGE_MAX = 500;
/** a list's continuations: kept per grant (the newest), and for how long (astra's S1 on #913: a cursor is an id the
 * server keeps, never a path) */
export const IX_CURSORS_MAX = 32;
export const IX_CURSOR_MS_MAX = 15 * 60_000;
/** expired continuations deleted by one alarm step (or when a cursor is made): a page, the alarm armed again while any
 * is left (ENGINE and LIMITS L5 on #913: kept no longer than they are good for, and none past their grant) */
export const IX_CURSOR_SWEEP_MAX = 100;
/** rows a rebuild's reset deletes in one step (ENGINE E2 on #913: never a whole index in one transaction) */
export const IX_RESET_PAGE_MAX = 10_000;
export const IX = {
  visits: IX_VISITS_MAX,
  ops: IX_OPS_MAX,
  bytes: IX_BYTES_MAX,
  entries: IX_ENTRIES_MAX,
  gone: IX_GONE_MAX,
  perFolder: IX_FOLDER_MAX,
  page: IX_PAGE_MAX,
  examined: IX_EXAMINED_MAX,
  jobPage: IX_JOB_PAGE_MAX,
  cursors: IX_CURSORS_MAX,
  cursorMs: IX_CURSOR_MS_MAX,
  cursorSweep: IX_CURSOR_SWEEP_MAX,
  resetPage: IX_RESET_PAGE_MAX,
};

export const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS ix_entries (id TEXT PRIMARY KEY, path TEXT NOT NULL, data TEXT NOT NULL)",
  "CREATE INDEX IF NOT EXISTS ix_entries_path ON ix_entries (path)",
  "CREATE TABLE IF NOT EXISTS ix_keys (key TEXT PRIMARY KEY, id TEXT NOT NULL)",
  // (ord: the order the id joined its folder, so a folder's children come back in the in-memory Set's order, which the
  // reducer walks: a subtree's order is part of its outcome)
  "CREATE TABLE IF NOT EXISTS ix_children (pk TEXT NOT NULL, id TEXT NOT NULL, ord INTEGER NOT NULL, PRIMARY KEY (pk, id))",
  "CREATE INDEX IF NOT EXISTS ix_children_ord ON ix_children (pk, ord)",
  "CREATE TABLE IF NOT EXISTS ix_meta (k TEXT PRIMARY KEY, v INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS ix_gone (id TEXT PRIMARY KEY, path TEXT NOT NULL)",
  // (a subtree op in progress, below: the descendants still to move or forget, each with its region; the job's state)
  "CREATE TABLE IF NOT EXISTS ix_stage (id TEXT PRIMARY KEY, r INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS ix_job (one INTEGER PRIMARY KEY CHECK (one = 1), v TEXT NOT NULL)",
  // (a list's continuation: where the next page starts, for that grant's listing of that folder only)
  "CREATE TABLE IF NOT EXISTS ix_cursors (id TEXT PRIMARY KEY, grant_id TEXT NOT NULL, folder TEXT NOT NULL, recursive INTEGER NOT NULL, after TEXT NOT NULL, t INTEGER NOT NULL)",
  "CREATE INDEX IF NOT EXISTS ix_cursors_grant ON ix_cursors (grant_id)",
  "CREATE INDEX IF NOT EXISTS ix_cursors_t ON ix_cursors (t)",
];
export const IX_TABLES = ["ix_entries", "ix_keys", "ix_children", "ix_gone", "ix_meta", "ix_stage", "ix_job", "ix_cursors"];

/** A budget stop: the work it would take is past the bound. Never an op the reducer refused. */
export class BudgetStop extends Error {
  constructor() {
    super("index budget");
  }
}

export class Budget {
  used = 0;
  stopped = false;
  constructor(public limit: number) {}
  charge(n = 1) {
    if (this.stopped || this.used + n > this.limit) {
      this.stopped = true;
      throw new BudgetStop();
    }
    this.used += n;
  }
}

/** One map of the reducer's, cached over a table for one op. `undefined` in `cache`: absent (or deleted). */
class CachedMap<V> extends Map<string, V> {
  private cache = new Map<string, V | undefined>();
  private read = new Map<string, string | null>();
  constructor(
    private sql: Sql,
    private budget: Budget,
    private load: (k: string) => V | undefined,
    private enc: (v: V) => string,
    private write: (k: string, v: V | undefined) => void,
    private onSet?: (k: string, v: V, was: string | undefined) => void,
  ) {
    super();
  }
  /** (deferred mode) the path each entry had when last seen, so a move shows */
  private seen = new Map<string, string>();
  /** What was read, decoded, by key. */
  reads(): [string, V | undefined][] {
    return [...this.read].map(([k, v]) => [k, v === null ? undefined : (JSON.parse(v) as V)]);
  }
  final(k: string): V | undefined {
    return this.cache.get(k);
  }
  /** Deferred mode, after a folder moved: each cached value `f` maps to something else is replaced (and taken as read
   * so, nothing to write); `null`: forgotten, to be read again through the regions. A pending write can't move so. */
  remap(f: (k: string, v: V | undefined) => V | undefined | null | false) {
    for (const [k, v] of [...this.cache]) {
      const n = f(k, v);
      if (n === false) continue;
      const was = this.read.get(k), now = v === undefined ? null : this.enc(v);
      if (was !== now) throw new Entangled("a change under a folder before it moved");
      if (n === null) {
        this.cache.delete(k);
        this.read.delete(k);
        this.seen.delete(k);
        continue;
      }
      this.cache.set(k, n);
      this.read.set(k, n === undefined ? null : this.enc(n));
      if (n !== undefined) this.seen.set(k, (n as unknown as SyncEntry).path);
    }
  }
  private fetch(k: string): V | undefined {
    if (this.cache.has(k)) return this.cache.get(k);
    this.budget.charge();
    const v = this.load(k);
    this.cache.set(k, v);
    this.read.set(k, v === undefined ? null : this.enc(v));
    if (this.onSet && v !== undefined) this.seen.set(k, (v as unknown as SyncEntry).path);
    return v;
  }
  override get(k: string): V | undefined {
    return this.fetch(k);
  }
  override has(k: string): boolean {
    return this.fetch(k) !== undefined;
  }
  override set(k: string, v: V): this {
    this.fetch(k);
    this.cache.set(k, v);
    if (this.onSet) {
      const p = (v as unknown as SyncEntry).path;
      this.onSet(k, v, this.seen.get(k));
      this.seen.set(k, p);
    }
    return this;
  }
  override delete(k: string): boolean {
    const had = this.fetch(k) !== undefined;
    this.cache.set(k, undefined);
    return had;
  }
  /** The rows to write: those that differ from what was read. */
  diff(): [string, V | undefined, number][] {
    const out: [string, V | undefined, number][] = [];
    for (const [k, v] of this.cache) {
      const now = v === undefined ? null : this.enc(v), was = this.read.get(k) ?? null;
      if (now !== was) out.push([k, v, (now === null ? 0 : 1) - (was === null ? 0 : 1)]);
    }
    return out;
  }
  /** `rows` (from diff(), already charged) written; the change in the number of rows. */
  apply(rows: [string, V | undefined, number][]): number {
    let delta = 0;
    for (const [k, v, d] of rows) {
      this.write(k, v);
      delta += d;
    }
    return delta;
  }
}

/** A loaded folder's children, in their order; an id deleted and added again goes to the end, as in any Set, and is
 * remembered, so its row is moved to the end too. */
class LoadedSet extends Set<string> {
  readonly moved = new Set<string>();
  private gone = new Set<string>();
  // (the ids read are added after the fields exist: Set's own constructor would call the add below before them)
  constructor(ids: Iterable<string>) {
    super();
    for (const id of ids) super.add(id);
  }
  override delete(id: string): boolean {
    const had = super.delete(id);
    if (had) this.gone.add(id);
    return had;
  }
  override add(id: string): this {
    if (!this.has(id) && this.gone.has(id)) this.moved.add(id);
    return super.add(id);
  }
}

/** The children map: each folder's ids (ix_children rows), loaded whole on first use and kept as they were read; the
 * reducer mutates the live Set in place, and the difference is written after the op. */
class ChildrenMap extends Map<string, Set<string>> {
  private cache = new Map<string, Set<string> | undefined>();
  private read = new Map<string, ReadonlySet<string>>();
  constructor(private sql: Sql, private budget: Budget) {
    super();
  }
  private fetch(pk: string): Set<string> | undefined {
    if (this.cache.has(pk)) return this.cache.get(pk);
    this.budget.charge();
    const ids: string[] = [];
    for (const r of this.sql.exec("SELECT id FROM ix_children WHERE pk = ? ORDER BY ord", pk)) {
      this.budget.charge();
      ids.push(String((r as Row).id));
    }
    this.read.set(pk, new Set(ids));
    const s = ids.length ? new LoadedSet(ids) : undefined;
    this.cache.set(pk, s);
    return s;
  }
  override get(pk: string): Set<string> | undefined {
    return this.fetch(pk);
  }
  override has(pk: string): boolean {
    return this.fetch(pk) !== undefined;
  }
  override set(pk: string, s: Set<string>): this {
    this.fetch(pk);
    this.cache.set(pk, s);
    return this;
  }
  override delete(pk: string): boolean {
    const had = this.fetch(pk) !== undefined;
    this.cache.set(pk, undefined);
    return had;
  }
  /** The adds and deletes to write, and the most children any touched folder has now. */
  diff(): { adds: [string, string][]; dels: [string, string][]; largest: number } {
    const adds: [string, string][] = [], dels: [string, string][] = [];
    let largest = 0;
    for (const [pk, s] of this.cache) {
      const before = this.read.get(pk)!, after = s ?? new Set<string>();
      // (in the Set's order: new ids, and ids that left and came back, each joins at the end)
      const moved = after instanceof LoadedSet ? after.moved : new Set<string>();
      for (const id of before) if (!after.has(id) || moved.has(id)) dels.push([pk, id]);
      for (const id of after) if (!before.has(id) || moved.has(id)) adds.push([pk, id]);
      largest = Math.max(largest, after.size);
    }
    return { adds, dels, largest };
  }
  apply(d: { adds: [string, string][]; dels: [string, string][] }) {
    ChildrenMap.write(this.sql, d);
  }
  static write(sql: Sql, d: { adds: [string, string][]; dels: [string, string][] }) {
    for (const [pk, id] of d.dels) sql.exec("DELETE FROM ix_children WHERE pk = ? AND id = ?", pk, id);
    if (!d.adds.length) return;
    let ord = Number((sql.exec("SELECT v FROM ix_meta WHERE k = 'ord'").toArray()[0] as Row | undefined)?.v ?? 0);
    for (const [pk, id] of d.adds) sql.exec("INSERT INTO ix_children (pk, id, ord) VALUES (?, ?, ?)", pk, id, ++ord);
    sql.exec("INSERT INTO ix_meta (k, v) VALUES ('ord', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", ord);
  }
}

const encEntry = (e: SyncEntry) => JSON.stringify(e);

// ---- subtree ops in steps (#904 D1, daybreak3's ENGINE ruling (a)): the reducer, unchanged, run so that a folder it
// moves or forgets is touched alone, its descendants left where they are in storage; their part is staged after, in
// bounded steps, while the index answers 503 index_building. The reducer sees the op's result as it would whole: what
// is under a folder that moved is read (and written) through that move, a "region": storage keeps the old paths until
// the stage takes each descendant to its new one.

/** A folder the op moved (`cur`: where it is now) or forgot, and where its descendants are in storage (`from`). */
export type Region = { top: string; from: string; cur: string | null };
const strictly = (p: string, f: string) => p.length > f.length && p.startsWith(f) && p.charCodeAt(f.length) === 47;
const keyOf = (p: string) => p.normalize("NFC");

/** Something the deferred op would need that the regions can't give (a write into where a moved folder was): the
 * reducer's flows never do it; if one did, the index fails rather than guess. */
export class Entangled extends Error {}

export class Regions {
  list: Region[] = [];
  /** each move as it happened: the region, and where it went (the reducer checks each against the subtree's bounds) */
  events: [number, string][] = [];
  constructor(readonly t: number, readonly seq: number) {}
  /** each region's top as the op first saw it (where an undo puts it back) */
  private first = new Map<string, string>();
  moved(top: string, from: string, to: string, was: string) {
    let i = this.list.findIndex((r) => r.top === top);
    if (i < 0) {
      this.first.set(top, was);
      i = this.list.push({ top, from, cur: to }) - 1;
    } else this.list[i].cur = to;
    // (moved back where it began, as the reducer's undo does on a Skip: no region, and none of its moves)
    if (to === this.first.get(top)) {
      this.list.splice(i, 1);
      this.events = this.events.filter(([j]) => j !== i).map(([j, d]) => [j > i ? j - 1 : j, d]);
      this.first.delete(top);
      return;
    }
    this.events.push([i, to]);
  }
  forgot(top: string, from: string) {
    this.list.push({ top, from, cur: null });
  }
  /** The longest region whose `field` holds `p` (strictly, or `p` itself too), compared as keys when `key`. */
  private best(p: string, field: "from" | "cur", inclusive: boolean, key: boolean): Region | undefined {
    let out: Region | undefined, n = -1;
    for (const r of this.list) {
      const f = r[field];
      if (f === null) continue;
      const g = key ? keyOf(f) : f;
      if ((strictly(p, g) || (inclusive && p === g)) && g.length > n) (out = r), (n = g.length);
    }
    return out;
  }
  /** An entry as storage has it, as the reducer sees it now: moved with its region (and stamped with the op), or gone. */
  readEntry(e: SyncEntry): SyncEntry | undefined {
    const r = this.best(e.path, "from", false, false);
    if (!r) return e;
    if (r.cur === null) return undefined;
    return { ...e, path: r.cur + e.path.slice(r.from.length), updated: this.t, seq: this.seq };
  }
  /** A path the reducer writes, as storage keeps it while the op is staged. */
  pathToStore(p: string): string {
    const c = this.best(p, "cur", false, false);
    if (c) return c.from + p.slice(c.cur!.length);
    if (this.best(p, "from", false, false)) throw new Entangled(`a write where a moved folder was: ${p.slice(0, 80)}`);
    return p;
  }
  /** A key the reducer reads or writes, as storage has it; null (a read) where a moved folder was. `inclusive`: a
   * folder's own key, for its children, which storage keeps under the old one. */
  keyToStore(k: string, write: boolean, inclusive: boolean): string | null {
    const c = this.best(k, "cur", inclusive, true);
    if (c) return keyOf(c.from) + k.slice(keyOf(c.cur!).length);
    if (this.best(k, "from", inclusive, true)) {
      if (write) throw new Entangled(`a write where a moved folder was: ${k.slice(0, 80)}`);
      return null;
    }
    return k;
  }
}

/** One folder's children in deferred mode: never loaded (and never listed: the reducer's walk of a subtree stops at
 * its top), only what the op adds and deletes, and how many there are. */
class DeltaSet {
  adds = new Set<string>();
  dels = new Set<string>();
  private there = new Map<string, boolean>();
  private n: number | null = null;
  constructor(private sql: Sql, private budget: Budget, readonly pk: string | null) {}
  private has0(id: string): boolean {
    if (this.pk === null) return false;
    let v = this.there.get(id);
    if (v === undefined) {
      this.budget.charge();
      v = this.sql.exec("SELECT 1 AS x FROM ix_children WHERE pk = ? AND id = ?", this.pk, id).toArray().length > 0;
      this.there.set(id, v);
    }
    return v;
  }
  has(id: string): boolean {
    return this.adds.has(id) || (!this.dels.has(id) && this.has0(id));
  }
  add(id: string): this {
    if (this.pk === null) throw new Entangled("a folder where a moved one was");
    if (this.dels.delete(id)) return this;
    if (!this.adds.has(id) && !this.has0(id)) this.adds.add(id);
    return this;
  }
  delete(id: string): boolean {
    if (this.adds.delete(id)) return true;
    if (this.dels.has(id) || !this.has0(id)) return false;
    this.dels.add(id);
    return true;
  }
  get size(): number {
    if (this.n === null) {
      this.budget.charge();
      this.n = this.pk === null ? 0 : Number((this.sql.exec("SELECT COUNT(*) AS n FROM ix_children WHERE pk = ?", this.pk).toArray()[0] as Row).n);
    }
    return this.n + this.adds.size - this.dels.size;
  }
  *[Symbol.iterator](): IterableIterator<string> {}
}

class DeltaChildren extends Map<string, Set<string>> {
  private sets = new Map<string, DeltaSet>();
  constructor(private sql: Sql, private budget: Budget, private R: Regions) {
    super();
  }
  private at(pk: string): DeltaSet {
    let s = this.sets.get(pk);
    if (!s) this.sets.set(pk, (s = new DeltaSet(this.sql, this.budget, this.R.keyToStore(pk, false, true))));
    return s;
  }
  override get(pk: string): Set<string> | undefined {
    return this.at(pk) as unknown as Set<string>;
  }
  override has(): boolean {
    return true;
  }
  override set(pk: string, s: Set<string>): this {
    const d = this.at(pk);
    for (const id of s) d.add(id);
    return this;
  }
  // (only ever after its last child left: nothing is left to write)
  override delete(): boolean {
    return true;
  }
  diff(): { adds: [string, string][]; dels: [string, string][]; largest: number } {
    const adds: [string, string][] = [], dels: [string, string][] = [];
    let largest = 0;
    for (const s of this.sets.values()) {
      if (!s.adds.size && !s.dels.size) continue;
      for (const id of s.dels) dels.push([s.pk!, id]);
      for (const id of s.adds) adds.push([s.pk!, id]);
      largest = Math.max(largest, s.size);
    }
    return { adds, dels, largest };
  }
  apply(d: { adds: [string, string][]; dels: [string, string][] }) {
    ChildrenMap.write(this.sql, d);
  }
}

/**
 * The index over the account object's tables, for one op (a fresh one per op: its caches are that op's). Its maps
 * have the reducer's surface; flush() writes what the op changed.
 */
export class SqlIndex extends SyncIndex {
  /** in deferred mode (`regions` given): what moved, for translating paths and keys; the storage path of each entry read */
  private stored = new Map<string, string>();
  constructor(private sql: Sql, readonly budget: Budget, readonly regions?: Regions) {
    super();
    const self = this as unknown as { byId: Map<string, SyncEntry>; byKey: Map<string, string>; children: Map<string, Set<string>>; gone: Map<string, string> };
    const R = regions;
    self.byId = new CachedMap<SyncEntry>(
      sql, budget,
      (id) => {
        const r = sql.exec("SELECT path, data FROM ix_entries WHERE id = ?", id).toArray()[0] as Row | undefined;
        if (!r) return undefined;
        const e = JSON.parse(String(r.data)) as SyncEntry;
        if (!R) return e;
        this.stored.set(id, String(r.path));
        return R.readEntry(e);
      },
      encEntry,
      (id, e) => {
        if (e === undefined) sql.exec("DELETE FROM ix_entries WHERE id = ?", id);
        else {
          const at = R ? R.pathToStore(e.path) : e, row = at === e ? e : { ...e, path: at as string };
          sql.exec("INSERT INTO ix_entries (id, path, data) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET path = excluded.path, data = excluded.data", id, row.path, encEntry(row));
        }
      },
      // (deferred: a folder that moves is a region from now on, so what is under it reads and writes through it)
      R ? (id, e, was) => {
        if (e.kind !== "folder" || was === undefined || was === e.path) return;
        R.moved(id, this.stored.get(id)!, e.path, was);
        // (what the op already read below it moves with it, as the reducer's own move would take it: entries to their
        // new paths, stamped; keys below either place read again, through the region)
        const to = e.path, wk = keyOf(was), tk = keyOf(to);
        (self.byId as CachedMap<SyncEntry>).remap((k, x) => (x !== undefined && k !== id && strictly(x.path, was) ? { ...x, path: to + x.path.slice(was.length), updated: R.t, seq: R.seq } : false));
        (self.byKey as CachedMap<string>).remap((k) => (strictly(k, wk) || strictly(k, tk) ? null : false));
      } : undefined,
    );
    self.byKey = new CachedMap<string>(
      sql, budget,
      (k) => {
        const sk = R ? R.keyToStore(k, false, false) : k;
        if (sk === null) return undefined;
        return (sql.exec("SELECT id FROM ix_keys WHERE key = ?", sk).toArray()[0] as Row | undefined)?.id as string | undefined;
      },
      (v) => v,
      (k, id) => {
        const sk = R ? (R.keyToStore(k, true, false) as string) : k;
        if (id === undefined) sql.exec("DELETE FROM ix_keys WHERE key = ?", sk);
        else sql.exec("INSERT INTO ix_keys (key, id) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET id = excluded.id", sk, id);
      },
    );
    self.gone = new CachedMap<string>(
      sql, budget,
      (id) => (sql.exec("SELECT path FROM ix_gone WHERE id = ?", id).toArray()[0] as Row | undefined)?.path as string | undefined,
      (v) => v,
      (id, p) => {
        if (p === undefined) sql.exec("DELETE FROM ix_gone WHERE id = ?", id);
        else sql.exec("INSERT INTO ix_gone (id, path) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET path = excluded.path", id, p);
      },
    );
    self.children = R ? new DeltaChildren(sql, budget, R) : new ChildrenMap(sql, budget);
  }

  /** Deferred mode: folders whose reads found them, deleted by the op and remembered as forgotten (their descendants
   * are the job's to forget), with their storage paths. */
  forgotten(): { top: string; from: string }[] {
    const self = this as unknown as { byId: CachedMap<SyncEntry>; gone: CachedMap<string> };
    const out: { top: string; from: string }[] = [];
    for (const [id, was] of self.byId.reads()) if (was?.kind === "folder" && self.byId.final(id) === undefined && self.gone.final(id) !== undefined) out.push({ top: id, from: this.stored.get(id)! });
    return out;
  }

  /** What the op changed, written: the change in live entries and in tombstones, and the largest folder touched. */
  // (every write is known and charged before the first is made: a stop leaves nothing written, transaction or not)
  flush(): { entries: number; gone: number; largest: number; written: [string, string | null][] } {
    const self = this as unknown as { byId: CachedMap<SyncEntry>; byKey: CachedMap<string>; children: ChildrenMap | DeltaChildren; gone: CachedMap<string> };
    const ids = self.byId.diff(), keys = self.byKey.diff(), ch = self.children.diff(), gone = self.gone.diff();
    this.budget.charge(ids.length + keys.length + ch.adds.length + ch.dels.length + gone.length);
    // (keys and children deleted first: a path can move from one identity to another within one op)
    const entries = self.byId.apply(ids);
    self.byKey.apply(keys);
    self.children.apply(ch);
    // (each entry written, at its storage path, or deleted: the job's stage follows it)
    const written = ids.map(([id, e]) => [id, e === undefined ? null : this.regions ? this.regions.pathToStore(e.path) : e.path] as [string, string | null]);
    return { entries, gone: self.gone.apply(gone), largest: ch.largest, written };
  }
}

/**
 * One op applied to the stored index, in the caller's transaction, charged to `budget`: the reducer's outcome, and the
 * change in counts. A BudgetStop (from the reducer's work, its own undo, or the writes) propagates: the caller rolls
 * back, and the op counts neither as applied nor as refused. With `regions`, deferred mode (above): each folder the op
 * moves or forgets becomes a region there; `dry`: nothing written (the regions are the point).
 */
export function applyOp(sql: Sql, op: SyncOp, budget: Budget, regions?: Regions, dry = false): { out: Outcome; entries: number; gone: number; largest: number; written: [string, string | null][] } {
  const ix = new SqlIndex(sql, budget, regions);
  let out: Outcome;
  try {
    out = reduce(ix, op);
  } catch (e) {
    if (budget.stopped) throw new BudgetStop();
    throw e;
  }
  // (the reducer catches what it calls, so a stop inside it shows only here)
  if (budget.stopped) throw new BudgetStop();
  if (regions) for (const f of ix.forgotten()) regions.forgot(f.top, f.from);
  if (dry) return { out, entries: 0, gone: 0, largest: 0, written: [] };
  return { out, ...ix.flush() };
}

/**
 * A deferred op's job, kept in ix_job (one row) and ix_stage, so a restart goes on from its last step:
 * - dry: the op run with nothing written, for its regions and moves (in a step of its own);
 * - pre: every descendant of every region read in pages, for the reducer's check of each move (the longest path and
 *   the deepest one below its top), and staged with its region (the innermost: regions are read outermost first);
 * - drop: a move past the workspace's bounds makes the op change nothing, as the reducer's own check would: the stage
 *   is emptied in pages, then the op is passed;
 * - apply: the op run and written (in a step of its own), the stage told what it wrote;
 * - stage: each staged descendant taken to its region's new place (stamped with the op), or forgotten, in pages.
 * The cursor moves past the op only when the stage is empty, in that step's transaction (the caller's).
 */
export type Job = {
  seq: number;
  phase: "dry" | "pre" | "drop" | "apply" | "stage";
  regions: Region[];
  events: [number, string][];
  order: number[];
  at: number;
  after: string | null;
  maxLen: number[];
  maxDepth: number[];
  entries: number;
  gone: number;
  /** a skip's reason, as the reducer gave it (for the record) */
  why?: string;
};
export function jobGet(sql: Sql): Job | null {
  const r = sql.exec("SELECT v FROM ix_job WHERE one = 1").toArray()[0] as Row | undefined;
  return r ? (JSON.parse(String(r.v)) as Job) : null;
}
export function jobPut(sql: Sql, job: Job | null) {
  if (job === null) sql.exec("DELETE FROM ix_job");
  else sql.exec("INSERT INTO ix_job (one, v) VALUES (1, ?) ON CONFLICT(one) DO UPDATE SET v = excluded.v", JSON.stringify(job));
}
export const jobNew = (seq: number): Job => ({ seq, phase: "dry", regions: [], events: [], order: [], at: 0, after: null, maxLen: [], maxDepth: [], entries: 0, gone: 0 });

const depthOf = (p: string) => (p === "/" ? 0 : p.split("/").length - 1);
/** rows a page reads at most, and what each row costs in visits */
export const JOB = { page: 500, preCost: 2, stageCost: 9, pages: Infinity };

/**
 * As much of the job as `budget` holds (the run phases only on a fresh budget: `fresh`): "more" (the next step goes
 * on), "skip" (the op changes nothing: its cursor passes), or "done" (the op is whole: its cursor and counts publish).
 * `largest`: the most children a folder the op wrote has (for the folder bound).
 */
export function jobStep(sql: Sql, job: Job, op: SyncOp, budget: Budget, fresh: boolean, page = JOB.page): { result: "more" | "skip" | "done"; largest: number } {
  let pages = 0;
  const room = (cost: number) => (++pages > JOB.pages ? 0 : Math.min(page, Math.floor((budget.limit - budget.used - 1) / cost)));
  let largest = 0;
  for (;;) {
    if (job.phase === "dry") {
      if (!fresh || budget.used > 0) return { result: "more", largest };
      const R = new Regions(op.t, op.seq);
      const res = applyOp(sql, op, budget, R, true);
      if (res.out.skipped !== undefined) {
        job.why = res.out.skipped;
        return { result: "skip", largest };
      }
      Object.assign(job, { phase: "pre", regions: R.list, events: R.events, at: 0, after: null, maxLen: R.list.map(() => -1), maxDepth: R.list.map(() => -1) });
      job.order = R.list.map((_, i) => i).sort((x, y) => R.list[x].from.length - R.list[y].from.length || x - y);
    } else if (job.phase === "pre") {
      if (job.at === job.order.length) {
        const past = job.events.some(([i, dest]) => job.maxLen[i] >= 0 && (dest.length + job.maxLen[i] > MAX_PATH || depthOf(dest) + job.maxDepth[i] > MAX_DEPTH));
        job.phase = past ? "drop" : "apply";
        continue;
      }
      const k = room(JOB.preCost);
      if (k <= 0) return { result: "more", largest };
      const i = job.order[job.at], r = job.regions[i];
      budget.charge();
      const rows = sql.exec("SELECT id, path FROM ix_entries WHERE path > ? AND path < ? ORDER BY path LIMIT ?", job.after ?? r.from + "/", r.from + "0", k).toArray() as Row[];
      budget.charge(rows.length * JOB.preCost);
      const top = depthOf(r.from);
      for (const x of rows) {
        const p = String(x.path);
        job.maxLen[i] = Math.max(job.maxLen[i], p.length - r.from.length);
        job.maxDepth[i] = Math.max(job.maxDepth[i], depthOf(p) - top);
        sql.exec("INSERT INTO ix_stage (id, r) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET r = excluded.r", x.id, i);
      }
      if (rows.length < k) (job.at += 1), (job.after = null);
      else job.after = String(rows[rows.length - 1].path);
    } else if (job.phase === "drop") {
      const k = room(1);
      if (k <= 0) return { result: "more", largest };
      budget.charge(k + 1);
      sql.exec("DELETE FROM ix_stage WHERE id IN (SELECT id FROM ix_stage LIMIT ?)", k);
      if (!sql.exec("SELECT 1 AS x FROM ix_stage LIMIT 1").toArray().length) return { result: "skip", largest };
    } else if (job.phase === "apply") {
      if (!fresh || budget.used > 0) return { result: "more", largest };
      const R = new Regions(op.t, op.seq);
      const res = applyOp(sql, op, budget, R, false);
      // (the same op on the same index: the same moves as the dry run, or something is wrong)
      if (JSON.stringify([R.list.map((r) => [r.top, r.from]), R.events]) !== JSON.stringify([job.regions.map((r) => [r.top, r.from]), job.events])) throw new Error("a deferred op moved differently when it was applied");
      job.regions = R.list;
      budget.charge(res.written.length);
      for (const [id, at] of res.written) {
        let best = -1;
        if (at !== null) for (let i = 0; i < R.list.length; i++) if (strictly(at, R.list[i].from) && (best < 0 || R.list[i].from.length > R.list[best].from.length)) best = i;
        if (best < 0) sql.exec("DELETE FROM ix_stage WHERE id = ?", id);
        else sql.exec("INSERT INTO ix_stage (id, r) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET r = excluded.r", id, best);
      }
      job.entries += res.entries;
      job.gone += res.gone;
      largest = res.largest;
      job.phase = "stage";
      fresh = false;
    } else {
      const k = room(JOB.stageCost);
      if (k <= 0) return { result: "more", largest };
      budget.charge();
      const rows = sql.exec("SELECT s.id AS id, s.r AS r, e.path AS path, e.data AS data FROM ix_stage s LEFT JOIN ix_entries e ON e.id = s.id ORDER BY s.id LIMIT ?", k).toArray() as Row[];
      if (!rows.length) return { result: "done", largest };
      budget.charge(rows.length * JOB.stageCost);
      const adds: [string, string][] = [], dels: [string, string][] = [];
      for (const x of rows) {
        const id = String(x.id);
        sql.exec("DELETE FROM ix_stage WHERE id = ?", id);
        if (x.path === null) continue;
        const r = job.regions[Number(x.r)], sp = String(x.path);
        sql.exec("DELETE FROM ix_keys WHERE key = ? AND id = ?", keyOf(sp), id);
        dels.push([keyOf(parentOf(sp)), id]);
        if (r.cur === null) {
          sql.exec("DELETE FROM ix_entries WHERE id = ?", id);
          if (!sql.exec("SELECT 1 AS x FROM ix_gone WHERE id = ?", id).toArray().length) job.gone += 1;
          sql.exec("INSERT INTO ix_gone (id, path) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET path = excluded.path", id, sp);
          job.entries -= 1;
          continue;
        }
        const fp = r.cur + sp.slice(r.from.length), e = JSON.parse(String(x.data)) as SyncEntry;
        e.path = fp;
        e.updated = op.t;
        e.seq = op.seq;
        sql.exec("UPDATE ix_entries SET path = ?, data = ? WHERE id = ?", fp, encEntry(e), id);
        const other = (sql.exec("SELECT id FROM ix_keys WHERE key = ?", keyOf(fp)).toArray()[0] as Row | undefined)?.id;
        if (other !== undefined && other !== id) throw new Entangled(`${fp.slice(0, 80)} is another's`);
        sql.exec("INSERT INTO ix_keys (key, id) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET id = excluded.id", keyOf(fp), id);
        adds.push([keyOf(parentOf(fp)), id]);
      }
      ChildrenMap.write(sql, { adds, dels });
    }
  }
}
