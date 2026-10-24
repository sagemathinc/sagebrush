// The view of a large confirmed move (design/sync-client.md D11 r4 §3, r5–r7, r8 notes v2): once the confirmed index
// has the move (sync-confirmed.ts drains its record), the view of the moved subtree is replayed, a page at a time,
// from a durable marker (`sync:<ns>:replay`), with every later confirmed page waiting for it:
//
//   pass      the moved confirmed subtree walked in key order, 100 identities a transaction: each identity's view
//             computed as applyView computes it, nothing written to the entries but the plan: every large lift (a
//             folder whose view moves it, with more than D11.chunk entries), each a mapping, fenced in the
//             transaction that observes it (r6 §2, r8 N1).  The sender is paused from here to the publication (N1:
//             at most D11.pauseMs), and its intent revision recorded.
//   close     (r8 N8 v3) every mapping's target settled against what is carried there after the plan: occupants
//             planned, free `name (k)`s chosen, from a durable worklist in rounds, until a round adds nothing and
//             frees no name; bounded by D11.closure*, else stable
//   validate  every mapping's top, D11.validatePage a transaction: its local path, its view and its occupancy as the
//             pass found them, else the plan fails (stable, told: its inputs were fenced and paused, so a difference
//             is a fault)
//   publish   one transaction: the intent revision unchanged, the plan published (sweep 1); the sender resumes
//   sweep     sweep 1: each planned row from its source to its mapping's staging range; sweep 2: from there to its
//             destination, a top with its view's fields and its one server op logged with it (N3); 1,000 rows a page
//   place     the moved subtree walked again, 100 identities a transaction, each page today's applyView: nothing it
//             would still lift large is lifted (a debt, replayed after as the next logical move, r6 §3)
//
// One logical move: from the confirmed publication, at most D11.deadlineMs (r6 §4): past it before the plan's
// publication, the plan is dropped and the replay stops, late (stable, told); after it, it finishes, marked late.
import type { Entry, Op, Workspace } from "./api";
import { inTx, req, hex } from "./db";
import { TRASH, join, parentOf, splitExt, nameOf } from "./paths";
import { D11, RW, MAPS, MapSet, mapKey, queueKey, stageOf, under, nkeyOf, entriesOf, recordOf, dropView, FENCE_READ, type ERecord, type Mapping } from "./sync-rewrite";
import { genKey, genPrefix, idbStore, crecordKey, ledgerNs, againNs } from "./sync-confirmed";
import { VIEW_STORES, applyView, viewer, noteListed, type ListedWhy, type Viewer } from "./sync-view";
import { capNow } from "./sync-pins";
import { intentRevKey } from "./sync-outbox";
import type { SyncEntry } from "./sync-reduce";

const keyOf = (p: string) => p.normalize("NFC");
const META = "meta";
export const markerKey = (ns: string) => `sync:${ns}:replay`;
/** The latest replay that finished past its deadline (r6 §4: late, a stable reported state). */
export const lateKey = (ns: string) => `sync:${ns}:replayLate`;
const debtKey = (ns: string, i: number) => `sync:${ns}:debt:${String(i).padStart(4, "0")}`;
const debtRange = (ns: string) => IDBKeyRange.bound(`sync:${ns}:debt:`, `sync:${ns}:debt;`, false, true);
const moreDebtsKey = (ns: string) => `sync:${ns}:moreDebts`;
/** The whole generation, as a replay's range (the "more debts" marker's) */
const ALL = "/";

export type Phase = "pass" | "close" | "validate" | "sweep" | "place" | "forget" | "again";
/** The phases before a plan's publication: the sender paused, a failure drops the plan. */
const beforePublication = (p: Phase) => p === "pass" || p === "close" || p === "validate";
export type Marker = {
  gen: string;
  rid: string;
  /** "move": a large confirmed move's view; "debts": the lifts its placement (or a rebuild's view) left; "forget":
   * a large forget's view, from its ledger (N6) */
  kind: "move" | "debts" | "forget";
  /** the confirmed subtrees replayed: each its top's key in `gen` (the exact top and its descendants, r5 §1) */
  ranges: string[];
  phase: Phase;
  start: number;
  deadline: number;
  /** the walk's position (pass, and again placement): the range, and the last key taken in it */
  pos?: { ri: number; key?: string };
  /** validation's next mapping */
  vi?: number;
  /** the sender's intent revision when the pass began */
  rev0?: number;
  /** the tops a plan put beside an occupant that stays, at a free `name (k)`, or left where they are carried (their
   * view's folder not a folder, no-folder): [identity, path, its view's path] (at publication) */
  settled?: [string, string, string?][];
  /** placement's deferred ranges (debts recorded, r4 §4's skip) */
  deferred?: string[];
  late?: boolean;
  /** stable, told: the pages held until the person reloads (which tries once more) or deletes the synced data */
  failed?: string;
  /** a page's consecutive failures */
  fails?: number;
  /** ms spent in each component, and the sender's pause (the fixture's composition) */
  times?: Partial<Record<Phase | "pause", number>>;
  /** (r8 N7) rows moved by sweep 1: directly (D, once) and to staging (S, then again): the sweeps' bound is
   * 300 s × (D + 2S) / (D + S) */
  moved?: { D: number; S: number };
  /** (r8 N8) the settled closure's figures: its rounds, items, every request and row its transactions read (their state
   * included) and their writes, one item's most requests and rows, one transaction's (its work's, and all of it), its
   * transactions, and the items that waited for the next transaction */
  closure?: { rounds: number; items: number; requests: number; rows: number; maxReq: number; maxRows: number; txReq: number; txRows: number; allTxReq: number; allTxRows: number; writes: number; txWrites: number; txs: number; waits: number };
  /** (LIMIT-D11-IMPL-3) validation's figures so far: its transactions, every request, row and write of them, and one
   * transaction's most (its work's, and all of it) */
  validation?: { txs: number; requests: number; rows: number; writes: number; txReq: number; txRows: number; allTxReq: number; allTxRows: number };
  /** sweep 2's next mapping (the ones before it drained: a staging range isn't refilled once sweep 2 begins) */
  s2?: number;
  /** placement's pages so far: identities, ops logged, paths listed, debts (the fixtures' figures) */
  placed?: { pages: number; ids: number; ops: number; listed: number; debts: number; walkMs?: number; viewMs?: number; txMs?: number };
};

/** Namespaces whose sender is paused (N1): sync-client.ts's drain sends, scans and drains nothing while set. */
export const SENDER_HOLD = new Set<string>();
/** A replay stopped, stable: its message is the person's. */
export class ReplayHalted extends Error {}
/** (tests) called at a named point of each replay transaction ("pass", "validate", "publish", "sweep1", "sweep2",
 * "place"); throwing there aborts it whole */
export const REPLAY = {
  cut: null as null | ((at: string, m: Marker) => void),
  before: null as null | ((phase: string, m: Marker) => Promise<void>),
  /** (tests) called with a closure or validation transaction as it begins (before its first request) and as it ends
   * (after its last) */
  reads: null as null | ((at: "begin" | "end", phase: "close" | "validate", tx: IDBTransaction) => void),
  /** (tests) as a new page would: the failed replays' one more try available again */
  reload: () => { retried.clear(); validating.clear(); },
};

/** The marker of a large confirmed move's view, written in the publication's transaction (sync-confirmed.ts's onLarge):
 * the moved subtrees, the deadline from now; and the entries' one record reserved for its plan (r3 §3a's both slots:
 * a local large move is refused `busy` until the replay ends). */
export async function startReplay(tx: IDBTransaction, ns: string, gen: string, tops: string[]) {
  const now = Date.now(), rid = hex(8);
  tx.objectStore(META).put({ gen, rid, kind: "move", ranges: tops.map(keyOf), phase: "pass", start: now, deadline: now + D11.deadlineMs, times: {} } satisfies Marker, markerKey(ns));
  FENCE_READ.add(tx);
  tx.objectStore("entries").put({ path: RW, rid, kind: "reserved", published: false, rev: 1, n: 0, fails: 0, at: now } satisfies ERecord);
  dropView(tx);
}

/** (N6) the marker of a large forget's view, in its publication's transaction: replayed from its ledger once the
 * confirmed rewrite has made every row gone (producer-complete). */
export function startForget(tx: IDBTransaction, ns: string, gen: string) {
  const now = Date.now();
  tx.objectStore(META).put({ gen, rid: hex(8), kind: "forget", ranges: [], phase: "forget", start: now, deadline: now + D11.deadlineMs, times: {} } satisfies Marker, markerKey(ns));
}

/** Whether a replay is pending for `ns` (a barrier: later confirmed pages, and the rebuild's stage, wait for it). */
export async function replayOf(w: Workspace, ns: string): Promise<Marker | undefined> {
  return inTx(w.ws, META, "readonly", (tx) => req(tx.objectStore(META).get(markerKey(ns)))) as Promise<Marker | undefined>;
}

