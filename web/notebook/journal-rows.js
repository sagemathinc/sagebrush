// The notebook journal's rows (plan-sync-slice2-client r4 §2.1, F1, F2, F8; r9 §3.1a as #208's design r4 amends it), in
// the history database's own transactions: T1's writes (the document's next j; a version's patch row at it; a save's
// intent at it), intents pruned, a dropped document's rows deleted, and the journal read.  Its own module, without the merge, so the
// workspace (web/workspace/api.ts, which drops a deleted notebook's rows) carries only this.  web/notebook/journal.js
// is the rest: the store, its saves and its recovery.
//
// A document's rows: its registry row (its handle h), its j row (jseq), and its saves' intents ("p" + j, each
// {srev, value}); each charged (F8): the registry and j rows to the metadata budget (at most 4 KiB a document, 4 MiB in
// all), the intents to the 32 MiB pending budget, in the same transaction as the row.  What doesn't fit is refused, said, and nothing of it written.
import { SYNC_NB, SYNC_KEY_BOUNDS, handleOf, registryKey, rowCharge, rowKey, seqKey } from "./sync-rows.js";

/** The namespace of a device's local journal (the account's namespaces are the sender's, 2c-2). */
export const JOURNAL_NS = "local";
/** F8's budgets for the journal's rows, in bytes as charged. */
export const JOURNAL_BUDGETS = { metaDoc: 4096, metaAll: 4 * 2 ** 20, pendingAll: 32 * 2 ** 20 };
const NO_ROOM_META = "too many documents are kept for sync on this device: not saved";
const NO_ROOM_PENDING = "this version is too large to keep for sync now: not saved";
// (the rows that aren't a document's: the handles' counter, and the budgets' counters)
const COUNTER = [SYNC_NB, "n"], META = [SYNC_NB, "b:m:" + JOURNAL_NS], PENDING = [SYNC_NB, "b:p:" + JOURNAL_NS];

