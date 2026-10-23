// The shared reducer (sync-reduce.ts), run over a stored index without holding it whole (design/sync-client.md
// D10, r2 and r3): each op runs on a copy-on-write overlay over the page's partial index (the base).  Every read
// looks in the overlay, then the base; every write goes to the overlay only; an entry is copied into the overlay
// the first time it is read, and a folder's `children` Set the first time it is read, since the reducer changes
// both in place.  A read of a key the base doesn't know (neither loaded nor known absent) marks the overlay dirty
// and throws: a dirty overlay is discarded whole, whatever `reduce` returned (it may catch the throw), the missed
// keys are loaded, and the op runs again on a fresh overlay.  Only an op that completes with no miss is merged
// into the base.  Every map operation counts one unit, every copy one memory unit (D10 r3).
//
// No IndexedDB here: the base loads through a `Store` (sync-confirmed.ts gives the IndexedDB one; the tests an
// in-memory one), so the vectors can check it against the in-memory reducer.
import { SyncIndex, reduce, type Outcome, type SyncEntry, type SyncOp } from "./sync-reduce";
import { parentOf } from "./paths";

/** D10 r3's bounds. */
export const OVERLAY = {
  /** units a page may execute (plus one discarded trial) */
  pageUnits: 500_000,
  /** units one op may take, retries included, across a discarded trial's handoff (daybreak3) */
  opUnits: 5_000_000,
  /** memory units a page may hold: base rows, dirty, the batch in hand, overlay clones, copied Set members */
  pageMemory: 200_000,
  /** memory units an op running alone may hold */
  opMemory: 250_000,
  /** retry rounds: the reducer's 1,000-candidate series, plus one */
  rounds: 1001,
};

const keyOf = (p: string) => p.normalize("NFC");

/** Where the base's misses are loaded from: the confirmed index (or a staging generation of it). */
export interface Store {
  /** an identity's entry, or undefined */
  byId(id: string): Promise<SyncEntry | undefined>;
  /** an identity forgotten for good: its last path, or undefined */
  gone(id: string): Promise<string | undefined>;
  /** every entry directly in the folder whose key is `folderKey` (at most the workspace's 10,000) */
  folder(folderKey: string): Promise<SyncEntry[]>;
}

/** A read of a key the base doesn't know. */
export class Miss extends Error {
  constructor(readonly map: "byId" | "byKey" | "children" | "gone", readonly key: string) { super(`sync: ${map} ${key.slice(0, 80)} isn't loaded`); }
}
/** An op that can't complete within its bounds: sync halts, and the person is told. */
export class Halt extends Error {}

const ABSENT = Symbol("absent");
const copyEntry = (e: SyncEntry): SyncEntry => ({ ...e, ...(e.trashed ? { trashed: { ...e.trashed } } : {}) });

/** The page's base: what is loaded, and what is known absent, for each of the four maps. */
export class PartialIndex {
  readonly byId = new Map<string, SyncEntry | typeof ABSENT>();
  readonly byKey = new Map<string, string | typeof ABSENT>();
  /** a folder's listing, only ever whole */
  readonly children = new Map<string, Set<string> | typeof ABSENT>();
  readonly gone = new Map<string, string | typeof ABSENT>();
  /** rows held (each entry, each gone row, each Set member): memory units */
  memory = 0;

  /** An entry loaded: by identity and by its path's key. */
  putEntry(e: SyncEntry) {
    if (!this.byId.has(e.id)) this.memory++;
    this.byId.set(e.id, e);
    this.byKey.set(keyOf(e.path), e.id);
  }
  /** A folder's listing loaded whole: its entries, and the folder's Set. */
  putFolder(folderKey: string, entries: SyncEntry[]) {
    for (const e of entries) this.putEntry(e);
    const s = new Set(entries.map((e) => e.id));
    this.children.set(folderKey, s.size ? s : ABSENT);
    this.memory += s.size;
  }

  /** The missed keys loaded from `store`.  Returns how many keys became known. */
  async load(store: Store, misses: Miss[]): Promise<number> {
    let learned = 0;
    for (const m of misses) {
      if (m.map === "byId") {
        if (this.byId.has(m.key)) continue;
        const e = await store.byId(m.key);
        if (e) this.putEntry(e);
        else this.byId.set(m.key, ABSENT);
        learned++;
      } else if (m.map === "gone") {
        if (this.gone.has(m.key)) continue;
        const p = await store.gone(m.key);
        this.gone.set(m.key, p === undefined ? ABSENT : p);
        if (p !== undefined) this.memory++;
        learned++;
      } else {
        // (a path's key, or a folder's listing: the folder loaded whole (D10 r3: a landing folder's names
        // are its read set, so name probes never retry), the key absent if it isn't among them)
        const folderKey = m.map === "children" ? m.key : keyOf(parentOf(m.key));
        if (!this.children.has(folderKey)) {
          this.putFolder(folderKey, await store.folder(folderKey));
          learned++;
        }
        if (m.map === "byKey" && !this.byKey.has(m.key)) {
          this.byKey.set(m.key, ABSENT);
          learned++;
        }
      }
    }
    return learned;
  }
}