/** The confirmed subtrees in key order from the marker's position: at most `n` rows, the position after them. */
async function walk(tx: IDBTransaction, m: Marker, pos: { ri: number; key?: string } | undefined, n: number, skip?: (row: SyncEntry & { key: string }) => boolean, bulk = 0): Promise<{ rows: (SyncEntry & { key: string })[]; pos: { ri: number; key?: string }; done: boolean }> {
  const ix = tx.objectStore("syncIndex").index("byKey");
  let ri = pos?.ri ?? 0, key = pos?.key, read = 0;
  const out: (SyncEntry & { key: string })[] = [];
  // (`bulk`: rows skipped are read up to that many a request (the pass's files: only folders can be large lifts),
  // at most WALK_READ rows a page in all, the position the last row taken or passed over)
  while (out.length < n && ri < m.ranges.length && read < WALK_READ) {
    const T = m.ranges[ri];
    if (key === undefined && T !== ALL) {
      const top = (await req(ix.get([m.gen, T]))) as (SyncEntry & { key: string }) | undefined;
      if (top && !skip?.(top)) out.push(top);
      key = T;
      continue;
    }
    const lo = T === ALL ? (key === undefined ? [m.gen, "/"] : [m.gen, key]) : key === T ? [m.gen, T + "/"] : [m.gen, key];
    const open = T === ALL ? key !== undefined : key !== T;
    const hi = T === ALL ? [m.gen, "0"] : [m.gen, T + "0"];
    const want = Math.max(n - out.length, bulk);
    const rows = (await req(ix.getAll(IDBKeyRange.bound(lo, hi, open, true), want))) as (SyncEntry & { key: string })[];
    read += rows.length;
    let cut = rows.length;
    for (let i = 0; i < rows.length; i++) {
      if (skip?.(rows[i])) continue;
      out.push(rows[i]);
      if (out.length >= n) { cut = i + 1; break; }
    }
    if (cut === rows.length && rows.length < want) {
      ri++;
      key = undefined;
    } else key = rows[cut - 1].key;
  }
  return { rows: out, pos: { ri, ...(key !== undefined ? { key } : {}) }, done: ri >= m.ranges.length };
}
/** A walk's rows as the view's confirmed entries (no record of the generation is pending: producer-complete). */
const confirmedRows = (rows: (SyncEntry & { key: string })[]) => new Map(rows.map((r) => { const { ns: _n, key: _k, parentKey: _p, ...e } = r as SyncEntry & { ns?: string; key: string; parentKey?: string }; return [r.id, e as SyncEntry]; }));
/** Rows a walk page reads at most (its skipped rows included): 10 requests of the pass's bulk reads. */
const WALK_READ = 10_000;

/** The marker read and checked in a page's transaction: still `rid`'s, of the active generation (a rebuild's `done`
 * supersedes it), in phase `phase`. */
async function marker(tx: IDBTransaction, ns: string, rid: string, phase: Phase): Promise<Marker | undefined> {
  const meta = tx.objectStore(META), m = (await req(meta.get(markerKey(ns)))) as Marker | undefined;
  if (!m || m.rid !== rid || m.phase !== phase || m.failed) return undefined;
  const gen = genPrefix(ns, ((await req(meta.get(genKey(ns)))) as number | undefined) ?? 0);
  // (producer-complete: the confirmed move's rewrite drained first, checked here too (a crash, a reload, a second tab))
  if (m.gen !== gen || (await req(meta.getKey(crecordKey(gen)))) !== undefined) return undefined;
  return m;
}

// ---- the plan (r5 §2, r6, r7, r8 N1/N3/N8)

class Cap extends Error {}
type PlanCtx = { V: Viewer; st: IDBObjectStore; maps: Mapping[]; added: Mapping[]; planned: Set<string>; now: number };

const srcOwner = (maps: Mapping[], p: string): Mapping | undefined => {
  let best: Mapping | undefined;
  for (const m of maps) if ((p === m.from || p.startsWith(m.from + "/")) && (!best || m.from.length > best.from.length)) best = m;
  return best;
};

/** The op a top's move is logged as (applyView's choice). */
const opOf = (e: Entry, v: SyncEntry): Mapping["op"] => (v.trashed && !e.trashed ? "remove" : !v.trashed && e.trashed ? "restore" : "rename");

async function countUnder(st: IDBObjectStore, p: string): Promise<number> {
  return (await req(st.count(under(p)))) as number;
}

/** A mapping for `e`'s lift to its view `v` (its target the view's path until the closure decides, N8), within the
 * plan's caps; none if the view's folder won't be there after the plan (placement's to list, as today: no-folder). */
function newMapping(maps: Mapping[], e: Entry, v: SyncEntry, large: boolean, now: number): Mapping | undefined {
  const nLarge = maps.filter((m) => m.large).length, nSmall = maps.length - nLarge;
  if (large ? nLarge + 1 > D11.large : nSmall + 1 > D11.small) throw new Cap(`too many large moves at once (more than ${D11.large} large folders or ${D11.small} entries in their way): reload to try again, or Delete my synced data`);
  return {
    i: maps.length, from: e.path, to: v.path, want: v.path, top: e.ident, large, kind: e.kind, op: opOf(e, v), was: e.path,
    trashed: v.trashed ? { from: v.trashed.from, at: v.trashed.at } : null, updated: now, t: 0, wit: null, occ: null,
  };
}

/** (CORR-D11-IMPL-2) Whether `p`'s folder is a folder after the plan: brought by the mapping whose target holds it
 * most specifically (that mapping's top, or the row it carries there from its source), else the row there now if
 * nothing moves it away. */
async function folderAfter(st: IDBObjectStore, maps: Mapping[], p: string): Promise<boolean> {
  const pf = parentOf(p);
  if (pf === "/" || pf === TRASH) return true;
  let by: Mapping | undefined;
  for (const m of maps) if (holds(pf, m.to) && (!by || m.to.length > by.to.length)) by = m;
  if (by && pf === by.to) return by.kind === "folder";
  const at = by ? by.from + pf.slice(by.to.length) : pf;
  if (by ? srcOwner(maps, at) !== by : !!srcOwner(maps, at)) return false;
  return ((await req(st.get(at))) as Entry | undefined)?.kind === "folder";
}

/** (CORR-D11-R1-1) Whether anything will be at `p`'s folder after the plan (of any kind): there now and not moving
 * away, or brought by a planned mapping.  Nothing there: the view's folder is still to be made (placement makes a
 * confirmed folder this device hasn't), so the lift is left to placement, a debt replayed once its folder is there. */
async function parentThere(st: IDBObjectStore, maps: Mapping[], p: string): Promise<boolean> {
  const pf = parentOf(p);
  if (pf === "/" || pf === TRASH || maps.some((m) => holds(pf, m.to))) return true;
  return !!(await req(st.get(pf))) && !srcOwner(maps, pf);
}

/** One identity of the pass: a large lift planned, unless it is carried by a planned folder, or its folder is still to
 * be made (left to placement).  (Whether a folder that is there will be a folder is the closure's: one that won't stays
 * where it is carried, CORR-D11-IMPL-2.) */
async function planOne(ctx: PlanCtx, id: string) {
  if (ctx.planned.has(id)) return;
  const e = await ctx.V.entryOf(id);
  if (!e || e.kind !== "folder") return;
  const { v } = await ctx.V.viewOf(id, e);
  if (v.kind !== "entry" || v.e.path === e.path) return;
  // (carried: where a planned folder takes it is its view)
  const up = srcOwner(ctx.maps, parentOf(e.path));
  if (up && up.from !== e.path && (up.want ?? up.to) + e.path.slice(up.from.length) === v.e.path) return;
  if ((await countUnder(ctx.st, e.path)) <= D11.chunk) return;
  if (!(await parentThere(ctx.st, ctx.maps, v.e.path))) return;
  const m = newMapping(ctx.maps, e, v.e, true, ctx.now)!;
  ctx.maps.push(m);
  ctx.added.push(m);
  if (e.ident) ctx.planned.add(e.ident);
}

// -- the closure (r8 N8 v3): every target settled against what is carried there, before validation

/** An unpublished plan's closure state (its control row): the worklist (mapping indices), the round, whether this
 * round added a mapping or saw a name come free, and the counters of all its rounds (every request and row its
 * transactions' metered reads made, an item that waited for the next transaction included). */
type Queue = { path: string; round: number; queue: number[]; added: boolean; unsettled: boolean; items: number; requests: number; rows: number; maxReq?: number; maxRows?: number; txReq?: number; txRows?: number; allTxReq?: number; allTxRows?: number; writes?: number; txWrites?: number; txs?: number; waits?: number };
/** A claimant of a key: another mapping's top (by its target), or a row carried there (`at`). */
type Claimant = { map: number } | { row: Entry; at: string };