const rq = (r) => new Promise((ok, no) => { r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
// (a sync row as the history store keeps it: its key's parts, and its value under v)
const rowOf = ([nb, time], v) => ({ nb, time, v });
const refusedWith = (why) => Object.assign(new Error(why), { refusal: why });

// (a budget's counter raised by `delta` within `limit`, in the caller's transaction; over it, refused)
async function charge(st, key, delta, limit, why) {
  if (!delta) return;
  const cur = (await rq(st.get(key)))?.v ?? { bytes: 0 };
  const bytes = cur.bytes + delta;
  if (delta > 0 && bytes > limit) throw refusedWith(why);
  st.put(rowOf(key, { bytes: Math.max(0, bytes) }));
}

// (the document's registry row, made if `make` and it has none: its handle h and the metadata charged to it)
async function registry(st, id, make) {
  const key = registryKey(JOURNAL_NS, id), cur = (await rq(st.get(key)))?.v;
  if (cur || !make) return cur ? { key, ...cur } : null;
  const n = (await rq(st.get(COUNTER)))?.v?.next ?? 0, h = handleOf(n);
  // (the counter charged as it is, recharged as it grows)
  await charge(st, META, rowCharge(COUNTER, { next: n + 1 }) - (n ? rowCharge(COUNTER, { next: n }) : 0), JOURNAL_BUDGETS.metaAll, NO_ROOM_META);
  st.put(rowOf(COUNTER, { next: n + 1 }));
  return { key, h, meta: 0, fresh: true };
}

// (the document's j row rewritten to `j`, and its metadata recharged: the registry's and the j row's, together within
// the document's 4 KiB and everything's 4 MiB)
async function setJ(st, reg, j) {
  const jkey = rowKey(reg.h, "j"), meta = rowCharge(reg.key, { h: reg.h, meta: 0 }) + rowCharge(jkey, { j });
  // (the registry's own charge counted with a meta field as wide as the one it will hold)
  const regCharge = rowCharge(reg.key, { h: reg.h, meta }), total = regCharge + rowCharge(jkey, { j });
  if (total > JOURNAL_BUDGETS.metaDoc) throw refusedWith(NO_ROOM_META);
  await charge(st, META, total - reg.meta, JOURNAL_BUDGETS.metaAll, NO_ROOM_META);
  st.put(rowOf(reg.key, { h: reg.h, meta: total }));
  st.put(rowOf(jkey, { j }));
}

/** At most this many saves' intents wait per document (each pruned once a record holding it, or a later one, is
 * written: r4 §3.3). */
export const MAX_INTENTS = 16;
const NO_ROOM_INTENTS = "too many saves of this notebook are waiting to be confirmed: not saved";
const intents = (h, upTo = Number.MAX_SAFE_INTEGER) => IDBKeyRange.bound([SYNC_NB + h, "p"], seqKey(h, "p", upTo));

/** T1 (design r4 §1), in the history's transaction `st`: the document's next j, and at it, with `row`, the version's
 * patch row, and with `intent` ({srev, value}: the record revision the save's T2 requires, or null, and the codec's
 * text of its versioned records), the save's intent row, charged to the pending budget, at most MAX_INTENTS waiting.
 * A version without an intent (the execution journal's, a TimeTravel clear's re-record, recovery's catch-up) decides
 * nothing.  Resolves {j}; refused (thrown, with `refusal`), nothing of it is written. */
export async function t1Write(st, id, { row, intent } = {}) {
  const reg = await registry(st, id, true);
  const j = ((await rq(st.get(rowKey(reg.h, "j"))))?.v?.j ?? 0) + 1;
  if (intent) {
    if ((await rq(st.count(intents(reg.h)))) >= MAX_INTENTS) throw refusedWith(NO_ROOM_INTENTS);
    const key = seqKey(reg.h, "p", j), v = { srev: intent.srev ?? null, value: intent.value };
    await charge(st, PENDING, rowCharge(key, v), JOURNAL_BUDGETS.pendingAll, NO_ROOM_PENDING);
    st.put(rowOf(key, v));
  }
  await setJ(st, reg, j);
  if (row) st.put({ ...row, j });
  return { j };
}

/** A T1 refused for room (2c-1d-iii §1: the intents' bound, the pending or the metadata budget, or the history
 * database's quota), after which the save's record is still written, marked: true.  Any other refusal (not the
 * writer, the fence, the workspace) is the save's own: not saved. */
export const roomRefused = (r) => !!r && (r.quota === true || r.refused === NO_ROOM_META || r.refused === NO_ROOM_PENDING || r.refused === NO_ROOM_INTENTS);
/** What an intent of the codec's text `value` is charged, at most (its key as wide as a key can be). */
export const intentCharge = (value) => rowCharge([SYNC_NB + "z".repeat(SYNC_KEY_BOUNDS.handle), "p" + "9".repeat(16)], { srev: Number.MAX_SAFE_INTEGER, value });

/** The document's intents at or below j `upTo` deleted, in `st`, and their charges released (design r4 §3.3: only
 * after a record write holding j `upTo` has committed).  Resolves how many. */
export async function pruneIntents(st, id, upTo) {
  let reg;
  try { reg = await registry(st, id, false); } catch (e) { if (e instanceof RangeError) return 0; throw e; }
  if (!reg) return 0;
  const rows = await rq(st.getAll(intents(reg.h, upTo)));
  let freed = 0;
  for (const r of rows) { freed += rowCharge([r.nb, r.time], r.v); st.delete([r.nb, r.time]); }
  await charge(st, PENDING, -freed, Infinity, "");
  return rows.length;
}

/** A dropped document's journal rows deleted, in the drop's transaction, and their charges released. */
export async function dropRows(st, id) {
  // (an id no journal row can have: none to drop)
  let reg;
  try { reg = await registry(st, id, false); } catch (e) { if (e instanceof RangeError) return; throw e; }
  if (!reg) return;
  await pruneIntents(st, id, Number.MAX_SAFE_INTEGER);
  await charge(st, META, -reg.meta, Infinity, "");
  st.delete(IDBKeyRange.bound([SYNC_NB + reg.h, ""], [SYNC_NB + reg.h, "\uffff"]));
  st.delete(reg.key);
}

/** The document's journal as the history database has it: {J, intents: [{j, srev, value}] in increasing j, jOf:
 * Map(patch time → j)}. */
export function readJournal(hdb, id) {
  return new Promise((ok, no) => {
    const tx = hdb.transaction("history", "readonly"), st = tx.objectStore("history"), out = { J: 0, intents: [], jOf: new Map() };
    const g = st.get(registryKey(JOURNAL_NS, id));
    g.onsuccess = () => {
      const h = g.result?.v?.h;
      if (!h) return;
      const j = st.get(rowKey(h, "j")), p = st.getAll(intents(h));
      j.onsuccess = () => { out.J = j.result?.v?.j ?? 0; };
      p.onsuccess = () => { out.intents = p.result.map((r) => ({ j: Number(r.time.slice(1)), srev: r.v.srev, value: r.v.value })); };
    };
    const rows = st.getAll(IDBKeyRange.bound([id, ""], [id, "\uffff"]));
    rows.onsuccess = () => { for (const r of rows.result) if (Number.isSafeInteger(r.j)) out.jOf.set(r.time, r.j); };
    tx.oncomplete = () => ok(out);
    tx.onerror = () => no(tx.error);
  });
}
