// The sync client's pins and pending summary (design/sync-client.md C2, "As built"), kept in the workspace's own
// transactions: what each local change, scan page and decision writes about the bytes committed here and not
// yet decided, and about what is waiting to go up for each identity.
//
// - Sync is on while `sync:current` is a lease that isn't off.  A lease's generation (`gen`) only fences stale
//   writers: a reconnect takes a new one and drops nothing.  The lifecycle epoch (`sync:epoch`) moves only when
//   sync is turned off, the person signs out, or the namespace changes: every pin is tagged with the epoch it was
//   taken in, and the paged purge after such a change (cleanPins) releases only pins of an older epoch, checked in
//   the releasing transaction, so a purge never touches what a later lease pinned.  A namespace's own state
//   (watermark, sequence, outbox, and its pending fields) is kept across off and on and across switches.
// - A pin, `pins[id, seq]`, is taken in the transaction of the local change that commits new bytes (create,
//   write, adopt of a data file): {path, sha256, size, epoch}; `storage`, where its bytes are (`skey`, the index
//   byStorage's key: "f:<fid>" for fileBytes, "v:<version>" for a version kept apart); `orphan`, its file's entry
//   removed for good meanwhile; `owner`, the record ({ns, dseq}) a scan handed it to.  Each file's pin on its
//   present bytes is pointed to from meta (`sync:cur:<fid>`), and whether any other pin names a storage is one
//   count on byStorage: no ownership question scans pins.  `sync:pinBytes` totals the bytes pins keep of their
//   own (kept apart or orphaned), within the cap.
// - A pin is released (release) in one transaction with everything it implies: the total down; its version, if
//   kept apart, no longer exempt once no pin names it; orphaned bytes deleted with the last pin naming them, if no
//   entry names the fid; and, if a record owns it (or its bytes are let go before upload), that record marked
//   unpinned and `sync:skipped` noted: an owned pin never goes silently.
// - The pending summary, `pending[id]`: `latest`, the newest local op (seq, author, what it left), kept across
//   namespaces; and each namespace's own state in `byNs[ns]` (allocated, acceptedTip, held, collapsed, cutoff,
//   successor), so a namespace never inherits another's.
// Every rule here reads and writes one pending record and a bounded number of pins: none walks the ops' tail.
import type { Entry, Op, OpAfter, Version, Workspace } from "./api";
import { inTx, req } from "./db";
import { bytesHash } from "../notebook/stores.js";
import type { Release } from "./reserve";
import { hubOf } from "./sync-ledger";

export const PINS = {
  /** the cap on bytes pins keep of their own; less where the browser's quota is smaller: half its estimated
   * free space at the time (capNow) */
  capBytes: 2 ** 30,
  /** pins released at once by a collapse, in the save's transaction (a few, so that a collapsing save stays
   * within its 64 IndexedDB calls); the rest by cleanPins, begun after the save returns */
  collapseRelease: 2,
  /** each cleanup slice, one transaction: at most `examine` records read a step, and at most `requests`
   * IndexedDB requests made (an item is begun only while its costliest outcome still fits); then the next slice,
   * after a timer, until nothing durable is left (daybreak2's LIMIT-E5C-1) */
  slice: { examine: 100, requests: 400 },
  /** files listed as "some intermediate versions weren't uploaded" */
  skippedList: 100,
  /** (tests: a change's transaction failing right after its pin is taken) */
  failAfterPin: false,
  /** (tests: the cleanup a collapsing save begins waits for this first) */
  cleanAfter: null as Promise<unknown> | null,
  /** (tests: awaited between the cleanup's slices) */
  afterSlice: null as null | (() => Promise<unknown>),
  /** (tests: called in bytesFor's transaction right after the value is read, before anything is marked or
   * committed: throwing aborts it, as a page killed there would) */
  cutAfterRead: null as null | ((rec: { id: string; op: { sha256?: string } }) => void),
};
/** The stores a local change's transaction takes for this, besides its own. */
export const SYNC_STORES = ["pending", "pins", "meta"];
/** The stores release needs: a pin kept apart has a version, an orphan has bytes, an owner has its pending record. */
export const RELEASE_STORES = ["pending", "pins", "meta", "versions", "versionBytes", "prunable", "entries", "fileBytes"];

type Storage = { fileBytes: string } | { version: number };
export type Pin = { id: string; seq: number; path: string; sha256: string; size: number; epoch: number; storage: Storage; skey: string; orphan?: boolean; owner?: { ns: string; dseq: number } };
/** A namespace's own pending state for an identity. */
export type NsState = {
  /** its newest write record not refused, and its decision so far */
  allocated?: { dseq: number; sha256?: string; pinned: boolean; state: "undecided" | "accepted" | "confirmed" };
  /** the newest accepted record (by dseq) not yet confirmed */
  acceptedTip?: { dseq: number; sha256?: string };
  /** a seq at or below which its writes aren't sent: collapsed past the cap */
  collapsed?: number;
  /** a seq at or below which its writes are already represented (a successor's snapshot) */
  cutoff?: number;
  /** a write passed over while an unpinned record waits for its decision */
  held?: boolean;
  /** the current state to send once there is room, based on `base` (a held identity's, once its record was decided) */
  successor?: { base?: string };
  /** (task #14) the newest held write's seq: its ledger row goes to the successor that carries it */
  heldSeq?: number;
};
/** `latest.movedAt`: the seq of the identity's last op that placed it (made, moved, put in Trash or out, removed for
 * good).  Past the scan watermark, the view (C3) takes its placement from `after`; a write alone leaves the placement
 * to the confirmed index.  Carried from op to op, so a save reads nothing more. */