// (LIMIT-D11-IMPL-1/2/3) A closure or validation transaction metered at the IndexedDB boundary, from its first request
// to its last: every request it makes (its own and its viewer's) goes through a Meter's stores.  Its state (the marker,
// the record, the closure's control row, the mapping rows) is read first, within PLAN_STATE; its work then, each
// request admitted before it is made against what is left of the transaction's D11.requests and D11.page; every read
// against what is left of the plan's closureRequests and closureRows (the closure's).  No read materializes more rows
// than are left (one that could is made for what is left, then counted: more is over).  Writes are counted.

/** (LIMIT-D11-IMPL-3) A closure or validation transaction's own state, read before its work, at most: the marker (3
 * requests), the record and the closure's control row, every mapping row (one request), the intent revision at
 * publication; its rows bounded by the plan's size (D11.large + D11.small mappings), not by its work's budget.  Its
 * writes, after its work: each mapping row at most once, the control row, the record and the marker. */
export const PLAN_STATE = {
  requests: 8,
  rows: () => D11.large + D11.small + 6,
  writes: () => D11.large + D11.small + 4,
};

/** A read the budget doesn't admit, not made: "tx", the transaction's work budget (the item waits for the next one);
 * "plan", the plan's; "state", PLAN_STATE. */
class Over extends Error {
  constructor(readonly of: "tx" | "plan" | "state") {
    super(`over the ${of === "tx" ? "transaction's" : of === "plan" ? "plan's" : "plan state's"} reads`);
  }
  get tx() {
    return this.of === "tx";
  }
}
/** A request answered by `p`, as `req` waits on one (its onsuccess and result, or its onerror and error). */
function answered<T>(p: Promise<T>): IDBRequest<T> {
  const r = { result: undefined as T | undefined, error: null as unknown, onsuccess: null as null | (() => void), onerror: null as null | (() => void) };
  p.then((v) => { r.result = v; r.onsuccess?.(); }, (e) => { r.error = e; r.onerror?.(); });
  return r as unknown as IDBRequest<T>;
}
type Query = IDBValidKey | IDBKeyRange | null | undefined;
class Meter {
  /** every request made and row read in this transaction; its work's; its writes */
  req = 0;
  rows = 0;
  workReq = 0;
  workRows = 0;
  writes = 0;
  /** reading the transaction's state (PLAN_STATE), not yet its work */
  state = true;
  /** the plan's reads left (the closure's), from this transaction's start */
  allReq = Infinity;
  allRows = Infinity;
  constructor(private txReq: number, private txRows: number) {}
  private admit() {
    if (this.req + 1 > this.allReq) throw new Over("plan");
    if (this.state ? this.req - this.workReq + 1 > PLAN_STATE.requests : this.workReq + 1 > this.txReq) throw new Over(this.state ? "state" : "tx");
    this.req++;
    if (!this.state) this.workReq++;
  }
  private charge(n: number) {
    this.rows += n;
    if (!this.state) this.workRows += n;
  }
  /** a read of at most `max` rows (`get`: one row or none) */
  private async read(t: IDBObjectStore | IDBIndex, how: "get" | "getAll" | "getAllKeys", q: Query, max: number): Promise<unknown> {
    const a = this.state ? PLAN_STATE.rows() - (this.rows - this.workRows) : this.txRows - this.workRows, b = this.allRows - this.rows;
    const left = Math.min(a, b), of = b <= a ? "plan" : this.state ? "state" : "tx";
    const take = Math.min(max, left);
    let got: unknown = how === "get" ? undefined : [], n = 0;
    if (take > 0) {
      this.admit();
      got = await req(how === "get" ? t.get(q as IDBValidKey) : t[how](q, take === Infinity ? undefined : take));
      n = how === "get" ? (got === undefined ? 0 : 1) : (got as unknown[]).length;
      this.charge(n);
      if (take === max || n < take) return got;
    }
    // (as many rows as are left read: whether there are more, counted (a request, no row))
    this.admit();
    if (Math.min((await req(t.count(q ?? undefined))) as number, max) > n) throw new Over(of);
    return got;
  }
  private wrap<T extends IDBObjectStore | IDBIndex>(s: T): T {
    const self = this;
    return new Proxy(s, {
      get(t, k) {
        if (k === "get") return (q: Query) => answered(self.read(t, "get", q, 1));
        if (k === "getAll" || k === "getAllKeys") return (q?: Query, n?: number) => answered(self.read(t, k, q, n ? n : Infinity));
        if (k === "count" || k === "getKey") return (q?: Query) => answered((async () => { self.admit(); return req((k === "count" ? t.count(q ?? undefined) : t.getKey(q as IDBValidKey)) as IDBRequest<unknown>); })());
        if (k === "index") return (name: string) => self.wrap((t as IDBObjectStore).index(name));
        if (k === "put" || k === "add" || k === "delete" || k === "clear") return (...a: unknown[]) => { self.writes++; return (t as unknown as Record<string, (...x: unknown[]) => unknown>)[k](...a); };
        if (k === "openCursor" || k === "openKeyCursor") return () => { throw new Error(`sync: a metered read can't ${k}`); };
        const v = Reflect.get(t, k, t);
        return typeof v === "function" ? v.bind(t) : v;
      },
    }) as T;
  }
  /** `tx` with every request on its stores metered */
  tx(tx: IDBTransaction): IDBTransaction {
    const self = this;
    return new Proxy(tx, {
      get(t, k) {
        if (k === "objectStore") return (name: string) => self.wrap(t.objectStore(name));
        const v = Reflect.get(t, k, t);
        return typeof v === "function" ? v.bind(t) : v;
      },
    }) as IDBTransaction;
  }
}

const holds = (F: string, t: string) => F === t || F.startsWith(t + "/");
/** nkeyOf, remembered (the closure asks for the same targets' keys many times; at most 20,000 kept) */
const nkMemo = new Map<string, string>();
const nk = (p: string) => {
  let v = nkMemo.get(p);
  if (v === undefined) {
    if (nkMemo.size >= 20_000) nkMemo.clear();
    nkMemo.set(p, (v = nkeyOf(p)));
  }
  return v;
};
const depth = (p: string) => p.split("/").length;
/** A mapping whose view's folder isn't a folder after the plan (CORR-D11-IMPL-2): `t` -1, its top staying where it
 * is carried, listed no-folder (applyView's outcome for a move whose folder isn't there). */
const NO_FOLDER = -1;
const noFolder = (m: Mapping) => m.t === NO_FOLDER;
/** Precedence among mappings claiming one key: the first view in confirmed key order, then by identity. */
const before = (a: Mapping, b: Mapping) => {
  const x = keyOf(a.want ?? a.to), y = keyOf(b.want ?? b.to);
  if (x !== y) return x < y;
  return (a.top ?? "") !== (b.top ?? "") ? (a.top ?? "") < (b.top ?? "") : a.i < b.i;
};
/** Whether `a`'s claim beats `b`'s: a top staying where it is carried (no-folder) can go nowhere else. */
const beats = (a: Mapping, b: Mapping) => noFolder(a) || before(a, b);
/** Candidate `c` of `m`'s target: its view's path, then freePath's names beside it. */
function candidate(m: Mapping, c: number): string {
  if (c === 0) return m.want ?? m.to;
  const [b, ext] = splitExt(nameOf(m.want!));
  return join(parentOf(m.want!), `${b} (${c + 1})${ext}`);
}
/** Where `m`'s top is carried if it doesn't move on its own: by the mapping whose source holds its source most
 * specifically, else where it is. */
function carried(maps: Mapping[], m: Mapping): string {
  let up: Mapping | undefined;
  for (const x of maps) if (x !== m && m.from.startsWith(x.from + "/") && (!up || x.from.length > up.from.length)) up = x;
  return up ? up.to + m.from.slice(up.from.length) : m.from;
}
function destIndex(maps: Mapping[]): Map<string, number[]> {
  const d = new Map<string, number[]>();
  for (const m of maps) d.set(nk(m.to), [...(d.get(nk(m.to)) ?? []), m.i]);
  return d;
}

/** A lookalike group, whole (r8 N8 v3: every name of one NFC form in one folder, legacy groups included), or the
 * stable failure if it has more than D11.lookalikes rows: a truncated group is never an answer. */
async function group(st: IDBObjectStore, key: string): Promise<Entry[]> {
  const rows = (await req(st.index("byNfc").getAll(IDBKeyRange.only(key), D11.lookalikes + 1))) as Entry[];
  if (rows.length > D11.lookalikes) throw new Cap(`more than ${D11.lookalikes} names that look the same as "${key.slice(key.indexOf("\u0000") + 1)}" in one folder: reload to try again, or Delete my synced data`);
  return rows;
}

