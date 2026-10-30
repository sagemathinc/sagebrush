// The journal's rows (plan-sync-slice2-client r4 §2.1, F1, F2, F8; r9 §3.1a as #208's design r4 amends it), in the
// history database's own transactions: T1's writes (the document's next j; a version's patch row at it; a save's intent
// at it), intents pruned, a dropped document's rows deleted, and the journal read.  Kind-neutral: each takes a history
// store's transaction (or database) and the document's id, a notebook's or a board's.  Its own module, without the
// merge, so the workspace (web/workspace/api.ts, which drops a deleted notebook's rows) carries only this.  Moved here
// from web/notebook/journal-rows.js, which re-exports it under the same names; web/journal/core.js is the store-level
// part, web/notebook/journal.js the notebooks' store, its saves and its recovery.
//
// A document's rows: its registry row (its handle h), its j row (jseq), and its saves' intents ("p" + j, each
// {srev, value}); each charged (F8): the registry and j rows to the metadata budget (at most 4 KiB a document, 4 MiB in
// all), the intents to the 32 MiB pending budget, in the same transaction as the row.  What doesn't fit is refused, said, and nothing of it written.
import { SYNC_NB, SYNC_KEY_BOUNDS, handleOf, registryKey, rowCharge, rowKey, seqKey } from "../notebook/sync-rows.js";

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

// (the document's metadata rows, j (jseq), m (its sync start), s (its slot, 2c-2), k (its pull cursor, 2c-3) and a (the
// merge mode its synced history asks for when it starts, plan-merge-align r3.2 §9), those in `changes` rewritten, and
// its metadata recharged: the registry's and these rows', together within the document's 4 KiB and everything's 4 MiB)
const META_ROWS = ["j", "m", "s", "k", "a"];
async function setMeta(st, reg, changes) {
  let rows = 0;
  for (const L of META_ROWS) {
    const key = rowKey(reg.h, L), v = L in changes ? changes[L] : (await rq(st.get(key)))?.v;
    if (v !== undefined) rows += rowCharge(key, v);
  }
  // (the registry's own charge counted with a meta field as wide as the one it will hold)
  const total = rowCharge(reg.key, { h: reg.h, meta: rowCharge(reg.key, { h: reg.h, meta: 0 }) + rows }) + rows;
  if (total > JOURNAL_BUDGETS.metaDoc) throw refusedWith(NO_ROOM_META);
  await charge(st, META, total - reg.meta, JOURNAL_BUDGETS.metaAll, NO_ROOM_META);
  st.put(rowOf(reg.key, { h: reg.h, meta: total }));
  reg.meta = total;
  for (const L of META_ROWS) if (L in changes) st.put(rowOf(rowKey(reg.h, L), changes[L]));
}

// ---- 2c-2: what the sender reads (plan r4 §2.2, r9 §3.2, §3.3, §3.8; design-2c2 r1).  One slot per document per
// device, held by the writer's lock (#215); a document's synced history, started once, under its own history key
// (William's D6(a)); every local patch on it given, in its T1, an `l` row at its j (the outbox, in send order) and its
// client's next cseq, and charged to sync's local budget (the debt) until the server acknowledges it.

/** Sync's local budget (r9 §3.8): the local patches the server hasn't acknowledged, a document's and its namespace's (in
 * each history database: notebooks' and boards' apart). */
