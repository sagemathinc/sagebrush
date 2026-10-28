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
import { bytesHash } from "./stores.js";
import { t1Write, dropRows, readJournal, roomRefused, syncedKey, acked, markSent, rotate } from "./journal-rows.js";
import { writeIntent, prune, neverFits, replay, NOT_WRITER } from "../journal/core.js";
import { makeClientId, decodePatchId } from "patchflow";
import { mergeRecords3 } from "./merge3.js";
export * from "./journal-rows.js";
// (the journal's store-level part, kind-neutral, moved to web/journal/core.js: here under the same names)
export { writeIntent, prune, neverFits, replay } from "../journal/core.js";

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

/** Notebooks' part of the journal (web/journal/core.js's per-kind hook), over the history's module `mod` (history.js):
 * `apply` merges by records (merge3.js mergeRecords3), the side `wins` names kept whole on a clash. */
export function notebookKind(mod) {
  return {
    kind: "notebooks",
    versionedOf,
    apply(lastSynced, shown, remote, wins) {
      const [a, b] = wins === "remote" ? [remote, shown] : [shown, remote];
      const r = mergeRecords3(mod.SCHEMA, mod.recordsOf(lastSynced), mod.recordsOf(a), mod.recordsOf(b));
      return { value: r.clashes.length ? a : mod.docOfRecords(r.value), clashes: r.clashes };
    },
    conflictCopy: null,
  };
}

/** The journal's classes over the page's stores (stores.js: `{IdbStore, IdbPatchStore}`, the page's own copy):
 * {JournalStore, journalPatchStore}. */
export function journalClasses({ IdbStore, IdbPatchStore }) {
  /** A notebook's history store whose writes are the journal's: T1 on every version (an IdbPatchStore with the
   * journal's hooks), and, while paused, a save's intent alone (F4). */
  function journalPatchStore(hdb, id) {
    // (nothing written but by the notebook's writer here: `writerOK`, set by its JournalStore)
    // (`start`: a synced history's start, set by the store for its root's append (2c-2))
    const store = new IdbPatchStore(hdb, id, { journal: { t1: (st, row, intent) => (store.writerOK?.() === false ? Promise.resolve({ refused: NOT_WRITER }) : t1Write(st, id, { row, intent, start: row && store.start?.time === row.time ? store.start : undefined })), drop: (st) => dropRows(st, id) } });
    // (the notebook's journal identity, for good: `store.id` is its history's key, which a synced notebook's start
    // changes to `<id>:s<n>`; every journal row is the notebook's (astra's CORR-2C2-1))
    store.docId = id;
    // (F4: paused, a save's T1 is its intent alone; nothing to write for a version that isn't a save's)
    store.writePending = () => (store.intent ? writeIntent(store, store.intent) : Promise.resolve({ refused: "TimeTravel is paused for this notebook" }));
    return store;
  }
  return { JournalStore: makeJournalStore(IdbStore, journalPatchStore), journalPatchStore };
}

/** Whether this page syncs notebooks' contents (DEV's docsync switch, set by the page once the journal is active): a
 * writer's load then starts a notebook's synced history (2c-2). */
export const DOC_SYNC = { on: false, saved: null };
// (`saved(id)`: told after a synced notebook's save is kept, and after its synced history starts, so the page's DocSync
// sends it (DEV's switch, web/workspace/doc-sync-switch.ts); null: nobody to tell)
const toldSaved = (id) => { try { DOC_SYNC.saved?.(id); } catch (e) { console.warn("sync: a notebook's save not told:", e); } };
// (a history's patches made by `client` from now on (a synced document's slot), each id after `last` (the slot's last
// patch id, or null): ids keep rising across reloads and clock changes.  Here, not in patch-history.js, so the no-sync
// board build doesn't grow (plan r4 F3))
function useClient(history, client, last) {
  history.clientId = client;
  if (last) history.lastMs = Math.max(history.lastMs, decodePatchId(last).timeMs);
  history.sessionOptions = function () { return { codec: this.codec, patchStore: this.guarded, clientId: client }; };
}
const NO_CLEAR_SYNCED = "TimeTravel's history can't be cleared while this notebook syncs (it will be, once conflicts are handled)";

