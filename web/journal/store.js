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
//                      subclass, with record(doc).  The store uses its record, refused, init, close, session (value),
//                      codec (toString, fromString), paused, rebuilding, clientId, lastMs, sessionOptions, and its
//                      patch store's subscribe and onAcked
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
import { t1Write, dropRows, readJournal, readSync, roomRefused, syncedKey, acked, markSent, rotate } from "./rows.js";
import { writeIntent, prune, neverFits, replay, journalTexts } from "./core.js";
import { makeClientId, decodePatchId } from "patchflow";
import { LIMITS } from "../sync-protocol/protocol";
import { EXACT_MERGE_CLIENT } from "../workspace/merge-client";

const canonical = (v) => JSON.stringify(v, (k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((key) => [key, x[key]])) : x));
/** The hash of what a kind's history keeps of `doc` (SHA-256 of the canonical JSON of its versionedOf). */
export const hashOf = (kind, doc) => bytesHash(new TextEncoder().encode(canonical(kind.versionedOf(doc))));
export { canonical };

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
    // (a synced history's merge mode, read with its patches (IdbPatchStore.loadInitial): its start row's, for the
    // synced key only; the document's own key never has one, plan-merge-align r3.2 §5)
    store.readMerge = (st) => readSync(st, id).then(({ start }) => (start && syncedKey(id, start.n) === store.id ? start.merge : undefined));
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
      this.remoteTimer = setTimeout(() => { void this.remoteArrived().catch((e) => console.warn("sync: a remote change not merged:", e)); }, 50);
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
    return this.writeSave({ ...doc, baseRev: rec.rev });
  }
  /** The merge of the server's patches with `mine` (this device's value: the record's, or what the editor shows): base
   * the history's value at the record's j, theirs the history's head.  Changes on separate cells, or separate lines of
   * one cell, are all kept.  A clash (the same cell's same field, a cell deleted on one side and changed on the
   * other, too much to merge) is decided the same way on every device, so they converge: the side with the later
   * patch (patch ids: time, then client) is kept whole, and the other side's version stays in TimeTravel (its patches
   * are stored on both devices), never dropped quietly (astra's A3 on 2c-3).  But a marked record's value (saved with
   * no room for its version, 2c-1d-iii) is in no version: replacing it would lose it, so its side is kept whole on a
   * clash (the remote side stays in TimeTravel), and the merge stays marked until its catch-up keeps it as a version,
   * which then reaches the other devices (astra's CORR-2C3-2).  Resolves {doc, clashes, kept}. */
  async mergeRemote(mine) {
    const rec = await super.loadRecord(), js = await readJournal(this.hdb, this.id);
    let baseTime = null, best = -1, theirsLast = "";
    for (const [time, j] of js.jOf) {
      if (j <= (rec?.j ?? 0) && j > best) { best = j; baseTime = time; }
      if (j > (rec?.j ?? 0) && time.slice(12) !== js.slot?.client && time > theirsLast) theirsLast = time;
    }
    const session = this.history.session;
    const base = baseTime ? this.kind.fromRecords(session.value({ time: baseTime })) : null;
    const head = this.kind.fromRecords(session.value());
    // (which side a clash keeps: the later one, by patch id; this device's side is its last version's (the record's j))
    const theirsWin = !rec?.unjournaled && theirsLast > (baseTime ?? "");
    const r = this.kind.apply(base, mine, head, theirsWin ? "remote" : "shown", this.mergeMode);
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
    try { env = this.history.record(doc); } finally { this.history.admit = undefined; }
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
  /** T1, then T2, then the intents it settles pruned. */
  async save(doc, opts = {}) {
    if (opts.journal) return super.save(doc, opts);
    // (only this document's writer here saves, once its load and recovery are done: for the milestone, one tab per
    // device; a read-only tab's own state, flushed as it is reattached at a takeover, is refused (board's B), and so is
    // a save while recovery runs or after a release (daybreak3's P2))
    if (!this.writer || !this.ready || this.released) return this.T.NOT_WRITER;
    return this.writeSave(doc, opts);
  }
  // (the mark a T2 of `doc` (its hash `hash`) writes, the history's head read now, after its version step (§2))
  async markOf(doc, hash) {
    // (a version just refused is in the head until the session's rebuild without it is done: read after it)
    while (this.history.rebuilding) await this.history.rebuilding.catch(() => {});
    if ((await this.headHash()) === hash) return false;
    return neverFits(this.textOf(doc)) ? "too-large" : true;
  }
  // (a save's T1, T2 and prune, counted while they run: a release waits for them (drain))
  async writeSave(doc, opts = {}) {
    // (not while a clear or a drop runs: its versions gone, this save's proof is read after it)
    while (this.mutating) await this.mutating;
    this.inflight++;
    try {
      const r = await this.t1(doc), hash = await hashOf(this.kind, doc);
      if (r.j === undefined) {
        if (!roomRefused(r)) return `not saved: ${r.refused ?? "not kept"}`;
        // (no room for its T1: the record written all the same, its j kept, marked (§1); saved only if T2 commits)
        const mark = neverFits(this.textOf(doc)) ? "too-large" : true;
        const out = await super.save(doc, { ...opts, journal: { keep: true, hash, unjournaled: mark } });
        return out && typeof out === "object" && out.saved ? { ...out, saved: mark === true ? this.T.SAVED_UNJOURNALED : this.T.SAVED_TOO_LARGE, unjournaled: mark } : out;
      }
      const mark = await this.markOf(doc, hash);
      const out = await super.save(doc, { ...opts, journal: { j: r.j, hash, unjournaled: mark } });
      if (out && typeof out === "object" && out.saved) {
        await prune(this.patches, r.j);
        if (this.synced) this.toldSaved();
        if (mark === "too-large") return { ...out, saved: this.T.SAVED_TOO_LARGE, unjournaled: mark };
      }
      return out;
    } finally {
      if (!--this.inflight) { for (const w of this.idleWaiters.splice(0)) w(); const r = this.whenIdle; this.whenIdle = null; r?.(); }
    }
  }
  async load() {
    this.released = false;
    await this.useSynced();
    await this.exactReadable();
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
      await this.exactReadable();
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
      const doc = await this.loading;
      this.ready = true;
      return doc;
    } finally {
      this.recovering = false;
    }
  }
  // (a synced history whose recorded mode this build can't read (exact-v1 without the exact reader, the define off):
  // refused before its history is opened, read, recovered or written, here and again under the writer's lock (the
  // grader's G-P2b-5; never the legacy codec in its place); nothing of it is touched)
  async exactReadable() {
    if (EXACT_MERGE_CLIENT) return;
    const js = await readJournal(this.hdb, this.id);
    if (js.start?.merge === "exact-v1") throw Object.assign(new Error(this.T.NO_EXACT), { noExact: true });
  }
  /** The recorded merge mode of this document's synced history, or undefined (none recorded yet, or the document's own
   * history): the patch store's, so always current (read with its patches, and told before the next ones). */
  get mergeMode() { return this.patches.id !== this.id ? this.patches.mergeMode : undefined; }
  /** The editor's merge of an unsaved edit (history.js mergeTextAt), for an exact-v1 document only; else undefined.
   * An exact-v1 document in a build without it is refused (NO_EXACT), never merged the older way (plan-p2c r0 S2). */
  get mergeText() {
    if (this.mergeMode !== "exact-v1") return undefined;
    if (!this.mod?.mergeTextAt) throw Object.assign(new Error(this.T.NO_EXACT), { noExact: true });
    return this.mod.mergeTextAt;
  }
  // (the record with the versioned part of `value` (the history's records): the kind's withValue)
  withValue(rec, value) { return this.kind.withValue(rec, value); }
  /** Recovery (design r4 §3): {doc, row: "consistent" | "stamped" | "rewritten" | "new" | "from-server", catchUp?},
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
      const saved = await this.writeSave(fresh);
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
    if (merged) doc = (await this.mergeRemote(doc)).doc;
    const hash = await hashOf(this.kind, doc), big = neverFits(merged ? this.textOf(doc) : value);
    // (consistent: its own value, j and hash right, and unmarked, or marked too large with nothing to try (§4))
    const settled = (mark) => rec && own && rec.j === state.J && rec.hash === hash && (rec.unjournaled ?? false) === mark;
    if (settled(false) || (big && settled("too-large"))) {
      if (state.intents.some((it) => it.j <= rec.j)) await prune(this.patches, rec.j);
      return { doc: rec, row: "consistent" };
    }
    // (TimeTravel's catch-up: the head made the chosen value by one version, with no intent, before T2; its committed
    // j is the record's.  Refused, the record takes J, and TimeTravel's head waits for the next save.  For a marked
    // record it is the value's ingestion (§3); never tried for a value that can't be kept (§4))
    let j = state.J, catchUp = null;
    if (!big && (await this.headHash()) !== hash) {
      const env = this.history.record(doc);
      const r = env && !env.pending ? await this.patches.appended(env.time) : { refused: "paused" };
      if (r.j !== undefined) { j = r.j; catchUp = r.j; } else if (env && !env.pending) this.history.refused(env.time);
    }
    // (the mark from the head read after the catch-up step (§2, §3); nothing to write if nothing differs (a marked
    // record whose catch-up was refused again))
    const mark = await this.markOf(doc, hash);
    if (settled(mark) && j === state.J) {
      if (state.intents.some((it) => it.j <= rec.j)) await prune(this.patches, rec.j);
      return { doc: rec, row: "consistent" };
    }
    const out = await super.save({ ...doc, ...(rec ? { baseRev: rec.rev } : {}) }, { journal: { j, hash, unjournaled: mark } });
    if (typeof out === "string") throw new Error(out);
    if (out.conflict) return null;
    await prune(this.patches, j);
    return { doc: { ...doc, rev: out.rev, j, hash, ...(mark ? { unjournaled: mark } : {}) }, row: merged ? "merged" : own ? "stamped" : "rewritten", catchUp };
  }
  /** What the page asks of a store to know it is the journal's. */
  get journaled() { return true; }
};