export type Pending = { id: string; latest?: { seq: number; by: string; after: OpAfter | null | undefined; movedAt?: number }; byNs?: Record<string, NsState> };
const PLACING = new Set(["create", "adopt", "mkdir", "rename", "remove", "restore", "forget", "emptyTrash", "discard"]);
export type Skipped = { count: number; files: string[] };
type Purge = { epoch: number; cursor?: [string, number] };

export const skeyOf = (s: Storage) => ("fileBytes" in s ? "f:" + s.fileBytes : "v:" + s.version);
const curKey = (fid: string) => "sync:cur:" + fid;
// (a fid whose bytes were orphaned (its entry removed for good while they were pinned): the sweep's only candidates,
// so it never looks at a file's own bytes (an entry not yet given its identity key would look unnamed))
const ORPHAN = "sync:orphan:";
const own = (p: Pin) => "version" in p.storage || !!p.orphan;
/** How many pins name storage `s` (one index count). */
export const refs = async (pins: IDBObjectStore, s: Storage) => req(pins.index("byStorage").count(skeyOf(s)));

type Lease = { ns: string; gen: number; off?: boolean };
// (a save's sync bookkeeping reads the lease, the epoch and the pins' total once per transaction, not once per
// rule: each kept with its transaction, every write of one in that transaction going through metaWrite, which
// keeps it right; never outliving the transaction: dropped when it completes or aborts, so a read after it
// meets the closed transaction as any read would)
const once = new WeakMap<IDBTransaction, Map<string, unknown>>();
async function readOnce<T>(meta: IDBObjectStore, key: string): Promise<T | undefined> {
  const tx = meta.transaction;
  let m = once.get(tx);
  if (!m) {
    once.set(tx, (m = new Map()));
    const drop = () => once.delete(tx);
    tx.addEventListener("complete", drop);
    tx.addEventListener("abort", drop);
  }
  if (!m.has(key)) m.set(key, await req(meta.get(key)));
  return m.get(key) as T | undefined;
}
/** `v` written as meta's `key` in `meta`'s transaction, and so read there after (the lease, the epoch, the total). */
export const metaWrite = (meta: IDBObjectStore, key: string, v: unknown) => {
  meta.put(v, key);
  once.get(meta.transaction)?.set(key, v);
};
/** The lease now, if sync is on (one exists and isn't off), read in `meta`'s transaction. */
export async function liveLease(meta: IDBObjectStore): Promise<Lease | undefined> {
  const cur = await readOnce<Lease>(meta, "sync:current");
  return cur && !cur.off ? cur : undefined;
}
export const syncOn = async (meta: IDBObjectStore) => (await liveLease(meta)) !== undefined;
export const epochOf = async (meta: IDBObjectStore) => (await readOnce<number>(meta, "sync:epoch")) ?? 0;

/** The cap on bytes pins keep now: PINS.capBytes, or half the estimated free space if that is less (read before
 * any transaction; advisory: a save that then meets the quota fails whole, nothing half-pinned). */
// (every save asks, sync on or not, so the browser's estimate is asked at most every 2 s)
let halfFree = Infinity, askedAt = -Infinity;
export async function capNow(): Promise<number> {
  const now = performance.now();
  if (now - askedAt >= 2000) {
    askedAt = now;
    halfFree = Infinity;
    try {
      const est = await (globalThis.navigator as any)?.storage?.estimate?.();
      if (est && typeof est.quota === "number" && typeof est.usage === "number") halfFree = Math.max(0, Math.floor((est.quota - est.usage) / 2));
    } catch {}
  }
  return Math.min(PINS.capBytes, halfFree);
}

export const pinTotal = async (meta: IDBObjectStore) => (await readOnce<number>(meta, "sync:pinBytes")) ?? 0;
const setTotal = (meta: IDBObjectStore, n: number) => metaWrite(meta, "sync:pinBytes", Math.max(0, n));

/** The pending record of `id` (or a new one), and namespace `ns`'s state in it. */
export async function pendingOf(tx: IDBTransaction, id: string): Promise<Pending> {
  return ((await req(tx.objectStore("pending").get(id))) as Pending | undefined) ?? { id };
}
export const stateOf = (p: Pending, ns: string): NsState => p.byNs?.[ns] ?? {};
/** `p` with namespace `ns`'s state `s` (none when nothing is pending for it there), written, or deleted when
 * nothing is pending at all (no namespace's state, and its latest op scanned: `scanned`). */
export function putPending(tx: IDBTransaction, p: Pending, ns: string, s: NsState, scanned: number | undefined) {
  const settled = (!s.allocated || s.allocated.state === "confirmed") && !s.acceptedTip && !s.held && !s.successor;
  const keep: NsState = settled ? { ...(s.collapsed !== undefined ? { collapsed: s.collapsed } : {}), ...(s.cutoff !== undefined ? { cutoff: s.cutoff } : {}), ...(s.allocated ? { allocated: s.allocated } : {}) } : s;
  const byNs = { ...(p.byNs ?? {}) };
  const latestDone = !p.latest || (scanned !== undefined && p.latest.seq <= scanned);
  // (a settled state is dropped once its identity's latest op is scanned: its cutoff and collapse mark are
  // then below the watermark, so nothing left can be skipped by them, and its base is the confirmed index's)
  if (settled && latestDone) delete byNs[ns];
  else byNs[ns] = keep;
  const ps = tx.objectStore("pending");
  if (!Object.keys(byNs).length && latestDone) ps.delete(p.id);
  else ps.put({ id: p.id, ...(p.latest ? { latest: p.latest } : {}), ...(Object.keys(byNs).length ? { byNs } : {}) });
}

