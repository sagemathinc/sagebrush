// The notebook journal's rows (plan-sync-slice2-client r4 §2.1, F1, F2, F8; r9 §3.1a), in the history database's own
// transactions: T1's writes (a patch's row with the document's next j; or, while TimeTravel is paused, its pending
// value), a dropped document's rows deleted, and the journal read.  Its own module, without the merge, so the
// workspace (web/workspace/api.ts, which drops a deleted notebook's rows) carries only this.  web/notebook/journal.js
// is the rest: the store, its saves and its recovery.
//
// A document's rows: its registry row (its handle h), its j row (jseq), and its pending value; each charged (F8): the
// registry and j rows to the metadata budget (at most 4 KiB a document, 4 MiB in all), the pending value to the 32 MiB
// pending budget, in the same transaction as the row.  What doesn't fit is refused, said, and nothing of it written.
import { SYNC_NB, handleOf, registryKey, rowCharge, rowKey } from "./sync-rows.js";

/** The namespace of a device's local journal (the account's namespaces are the sender's, 2c-2). */
export const JOURNAL_NS = "local";
/** F8's budgets for the journal's rows, in bytes as charged. */
export const JOURNAL_BUDGETS = { metaDoc: 4096, metaAll: 4 * 2 ** 20, pendingAll: 32 * 2 ** 20 };
export const PENDING_OPEN = "a pending value is waiting";
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

/** The journal's T1 for a patch, in the history's transaction `st` (stores.js IdbPatchStore's hook): the patch's row
 * written with the next j, and jseq raised to it.  With a pending value waiting, nothing: {refused: PENDING_OPEN}
 * (the history pauses, and its next version goes to the pending value, F4). */
export async function t1Patch(st, id, row) {
  const reg = await registry(st, id, true);
  if ((await rq(st.get(rowKey(reg.h, "p")))) !== undefined) return { refused: PENDING_OPEN };
  const j = ((await rq(st.get(rowKey(reg.h, "j"))))?.v?.j ?? 0) + 1;
  await setJ(st, reg, j);
  st.put({ ...row, j });
  return { j };
}

/** The journal's T1 for a pending value (F4: TimeTravel paused), in `st`: the value (the codec's text of the records)
 * written at the next j, only if the document's j is still `baseJ`; else {conflict: j}. */
export async function t1Pending(st, id, text, baseJ) {
  const reg = await registry(st, id, true), pkey = rowKey(reg.h, "p");
  const j0 = (await rq(st.get(rowKey(reg.h, "j"))))?.v?.j ?? 0;
  if (j0 !== baseJ) return { conflict: j0 };
  const old = (await rq(st.get(pkey)))?.v, j = j0 + 1, v = { j, value: text };
  await charge(st, PENDING, rowCharge(pkey, v) - (old ? rowCharge(pkey, old) : 0), JOURNAL_BUDGETS.pendingAll, NO_ROOM_PENDING);
  await setJ(st, reg, j);
  st.put(rowOf(pkey, v));
  return { j };
}

/** A dropped document's journal rows deleted, in the drop's transaction, and their charges released. */
export async function dropRows(st, id) {
  // (an id no journal row can have: none to drop)
  let reg;
  try { reg = await registry(st, id, false); } catch (e) { if (e instanceof RangeError) return; throw e; }
  if (!reg) return;
  const pkey = rowKey(reg.h, "p"), p = (await rq(st.get(pkey)))?.v;
  if (p) await charge(st, PENDING, -rowCharge(pkey, p), Infinity, "");
  await charge(st, META, -reg.meta, Infinity, "");
  st.delete(IDBKeyRange.bound([SYNC_NB + reg.h, ""], [SYNC_NB + reg.h, "\uffff"]));
  st.delete(reg.key);
}

/** The document's journal as the history database has it: {J, pending: {j, value} | null, jOf: Map(time → j)}. */
export function readJournal(hdb, id) {
  return new Promise((ok, no) => {
    const tx = hdb.transaction("history", "readonly"), st = tx.objectStore("history"), out = { J: 0, pending: null, jOf: new Map() };
    const g = st.get(registryKey(JOURNAL_NS, id));
    g.onsuccess = () => {
      const h = g.result?.v?.h;
      if (!h) return;
      const j = st.get(rowKey(h, "j")), p = st.get(rowKey(h, "p"));
      j.onsuccess = () => { out.J = j.result?.v?.j ?? 0; };
      p.onsuccess = () => { out.pending = p.result?.v ?? null; };
    };
    const rows = st.getAll(IDBKeyRange.bound([id, ""], [id, "\uffff"]));
    rows.onsuccess = () => { for (const r of rows.result) if (Number.isSafeInteger(r.j)) out.jOf.set(r.time, r.j); };
    tx.oncomplete = () => ok(out);
    tx.onerror = () => no(tx.error);
  });
}

