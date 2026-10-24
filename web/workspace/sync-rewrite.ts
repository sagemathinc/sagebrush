// Large moves applied in chunks (design/sync-client.md D11, plan-pr65-d11-chunked-moves r7 and its r8 notes v2): the
// records, the read model and the fence they share.
//
// - A record names a set of mappings, each a subtree (its top and everything under it) carried from a source prefix
//   `from` to a destination prefix `to`.  At most one record per store: the workspace's `entries` (a local large move,
//   or the view's plan of a large confirmed move) and each confirmed index generation (sync-confirmed.ts).
// - Until a record is published, readers see the old tree (the read model is the identity).  From its publication,
//   every reader sees the logical tree: each row answered as its mapping's projection, wherever the row physically is
//   (r3 §4, r7 §1).  Where a row may be depends on the record's phase:
//     direct  (a local move; the confirmed index)  its source, or its destination;
//     sweep 1 (a plan)                             its source, or its mapping's own staging range;
//     sweep 2 (a plan)                             its mapping's staging range, or its destination.
// - From a record's creation every write to `entries` whose path is an ancestor, a descendant or the same as any of
//   its prefixes (NFC) is refused `busy` (r3 §1's affected-subtree intersection), through fenceCheck.
//
// In `entries` (r8 N4), under keys below "/", which no path can be:
//   "\u0001rw"                 the record (a control row: no indexed field, so in no index, never counted)
//   "\u0001m/<rid>/<i>"         a plan's mapping rows (control rows too)
//   "\u0001s/<rid>/<i>…"        staged rows: real entries, each in one place, counted once, in the indexes (byIdent
//                               keeps their bytes protected; their `ref` is kept as it was until sweep 2)
// Every logical reader hides control rows; every physical whole-store scan or count starts at "/" and adds the
// staging range where it means every real entry.
import { req } from "./db";
import { nameOf, parentOf, within } from "./paths";
import type { Entry } from "./api";
import type { Kind } from "./paths";
import { WorkspaceError } from "./api";

/** D11's bounds: defaults, admin-configurable within hard ceilings (configureD11). */
export const D11 = {
  /** a subtree of more than this many descendants is moved in chunks */
  chunk: 1000,
  /** rows a rewrite or sweep transaction moves at most */
  page: 1000,
  /** identities a plan, validation-free placement or replay transaction takes at most */
  planPage: 100,
  /** tops a validation transaction checks at most */
  validatePage: 10,
  /** IndexedDB requests a plan, validation or placement transaction makes at most */
  requests: 400,
  /** a plan's large mappings at most, and its small (one-entry or small-folder) mappings */
  large: 100,
  small: 1000,
  /** replay debts kept at most (the rebuild's view) */
  debts: 100,
  /** one logical large move, from the confirmed publication: late past this */
  deadlineMs: 900_000,
  /** the sender's pause (the plan pass, its closure and validation) at most */
  pauseMs: 150_000,
  /** (r8 N8) a plan's closure at most: items (target checks) and IndexedDB requests and rows in all its rounds, its
   * rounds, the candidates for one target (its view's name included), and the rows one lookalike group may have */
  closureItems: 8800,
  closureRequests: 200_000,
  closureRows: 400_000,
  closureRounds: 3,
  freeNames: 100,
  lookalikes: 32,
  /** consecutive failures of a record's page before it is stuck, told */
  fails: 10,
  /** a failed page's retry: from min, doubling to max */
  backoffMin: 1000,
  backoffMax: 60_000,
};
type D11Key = keyof typeof D11;
/** The hard ceilings no configuration passes (and floors it can't go under). */
export const D11_CEILING: Record<D11Key, [number, number]> = {
  chunk: [10, 1000],
  page: [10, 1000],
  planPage: [1, 100],
  validatePage: [1, 10],
  requests: [50, 400],
  large: [1, 100],
  small: [1, 1000],
  debts: [1, 100],
  deadlineMs: [1000, 900_000],
  pauseMs: [1000, 150_000],
  closureItems: [1, 8800],
  closureRequests: [1, 200_000],
  closureRows: [1, 400_000],
  closureRounds: [1, 3],
  freeNames: [1, 100],
  lookalikes: [1, 32],
  fails: [1, 100],
  backoffMin: [10, 60_000],
  backoffMax: [10, 600_000],
};
/** An administrator's values (from the site's policy), each clamped to its ceiling; unknown or non-numeric keys
 * ignored.  Returns the values in force. */