/** The op `rec` (just added, its seq known) noted as its identity's latest, in its change's transaction, and,
 * for a data file's new bytes (`pin`), those bytes pinned, tagged with the epoch.  Nothing if sync is off. */
export async function noteChange(tx: IDBTransaction, rec: Op, pin: boolean) {
  const meta = tx.objectStore("meta");
  // (a change applied from the server is no local intent: nothing pending, nothing pinned (C3))
  if (rec.origin === "server" || !(await syncOn(meta))) return;
  const id = rec.after?.id ?? rec.fid ?? rec.ref;
  if (!id) return;
  const ps = tx.objectStore("pending");
  const cur = ((await req(ps.get(id))) as Pending | undefined) ?? { id };
  const movedAt = PLACING.has(rec.op) ? rec.seq! : cur.latest?.movedAt;
  ps.put({ ...cur, latest: { seq: rec.seq!, by: rec.by, after: rec.after, ...(movedAt !== undefined ? { movedAt } : {}) } });
  if (pin && rec.sha256 && rec.size !== undefined && rec.fid) await pinPresent(tx, id, rec.seq!, rec.path, rec.sha256, rec.size, rec.fid);
  // (tests: a save failing after its pin, as one meeting the quota would: the whole change refused)
  if (PINS.failAfterPin) throw new DOMException("the quota (a test's)", "QuotaExceededError");
}
/** A pin on a data file's present bytes, at (`id`, `seq`), pointed to as its present one. */
export async function pinPresent(tx: IDBTransaction, id: string, seq: number, path: string, sha256: string, size: number, fid: string, owner?: Pin["owner"]): Promise<Pin> {
  const meta = tx.objectStore("meta"), storage = { fileBytes: fid };
  const p: Pin = { id, seq, path, sha256, size, epoch: await epochOf(meta), storage, skey: skeyOf(storage), ...(owner ? { owner } : {}) };
  tx.objectStore("pins").put(p);
  meta.put(seq, curKey(fid));
  return p;
}

/** The pin on a data file's present bytes (`fid`, `sha256`), if any: one lookup. */
export async function pinOfCurrent(tx: IDBTransaction, fid: string, sha256: string | undefined): Promise<Pin | undefined> {
  if (!sha256) return undefined;
  const seq = (await req(tx.objectStore("meta").get(curKey(fid)))) as number | undefined;
  if (seq === undefined) return undefined;
  const p = (await req(tx.objectStore("pins").get([fid, seq]))) as Pin | undefined;
  return p && p.sha256 === sha256 && "fileBytes" in p.storage && !p.orphan ? p : undefined;
}
async function dropCurrent(meta: IDBObjectStore, p: Pin) {
  if (!("fileBytes" in p.storage)) return;
  const k = curKey(p.storage.fileBytes);
  if (((await req(meta.get(k))) as number | undefined) === p.seq) meta.delete(k);
}

/** Pin `p` charged with bytes of its own (kept apart as `version`, or orphaned), if the cap allows, in `tx`
 * (RELEASE_STORES).  Past the cap it is released instead (unpinned, said).  Returns whether it was kept. */
export async function charge(tx: IDBTransaction, p: Pin, how: { version: number } | { orphan: true }, cap: number, current = false): Promise<boolean> {
  const meta = tx.objectStore("meta"), t = await pinTotal(meta);
  if (t + p.size > cap) {
    await release(tx, p, true);
    return false;
  }
  // (`current`: the caller found `p` through its file's pointer and points it at the file's new bytes' pin in this
  // transaction; were it not repointed, it would name a pin kept apart, which pinOfCurrent never takes as present)
  if (!current) await dropCurrent(meta, p);
  if ("version" in how) {
    const storage = { version: how.version };
    tx.objectStore("pins").put({ ...p, storage, skey: skeyOf(storage) });
  } else {
    tx.objectStore("pins").put({ ...p, orphan: true });
    meta.put(1, ORPHAN + (p.storage as { fileBytes: string }).fileBytes);
  }
  setTotal(meta, t + p.size);
  return true;
}

/** Pin `p` released, in `tx` (RELEASE_STORES), with everything it implies, all in this transaction (see above).
 * `skipped`: its bytes let go before upload, said in `sync:skipped` even if no record owns it yet.  `present`: the
 * caller knows its file is there (the save of it). */
export async function release(tx: IDBTransaction, p: Pin, skipped = false, present = false) {
  const pins = tx.objectStore("pins"), meta = tx.objectStore("meta");
  pins.delete([p.id, p.seq]);
  if (own(p)) setTotal(meta, (await pinTotal(meta)) - p.size);
  await dropCurrent(meta, p);
  const left = await refs(pins, p.storage);
  if ("version" in p.storage) {
    const vs = tx.objectStore("versions"), v = (await req(vs.get(p.storage.version))) as Version | undefined;
    if (v?.pinned && left === 0) await unpinOrDrop(tx, v, true, present);
  } else if (p.orphan && left === 0) {
    // (orphaned bytes go with the last reference to them: no pin naming them, no entry (from step 4, no journal
    // record either))
    const fid = p.storage.fileBytes;
    if ((await req(tx.objectStore("entries").index("byIdent").count(fid))) === 0) tx.objectStore("fileBytes").delete(fid);
    meta.delete(ORPHAN + fid);
  }
  if (p.owner) {
    const ps = tx.objectStore("pending"), cur = (await req(ps.get(p.id))) as Pending | undefined;
    const s = cur?.byNs?.[p.owner.ns];
    if (cur && s?.allocated?.dseq === p.owner.dseq) ps.put({ ...cur, byNs: { ...cur.byNs, [p.owner.ns]: { ...s, allocated: { ...s.allocated, pinned: false } } } });
  }
  if (p.owner || skipped) await noteSkipped(meta, p.path);
}

