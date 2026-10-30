// The notebook journal (plan-sync-slice2-client r4 §2.1; r9 §3.1a as #208's design r4 amends it), its core: once this
// device's journal is active (web/workspace/api.ts activateJournal), a notebook's save is two writes, in this order,
// and its load checks them.
//
//   T1, in the history database ("sagebrush-history"), one transaction: the document's next j, the save's intent at it
//       ({srev: the record revision its T2 requires, or null; value: the codec's text of its versioned records}), and,
//       when its content changed and TimeTravel isn't paused, the version's patch at the same j.  Every save writes an
//       intent, an unchanged or outputs-only one too.
//   T2, in the notebooks' store: an ordinary save's record with its intent's j and the hash of its versioned value,
//       written only if its revision is still `srev` (compare and swap, stores.js) and no later j is there.  Then the
//       intents at or below that j are pruned.  (Recovery's T2, below, takes J or its catch-up's committed j.)
//   Recovery, on every load, before the notebook is shown: the intents above the record's j replayed in increasing j,
//       from the record's revision r: one whose srev is r (or null) is the save whose T2 would have won next (chosen,
//       r + 1), any other was refused.  The outcome is written by T2 alone, under the record's compare and swap:
//         consistent  the record's own value, its j the history's J, its hash right: nothing;
//         stamped     the record's own value, its j or hash wrong: written again with j and the hash;
//         rewritten   an interrupted save's value: the whole document, its hash and j;
//       first, when the history's head isn't the chosen value, one version patching it there (best effort: never an
//       intent, never authority), its committed j the record's.  Then the intents at or below are pruned.
//   An edit counts as saved only once both T1 and T2 have completed; the catch-up version is never a saved one.
//
// The journal's rows are sync's reserved rows (journal-rows.js; sync-rows.js, F1, F2), each charged (F8).  Recovery
// writes no intent and no charged row, so it always progresses.  Several tabs' outstanding saves are serialized by the
// replay, one legal order of their T2s.
//
// The mark (2c-1d-iii): every T2 writes `unjournaled` with the record, under its compare and swap: false (left out)
// only when the history's head, read after the save's (or recovery's) version step, hashes to the value written,
// which a version then holds; else true, or "too-large" for a value that can never be kept (TimeTravel's bound for one
// version, or the pending budget).  A save whose T1 is refused for room (journal-rows.js roomRefused) is still
// written by T2, its j kept, marked: saved in this browser, its versions coalesced into the latest, which recovery's
// catch-up (ingestion) then makes a version of and unmarks.
// It loads with the history (the sagebrush-history.js bundle, history.js), and is given the page's own stores
// (journalClasses): one copy of stores.js, the page's, its gate and its queues, writes everything.
import { mergeRecords3 } from "./merge3.js";
import { journalTexts } from "../journal/core.js";
import { journalStoreClasses, canonical, hashOf } from "../journal/store.js";
import { bytesHash } from "./stores.js";
export * from "./journal-rows.js";
// (the journal's store-level part, kind-neutral, moved to web/journal/core.js: here under the same names)
export { writeIntent, prune, neverFits, replay } from "../journal/core.js";
// (the journal's store and the page's helpers, kind-neutral, in web/journal/store.js: here under the same names)
export { pageControls, switchJournal, hashOf, writerLock } from "../journal/store.js";

/** The part of a notebook document the history keeps (history.js toRecords: its kind and each cell's id, type,
 * code and a Markdown cell's attachments, in order): what the store's hash is of. */
export function versionedOf(doc) {
  const type = (c) => (c.type === "markdown" || c.type === "raw" ? c.type : "code");
  return {
    mode: doc?.mode ?? "python",
    cells: (doc?.cells ?? []).map((c) => ({ id: c.id, type: type(c), code: c.code ?? "", ...(type(c) === "markdown" && c.attachments ? { attachments: c.attachments } : {}) })),
  };
}
/** The hash of what the history keeps of `doc` (SHA-256 of its canonical JSON). */
export const docHash = (doc) => bytesHash(new TextEncoder().encode(canonical(versionedOf(doc))));

/** Whether this page syncs notebooks' contents (DEV's docsync switch, set by the page once the journal is active): a
 * writer's load then starts a notebook's synced history (2c-2). */
export const DOC_SYNC = { on: false, saved: null, pull: null, stoppedOf: null };
/** What a notebook that arrived by sync but has no history here yet says (2c-3), its pull asked for if this page can:
 * why, if this page's doc sync stopped it (it won't arrive); that this page's notebook sync isn't on, if there is no
 * pull to ask (the switch decided off, or failed); else that it is still arriving. */
