// A document's edit history as patchflow patches on records (TimeTravel),
// shared by the notebook's (history.js) and the board's (web/board/history.ts).
// The document is a set of records keyed by their primary keys (a codec from
// createImmerDbCodec(schema)); each change is a patch with its parents, so
// the history is compact and any version can be rebuilt.  Patches are kept
// by a PatchStore (IdbPatchStore: this browser's IndexedDB, shared by the
// tabs that have the document open).  Patches marked {meta: {journal: true}}
// are not versions (the notebook's execution journal).
import { Session, createImmerDbCodec, decodePatchId } from "patchflow";
export { createImmerDbCodec, decodePatchId };

// A patch the store refuses (too large, or too many waiting: notebook/stores.js) breaks the chain: the next patch
// names it as a parent, and a version built on it would be wrong once the page is reloaded (astra's CORR-896-1).
// So, the invariant: no stored patch's parents reach a refused one.  After a refusal the history is paused for
// this document: each next version is stored only as a new root of its own (no parents; its patch the whole
// document, from nothing), under its own id, and once one is stored, those after it chain to it as usual.  One
// that doesn't fit is refused in turn, and the history stays paused.  The versions before the refusal stay, as
// they were; the refused ones are never offered, here or after a reload, and the store's notice says so.
export class PatchHistory {
  /** @param store a patchflow PatchStore, with clear(); @param codec an immer-db codec (createImmerDbCodec) */
  constructor(store, codec) {
    this.store = store; this.codec = codec; this.session = null; this.listeners = new Set(); this.edits = null;
    this.refused = new Set(); this.paused = false; this.next = null;
    // (the store as the session sees it: its append through append() below, the rest as they are)
    this.guarded = new Proxy(store, { get: (t, k) => (k === "append" ? (env) => this.append(env) : typeof t[k] === "function" ? t[k].bind(t) : t[k]) });
  }
  // (a patch the session made, stored as it is, or, paused, as a new root; refused: the history paused)
  append(env) {
    let out = env;
    if (this.paused) {
      out = { ...env, parents: [], patch: this.codec.makePatch(this.codec.fromString(""), this.next ?? this.session.value({ time: env.time })) };
      delete out.mergeParent; delete out.mergePatch; delete out.inexact;
    }
    const took = this.store.append(out);
    if (took === false) { this.refused.add(env.time); this.paused = true; this.edits = null; }
    else if (this.paused) this.paused = false;
    return took;
  }
  async init() {
    this.session?.close();
    this.refused = new Set(); this.paused = false;
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
    if (!this.session || next.isEqual(this.committed())) return null;
    this.edits = null;
    this.next = next;
    let env;
    try { env = meta ? this.session.commit(next, { meta }) : this.session.commit(next); } finally { this.next = null; }
    this.emit();
    return env;
  }
  // the patch ids that are versions (not the journal's), oldest first
  editTimes() {
    if (!this.session) return [];
    // (a refused one never offered: its patch isn't kept, and a version made over it is kept as a root of its own)
    return (this.edits ??= this.session.versions().filter((t) => !this.refused.has(t) && !this.session.getPatch(t)?.meta?.journal));
  }
  /** The versions, oldest first: {time (the patch id), ms, index}. */
  versions() {
    return this.editTimes().map((time, index) => ({ time, ms: decodePatchId(time).timeMs, index }));
  }
  /** The newest version's id, or null. */
  head() { const e = this.editTimes(); return e[e.length - 1] ?? null; }
  /** The records at a version. */
  valueAt(time) { return this.session.value({ time }); }
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