/** `v` no longer kept for sync, in `tx`: exempt no more, and prunable (db.ts, version 5); its file marked due from
 * its oldest (`due`), since a version prunable again may be behind the cleanup's cursor for that file, or past its
 * count (astra's round 3): three writes. */
export function unpin(tx: IDBTransaction, v: Version, due = true) {
  const { pinned: _p, ...rest } = v;
  tx.objectStore("versions").put(rest);
  tx.objectStore("prunable").put(prunableOf(v));
  if (due) markDue(tx, v.fid);
}
/** `fid`'s versions due for the cleanup from its oldest, and the bytes bound checked again (a version prunable
 * again may be what it needs), in `tx`, once a transaction each; the cleanup begun after it commits (afterReleases). */
export function markDue(tx: IDBTransaction, fid: string) {
  let m = marked.get(tx);
  if (!m) marked.set(tx, (m = new Set()));
  if (m.has(fid)) return;
  m.add(fid);
  const meta = tx.objectStore("meta");
  meta.put(1, VDUE + fid);
  if (!m.has("")) { m.add(""); meta.put(1, VOVER); }
  dueIn.add(tx.db);
}
const marked = new WeakMap<IDBTransaction, Set<string>>();
const dueIn = new WeakSet<IDBDatabase>();
/** (after a change that may have left the cleanup work (versions due, a purge recorded): the cleanup begun) */
export function afterReleases(w: Workspace) {
  if (!dueIn.has(w.ws)) return;
  dueIn.delete(w.ws);
  void scheduleClean(w);
}
/** A pinned version released, in `tx`: prunable, if its file is still there; else deleted, as the file's deletion
 * would have deleted it but for the pin (it never becomes prunable for a file deleted for good: astra's round 3). */
export async function unpinOrDrop(tx: IDBTransaction, v: Version, due = true, present = false) {
  if (present || (await req(tx.objectStore("entries").index("byIdent").count(v.fid))) > 0) return unpin(tx, v, due);
  const meta = tx.objectStore("meta");
  tx.objectStore("versions").delete(v.id!);
  tx.objectStore("versionBytes").delete(v.id!);
  meta.put(Math.max(0, (((await req(meta.get("versionBytes"))) as number | undefined) ?? 0) - v.size), "versionBytes");
}
/** The prunable record of version `v`. */
export const prunableOf = (v: Version) => ({ fid: v.fid, id: v.id!, t: v.t, size: v.size });

/** Bytes not uploaded, noted for the Sync panel: "some intermediate versions weren't uploaded", with the file. */
export async function noteSkipped(meta: IDBObjectStore, path: string) {
  const s = ((await req(meta.get("sync:skipped"))) as Skipped | undefined) ?? { count: 0, files: [] };
  s.count++;
  if (!s.files.includes(path)) s.files = [...s.files, path].slice(-PINS.skippedList);
  meta.put(s, "sync:skipped");
}

/** A save past the cap (C2), in the save's transaction (RELEASE_STORES), before its op is logged: namespace `ns`'s
 * unscanned writes of `id` collapsed (`collapsed`, its previous latest seq: one record written), and at most
 * PINS.collapseRelease of their unowned pins released now, by the [id, seq] key range; cleanPins does the rest. */
export async function collapse(tx: IDBTransaction, id: string, ns: string): Promise<boolean> {
  const ps = tx.objectStore("pending"), cur = (await req(ps.get(id))) as Pending | undefined;
  if (!cur?.latest) return false;
  const upTo = cur.latest.seq, s = stateOf(cur, ns);
  ps.put({ ...cur, byNs: { ...(cur.byNs ?? {}), [ns]: { ...s, collapsed: Math.max(s.collapsed ?? 0, upTo) } } });
  const some = ((await req(tx.objectStore("pins").getAll(IDBKeyRange.bound([id, -Infinity], [id, upTo]), PINS.collapseRelease * 2))) as Pin[]).filter((p) => !p.owner).slice(0, PINS.collapseRelease);
  await releaseUnowned(tx, some);
  return true;
}
/** Unowned pins of one identity released together (a collapse's): as release, its totals and its note written once. */
async function releaseUnowned(tx: IDBTransaction, list: Pin[]) {
  if (!list.length) return;
  const pins = tx.objectStore("pins"), meta = tx.objectStore("meta"), vs = tx.objectStore("versions");
  let freed = 0;
  for (const p of list) {
    pins.delete([p.id, p.seq]);
    if (own(p)) freed += p.size;
    if ("version" in p.storage) {
      // (one pin per storage: its version no longer exempt)
      const v = (await req(vs.get(p.storage.version))) as Version | undefined;
      // (the file is the one being saved: there; its due mark written once, below)
      if (v?.pinned) unpin(tx, v, false);
    } else await dropCurrent(meta, p);
  }
  if (freed) setTotal(meta, (await pinTotal(meta)) - freed);
  if (list.some((p) => "version" in p.storage)) markDue(tx, list[0].id);
  await noteSkipped(meta, list[0].path);
}

/** Turning sync off or signing out: one transaction.  The lease takes a new, higher generation, marked off
 * (every lease taken before fenced; never deleted, so none comes back), the lifecycle epoch moves on, and a
 * purge of every pin of an older epoch is recorded, which cleanPins does a page at a time.  The namespace's
 * own state is kept: re-enabling (switchTo the same namespace) resumes it. */
