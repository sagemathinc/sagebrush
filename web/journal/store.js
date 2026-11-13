// The journal's store, kind-neutral (plan-sync-slice2-client r4 §2.1; r9 §3.1a as #208's design r4 amends it): a
// document's T1 then T2 on every save, its load's recovery, its writer's lock, and its synced history (2c-2, 2c-3), for
// any kind of document: notebooks (web/notebook/journal.js notebookKind) and boards.  Moved from web/notebook/journal.js,
// whose table (T1, T2, recovery, the mark) it implements; the notebooks' names are re-exported there.
//
// A kind ({kind, noun, lockPrefix, sync, versionedOf, history, toRecords, fromRecords, withValue, empty, apply,
// conflictCopy}), made from the history's module by `kindOf(mod)`:
//   kind, noun         its name ("notebooks", "boards") and the noun its texts say ("notebook", "board": journalTexts)
//   lockPrefix         its writer lock's name before the document's id ("sagebrush-nb-writer:", kept for open tabs)
//   sync               its switch: {on, saved(id)} (on: a writer's load starts its synced history; saved: told after a
//                      synced document's save is kept)
//   versionedOf(doc)   what its history keeps of a document: what the record's hash is of (hashOf)
//   history(store)     its history over a journal's patch store: a PatchHistory (web/notebook/patch-history.js) or a
//                      subclass, with record(doc, base) and mergedWith(doc, base).  The store uses its record,
//                      mergedWith, refused, init, close, session (value), codec (toString, fromString), paused,
//                      rebuilding, clientId, lastMs, sessionOptions, and its patch store's subscribe and onAcked
//   toRecords(doc), fromRecords(records)   a document as the history's records and back (its versioned part only)
//   withValue(rec, records)  the record with its versioned part replaced by `records`, its other parts kept.  The law,
//                      tested for each kind: withValue(rec, toRecords(rec)) is rec but for the store's own fields
//   empty(id, initial) a new document: `initial` (the store's) with what it lacks, and its id
//   apply(lastSynced, shown, remote, wins), conflictCopy   2c-3's merge (web/journal/core.js), of documents (the
//                      store gives it fromRecords's documents, and makes the record from toRecords of its value)
// The store's own fields of a record, the same for every kind, never a document's: rev, j, hash, unjournaled, and
// baseRev on the way in.
//
// `Base`, the kind's record store (T2): constructor(db, id, initial, {journal: true}) with `id` and `initial`;
// loadRecord(), the record or null; save(doc, {journal: {j, hash, unjournaled, keep?, markOnly?}}), a compare and swap
// on doc.baseRev, resolving {saved, rev}, {conflict}, or a refusal's text (web/notebook/stores.js IdbStore's).
import { bytesHash } from "../notebook/stores.js";
import { t1Write, dropRows, readJournal, roomRefused, syncedKey, acked, markSent, rotate } from "./rows.js";
import { writeIntent, prune, neverFits, replay, journalTexts } from "./core.js";
import { makeClientId, decodePatchId } from "patchflow";
import { NO_VERSIONS } from "../notebook/patch-history.js";
import { LIMITS } from "../sync-protocol/protocol";

const canonical = (v) => JSON.stringify(v, (k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((key) => [key, x[key]])) : x));
/** The hash of what a kind's history keeps of `doc` (SHA-256 of the canonical JSON of its versionedOf). */
export const hashOf = (kind, doc) => bytesHash(new TextEncoder().encode(canonical(kind.versionedOf(doc))));
export { canonical };
/** The rules a record's `at` proof was made under (the merge of several heads: patchflow's graph with the kind's
 * codec): a proof made under others is no proof, and its record is taken as an older version's (legacy). */
export const PROOF = "exact-1";
const MAX_AT = 64;

/** The journal's classes for a kind (`kindOf(mod)`), over the page's stores (stores.js: `{IdbStore, IdbPatchStore}`,
 * the page's own copy) or the kind's record store as `IdbStore`: {JournalStore, journalPatchStore}. */
export function journalStoreClasses({ IdbStore, IdbPatchStore }, kindOf) {
  /** A document's history store whose writes are the journal's: T1 on every version (an IdbPatchStore with the
   * journal's hooks), and, while paused, a save's intent alone (F4). */
  function journalPatchStore(hdb, id, kind = { noun: "notebook" }) {
    // (nothing written but by the document's writer here: `writerOK`, set by its JournalStore)
    // (`start`: a synced history's start, set by the store for its root's append (2c-2))
    const store = new IdbPatchStore(hdb, id, { journal: { t1: (st, row, intent) => (store.writerOK?.() === false ? Promise.resolve({ refused: journalTexts(kind.noun).NOT_WRITER }) : t1Write(st, id, { row, intent, start: row && store.start?.time === row.time ? store.start : undefined, noun: kind.noun })), drop: (st) => dropRows(st, id) } });
    // (the document's journal identity, for good: `store.id` is its history's key, which a synced document's start
    // changes to `<id>:s<n>`; every journal row is the document's (astra's CORR-2C2-1))
    store.docId = id; store.noun = kind.noun;
    // (F4: paused, a save's T1 is its intent alone; nothing to write for a version that isn't a save's)
    store.writePending = () => (store.intent ? writeIntent(store, store.intent) : Promise.resolve({ refused: journalTexts(kind.noun).PAUSED }));
    return store;
  }
  return { JournalStore: makeJournalStore(IdbStore, journalPatchStore, kindOf), journalPatchStore };
}

// (a history's patches made by `client` from now on (a synced document's slot), each id after `last` (the slot's last
// patch id, or null): ids keep rising across reloads and clock changes.  Here, not in patch-history.js, so the no-sync
// board build doesn't grow (plan r4 F3))
function useClient(history, client, last) {
  history.clientId = client;
  if (last) history.lastMs = Math.max(history.lastMs, decodePatchId(last).timeMs);
  history.sessionOptions = function () { return { codec: this.codec, patchStore: this.guarded, clientId: client }; };
}