const DELETED = Symbol("deleted");

/** One map of the overlay: reads overlay then base, writes overlay only, a miss throws; only get, has, set and
 * delete exist (anything else throws: a partial map can't answer a whole-map question). */
class OverlayMap<V> {
  readonly own = new Map<string, V | typeof DELETED>();
  constructor(
    private ov: Overlay,
    private name: "byId" | "byKey" | "children" | "gone",
    private base: Map<string, V | typeof ABSENT>,
    // (how a base value is copied into the overlay on first read: entries and Sets, which the reducer changes in place)
    private clone: ((v: V) => V) | null,
    private sizeOf: (v: V) => number,
  ) {}
  private read(k: string): V | undefined {
    this.ov.units++;
    if (this.own.has(k)) {
      const v = this.own.get(k)!;
      return v === DELETED ? undefined : v;
    }
    if (!this.base.has(k)) {
      const m = new Miss(this.name, k);
      this.ov.missed.push(m);
      throw m;
    }
    const b = this.base.get(k)!;
    if (b === ABSENT) return undefined;
    if (!this.clone) return b as V;
    const c = this.clone(b as V);
    this.own.set(k, c);
    this.ov.memory += this.sizeOf(c);
    return c;
  }
  get(k: string): V | undefined {
    return this.read(k);
  }
  has(k: string): boolean {
    return this.read(k) !== undefined;
  }
  set(k: string, v: V): this {
    this.ov.units++;
    this.own.set(k, v);
    return this;
  }
  delete(k: string): boolean {
    this.ov.units++;
    // (a delete needs no read of what it deletes: the overlay says it's gone)
    this.own.set(k, DELETED);
    return true;
  }
}
// (every other Map member, on the overlay's maps: a throw, so a reducer that starts to iterate or count a map fails
// every test at once rather than reading a partial index)
for (const m of ["size", "keys", "values", "entries", "forEach", "clear", Symbol.iterator] as const) {
  Object.defineProperty(OverlayMap.prototype, m, {
    get() { throw new Error(`sync: the partial index has no ${String(m)} (a whole-map question)`); },
  });
}

/** One op's overlay over the base: a SyncIndex whose four maps are OverlayMaps. */
export class Overlay {
  units = 0;
  memory = 0;
  readonly missed: Miss[] = [];
  readonly index: SyncIndex;
  readonly maps: { byId: OverlayMap<SyncEntry>; byKey: OverlayMap<string>; children: OverlayMap<Set<string>>; gone: OverlayMap<string> };
  constructor(readonly base: PartialIndex) {
    this.maps = {
      byId: new OverlayMap<SyncEntry>(this, "byId", base.byId, copyEntry, () => 1),
      byKey: new OverlayMap<string>(this, "byKey", base.byKey, null, () => 0),
      children: new OverlayMap<Set<string>>(this, "children", base.children, (s) => new Set(s), (s) => s.size),
      gone: new OverlayMap<string>(this, "gone", base.gone, null, () => 0),
    };
    // (the reducer receives only this object: its maps are the overlay's)
    const ix = Object.create(SyncIndex.prototype) as SyncIndex;
    for (const [k, m] of Object.entries(this.maps)) Object.defineProperty(ix, k, { value: m, enumerable: true });
    this.index = ix;
  }
  get dirty() {
    return this.missed.length > 0;
  }
  /** This (clean) overlay's changes into the base. */
  merge(changed: string[]) {
    const b = this.base;
    for (const [k, v] of this.maps.byId.own) {
      if (v === DELETED) b.byId.set(k, ABSENT);
      else {
        if (b.byId.get(k) === undefined || b.byId.get(k) === ABSENT) b.memory++;
        b.byId.set(k, v);
      }
    }
    for (const [k, v] of this.maps.byKey.own) b.byKey.set(k, v === DELETED ? ABSENT : v);
    for (const [k, v] of this.maps.children.own) {
      const was = b.children.get(k);
      if (was && was !== ABSENT) b.memory -= was.size;
      if (v === DELETED || v.size === 0) b.children.set(k, ABSENT);
      else {
        b.children.set(k, v);
        b.memory += v.size;
      }
    }
    for (const [k, v] of this.maps.gone.own) b.gone.set(k, v === DELETED ? ABSENT : v);
    return changed;
  }
}