export function configureD11(policy: Partial<Record<string, unknown>>): typeof D11 {
  for (const k of Object.keys(D11) as D11Key[]) {
    const v = policy[k];
    if (typeof v !== "number" || !Number.isFinite(v)) continue;
    const [lo, hi] = D11_CEILING[k];
    D11[k] = Math.min(hi, Math.max(lo, Math.floor(v)));
  }
  if (D11.backoffMax < D11.backoffMin) D11.backoffMax = D11.backoffMin;
  return { ...D11 };
}

// ---- keys

export const RW = "\u0001rw";
export const MAPS = "\u0001m/";
export const STAGE = "\u0001s/";
/** (r8 N8) an unpublished plan's closure: its worklist, round and counters (one control row) */
export const QUEUE = "\u0001q/";
export const queueKey = (rid: string) => `${QUEUE}${rid}`;
const STAGE_END = "\u0001s0";
/** Every path a user's row can have: keys from "/" up to, not including, "0". */
export const USER_RANGE = () => IDBKeyRange.bound("/", "0", false, true);
export const STAGE_RANGE = () => IDBKeyRange.bound(STAGE, STAGE_END, false, true);
export const isControl = (k: string) => k === RW || k.startsWith(MAPS);
const pad = (i: number) => String(i).padStart(5, "0");
export const mapKey = (rid: string, i: number) => `${MAPS}${rid}/${pad(i)}`;
const mapRange = (rid: string) => IDBKeyRange.bound(`${MAPS}${rid}/`, `${MAPS}${rid}0`, false, true);
export const stageOf = (rid: string, i: number) => `${STAGE}${rid}/${pad(i)}`;
/** The descendants of `p` (not `p`): keys from `p/` up to, not including, `p0` (CORR-4A0-3). */
export const under = (p: string) => (p === "/" ? IDBKeyRange.bound("/", "0", true, true) : IDBKeyRange.bound(p + "/", p + "0", false, true));
const nfc = (s: string) => s.normalize("NFC");
export const nkeyOf = (p: string) => parentOf(p) + "\u0000" + nfc(nameOf(p));
const join = (f: string, name: string) => (f === "/" ? "" : f) + "/" + name;
/** A child's place in its folder's listing: by its name's NFC form, then its name (the index byNfc's order). */
export const ckey = (name: string) => nfc(name) + "\u0000" + name;

// ---- records and mappings

export type Mapping = {
  i: number;
  /** the source prefix (physical, where its rows were at publication) */
  from: string;
  /** the destination prefix (logical) */
  to: string;
  /** the top's identity */
  top?: string;
  large?: boolean;
  /** (a plan's, r8 N3) the op the top's move is logged as, its original and final logical paths, its kind, and the
   * view's top fields with the time captured at planning */
  op?: "rename" | "remove" | "restore";
  was?: string;
  kind?: Kind;
  trashed?: Entry["trashed"] | null;
  updated?: number;
  /** (a plan's) the top's op logged, in sweep 2's transaction that wrote it at its destination */
  logged?: boolean;
  /** (a plan's) the top's view path, where `to` is a free `name (k)` beside an occupant that stays there (`occ`, its
   * identity; null: none) */
  want?: string;
  occ?: string | null;
  /** (a plan's, r8 N8) the candidate `to` is (0: `want`, k: freePath's (k + 1)th name), and the claimant at `want`
   * that decided it (null at 0): where it was found (carried) and its physical path, its identity or its mapping */
  t?: number;
  wit?: { map?: number; id?: string | null; at: string; src: string } | null;
  /** (a plan's, r8 N7) direct: it touches no other mapping and has no occupant, so its rows go source -> destination
   * in sweep 1, never through staging; persisted with the mapping at publication */
  direct?: boolean;
};
export type RecordKind = "local" | "plan" | "reserved";
export type ERecord = {
  path: typeof RW;
  rid: string;
  kind: RecordKind;
  published: boolean;
  /** a plan's sweep, once published */
  sweep?: 1 | 2;
  /** changed with the plan's mappings: the cached ones are read again */
  rev: number;
  /** a local move's one mapping (inline); a plan's are rows */
  maps?: Mapping[];
  n: number;
  fails: number;
  /** after D11.fails consecutive failures: why, told; the fence and the read model stay */
  stuck?: string;
  at: number;
  /** a local move's preflight position, and its op's parts (published by the caller's transaction) */
  pre?: { after?: string; done?: boolean };
  /** the tab whose call made it (a local move's preflight: abandoned on reload when its caller is gone) */
  tab?: string;
};