export const SYNC_DEBT = { docCount: 10000, docBytes: 16 * 2 ** 20, nsCount: 50000, nsBytes: 64 * 2 ** 20 };
const NO_ROOM_DEBT = "more unsent changes than this browser keeps for syncing: not kept as a version";
const DEBT = [SYNC_NB, "b:d:" + JOURNAL_NS];
// (the texts a refusal says, of the document's kind's noun: "notebook" unless the caller says otherwise)
const NOT_THIS_CLIENT = (noun) => `not this device's sync client for this ${noun}: reload this page`;
/** The history key of a document's synced history, its `n`th start. */
export const syncedKey = (id, n) => `${id}:s${n}`;
// (a patch id's client: patchflow's "<11 base-36 time digits>_<client>")
const clientOf = (time) => (typeof time === "string" && time[11] === "_" ? time.slice(12) : null);
const lseqs = (h, from = 0) => IDBKeyRange.bound(seqKey(h, "l", from), seqKey(h, "l", Number.MAX_SAFE_INTEGER));
// (the document's registry row, or null for an id no journal row can have)
async function registered(st, id) {
  try { return await registry(st, id, false); } catch (e) { if (e instanceof RangeError) return null; throw e; }
}
/** The document's sync start ({n, from_j}) and slot ({gen, client, cseq, last, fgen, claimed, debt}), read in `st`. */
export async function readSync(st, id) {
  const reg = await registered(st, id);
  if (!reg) return { start: null, slot: null };
  return { start: (await rq(st.get(rowKey(reg.h, "m"))))?.v ?? null, slot: (await rq(st.get(rowKey(reg.h, "s"))))?.v ?? null };
}

/** At most this many saves' intents wait per document (each pruned once a record holding it, or a later one, is
 * written: r4 §3.3). */
export const MAX_INTENTS = 16;
const NO_ROOM_INTENTS = (noun) => `too many saves of this ${noun} are waiting to be confirmed: not saved`;
const NO_ROOM_INTENTS_RE = /^too many saves of this [a-z]+ are waiting to be confirmed: not saved$/;
const intents = (h, upTo = Number.MAX_SAFE_INTEGER) => IDBKeyRange.bound([SYNC_NB + h, "p"], seqKey(h, "p", upTo));

/** T1 (design r4 §1), in the history's transaction `st`: the document's next j, and at it, with `row`, the version's
 * patch row, and with `intent` ({srev, value}: the record revision the save's T2 requires, or null, and the codec's
 * text of its versioned records), the save's intent row, charged to the pending budget, at most MAX_INTENTS waiting.
 * A version without an intent (the execution journal's, a TimeTravel clear's re-record, recovery's catch-up) decides
 * nothing.  Resolves {j}; refused (thrown, with `refusal`), nothing of it is written. */
export async function t1Write(st, id, { row, intent, start, local = true, noun = "notebook" } = {}) {
  const reg = await registry(st, id, true);
  const j = ((await rq(st.get(rowKey(reg.h, "j"))))?.v?.j ?? 0) + 1;
  if (intent) {
    if ((await rq(st.count(intents(reg.h)))) >= MAX_INTENTS) throw refusedWith(NO_ROOM_INTENTS(noun));
    const key = seqKey(reg.h, "p", j), v = { srev: intent.srev ?? null, value: intent.value };
    await charge(st, PENDING, rowCharge(key, v), JOURNAL_BUDGETS.pendingAll, NO_ROOM_PENDING);
    st.put(rowOf(key, v));
  }
  const changes = { j: { j } };
  // (2c-2: the start, with its root patch, in this one transaction: the start row, the slot, the root's l row; never
  // twice)
  let m = (await rq(st.get(rowKey(reg.h, "m"))))?.v ?? null;
  if (start) {
    if (m) throw refusedWith(`this ${noun}'s synced history has already started`);
    // (the mode asked for, if one was recorded before the start (a .sbreplay restore asks legacy: askMerge), kept with
    // the start: what DocSync's creating claim asks)
    const a = (await rq(st.get(rowKey(reg.h, "a"))))?.v;
    m = changes.m = { n: start.n, from_j: j, ...(a?.asked ? { asked: a.asked } : {}) };
    changes.s = { gen: 1, client: start.client, cseq: 1, last: null, fgen: 0, claimed: null, debt: { count: 0, bytes: 0 } };
  }
  if (row && m && local) {
    // (a started document's local patch: on its synced history only, from its slot's client)
    const slot = changes.s ?? (await rq(st.get(rowKey(reg.h, "s"))))?.v;
    if (row.nb !== syncedKey(id, m.n) || !slot || clientOf(row.time) !== slot.client) throw refusedWith(NOT_THIS_CLIENT(noun));
    const lkey = seqKey(reg.h, "l", j), lv = { time: row.time, gen: slot.gen, client: slot.client, cseq: slot.cseq, bytes: 0 };
    // (its debt: the patch row's charge and its l row's, measured with the bytes field as wide as it can be)
    lv.bytes = rowCharge([row.nb, row.time], { env: row.env, j }) + rowCharge(lkey, { ...lv, bytes: Number.MAX_SAFE_INTEGER });
    const debt = { count: slot.debt.count + 1, bytes: slot.debt.bytes + lv.bytes };
    const ns = (await rq(st.get(DEBT)))?.v ?? { count: 0, bytes: 0 };
    if (debt.count > SYNC_DEBT.docCount || debt.bytes > SYNC_DEBT.docBytes || ns.count + 1 > SYNC_DEBT.nsCount || ns.bytes + lv.bytes > SYNC_DEBT.nsBytes) throw refusedWith(NO_ROOM_DEBT);
    st.put(rowOf(DEBT, { count: ns.count + 1, bytes: ns.bytes + lv.bytes }));
    st.put(rowOf(lkey, lv));
    changes.s = { ...slot, cseq: slot.cseq + 1, last: row.time, debt };
  }
  await setMeta(st, reg, changes);
  if (row) st.put({ ...row, j });
  return { j };
}

