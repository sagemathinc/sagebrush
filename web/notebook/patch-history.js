// A document's edit history as patchflow patches on records (TimeTravel),
// shared by the notebook's (history.js) and the board's (web/board/history.ts).
// The document is a set of records keyed by their primary keys (a codec from
// createImmerDbCodec(schema)); each change is a patch with its parents, so
// the history is compact and any version can be rebuilt.  Patches are kept
// by a PatchStore (IdbPatchStore: this browser's IndexedDB, shared by the
// tabs that have the document open).  Patches marked {meta: {journal: true}}
// are not versions (the notebook's execution journal).
import { Session, createImmerDbCodec, decodePatchId, encodePatchId, makeClientId } from "patchflow";
export { createImmerDbCodec, decodePatchId };

// A patch the store refuses (too large, or too many waiting: notebook/stores.js) breaks the chain: the next patch
// would name it as a parent, and a version built on it would be wrong once the page is reloaded (astra's
// CORR-896-1).  So, the invariant: no stored patch's parents reach a refused one.  After a refusal the history is
// paused for this document, in state of a fixed size whatever is edited meanwhile (daybreak2's LIMIT-D761-1):
// - the session is rebuilt from the store, so the refused version is gone from it (until then the open
//   TimeTravel view passes over it: its one id the only one remembered);
// - while paused, an edit never reaches the session: its document is offered to the store as a new root of its
//   own (no parents; its patch the whole document, from nothing), and is kept nowhere if refused;
// - once one is stored, the edits after it are stored, until the session has caught up, as patches from the
//   last one stored (its document the one thing remembered: `tail`), and the session is rebuilt from the store,
//   one rebuild at a time, again until it holds the tail; one of them refused pauses the history again.  Until
//   then the tail is the document as it is now (what's committed, the base of the journal's records and of the
//   next patch: astra's CORR-BE4-1), and the versions stored by themselves are listed once the rebuild holds
//   them, never before (a short lag, never a wrong version: @sagebrush's decision on daybreak2's LIMIT-BE4-1);
// - a rebuild is of one generation of the session: init(), clear() and close() start the next, and a rebuild of
//   an earlier one is let go whole, no session swapped in, nothing subscribed (astra's CORR-BE4-2).
// The versions before the refusal stay as they were; the refused ones are never offered, here or after a reload.
export class PatchHistory {
  /** @param store a patchflow PatchStore, with clear(); @param codec an immer-db codec (createImmerDbCodec) */
  constructor(store, codec) {
    this.store = store; this.codec = codec; this.session = null; this.listeners = new Set(); this.edits = null;
    this.paused = false; this.refusedTime = null; this.tail = null; this.rebuilding = null; this.again = false; this.gen = 0;
    this.clientId = makeClientId(); this.lastMs = 0; this.version = 1;
    // (the store as the session sees it: its append noting a refusal, the rest as they are)
    this.guarded = new Proxy(store, { get: (t, k) => (k === "append" ? (env) => this.appendMade(env) : typeof t[k] === "function" ? t[k].bind(t) : t[k]) });
  }
  // (a session's options: a synced document's history adds its slot's client (web/notebook/journal.js, 2c-2))
  sessionOptions() { return { codec: this.codec, patchStore: this.guarded }; }
  // (a patch the session made, refused: the history paused, the session rebuilt without it)
  appendMade(env) {
    const took = this.store.append(env);
    if (took === false) this.refused(env.time);
    return took;
  }
  /** A version the store didn't keep (refused when asked, or, a journal's, when its transaction ended): the history
   * paused, the session rebuilt without it. */
  refused(time) { this.paused = true; this.refusedTime = time; this.edits = null; this.rebuild(); }
  // (the next generation of the session: any rebuild of the one before let go; one running no longer joined)
  nextGen() { this.gen++; this.rebuilding = null; this.again = false; }
  // (the session made again from what the store keeps, after any append still waiting; one rebuild at a time,
  // run again while asked for meanwhile or while the session lacks the tail; let go whole once of an earlier generation)
  rebuild() {
    if (this.rebuilding) { this.again = true; return this.rebuilding; }
    const gen = this.gen;
    const run = (async () => {
      do {
        if (gen !== this.gen) return;
        this.again = false;
        await this.store.appending;
        if (gen !== this.gen) return;
        const session = new Session(this.sessionOptions());
        await session.init();
        if (gen !== this.gen) { session.close(); return; }
        this.session?.close();
        this.session = session;
        this.session.on("change", () => { this.edits = null; this.emit(); });
        this.refusedTime = null;
        this.edits = null;
      } while (this.again || (this.tail && !this.session.versions().includes(this.tail.time)));
      this.tail = null;
    })().catch((e) => console.warn("history:", e)).finally(() => {
      if (this.rebuilding === run) this.rebuilding = null;
      if (gen === this.gen) this.emit();
    });
    return (this.rebuilding = run);
  }
  // (an edit while paused, or before the session has caught up: stored by itself, a root if paused, else a patch
  // from the tail; kept, it is the tail; refused, paused (again), nothing kept)
  commitDetached(next, meta) {
    // (a journal's history, paused: no version; a save's intent alone is its T1 (F4; notebook/journal.js), and the
    // history stays paused for this page)
    if (this.paused && this.store.writePending) {
      const timeMs = Math.max(Date.now(), this.lastMs + 1);
      this.lastMs = timeMs;
      const env = { time: encodePatchId(timeMs, this.clientId), pending: this.store.writePending() };
      this.emit();
      return env;
    }
    if (!this.paused && this.tail && next.isEqual(this.tail.doc)) return null;
    const root = this.paused, timeMs = Math.max(Date.now(), this.lastMs + 1);
    this.lastMs = timeMs;
    const env = { time: encodePatchId(timeMs, this.clientId), wall: Date.now(), patch: this.codec.makePatch(root ? this.codec.fromString("") : this.tail.doc, next), parents: root ? [] : [this.tail.time], userId: 0, version: this.version++, ...(meta ? { meta } : {}) };
    if (this.store.append(env) !== false) {
      this.paused = false;
      this.tail = { time: env.time, doc: next };
      this.rebuild();
    }
    else { this.paused = true; this.tail = null; }
    this.emit();
    return env;
  }
  /** The pause's state, for tests: paused, a refused version still in the open session, an edit the session hasn't yet, a rebuild running. */
  pauseState() { return { paused: this.paused, refusedTime: this.refusedTime, tail: !!this.tail, rebuilding: !!this.rebuilding }; }
  async init() {
    this.nextGen();
    const gen = this.gen;
    this.session?.close();
    this.session = null;
    this.paused = false; this.refusedTime = null; this.tail = null;
    const session = new Session(this.sessionOptions());
    await session.init();
    if (gen !== this.gen) { session.close(); return this; }
    this.session = session;
    this.edits = null;
    this.session.on("change", () => { this.edits = null; this.emit(); });
    this.unclear?.();
    this.unclear = this.store.onClear?.(() => this.init().then(() => this.emit()));
    return this;
  }
  on(f) { this.listeners.add(f); return () => this.listeners.delete(f); }
  emit() { for (const f of this.listeners) f(); }
  /** The records as they are now; null while the history is (re)opened (no session yet: nothing to base a version
   *  on, so none is made; the next one, made once it is open, has every change since: astra's CORR-529-1). */
  committed() { return this.tail?.doc ?? (this.session ? this.session.getCommittedDocument() ?? this.codec.fromString("") : null); }
  /** Keep `next` (records) as a version, or, with `meta`, as a patch so marked; null if nothing changed. */
  commit(next, meta) {
    if (!this.session) return null;
    // (paused, or the session not yet caught up after a root: stored by itself, never through the session; never
    // with an admission check, which only the session's preview serves)
    if (this.paused || this.tail) return this.admit ? { notAdmitted: { refused: "the history is paused" } } : this.commitDetached(next, meta);
    if (next.isEqual(this.committed())) return null;
    // (an admission check (the journal store's startSynced: the root's size): the envelope previewed, checked, and
    // committed as previewed, or nothing committed or appended: {time, notAdmitted} (astra3's A-SA-2 on #353))
    let preview;
    if (this.admit) {
      preview = this.session.previewCommit(next, meta ? { meta } : {});
      const no = this.admit(preview);
      if (no) { this.session.cancelPreview(preview); return { time: preview.time, notAdmitted: no }; }
    }
    this.edits = null;
    const env = this.session.commit(next, { ...(meta ? { meta } : {}), ...(preview ? { preview } : {}) });
    this.emit();
    return env;
  }
  // the patch ids that are versions (not the journal's), oldest first
  editTimes() {
    if (!this.session) return [];
    // (a refused one never offered: until the rebuild drops it from the session, passed over here)
    return (this.edits ??= this.session.versions().filter((t) => t !== this.refusedTime && !this.session.getPatch(t)?.meta?.journal));
  }
  /** The versions, oldest first: {time (the patch id), ms, index}. */
  versions() {
    return this.editTimes().map((time, index) => ({ time, ms: decodePatchId(time).timeMs, index }));
  }
  /** The newest version's id, or null. */
  head() { const e = this.editTimes(); return e[e.length - 1] ?? null; }
  /** The records at a version. */
  valueAt(time) {
    if (!this.session) throw new Error("history: not available while it is opened");
    return this.session.value({ time });
  }
  /** The patches, for sending elsewhere (CoCalc). */
  patches() { return this.session?.history() ?? []; }
  /** Forget every version. */
  async clear() {
    this.nextGen();
    await this.store.clear();
    await this.init();
    this.emit();
  }
  close() { this.nextGen(); this.unclear?.(); this.session?.close(); this.session = null; this.listeners.clear(); }
}