export type Phase = "none" | "direct" | "s1" | "s2";

/** A record's mappings, indexed: sources, destinations, folders' direct-child mappings, and the fence's prefixes. */
export class MapSet {
  readonly phase: Phase;
  private src = new Map<string, number>();
  private dst = new Map<string, number>();
  private kids = new Map<string, Mapping[]>();
  private fencePre: string[] = [];
  private fenceSet = new Set<string>();
  constructor(readonly rec: ERecord | undefined, readonly maps: Mapping[]) {
    this.phase = !rec || rec.kind === "reserved" ? "none" : !rec.published ? "none" : rec.kind === "local" ? "direct" : rec.sweep === 2 ? "s2" : "s1";
    for (const m of maps) {
      this.src.set(m.from, m.i);
      this.dst.set(m.to, m.i);
      const f = parentOf(m.to);
      if (!this.kids.has(f)) this.kids.set(f, []);
      this.kids.get(f)!.push(m);
      for (const p of [m.from, m.to]) this.fenceSet.add(nfc(p));
    }
    for (const list of this.kids.values()) list.sort((a, b) => (ckey(nameOf(a.to)) < ckey(nameOf(b.to)) ? -1 : 1));
    this.fencePre = [...this.fenceSet].sort();
  }
  get active() {
    return this.phase !== "none";
  }
  /** rows can be at their source (direct, sweep 1) */
  get atSource() {
    return this.phase === "direct" || this.phase === "s1";
  }
  /** rows can be at their staging range (sweep 1, sweep 2) */
  get staged() {
    return this.phase === "s1" || this.phase === "s2";
  }
  /** rows can be at their destination (direct, sweep 2) */
  get atDest() {
    return this.phase === "direct" || this.phase === "s2";
  }
  stage(m: Mapping) {
    return stageOf(this.rec!.rid, m.i);
  }
  /** Where a mapping's rows can be in this phase (r8 N7: a plan's direct mapping as the direct mode). */
  isDirect(m: Mapping) {
    return this.phase === "direct" || !!m.direct;
  }
  stagedFor(m: Mapping) {
    return this.staged && !this.isDirect(m);
  }
  atSourceFor(m: Mapping) {
    return this.atSource;
  }
  atDestFor(m: Mapping) {
    return this.atDest || (this.phase === "s1" && !!m.direct);
  }
  /** The mapping whose source is `p`'s longest source prefix (`p` itself or an ancestor). */
  srcOwner(p: string): Mapping | undefined {
    if (!this.src.size) return undefined;
    for (let a = p; ; a = parentOf(a)) {
      const i = this.src.get(a);
      if (i !== undefined) return this.maps[i];
      if (a === "/" || !a.startsWith("/")) return undefined;
    }
  }
  /** The mapping whose destination is `L`'s longest destination prefix. */
  dstOwner(L: string): Mapping | undefined {
    if (!this.dst.size) return undefined;
    for (let a = L; ; a = parentOf(a)) {
      const i = this.dst.get(a);
      if (i !== undefined) return this.maps[i];
      if (a === "/" || !a.startsWith("/")) return undefined;
    }
  }
  /** The mappings whose destination is directly in folder `F`, in listing order. */
  childMaps(F: string): Mapping[] {
    return this.kids.get(F) ?? [];
  }
  /** Whether `p` is a direct-child mapping's destination. */
  isDest(p: string) {
    return this.dst.has(p);
  }
  /** The mapping of a staged key, and the rest of the key after its staging prefix. */
  stagedOwner(P: string): { m: Mapping; rest: string } | undefined {
    if (!P.startsWith(STAGE) || !this.rec) return undefined;
    const pre = `${STAGE}${this.rec.rid}/`;
    if (!P.startsWith(pre)) return undefined;
    const i = Number(P.slice(pre.length, pre.length + 5));
    const m = this.maps[i];
    return m ? { m, rest: P.slice(pre.length + 5) } : undefined;
  }
  /** Where logical path `L` may physically be, in this phase (r6/r7 §1's point read): candidates in order, each with
   * the mapping that must own a source candidate; null for an old alias (absent). */
  route(L: string): { m?: Mapping; cands: { p: string; own?: Mapping }[] } | null {
    const m = this.dstOwner(L);
    if (m) {
      const rest = L.slice(m.to.length);
      if (this.isDirect(m)) return { m, cands: this.phase === "s2" ? [{ p: L }] : [{ p: L }, { p: m.from + rest, own: m }] };
      if (this.phase === "s1") return { m, cands: [{ p: this.stage(m) + rest }, { p: m.from + rest, own: m }] };
      return { m, cands: [{ p: this.stage(m) + rest }, { p: L }] };
    }
    if (this.atSource && this.srcOwner(L)) return null;
    return { cands: [{ p: L }] };
  }
  /** A physical row's logical path, and its mapping (none for an unplanned row, or one already at its destination). */
  logicalOf(P: string): { L: string; m?: Mapping } {
    const s = this.stagedOwner(P);
    if (s) return { L: s.m.to + s.rest, m: s.m };
    if (this.atSource) {
      const m = this.srcOwner(P);
      if (m) return { L: m.to + P.slice(m.from.length), m };
    }
    return { L: P };
  }
  /** Whether a write to `p` meets the fence: `p` an ancestor of, a descendant of, or the same as any prefix (NFC). */
  conflicts(p: string): boolean {
    if (!this.fencePre.length) return false;
    const q = nfc(p);
    if (q === "/") return true;
    for (let a = q; a !== "/" && a.startsWith("/"); a = parentOf(a)) if (this.fenceSet.has(a)) return true;
    const lo = q + "/";
    let i = 0, j = this.fencePre.length;
    while (i < j) {
      const k = (i + j) >> 1;
      if (this.fencePre[k] < lo) i = k + 1;
      else j = k;
    }
    return i < this.fencePre.length && this.fencePre[i].startsWith(lo);
  }
}