/** The base of a merge with the history (mergeRemote): the history as a record whose j is `recJ` had it, from the
 * journal's `jOf` (patch time -> j), the document's sync `start` and the history's `session`.  {time, value}: `time` the
 * version with the highest j at or below recJ (null: none), `value` the base's value (null: none); or {refuse} when it
 * can't be given completely.
 * - A codec without merge3 (a board's): that version's value, as always.
 * - With merge3 (a notebook's: exact merges, plan-exact-only r1):
 *   - (a) a record not saved since this device started the synced history keeps its j from before, below the synced
 *     root's (start.from_j): its base is the synced root, its value when it started;
 *   - (b) the merged value of every version at or below recJ (their maximal ones), by patchflow's exactValueOf: a record
 *     stamped with a merge that made no new version has both sides' versions at or below its j, and the highest alone
 *     would read that merge as an edit of its own and keep the other side's text twice;
 *   - refused, never a partial or one-version value in its place, when a version it needs isn't held here or the
 *     history can't merge them exactly (astra3's BASE-1). */
export function mergeBaseOf(jOf, recJ, start, session) {
  let time = null, best = -1;
  for (const [t, j] of jOf) if (j <= recJ && j > best) { best = j; time = t; }
  const g = session?.graph;
  if (!g?.codec?.merge3) return { time, value: time ? session.value({ time }) : null };
  let times = [...jOf].filter(([, j]) => j <= recJ).map(([t]) => t);
  if (!times.length && Number.isSafeInteger(start?.from_j)) for (const [t, j] of jOf) if (j === start.from_j) { time = t; times = [t]; }
  if (!times.length) return { time: null, value: null };
  const missing = times.filter((t) => !g.patches?.has(t));
  if (missing.length) return { refuse: `${missing.length} of the versions it merges from aren't here yet` };
  const top = new Set(times);
  for (const t of times) for (const p of g.getParents?.(t) ?? []) top.delete(p);
  const value = typeof g.exactValueOf === "function" ? g.exactValueOf([...top]) : undefined;
  if (value == null) return { refuse: "the history here can't merge the versions it merges from yet" };
  return { time, value };
}

/** The one writer of a document on this device, for the milestone (William, Oct 27: "Yes, single writer per device for
 * the milestone"): the Web Lock (its kind's lockPrefix and the id) a journal store holds while it may write the
 * document.  Another tab's store waits for it, read-only; the browser frees it when its holder's tab closes or crashes.
 * A mixin over the store's base: its state is the store's own (writer, readOnly, unlock, waiting, ontakeover, lockGen,
 * takeoverDue, lockDone, acquiring), its texts the kind's (this.T). */
export const writerLock = (Base) => class extends Base {
  /** This store's document isn't writable here: its kind's READ_ONLY text, or null. */
  get viewOnly() {
    if (this.writer && this.ready) return null;
    if (this.readOnly === "nolocks") return this.T.READ_ONLY.nolocks;
    return this.writer || this.readOnly === "other" ? this.T.READ_ONLY.other : null;
  }
  /** `f()` once this read-only store holds the lock, its reload (load) still to come: at once if it already does. */
  onTakeover(f) {
    this.ontakeover = f;
    if (this.takeoverDue && f) { this.takeoverDue = false; queueMicrotask(f); }
  }
  // (the writer's lock: taken if free; else waited for, read-only meanwhile, and `ontakeover()` called once held.
  // Without Web Locks, read-only for good (fail closed))
  acquire() {
    if (this.writer) return Promise.resolve(true);
    if (this.waiting) return Promise.resolve(false);
    const locks = globalThis.navigator?.locks;
    if (!locks || typeof locks.request !== "function") { this.readOnly = "nolocks"; return (this.acquiring = Promise.resolve(false)); }
    const name = this.kind.lockPrefix + this.id, gen = this.lockGen;
    // (a grant kept only while nothing let go since it was asked for: else returned at once, and the next store's
    // own request has it (astra's CORR-215-2))
    const stale = () => gen !== this.lockGen || this.released;
    const hold = () => {
      this.writer = true; this.readOnly = null;
      return new Promise((done) => { this.unlock = done; });
    };
    this.acquiring = new Promise((decided) => {
      this.lockDone = locks.request(name, { ifAvailable: true }, (lock) => {
        if (!lock || stale()) { decided(false); return null; }
        const held = hold();
        decided(true);
        return held;
      }).catch(() => decided(false));
    }).then((got) => {
      if (got || stale()) return got;
      // (waiting in the lock's queue: granted when the writer's tab lets go, in turn; then this tab writes, once its
      // reload has recovered (load): told by onTakeover, now or whenever it is asked (astra's CORR-215-3))
      this.readOnly = "other";
      this.waiting = new AbortController();
      this.lockDone = locks.request(name, { signal: this.waiting.signal }, (lock) => {
        this.waiting = null;
        if (stale()) return null;
        const held = hold();
        if (this.ontakeover) { const f = this.ontakeover; queueMicrotask(() => f()); }
        else this.takeoverDue = true;
        return held;
      }).catch(() => { this.waiting = null; });
      return false;
    });
    return this.acquiring;
  }
  // (let go: the lock, or the place in its queue, and any grant still on its way; resolves once the browser has it back)
  letGo() {
    this.lockGen++;
    this.waiting?.abort();
    this.waiting = null;
    this.unlock?.();
    this.unlock = null;
    this.writer = false; this.ready = false; this.takeoverDue = false;
    return Promise.resolve(this.lockDone).catch(() => {});
  }
};

/** What the page shows and allows for a store (the page's controls; a plain store: everything). */
export function pageControls(store) {
  const why = store?.journaled ? store.viewOnly : null;
  return { readOnly: !!why, bar: why, name: !why, mode: !why, repro: !why, rename: !why, trash: !why, history: !why };
}
/** The store the page now uses, `next`, after `prev`: `prev` let go (its lock, its history) only if it is another
 * store; the same store reattached (a takeover's reload) is kept as it is. */
export function switchJournal(prev, next) {
  if (prev && prev !== next) prev.release();
  return next?.journaled ? next : null;
}

/** The journal's store of a kind's documents: `Base`'s record with {j, hash} (T2), its saves made only after their T1,
 * and its load recovering per the table in web/notebook/journal.js.  `history`: the kind's history over
 * journalPatchStore(hdb, id, kind), the kind made from the history's module `mod` by `kindOf(mod)`. */
