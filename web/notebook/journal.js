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
// writes no intent and no charged row, so it always progresses.  Not here: an entry for a save whose T1 can't be
// written (2c-1d-iii).  Several tabs' outstanding saves are serialized by the replay, one legal order of their T2s.
// It loads with the history (the sagebrush-history.js bundle, history.js), and is given the page's own stores
// (journalClasses): one copy of stores.js, the page's, its gate and its queues, writes everything.
import { bytesHash } from "./stores.js";
import { t1Write, pruneIntents, dropRows, readJournal } from "./journal-rows.js";
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

/** The journal's classes over the page's stores (stores.js: `{IdbStore, IdbPatchStore}`, the page's own copy):
 * {JournalStore, journalPatchStore}. */
export function journalClasses({ IdbStore, IdbPatchStore }) {
  /** A notebook's history store whose writes are the journal's: T1 on every version (an IdbPatchStore with the
   * journal's hooks), and, while paused, a save's intent alone (F4). */
  function journalPatchStore(hdb, id) {
    const store = new IdbPatchStore(hdb, id, { journal: { t1: (st, row, intent) => t1Write(st, id, { row, intent }), drop: (st) => dropRows(st, id) } });
    // (F4: paused, a save's T1 is its intent alone; nothing to write for a version that isn't a save's)
    store.writePending = () => (store.intent ? writeIntent(store, store.intent) : Promise.resolve({ refused: "TimeTravel is paused for this notebook" }));
    return store;
  }
  return { JournalStore: makeJournalStore(IdbStore, journalPatchStore), journalPatchStore };
}

/** A save's intent alone (no version: its content unchanged, or TimeTravel paused), its T1 in the store's queue,
 * through its journalTx (the workspace's word and lock, the fence in the transaction). */
export function writeIntent(store, intent) {
  return store.queue(() => store.journalTx((st) => t1Write(st, store.id, { intent }))).catch((e) => ({ refused: e?.message ?? String(e) }));
}
/** The intents at or below j `upTo` pruned (after a record write holding it has committed), through journalTx. */
export function prune(store, upTo) {
  return store.queue(() => store.journalTx(async (st) => ({ j: upTo, pruned: await pruneIntents(st, store.id, upTo) }))).catch((e) => ({ refused: e?.message ?? String(e) }));
}

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

/** The journal's notebook store: IdbStore's record with {j, hash} (T2), its saves made only after their T1, and its
 * load recovering per the table above.  `history`: a NotebookHistory over journalPatchStore(hdb, id), whose
 * module (history.js) is passed in `mod` ({NotebookHistory, toRecords, fromRecords, SCHEMA}). */