// ---- the projection

/** A projected entry's physical row (its path and `ref`): a legacy file's bytes are read where they are (r3 §4). */
const PHYSICAL = new WeakMap<Entry, Entry>();
export const physicalOf = (e: Entry): Entry => PHYSICAL.get(e) ?? e;

/** Row `row` as the logical record at `L` of mapping `m` (r3 §4's entries projection; r8 N3's top fields). */
export function project(row: Entry, L: string, m: Mapping | undefined): Entry {
  if (!m || row.path === L) return row;
  const n: Entry = { ...row, path: L, nkey: nkeyOf(L) };
  if (row.kind === "file" && row.ref !== null) n.ref = L;
  if (L === m.to && m.updated !== undefined) {
    n.updated = m.updated;
    if (m.trashed) n.trashed = { ...m.trashed };
    else if (m.trashed === null) delete n.trashed;
  }
  PHYSICAL.set(n, row);
  return n;
}

// ---- the record, read once a transaction

type Cached = { rid: string; rev: number; maps: Mapping[] };
const cache = new WeakMap<IDBDatabase, Cached>();

/** The `entries` record and its mappings, read in `tx` (one request; the mappings again only when they changed). */
export async function recordOf(tx: IDBTransaction): Promise<{ rec?: ERecord; maps: Mapping[] }> {
  const st = tx.objectStore("entries");
  const rec = (await req(st.get(RW))) as ERecord | undefined;
  if (!rec) return { maps: [] };
  if (rec.kind !== "plan") return { rec, maps: rec.maps ?? [] };
  const db = tx.db, c = cache.get(db);
  if (c && c.rid === rec.rid && c.rev === rec.rev) return { rec, maps: c.maps };
  const rows = (await req(st.getAll(mapRange(rec.rid)))) as (Mapping & { path: string })[];
  const maps = rows.map(({ path: _p, ...m }) => m as Mapping).sort((a, b) => a.i - b.i);
  cache.set(db, { rid: rec.rid, rev: rec.rev, maps });
  return { rec, maps };
}