/** A new client for the document's slot (after a final refusal, an epoch move, `unknown_client`: 2c-3, 2c-4): its
 * generation raised, its cseq from 1 (the server counts a client's patches 1, 2, 3, …), unclaimed.  The old client's l rows stay as they are, each with its own gen and
 * client, so delayed work for it can still find them, and never touches the new one's (astra's pin 2). */
export async function rotate(st, id, client, { noun = "notebook" } = {}) {
  const reg = await registered(st, id), slot = reg && (await rq(st.get(rowKey(reg.h, "s"))))?.v;
  if (!slot) throw refusedWith(`this ${noun}'s synced history hasn't started`);
  const next = { ...slot, gen: slot.gen + 1, client, cseq: 1, last: null, fgen: 0, claimed: null, rotations: (slot.rotations ?? 0) + 1 };
  await setMeta(st, reg, { s: next });
  return next;
}

/** The local patches the server hasn't acknowledged, in send order (j), after j `after`: at most `max` of them, and as
 * many as fit `maxBytes` (one at least): [{j, time, gen, client, cseq, bytes, sent?}]. */
export function unsent(hdb, id, { after = 0, max = 500, maxBytes = 2 ** 20 } = {}) {
  return new Promise((ok, no) => {
    const tx = hdb.transaction("history", "readonly"), st = tx.objectStore("history"), out = [];
    const g = st.get(registryKey(JOURNAL_NS, id));
    g.onsuccess = () => {
      const h = g.result?.v?.h;
      if (!h) return;
      const r = st.getAll(lseqs(h, after + 1), max);
      r.onsuccess = () => {
        let bytes = 0;
        for (const x of r.result) {
          if (out.length && bytes + x.v.bytes > maxBytes) break;
          bytes += x.v.bytes;
          out.push({ j: Number(x.time.slice(1)), ...x.v });
        }
      };
    };
    tx.oncomplete = () => ok(out);
    tx.onerror = () => no(tx.error);
  });
}

// (the document's l rows of one client (its generation and id) with cseq at most `upTo`, each given to `f(row)`)
async function eachOf(st, h, gen, client, upTo, f) {
  for (const r of await rq(st.getAll(lseqs(h)))) if (r.v.gen === gen && r.v.client === client && r.v.cseq <= upTo) f(r);
}

/** The l rows of client (`gen`, `client`) up to cseq `upTo`, marked sent, in `st`, before the request `req` carries them
 * (CORR-SS2B-1): with the client's fence generation `fgen`, the epoch the batch names and the request, so an answer
 * is bound to exactly the rows it answers (astra's A4 on 2c-3).  A row marked by an earlier request is marked again
 * (a resend).  Resolves how many. */