/** Who claims the key of `C` besides mapping `k` after the plan (N8 v3 §2): other mappings' tops by their targets,
 * rows no planned source owns (staying put), and rows each target holding C's folder (itself or an ancestor)
 * carries there from its source; ownership after the whole group is read, `k`'s own rows never. */
async function claim(st: IDBObjectStore, maps: Mapping[], dest: Map<string, number[]>, C: string, k: number): Promise<Claimant[]> {
  const key = nk(C), F = parentOf(C), name = nameOf(C);
  const out: Claimant[] = [], seen = new Set<string>();
  for (const j of dest.get(key) ?? []) if (j !== k) out.push({ map: j });
  for (const r of await group(st, key)) {
    if (seen.has(r.path) || srcOwner(maps, r.path)) continue;
    seen.add(r.path);
    out.push({ row: r, at: r.path });
  }
  for (const j of maps) {
    if (j.i === k || !holds(F, j.to)) continue;
    const P = j.from + F.slice(j.to.length);
    for (const r of await group(st, nk(join(P, name)))) {
      if (seen.has(r.path) || srcOwner(maps, r.path) !== j) continue;
      seen.add(r.path);
      out.push({ row: r, at: j.to + r.path.slice(j.from.length) });
    }
  }
  return out;
}

/** Where `r`'s own view moves it, if it moves from `at` (where it is carried); undefined: it stays. */
async function movesTo(V: Viewer, r: Entry, at: string): Promise<SyncEntry | undefined> {
  if (!r.ident) return undefined;
  const { v } = await V.viewOf(r.ident, r);
  return v.kind === "entry" && keyOf(v.e.path) !== keyOf(at) ? v.e : undefined;
}

type CloseCtx = { V: Viewer; st: IDBObjectStore; maps: Mapping[]; dest: Map<string, number[]>; now: number };
type ItemResult = { added: Mapping[]; moved?: { from: string; to: string }; vacate: boolean };

/** One item of the closure (N8 v3 §3): `k`'s first candidate with no winning claimant but itself; at its view's name,
 * a claimant whose own view moves it gets its mapping (an occupant, r5) and is no winner.  A target whose folder
 * isn't a folder after the plan has no candidate: its top stays where it is carried (CORR-D11-IMPL-2). */
async function closeItem(c: CloseCtx, k: number): Promise<ItemResult> {
  const m = c.maps[k], added: Mapping[] = [];
  if (!(await folderAfter(c.st, c.maps, m.want!))) return stays(c, k);
  let chosen = -1, wit: Mapping["wit"] = null;
  for (let t = 0; t < D11.freeNames && chosen < 0; t++) {
    const C = candidate(m, t);
    let win: Mapping["wit"] = null;
    for (const x of await claim(c.st, c.maps, c.dest, C, k)) {
      if ("map" in x) {
        const j = c.maps[x.map];
        if (beats(j, m)) { win = { map: j.i, at: j.to, src: j.from }; break; }
        continue;
      }
      const r = x.row;
      if (t === 0) {
        const v = await movesTo(c.V, r, x.at);
        if (v && (await folderAfter(c.st, c.maps, v.path))) {
          const large = r.kind === "folder" && (await countUnder(c.st, r.path)) > D11.chunk;
          const o = newMapping(c.maps, r, v, large, c.now)!;
          c.maps.push(o);
          c.dest.set(nk(o.to), [...(c.dest.get(nk(o.to)) ?? []), o.i]);
          added.push(o);
          continue;
        }
      }
      win = { id: r.ident ?? null, at: x.at, src: r.path };
      break;
    }
    if (!win) chosen = t;
    else if (t === 0) wit = win;
  }
  if (chosen < 0) throw new Cap(`no free name beside ${m.want} within ${D11.freeNames} names: reload to try again, or Delete my synced data`);
  const t0 = m.t ?? 0;
  // (a name came free: this round isn't settled; the target isn't lowered in it)
  if (chosen < t0) return { added, vacate: true };
  const to = candidate(m, chosen), from = m.to;
  m.t = chosen;
  m.wit = chosen ? wit : null;
  m.occ = chosen ? (wit!.id ?? wit!.src) : null;
  if (to === from) return { added, vacate: false };
  m.to = to;
  c.dest = destIndex(c.maps);
  return { added, moved: { from, to }, vacate: false };
}
/** `k`'s top staying where it is carried (no-folder): nothing else may claim that place (a mapping there moves on:
 * this one beats it; a row there, a lookalike in its own folder, is the stable failure). */
async function stays(c: CloseCtx, k: number): Promise<ItemResult> {
  const m = c.maps[k], to = carried(c.maps, m), from = m.to;
  if ((await claim(c.st, c.maps, c.dest, to, k)).some((x) => !("map" in x) || noFolder(c.maps[x.map]))) throw new Cap(`${m.want}'s folder won't be a folder, and ${to} is taken: reload to try again, or Delete my synced data`);
  m.t = NO_FOLDER;
  m.wit = null;
  m.occ = null;
  if (to === from) return { added: [], vacate: false };
  m.to = to;
  c.dest = destIndex(c.maps);
  return { added: [], moved: { from, to }, vacate: false };
}

/** The items a change makes due again (N8 v3 §3.3), from the mapping rows alone. */
function affected(maps: Mapping[], k: number, r: ItemResult): number[] {
  const out = new Set<number>();
  const under = (p: string, t: string) => p === t || p.startsWith(t + "/");
  // (a target's folder: the one its view names, where a change can make it a folder or not)
  const folder = (j: Mapping) => parentOf(j.want ?? j.to);
  for (const a of r.added) {
    out.add(a.i);
    const was = carried(maps, a);
    for (const j of maps) if (j.i !== a.i && (under(j.to, a.to) || nk(j.to) === nk(a.to) || (j.wit && under(j.wit.src, a.from)) || under(folder(j), a.to) || under(folder(j), was))) out.add(j.i);
  }
  if (r.moved) {
    const { from, to } = r.moved;
    // (and what is under its target, where its folder is: whether that is a folder after the plan may change)
    for (const j of maps) if (j.i !== k && (j.to.startsWith(from + "/") || j.to.startsWith(to + "/") || nk(j.to) === nk(to) || j.wit?.map === k || under(folder(j), from) || under(folder(j), to))) out.add(j.i);
  }
  return [...out];
}

/** The settled plan's check (validation, N8 v3 §6): source and view as planned; its folder a folder after the plan
 * (else it stays where it is carried); at its target no claimant but itself; beside a claimant, the one that decided
 * it (still staying) still at its view's name.  The same claimant query as the closure's, over the final mappings. */
async function checkOne(V: Viewer, st: IDBObjectStore, maps: Mapping[], dest: Map<string, number[]>, m: Mapping): Promise<string | undefined> {
  const e = m.top ? await V.entryOf(m.top) : undefined;
  if (!e || e.path !== m.from) return `${m.from} moved since it was planned`;
  const { v } = await V.viewOf(m.top!, e);
  if (v.kind !== "entry" || v.e.path !== m.want) return `${m.from}'s view changed since it was planned`;
  if (noFolder(m)) {
    if (m.to !== carried(maps, m) || (await folderAfter(st, maps, m.want!))) return `the folder of ${m.want} changed since it was planned`;
  } else if (!(await folderAfter(st, maps, m.to))) return `the folder of ${m.to} won't be a folder after the plan`;
  if ((await claim(st, maps, dest, m.to, m.i)).length) return `what is at ${m.to} changed since it was planned`;
  if (m.to === m.want || noFolder(m)) return undefined;
  const w = m.wit;
  const at = w ? await claim(st, maps, dest, m.want!, m.i) : [];
  const still = w && at.some((x) => ("map" in x ? x.map === w.map && beats(maps[x.map], m) : w.map === undefined && x.row.path === w.src));
  if (!still) return `what is at ${m.want} changed since it was planned`;
  if (w!.map === undefined) {
    const r = at.find((x) => !("map" in x) && x.row.path === w!.src) as { row: Entry; at: string };
    if (await movesTo(V, r.row, r.at)) return `what is at ${m.want} changed since it was planned`;
  }
  return undefined;
}

/** r8 N7: whether mapping `m` touches no other mapping (none of its prefixes the same as, an ancestor or a descendant
 * of another's, by whole path components) and has no occupant: then it moves directly, never through staging. */