/** What one op did, with what it cost. */
export type OpResult = { outcome: Outcome; units: number; rounds: number; memory: number };

/**
 * `op` run on fresh overlays over `base` until one completes with no miss, then merged: misses loaded from
 * `store` between rounds.  `carried`: units this op already took in a page that discarded it as a trial (its
 * cumulative meter, daybreak3).  `budget`: units the page has left; a completed op that would pass it isn't
 * merged (its overlay discarded, no changed identity kept: astra's proviso), and `null` is returned so the page
 * is cut before it.  Throws Halt past the op's own ceilings, or for a reducer fault.
 */
export async function runOp(base: PartialIndex, store: Store, op: SyncOp, opts: { carried?: number; budget?: number; alone?: boolean } = {}): Promise<OpResult | { trial: number }> {
  let units = opts.carried ?? 0;
  for (let round = 1; ; round++) {
    const ov = new Overlay(base);
    let outcome: Outcome | undefined, escaped: unknown;
    try {
      outcome = reduce(ov.index, op);
    } catch (e) {
      // (whatever escapes, the reducer's own undo included: the overlay's flag decides, astra's note on r2)
      escaped = e;
    }
    units += ov.units;
    if (units > OVERLAY.opUnits) throw new Halt(`sync: an op (seq ${op.seq}) took more than ${OVERLAY.opUnits} units`);
    if (ov.dirty) {
      if (round >= OVERLAY.rounds) throw new Halt(`sync: an op (seq ${op.seq}) still missed after ${OVERLAY.rounds} rounds`);
      if ((await base.load(store, ov.missed)) === 0) throw new Halt(`sync: an op (seq ${op.seq}) missed without anything to load`);
      continue;
    }
    if (escaped !== undefined || !outcome) throw new Halt(`sync: the reducer failed on seq ${op.seq}: ${String(escaped).slice(0, 200)}`);
    const memory = base.memory + ov.memory;
    if (memory > (opts.alone ? OVERLAY.opMemory : Infinity)) throw new Halt(`sync: an op (seq ${op.seq}) held more than ${OVERLAY.opMemory} rows`);
    // (a trial past the page's budget or memory: discarded, the page cut before it; its units go with it)
    if (!opts.alone && ((opts.budget !== undefined && units - (opts.carried ?? 0) > opts.budget) || memory > OVERLAY.pageMemory)) return { trial: units };
    ov.merge(outcome.changed);
    return { outcome, units, rounds: round, memory };
  }
}

/** A page of ops run over a fresh base: as many as fit its budgets, at least one.  Returns what was reduced (the ops
 * taken, their changed identities) and the base to write from; `carried` is the next op's units if it was cut as a
 * trial. */
export async function runPage(store: Store, ops: SyncOp[], carried = 0): Promise<{ base: PartialIndex; taken: number; changed: Set<string>; units: number; carry: number; outcomes: Outcome[] }> {
  const base = new PartialIndex(), changed = new Set<string>(), outcomes: Outcome[] = [];
  let units = 0, carry = carried;
  for (let i = 0; i < ops.length; i++) {
    const alone = i === 0;
    const r = await runOp(base, store, ops[i], { carried: carry, budget: OVERLAY.pageUnits - units, alone });
    carry = 0;
    if ("trial" in r) return { base, taken: i, changed, units, carry: r.trial, outcomes };
    units += r.units;
    for (const id of r.outcome.changed) changed.add(id);
    outcomes.push(r.outcome);
  }
  return { base, taken: ops.length, changed, units, carry: 0, outcomes };
}

/** What a page writes for an identity it changed: its entry as it is now, or that it is gone (with its last path),
 * or nothing (an identity a conflict made and a later op removed again isn't possible: the reducer's changes are
 * entries, moves and forgets). */
export function rowsOf(base: PartialIndex, changed: Iterable<string>): { put: SyncEntry[]; gone: [string, string][]; drop: string[] } {
  const put: SyncEntry[] = [], gone: [string, string][] = [], drop: string[] = [];
  for (const id of changed) {
    const e = base.byId.get(id);
    if (e && e !== ABSENT) {
      put.push(e);
      continue;
    }
    const g = base.gone.get(id);
    if (g !== undefined && g !== ABSENT) gone.push([id, g]);
    else drop.push(id);
  }
  return { put, gone, drop };
}
