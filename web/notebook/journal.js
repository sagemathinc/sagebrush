// The notebook journal (plan-sync-slice2-client r4 §2.1; r9 §3.1a), its core: once this device's journal is active
// (web/workspace/api.ts activateJournal), a notebook's save is two writes, in this order, and its load checks them.
//
//   T1, in the history database ("sagebrush-history"): the version's patch and the document's journal sequence
//       `jseq` (its j), in one transaction; or, while TimeTravel is paused (F4), the whole value as the document's
//       pending value, at the next j, conditional on the j the tab last saw.
//   T2, in the notebooks' store: the record, with that j and the hash of what it holds, written only if its
//       revision is still the one the tab saw (compare and swap, stores.js) and no later j is there.
//   Recovery, on every load, before the notebook is shown (r9 §3.1a's table; J the history's jseq):
//       j = J, the hash right       consistent: nothing;
//       j < J, the hash right       T1 committed and T2 didn't: the record rewritten from the history at J;
//       the hash wrong (or none)    a value the history doesn't hold (written by code from before the journal): merged
//                                   three ways (merge3.js) from the history at the record's j with the history at J,
//                                   journaled (T1), then written (T2).  A clash keeps the history's value as the
//                                   document and the record's as a copy, a notebook of its own beside it.
//   An edit counts as saved only once both transactions have completed.
//
// The journal's rows are sync's reserved rows (sync-rows.js, F1, F2), each charged (F8): a document's registry row and
// its j row to the metadata budget (at most 4 KiB a document, 4 MiB in all), its pending value to the 32 MiB pending
// budget.  What doesn't fit is refused, said, and nothing of it written; the save keeps its value on the page.
// Not here: an entry for a save whose T1 can't be written (2c-1d-iii), several tabs writing one document at once.
// It loads with the history (the sagebrush-history.js bundle, history.js), and is given the page's own stores
// (journalClasses): one copy of stores.js, the page's, its gate and its queues, writes everything.
import { bytesHash } from "./stores.js";
import { mergeRecords3 } from "./merge3.js";
import { t1Patch, t1Pending, dropRows, readJournal } from "./journal-rows.js";
export * from "./journal-rows.js";

/** The part of a notebook document the history keeps (history.js toRecords: its kind and each cell's id, type,
 * code and a Markdown cell's attachments, in order): what the store's hash is of. */
export function versionedOf(doc) {
  const type = (c) => (c.type === "markdown" || c.type === "raw" ? c.type : "code");
  return {
    mode: doc?.mode ?? "python",
    cells: (doc?.cells ?? []).map((c) => ({ id: c.id, type: type(c), code: c.code ?? "", ...(type(c) === "markdown" && c.attachments ? { attachments: c.attachments } : {}) })),
  };
}
const canonical = (v) => JSON.stringify(v, (k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((key) => [key, x[key]])) : x));
/** The hash of what the history keeps of `doc` (SHA-256 of its canonical JSON). */
export const docHash = (doc) => bytesHash(new TextEncoder().encode(canonical(versionedOf(doc))));

// (the history's records of the document, settings and cells only (not the execution journal's), as an array)
const recordsOf = (d) => [...d.get({ type: "settings" }), ...d.get({ type: "cell" })];

/** The journal's classes over the page's stores (stores.js: `{IdbStore, IdbPatchStore}`, the page's own copy):
 * {JournalStore, journalPatchStore}. */
export function journalClasses({ IdbStore, IdbPatchStore }) {
  /** A notebook's history store whose writes are the journal's: T1 on every version (an IdbPatchStore with the
   * journal's hooks), and, while paused, the pending value (F4). */
  function journalPatchStore(hdb, id) {
    const store = new IdbPatchStore(hdb, id, { journal: { t1: (st, row) => t1Patch(st, id, row), drop: (st) => dropRows(st, id) } });
    // (F4: a paused history's version, the pending value, conditional on the j its tab last saw: `baseJ`)
    store.baseJ = 0;
    store.writePending = (text) => writePending(store, text, store.baseJ);
    return store;
  }
  return { JournalStore: makeJournalStore(IdbStore, journalPatchStore), journalPatchStore };
}