export async function syncOff(w: Workspace): Promise<void> {
  await syncOffIf(w);
}
/** This browser's sync lifecycle as an action saw it (step 5, astra3's CORR-PR130-1): the namespace (null: none), off,
 * and the lifecycle epoch.  Renewals raise the lease's generation only, so they leave it unchanged. */
export type LifeMark = { ns: string | null; off: boolean; epoch: number };
export const sameLife = (a: LifeMark, b: LifeMark) => a.ns === b.ns && a.off === b.off && a.epoch === b.epoch;
/** The lifecycle now, read in `meta`'s transaction. */
export async function lifeMarkOf(meta: IDBObjectStore): Promise<LifeMark> {
  const cur = (await req(meta.get("sync:current"))) as Lease | undefined;
  return { ns: cur?.ns ?? null, off: !cur || !!cur.off, epoch: ((await req(meta.get("sync:epoch"))) as number | undefined) ?? 0 };
}
/** The lifecycle now (its own transaction). */
export function readLife(w: Workspace): Promise<LifeMark> {
  return inTx(w.ws, "meta", "readonly", (tx) => lifeMarkOf(tx.objectStore("meta")));
}
/** Why sync was turned off here, kept in the lease for the sidebar's line: "deleted" for this device's "Delete my
 * synced data". */
export type OffWhy = "deleted";
/** syncOff, and with `expect` only as a compare-and-set: if this browser's lifecycle is still the one the action saw,
 * in the same transaction; otherwise nothing is written (a late answer never turns off a newer lifecycle).  Returns
 * whether it applied (true too when sync was already off and that was expected). */
export async function syncOffIf(w: Workspace, expect?: LifeMark, why?: OffWhy): Promise<boolean> {
  const r = await inTx(w.ws, ["meta"], "readwrite", async (tx) => {
    const meta = tx.objectStore("meta");
    if (expect && !sameLife(await lifeMarkOf(meta), expect)) return { applied: false, ended: null };
    const cur = (await req(meta.get("sync:current"))) as Lease | undefined;
    if (!cur || cur.off) return { applied: true, ended: null };
    metaWrite(meta, "sync:current", { ns: cur.ns, gen: cur.gen + 1, off: true, ...(why ? { why } : {}) });
    const fromEpoch = await epochOf(meta);
    await newEpoch(meta);
    return { applied: true, ended: { ns: cur.ns, fromEpoch } };
  });
  // (the waits of that epoch told it ended (task #14): by type, past their epoch filter)
  if (r.ended) hubOf(w.ws).post({ t: "lifecycle", ns: r.ended.ns, fromEpoch: r.ended.fromEpoch, toEpoch: r.ended.fromEpoch + 1, kind: "off" });
  afterReleases(w);
  return r.applied;
}
/** The lifecycle epoch moved on (off, sign-out, a namespace switch), in `meta`'s transaction, and the purge of
 * every pin of an older one recorded. */
export async function newEpoch(meta: IDBObjectStore) {
  // (the purge recorded: the cleanup begun after this change commits (afterReleases))
  dueIn.add(meta.transaction.db);
  const e = (await epochOf(meta)) + 1;
  metaWrite(meta, "sync:epoch", e);
  meta.put({ epoch: e } satisfies Purge, "sync:purge");
}

/** meta: a file whose versions a save left past the count or the age, for the cleanup; versions past the bytes;
 * the versions kept before database v5 not yet made prunable (db.ts), from the last id done */
export const VDUE = "versions:due:", VOVER = "versions:over", BACKFILL = "versions:backfill";
/** meta: a file emptied from Trash whose versions are still being deleted (api.ts emptyTrash), for the cleanup to
 * finish should that be cut short (a reload). */
export const GONE = "versions:gone:";

/** A page of `fid`'s versions by the index byFile (`index`, keyed [fid, t]), from just after `after` (its last key
 * and id), at most `limit`: one request (getAll from that key, those at it already looked at passed over), so a
 * page of versions kept for sync is never read again.  Only should a whole page share one key (as many versions
 * kept in one millisecond) does it go by a key cursor instead, one request a record. */
export async function filePage(index: IDBIndex, fid: string, after: [IDBValidKey, number] | null, limit: number): Promise<{ list: Version[]; last: [IDBValidKey, number] | null; end: boolean }> {
  const raw = (await req(index.getAll(IDBKeyRange.bound(after ? after[0] : [fid, -Infinity], [fid, Infinity]), limit))) as Version[];
  const t = after ? (after[0] as [string, number])[1] : -Infinity;
  const list = after ? raw.filter((v) => v.t > t || (v.t === t && v.id! > after[1])) : raw;
  if (after && raw.length === limit && list.length === 0) return filePageByCursor(index, fid, after, limit);
  const lastV = list[list.length - 1];
  return { list, last: lastV ? [[fid, lastV.t], lastV.id!] : after, end: raw.length < limit };
}
function filePageByCursor(index: IDBIndex, fid: string, after: [IDBValidKey, number] | null, limit: number): Promise<{ list: Version[]; last: [IDBValidKey, number] | null; end: boolean }> {
  return new Promise((ok, no) => {
    const r = index.openCursor(IDBKeyRange.bound([fid, -Infinity], [fid, Infinity]));
    const list: Version[] = [];
    let moved = !after, last = after;
    r.onsuccess = () => {
      const c = r.result;
      if (!c) return ok({ list, last, end: true });
      if (!moved) {
        moved = true;
        // (past the last one looked at: to it, then (if it is still there) one more)
        if (indexedDB.cmp(c.key, after![0]) < 0 || (indexedDB.cmp(c.key, after![0]) === 0 && (c.primaryKey as number) < after![1])) { c.continuePrimaryKey(after![0], after![1]); return; }
      }
      if (after && list.length === 0 && indexedDB.cmp(c.key, after[0]) === 0 && c.primaryKey === after[1]) { c.continue(); return; }
      list.push(c.value as Version);
      last = [c.key, c.primaryKey as number];
      if (list.length >= limit) return ok({ list, last, end: false });
      c.continue();
    };
    r.onerror = () => no(r.error);
  });
}