/** The `entries` record, if any (its own short transaction): the migrator and the cleanup wait while there is one
 * (r8 N4). */
export async function rewriting(db: IDBDatabase): Promise<ERecord | undefined> {
  return new Promise((ok, no) => {
    const r = db.transaction("entries").objectStore("entries").get(RW);
    r.onsuccess = () => ok(r.result as ERecord | undefined);
    r.onerror = () => no(r.error);
  });
}

/** The views of `entries` made in a transaction, kept for it: one read of the record a transaction. */
const views = new WeakMap<IDBTransaction, EntriesView>();
/** Transactions that read the fence before writing `entries` (the participation test's witness, r3 §1). */
export const FENCE_READ = new WeakSet<IDBTransaction>();

/** The logical view of `entries` in `tx` (r3 §4, r7 §1). */
export async function entriesOf(tx: IDBTransaction): Promise<EntriesView> {
  const had = views.get(tx);
  if (had) return had;
  const { rec, maps } = await recordOf(tx);
  const v = new EntriesView(tx, new MapSet(rec, maps));
  views.set(tx, v);
  return v;
}
/** Forgets the view kept for `tx` (after the record changed in it). */
export const dropView = (tx: IDBTransaction) => views.delete(tx);

export const busyError = (why = "a large move is still being applied here: try again in a moment") => new WorkspaceError("busy" as never, why);

/**
 * The fence (r3 §1): every transaction that writes `entries` calls this, with every path its change affects (its
 * target; a move's source and destination; a folder op's folder, whose subtree the intersection covers), before
 * its first write.  A conflict is refused `busy`, nothing written.  Returns the transaction's view.
 */
export async function fenceCheck(tx: IDBTransaction, paths: Iterable<string>): Promise<EntriesView> {
  const v = await entriesOf(tx);
  FENCE_READ.add(tx);
  for (const p of paths) if (v.ms.conflicts(p)) throw busyError();
  return v;
}

type Item = { ck: string; L: string; row: Entry; m?: Mapping };

/** `entries` as its readers see it, in one transaction: the logical tree while a record is published. */
export class EntriesView {
  readonly st: IDBObjectStore;
  constructor(readonly tx: IDBTransaction, readonly ms: MapSet) {
    this.st = tx.objectStore("entries");
  }
  get rec() {
    return this.ms.rec;
  }
  get active() {
    return this.ms.active;
  }

  /** A physical row as its logical record. */
  logical(row: Entry): Entry {
    if (!this.ms.active) return row;
    const { L, m } = this.ms.logicalOf(row.path);
    return project(row, L, m);
  }

  /** The entry at logical path `L`. */
  async get(L: string): Promise<Entry | undefined> {
    if (!this.ms.active) return (await req(this.st.get(L))) as Entry | undefined;
    const r = this.ms.route(L);
    if (!r) return undefined;
    for (const c of r.cands) {
      const row = (await req(this.st.get(c.p))) as Entry | undefined;
      if (!row) continue;
      if (c.own && this.ms.srcOwner(c.p) !== c.own) continue;
      return project(row, L, r.m);
    }
    return undefined;
  }
  async has(L: string): Promise<boolean> {
    if (!this.ms.active) return (await req(this.st.getKey(L))) !== undefined;
    return (await this.get(L)) !== undefined;
  }

  /** An identity's entry. */
  async byIdent(id: string): Promise<Entry | undefined> {
    const row = (await req(this.st.index("byIdent").get(id))) as Entry | undefined;
    return row ? this.logical(row) : undefined;
  }
  async byIdentAll(range?: IDBKeyRange | null, n?: number): Promise<Entry[]> {
    return ((await req(this.st.index("byIdent").getAll(range ?? null, n))) as Entry[]).map((r) => this.logical(r));
  }
  async byIdentCount(id: string): Promise<number> {
    return (await req(this.st.index("byIdent").count(id))) as number;
  }