export const STILL_ARRIVING = "This notebook is still arriving from sync: try again in a moment";
export const SYNC_NOT_ON = "Notebook sync isn't on in this page: reload it";
export function arrivingSay(id, ds = DOC_SYNC) {
  const stopped = ds.stoppedOf?.(id) ?? null;
  if (stopped) return `This notebook can't sync here: ${stopped.code}`;
  if (typeof ds.pull !== "function") return SYNC_NOT_ON;
  try { ds.pull(id); } catch {}
  return STILL_ARRIVING;
}
// (`saved(id)`: told after a synced notebook's save is kept, and after its synced history starts, so the page's DocSync
// sends it (DEV's switch, web/workspace/doc-sync-switch.ts); null: nobody to tell)

/** The one writer of a notebook on this device, for the milestone (William, Oct 27: "Yes, single writer per device for
 * the milestone"): the Web Lock a journal store holds while it may write the notebook.  Another tab's store waits for
 * it, read-only; the browser frees it when its holder's tab closes or crashes. */
export const writerLockName = (id) => `sagebrush-nb-writer:${id}`;
// (notebooks' texts: web/journal/core.js journalTexts, of "notebook")
const T = journalTexts("notebook");
/** Why a store isn't its notebook's writer: another tab is, or this browser can't tell (no Web Locks). */
export const READ_ONLY = T.READ_ONLY;
/** Said when a read-only tab becomes the writer (the page's status line). */
export const TAKEOVER = T.TAKEOVER;
/** Said when a read-only tab couldn't reopen the notebook as its writer (and let the lock go). */
export const TAKEOVER_FAILED = T.TAKEOVER_FAILED;
/** Said for a save whose T1 had no room, written all the same (2c-1d-iii §1): never a promise of each version. */
export const SAVED_UNJOURNALED = T.SAVED_UNJOURNALED;
/** Said for a save of a notebook too large ever to be kept as a version (2c-1d-iii §4). */
export const SAVED_TOO_LARGE = T.SAVED_TOO_LARGE;

/** Notebooks' kind (web/journal/store.js), over the history's module `mod` (history.js: {NotebookHistory, toRecords,
 * fromRecords, recordsOf, docOfRecords, SCHEMA}): `apply` merges by records (merge3.js mergeRecords3), the side `wins`
 * names kept whole on a clash, from an empty notebook in `shown`'s mode when there is no `lastSynced`. */
export function notebookKind(mod) {
  return {
    kind: "notebooks",
    noun: "notebook",
    lockPrefix: "sagebrush-nb-writer:",
    sync: DOC_SYNC,
    versionedOf,
    history: (patchStore) => new mod.NotebookHistory(patchStore),
    toRecords: (doc) => mod.toRecords(doc),
    fromRecords: (records) => mod.fromRecords(records),
    // (the record as a notebook document with the versioned part of `value` (records), its own outputs, names and
    // settings kept for the cells it still has)
    withValue(rec, value) {
      const v = mod.fromRecords(value), mine = new Map((rec?.cells ?? []).map((c) => [c.id, c]));
      const { j: _j, hash: _h, rev: _r, ...rest } = rec ?? {};
      const cell = (c) => {
        const out = { ...(mine.get(c.id) ?? {}), ...c };
        if (!c.type) delete out.type;
        if (!c.attachments) delete out.attachments;
        return out;
      };
      return { ...rest, mode: v.mode, cells: v.cells.map(cell) };
    },
    empty: (id, initial) => ({ ...(initial ?? { name: "Untitled", mode: "python", cells: [] }), id }),
    // (`merge`: the document's recorded mode (the store's mergeMode).  exact-v1: dbMerge3's rules (history.js
    // exactRecords3), the side `wins` names as `b`, the later one, never a clash (plan-p2c r0 S1); in a build without
    // them, refused, never merged the older way.  Else mergeRecords3, a clash keeping the side `wins` names whole)
    apply(lastSynced, shown, remote, wins, merge) {
      const base = mod.recordsOf(lastSynced ?? { mode: shown.mode, cells: [] });
      if (merge === "exact-v1") {
        if (!mod.exactRecords3) throw Object.assign(new Error(T.NO_EXACT), { noExact: true });
        const [a, b] = wins === "remote" ? [shown, remote] : [remote, shown];
        return { value: mod.docOfRecords(mod.exactRecords3(base, mod.recordsOf(a), mod.recordsOf(b))), clashes: [] };
      }
      const [a, b] = wins === "remote" ? [remote, shown] : [shown, remote];
      const r = mergeRecords3(mod.SCHEMA, base, mod.recordsOf(a), mod.recordsOf(b));
      return { value: r.clashes.length ? a : mod.docOfRecords(r.value), clashes: r.clashes };
    },
    conflictCopy: null,
  };
}

/** The journal's classes over the page's stores (stores.js: `{IdbStore, IdbPatchStore}`, the page's own copy):
 * {JournalStore, journalPatchStore}, of notebooks' kind. */
export function journalClasses(stores) {
  return journalStoreClasses(stores, notebookKind);
}