/** The most requests one release makes (release, above): the pin's delete; the total's read and write; the
 * pointer's read and delete; the storage count; a version's read, its file's count, and three writes (or two
 * deletes and the total's read and write), or an orphan's entry count and two deletes; an owner's pending read and write; the skipped note's read and write. */
export const RELEASE_COST = 18;
/** The most requests one orphan marker costs the sweep: the storage count, the entry count, two deletes. */
const SWEEP_COST = 4;
type Tag = { ns: string; epoch: number };

/** The cleanup, a slice at a time until nothing durable is left (each slice one transaction, all of it or none,
 * within PINS.slice's records and requests, a timer between slices, each step going on from a durable cursor):
 * (1) a lifecycle change's purge (every pin of an older epoch released, checked in that transaction); (2) the pins
 * of collapsed writes (seq at or below their identity's `collapsed`, unowned) released; (3) orphaned bytes (marked
 * when orphaned) that no pin and no entry names any more, deleted; (4) versions a save left due (past a file's
 * count or age, or past the bytes) dropped (Workspace.versionsSlice).  Begun at each start (the migrator's), after
 * a collapse, a lifecycle change, or a save that left versions due (scheduleClean).  `tag`, a collapsing save's
 * (its namespace and lifecycle epoch, P1): (2) then releases only pins of that epoch or older collapsed in that
 * namespace, checked in each slice's transaction, so a run that starts after a later save, or after sync was
 * turned off and on, never takes a pin made since. */
export async function cleanPins(w: Workspace, tag?: Tag): Promise<void> {
  while (!w.closed && (await cleanSlice(w, tag))) {
    await new Promise((r) => setTimeout(r, 0));
    if (PINS.afterSlice) await PINS.afterSlice();
  }
}
/** The cleanup begun after whatever cleanup is under way (one at a time; the same one asked again while it
 * waits, not twice), for the workspace's tests to wait for as `w.pinsCleaning`. */
export function scheduleClean(w: Workspace, tag?: Tag): Promise<unknown> {
  const k = tag ? tag.ns + ":" + tag.epoch : "";
  const queued = (w.pinsQueued ??= new Set());
  if (queued.has(k)) return w.pinsCleaning!;
  queued.add(k);
  const run = (w.pinsCleaning ?? Promise.resolve())
    .then(() => new Promise((r) => setTimeout(r, 0)))
    .then(() => PINS.cleanAfter)
    .then(() => { queued.delete(k); return cleanPins(w, tag); })
    .catch((err) => { queued.delete(k); console.warn("workspace: sync's pins:", err); });
  w.pinsCleaning = run;
  return run;
}

/** One page of the backfill, in `tx` (the cleanup's stores), within `left` requests: the versions kept before
 * database v5 made prunable, from the last id done (BACKFILL's `after`) up to its end, fixed when it began
 * (`through`, the newest version's id then: those saved since have prunable records of their own and are never its
 * to walk, so however fast they come it ends: daybreak2's round 4).  Each one not pinned is put in the prunable
 * store (a put: one there already is the same after), and a file already due has its cursor rewound to its oldest
 * (it may be past it: astra's round 3); one whose file is gone for good is deleted instead, as the deletion would
 * have (never made prunable: astra's round 3), once the migrator has given every entry its identity (until then a
 * file's absence can't be told).  At the end, the bytes bound checked again.  Saves go on meanwhile: a version not
 * yet done has no prunable record, so it is kept.  Whether there was a page to do (false: the backfill is over). */
export async function backfillPage(tx: IDBTransaction, w: Workspace, n: number, left: number): Promise<false | { at: number; through: number }> {
  const meta = tx.objectStore("meta");
  const bf = (await req(meta.get(BACKFILL))) as { after: number; through?: number } | undefined;
  if (!bf) return false;
  const vs = tx.objectStore("versions"), vb = tx.objectStore("versionBytes"), pr = tx.objectStore("prunable"), byIdent = tx.objectStore("entries").index("byIdent");
  // (the marker, the end's key cursor, the migration's state, the page, the marker's write, the total's read and write)
  left -= 8;
  if (bf.through === undefined) bf.through = await new Promise<number>((ok, no) => { const c = vs.openKeyCursor(null, "prev"); c.onsuccess = () => ok((c.result?.key as number | undefined) ?? 0); c.onerror = () => no(c.error); });
  const identities = !!((await req(meta.get("migration"))) as { done?: boolean } | undefined)?.done;
  // (each version at most: its file's gone mark, count and due read, and three writes (prunable, its due marks) or
  // two deletes)
  const want = Math.max(1, Math.min(n, Math.floor(left / 6)));
  const list = bf.after >= bf.through ? [] : ((await req(vs.getAll(IDBKeyRange.bound(bf.after, bf.through, true, false), want))) as Version[]);
  const there = new Map<string, boolean>(), due = new Set<string>();
  let gone = 0;
  for (const v of list) {
    if (v.pinned) continue;
    if (!there.has(v.fid)) there.set(v.fid, (await req(meta.get(GONE + v.fid))) === undefined && (!identities || (await req(byIdent.count(v.fid))) > 0));
    if (!there.get(v.fid)) {
      vs.delete(v.id!);
      vb.delete(v.id!);
      gone += v.size;
      continue;
    }
    pr.put(prunableOf(v));
    // (a file already due: its cursor rewound to its oldest, so the version just made prunable isn't passed by;
    // one not due stays so, an idle file's versions pruned only on its next save, as before v5)
    if (!due.has(v.fid)) {
      due.add(v.fid);
      if ((await req(meta.get(VDUE + v.fid))) !== undefined) markDue(tx, v.fid);
    }
  }
  const total = Math.max(0, (((await req(meta.get("versionBytes"))) as number | undefined) ?? 0) - gone);
  if (gone) meta.put(total, "versionBytes");
  const at = list.length ? list[list.length - 1].id! : bf.after;
  if (list.length === want && at < bf.through) meta.put({ after: at, through: bf.through }, BACKFILL);
  else {
    meta.delete(BACKFILL);
    if (total > w.limits.maxVersionBytes) meta.put(1, VOVER);
    return { at: bf.through, through: bf.through };
  }
  return { at, through: bf.through };
}
/** One file's versions kept before database v5 put in the prunable store, a page a transaction (a key cursor by
 * the index byFile), before a drop of that file's that needs them in the order they were kept (its newest `keep`,
 * a fence): bounded by that file's versions, whatever the rest of the backfill has left (@sagebrush's (b)).  Nothing
 * once the backfill is over; one already there is the same after (a put). */