function directOf(maps: Mapping[], m: Mapping, index: { set: Map<string, number[]>; sorted: string[] }): boolean {
  if (m.to !== (m.want ?? m.to) || (m.occ ?? null) !== null) return false;
  for (const x of [m.from, m.to]) {
    for (let a = x; a !== "/" && a.startsWith("/"); a = parentOf(a)) if ((index.set.get(a) ?? []).some((i) => i !== m.i)) return false;
    const lo = x + "/";
    let i = 0, j = index.sorted.length;
    while (i < j) { const k = (i + j) >> 1; if (index.sorted[k] < lo) i = k + 1; else j = k; }
    for (; i < index.sorted.length && index.sorted[i].startsWith(lo); i++) if ((index.set.get(index.sorted[i]) ?? []).some((o) => o !== m.i)) return false;
  }
  return true;
}
function prefixIndex(maps: Mapping[]) {
  const set = new Map<string, number[]>();
  for (const m of maps) for (const p of [m.from, m.to]) set.set(p, [...(set.get(p) ?? []), m.i]);
  return { set, sorted: [...set.keys()].sort() };
}

// ---- the driver

const yieldNow = () => new Promise<void>((ok) => setTimeout(ok, 0));
/** Replays tried once more at this page's start (a failed or late one: a reload tries once). */
const retried = new Set<string>();

/**
 * The pending replay of `ns` driven to its end (the client's onIndex, before any later page): returns when there is
 * none; throws ReplayHalted when it is stopped (failed, or late before its publication), the pages held.
 */
export async function runReplay(w: Workspace, ns: string): Promise<void> {
  // (one driver a namespace in this page: a second caller waits for the first, then looks again)
  for (;;) {
    const cur = driving.get(ns);
    if (!cur) break;
    await cur.catch(() => {});
  }
  const run = drive(w, ns);
  driving.set(ns, run);
  try {
    await run;
  } finally {
    if (driving.get(ns) === run) driving.delete(ns);
  }
}
const driving = new Map<string, Promise<void>>();
/** Plans whose validation began in this page (one begun before it is done again from its start). */
const validating = new Set<string>();

async function drive(w: Workspace, ns: string): Promise<void> {
  if (!(await replayOf(w, ns))) return;
  const cap = await capNow();
  let ran = false;
  for (;;) {
    let m = await replayOf(w, ns);
    if (!m) {
      // (the replay's pages didn't publish the durability witness one by one (it recounts every entry): once now)
      if (ran) await w.locked(async () => {}, undefined, { internal: true, publish: true }).catch(() => {});
      return;
    }
    ran = true;
    if (m.failed) {
      if (retried.has(m.rid)) throw new ReplayHalted(m.failed);
      retried.add(m.rid);
      m = await restart(w, ns, m);
      continue;
    }
    if (REPLAY.before) await REPLAY.before(m.phase, m);
    // (the deadline (r6 §4): past it before the publication, the plan dropped and the replay stopped, late; after it,
    // finished, marked late)
    if (Date.now() > m.deadline && !m.late) {
      const pre = beforePublication(m.phase);
      if (pre) retried.add(m.rid);
      await setMarker(w, ns, m.rid, (x) => ({ ...x, late: true, ...(pre ? { failed: `the view of a large move is late (past ${Math.round(D11.deadlineMs / 1000)} s): reload to try again, or Delete my synced data` } : {}) }), pre);
      continue;
    }
    // (the sender's pause at most D11.pauseMs (N1, N8 v3 §5): past it, the plan dropped, stable)
    if (beforePublication(m.phase) && (m.times?.pause ?? 0) > D11.pauseMs) {
      retried.add(m.rid);
      await setMarker(w, ns, m.rid, (x) => ({ ...x, failed: `the view of a large move took longer to plan than its pause (${Math.round(D11.pauseMs / 1000)} s): reload to try again, or Delete my synced data` }), true);
      continue;
    }
    // (a validation begun before this page isn't taken as fresh (N8 v3 §7): from its first mapping again)
    if (m.phase === "validate" && (m.vi ?? 0) > 0 && !validating.has(m.rid)) {
      await setMarker(w, ns, m.rid, (x) => ({ ...x, vi: 0 }), false);
      validating.add(m.rid);
      continue;
    }
    if (m.phase === "validate") validating.add(m.rid);
    const t0 = Date.now();
    let r: "more" | "next";
    try {
      if (beforePublication(m.phase)) SENDER_HOLD.add(ns);
      r = await step(w, ns, m, cap);
    } catch (e) {
      if (e instanceof ReplayHalted) throw e;
      const failed = e instanceof Cap ? e.message : undefined;
      const fails = (m.fails ?? 0) + 1;
      const msg = failed ?? (fails >= D11.fails ? `the view of a large move couldn't be applied here: ${String((e as Error)?.message ?? e).slice(0, 200)} (reload to try again, or Delete my synced data)` : undefined);
      console.warn("sync: a large move's view:", e);
      if (msg) retried.add(m.rid);
      await setMarker(w, ns, m.rid, (x) => ({ ...x, fails, ...(msg ? { failed: msg } : {}) }), !!msg && beforePublication(m.phase));
      if (!msg) await new Promise((ok) => setTimeout(ok, Math.min(D11.backoffMax, D11.backoffMin * 2 ** (fails - 1))));
      continue;
    }
    const dt = Date.now() - t0;
    await setMarker(w, ns, m.rid, (x) => ({ ...x, fails: 0, times: { ...x.times, [m!.phase]: (x.times?.[m!.phase] ?? 0) + dt, ...(beforePublication(m!.phase) ? { pause: (x.times?.pause ?? 0) + dt } : {}) } }), false).catch(() => {});
    // (its page found it not yet its turn (the confirmed rewrite not drained: not producer-complete, N6 addendum 1),
    // or superseded: stopped here; whoever drains the rewrite drives it on after)
    if (r === "next") return;
    await yieldNow();
  }
}

/** The marker changed (if still `rid`'s); `dropPlan`: an unpublished plan dropped with it (nothing visible changes). */
async function setMarker(w: Workspace, ns: string, rid: string, f: (m: Marker) => Marker, dropPlan: boolean) {
  await inTx(w.ws, ["entries", META], "readwrite", async (tx) => {
    const meta = tx.objectStore(META), m = (await req(meta.get(markerKey(ns)))) as Marker | undefined;
    if (!m || m.rid !== rid) return;
    const n = f(m);
    meta.put(n, markerKey(ns));
    if (dropPlan) {
      FENCE_READ.add(tx);
      const st = tx.objectStore("entries"), rec = (await req(st.get(RW))) as ERecord | undefined;
      if (rec && rec.rid === rid && !rec.published) {
        st.delete(IDBKeyRange.bound(`${MAPS}${rid}/`, `${MAPS}${rid}0`, false, true));
        st.delete(queueKey(rid));
        st.put({ path: RW, rid, kind: "reserved", published: false, rev: rec.rev + 1, n: 0, fails: 0, at: rec.at } satisfies ERecord);
      }
      SENDER_HOLD.delete(ns);
    }
  });
}

/** A failed replay tried once more (a reload): from its pass, a fresh deadline. */
async function restart(w: Workspace, ns: string, m: Marker): Promise<Marker> {
  const now = Date.now();
  const pre = beforePublication(m.phase);
  const n: Marker = { ...m, phase: pre ? "pass" : m.phase, pos: pre ? undefined : m.pos, vi: undefined, rev0: undefined, settled: pre ? [] : m.settled, failed: undefined, fails: 0, late: undefined, start: now, deadline: now + D11.deadlineMs, ...(pre ? { times: { ...m.times, pause: 0 } } : {}) };
  await inTx(w.ws, META, "readwrite", async (tx) => { tx.objectStore(META).put(n, markerKey(ns)); });
  return n;
}

