// The journal's store-level part, kind-neutral (plan-sync-slice2-client r4 §2.1; r9 §3.1a as #208's design r4 amends
// it): a save's intent written alone, the intents a committed T2 settles pruned, the bound of a value that can never be
// kept, and recovery's replay.  Each works over any journal's history store (`queue`, `journalTx`, `id` or `docId`, and
// optionally `writerOK`), a notebook's or a board's.  Moved from web/notebook/journal.js, which re-exports them under the
// same names; the rows they write are web/journal/rows.js's, re-exported here too.
//
// A kind's part of the journal (2c-3's per-kind hook), given by its store: { kind, versionedOf, apply(lastSynced,
// shown, remote, wins), conflictCopy }.  `versionedOf(doc)`: what its history keeps of a document (what the record's
// hash is of); `apply`: the three-way merge of this device's value (`shown`) and the server's (`remote`) from the value
// both last had (`lastSynced`), resolving {value, clashes}, a clash keeping the side `wins` names ("shown" or "remote")
// whole; `conflictCopy`: 2c-4's, null until then.  Notebooks' is web/notebook/journal.js notebookKind.
import { HISTORY_BACKLOG, ENTRY_OVERHEAD } from "../notebook/stores.js";
import { t1Write, pruneIntents, intentCharge, JOURNAL_BUDGETS } from "./rows.js";
export * from "./rows.js";

/** A save's intent alone (no version: its content unchanged, or TimeTravel paused), its T1 in the store's queue,
 * through its journalTx (the workspace's word and lock, the fence in the transaction). */
export function writeIntent(store, intent) {
  if (store.writerOK?.() === false) return Promise.resolve({ refused: NOT_WRITER });
  return store.queue(() => store.journalTx((st) => t1Write(st, store.docId ?? store.id, { intent }))).catch((e) => ({ refused: e?.message ?? String(e) }));
}
/** The intents at or below j `upTo` pruned (after a record write holding it has committed), through journalTx. */
export function prune(store, upTo) {
  return store.queue(() => store.journalTx(async (st) => ({ j: upTo, pruned: await pruneIntents(st, store.docId ?? store.id, upTo) }))).catch((e) => ({ refused: e?.message ?? String(e) }));
}
export const NOT_WRITER = "not saved: this notebook is open for editing in another tab of this browser";
/** A versioned value (the codec's text) that can never be kept: past TimeTravel's bound for one version (an append's
 * JSON text alone, stores.js append), or an intent of it past the pending budget alone (2c-1d-iii §4). */
export const neverFits = (text) => text.length > Math.floor((HISTORY_BACKLOG.bytes - ENTRY_OVERHEAD) / 2) || intentCharge(text) > JOURNAL_BUDGETS.pendingAll;

/** Recovery's replay (design r4 §3.1), pure: from the record's revision `rev` (null: no record) and the intents above
 * its j in increasing j, the value chosen: the last one whose T2 would have won, in order, or null for the record's
 * own. */
export function replay(rev, intents) {
  let r = rev, chosen = null;
  for (const it of intents) {
    if (r === null || it.srev === null || it.srev === r) { chosen = it; r = r === null ? null : r + 1; }
  }
  return chosen;
}