export async function finishBackfillFor(w: Workspace, fid: string): Promise<void> {
  let at: [IDBValidKey, number] | null = null;
  for (;;) {
    const end = await inTx(w.ws, [...RELEASE_STORES], "readwrite", async (tx) => {
      const meta = tx.objectStore("meta");
      if ((await req(meta.get(BACKFILL))) === undefined) return true;
      const page = await filePage(tx.objectStore("versions").index("byFile"), fid, at, Math.floor((PINS.slice.requests - 8) / 2));
      const pr = tx.objectStore("prunable");
      for (const v of page.list) if (!v.pinned) pr.put(prunableOf(v));
      if (page.list.some((v) => !v.pinned) && (await req(meta.get(VDUE + fid))) !== undefined) markDue(tx, fid);
      at = page.last;
      return page.end;
    });
    if (end || w.closed) return;
    await new Promise((r) => setTimeout(r, 0));
  }
}

/** One slice of the cleanup, in one transaction: whether there may be more. */
async function cleanSlice(w: Workspace, tag?: Tag): Promise<boolean> {
  return inTx(w.ws, [...RELEASE_STORES, "versionBytes"], "readwrite", async (tx) => {
    const meta = tx.objectStore("meta"), pins = tx.objectStore("pins"), ps = tx.objectStore("pending");
    const n = PINS.slice.examine;
    let left = PINS.slice.requests;
    const spend = (c: number) => { left -= c; };
    const fits = (c: number) => left >= c;
    // (0) the versions kept before database v5 made prunable (backfillPage)
    const bf = await backfillPage(tx, w, n, left);
    if (bf) return true;
    spend(1);
    // (1) the purge: its read, the page, the cursor's write; each pin begun only while its release fits
    spend(3);
    const purge = (await req(meta.get("sync:purge"))) as Purge | undefined;
    if (purge) {
      const list = (await req(pins.getAll(purge.cursor ? IDBKeyRange.lowerBound(purge.cursor, true) : null, n))) as Pin[];
      let done = 0;
      for (const p of list) {
        if (!fits(RELEASE_COST)) break;
        if (p.epoch < purge.epoch) { await release(tx, p); spend(RELEASE_COST); }
        done++;
      }
      if (done === list.length && list.length < n) meta.delete("sync:purge");
      else if (done) meta.put({ ...purge, cursor: [list[done - 1].id, list[done - 1].seq] }, "sync:purge");
      return true;
    }
    // (2) collapsed writes' pins: the cursor's read and write, the page; a pending read for each identity
    spend(3);
    const at = (await req(meta.get("sync:pinCursor"))) as [string, number] | undefined;
    const list = (await req(pins.getAll(at ? IDBKeyRange.lowerBound(at, true) : null, n))) as Pin[];
    const seen = new Map<string, Pending | undefined>();
    let done = 0;
    for (const p of list) {
      if (!fits(1 + RELEASE_COST)) break;
      done++;
      if (p.owner) continue;
      if (!seen.has(p.id)) { spend(1); seen.set(p.id, (await req(ps.get(p.id))) as Pending | undefined); }
      const byNs = seen.get(p.id)?.byNs ?? {};
      const marks = tag ? (p.epoch <= tag.epoch && byNs[tag.ns] ? [byNs[tag.ns]] : []) : Object.values(byNs);
      if (marks.some((s) => s.collapsed !== undefined && p.seq <= s.collapsed)) { await release(tx, p, true); spend(RELEASE_COST); }
    }
    if (done < list.length || list.length === n) {
      meta.put([list[done - 1].id, list[done - 1].seq], "sync:pinCursor");
      return true;
    }
    meta.delete("sync:pinCursor");
    // (3) orphaned bytes no pin names any more: only fids marked when they were orphaned, never a file's own
    spend(3);
    const fat = (await req(meta.get("sync:bytesCursor"))) as string | undefined;
    const keys = (await req(meta.getAllKeys(IDBKeyRange.bound(fat ?? ORPHAN, ORPHAN + "￿", !!fat), n))) as string[];
    let swept = 0;
    for (const k of keys) {
      if (!fits(SWEEP_COST)) break;
      swept++;
      spend(SWEEP_COST);
      const fid = k.slice(ORPHAN.length);
      if ((await refs(pins, { fileBytes: fid })) > 0) continue;
      if ((await req(tx.objectStore("entries").index("byIdent").count(fid))) === 0) tx.objectStore("fileBytes").delete(fid);
      meta.delete(k);
    }
    if (swept < keys.length || keys.length === n) {
      meta.put(keys[swept - 1], "sync:bytesCursor");
      return true;
    }
    meta.delete("sync:bytesCursor");
    // (4) a file emptied from Trash whose versions a reload left part deleted: finished, a page a slice, from its
    // mark's cursor, those kept for sync passed over (their release deletes them: unpinOrDrop), its prunable range and
    // mark deleted at its end
    spend(2);
    const gone = ((await req(meta.getAllKeys(IDBKeyRange.bound(GONE, GONE + "\uffff"), 1))) as string[])[0];
    if (gone !== undefined) {
      const fid = gone.slice(GONE.length), mark = (await req(meta.get(gone))) as { at?: [IDBValidKey, number] } | number;
      const vs = tx.objectStore("versions"), vb = tx.objectStore("versionBytes");
      const page = await filePage(vs.index("byFile"), fid, typeof mark === "object" && mark.at ? mark.at : null, Math.max(1, Math.floor((left - 6) / 3)));
      let freed = 0;
      for (const v of page.list) if (!v.pinned) { vs.delete(v.id!); vb.delete(v.id!); freed += v.size; }
      if (freed) meta.put(Math.max(0, (((await req(meta.get("versionBytes"))) as number | undefined) ?? 0) - freed), "versionBytes");
      if (page.end) {
        tx.objectStore("prunable").delete(IDBKeyRange.bound([fid, -Infinity], [fid, Infinity]));
        meta.delete(gone);
      } else meta.put({ at: page.last }, gone);
      return true;
    }
    // (5) versions left due by saves (each save drops only a few: putVersion), in what is left of the budget
    return w.versionsSlice(tx, left);
  });
}