/** The one writer of a notebook on this device, for the milestone (William, Oct 27: "Yes, single writer per device for
 * the milestone"): the Web Lock a journal store holds while it may write the notebook.  Another tab's store waits for
 * it, read-only; the browser frees it when its holder's tab closes or crashes. */
export const writerLockName = (id) => `sagebrush-nb-writer:${id}`;
/** Why a store isn't its notebook's writer: another tab is, or this browser can't tell (no Web Locks). */
export const READ_ONLY = {
  other: "This notebook is open for editing in another tab of this browser, so it's read-only here (two tabs editing it could overwrite each other's work). It becomes editable here as soon as that tab closes it or opens another notebook.",
  nolocks: "This browser can't make sure that only one tab edits a notebook at a time, so notebooks are read-only in it. An up-to-date Chrome, Edge, Firefox or Safari can edit them.",
};
/** Said when a read-only tab becomes the writer (the page's status line). */
export const TAKEOVER = "You can edit this notebook here now (the other tab let go of it).";
/** Said when a read-only tab couldn't reopen the notebook as its writer (and let the lock go). */
export const TAKEOVER_FAILED = "This notebook couldn't be opened for editing here: reload this page to try again.";
/** What the page shows and allows for a store (the notebook page's controls; a plain store: everything). */
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
/** Said for a save whose T1 had no room, written all the same (2c-1d-iii §1): never a promise of each version. */
export const SAVED_UNJOURNALED = "Saved in this browser. TimeTravel and sync can't keep versions right now (their storage is full): they'll keep the latest one when there's room.";
/** Said for a save of a notebook too large ever to be kept as a version (2c-1d-iii §4). */
export const SAVED_TOO_LARGE = "This notebook is too large to sync. It's saved in this browser.";

/** The journal's notebook store: IdbStore's record with {j, hash} (T2), its saves made only after their T1, and its
 * load recovering per the table above.  `history`: a NotebookHistory over journalPatchStore(hdb, id), whose
 * module (history.js) is passed in `mod` ({NotebookHistory, toRecords, fromRecords, SCHEMA}). */