const makeJournalStore = (Base, journalPatchStore, kindOf) => class JournalStore extends writerLock(Base) {
  constructor(db, hdb, id, initial, mod) {
    super(db, id, initial, { journal: true });
    this.hdb = hdb; this.mod = mod;
    // (the document's kind (its history, records, merge, texts, lock and switch) and its texts)
    this.kind = kindOf(mod); this.T = journalTexts(this.kind.noun);
    this.patches = journalPatchStore(hdb, id, this.kind);
    // (two phases of a writer (daybreak3's P2): `ready`, its load and recovery done: saves, versions, clears and drops
    // from outside; `recovering`, its load's own writes only (recovery's T1 catch-up, T2 and prune). T1's hook allows
    // either; a clear or a drop (mutateOK) and a public save only the first)
    this.patches.writerOK = () => this.writer && !this.released && (this.ready || this.recovering);
    this.patches.mutateOK = () => this.writer && !this.released && this.ready;
    this.history = this.kind.history(this.patches);
    this.recovered = null;
    this.inflight = 0; this.released = false; this.opening = null; this.idleWaiters = []; this.mutating = null;
    // (a TimeTravel clear or a drop deletes the versions a mark's proof rests on (astra's CORR-229-1): it waits until no
    // save is between its proof and its T2, marks the record first (durably, so a crash after it leaves the record
    // marked), and saves asked for meanwhile wait for it; the next save, or recovery, unmarks it by the proof again)
    for (const k of ["clear", "drop"]) {
      const f = this.patches[k].bind(this.patches);
      // (a started document's TimeTravel isn't cleared: its versions are what sync sends, and a clear's re-record would
      // be a root the server can't take (astra's pin 1 on 2c-2); until 2c-4's clear)
      this.patches[k] = (opts) => (k === "clear" && this.synced ? Promise.reject(new Error(this.T.NO_CLEAR_SYNCED)) : this.exclusive(() => f(opts)));
    }
    // (the writer's lock: `writer` once held; `readOnly` why not (READ_ONLY's keys), while waiting for it)
    this.writer = false; this.readOnly = null; this.unlock = null; this.waiting = null; this.ontakeover = null;
    // (`ready`: a writer whose load (and recovery) has begun: only then does it write; `lockGen`: what a lock's grant
    // must still match to be kept (a release in between makes it stale); `takeoverDue`: a grant not yet told)
    this.ready = false; this.lockGen = 0; this.takeoverDue = false;
  }
  // (2c-2: a started document's history is its synced history, under its own key, its patches from the slot's client)
  async useSynced() {
    const js = await readJournal(this.hdb, this.id);
    if (!js.start) return;
    const key = syncedKey(this.id, js.start.n);
    if (this.patches.id !== key) { this.history.close(); this.patches.id = key; }
    this.synced = js.start;
    useClient(this.history, js.slot.client, js.slot.last);
    this.watchRemote(js.slot.client);
  }
  // (2c-3: another device's patch stored here (doc-sync.ts, told by tellHistory): the writer makes the record their merge
  // with this device's value, once, after the burst)
  watchRemote(client) {
    this.unwatchRemote?.();
    const off = this.patches.subscribe((env) => {
      if (typeof env?.time !== "string" || env.time.slice(12) === client) return;
      clearTimeout(this.remoteTimer);
      // (`remoteHold`, tests only: a promise the merge waits for, holding open the window in which the history has
      // another device's patch and the page doesn't (test-doc-sync.mjs, the lagging device's case))
      this.remoteTimer = setTimeout(() => { void Promise.resolve(this.remoteHold).then(() => this.remoteArrived()).catch((e) => console.warn("sync: a remote change not merged:", e)); }, 50);
    });
    // (an acknowledgement over the wire (doc-sync.ts) released the debt: a history paused for want of room resumes, as
    // ackedUpTo's does (astra's CORR-2C3-3))
    const offAcked = this.patches.onAcked(() => { void this.resumeAfterAck().catch((e) => console.warn("sync: a paused history not resumed:", e)); });
    this.unwatchRemote = () => { off(); offAcked(); };
  }
  async resumeAfterAck() {
    if (this.history.paused && this.writer && this.ready && !this.released) await this.history.init();
  }
  async remoteArrived() {
    if (!this.writer || !this.ready || this.released) return;
    await this.history.init();
    // (the page's editor, when it has one: it merges with what it shows, unsaved edits too, and saves (journal.js's
    // users: the notebook page, a board page); else the record itself)
    if (this.onremote) return this.onremote();
    const rec = await super.loadRecord();
    if (!rec) return;
    const { doc } = await this.mergeRemote((({ j: _j, hash: _h, rev: _r, unjournaled: _u, ...d }) => d)(rec));
    // (the merge already holds the head: its base is the head, so its version is what the record adds to it)
    return this.writeSave({ ...doc, baseRev: rec.rev }, { base: this.kind.fromRecords(this.history.committed()), merging: true });
  }
  /** The merge of the server's patches with `mine` (this device's value: the record's, or what the editor shows).
   * Theirs is the history's head; the base is mergeBaseOf's (a notebook's: the merged value of every version at or
   * below the record's j, or the synced root; a board's: the version at that j).  A base this history can't give
   * completely refuses: deferMerge, nothing written or sent, and the next arrival tries again (astra3's BASE-1).
   * The kind merges (its apply), told which side is the later by patch id (`wins`: the side with the later patch,
   * the same on every device, so they converge):
   * - a notebook: exact merges (plan-exact-only r1), its records by dbMerge3 with the later side as dbMerge3's `b`.
   *   Every edit is kept, text merged within a cell; never a clash.
   * - a board: boardMerge3.  A clash (or a refused merge, which keeps the later side whole) is reported, and the other
   *   side's version stays in TimeTravel (its patches are stored on both devices), never dropped quietly (astra's A3
   *   on 2c-3).
   * A marked record's value (saved with no room for its version, 2c-1d-iii) is in no version, so its side is always
   * the later one (`shown`): kept whole on a board's clash, dbMerge3's `b` for a notebook.  The merge stays marked
   * until its catch-up keeps it as a version, which then reaches the other devices (astra's CORR-2C3-2).
   * Resolves {doc, clashes, kept}: `clashes` is always [] for a notebook, so `kept` is null; for a board, `kept`
   * names the side kept on a clash ("theirs" or "mine"). */
  async mergeRemote(mine) {
    const rec = await super.loadRecord(), js = await readJournal(this.hdb, this.id);
    let theirsLast = "";
    for (const [time, j] of js.jOf) if (j > (rec?.j ?? 0) && time.slice(12) !== js.slot?.client && time > theirsLast) theirsLast = time;
    const session = this.history.session;
    // (the base: the record's proof when it has a valid one (the versions it is, exactly); a record from before proofs
    // and not marked: the history at its j, as it was written; a marked one without a valid proof is set aside by
    // recovery (legacy) and never reaches here as it was)
    // (a marked record this store wrote: its value is the head it was merged with plus what was typed, so that head
    // is its base, exactly)
    const under = rec?.unjournaled === true ? this.revs?.get(rec.rev)?.under : null, marked = rec?.unjournaled === true && !under ? this.baseOfMarked(rec) : null;
    const proved = rec ? (await this.baseOfValue(rec, rec.hash, { rec, j: rec.j, jOf: js.jOf })) ?? (under && !under.noVersions ? { time: null, value: this.kind.toRecords(under) } : marked ? { time: null, value: marked } : null) : null;
    if (!proved && rec?.unjournaled === true) throw Object.assign(new Error("sync: a change from elsewhere waits: this notebook's last save here is in no version"), { deferMerge: true });
    const mb = proved ? { time: proved.time, value: proved.value } : mergeBaseOf(js.jOf, rec?.j ?? 0, js.start, session);
    // (a base the history here can't give completely: no merge now (nothing saved, nothing sent); the next arrival tries
    // again, once the versions it needs are here (astra3's BASE-1))
    if (mb.refuse) throw Object.assign(new Error(`sync: a change from elsewhere waits: ${mb.refuse}`), { deferMerge: true });
    const baseTime = mb.time, base = mb.value ? this.kind.fromRecords(mb.value) : null;
    const head = this.kind.fromRecords(session.value());
    // (which side is the later, by patch id (a notebook's dbMerge3 `b`, a board's clash keeper): the two sides' last
    // versions compared, this device's (its own at or below the record's j) and the other's, so every device names the
    // same one; a marked record's side is always the later (§3))
    let mineLast = "";
    for (const [time, j] of js.jOf) if (j <= (rec?.j ?? 0) && time.slice(12) === js.slot?.client && time > mineLast) mineLast = time;
    const theirsWin = !rec?.unjournaled && theirsLast > mineLast;
    const r = this.kind.apply(base, mine, head, theirsWin ? "remote" : "shown");
    return { doc: this.withValue(rec ?? mine, this.kind.toRecords(r.value)), clashes: r.clashes, kept: r.clashes.length ? (theirsWin ? "theirs" : "mine") : null };
  }
  // (the synced history started (William's D6(a)): a new key, the root the whole value `doc`, from a new client, all of
  // it in the root's one T1 (journal-rows.js t1Write `start`); refused, the history as it was)
  async startSynced(doc) {
    if (this.synced) throw new Error(this.T.STARTED);
    const n = 1, key = syncedKey(this.id, n), client = makeClientId(), old = this.patches.id;
    const was = { client: this.history.clientId, lastMs: this.history.lastMs };
    this.history.close();
    this.patches.id = key;
    useClient(this.history, client, null);
    await this.history.init();
    // (the root patch measured as doc-sync will send it, its payload without time and parents (doc-sync.ts send): one
    // over the batch bound would be stopped there for good, so the history isn't started at all.  Measured on the
    // session's preview, before anything is committed or appended, and the envelope committed is the one measured
    // (history.admit, patch-history.js commit; astra3's A-SA-2 on #353); the value is the one recovered under the
    // writer's lock (A-SA-1))
    this.history.admit = (env) => {
      const { time: _t, parents: _p, ...payload } = env;
      return new TextEncoder().encode(JSON.stringify(payload)).length > LIMITS.batchBytes ? { refused: this.T.TOO_LARGE_TO_SYNC, tooLarge: true } : null;
    };
    let env;
    try { env = this.history.record(doc, NO_VERSIONS); } finally { this.history.admit = undefined; }
    let r = { refused: "nothing to record" };
    if (env?.notAdmitted) r = env.notAdmitted;
    else if (env && !env.pending) {
      this.patches.start = { n, client, time: env.time };
      try { r = await this.patches.appended(env.time); } finally { this.patches.start = undefined; }
    }
    if (r.j !== undefined) { this.synced = { n, from_j: r.j }; this.watchRemote(client); this.toldSaved(); return true; }
    this.history.close();
    this.patches.id = old;
    this.history.clientId = was.client; delete this.history.sessionOptions; this.history.lastMs = was.lastMs;
    await this.history.init();
    // (the refusal kept with the error: for room (roomRefused), too large, or another (the grader's R-SA-1 on #353))
    throw Object.assign(new Error(r.refused ?? "not kept"), { refusal: r });
  }
  /** A new client for this document's slot (2c-3, 2c-4: after a final refusal, an epoch move, `unknown_client`): the
   * rotation's transaction, then the history's session made again with it, so every later patch is the new client's. */
  async rotateClient() {
    const r = await this.patches.queue(() => this.patches.journalTx(async (st) => ({ j: 0, slot: await rotate(st, this.id, makeClientId(), { noun: this.kind.noun }) })));
    if (!r?.slot) throw new Error(r?.refused ?? "not rotated");
    useClient(this.history, r.slot.client, null);
    await this.history.init();
    return r.slot;
  }
  /** The server's acknowledgement of this document's client (gen, client) up to cseq `upTo` (2c-3): its l rows and debt
   * released, in the history's queue; a history paused for want of room then resumes (astra's pin 3 on 2c-2). */
  async ackedUpTo(which) {
    const r = await this.patches.queue(() => this.patches.journalTx(async (st) => ({ j: 0, n: await acked(st, this.id, which) })));
    if (r?.n) await this.resumeAfterAck();
    return r;
  }
  /** This document's client's l rows up to cseq `upTo`, marked sent with fence generation `fgen` (2c-3, before a send). */
  markSentUpTo(which) {
    return this.patches.queue(() => this.patches.journalTx(async (st) => ({ j: 0, n: await markSent(st, this.id, which) })));
  }
  // (told after a synced document's save is kept, and after its synced history starts: the kind's switch's `saved`)
  toldSaved() { try { this.kind.sync.saved?.(this.id); } catch (e) { console.warn(`sync: a ${this.kind.noun}'s save not told:`, e); } }
  // (the history open; opened again when a save comes after it was let go)
  async open() {
    if (this.history.session) return;
    this.opening ??= this.history.init().finally(() => { this.opening = null; });
    await this.opening;
  }
  /** The page is done with this document: its history let go once its saves still running are done (a save after it
   * opens it again). */
  release() {
    this.released = true;
    this.draining ??= this.drain().finally(() => { this.draining = null; });
    return this.draining;
  }
  // (the one way this store lets go, whatever asks (the page leaving it, a failed takeover, a release while saves run):
  // only once nothing of it can still commit: its load's writes (recovery's catch-up, T2 and prune), every save running
  // (T1, T2, prune) and its history's queue, each waited for until none is left (astra's CORR-215-5, CORR-215-6))
  async drain() {
    for (;;) {
      const a = this.patches.appending, l = this.loading, m = this.mutating;
      await Promise.allSettled([a, l, m]);
      if (this.inflight) { await new Promise((r) => { this.whenIdle = r; }); continue; }
      if (a === this.patches.appending && l === this.loading && m === this.mutating) break;
    }
    if (!this.released) return;
    this.unwatchRemote?.(); this.unwatchRemote = null; clearTimeout(this.remoteTimer);
    this.history.close();
    return this.letGo();
  }
  // (the codec's text of a document's versioned records: an intent's value)
  textOf(doc) { return this.history.codec.toString(this.kind.toRecords(doc)); }
  // (the hash of the history's versioned value as it is now, as hashOf hashes a document)
  headHash() { return hashOf(this.kind, this.kind.fromRecords(this.history.session.value())); }
  /** T1 for a save of `doc`, made from `base` (the document `doc` derives from, exactly): what was typed since `base`
   * merged three-way into the head (history.js record), never `doc` over the head, so a change from elsewhere that
   * the page doesn't show yet is kept (William's reverted edit, Nov 13).  Its intent is that merged value, with its
   * version when it changed (and TimeTravel isn't paused); resolves {j, merged} once committed, or {refused}.  The
   * merge and the version's parents are taken in one step (the session's commit): the version is exactly the heads it
   * was merged with, plus what was typed. */
  async t1(doc, base, again = true, merging = false, before = null) {
    await this.open();
    // (a T1 alone (tests' crash points): its base as a save's would be)
    if (!base) { const b = await this.baseFor(doc); if (b.conflict) return { refused: "the record has changed since this document was made from it" }; base = b.base; }
    if (!this.history.committed()) return { refused: "its history isn't open here yet" };
    // (the head this save is merged with, taken before its first try: a refused version stays in the session until
    // its rebuild, so a retry's head would be this save's own value)
    const heads = before?.heads ?? this.history.heads(), under = before?.under ?? this.kind.fromRecords(this.history.committed());
    const next = this.history.mergedWith(doc, base), merged = this.withValue(doc, next);
    const intent = { srev: doc.baseRev ?? null, value: this.textOf(merged) };
    this.patches.intent = intent;
    let env;
    try { env = this.history.commit(next); } finally { this.patches.intent = undefined; }
    const r = await (env?.pending ?? (env ? this.patches.appended(env.time) : writeIntent(this.patches, intent)));
    // (`at`: the patches whose value the merged one is, its proof (§ the base); none while paused (a pending intent
    // with no version: unproved))
    const at = env?.pending ? null : env ? [env.time] : heads.length && heads.length <= MAX_AT ? heads : null;
    if (r.j !== undefined || env?.pending || !env) {
      // (kept for the next save of the document this one had (save's), never for the store's own merge, which no page showed)
      if (!merging && (r.j !== undefined || env?.pending)) this.lastT1 = { baseRev: doc.baseRev, local: doc };
      return { ...r, merged, at, under, from: heads };
    }
    // (a version the journal didn't keep: the history paused, the session rebuilt without it, and the save's intent
    // written alone instead, once)
    this.history.refused(env.time);
    return again ? this.t1(doc, base, false, merging, { heads, under }) : { ...r, merged, under, from: heads };
  }
  // (`f`, a clear or a drop, alone: after the ones asked for before it, once no save is between its proof and its T2,
  // the record marked first)
  exclusive(f) {
    const run = (this.mutating ?? Promise.resolve()).then(async () => {
      while (this.inflight) await new Promise((r) => { this.idleWaiters.push(r); });
      if (this.writer && this.ready && !this.released) await this.markRecord();
      return f();
    });
    const tail = run.then(() => {}, () => {});
    this.mutating = tail;
    tail.then(() => { if (this.mutating === tail) this.mutating = null; });
    return run;
  }
  // (the record marked, its value and revision as they are: no version need hold it until the proof says so again)
  async markRecord() {
    const rec = await super.loadRecord();
    if (!rec || rec.unjournaled || typeof rec.hash !== "string") return;
    const out = await super.save(rec, { journal: { keep: true, hash: rec.hash, unjournaled: true, markOnly: true } });
    if (typeof out === "string") throw new Error(out);
  }
  // (the record at the revisions this store last read or wrote: the base of a save made from one of them, exactly;
  // a revision not among them is answered as T2 would, a conflict)
  // (a record is a save's base when the history holds its value; a marked one's value is in no version (no room, or
  // paused), so its base is the head it was merged with when this store wrote it (`under`), and, for one read as it is
  // (recovery left it marked: still no room), the head, but only in a history no other device has written; else none)
  async baseFor(doc) {
    const rec = this.seen(await super.loadRecord());
    const e = doc.baseRev === undefined || doc.baseRev === rec?.rev ? this.revs?.get(rec?.rev) ?? (rec ? { rec } : null) : this.revs?.get(doc.baseRev);
    if (rec && !e) return { conflict: rec };
    if (!e) return { base: NO_VERSIONS };
    if (!e.rec.unjournaled) return { base: e.rec };
    if (e.under) return { base: e.under };
    const proved = this.baseOfMarked(e.rec);
    if (proved) return { base: this.kind.fromRecords(proved) };
    const js = await readJournal(this.hdb, this.id), client = js.slot?.client;
    if (this.synced && (!client || [...js.jOf].some(([t]) => t.slice(12) !== client))) return { refused: "not saved: this notebook's last save here is in no version, and another device has changed it since: reload this page" };
    return { base: this.history.docOfHead?.() ?? this.kind.fromRecords(this.history.committed()) };
  }
  // (a marked record's base proof, written with it: the heads its value was merged with (`from`), not the versions it is
  // (it is in none); its base, then, exactly: those heads' value, or null (none, from other rules, or not all here))
  fromProof(r) { return Array.isArray(r?.from) && r.from.length && r.from.length <= MAX_AT ? { from: r.from, proof: PROOF } : {}; }
  baseOfMarked(rec) {
    if (rec?.proof !== PROOF || !Array.isArray(rec.from) || !rec.from.length || rec.from.length > MAX_AT || !rec.from.every((t) => typeof t === "string")) return null;
    return this.history.valueOfHeads(rec.from);
  }
  seen(rec, under = null) {
    if (rec && Number.isSafeInteger(rec.rev)) {
      this.revs ??= new Map();
      const had = this.revs.get(rec.rev);
      this.revs.delete(rec.rev);
      this.revs.set(rec.rev, { rec, under: under ?? (had?.rec === rec ? had.under : null) });
      if (this.revs.size > 32) this.revs.delete(this.revs.keys().next().value);
    }
    return rec;
  }
  /** T1, then T2, then the intents it settles pruned.  `opts.base`: the document `doc` derives from (notebook.js
   * queueSave's); without one, the record at `doc.baseRev` (the revision T2's compare and swap requires: what `doc` was
   * made from, exactly), answered as T2 would if the record has moved on since; with no baseRev, the record as it is
   * (which such a save's T2 writes over); with no record, nothing (the first version). */
  async save(doc, opts = {}) {
    if (opts.journal) return super.save(doc, opts);
    // (only this document's writer here saves, once its load and recovery are done: for the milestone, one tab per
    // device; a read-only tab's own state, flushed as it is reattached at a takeover, is refused (board's B), and so is
    // a save while recovery runs or after a release (daybreak3's P2))
    if (!this.writer || !this.ready || this.released) return this.T.NOT_WRITER;
    if (!opts.base) {
      const b = await this.baseFor(doc);
      if (b.conflict) return b;
      if (b.refused) return b.refused;
      opts = { ...opts, base: b.base };
    }
    // (a save after one of this store's whose T1 was kept and whose T2 wasn't (busy, refused, a conflict, cut off),
    // made from the same revision: its document grew from the document that save had (the page never showed that T1's
    // merge, which may hold another device's change), so that document is its base; from the record it would merge
    // this page's own edit with itself (test-record-base.mjs, row 0), from that T1's merge undo the other's change)
    if (this.lastT1 && this.lastT1.baseRev === doc.baseRev) opts = { ...opts, base: this.lastT1.local };
    // (a save from a marked record this store wrote: that value is in no version, so its base is the head it was
    // merged with (`under`), and what it added is recorded now, with what was typed since)
    else {
      const e = this.revs?.get(doc.baseRev), proved = e?.rec?.unjournaled && !e.under ? this.baseOfMarked(e.rec) : null;
      if (e?.rec?.unjournaled && (e.under || proved)) opts = { ...opts, base: e.under ?? this.kind.fromRecords(proved) };
    }
    const out = await this.writeSave(doc, opts);
    if (out && typeof out === "object") {
      if (out.conflict) this.seen(out.conflict);
      else if (out.doc && out.rev !== undefined) this.seen({ ...out.doc, rev: out.rev, ...(out.unjournaled ? { unjournaled: out.unjournaled } : {}) }, out.under ?? null);
    }
    return out;
  }
  // (the mark a T2 of `doc` (its hash `hash`) writes, the history's head read now, after its version step (§2))
  async markOf(doc, hash) {
    // (a version just refused is in the head until the session's rebuild without it is done: read after it)
    while (this.history.rebuilding) await this.history.rebuilding.catch(() => {});
    if ((await this.headHash()) === hash) return false;
    return neverFits(this.textOf(doc)) ? "too-large" : true;
  }
  // (a save's T1, T2 and prune, counted while they run: a release waits for them (drain))
  async writeSave(given, { base, merging = false, ...opts } = {}) {
    // (not while a clear or a drop runs: its versions gone, this save's proof is read after it)
    while (this.mutating) await this.mutating;
    this.inflight++;
    try {
      // (what is kept, T1 and T2 alike, is the merged value: never the page's document where it lags)
      // (the merged value keeps the revision T2's compare and swap requires: a kind's withValue needn't carry it)
      const r = await this.t1(given, base, true, merging), doc = r.merged ? { ...r.merged, ...(given.baseRev !== undefined ? { baseRev: given.baseRev } : {}) } : given, hash = await hashOf(this.kind, doc);
      if (r.j === undefined) {
        if (!roomRefused(r)) return `not saved: ${r.refused ?? "not kept"}`;
        // (no room for its T1: the record written all the same, its j kept, marked (§1); saved only if T2 commits)
        const mark = neverFits(this.textOf(doc)) ? "too-large" : true;
        // (no version holds it: unproved, no `at`)
        const out = await super.save(doc, { ...opts, journal: { keep: true, hash, unjournaled: mark, ...this.fromProof(r) } });
        if (out && typeof out === "object" && out.saved) this.lastT1 = null;
        return out && typeof out === "object" && out.saved ? { ...out, doc, under: r.under, saved: mark === true ? this.T.SAVED_UNJOURNALED : this.T.SAVED_TOO_LARGE, unjournaled: mark } : out;
      }
      const mark = await this.markOf(doc, hash);
      const out = await super.save(doc, { ...opts, journal: { j: r.j, hash, unjournaled: mark, ...(mark ? this.fromProof(r) : r.at ? { at: r.at, proof: PROOF } : {}) } });
      if (out && typeof out === "object" && out.saved) {
        this.lastT1 = null;
        await prune(this.patches, r.j);
        if (this.synced) this.toldSaved();
        if (mark === "too-large") return { ...out, doc, under: r.under, saved: this.T.SAVED_TOO_LARGE, unjournaled: mark };
        // (what was kept: the page shows it, and takes it as its base (notebook.js queueSave))
        return { ...out, doc, ...(mark ? { under: r.under, unjournaled: mark } : {}) };
      }
      return out;
    } finally {
      if (!--this.inflight) { for (const w of this.idleWaiters.splice(0)) w(); const r = this.whenIdle; this.whenIdle = null; r?.(); }
    }
  }
  async load() {
    this.released = false;
    await this.useSynced();
    // (not the writer: shown as it is, read-only, with nothing written (no recovery: that is the writer's))
    if (!(await this.acquire())) {
      this.viewed = true;
      await this.open();
      const rec = await super.loadRecord();
      if (!this.writer) {
        this.recovered = { doc: rec ?? this.kind.empty(this.id, this.initial), row: "read-only" };
        return this.recovered.doc;
      }
      // (granted while it loaded read-only: loaded as the writer instead, recovery first; nothing left to tell)
      this.takeoverDue = false;
    }
    // (the writer from here: its saves and versions allowed; a tab taking over from a read-only view reads its history
    // again, as the writer left it; not ready again until this load's recovery is done, even if an earlier load was:
    // a load or recovery that fails writes nothing more, no save, no version, until a load succeeds (astra's
    // CORR-215-5); the page then lets the lock go)
    this.recovering = true; this.ready = false;
    this.loading = (async () => {
      // (not while a clear or a drop runs (astra's CORR-229-2): recovery's T2 would unmark the record it marked before
      // deleting; not ready now, so its turn refuses it if it hasn't deleted yet, and the mark stays until the proof
      // below.  The load's own saves wait for nothing else: nothing can be running here when a store first loads)
      while (this.mutating) await this.mutating;
      // (the synced history's key and client read again now, under the writer's lock: a start or a rotation by the tab
      // that held it before is adopted, never an earlier read's (astra's CORR-2C2-2)); the history made again from it
      await this.useSynced();
      this.viewed = false;
      await this.history.init();
      for (let i = 0; ; i++) {
        const out = await this.recover(await super.loadRecord());
        if (out || i >= 4) { this.recovered = out ?? { row: "busy" }; break; }
      }
      if (this.recovered.row === "busy") throw new Error(this.T.BUSY);
      // (2c-3: started here with none of its synced history yet: not opened, nothing written; the page says it is still
      // arriving and asks for its pull (sync-docs' N-2C3-1))
      if (this.recovered.row === "arriving") throw Object.assign(new Error(this.T.ARRIVING), { arriving: true });
      // (2c-2: a document not yet synced starts its synced history now, from the value recovered; one that can't (no
      // room, say) stays local this time, and tries again at its next load)
      // (why it didn't start, kept for a caller that walks many (notebook/start-all.js): too large, for room, or another)
      this.startRefused = null;
      if (this.kind.sync.on && !this.synced) await this.startSynced(this.recovered.doc).catch((e) => {
        const r = e?.refusal ?? null;
        this.startRefused = { message: String(e?.message ?? e), tooLarge: !!r?.tooLarge, room: !!r && roomRefused(r) };
        console.warn(`sync: a ${this.kind.noun}'s synced history not started:`, e);
      });
      return this.recovered.doc;
    })();
    try {
      const doc = this.seen(await this.loading);
      this.ready = true;
      return doc;
    } finally {
      this.recovering = false;
    }
  }
  /** The editor's merge of an unsaved edit with a change from elsewhere (notebook.js applyRemote): the kind's history
   * module's mergeTextAt (cocalc-ai's mergeText, the selection mapped), or undefined for a kind without one (a board's
   * page has its own editor) (plan-exact-only r1). */
  get mergeText() { return this.mod?.mergeTextAt; }
  // (the record with the versioned part of `value` (the history's records): the kind's withValue)
  withValue(rec, value) { return this.kind.withValue(rec, value); }
  /** Recovery (design r4 §3): {doc, row: "consistent" | "stamped" | "rewritten" | "new" | "from-server" | "deferred" (a
   * merge waiting for versions not here yet: nothing written), catchUp?},
   * {row: "arriving"} (nothing written), or null when the record changed under its compare and swap (load reads it
   * again and replays again). */
  async recover(rec) {
    const state = await readJournal(this.hdb, this.id);
    const above = state.intents.filter((it) => it.j > (rec && Number.isSafeInteger(rec.j) ? rec.j : 0));
    const chosen = replay(rec ? rec.rev ?? 0 : null, above);
    if (!rec && !chosen && this.synced && state.jOf.size) {
      // (2c-3: a document this device has only from the server (its synced history pulled, no record yet): the record
      // is the history's head, its j the history's J, unmarked)
      // (the kind's new document with the history's head as its versioned part: the store adds no field of its own)
      const doc = this.kind.withValue(this.kind.empty(this.id, this.initial), this.history.session.value());
      const hash = await hashOf(this.kind, doc);
      const out = await super.save(doc, { journal: { j: state.J, hash } });
      if (typeof out === "string") throw new Error(out);
      return out.conflict ? null : { doc: { ...doc, rev: out.rev, j: state.J, hash }, row: "from-server" };
    }
    if (!rec && !chosen && this.synced) {
      // (2c-3: started here, no record, and none of its synced history yet (a start whose pull brought nothing, or rows
      // a remove dropped meanwhile): still arriving, and nothing written.  A fresh record here would fork it: its first
      // save is a local root patch on the synced history (t1Write's l row), which the page's DocSync sends before any
      // page could stop it (sync-docs' N-2C3-1, after the grader's N-ST-2))
      return { doc: null, row: "arriving" };
    }
    if (!rec && !chosen) {
      // (a new document, never started: its first save journaled like any other)
      const fresh = this.kind.empty(this.id, this.initial);
      const saved = await this.writeSave(fresh, { base: NO_VERSIONS });
      if (typeof saved === "string") throw new Error(saved);
      return saved.conflict ? null : { doc: { ...fresh, rev: saved.rev }, row: "new" };
    }
    const base = rec ?? this.kind.empty(this.id, this.initial);
    const recText = this.textOf(base);
    const value = chosen ? chosen.value : recText, own = value === recText;
    let doc = own ? (({ j: _j, hash: _h, rev: _r, unjournaled: _u, ...d }) => d)(base) : this.withValue(base, this.history.codec.fromString(value));
    // (2c-3: another device's patches stored above the record's j (a page applied, its T2 not written yet): merged
    // with the chosen value, never reverted by the catch-up below (astra's A1 on 2c-3))
    const slotClient = state.slot?.client;
    const merged = !!rec && !!slotClient && [...state.jOf].some(([time, j]) => j > (rec.j ?? 0) && time.slice(12) !== slotClient);
    if (merged) {
      // (a merge whose base this history can't give yet (mergeBaseOf's refusal): nothing written now, the record shown as
      // it is; its intents stay, and the next load or arrival tries again (astra3's BASE-1))
      try { doc = (await this.mergeRemote(doc)).doc; } catch (e) { if (e?.deferMerge) return { doc: rec, row: "deferred" }; throw e; }
    }
    let hash = await hashOf(this.kind, doc);
    const big = neverFits(merged ? this.textOf(doc) : value);
    // (consistent: its own value, j and hash right, and unmarked, or marked too large with nothing to try (§4))
    const settled = (mark) => rec && own && rec.j === state.J && rec.hash === hash && (rec.unjournaled ?? false) === mark;
    if (settled(false) || (big && settled("too-large"))) {
      if (state.intents.some((it) => it.j <= rec.j)) await prune(this.patches, rec.j);
      return { doc: rec, row: "consistent" };
    }
    // (TimeTravel's catch-up: the head made the chosen value by one version, with no intent, before T2; its committed
    // j is the record's.  Refused, the record takes J, and TimeTravel's head waits for the next save.  For a marked
    // record it is the value's ingestion (§3); never tried for a value that can't be kept (§4))
    // (the proof recovery's T2 writes with its value, so a reload finds the base again (never lost by a rewrite): the
    // record's own when its value is kept as it was; else what the catch-up made, taken with it)
    let j = state.J, catchUp = null, legacy = null;
    let proof = own && rec?.proof === PROOF ? (Array.isArray(rec.at) ? { at: rec.at } : Array.isArray(rec.from) ? { from: rec.from } : {}) : {};
    if (!big && (await this.headHash()) !== hash) {
      // (what the value changed is merged in from the version it is, never the value over the head (William's
      // reverted edit); a value that is no version is set aside whole, in the record, and the head shown: nothing of
      // it recorded or sent until the person decides (the legacy rule))
      // (a history no other device has written: nothing in it a value could undo, so its head is the base; with
      // another device's patches, the value's own provenance or none (the legacy rule: a stale record written
      // at a later j than the patch it lags is in no way told apart from a later edit))
      // ("no other device": over every retained row of the history, by the patches' own client ids; a synced history
      // whose slot client isn't known counts as another device's (unknown is no proof); one never synced has no other
      // device's patches)
      const foreign = !!this.synced && (!slotClient || [...state.jOf].some(([t]) => t.slice(12) !== slotClient));
      const marked = own && rec?.unjournaled ? this.baseOfMarked(rec) : null;
      const from = merged || !foreign ? { value: this.history.committed() } : (await this.baseOfValue(doc, hash, { rec: own ? rec : null, j: own ? rec?.j : chosen?.j, jOf: state.jOf })) ?? (marked ? { value: marked } : null);
      // (the heads the value is merged with, taken before anything is committed: its base's proof if it stays marked)
      const heads0 = this.history.heads();
      if (from) {
        const next = this.history.mergedWith(doc, this.kind.fromRecords(from.value));
        doc = this.withValue(doc, next);
        const env = this.history.commit(next);
        const r = env && !env.pending ? await this.patches.appended(env.time) : env ? { refused: "paused" } : {};
        if (r.j !== undefined) { j = r.j; catchUp = r.j; proof = { at: [env.time] }; }
        else {
          if (env && !env.pending) this.history.refused(env.time);
          proof = heads0.length ? (env ? { from: heads0 } : { at: heads0 }) : {};
        }
      } else {
        legacy = { value: this.textOf(doc), j: own ? rec?.j ?? null : chosen?.j ?? null, kept: Date.now() };
        doc = { ...this.withValue(doc, this.history.committed()), legacy };
        proof = heads0.length ? { at: heads0 } : {};
      }
      hash = await hashOf(this.kind, doc);
    }
    // (the mark from the head read after the catch-up step (§2, §3); nothing to write if nothing differs (a marked
    // record whose catch-up was refused again))
    const mark = await this.markOf(doc, hash);
    if (settled(mark) && j === state.J) {
      if (state.intents.some((it) => it.j <= rec.j)) await prune(this.patches, rec.j);
      return { doc: rec, row: "consistent" };
    }
    const carried = mark ? (proof.from && proof.from.length <= MAX_AT ? { from: proof.from, proof: PROOF } : {}) : proof.at && proof.at.length <= MAX_AT ? { at: proof.at, proof: PROOF } : {};
    const out = await super.save({ ...doc, ...(rec ? { baseRev: rec.rev } : {}) }, { journal: { j, hash, unjournaled: mark, ...carried } });
    if (typeof out === "string") throw new Error(out);
    if (out.conflict) return null;
    await prune(this.patches, j);
    const { at: _a, from: _f, proof: _p, ...plainDoc } = doc;
    return { doc: { ...plainDoc, rev: out.rev, j, hash, ...(mark ? { unjournaled: mark } : {}), ...carried }, row: legacy ? "legacy" : merged ? "merged" : own ? "stamped" : "rewritten", catchUp };
  }
  /** The version `doc` (whose versioned part hashes to `hash`) is exactly, if its provenance says so: its record's
   * proof (`rec.at`, made under these rules), or the version written in the same T1 as it (the one at its j), each
   * checked against the content: {time, value (records)}, or null.  Never looked for among other versions: a value
   * equal to an older version may be a stale page's or a deliberate revert, and which can't be told, so
   * a value without its own provenance (a stale page's, from before proofs, or one with no room for its version) has
   * no base, and is never given a guessed one. */
  async baseOfValue(doc, hash, { rec = null, j = null, jOf = null } = {}) {
    if (typeof hash !== "string") return null;
    const tries = [];
    const at = rec?.proof === PROOF ? rec.at : null;
    if (Array.isArray(at) && at.length && at.length <= MAX_AT && at.every((t) => typeof t === "string") && new Set(at).size === at.length) tries.push(at);
    if (jOf && Number.isSafeInteger(j)) for (const [t, jj] of jOf) if (jj === j) tries.push([t]);
    const seen = new Set();
    for (const times of tries) {
      const key = times.join(",");
      if (seen.has(key)) continue;
      seen.add(key);
      const value = this.history.valueOfHeads(times);
      if (value && (await hashOf(this.kind, this.withValue(doc, value))) === hash) return { time: times[times.length - 1], value };
    }
    return null;
  }
  /** What the page asks of a store to know it is the journal's. */
  get journaled() { return true; }
};