/** The bytes an outbox record names, read in `token`'s reservation: the file's present bytes if they are the
 * record's (its entry's SHA-256 and size), else the bytes its pin's storage holds (the pin's hash and size the
 * record's), checked against the record's size and hash; undefined if neither is the record's (sent all the same:
 * the server decides, `missing` if it doesn't hold them); "mismatch" if the stored size isn't the record's (nothing
 * read), "length" if the bytes read aren't as long as their metadata says (daybreak3's LIMIT-PR58-2).  The reservation must cover the record's size: nothing is read that it
 * doesn't, by the metadata, and bytes longer than it are never hashed or sent.  Never other bytes under the
 * record's hash. */
export async function bytesFor(w: Workspace, rec: { id: string; lseq: number; pin?: number; op: { sha256?: string; size?: number } }, token: Release, marks?: { mismatch: string; untrusted: string; reading: string; ns: string; dseq: number }): Promise<Uint8Array | undefined | "mismatch" | "length"> {
  if (!rec.op.sha256) return undefined;
  if (!token.live()) throw new Error("sync: bytes read in the name of a reservation that isn't held");
  const size = rec.op.size;
  if (size === undefined || !Number.isSafeInteger(size) || size < 0) return "mismatch";
  if (token.n < size) throw new Error("sync: bytes read in the name of a reservation smaller than they are");
  // (with `marks`: what is found is marked in the very transaction that finds it (daybreak3): a mismatch's own mark,
  // and, for bytes read and found to be another length, the workspace's bytes marked untrusted; the read-in-progress
  // mark the caller made before is cleared in it too.  A crash before it commits leaves that mark, which the next
  // start takes as untrusted bytes: so no crash lets an unreserved read happen twice)
  const stores = ["entries", "pins", "fileBytes", "versionBytes", ...(marks ? ["meta"] : [])];
  const b = await inTx(w.ws, stores, marks ? "readwrite" : "readonly", async (tx) => {
    const found = (what: "mismatch" | "length") => {
      if (!marks) return what;
      const meta = tx.objectStore("meta");
      meta.put(1, marks.mismatch);
      if (what === "length") meta.put({ ns: marks.ns, dseq: marks.dseq }, marks.untrusted);
      meta.delete(marks.reading);
      return what;
    };
    const read = async (): Promise<Uint8Array | undefined | "mismatch"> => {
      const e = (await req(tx.objectStore("entries").index("byIdent").get(rec.id))) as Entry | undefined;
      if (e?.kind === "file" && e.migrated && e.sha256 === rec.op.sha256) {
        if (e.size !== size) return "mismatch";
        return (await req(tx.objectStore("fileBytes").get(e.fid!))) as Uint8Array | undefined;
      }
      const p = (await req(tx.objectStore("pins").get([rec.id, rec.pin ?? rec.lseq]))) as Pin | undefined;
      if (!p || p.sha256 !== rec.op.sha256) return undefined;
      if (p.size !== size) return "mismatch";
      return ("version" in p.storage ? await req(tx.objectStore("versionBytes").get(p.storage.version)) : await req(tx.objectStore("fileBytes").get(p.storage.fileBytes))) as Uint8Array | undefined;
    };
    const v = await read();
    PINS.cutAfterRead?.(rec);
    if (v === "mismatch") return found("mismatch");
    // (stored bytes longer, or shorter, than their metadata: let go unhashed, unsent; "length", as they were read)
    if (v !== undefined && v.length !== size) return found("length");
    if (marks) tx.objectStore("meta").delete(marks.reading);
    return v;
  });
  if (b === undefined || b === "mismatch" || b === "length") return b;
  return (await bytesHash(b)) === rec.op.sha256 ? b : undefined;
}
