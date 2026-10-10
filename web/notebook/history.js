// TimeTravel: a notebook's edit history, as patchflow patches on records in
// the format of CoCalc's Jupyter documents (cocalc-ai: jupyter/redux/sync.ts,
// primary keys type and id, string column input):
//
//   {type: "settings", kernel: "python3" | "sagemath" | "magma"}
//   {type: "cell", id, pos, input, cell_type: "code" | "markdown" | "raw"}
//
// Outputs are not kept: only what was typed.  Each change is a patch with its
// parents (diff-match-patch for the text of a cell), so the history is
// compact, any version can be rebuilt, and the patches could be sent to CoCalc
// as they are.  Patches are kept by a PatchStore (IdbPatchStore: this
// browser's IndexedDB, shared by the tabs that have the notebook open).
import { Session, createImmerDbCodec, decodePatchId } from "patchflow";

export const SCHEMA = { primaryKeys: ["type", "id"], stringCols: ["input"] };
const codec = createImmerDbCodec(SCHEMA);
const KERNEL = { python: "python3", sage: "sagemath", magma: "magma" };
const MODE = { python3: "python", sagemath: "sage", magma: "magma" };

/** A notebook document (web/notebook/types.ts) as records. */
export function toRecords(doc) {
  let d = codec.fromString("");
  d = d.set({ type: "settings", kernel: KERNEL[doc.mode] ?? "python3" });
  (doc.cells ?? []).forEach((c, i) => {
    // (a Markdown cell's attachments are part of its content: restored with it)
    d = d.set({ type: "cell", id: c.id, pos: i, input: c.code ?? "", cell_type: c.type === "markdown" || c.type === "raw" ? c.type : "code",
               ...(c.type === "markdown" && c.attachments ? { attachments: c.attachments } : {}) });
  });
  return d;
}
/** Records as a notebook document (no outputs). */
export function fromRecords(d) {
  const kernel = d.getOne({ type: "settings" })?.kernel;
  const cells = d.get({ type: "cell" }).slice().sort((a, b) => (a.pos ?? 0) - (b.pos ?? 0))
    .map((r) => (r.cell_type === "markdown" || r.cell_type === "raw"
      ? { id: r.id, type: r.cell_type, code: r.input ?? "", ...(r.attachments ? { attachments: r.attachments } : {}) }
      : { id: r.id, code: r.input ?? "" }));
  return { mode: MODE[kernel] ?? "python", cells };
}

export class NotebookHistory {
  /** @param store a patchflow PatchStore, with clear() */
  constructor(store) { this.store = store; this.session = null; this.listeners = new Set(); }
  async init() {
    this.session?.close();
    this.session = new Session({ codec, patchStore: this.store });
    await this.session.init();
    this.session.on("change", () => this.emit());
    this.unclear = this.store.onClear?.(() => this.init().then(() => this.emit()));
    return this;
  }
  on(f) { this.listeners.add(f); return () => this.listeners.delete(f); }
  emit() { for (const f of this.listeners) f(); }
  /** Record the document as it is now (nothing if it has not changed). */
  record(doc) {
    if (!this.session) return null;
    const next = toRecords(doc);
    if (this.session.getCommittedDocument()?.isEqual(next)) return null;
    const env = this.session.commit(next);
    this.emit();
    return env;
  }
  /** The versions, oldest first: {time (the patch id), ms, index}. */
  versions() {
    return (this.session?.versions() ?? []).map((time, index) => ({ time, ms: decodePatchId(time).timeMs, index }));
  }
  /** The document at a version. */
  docAt(time) { return fromRecords(this.session.value({ time })); }
  /** The patches, for sending elsewhere (CoCalc). */
  patches() { return this.session?.history() ?? []; }
  /** Forget every version; the history starts again from `doc`. */
  async clear(doc) {
    await this.store.clear();
    await this.init();
    if (doc) this.record(doc);
    this.emit();
  }
  close() { this.unclear?.(); this.session?.close(); this.session = null; this.listeners.clear(); }
}