/** A pending value's T1 (F4), in its own transaction, under the store's fence and the workspace's word. */
export function writePending(store, text, baseJ) {
  return store.queue(async () => {
    await store.allowed();
    return new Promise((ok) => {
      let out = null;
      const tx = store.db.transaction("history", "readwrite"), st = tx.objectStore("history");
      t1Pending(st, store.id, text, baseJ).then((r) => { out = r; if (r.conflict !== undefined) { try { tx.abort(); } catch {} } },
        (e) => { out = { refused: e?.refusal ?? `not kept: ${e?.message ?? e}` }; try { tx.abort(); } catch {} });
      tx.oncomplete = () => ok(out);
      tx.onabort = () => ok(out?.j !== undefined || !out ? { refused: "not kept: the write was stopped" } : out);
    });
  }).catch((e) => ({ refused: e?.message ?? String(e) }));
}

/** The journal's notebook store: IdbStore's record with {j, hash} (T2), its saves made only after their T1, and its
 * load recovering per the table above.  `history`: a NotebookHistory over journalPatchStore(hdb, id), whose
 * module (history.js) is passed in `mod` ({NotebookHistory, toRecords, fromRecords, SCHEMA}). */
const makeJournalStore = (IdbStore, journalPatchStore) => class JournalStore extends IdbStore {
  constructor(db, hdb, id, initial, mod) {
    super(db, id, initial, { journal: true });
    this.hdb = hdb; this.mod = mod;
    this.patches = journalPatchStore(hdb, id);
    this.history = new mod.NotebookHistory(this.patches);
    this.lastJ = 0;
    this.recovered = null;
    this.inflight = 0; this.released = false; this.opening = null;
  }
  // (the history open, with the journal's state: its j, and paused while a pending value waits (F4); opened again
  // when a save comes after it was let go)
  async open() {
    if (this.history.session) return null;
    this.opening ??= (async () => {
      await this.history.init();
      const state = await readJournal(this.hdb, this.id);
      this.lastJ = this.patches.baseJ = state.J;
      if (state.pending) { this.history.paused = true; this.history.pendingText = state.pending.value; }
      return state;
    })().finally(() => { this.opening = null; });
    return this.opening;
  }
  /** The page is done with this notebook: its history let go once its saves still running are done (a save after it
   * opens it again). */
  release() {
    this.released = true;
    if (!this.inflight) this.history.close();
  }
  // (T1 for a document: its version kept (a patch, or the pending value while paused), resolving {j} once committed,
  // or {refused}; nothing changed since the last version: the j that holds it)
  async t1(doc, again = true) {
    await this.open();
    const env = this.history.record(doc);
    if (!env) return { j: this.lastJ };
    const r = await (env.pending ?? this.patches.appended(env.time));
    if (r.j !== undefined) { this.lastJ = Math.max(this.lastJ, r.j); this.patches.baseJ = this.lastJ; return r; }
    // (a patch the journal didn't keep: the history paused, the session rebuilt without it, and the version kept as
    // the pending value instead, once)
    if (!env.pending) {
      this.history.refused(env.time);
      if (again) return this.t1(doc, false);
    }
    return r;
  }
  /** T1, then T2. */
  async save(doc, opts = {}) {
    if (opts.journal) return super.save(doc, opts);
    this.inflight++;
    try {
      const r = await this.t1(doc);
      if (r.j === undefined) return `not saved: ${r.refused ?? (r.conflict !== undefined ? "another tab saved this notebook meanwhile: reload this page" : "not kept")}`;
      return await super.save(doc, { ...opts, journal: { j: r.j, hash: await docHash(doc) } });
    } finally {
      if (!--this.inflight && this.released) this.history.close();
    }
  }
  async load() {
    this.released = false;
    await this.open();
    const rec = await super.loadRecord();
    this.recovered = await this.recover(rec);
    return this.recovered.doc;
  }
  // (the history's value at j: its versions with a later j left out; the pending value when it is that j's)
  valueAt(state, j) {
    if (state.pending && j >= state.pending.j) return this.history.codec.fromString(state.pending.value);
    const later = [...state.jOf].filter(([, k]) => k > j).map(([t]) => t);
    return this.history.session.value(later.length ? { withoutTimes: later } : {});
  }
  // (the record as a notebook document with the versioned part of `value` (records), its own outputs, names and
  // settings kept for the cells it still has)
  withValue(rec, value) {
    const v = this.mod.fromRecords(value), mine = new Map((rec?.cells ?? []).map((c) => [c.id, c]));
    const { j: _j, hash: _h, rev: _r, ...rest } = rec ?? {};
    const cell = (c) => {
      const out = { ...(mine.get(c.id) ?? {}), ...c };
      if (!c.type) delete out.type;
      if (!c.attachments) delete out.attachments;
      return out;
    };
    return { ...rest, mode: v.mode, cells: v.cells.map(cell) };
  }
  /** Recovery (the table above): {doc, row: "consistent" | "rewritten" | "journaled" | "copied" | "new", copy?}. */
  async recover(rec) {
    const state = await readJournal(this.hdb, this.id);
    if (!rec) {
      // (a new notebook: its first save is journaled like any other)
      const fresh = { ...(this.initial ?? { name: "Untitled", mode: "python", cells: [] }), id: this.id };
      const saved = await this.save(fresh);
      if (typeof saved === "string") throw new Error(saved);
      return { doc: { ...fresh, rev: saved.rev }, row: "new" };
    }
    const hashOk = typeof rec.hash === "string" && rec.hash === (await docHash(rec));
    const j = Number.isSafeInteger(rec.j) ? rec.j : null;
    if (hashOk && j === state.J) return { doc: rec, row: "consistent" };
    const H = this.valueAt(state, state.J);
    if (hashOk && j !== null && j < state.J) {
      // (T1 committed, T2 didn't: the store rewritten from the history, under its revision)
      const doc = this.withValue(rec, H), out = await super.save({ ...doc, baseRev: rec.rev }, { journal: { j: state.J, hash: await docHash(doc) } });
      if (typeof out === "string" || out.conflict) throw new Error(typeof out === "string" ? out : "the notebook changed while it was recovered: reload this page");
      return { doc: { ...doc, rev: out.rev, j: state.J }, row: "rewritten" };
    }
    // (a value the history doesn't hold: merged from the history at its j (or at J, with none) with the history now)
    const base = this.valueAt(state, j ?? state.J), S = this.mod.toRecords(rec);
    const m = mergeRecords3(this.mod.SCHEMA, recordsOf(base), recordsOf(H), recordsOf(S));
    if (!m.clashes.length) {
      let merged = this.history.codec.fromString("");
      for (const r of m.value) merged = merged.set(r);
      const doc = this.withValue(rec, merged), out = await this.save({ ...doc, baseRev: rec.rev });
      if (typeof out === "string" || out.conflict) throw new Error(typeof out === "string" ? out : "the notebook changed while it was recovered: reload this page");
      return { doc: { ...doc, rev: out.rev }, row: "journaled" };
    }
    // (a clash: the history's value is the document, and the record's is kept whole, as a copy, first)
    const copy = await this.keepCopy(rec);
    const doc = this.withValue(rec, H), out = await super.save({ ...doc, baseRev: rec.rev }, { journal: { j: state.J, hash: await docHash(doc) } });
    if (typeof out === "string" || out.conflict) throw new Error(typeof out === "string" ? out : "the notebook changed while it was recovered: reload this page");
    return { doc: { ...doc, rev: out.rev, j: state.J }, row: "copied", copy };
  }
  // (the record kept as a notebook of its own, journaled like any: its id)
  async keepCopy(rec) {
    const id = crypto.randomUUID();
    const { id: _i, rev: _r, j: _j, hash: _h, updated: _u, ...rest } = rec;
    const st = new this.constructor(this.db, this.hdb, id, { ...rest, id, name: `${rec.name || "Untitled"} (kept from this browser)` }, this.mod);
    await st.load();
    st.history.close();
    return id;
  }
  /** What the page asks of a store to know it is the journal's. */
  get journaled() { return true; }
};
