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
import { dbMerge3, mergeDbStrings } from "./db-merge3.ts";
import { diffMain, mergeStrings3 } from "patchflow";
export { decodePatchId };
// (this module is the sagebrush-history.js bundle: boards load the shared history from it)
export { PatchHistory, createImmerDbCodec };
// (and the notebook journal's, loaded with it: notebook/journal.js, given the page's stores)
export { journalClasses, pageControls, switchJournal, TAKEOVER, TAKEOVER_FAILED, DOC_SYNC, arrivingSay, STILL_ARRIVING } from "./journal.js";
// (the journal's store for any kind, for a board page, which loads this bundle lazily: web/journal/store.js)
export { journalStoreClasses, hashOf } from "../journal/store.js";

export const SCHEMA = { primaryKeys: ["type", "id"], stringCols: ["input"] };
// (every notebook's history merges concurrent heads exactly, as CoCalc's Jupyter does: cocalc-ai's dbMerge3
// (db-merge3.ts) as the codec's merge3 (plan-exact-only r1: no mode, no other rule).  patchflow reads it each time it
// computes a value; a linear history (one writer) reads the same with or without it (test-merge-mode-chain.mjs))
const plain = createImmerDbCodec(SCHEMA);
const codec = { ...plain, merge3: dbMerge3((s) => plain.fromString(s), (d) => plain.toString(d), SCHEMA) };
/** The notebook histories' codec (for tests: test-merge-mode-chain.mjs). */
export const notebookCodec = codec;
// (the merges outside the patch graph, CoCalc's way (plan-exact-only r1): the store's and the editor's)
/** The store's merge of a notebook's records (journal.js notebookKind.apply): db-merge3.ts's own mergeDbStrings over
 * them, `b` the later side.  Never a clash. */
export function exactRecords3(base, a, b) {
  const lines = (rs) => rs.map((r) => JSON.stringify(r)).join("\n");
  return mergeDbStrings({ ...SCHEMA, base: lines(base), a: lines(a), b: lines(b) }).split("\n").filter((l) => l !== "").map((l) => JSON.parse(l));
}
/** An edit of a text (base -> local) merged into a newer version of it (base -> remote), as cocalc-ai's mergeText
 * (sync/editor/generic/string-merge3.ts at 0b8b7547, written here from its rules, not copied): nothing either side
 * added is lost. */
export function mergeText({ base, local, remote }) {
  if (local === remote || base === remote) return local;
  if (base === local) return remote;
  return mergeStrings3({ base, a: remote, b: local });
}
// (a position in `from` as a position in `to`, by their diff (UTF-16 units, as a textarea's): kept within text both
// have; at the start of a deleted run for a position inside it; for text inserted exactly at it, before that text if
// `before`, else after it)
function mapPos(diffs, pos, before) {
  let x = 0, y = 0;
  for (const [op, text] of diffs) {
    if (op === 0) {
      if (pos < x + text.length || (pos === x + text.length && before)) return y + pos - x;
      x += text.length; y += text.length;
    } else if (op === -1) {
      if (pos < x + text.length) return y;
      x += text.length;
    } else {
      if (pos === x && before) return y;
      y += text.length;
    }
  }
  return y + pos - x;
}
/** The editor's merge of an unsaved edit (notebook.js applyRemote, through the store's mergeText): mergeText's text,
 * and the selection [start, end] in `local` mapped onto it.  Insertion affinity: a caret stays after the text it
 * follows, with text inserted exactly at it after it; a selection's ends keep text inserted exactly at them outside
 * it. */
export function mergeTextAt({ base, local, remote, sel }) {
  const text = mergeText({ base, local, remote });
  if (!sel || text === local) return { text, sel };
  const d = diffMain(local, text);
  const [s, e] = sel;
  return { text, sel: s === e ? [mapPos(d, s, true), mapPos(d, s, true)] : [mapPos(d, s, false), mapPos(d, e, true)] };
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
/** A notebook document's records as a plain array (settings, then cells): what exactRecords3 merges. */
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
  constructor(store) { super(store, codec); }
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