const makeJournalStore = (IdbStore, journalPatchStore) => class JournalStore extends IdbStore {
  constructor(db, hdb, id, initial, mod) {
    super(db, id, initial, { journal: true });
    this.hdb = hdb; this.mod = mod;
    this.patches = journalPatchStore(hdb, id);
    this.history = new mod.NotebookHistory(this.patches);
    this.recovered = null;
    this.inflight = 0; this.released = false; this.opening = null;
  }
  // (the history open; opened again when a save comes after it was let go)
  async open() {
    if (this.history.session) return;
    this.opening ??= this.history.init().finally(() => { this.opening = null; });
    await this.opening;
  }
  /** The page is done with this notebook: its history let go once its saves still running are done (a save after it
   * opens it again). */
  release() {
    this.released = true;
    if (!this.inflight) this.history.close();
  }
  // (the codec's text of a document's versioned records: an intent's value)
  textOf(doc) { return this.history.codec.toString(this.mod.toRecords(doc)); }
  // (the hash of the history's versioned value as it is now: its settings and cells, as docHash hashes a document)
  headHash() { return docHash(this.mod.fromRecords(this.history.session.value())); }
  /** T1 for a save of `doc`: its intent, with its version when its content changed (and TimeTravel isn't paused);
   * resolves {j} once committed, or {refused}. */
  async t1(doc, again = true) {
    await this.open();
    const intent = { srev: doc.baseRev ?? null, value: this.textOf(doc) };
    this.patches.intent = intent;
    let env;
    try { env = this.history.record(doc); } finally { this.patches.intent = undefined; }
    const r = await (env?.pending ?? (env ? this.patches.appended(env.time) : writeIntent(this.patches, intent)));
    if (r.j !== undefined || env?.pending || !env) return r;
    // (a version the journal didn't keep: the history paused, the session rebuilt without it, and the save's intent
    // written alone instead, once)
    this.history.refused(env.time);
    return again ? this.t1(doc, false) : r;
  }
  /** T1, then T2, then the intents it settles pruned. */
  async save(doc, opts = {}) {
    if (opts.journal) return super.save(doc, opts);
    this.inflight++;
    try {
      const r = await this.t1(doc);
      if (r.j === undefined) return `not saved: ${r.refused ?? "not kept"}`;
      const out = await super.save(doc, { ...opts, journal: { j: r.j, hash: await docHash(doc) } });
      if (out && typeof out === "object" && out.saved) await prune(this.patches, r.j);
      return out;
    } finally {
      if (!--this.inflight && this.released) this.history.close();
    }
  }
  async load() {
    this.released = false;
    await this.open();
    for (let i = 0; ; i++) {
      const out = await this.recover(await super.loadRecord());
      if (out || i >= 4) { this.recovered = out ?? { row: "busy" }; break; }
    }
    if (this.recovered.row === "busy") throw new Error("the notebook kept changing while it was opened: reload this page");
    return this.recovered.doc;
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
  /** Recovery (design r4 §3): {doc, row: "consistent" | "stamped" | "rewritten" | "new", catchUp?}, or null when the
   * record changed under its compare and swap (load reads it again and replays again). */
  async recover(rec) {
    const state = await readJournal(this.hdb, this.id);
    const above = state.intents.filter((it) => it.j > (rec && Number.isSafeInteger(rec.j) ? rec.j : 0));
    const chosen = replay(rec ? rec.rev ?? 0 : null, above);
    if (!rec && !chosen) {
      // (a new notebook: its first save journaled like any other)
      const fresh = { ...(this.initial ?? { name: "Untitled", mode: "python", cells: [] }), id: this.id };
      const saved = await this.save(fresh);
      if (typeof saved === "string") throw new Error(saved);
      return saved.conflict ? null : { doc: { ...fresh, rev: saved.rev }, row: "new" };
    }
    const base = rec ?? { ...(this.initial ?? { name: "Untitled", mode: "python", cells: [] }), id: this.id };
    const recText = this.textOf(base);
    const value = chosen ? chosen.value : recText, own = value === recText;
    const doc = own ? (({ j: _j, hash: _h, rev: _r, ...d }) => d)(base) : this.withValue(base, this.history.codec.fromString(value));
    const hash = await docHash(doc);
    if (rec && own && rec.j === state.J && rec.hash === hash) {
      if (state.intents.some((it) => it.j <= rec.j)) await prune(this.patches, rec.j);
      return { doc: rec, row: "consistent" };
    }
    // (TimeTravel's catch-up: the head made the chosen value by one version, with no intent, before T2; its committed
    // j is the record's.  Refused, the record takes J, and TimeTravel's head waits for the next save)
    let j = state.J, catchUp = null;
    if ((await this.headHash()) !== hash) {
      const env = this.history.record(doc);
      const r = env && !env.pending ? await this.patches.appended(env.time) : { refused: "paused" };
      if (r.j !== undefined) { j = r.j; catchUp = r.j; } else if (env && !env.pending) this.history.refused(env.time);
    }
    const out = await super.save({ ...doc, ...(rec ? { baseRev: rec.rev } : {}) }, { journal: { j, hash } });
    if (typeof out === "string") throw new Error(out);
    if (out.conflict) return null;
    await prune(this.patches, j);
    return { doc: { ...doc, rev: out.rev, j, hash }, row: own ? "stamped" : "rewritten", catchUp };
  }
  /** What the page asks of a store to know it is the journal's. */
  get journaled() { return true; }
};
