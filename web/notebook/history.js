// TimeTravel: a notebook's edit history, as patchflow patches on records in
// the format of CoCalc's Jupyter documents (cocalc-ai: jupyter/redux/sync.ts,
// primary keys type and id, string column input):
//
//   {type: "settings", kernel: "python3" | "sagemath" | "magma" | "matlab"}
//   {type: "cell", id, pos, input, cell_type: "code" | "markdown" | "raw"}
//
// Outputs are not kept: only what was typed.  Each change is a patch with its
// parents (diff-match-patch for the text of a cell), so the history is
// compact, any version can be rebuilt, and the patches could be sent to CoCalc
// as they are.  Patches are kept by a PatchStore (IdbPatchStore: this
// browser's IndexedDB, shared by the tabs that have the notebook open); the
// history itself is patch-history.js's, shared with boards.
//
// The execution journal (design/timetravel-replay.md) is in the same history,
// in patches marked {meta: {journal: true}}, which are not versions:
//
//   {type: "session", id: sid, t, seed?, startup: [clock values], files:
//    [[path, sha256]], ms (to start), kernel: "browser" | "local", version,
//    incomplete?}    an interpreter started (seed: its entropy, absent when
//                    reproducible randomness is off)
//   {type: "run", id: sid:n, sid, n, kind: "code" | "interact", at (the
//    version when it was asked for), cell? | code?, src (hash of the code),
//    mode, repl?, iid?, values?, t, ms, out (hash of its output), clock?,
//    overflow?, status?: "interrupted", foreign?}   (foreign: another
//    notebook's run in the same interpreter, its code inline)
//   {type: "file", id: sid:n, sid, n, t, path, hash | null}   a file put or deleted
//
// A run's code is the cell's input at version `at` (or `code`, for the
// console's).  Only hashes of files are kept; their bytes are elsewhere.
import { PatchHistory, createImmerDbCodec, decodePatchId } from "./patch-history.js";
import { dbMerge3 } from "./db-merge3.ts";
export { decodePatchId };
// (this module is the sagebrush-history.js bundle: boards load the shared history from it)
export { PatchHistory, createImmerDbCodec };
// (and the notebook journal's, loaded with it: notebook/journal.js, given the page's stores)
export { journalClasses, pageControls, switchJournal, TAKEOVER, TAKEOVER_FAILED, DOC_SYNC, arrivingSay, STILL_ARRIVING } from "./journal.js";
// (the journal's store for any kind, for a board page, which loads this bundle lazily: web/journal/store.js)
export { journalStoreClasses, hashOf } from "../journal/store.js";

export const SCHEMA = { primaryKeys: ["type", "id"], stringCols: ["input"] };
const codec = createImmerDbCodec(SCHEMA);
// (exact merges, plan-merge-align r3.2 §5: cocalc-ai's dbMerge3 (db-merge3.ts) as the codec's merge3, for a synced
// history whose server document is exact-v1; patchflow reads codec.merge3 each time it computes a value)
// (compiled in only with __SB_EXACT_MERGE__, as merge-client.ts reads it: a production build carries none of it until
// activation.  The define tested here itself, inline in the condition: Bun folds a define where it is written, but not
// through an imported constant or a const binding, and only a folded condition drops the reader (measured; the built
// page is checked by test-merge-client-off.mjs))
// eslint-disable-next-line no-undef
const exactMerge3 = typeof __SB_EXACT_MERGE__ !== "undefined" && __SB_EXACT_MERGE__ === true ? dbMerge3((s) => codec.fromString(s), (d) => codec.toString(d), SCHEMA) : undefined;
/** The codec of a notebook history kept by `store`: merge3 only while it is a journal store's synced history (its key
 * isn't the document's own id) whose recorded mode is exact-v1 (the store's mergeMode, read with its patches or told
 * before the next ones).  Every other history (a notebook's own, from before sync or restored from a replay; one with
 * no mode recorded, or legacy) reads as it always has.  The mode only ever goes from none to a value, and before it the
 * synced history is this device's one line, which both read alike (rows.js mergeRecorded). */
export function codecFor(store) {
  return Object.create(codec, {
    merge3: {
      get: () => {
        if (!(store && store.docId && store.id !== store.docId && store.mergeMode === "exact-v1")) return undefined;
        // (an exact-v1 history in a build without the reader (told live by a newer tab): fails, never read legacy; the
        // store refuses such a history before it opens it, exactReadable)
        if (!exactMerge3) throw new Error("exact merges aren't in this build: reload this page");
        return exactMerge3;
      },
    },
  });
}
const KERNEL = { python: "python3", sage: "sagemath", magma: "magma", matlab: "matlab" };
const MODE = { python3: "python", sagemath: "sage", magma: "magma", matlab: "matlab" };