export async function markSent(st, id, { gen, client, upTo, fgen, epoch = null, req = null }) {
  const reg = await registered(st, id);
  if (!reg) return 0;
  let n = 0;
  await eachOf(st, reg.h, gen, client, upTo, (r) => { st.put(rowOf([r.nb, r.time], { ...r.v, sent: { fgen, epoch, req } })); n++; });
  return n;
}

/** The server's acknowledgement of client (`gen`, `client`) up to cseq `upTo`, in `st`: those l rows deleted and their
 * debt released, the document's and its namespace's.  Idempotent: rows gone stay gone.  (The patches themselves stay:
 * they are TimeTravel's versions.)  Resolves how many. */
export async function acked(st, id, { gen, client, upTo, epoch, req }) {
  const reg = await registered(st, id), slot = reg && (await rq(st.get(rowKey(reg.h, "s"))))?.v;
  if (!slot) return 0;
  let n = 0, bytes = 0;
  // (with a request: only the rows that request carried, in its epoch (astra's A4 on 2c-3); a later resend re-marks them)
  const mine = (r) => req === undefined || (r.v.sent?.req === req && r.v.sent?.epoch === epoch);
  await eachOf(st, reg.h, gen, client, upTo, (r) => { if (mine(r)) { st.delete([r.nb, r.time]); n++; bytes += r.v.bytes; } });
  if (!n) return 0;
  const ns = (await rq(st.get(DEBT)))?.v ?? { count: 0, bytes: 0 };
  st.put(rowOf(DEBT, { count: Math.max(0, ns.count - n), bytes: Math.max(0, ns.bytes - bytes) }));
  await setMeta(st, reg, { s: { ...slot, debt: { count: Math.max(0, slot.debt.count - n), bytes: Math.max(0, slot.debt.bytes - bytes) } } });
  return n;
}

// ---- 2c-3: what the server answers, applied

/** A claim's answer (`doc_claim`, r9 §5.8), recorded in `st` only for the client it was sent for, its generation and
 * id: a delayed answer for an earlier client marks nothing.  Resolves whether it was recorded. */
export async function recordClaim(st, id, { gen, client, epoch, fgen, merge = undefined, noun = "notebook" }) {
  const reg = await registered(st, id), slot = reg && (await rq(st.get(rowKey(reg.h, "s"))))?.v;
  if (!slot || slot.gen !== gen || slot.client !== client) return false;
  const changes = { s: { ...slot, claimed: { epoch, client }, fgen } };
  const m = (await rq(st.get(rowKey(reg.h, "m"))))?.v;
  const mm = m ? await mergeRecorded(st, syncedKey(id, m.n), m, merge, noun) : null;
  if (mm) changes.m = mm;
  await setMeta(st, reg, changes);
  return true;
}

// ---- merge modes (plan-merge-align r3.2 §5, §9): the server's word on a document's mode, recorded once

const MERGE_CHANGED = (noun) => `the server says another merge mode for this ${noun} than it said before: this ${noun} stops syncing`;
const NOT_ONE_CHAIN = (noun) => `this ${noun}'s synced history here isn't one line of this device's changes, so it can't be read with exact merges: this ${noun} stops syncing (nothing is lost)`;
// (a history's rows are one chain: at most one parentless root, every other row one parent, one head (or none))
function oneChain(rows) {
  const times = new Set(rows.map((r) => r.time)), parents = new Set();
  let roots = 0;
  for (const r of rows) {
    const ps = r.env?.parents ?? [];
    if (ps.length > 1) return false;
    if (ps.length === 0) roots++;
    for (const p of ps) parents.add(p);
  }
  return roots <= 1 && [...times].filter((t) => !parents.has(t)).length <= 1;
}
/** The start row `m` with `merge` (the mode a server's answer says) recorded, or null when nothing changes: an answer
 * that says none (an older server), or the mode already recorded.  Another mode than the one recorded refuses (thrown,
 * nothing written).  Recording "exact-v1" first checks, in `st`, that the synced history (`key`) holds one chain:
 * before a mode is recorded only this device's own line is there, and both codecs read a line alike; anything else
 * refuses (thrown, nothing written, every row kept). */
