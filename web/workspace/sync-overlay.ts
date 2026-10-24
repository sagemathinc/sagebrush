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
import { TRASH, join, parentOf, within } from "./paths";

/** A partial folder's name probes read at once (D11 r2 §2: a 10,000-probe series in at most 10 more rounds). */
export const PARTIAL_PROBES = 1000;

/** D10 r3's bounds. */
export const OVERLAY = {
  /** units a page may execute (plus one discarded trial) */
  pageUnits: 500_000,
  /** units one op may take, retries included, across a discarded trial's handoff (daybreak3) */
  opUnits: 5_000_000,
  /** memory units a page may hold: base rows, dirty, the batch in hand, overlay clones, copied Set members */
  pageMemory: 200_000,
  /** memory units an op running alone may hold, every live population counted (daybreak3's LIMIT-PR65-IMPL-1): at a
   * maximum move, ~100,000 base rows, ~100,000 overlay clones, ~100,000 members of the moved folders' copied children
   * Sets, and the ~100,000 identities it changes held twice (the reducer's Set and the array it returns), plus a folder
   * listing in hand (10,000): about 510,000.  D10 r3 said 250,000, which left out all but the first two */
  opMemory: 520_000,
  /** a folder listing's rows at most (the workspace's folder bound): reserved before one is read, the batch in hand */
  listing: 10_000,
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
  /** how many entries are under the folder whose key is `folderKey` (its descendants, one count: D11) */
  count?(folderKey: string): Promise<number>;
  /** how many entries are directly in the folder (one count): a listing larger than OVERLAY.listing is partial */
  childCount?(folderKey: string): Promise<number>;
  /** the entries at these keys, each or undefined (one round of requests: a partial folder's name probes) */
  keys?(keys: string[]): Promise<(SyncEntry | undefined)[]>;
}

/**
 * A folder's listing too large to load (more than OVERLAY.listing, legal on the server: D11 r2 §2): its members
 * are never held.  It records the reduction's adds and deletes, and knows its size; iterating it throws, so an op
 * that would walk it (a subtree) can't run on a partial index (such a folder is large: a hidden one, D11).
 */
export class PartialSet {
  constructor(public size: number, readonly added = new Set<string>(), readonly removed = new Set<string>()) {}
  add(id: string) {
    if (this.removed.delete(id) || !this.added.has(id)) this.size++;
    this.added.add(id);
    return this;
  }
  delete(id: string) {
    this.added.delete(id);
    this.removed.add(id);
    this.size = Math.max(0, this.size - 1);
    return true;
  }
  clone() {
    return new PartialSet(this.size, new Set(this.added), new Set(this.removed));
  }
  get units() {
    return this.added.size + this.removed.size;
  }
}
for (const m of ["has", "keys", "values", "entries", "forEach", Symbol.iterator] as const) {
  Object.defineProperty(PartialSet.prototype, m, {
    get() { throw new Error(`sync: a folder's listing too large to hold has no ${String(m)} (a partial listing)`); },
  });
}
/** The next names of a series `base (k).ext`, from the one probed: a partial folder's probes batched (r2 §2). */
function series(key: string, n: number): string[] {
  const folder = parentOf(key), name = key.slice(folder === "/" ? 1 : folder.length + 1);
  const dot = name.lastIndexOf(".");
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  const m = /^(.*) \((\d+)\)$/.exec(stem);
  const base = m ? m[1] : stem, from = m ? Number(m[2]) : 1;
  const out = [key];
  for (let k = Math.max(2, from + 1); out.length < n; k++) out.push(join(folder, `${base} (${k})${ext}`));
  return out;
}

/** A large folder the op may relocate (D11 r2 §3, r8 N2): its subtree hidden from the reduction, its descendants read
 * through their projection.  `fromPath`/`fromKey`: where it is in the base (physically). */
export type Hidden = { id: string; fromPath: string; fromKey: string };

/** A read of a key the base doesn't know. */
export class Miss extends Error {
  constructor(readonly map: "byId" | "byKey" | "children" | "gone", readonly key: string) { super(`sync: ${map} ${key.slice(0, 80)} isn't loaded`); }
}
/** An op that can't complete within its bounds: sync halts, and the person is told. */
export class Halt extends Error {}
/** An allocation that would pass the memory ceiling in force, refused before it is made. */
export class OverLimit extends Error {
  constructor() { super("sync: the partial index's memory ceiling"); }
}