const makeJournalStore = (IdbStore, journalPatchStore) => class JournalStore extends IdbStore {
  constructor(db, hdb, id, initial, mod) {
    super(db, id, initial, { journal: true });
    this.hdb = hdb; this.mod = mod;
    this.patches = journalPatchStore(hdb, id);
    // (two phases of a writer (daybreak3's P2): `ready`, its load and recovery done: saves, versions, clears and drops
    // from outside; `recovering`, its load's own writes only (recovery's T1 catch-up, T2 and prune). T1's hook allows
    // either; a clear or a drop (mutateOK) and a public save only the first)
    this.patches.writerOK = () => this.writer && !this.released && (this.ready || this.recovering);
    this.patches.mutateOK = () => this.writer && !this.released && this.ready;
    this.history = new mod.NotebookHistory(this.patches);
    this.recovered = null;
    this.inflight = 0; this.released = false; this.opening = null; this.idleWaiters = []; this.mutating = null;
    // (a TimeTravel clear or a drop deletes the versions a mark's proof rests on (astra's CORR-229-1): it waits until no
    // save is between its proof and its T2, marks the record first (durably, so a crash after it leaves the record
    // marked), and saves asked for meanwhile wait for it; the next save, or recovery, unmarks it by the proof again)
    for (const k of ["clear", "drop"]) {
      const f = this.patches[k].bind(this.patches);
      // (a started document's TimeTravel isn't cleared: its versions are what sync sends, and a clear's re-record would
      // be a root the server can't take (astra's pin 1 on 2c-2); until 2c-4's clear)
      this.patches[k] = (opts) => (k === "clear" && this.synced ? Promise.reject(new Error(NO_CLEAR_SYNCED)) : this.exclusive(() => f(opts)));
    }
    // (the writer's lock: `writer` once held; `readOnly` why not (READ_ONLY's keys), while waiting for it)
    this.writer = false; this.readOnly = null; this.unlock = null; this.waiting = null; this.ontakeover = null;
    // (`ready`: a writer whose load (and recovery) has begun: only then does it write; `lockGen`: what a lock's grant
    // must still match to be kept (a release in between makes it stale); `takeoverDue`: a grant not yet told)
    this.ready = false; this.lockGen = 0; this.takeoverDue = false;
  }
  /** This store's notebook isn't writable here: READ_ONLY's text, or null. */
  get viewOnly() {
    if (this.writer && this.ready) return null;
    if (this.readOnly === "nolocks") return READ_ONLY.nolocks;
    return this.writer || this.readOnly === "other" ? READ_ONLY.other : null;
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
    const name = writerLockName(this.id), gen = this.lockGen;
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
    // users: the notebook page); else the record itself)
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
    const base = baseTime ? this.mod.fromRecords(session.value({ time: baseTime })) : { mode: mine.mode, cells: [] };
    const head = this.mod.fromRecords(session.value());
    // (which side a clash keeps: the later one, by patch id; this device's side is its last version's (the record's j))
    const theirsWin = !rec?.unjournaled && theirsLast > (baseTime ?? "");
    const r = (this.kind ??= notebookKind(this.mod)).apply(base, mine, head, theirsWin ? "remote" : "shown");
    return { doc: this.withValue(rec ?? mine, this.mod.toRecords(r.value)), clashes: r.clashes, kept: r.clashes.length ? (theirsWin ? "theirs" : "mine") : null };
  }
  // (the synced history started (William's D6(a)): a new key, the root the whole value `doc`, from a new client, all of
  // it in the root's one T1 (journal-rows.js t1Write `start`); refused, the history as it was)
  async startSynced(doc) {
    if (this.synced) throw new Error("this notebook's synced history has already started");
    const n = 1, key = syncedKey(this.id, n), client = makeClientId(), old = this.patches.id;
    const was = { client: this.history.clientId, lastMs: this.history.lastMs };
    this.history.close();
    this.patches.id = key;
    useClient(this.history, client, null);
    await this.history.init();
    const env = this.history.record(doc);
    let r = { refused: "nothing to record" };
    if (env && !env.pending) {
      this.patches.start = { n, client, time: env.time };
      try { r = await this.patches.appended(env.time); } finally { this.patches.start = undefined; }
    }
    if (r.j !== undefined) { this.synced = { n, from_j: r.j }; this.watchRemote(client); toldSaved(this.id); return true; }
    this.history.close();
    this.patches.id = old;
    this.history.clientId = was.client; delete this.history.sessionOptions; this.history.lastMs = was.lastMs;
    await this.history.init();
    throw new Error(r.refused ?? "not kept");
  }
  /** A new client for this notebook's slot (2c-3, 2c-4: after a final refusal, an epoch move, `unknown_client`): the
   * rotation's transaction, then the history's session made again with it, so every later patch is the new client's. */
  async rotateClient() {
    const r = await this.patches.queue(() => this.patches.journalTx(async (st) => ({ j: 0, slot: await rotate(st, this.id, makeClientId()) })));
    if (!r?.slot) throw new Error(r?.refused ?? "not rotated");
    useClient(this.history, r.slot.client, null);
    await this.history.init();
    return r.slot;
  }
  /** The server's acknowledgement of this notebook's client (gen, client) up to cseq `upTo` (2c-3): its l rows and debt
   * released, in the history's queue; a history paused for want of room then resumes (astra's pin 3 on 2c-2). */
  async ackedUpTo(which) {
    const r = await this.patches.queue(() => this.patches.journalTx(async (st) => ({ j: 0, n: await acked(st, this.id, which) })));
    if (r?.n) await this.resumeAfterAck();
    return r;
  }
  /** This notebook's client's l rows up to cseq `upTo`, marked sent with fence generation `fgen` (2c-3, before a send). */
  markSentUpTo(which) {
    return this.patches.queue(() => this.patches.journalTx(async (st) => ({ j: 0, n: await markSent(st, this.id, which) })));
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
    // (only this notebook's writer here saves, once its load and recovery are done: for the milestone, one tab per
    // device; a read-only tab's own state, flushed as it is reattached at a takeover, is refused (board's B), and so is
    // a save while recovery runs or after a release (daybreak3's P2))
    if (!this.writer || !this.ready || this.released) return NOT_WRITER;
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
      const r = await this.t1(doc), hash = await docHash(doc);
      if (r.j === undefined) {
        if (!roomRefused(r)) return `not saved: ${r.refused ?? "not kept"}`;
        // (no room for its T1: the record written all the same, its j kept, marked (§1); saved only if T2 commits)
        const mark = neverFits(this.textOf(doc)) ? "too-large" : true;
        const out = await super.save(doc, { ...opts, journal: { keep: true, hash, unjournaled: mark } });
        return out && typeof out === "object" && out.saved ? { ...out, saved: mark === true ? SAVED_UNJOURNALED : SAVED_TOO_LARGE, unjournaled: mark } : out;
      }
      const mark = await this.markOf(doc, hash);
      const out = await super.save(doc, { ...opts, journal: { j: r.j, hash, unjournaled: mark } });
      if (out && typeof out === "object" && out.saved) {
        await prune(this.patches, r.j);
        if (this.synced) toldSaved(this.id);
        if (mark === "too-large") return { ...out, saved: SAVED_TOO_LARGE, unjournaled: mark };
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
        this.recovered = { doc: rec ?? { ...(this.initial ?? { name: "Untitled", mode: "python", cells: [] }), id: this.id }, row: "read-only" };
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
      if (this.recovered.row === "busy") throw new Error("the notebook kept changing while it was opened: reload this page");
      // (2c-2: a notebook not yet synced starts its synced history now, from the value recovered; one that can't (no
      // room, say) stays local this time, and tries again at its next load)
      if (DOC_SYNC.on && !this.synced) await this.startSynced(this.recovered.doc).catch((e) => console.warn("sync: a notebook's synced history not started:", e));
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
    if (!rec && !chosen && this.synced && state.jOf.size) {
      // (2c-3: a notebook this device has only from the server (its synced history pulled, no record yet): the record
      // is the history's head, its j the history's J, unmarked)
      const head = this.mod.fromRecords(this.history.session.value());
      const doc = { ...(this.initial ?? { name: "Untitled" }), ...head, id: this.id };
      const hash = await docHash(doc);
      const out = await super.save(doc, { journal: { j: state.J, hash } });
      if (typeof out === "string") throw new Error(out);
      return out.conflict ? null : { doc: { ...doc, rev: out.rev, j: state.J, hash }, row: "from-server" };
    }
    if (!rec && !chosen) {
      // (a new notebook: its first save journaled like any other)
      const fresh = { ...(this.initial ?? { name: "Untitled", mode: "python", cells: [] }), id: this.id };
      const saved = await this.writeSave(fresh);
      if (typeof saved === "string") throw new Error(saved);
      return saved.conflict ? null : { doc: { ...fresh, rev: saved.rev }, row: "new" };
    }
    const base = rec ?? { ...(this.initial ?? { name: "Untitled", mode: "python", cells: [] }), id: this.id };
    const recText = this.textOf(base);
    const value = chosen ? chosen.value : recText, own = value === recText;
    let doc = own ? (({ j: _j, hash: _h, rev: _r, unjournaled: _u, ...d }) => d)(base) : this.withValue(base, this.history.codec.fromString(value));
    // (2c-3: another device's patches stored above the record's j (a page applied, its T2 not written yet): merged
    // with the chosen value, never reverted by the catch-up below (astra's A1 on 2c-3))
    const slotClient = state.slot?.client;
    const merged = !!rec && !!slotClient && [...state.jOf].some(([time, j]) => j > (rec.j ?? 0) && time.slice(12) !== slotClient);
    if (merged) doc = (await this.mergeRemote(doc)).doc;
    const hash = await docHash(doc), big = neverFits(merged ? this.textOf(doc) : value);
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
