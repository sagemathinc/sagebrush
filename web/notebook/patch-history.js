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
//   one rebuild at a time, again until it holds the tail; one of them refused pauses the history again.
// The versions before the refusal stay as they were; the refused ones are never offered, here or after a reload.
const DETACHED_MAX = 256;
export class PatchHistory {
  /** @param store a patchflow PatchStore, with clear(); @param codec an immer-db codec (createImmerDbCodec) */
  constructor(store, codec) {
    this.store = store; this.codec = codec; this.session = null; this.listeners = new Set(); this.edits = null;
    this.paused = false; this.refusedTime = null; this.tail = null; this.rebuilding = null; this.again = false;
    // (the versions stored by themselves that the session hasn't yet, by their ids: their documents, so that they
    // can be shown meanwhile; at most DETACHED_MAX, the oldest let go (then shown once the session has them))
    this.detached = new Map();
    this.clientId = makeClientId(); this.lastMs = 0; this.version = 1;
    // (the store as the session sees it: its append noting a refusal, the rest as they are)
    this.guarded = new Proxy(store, { get: (t, k) => (k === "append" ? (env) => this.appendMade(env) : typeof t[k] === "function" ? t[k].bind(t) : t[k]) });
  }
  // (a patch the session made, refused: the history paused, the session rebuilt without it)
  appendMade(env) {
    const took = this.store.append(env);
    if (took === false) { this.paused = true; this.refusedTime = env.time; this.edits = null; this.rebuild(); }
    return took;
  }
  // (the session made again from what the store keeps, after any append still waiting; one rebuild at a time,
  // run again while asked for meanwhile or while the session lacks the tail)
  rebuild() {
    if (this.rebuilding) { this.again = true; return this.rebuilding; }
    this.rebuilding = (async () => {
      do {
        this.again = false;
        await this.store.appending;
        const session = new Session({ codec: this.codec, patchStore: this.guarded });
        await session.init();
        this.session?.close();
        this.session = session;
        this.session.on("change", () => { this.edits = null; this.emit(); });
        this.refusedTime = null;
        this.edits = null;
      } while (this.again || (this.tail && !this.session.versions().includes(this.tail.time)));
      this.tail = null;
      this.detached.clear();
    })().catch((e) => console.warn("history:", e)).finally(() => { this.rebuilding = null; this.emit(); });
    return this.rebuilding;
  }
  // (an edit while paused, or before the session has caught up: stored by itself, a root if paused, else a patch
  // from the tail; kept, it is the tail; refused, paused (again), nothing kept)
  commitDetached(next, meta) {
    if (!this.paused && this.tail && next.isEqual(this.tail.doc)) return null;
    const root = this.paused, timeMs = Math.max(Date.now(), this.lastMs + 1);
    this.lastMs = timeMs;
    const env = { time: encodePatchId(timeMs, this.clientId), wall: Date.now(), patch: this.codec.makePatch(root ? this.codec.fromString("") : this.tail.doc, next), parents: root ? [] : [this.tail.time], userId: 0, version: this.version++, ...(meta ? { meta } : {}) };
    if (this.store.append(env) !== false) {
      this.paused = false;
      this.tail = { time: env.time, doc: next };
      this.detached.set(env.time, next);
      if (this.detached.size > DETACHED_MAX) this.detached.delete(this.detached.keys().next().value);
      this.rebuild();
    }
    else { this.paused = true; this.tail = null; }
    this.emit();
    return env;
  }
  /** The pause's state, for tests: paused, a refused version still in the open session, an edit the session hasn't yet, a rebuild running. */
  pauseState() { return { paused: this.paused, refusedTime: this.refusedTime, tail: !!this.tail, rebuilding: !!this.rebuilding }; }
  async init() {
    this.session?.close();
    this.paused = false; this.refusedTime = null; this.tail = null; this.detached = new Map();
    this.session = new Session({ codec: this.codec, patchStore: this.guarded });
    await this.session.init();
    this.edits = null;
    this.session.on("change", () => { this.edits = null; this.emit(); });
    this.unclear = this.store.onClear?.(() => this.init().then(() => this.emit()));
    return this;
  }
  on(f) { this.listeners.add(f); return () => this.listeners.delete(f); }
  emit() { for (const f of this.listeners) f(); }
  /** The records as they are now. */
  committed() { return this.session.getCommittedDocument() ?? this.codec.fromString(""); }
  /** Keep `next` (records) as a version, or, with `meta`, as a patch so marked; null if nothing changed. */
  commit(next, meta) {
    if (!this.session) return null;
    // (paused, or the session not yet caught up after a root: stored by itself, never through the session)
    if (this.paused || this.tail) return this.commitDetached(next, meta);
    if (next.isEqual(this.committed())) return null;
    this.edits = null;
    const env = meta ? this.session.commit(next, { meta }) : this.session.commit(next);
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
  valueAt(time) { return this.detached.get(time) ?? this.session.value({ time }); }
  /** The patches, for sending elsewhere (CoCalc). */
  patches() { return this.session?.history() ?? []; }
  /** Forget every version. */
  async clear() {
    await this.store.clear();
    await this.init();
    this.emit();
  }
  close() { this.unclear?.(); this.session?.close(); this.session = null; this.listeners.clear(); }
}