/** One page of the marker's phase. */
async function step(w: Workspace, ns: string, m0: Marker, cap: number): Promise<"more" | "next"> {
  const rid = m0.rid;
  if (m0.phase === "pass") {
    return w.locked(() => inTx(w.ws, [...new Set([...VIEW_STORES, "syncIndex", META])], "readwrite", async (tx) => {
      const m = await marker(tx, ns, rid, "pass");
      if (!m) return "next";
      const meta = tx.objectStore(META), st = tx.objectStore("entries");
      FENCE_READ.add(tx);
      if (m.rev0 === undefined) m.rev0 = ((await req(meta.get(intentRevKey(ns)))) as number | undefined) ?? 0;
      let rec = (await req(st.get(RW))) as ERecord | undefined;
      if (!rec || rec.rid !== rid) throw new Cap("sync's plan for a large move was taken over: reload to try again");
      if (rec.kind === "reserved") rec = { ...rec, kind: "plan" };
      const { maps } = await recordOf(tx);
      // (only folders can be large lifts: files passed over in bulk, never examined (an occupant is found at its
      // destination, not by this walk))
      const { rows, pos, done } = await walk(tx, m, m.pos, D11.planPage, (r) => r.kind !== "folder", 1000);
      const V = await viewer({ w, tx, ns, store: idbStore(tx, m.gen), cap, prefetch: { ids: rows.map((x) => x.id), prefix: m.gen, rows: confirmedRows(rows) } });
      const ctx: PlanCtx = { V, st, maps: [...maps], added: [], planned: new Set(maps.map((x) => x.top!).filter(Boolean)), now: Date.now() };
      for (const r of rows) await planOne(ctx, r.id);
      REPLAY.cut?.("pass", m);
      // (the mappings found, fenced in this transaction: the record's rows, its revision moved on)
      for (const x of ctx.added) st.put({ path: mapKey(rid, x.i), ...x });
      st.put({ ...rec, n: ctx.maps.length, rev: rec.rev + 1 } satisfies ERecord);
      dropView(tx);
      const next: Marker = { ...m, pos };
      if (done) {
        if (ctx.maps.length) {
          // (the closure next (N8 v3 §3): every mapping due, round 1)
          st.put({ path: queueKey(rid), round: 1, queue: ctx.maps.map((x) => x.i), added: false, unsettled: false, items: 0, requests: 0, rows: 0 } satisfies Queue);
          Object.assign(next, { phase: "close" });
        }
        else {
          // (no large lift: no plan; the sender resumes, and placement walks the subtree from its start)
          st.delete(RW);
          Object.assign(next, { phase: "place", pos: undefined });
          SENDER_HOLD.delete(ns);
        }
      }
      meta.put(next, markerKey(ns));
      return "more";
    }, { durability: "relaxed" }), undefined, { quiet: true });
  }
  if (m0.phase === "close") {
    return w.locked(() => inTx(w.ws, [...new Set([...VIEW_STORES, "syncIndex", META])], "readwrite", async (tx0) => {
      // (the whole transaction metered (LIMIT-D11-IMPL-1/2/3): its state within PLAN_STATE, its work within this
      // transaction's D11.requests and D11.page, all of it within what is left of the plan's closureRequests and
      // closureRows, each request admitted before it is made; its writes counted)
      REPLAY.reads?.("begin", "close", tx0);
      const M = new Meter(D11.requests, D11.page), tx = M.tx(tx0);
      const over = (e: Over) => new Cap(e.of === "tx" ? `sync's plan for a large move needs more than ${D11.requests} requests or ${D11.page} rows for one name: reload to try again, or Delete my synced data` : e.of === "plan" ? `sync's plan for a large move needs more than ${D11.closureRequests} requests or ${D11.closureRows} rows: reload to try again, or Delete my synced data` : `sync's plan for a large move is larger than one transaction reads (${PLAN_STATE.requests} requests, ${PLAN_STATE.rows()} rows): reload to try again, or Delete my synced data`);
      const metered = async <T>(f: () => Promise<T>) => {
        try {
          return await f();
        } catch (e) {
          throw e instanceof Over ? over(e) : e;
        }
      };
      const m = await metered(() => marker(tx, ns, rid, "close"));
      if (!m) return "next";
      const meta = tx.objectStore(META), st = tx.objectStore("entries");
      FENCE_READ.add(tx0);
      const rec = (await metered(() => req(st.get(RW)))) as ERecord | undefined;
      if (!rec || rec.rid !== rid) throw new Cap("sync's plan for a large move was taken over: reload to try again");
      const q = (await metered(() => req(st.get(queueKey(rid))))) as Queue | undefined;
      if (!q) throw new Cap("sync's plan for a large move lost its closure: reload to try again");
      // (what is left of the plan's reads: the closure's so far, from this transaction's start (its state's included))
      M.allReq = D11.closureRequests - q.requests;
      M.allRows = D11.closureRows - q.rows;
      const { maps: rows } = await metered(() => recordOf(tx));
      const maps = rows.map((x) => ({ ...x }));
      M.state = false;
      const V = await metered(() => viewer({ w, tx, ns, store: idbStore(tx, m.gen), cap }));
      const c: CloseCtx = { V, st, maps, dest: destIndex(maps), now: Date.now() };
      const dirty = new Set<number>();
      const prio = (i: number) => [depth(maps[i].to), nk(maps[i].to)] as const;
      const order = (a: number, b: number) => {
        const [da, ka] = prio(a), [db, kb] = prio(b);
        return da !== db ? da - db : ka !== kb ? (ka < kb ? -1 : 1) : before(maps[a], maps[b]) ? -1 : 1;
      };
      let done = 0;
      while (q.queue.length && done < D11.planPage) {
        q.queue.sort(order);
        const k = q.queue[0];
        // (a cap is a maximum: the item that would exceed it fails the plan, stable (N8 v3 §5))
        if (q.items + 1 > D11.closureItems) throw new Cap(`sync's plan for a large move needs more than ${D11.closureItems} checks: reload to try again, or Delete my synced data`);
        const len = maps.length, was = { to: maps[k].to, t: maps[k].t, wit: maps[k].wit, occ: maps[k].occ }, r0 = M.req, w0 = M.rows;
        let r: ItemResult;
        try {
          r = await closeItem(c, k);
        } catch (e) {
          if (!(e instanceof Over)) throw e;
          // (a read the budget doesn't admit isn't made: past the plan's, or one item's own past the transaction's, the
          // plan fails, stable; else this item waits for the next transaction, what it did here undone (what it read,
          // within the budget, counted))
          if (!e.tx || !done) throw over(e);
          maps.length = len;
          Object.assign(maps[k], was);
          c.dest = destIndex(maps);
          q.waits = (q.waits ?? 0) + 1;
          break;
        }
        q.queue.shift();
        q.maxReq = Math.max(q.maxReq ?? 0, M.req - r0);
        q.maxRows = Math.max(q.maxRows ?? 0, M.rows - w0);
        for (const j of affected(maps, k, r)) if (!q.queue.includes(j)) q.queue.push(j);
        q.items++;
        if (r.added.length) q.added = true;
        if (r.vacate) q.unsettled = true;
        dirty.add(k);
        for (const a of r.added) dirty.add(a.i);
        done++;
      }
      const next: Marker = { ...m };
      const settled = !q.queue.length && !q.added && !q.unsettled, reset = !q.queue.length && !settled;
      if (reset) {
        // (a round that found a mapping or freed a name: another over the whole plan, from its views (N8 v3 §3))
        if (q.round + 1 > D11.closureRounds) throw new Cap(`sync's plan for a large move didn't settle in ${D11.closureRounds} rounds: reload to try again, or Delete my synced data`);
        for (const x of maps) {
          Object.assign(x, { to: x.want ?? x.to, t: 0, wit: null, occ: null });
          dirty.add(x.i);
        }
        Object.assign(q, { round: q.round + 1, queue: maps.map((x) => x.i), added: false, unsettled: false });
      }
      // (the ledger: every read of this transaction (no more come), and the writes it makes next: its dirty mappings,
      // the control row, the record and the marker)
      const writes = dirty.size + 3;
      q.requests += M.req;
      q.rows += M.rows;
      q.txReq = Math.max(q.txReq ?? 0, M.workReq);
      q.txRows = Math.max(q.txRows ?? 0, M.workRows);
      q.allTxReq = Math.max(q.allTxReq ?? 0, M.req);
      q.allTxRows = Math.max(q.allTxRows ?? 0, M.rows);
      q.writes = (q.writes ?? 0) + writes;
      q.txWrites = Math.max(q.txWrites ?? 0, writes);
      q.txs = (q.txs ?? 0) + 1;
      REPLAY.cut?.("close", m);
      if (reset) REPLAY.cut?.("close-round", m);
      if (settled) {
        // (settled: validation of the final plan next)
        REPLAY.cut?.("close-settled", m);
        Object.assign(next, { phase: "validate", vi: 0, closure: { rounds: q.round, items: q.items, requests: q.requests, rows: q.rows, maxReq: q.maxReq ?? 0, maxRows: q.maxRows ?? 0, txReq: q.txReq, txRows: q.txRows, allTxReq: q.allTxReq, allTxRows: q.allTxRows, writes: q.writes, txWrites: q.txWrites, txs: q.txs, waits: q.waits ?? 0 } });
      }
      // (the closure's state, durable with what it changed: its mappings (fenced from here), the worklist, the counters)
      for (const i of dirty) st.put({ path: mapKey(rid, i), ...maps[i] });
      if (settled) st.delete(queueKey(rid));
      else st.put(q);
      st.put({ ...rec, n: maps.length, rev: rec.rev + 1 } satisfies ERecord);
      dropView(tx0);
      dropView(tx);
      meta.put(next, markerKey(ns));
      REPLAY.reads?.("end", "close", tx0);
      return "more";
    }, { durability: "relaxed" }), undefined, { quiet: true });
  }
  if (m0.phase === "validate") {
    return inTx(w.ws, [...new Set([...VIEW_STORES, "syncIndex", META])], "readwrite", async (tx0) => {
      // (metered as the closure's (LIMIT-D11-IMPL-1/2/3): its state within PLAN_STATE, its work within this
      // transaction's D11.requests and D11.page; tops past them wait for the next transaction, one top's own past them
      // is the stable failure)
      REPLAY.reads?.("begin", "validate", tx0);
      const M = new Meter(D11.requests, D11.page), tx = M.tx(tx0);
      const over = (e: Over) => new Cap(e.of === "tx" ? `sync's plan for a large move needs more than ${D11.requests} requests or ${D11.page} rows to check one name: reload to try again, or Delete my synced data` : `sync's plan for a large move is larger than one transaction reads (${PLAN_STATE.requests} requests, ${PLAN_STATE.rows()} rows): reload to try again, or Delete my synced data`);
      const metered = async <T>(f: () => Promise<T>) => {
        try {
          return await f();
        } catch (e) {
          throw e instanceof Over ? over(e) : e;
        }
      };
      const m = await metered(() => marker(tx, ns, rid, "validate"));
      if (!m) return "next";
      const meta = tx.objectStore(META), st = tx.objectStore("entries");
      FENCE_READ.add(tx0);
      const { rec, maps } = await metered(() => recordOf(tx));
      if (!rec || rec.rid !== rid) throw new Cap("sync's plan for a large move was taken over: reload to try again");
      const vi = m.vi ?? 0;
      const pix = prefixIndex(maps), dest = destIndex(maps);
      M.state = false;
      const V = await metered(() => viewer({ w, tx, ns, store: idbStore(tx, m.gen), cap }));
      const checked: Mapping[] = [];
      for (const x of maps.slice(vi, vi + D11.validatePage)) {
        let why: string | undefined;
        try {
          why = await checkOne(V, st, maps, dest, x);
        } catch (e) {
          if (!(e instanceof Over)) throw e;
          if (!checked.length) throw over(e);
          break;
        }
        if (why) throw new Cap(`sync's plan for a large move no longer holds (${why}): reload to try again`);
        checked.push(x);
      }
      const last = vi + checked.length >= maps.length;
      // (the publication (r6 §2): the sender's intent revision unchanged since the pass began, else a fault: stable)
      M.state = true;
      const rev = last ? (((await metered(() => req(meta.get(intentRevKey(ns))))) as number | undefined) ?? 0) : undefined;
      // (the ledger: every read of this transaction, and its writes next: its checked mappings, the marker (and the
      // record, at publication))
      const v0 = m.validation ?? { txs: 0, requests: 0, rows: 0, writes: 0, txReq: 0, txRows: 0, allTxReq: 0, allTxRows: 0 };
      const writes = checked.length + (last ? 2 : 1);
      const validation = { txs: v0.txs + 1, requests: v0.requests + M.req, rows: v0.rows + M.rows, writes: v0.writes + writes, txReq: Math.max(v0.txReq, M.workReq), txRows: Math.max(v0.txRows, M.workRows), allTxReq: Math.max(v0.allTxReq, M.req), allTxRows: Math.max(v0.allTxRows, M.rows) };
      // (each one's class, persisted with it, never recomputed from partly drained sources (r8 N7))
      for (const x of checked) st.put({ path: mapKey(rid, x.i), ...x, direct: directOf(maps, x, pix) });
      REPLAY.cut?.("validate", m);
      if (!last) {
        meta.put({ ...m, vi: vi + checked.length, validation }, markerKey(ns));
        REPLAY.reads?.("end", "validate", tx0);
        return "more";
      }
      if (rev !== m.rev0) throw new Cap("sync's plan for a large move saw its inputs change: reload to try again");
      REPLAY.cut?.("publish", m);
      st.put({ ...rec, published: true, sweep: 1, rev: rec.rev + 1 } satisfies ERecord);
      dropView(tx0);
      dropView(tx);
      // (the tops put beside a claimant that stays, for placement: from the final plan)
      const settled = maps.filter((x) => x.top && x.to !== x.want).map((x) => [x.top!, x.to, x.want!] as [string, string, string]);
      meta.put({ ...m, phase: "sweep", settled, validation }, markerKey(ns));
      SENDER_HOLD.delete(ns);
      REPLAY.reads?.("end", "validate", tx0);
      return "more";
    });
  }
  if (m0.phase === "sweep") {
    const ops: Op[] = [];
    const r = await inTx(w.ws, [...new Set([...VIEW_STORES, "syncIndex", META])], "readwrite", async (tx) => {
      const m = await marker(tx, ns, rid, "sweep");
      if (!m) return "next" as const;
      const meta = tx.objectStore(META), st = tx.objectStore("entries");
      FENCE_READ.add(tx);
      const { rec, maps } = await recordOf(tx);
      if (!rec || rec.rid !== rid || !rec.published) {
        meta.put({ ...m, phase: "place", pos: undefined }, markerKey(ns));
        return "more" as const;
      }
      const ms = new MapSet(rec, maps);
      let k = 0;
      const breathe = async () => { if (++k % 200 === 0) await req(st.getKey(RW)); };
      if (rec.sweep !== 2) {
        // (sweep 1: the outermost sources, a page of rows each moved to its owner's staging range)
        for (const x of maps.filter((a) => !maps.some((b) => b !== a && a.from.startsWith(b.from + "/"))).sort((a, b) => (a.from < b.from ? -1 : 1))) {
          const top = (await req(st.get(x.from))) as Entry | undefined;
          const rows = [...(top ? [top] : []), ...((await req(st.getAll(under(x.from), D11.page))) as Entry[])];
          if (!rows.length) continue;
          REPLAY.cut?.("sweep1", m);
          if (x.direct) {
            // (r8 N7: a direct mapping's page, source -> destination at once; its top with its view's fields and its
            // one op, with its row (N3))
            if (top) st.delete(top.path);
            const d = rows.slice(top ? 1 : 0);
            if (d.length) st.delete(IDBKeyRange.bound(d[0].path, d[d.length - 1].path));
            const listed: [string, ListedWhy][] = [];
            for (const row of rows) {
              const rest = row.path.slice(x.from.length), L = x.to + rest;
              const n: Entry = { ...row, path: L, nkey: nkeyOf(L), ...(row.kind === "file" && row.ref !== null ? { ref: L } : {}) };
              if (rest === "") {
                if (x.updated !== undefined) n.updated = x.updated;
                if (x.trashed) n.trashed = { ...x.trashed };
                else if (x.trashed === null) delete n.trashed;
              }
              await req(st.add(n));
              if (rest === "") await w.logServer(tx, ops, { op: x.op ?? "rename", path: x.was ?? x.from, to: L, kind: n.kind }, n);
              await breathe();
            }
            await noteListed(meta, ns, listed);
            meta.put({ ...m, moved: { D: (m.moved?.D ?? 0) + rows.length, S: m.moved?.S ?? 0 } }, markerKey(ns));
            return "more" as const;
          }
          // (the page's rows deleted as one key range: getAll gave every row between its first and last (the top
          // apart, deleted on its own))
          if (top) st.delete(top.path);
          const desc = rows.slice(top ? 1 : 0);
          if (desc.length) st.delete(IDBKeyRange.bound(desc[0].path, desc[desc.length - 1].path));
          for (const row of rows) {
            const o = ms.srcOwner(row.path)!;
            const sk = stageOf(rid, o.i) + row.path.slice(o.from.length);
            // (its `ref` kept until sweep 2: a legacy file's bytes stay named (r8 N4))
            st.put({ ...row, path: sk, nkey: nkeyOf(sk) });
            await breathe();
          }
          meta.put({ ...m, moved: { D: m.moved?.D ?? 0, S: (m.moved?.S ?? 0) + rows.length } }, markerKey(ns));
          return "more" as const;
        }
        REPLAY.cut?.("sweep1to2", m);
        st.put({ ...rec, sweep: 2, rev: rec.rev + 1 } satisfies ERecord);
        dropView(tx);
        return "more" as const;
      }
      // (sweep 2: each staging range, a page of rows to their destination; a top with its view's fields and its op)
      // (several mappings a page, up to D11.page rows, from where the last page left off: a plan of 1,000 one-row
      // occupants is a few pages, not 1,000 each reading every range before it)
      const listed: [string, ListedWhy][] = [];
      let si = m.s2 ?? 0, moved = 0;
      for (; si < maps.length; si++) {
        const room = D11.page - moved;
        if (room <= 0) break;
        const x = maps[si], stage = stageOf(rid, x.i);
        const rows = (await req(st.getAll(IDBKeyRange.bound(stage, stage + "0", false, true), room))) as Entry[];
        if (!rows.length) continue;
        REPLAY.cut?.("sweep2", m);
        st.delete(IDBKeyRange.bound(rows[0].path, rows[rows.length - 1].path));
        for (const row of rows) {
          const rest = row.path.slice(stage.length), L = x.to + rest;
          const n: Entry = { ...row, path: L, nkey: nkeyOf(L), ...(row.kind === "file" && row.ref !== null ? { ref: L } : {}) };
          // (a top staying where it is carried (no-folder) is no move of its own: its fields as they were, no op)
          const own = rest === "" && !noFolder(x);
          if (own) {
            if (x.updated !== undefined) n.updated = x.updated;
            if (x.trashed) n.trashed = { ...x.trashed };
            else if (x.trashed === null) delete n.trashed;
          }
          await req(st.add(n));
          // (its one server op, with its row: exactly once, never with a staging path (r8 N3))
          if (own) await w.logServer(tx, ops, { op: x.op ?? "rename", path: x.was ?? x.from, to: L, kind: n.kind }, n);
          if (rest === "" && x.to !== x.want) listed.push([L, noFolder(x) ? "no-folder" : "conflict"]);
          await breathe();
        }
        moved += rows.length;
        // (this mapping may hold more: the next page starts at it)
        if (rows.length === room) break;
      }
      if (moved) {
        await noteListed(meta, ns, listed);
        meta.put({ ...m, s2: si }, markerKey(ns));
        return "more" as const;
      }
      // (every staging range empty: the plan done, its record and mapping rows dropped)
      st.delete(RW);
      st.delete(IDBKeyRange.bound(`${MAPS}${rid}/`, `${MAPS}${rid}0`, false, true));
      dropView(tx);
      meta.put({ ...m, phase: "place", pos: undefined }, markerKey(ns));
      return "more" as const;
    }, { durability: "relaxed" });
    w.tell({ ops });
    return r;
  }
  if (m0.phase === "forget" || m0.phase === "again") {
    // (N6: a page of the ledger, deeper first: today's applyView by identity; a folder still holding entries
    // reconsidered once after the rest; the marker retired by the page that finds both ranges empty, producer-complete
    // (marker() checks the confirmed record is gone))
    const told: Op[] = [], gone: Entry[] = [];
    const r = await w.locked(() => inTx(w.ws, [...new Set([...VIEW_STORES, "syncIndex", META])], "readwrite", async (tx) => {
      const m = await marker(tx, ns, rid, m0.phase);
      if (!m) return "next" as const;
      const meta = tx.objectStore(META), ix = tx.objectStore("syncIndex");
      const lns = m.phase === "forget" ? ledgerNs(m.gen) : againNs(m.gen);
      const rows = (await req(ix.getAll(IDBKeyRange.bound([lns, ""], [lns, "\uffff"]), D11.planPage))) as { ns: string; id: string }[];
      if (!rows.length) {
        if (m.phase === "forget") meta.put({ ...m, phase: "again" }, markerKey(ns));
        else await finish(tx, ns, m);
        return "more" as const;
      }
      const key = new Map(rows.map((x) => [x.id.slice(3), x.id]));
      const again: string[] = [], debts: string[] = [];
      const v = await applyView({
        w, tx, ns, store: idbStore(tx, m.gen), cap, prefetch: { ids: [...key.keys()], prefix: m.gen },
        large: { chunk: D11.chunk, debt: (it) => debts.push(it.id) },
        ...(m.phase === "forget" ? { notEmpty: (id: string) => again.push(id) } : {}),
      }, [...key.keys()]);
      told.push(...v.ops);
      gone.push(...v.gone);
      REPLAY.cut?.(m.phase, m);
      for (const x of rows) ix.delete([lns, x.id]);
      for (const id of again) ix.put({ ns: againNs(m.gen), id: key.get(id)! });
      await noteDebts(tx, ns, m, debts);
      return "more" as const;
    }, { durability: "relaxed" }), undefined, { quiet: true });
    w.tell({ ops: told });
    if (gone.length) await w.dropContents(gone).catch((err) => console.warn("sync: dropping forgotten contents:", err));
    return r;
  }
  // (placement: today's applyView over the subtree again, large lifts recorded as debts)
  const told: Op[] = [], gone: Entry[] = [];
  const r = await w.locked(() => inTx(w.ws, [...new Set([...VIEW_STORES, "syncIndex", META])], "readwrite", async (tx) => {
    const t0 = Date.now();
    const m = await marker(tx, ns, rid, "place");
    if (!m) return "next" as const;
    const meta = tx.objectStore(META);
    const deferred = new Set(m.deferred ?? []);
    const inDeferred = (r: { key: string }) => { for (const d of deferred) if (r.key === d || r.key.startsWith(d + "/")) return true; return false; };
    const { rows, pos, done } = await walk(tx, m, m.pos, D11.planPage, inDeferred);
    const t1 = Date.now();
    const settled = new Map((m.settled ?? []).map(([id, p]) => [id, p]));
    // (what such a top carries (CORR-D11-IMPL-1): an entry under it whose view is where the top's view would carry it
    // stays where the top is (applyView's lift carries it so); by the nearest such top, as applyView's nearest moved
    // folder; any other view is its own move, as in one transaction)
    const beside = (m.settled ?? []).filter((x) => x[2]).sort((a, b) => b[1].length - a[1].length) as [string, string, string][];
    const translate = (p: string, at: string) => {
      for (const [, to, want] of beside) if (at.startsWith(to + "/")) return want + at.slice(to.length) === p ? at : undefined;
      return undefined;
    };
    const debts: { id: string }[] = [];
    const v = rows.length ? await applyView({
      w, tx, ns, store: idbStore(tx, m.gen), cap, prefetch: { ids: rows.map((x) => x.id), prefix: m.gen, rows: confirmedRows(rows) },
      large: { chunk: D11.chunk, debt: (it) => debts.push({ id: it.id }), settled: (id, path) => settled.get(id) === path, translate },
    }, rows.map((x) => x.id)) : { ops: [], gone: [], listed: [] };
    const t2 = Date.now();
    told.push(...v.ops);
    gone.push(...v.gone);
    REPLAY.cut?.("place", m);
    for (const k of await noteDebts(tx, ns, m, debts.map((d) => d.id))) deferred.add(k);
    const pl = m.placed ?? { pages: 0, ids: 0, ops: 0, listed: 0, debts: 0 };
    const placed = { pages: pl.pages + 1, ids: pl.ids + rows.length, ops: pl.ops + v.ops.length, listed: pl.listed + v.listed.length, debts: pl.debts + debts.length, walkMs: (pl.walkMs ?? 0) + t1 - t0, viewMs: (pl.viewMs ?? 0) + t2 - t1, txMs: (pl.txMs ?? 0) + Date.now() - t0 };
    if (!done) {
      meta.put({ ...m, pos, deferred: [...deferred], placed }, markerKey(ns));
      return "more" as const;
    }
    await finish(tx, ns, m);
    return "more" as const;
  }, { durability: "relaxed" }), undefined, { quiet: true });
  w.tell({ ops: told });
  if (gone.length) await w.dropContents(gone).catch((err) => console.warn("sync: dropping forgotten contents:", err));
  return r;
}

