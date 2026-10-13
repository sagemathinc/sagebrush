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

export class PatchHistory {
  /** @param store a patchflow PatchStore, with clear(); @param codec an immer-db codec (createImmerDbCodec) */
  constructor(store, codec) { this.store = store; this.codec = codec; this.session = null; this.listeners = new Set(); this.edits = null; }
  async init() {
    this.session?.close();
    this.session = new Session({ codec: this.codec, patchStore: this.store });
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
    const env = meta ? this.session.commit(next, { meta }) : this.session.commit(next);
    this.emit();
    return env;
  }
  // the patch ids that are versions (not the journal's), oldest first
  editTimes() {
    if (!this.session) return [];
    return (this.edits ??= this.session.versions().filter((t) => !this.session.getPatch(t)?.meta?.journal));
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