async function mergeRecorded(st, key, m, merge, noun) {
  if (merge === undefined) return null;
  if (merge !== "legacy" && merge !== "exact-v1") throw refusedWith(`a merge mode this build doesn't know: this ${noun} stops syncing`);
  if (m.merge !== undefined) {
    if (m.merge !== merge) throw refusedWith(MERGE_CHANGED(noun));
    return null;
  }
  if (merge === "exact-v1" && !oneChain(await rq(st.getAll(IDBKeyRange.bound([key, ""], [key, "\uffff"]))))) throw refusedWith(NOT_ONE_CHAIN(noun));
  return { ...m, merge };
}
/** A document's synced history asks for `asked` when it starts (a .sbreplay restore: "legacy", so its server document
 * is made legacy, plan-merge-align r3.2 §9), recorded in `st`, the restore's own transaction.  A document whose synced
 * history has started already keeps what it asked (the server's mode is fixed): false. */
export async function askMerge(st, id, asked) {
  if (asked !== "legacy" && asked !== "exact-v1") throw new TypeError("askMerge: legacy or exact-v1");
  const reg = await registry(st, id, true);
  if ((await rq(st.get(rowKey(reg.h, "m"))))?.v) return false;
  await setMeta(st, reg, { a: { asked } });
  return true;
}

/** The document's pull cursor ({epoch, after, chain}) and start, read in `st`. */
export async function readCursor(st, id) {
  const reg = await registered(st, id);
  if (!reg) return { cursor: null, start: null };
  return { cursor: (await rq(st.get(rowKey(reg.h, "k"))))?.v ?? null, start: (await rq(st.get(rowKey(reg.h, "m"))))?.v ?? null };
}

// (a patch envelope as one canonical text: its keys sorted, for comparing a stored patch with one received)
const canon = (v) => JSON.stringify(v, (k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((key) => [key, x[key]])) : x));

/** One page of the server's batches applied, in `st` (one history transaction): only if the cursor is still `expect`
 * (a compare and swap: two pages checked against the same cursor can't both be applied, astra's A2), each patch of
 * `rows` ([{time, env}], in the server's order) appended to the synced history with the next j and no l row and no
 * debt (it's the server's); one already stored is skipped only if it is exactly that patch (astra's A4), and a different
 * one under the same id refuses the page; then the cursor is `next`.  A document not started here yet is started with
 * `start` ({client}), no root of its own: the server's patches are its history.  Resolves {j, applied}; refused
 * (thrown, with `refusal`), nothing of it is written. */
export async function applyPage(st, id, { expect, next, rows, start, merge, noun = "notebook" }) {
  const reg = await registry(st, id, true);
  const changes = {};
  let m = (await rq(st.get(rowKey(reg.h, "m"))))?.v ?? null;
  if (!m) {
    if (!start) throw refusedWith(`this ${noun}'s synced history hasn't started here`);
    m = changes.m = { n: 1, from_j: null };
    changes.s = { gen: 1, client: start.client, cseq: 1, last: null, fgen: 0, claimed: null, debt: { count: 0, bytes: 0 } };
  }
  const cur = (await rq(st.get(rowKey(reg.h, "k"))))?.v ?? null;
  if (canon(cur) !== canon(expect ?? null)) throw refusedWith("the pull cursor moved: this page is not applied");
  const key = syncedKey(id, m.n);
  // (the mode the answer says, recorded with this page's rows, before them: checked against this device's own line
  // alone, never against what this page brings)
  const mm = await mergeRecorded(st, key, m, merge, noun);
  if (mm) m = changes.m = mm;
  let j = (await rq(st.get(rowKey(reg.h, "j"))))?.v?.j ?? 0, applied = 0;
  for (const r of rows) {
    const had = await rq(st.get([key, r.time]));
    if (had) {
      if (canon(had.env) !== canon(r.env)) throw refusedWith(`another patch is stored under a received patch's id: this ${noun} stops syncing`);
      continue;
    }
    j++;
    applied++;
    st.put({ nb: key, time: r.time, env: r.env, j });
  }
  if (applied) changes.j = { j };
  changes.k = next;
  await setMeta(st, reg, changes);
  return { j, applied };
}