  /** Entries naming `ref` as their contents (index byRef), matched physically: a legacy file's storage key is where
   * its bytes are, and a staged row keeps its `ref` until sweep 2 (r8 N4). */
  async byRef(kind: string, ref: string, n?: number): Promise<Entry[]> {
    return ((await req(this.st.index("byRef").getAll([kind, ref], n))) as Entry[]).map((r) => this.logical(r));
  }
  /** The data files whose bytes are to be fetched (index byFetch). */
  async byFetch(n: number): Promise<Entry[]> {
    return ((await req(this.st.index("byFetch").getAll(null, n))) as Entry[]).map((r) => this.logical(r));
  }

  /** How many entries there are: rows from "/" and staged rows, in this one transaction (r8 N4). */
  async count(): Promise<number> {
    const a = (await req(this.st.count(USER_RANGE()))) as number;
    if (!this.ms.rec) return a;
    return a + ((await req(this.st.count(STAGE_RANGE()))) as number);
  }

  /** Every entry (Trash's too), as the logical tree has them, in no particular order. */
  async all(): Promise<Entry[]> {
    const rows = (await req(this.st.getAll(USER_RANGE()))) as Entry[];
    if (this.ms.rec) rows.push(...((await req(this.st.getAll(STAGE_RANGE()))) as Entry[]));
    return rows.map((r) => this.logical(r));
  }

  /** Physical direct children of folder `X` (index byNfc), from `afterCk`, at most `n` raw rows. */
  private async raw(X: string, afterCk: string, n: number): Promise<Entry[]> {
    const lo = X + "\u0000" + (afterCk ? afterCk.slice(0, afterCk.indexOf("\u0000")) : "");
    return (await req(this.st.index("byNfc").getAll(IDBKeyRange.bound(lo, X + "\u0000￿"), n))) as Entry[];
  }

  /**
   * A page of folder `F`'s direct children, by listing order, after the logical cursor `after` (a ckey): r7 §1's
   * sources, each read at most `n + 1` (plus the cursor's lookalikes), merged, rows owned elsewhere skipped.
   * Returns the page, and the cursor to go on from (undefined: the end).  `absent`: `F` is an old alias.
   */
  async page(F: string, after = "", n = 1000): Promise<{ list: Entry[]; next?: string; absent?: boolean; reads: number }> {
    const ms = this.ms;
    const slack = 8, lim = n + 1 + slack;
    type Src = { items: Item[]; more: boolean };
    const sources: Promise<Src>[] = [];
    let reads = 0;
    const phys = (X: string, skip: (P: string) => boolean, m?: Mapping) => (async (): Promise<Src> => {
      reads++;
      const rows = await this.raw(X, after, lim);
      const items: Item[] = [];
      for (const row of rows) {
        const name = nameOf(row.path), ck = ckey(name);
        if (ck <= after) continue;
        const it: Item = { ck, L: join(F, name), row, m };
        if (skip(row.path)) (it as Item & { skip?: true }).skip = true;
        items.push(it);
      }
      return { items, more: rows.length >= lim };
    })();
    if (!ms.active) sources.push(phys(F, () => false));
    else {
      const own = ms.dstOwner(F);
      if (!own && ms.atSource && ms.srcOwner(F)) return { list: [], absent: true, reads };
      const childDest = (P: string) => ms.isDest(P) && parentOf(P) === F && ms.dstOwner(P)?.to === P;
      if (own) {
        const rest = F.slice(own.to.length);
        if (ms.stagedFor(own)) sources.push(phys(ms.stage(own) + rest, () => false, own));
        if (ms.atSourceFor(own)) sources.push(phys(own.from + rest, (P) => ms.srcOwner(P) !== own, own));
        if (ms.atDestFor(own)) sources.push(phys(F, childDest));
      } else sources.push(phys(F, (P) => (ms.atSource && !!ms.srcOwner(P)) || childDest(P)));
      // (the direct-child mappings' tops, by point reads)
      const kids = ms.childMaps(F).filter((m) => ckey(nameOf(m.to)) > after);
      if (kids.length) sources.push((async (): Promise<Src> => {
        const items: Item[] = [];
        for (const m of kids.slice(0, lim)) {
          const e = await this.get(m.to);
          reads += 2;
          if (e) items.push({ ck: ckey(nameOf(m.to)), L: m.to, row: e, m: undefined });
        }
        return { items, more: kids.length > lim };
      })());
    }
    const got = await Promise.all(sources);
    // (the page ends at the smallest last key read among the sources that have more: everything up to it is known)
    let end: string | undefined;
    for (const s of got) if (s.more && s.items.length) {
      const last = s.items[s.items.length - 1].ck;
      if (end === undefined || last < end) end = last;
    }
    const merged = got.flatMap((s) => s.items).filter((it) => end === undefined || it.ck <= end).sort((a, b) => (a.ck < b.ck ? -1 : a.ck > b.ck ? 1 : 0));
    const list: Entry[] = [];
    let next: string | undefined = end;
    for (const it of merged) {
      if ((it as Item & { skip?: true }).skip) continue;
      if (list.length === n) { next = list.length ? ckey(nameOf(list[list.length - 1].path)) : end; break; }
      list.push(it.m || it.row.path !== it.L ? project(it.row, it.L, it.m ?? ms.dstOwner(it.L)) : it.row);
    }
    return { list, next, reads };
  }