/** Debts recorded (r4 §4, r6 §3): each its folder's confirmed subtree, by its confirmed key, at most D11.debts, then
 * one "more debts".  Returns their keys (placement's deferred ranges). */
async function noteDebts(tx: IDBTransaction, ns: string, m: Marker, ids: string[]): Promise<string[]> {
  if (!ids.length) return [];
  const meta = tx.objectStore(META), store = idbStore(tx, m.gen), out: string[] = [];
  let nd = (await req(meta.count(debtRange(ns)))) as number;
  for (const id of ids) {
    const c = await store.byId(id);
    if (!c) continue;
    const k = keyOf(c.path);
    out.push(k);
    if (nd < D11.debts) meta.put(k, debtKey(ns, nd++));
    else meta.put(true, moreDebtsKey(ns));
  }
  return out;
}
/** A replay ended: its debts, if any, the next logical move, with its own deadline (r6 §3); else the marker retired;
 * a lateness after publication kept (r6 §4). */
async function finish(tx: IDBTransaction, ns: string, m: Marker) {
  const meta = tx.objectStore(META);
  const more = (await req(meta.get(moreDebtsKey(ns)))) !== undefined;
  const keys = (await req(meta.getAll(debtRange(ns)))) as string[];
  if (keys.length || more) {
    meta.delete(debtRange(ns));
    meta.delete(moreDebtsKey(ns));
    const now = Date.now(), nrid = hex(8);
    meta.put({ gen: m.gen, rid: nrid, kind: "debts", ranges: more ? [ALL] : keys, phase: "pass", start: now, deadline: now + D11.deadlineMs, times: {} } satisfies Marker, markerKey(ns));
    FENCE_READ.add(tx);
    tx.objectStore("entries").put({ path: RW, rid: nrid, kind: "reserved", published: false, rev: 1, n: 0, fails: 0, at: now } satisfies ERecord);
    dropView(tx);
  } else meta.delete(markerKey(ns));
  if (m.late) meta.put({ rid: m.rid, start: m.start, deadline: m.deadline, end: Date.now(), times: m.times }, lateKey(ns));
}

export { ALL as REPLAY_ALL };