/** A T1 refused for room (2c-1d-iii §1: the intents' bound, the pending or the metadata budget, or the history
 * database's quota), after which the save's record is still written, marked: true.  Any other refusal (not the
 * writer, the fence, the workspace) is the save's own: not saved. */
export const roomRefused = (r) => !!r && (r.quota === true || r.refused === NO_ROOM_META || r.refused === NO_ROOM_PENDING || (typeof r.refused === "string" && NO_ROOM_INTENTS_RE.test(r.refused)) || r.refused === NO_ROOM_DEBT);
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
  // (a started document's synced history with it, and its debt released (2c-2))
  const m = (await rq(st.get(rowKey(reg.h, "m"))))?.v, slot = (await rq(st.get(rowKey(reg.h, "s"))))?.v;
  if (m) {
    st.delete(IDBKeyRange.bound([syncedKey(id, m.n), ""], [syncedKey(id, m.n), "\uffff"]));
    st.delete(IDBKeyRange.bound([id, ""], [id, "\uffff"]));
  }
  if (slot?.debt?.count) {
    const ns = (await rq(st.get(DEBT)))?.v ?? { count: 0, bytes: 0 };
    st.put(rowOf(DEBT, { count: Math.max(0, ns.count - slot.debt.count), bytes: Math.max(0, ns.bytes - slot.debt.bytes) }));
  }
  await charge(st, META, -reg.meta, Infinity, "");
  st.delete(IDBKeyRange.bound([SYNC_NB + reg.h, ""], [SYNC_NB + reg.h, "\uffff"]));
  st.delete(reg.key);
}

/** The document's journal as the history database has it: {J, intents: [{j, srev, value}] in increasing j, jOf:
 * Map(patch time → j) (of its synced history once started), start, slot, lrows (2c-2), cursor (2c-3)}. */
export function readJournal(hdb, id) {
  return new Promise((ok, no) => {
    const tx = hdb.transaction("history", "readonly"), st = tx.objectStore("history"), out = { J: 0, intents: [], jOf: new Map(), start: null, slot: null, lrows: 0, cursor: null };
    const rowsOf = (key) => { const rows = st.getAll(IDBKeyRange.bound([key, ""], [key, "\uffff"])); rows.onsuccess = () => { for (const r of rows.result) if (Number.isSafeInteger(r.j)) out.jOf.set(r.time, r.j); }; };
    const g = st.get(registryKey(JOURNAL_NS, id));
    g.onsuccess = () => {
      const h = g.result?.v?.h;
      if (!h) return rowsOf(id);
      const j = st.get(rowKey(h, "j")), p = st.getAll(intents(h)), m = st.get(rowKey(h, "m")), s = st.get(rowKey(h, "s")), l = st.count(lseqs(h));
      j.onsuccess = () => { out.J = j.result?.v?.j ?? 0; };
      p.onsuccess = () => { out.intents = p.result.map((r) => ({ j: Number(r.time.slice(1)), srev: r.v.srev, value: r.v.value })); };
      m.onsuccess = () => { out.start = m.result?.v ?? null; rowsOf(out.start ? syncedKey(id, out.start.n) : id); };
      s.onsuccess = () => { out.slot = s.result?.v ?? null; };
      const k = st.get(rowKey(h, "k"));
      k.onsuccess = () => { out.cursor = k.result?.v ?? null; };
      l.onsuccess = () => { out.lrows = l.result; };
    };
    tx.oncomplete = () => ok(out);
    tx.onerror = () => no(tx.error);
  });
}