  /** Every direct child of folder `F` (at most the workspace's 10,000 per folder, read a page at a time). */
  async list(F: string): Promise<Entry[]> {
    // (no record: the subtree's keys, as the workspace always listed a folder (an entry made before nkeys were kept
    // has none until the migrator gives it, so the index byNfc isn't asked))
    if (!this.ms.active) return ((await req(this.st.getAll(under(F)))) as Entry[]).filter((e) => parentOf(e.path) === F);
    const out: Entry[] = [];
    let after = "";
    for (;;) {
      const p = await this.page(F, after, 1000);
      out.push(...p.list);
      if (p.next === undefined) return out;
      after = p.next;
    }
  }
  /** How many direct children folder `F` has. */
  async childCount(F: string): Promise<number> {
    if (!this.ms.active) return (await req(this.st.index("byNfc").count(IDBKeyRange.bound(F + "\u0000", F + "\u0000￿")))) as number;
    return (await this.list(F)).length;
  }
  /** The children of `parentOf(L)` whose names look the same as `L`'s (NFC), at most `n`. */
  async lookalikes(L: string, n = 2): Promise<Entry[]> {
    const F = parentOf(L), want = nfc(nameOf(L));
    if (!this.ms.active) return ((await req(this.st.index("byNfc").getAll(IDBKeyRange.only(nkeyOf(L)), n))) as Entry[]);
    const out: Entry[] = [];
    let after = want;
    for (;;) {
      const p = await this.page(F, after, 16);
      for (const e of p.list) {
        if (nfc(nameOf(e.path)) !== want) return out;
        out.push(e);
        if (out.length >= n) return out;
      }
      if (p.next === undefined) return out;
      after = p.next;
    }
  }

  /** Everything under folder `F` (not `F`), by path: the physical subtree, and every mapping's ranges that project
   * into it, each row kept if its logical path is under `F`. */
  async subtree(F: string): Promise<Entry[]> {
    const ms = this.ms;
    if (!ms.active) return (await req(this.st.getAll(under(F)))) as Entry[];
    const seen = new Map<string, Entry>();
    const take = async (range: IDBKeyRange) => {
      for (const r of (await req(this.st.getAll(range))) as Entry[]) seen.set(r.path, r);
    };
    const one = async (k: string) => {
      const r = (await req(this.st.get(k))) as Entry | undefined;
      if (r) seen.set(r.path, r);
    };
    await take(under(F));
    for (const m of ms.maps) {
      let base: string, top = false;
      if (m.to !== F && within(m.to, F)) { base = ""; top = true; }
      else if (within(F, m.to)) base = F.slice(m.to.length);
      else continue;
      for (const pre of [...(ms.stagedFor(m) ? [ms.stage(m)] : []), ...(ms.atSourceFor(m) ? [m.from] : [])]) {
        if (top) await one(pre);
        await take(under(pre + base));
      }
    }
    const out: Entry[] = [];
    for (const row of seen.values()) {
      const { L, m } = ms.logicalOf(row.path);
      if (L !== F && within(L, F)) out.push(project(row, L, m));
    }
    return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }
}