function cellRecord(c, i) {
  // (a Markdown cell's attachments are part of its content: restored with it)
  return { type: "cell", id: c.id, pos: i, input: c.code ?? "", cell_type: c.type === "markdown" || c.type === "raw" ? c.type : "code",
           ...(c.type === "markdown" && c.attachments ? { attachments: c.attachments } : {}) };
}
/** A notebook document (web/notebook/types.ts) as records. */
export function toRecords(doc) {
  let d = codec.fromString("");
  d = d.set({ type: "settings", kernel: KERNEL[doc.mode] ?? "python3" });
  (doc.cells ?? []).forEach((c, i) => (d = d.set(cellRecord(c, i))));
  return d;
}
/** A notebook document's records as a plain array (settings, then cells): what merge3.js's mergeRecords3 merges. */
export const recordsOf = (doc) => [...toRecords(doc).get({ type: "settings" }), ...toRecords(doc).get({ type: "cell" })];
/** A plain array of records as a notebook document (no outputs). */
export function docOfRecords(records) {
  let d = codec.fromString("");
  for (const r of records) d = d.set(r);
  return fromRecords(d);
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
const canon = (r) => JSON.stringify(r ?? null, Object.keys(r ?? {}).sort());

/** A short hash of a text (cyrb53), e.g. a run's code. */
export function textHash(s) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

export class NotebookHistory extends PatchHistory {
  /** @param store a patchflow PatchStore, with clear() */
  constructor(store) { super(store, codecFor(store)); }
  /** Record the document as it is now (nothing if it has not changed). */
  record(doc) {
    if (!this.session) return null;
    // only what changed: the journal's records stay as they are
    const cur = this.committed();
    let next = cur;
    const kernel = KERNEL[doc.mode] ?? "python3";
    if (cur.getOne({ type: "settings" })?.kernel !== kernel) next = next.set({ type: "settings", kernel });
    const want = new Map((doc.cells ?? []).map((c, i) => [c.id, cellRecord(c, i)]));
    for (const r of cur.get({ type: "cell" })) if (!want.has(r.id)) next = next.delete({ type: "cell", id: r.id });
    for (const [id, r] of want) {
      const old = cur.getOne({ type: "cell", id });
      if (old && canon(old) === canon(r)) continue;
      if (old) next = next.delete({ type: "cell", id });
      next = next.set(r);
    }
    return this.commit(next);
  }
  /** Add journal records (one patch, which is not a version). */
  journal(records) {
    if (!this.session || !records.length) return null;
    let next = this.committed();
    for (const r of records) next = next.set(r);
    return this.commit(next, { journal: true });
  }
  /** The document at a version. */
  docAt(time) { return fromRecords(this.valueAt(time)); }
  /** The journal's records of a type ("session", "run", "file"). */
  records(type) { return this.session ? this.session.value().get({ type }) : []; }

  /**
   * What resuming at a version replays: the session that was running then
   * (the newest one started before the next version), its runs asked for
   * at this version or before, and its file changes, in order.
   *   {session, events: [{run, code} | {file}], runs, ms (estimated),
   *    blocking: [reasons it cannot be replayed], warnings: [reasons it may differ]}
   */
  replayPlan(time) {
    const ed = this.editTimes(), idx = ed.indexOf(time);
    const plan = { session: null, events: [], runs: 0, ms: 0, blocking: [], warnings: [] };
    if (idx < 0) { plan.blocking.push("unknown version"); return plan; }
    const nextMs = idx + 1 < ed.length ? decodePatchId(ed[idx + 1]).timeMs : Infinity;
    const order = new Map(ed.map((t, i) => [t, i]));
    const sessions = this.records("session").filter((s) => s.t < nextMs).sort((a, b) => a.t - b.t);
    const s = sessions[sessions.length - 1];
    if (!s) return plan; // nothing ran yet: a fresh interpreter
    plan.session = s;
    plan.ms = s.ms ?? 0;
    if (s.kernel && s.kernel !== "browser") plan.blocking.push("the interpreter ran outside this browser");
    if (s.incomplete) plan.blocking.push("some of this interpreter's earlier runs are not in this history (it was cleared, or the runs were another notebook's before Sagebrush recorded those too)");
    if (!s.seed) plan.warnings.push("reproducible randomness was off");
    const runs = this.records("run").filter((r) => r.sid === s.id && (r.at != null && order.has(r.at) ? order.get(r.at) <= idx : r.t < nextMs));
    const files = this.records("file").filter((f) => f.sid === s.id && f.t < nextMs);
    const last = runs.reduce((m, r) => Math.max(m, r.n), -1);
    const evs = [...runs.map((r) => ({ n: r.n, run: r })), ...files.filter((f) => f.n < last || runs.length === 0).map((f) => ({ n: f.n, file: f }))].sort((a, b) => a.n - b.n);
    const docs = new Map();
    for (const e of evs) {
      if (e.file) { plan.events.push(e); continue; }
      const r = e.run;
      let code = r.code;
      if (code === undefined && r.kind === "code") {
        if (!docs.has(r.at)) docs.set(r.at, order.has(r.at) ? this.docAt(r.at) : null);
        code = docs.get(r.at)?.cells.find((c) => c.id === r.cell)?.code;
      }
      if (r.kind === "code" && (code === undefined || (r.src && textHash(code) !== r.src))) plan.blocking.push(`the code of run ${r.n} is not in the history`);
      if (r.status === "interrupted") plan.blocking.push(`run ${r.n} was interrupted`);
      if (r.overflow) plan.warnings.push(`run ${r.n} read the clock too often to be replayed exactly`);
      plan.events.push({ run: r, code });
      plan.runs++;
      plan.ms += r.ms ?? 0;
    }
    plan.blocking = [...new Set(plan.blocking)];
    plan.warnings = [...new Set(plan.warnings)];
    return plan;
  }
  /** Forget every version; the history starts again from `doc`. */
  async clear(doc) {
    await super.clear();
    if (doc) this.record(doc);
    this.emit();
  }
}