const ABSENT = Symbol("absent");
const copyEntry = (e: SyncEntry): SyncEntry => ({ ...e, ...(e.trashed ? { trashed: { ...e.trashed } } : {}) });

/** The page's base: what is loaded, and what is known absent, for each of the four maps. */
export class PartialIndex {
  readonly byId = new Map<string, SyncEntry | typeof ABSENT>();
  readonly byKey = new Map<string, string | typeof ABSENT>();
  /** a folder's listing, only ever whole */
  readonly children = new Map<string, Set<string> | PartialSet | typeof ABSENT>();
  readonly gone = new Map<string, string | typeof ABSENT>();
  /** rows held (each entry, each gone row): memory units; a folder's listing Set points at rows already counted */
  memory = 0;
  /** the ceiling in force for loads (the op's or the page's), and what else is live beside the base (the page's
   * dirty set): a listing is refused before it is read if its rows could pass it */
  limit = Infinity;
  extra = 0;
  /** (D11) the large folders hidden from this page's op, and the op (its `t` and `seq` are what a relocation sets) */
  hidden: Hidden[] = [];
  hiddenOp: SyncOp | null = null;

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
  }

  /** A folder's listing loaded: whole, or partial past OVERLAY.listing (its count first, one request). */
  async loadFolder(store: Store, folderKey: string) {
    if (store.childCount && (await store.childCount(folderKey)) > OVERLAY.listing) {
      this.children.set(folderKey, new PartialSet(await store.childCount(folderKey)));
      return;
    }
    this.room(OVERLAY.listing);
    this.putFolder(folderKey, await store.folder(folderKey));
  }

  /** Room for `n` more rows within the ceiling in force, checked before they are read. */
  room(n: number) {
    if (this.memory + this.extra + n > this.limit) throw new OverLimit();
  }

  /** The missed keys loaded from `store`.  Returns how many keys became known. */
  async load(store: Store, misses: Miss[]): Promise<number> {
    let learned = 0;
    for (const m of misses) {
      if (m.map === "byId" || m.map === "gone") {
        // (an identity's entry and its gone row are one stored row: both learned from one miss, so a derived
        // identity's probe (byId, then gone) costs one round per candidate, as D10 r2's 1,001 rounds count)
        if (this.byId.has(m.key) && this.gone.has(m.key)) continue;
        if (!this.byId.has(m.key)) {
          this.room(1);
          const e = await store.byId(m.key);
          if (e) this.putEntry(e);
          else this.byId.set(m.key, ABSENT);
          learned++;
        }
        if (!this.gone.has(m.key)) {
          const cur = this.byId.get(m.key);
          const p = cur !== undefined && cur !== ABSENT ? undefined : await store.gone(m.key);
          this.gone.set(m.key, p === undefined ? ABSENT : p);
          if (p !== undefined) this.memory++;
          learned++;
        }
      } else {
        // (a path's key, or a folder's listing: the folder loaded whole (D10 r3: a landing folder's names
        // are its read set, so name probes never retry), the key absent if it isn't among them)
        const folderKey = m.map === "children" ? m.key : keyOf(parentOf(m.key));
        if (!this.children.has(folderKey)) {
          await this.loadFolder(store, folderKey);
          learned++;
        }
        if (m.map === "byKey" && !this.byKey.has(m.key)) {
          const s = this.children.get(folderKey);
          if (s instanceof PartialSet && store.keys) {
            // (a partial folder: the probed name and the next of its series, PARTIAL_PROBES at once, by key)
            const want = series(m.key, PARTIAL_PROBES).filter((k) => !this.byKey.has(k));
            this.room(want.length);
            const got = await store.keys(want);
            want.forEach((k, i) => {
              const e = got[i];
              if (e) this.putEntry(e);
              else this.byKey.set(k, ABSENT);
            });
          } else this.byKey.set(m.key, ABSENT);
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
    // (a large folder hidden (D11): a key beneath its present place read where it physically is, its old place
    // absent once it has moved, its own listing hidden; a descendant's entry answered as its projection)
    if (this.ov.base.hidden.length && this.name !== "gone") {
      if (this.name === "byKey" || this.name === "children") {
        const t = this.ov.translate(k, this.name === "children");
        if (t === null) return undefined;
        if (t !== k) {
          if (!this.base.has(t)) {
            const m = new Miss(this.name, t);
            this.ov.missed.push(m);
            throw m;
          }
          const b = this.base.get(t)!;
          if (b === ABSENT) return undefined;
          if (!this.clone) return b as V;
          const n = this.sizeOf(b as V);
          this.ov.need(n);
          const c = this.clone(b as V);
          this.own.set(k, c);
          this.ov.memory += n;
          return c;
        }
      }
    }
    if (!this.base.has(k)) {
      const m = new Miss(this.name, k);
      this.ov.missed.push(m);
      throw m;
    }
    const b = this.base.get(k)!;
    if (b === ABSENT) return undefined;
    if (this.name === "byId" && this.ov.base.hidden.length) {
      const v = this.ov.virtual(b as unknown as SyncEntry);
      if (v) return v as unknown as V;
    }
    if (!this.clone) return b as V;
    // (its copy admitted before it is made: an entry is one unit, a Set its members)
    const n = this.sizeOf(b as V);
    this.ov.need(n);
    const c = this.clone(b as V);
    this.own.set(k, c);
    this.ov.memory += n;
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
    // (an identity the op changes is held twice until the op is merged: in the reducer's changed Set, and in the
    // array it returns; admitted before either holds it)
    if (this.name === "byId" && !this.own.has(k)) {
      this.ov.need(2);
      this.ov.changed++;
    }
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
  /** identities this op has changed (each two units: the reducer's Set and its returned array) */
  changed = 0;
  /** the ceiling in force, and whether an allocation was refused (the overlay is then discarded whole) */
  limit = Infinity;
  over = false;
  /** Every live population, as D10 r3 counts them (daybreak3's LIMIT-PR65-IMPL-1): the base's rows, what else the
   * page holds (its dirty set), this overlay's clones and copied Set members, and its changed identities. */
  total(): number {
    return this.base.memory + this.base.extra + this.memory + 2 * this.changed;
  }
  /** Room for `n` more units, refused (marked over, thrown) before the allocation is made. */
  need(n: number) {
    if (this.total() + n > this.limit) {
      this.over = true;
      throw new OverLimit();
    }
  }
  readonly missed: Miss[] = [];
  readonly index: SyncIndex;
  readonly maps: { byId: OverlayMap<SyncEntry>; byKey: OverlayMap<string>; children: OverlayMap<Set<string>>; gone: OverlayMap<string> };
  constructor(readonly base: PartialIndex) {
    this.maps = {
      byId: new OverlayMap<SyncEntry>(this, "byId", base.byId, copyEntry, () => 1),
      byKey: new OverlayMap<string>(this, "byKey", base.byKey, null, () => 0),
      children: new OverlayMap<Set<string>>(this, "children", base.children as Map<string, Set<string> | typeof ABSENT>, (s) => (s instanceof PartialSet ? (s.clone() as unknown as Set<string>) : new Set(s)), (s) => (s instanceof PartialSet ? (s as unknown as PartialSet).units : s.size)),
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

  // ---- hidden large folders (D11 r2 §3, r8 N2)

  /** Where hidden folder `h` is now, in this overlay: its own entry if the op has written it, else its base path, or
   * its projection under an enclosing hidden folder that has moved. */
  curPath(h: Hidden): string {
    const own = this.maps.byId.own.get(h.id);
    if (own !== undefined && own !== DELETED) return (own as SyncEntry).path;
    return this.projected(h.fromPath, h.id);
  }
  /** A base path under a hidden folder that has moved: where it is now (the longest such folder's place, then the
   * rest); else the path itself. */
  projected(path: string, self?: string): string {
    let best: Hidden | undefined;
    for (const h of this.base.hidden) {
      if (h.id === self || !path.startsWith(h.fromPath + "/")) continue;
      if (!best || h.fromPath.length > best.fromPath.length) best = h;
    }
    if (!best) return path;
    const cur = this.curPath(best);
    return cur === best.fromPath ? path : cur + path.slice(best.fromPath.length);
  }
  /** A base entry under a moved hidden folder: a fresh copy at its projected path, with the relocation's `updated` and
   * `seq`, recomputed at each read (the reducer reads again after each relocation); undefined otherwise. */
  virtual(e: SyncEntry): SyncEntry | undefined {
    // (any row under a hidden folder, moved yet or not, is answered afresh at each read and never kept in the
    // overlay: a copy kept before its folder moved would keep the old path (the reducer reads again after moving))
    let under = false;
    for (const h of this.base.hidden) if (h.id !== e.id && e.path.startsWith(h.fromPath + "/")) { under = true; break; }
    if (!under) return undefined;
    const p = this.projected(e.path, e.id);
    this.need(1);
    if (p === e.path) return copyEntry(e);
    const op = this.base.hiddenOp!;
    return { ...copyEntry(e), path: p, updated: op.t, seq: op.seq };
  }
  /** A key the reduction reads (a path's, or a folder's listing): the base key it is at physically; null for an old
   * place of a moved hidden folder, or a hidden folder's own listing. */
  translate(k: string, listing: boolean): string | null {
    let best: { h: Hidden; cur: string } | undefined;
    for (const h of this.base.hidden) {
      const cur = keyOf(this.curPath(h));
      if (listing && k === cur) return null;
      if (cur !== h.fromKey && k.startsWith(cur + "/") && (!best || cur.length > best.cur.length)) best = { h, cur };
    }
    if (best) return best.h.fromKey + k.slice(best.cur.length);
    for (const h of this.base.hidden) {
      const cur = keyOf(this.curPath(h));
      if (cur !== h.fromKey && (k === h.fromKey || k.startsWith(h.fromKey + "/"))) return null;
    }
    return k;
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
    for (const [k, v] of this.maps.children.own) b.children.set(k, v === DELETED || v.size === 0 ? ABSENT : (v as Set<string> | PartialSet));
    for (const [k, v] of this.maps.gone.own) b.gone.set(k, v === DELETED ? ABSENT : v);
    return changed;
  }
}

/**
 * The op's read set loaded before it runs (D10 r1): its target and `parent` by identity; the ancestors of its path
 * and of `to` by key (each a folder's listing, as a key's miss loads it); for a folder it moves, puts in Trash or
 * forgets, its subtree, level by level; and Trash's top.  So the rounds that follow miss only on what can't be
 * known before the reducer runs: derived identities' candidates (D10 r2's 1,001 rounds).
 */
async function preload(base: PartialIndex, store: Store, op: SyncOp) {
  const misses: Miss[] = [];
  const id = op.kind === "file" || op.kind === "folder" ? op.fid : op.ref;
  if (typeof id === "string") misses.push(new Miss("byId", id));
  if (typeof op.parent === "string") misses.push(new Miss("byId", op.parent));
  for (const p of [op.path, op.to]) {
    if (typeof p !== "string" || !p.startsWith("/")) continue;
    for (let a = p; a !== "/" && a.length > 0; a = parentOf(a)) misses.push(new Miss("byKey", keyOf(a)));
  }
  misses.push(new Miss("children", keyOf(TRASH)));
  await base.load(store, misses);
  const e = typeof id === "string" ? base.byId.get(id) : undefined;
  if (e && e !== ABSENT && e.kind === "folder" && op.op !== "write" && op.op !== "create" && op.op !== "mkdir" && op.op !== "adopt" && !base.hidden.some((h) => h.id === e.id)) {
    const queue = [keyOf(e.path)];
    while (queue.length) {
      const k = queue.shift()!;
      if (!base.children.has(k)) await base.loadFolder(store, k);
      // (and where it lands: each subtree folder's destination listing, for a move with `to`)
      if (typeof op.to === "string" && op.to.startsWith("/")) {
        const dest = keyOf(op.to) + k.slice(keyOf(e.path).length);
        if (!base.children.has(dest)) await base.loadFolder(store, dest);
      }
      const kids = base.children.get(k);
      if (!kids || kids === ABSENT || kids instanceof PartialSet) continue;
      for (const cid of kids) {
        const c = base.byId.get(cid);
        if (c && c !== ABSENT && c.kind === "folder") queue.push(keyOf(c.path));
      }
    }
  }
}

/** The ops that may relocate a folder: its own move, or bringing back the Trash top it is in, or the folder it names. */
const RELOCATING = new Set(["rename", "remove", "restore", "write", "create", "mkdir", "adopt", "forget"]);

/**
 * The large folders `op` may relocate (D11, r8 N2): its target if a folder, the Trash top its target is in, and the
 * Trash top of the folder its `parent` names; each kept if it has more than `chunk` descendants (one count each).
 * Loads what it reads into `base`.
 */
export async function largeOf(base: PartialIndex, store: Store, op: SyncOp, chunk: number): Promise<{ id: string; path: string; count: number }[]> {
  if (!store.count || !RELOCATING.has(op.op)) return [];
  const id = op.kind === "file" || op.kind === "folder" ? op.fid : op.ref;
  const ids = [id, op.parent].filter((x): x is string => typeof x === "string");
  await base.load(store, [...ids.map((x) => new Miss("byId", x)), new Miss("children", keyOf(TRASH))]);
  const got = (x: string) => { const e = base.byId.get(x); return e && e !== ABSENT ? e : undefined; };
  const cands = new Map<string, SyncEntry>();
  const t = id ? got(id) : undefined;
  if (t?.kind === "folder" && op.op !== "write" && op.op !== "create" && op.op !== "mkdir" && op.op !== "adopt") cands.set(t.id, t);
  for (const x of [t, op.parent ? got(op.parent) : undefined]) {
    if (!x || !within(x.path, TRASH) || x.path === TRASH) continue;
    const topPath = join(TRASH, x.path.slice(TRASH.length + 1).split("/")[0]);
    await base.load(store, [new Miss("byKey", keyOf(topPath))]);
    const tid = base.byKey.get(keyOf(topPath));
    const top = tid && tid !== ABSENT ? got(tid) : undefined;
    if (top?.trashed && top.kind === "folder") cands.set(top.id, top);
  }
  const out: { id: string; path: string; count: number }[] = [];
  for (const c of cands.values()) {
    const n = await store.count(keyOf(c.path));
    if (n > chunk) out.push({ id: c.id, path: c.path, count: n });
  }
  return out;
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
export async function runOp(base: PartialIndex, store: Store, op: SyncOp, opts: { carried?: number; budget?: number; alone?: boolean; dirty?: number; check?: (ov: Overlay, outcome: Outcome) => string | undefined } = {}): Promise<OpResult | { trial: number }> {
  let units = opts.carried ?? 0;
  // (the ceiling in force, every live population counted against it before it is allocated (daybreak3's
  // LIMIT-PR65-IMPL-1): alone, the op's own; in a page, the page's, with its dirty set beside the base)
  const limit = opts.alone ? OVERLAY.opMemory : OVERLAY.pageMemory;
  base.limit = limit;
  base.extra = opts.dirty ?? 0;
  const over = () => {
    if (opts.alone) throw new Halt(`sync: an op (seq ${op.seq}) would hold more than ${OVERLAY.opMemory} memory units`);
    return { trial: units };
  };
  try {
    await preload(base, store, op);
  } catch (e) {
    if (e instanceof OverLimit) return over();
    throw e;
  }
  for (let round = 1; ; round++) {
    const ov = new Overlay(base);
    ov.limit = limit;
    let outcome: Outcome | undefined, escaped: unknown;
    try {
      outcome = reduce(ov.index, op);
    } catch (e) {
      // (whatever escapes, the reducer's own undo included: the overlay's flag decides, astra's note on r2)
      escaped = e;
    }
    units += ov.units;
    if (units > OVERLAY.opUnits) throw new Halt(`sync: an op (seq ${op.seq}) took more than ${OVERLAY.opUnits} units`);
    // (an allocation refused: the overlay discarded whole, whatever reduce returned)
    if (ov.over) return over();
    if (ov.dirty) {
      if (round >= OVERLAY.rounds) throw new Halt(`sync: an op (seq ${op.seq}) still missed after ${OVERLAY.rounds} rounds`);
      let learned: number;
      try {
        learned = await base.load(store, ov.missed);
      } catch (e) {
        if (e instanceof OverLimit) return over();
        throw e;
      }
      if (learned === 0) throw new Halt(`sync: an op (seq ${op.seq}) missed without anything to load`);
      continue;
    }
    if (escaped !== undefined || !outcome) throw new Halt(`sync: the reducer failed on seq ${op.seq}: ${String(escaped).slice(0, 200)}`);
    const memory = ov.total();
    // (a trial past the page's budget: discarded, the page cut before it; its units go with it)
    if (!opts.alone && opts.budget !== undefined && units - (opts.carried ?? 0) > opts.budget) return { trial: units };
    // (a check the reduction can't make itself (D11: a hidden subtree's bounds): failed, the op skipped whole, nothing
    // of it merged)
    const why = !outcome.skipped && opts.check ? opts.check(ov, outcome) : undefined;
    if (why !== undefined) return { outcome: { changed: [], skipped: why }, units, rounds: round, memory };
    ov.merge(outcome.changed);
    return { outcome, units, rounds: round, memory };
  }
}

/** A page of ops run over a fresh base: as many as fit its budgets, at least one.  Returns what was reduced (the ops
 * taken, their changed identities) and the base to write from; `carried` is the next op's units if it was cut as a
 * trial. */
/** (D11) a page's large ops: found (each with more than `chunk` descendants to relocate), and the one `ready` (its
 * preflight done: its hidden folders and its bounds' check) run alone, hidden. */
export type LargeOpts = { chunk: number; ready?: { seq: number; hidden: Hidden[]; check: (ov: Overlay, outcome: Outcome) => string | undefined } };
export type PageResult = { base: PartialIndex; taken: number; changed: Set<string>; units: number; carry: number; outcomes: Outcome[]; large?: { cands: { id: string; path: string; count: number }[]; ran?: boolean } };

export async function runPage(store: Store, ops: SyncOp[], carried = 0, large?: LargeOpts): Promise<PageResult> {
  const base = new PartialIndex(), changed = new Set<string>(), outcomes: Outcome[] = [];
  let units = 0, carry = carried;
  for (let i = 0; i < ops.length; i++) {
    const alone = i === 0;
    if (large) {
      // (a large op: the page cut before it; first in its page, it waits for its preflight, then runs alone, hidden,
      // and the page is cut after it (D11 r2 §1, §3))
      const cands = await largeOf(base, store, ops[i], large.chunk);
      if (cands.length) {
        if (i > 0 || !large.ready || large.ready.seq !== ops[i].seq) return { base, taken: i, changed, units, carry: 0, outcomes, large: { cands } };
        base.hidden = large.ready.hidden;
        base.hiddenOp = ops[i];
        const r = await runOp(base, store, ops[i], { carried: carry, alone: true, check: large.ready.check });
        if ("trial" in r) throw new Halt(`sync: a large op (seq ${ops[i].seq}) as a trial`);
        for (const id of r.outcome.changed) changed.add(id);
        outcomes.push({ changed: [], ...(r.outcome.skipped !== undefined ? { skipped: r.outcome.skipped } : {}) });
        return { base, taken: 1, changed, units: r.units, carry: 0, outcomes, large: { cands, ran: true } };
      }
    }
    const r = await runOp(base, store, ops[i], { carried: carry, budget: OVERLAY.pageUnits - units, alone, dirty: changed.size });
    carry = 0;
    if ("trial" in r) return { base, taken: i, changed, units, carry: r.trial, outcomes };
    units += r.units;
    for (const id of r.outcome.changed) changed.add(id);
    // (its changed array let go at once: only whether it was skipped is kept)
    outcomes.push({ changed: [], ...(r.outcome.skipped !== undefined ? { skipped: r.outcome.skipped } : {}) });
  }
  return { base, taken: ops.length, changed, units, carry: 0, outcomes };
}

/** An identity's entry in `base`, loaded from `store` first if the base doesn't know it (the view, C3). */
export async function entryIn(base: PartialIndex, store: Store, id: string): Promise<SyncEntry | undefined> {
  if (!base.byId.has(id)) await base.load(store, [new Miss("byId", id)]);
  const v = base.byId.get(id);
  return v === undefined || v === ABSENT ? undefined : v;
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
