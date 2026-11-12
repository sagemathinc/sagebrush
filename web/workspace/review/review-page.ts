// The person's review of an agent's branch: a chunk of its own (sagebrush-review.js), fetched when a page opens a
// review, never at a page's start.  openReview(host, { name }, panel) shows the branch's reviewed commit, file by file:
//   - each file changed, with its one run fact (run-line.ts) and, for the file opened, its diff: a notebook cell by
//     cell (cells.ts), a text file line by line (line-diff.ts), a board as counts, anything else as its sizes;
//   - a notebook's document as submitted, outputs and all, in the notebook component with no interpreter, read only
//     and not reactive, only what outputs.ts lets through (pictures whose headers say their size, and text);
//   - per file Accept, Reject or Ask for changes, with a reason, one note for the whole, and Submit (review-actions.ts:
//     its checks decide; this page shows what they say).  Nothing here runs code.
// With no name, the branches (listBranches), each opening its review.
//
// Bound to what it shows: the branch's root fid and name, the reviewed commit and its review seq, captured at each
// read and handed to Submit as they are.  A change to the branch (onBranch: a commit, a decision, a run's note, in
// this tab or another) redraws it; decisions not yet submitted and any "Replace your version" are cleared when the
// review state changes under them.
//
// One refresh at a time: at most one generation reading, diffing or mounting, and at most one
// change waiting behind it, however many arrive; a generation checks it is still the latest after every wait and
// every 50 cells, and stops if not, letting go of what it read.  A change to the review state alone (a decision, a
// run's note) reads the state again but no file.  Only the file opened is read; only one submitted notebook is
// mounted, and it is destroyed when it is closed, the file or the commit changes, or the review closes.

import { REVIEW_TEXT, listBranches, resumeAccepting, review, type PersonHost } from "../review-actions";
import { branchStoreName, onBranch } from "../branch-wake";
import { openBranchStore, type BranchStore } from "../branch-store";
import type { BranchReview, BranchRuns, FileDecision, ReviewStatus } from "../branch-rules";
import { REVIEW_DIFF, reviewLineDiff, utf8Length, type Seg } from "./line-diff";
import { CELL_LIMITS, cellDiff, foldRows, type CellKey } from "./cells";
import { JSON_LIMITS, jsonValues } from "./json-scan";
import { filterOutputs } from "./outputs";
import { runFact } from "./run-line";
import { boardCounts } from "./board-summary";

/** What the review needs of the workspace: Workspace.reviewHost(). */
export type ReviewHost = PersonHost & { branchRuns(fid: string, name: string): Promise<BranchRuns | null> };
/** The notebook component's module (web/notebook: sagebrush-notebook.js), as the page loads it. */
export type NotebookModule = { createNotebook(root: HTMLElement, opts: Record<string, unknown>): { load(doc: unknown): void; setReadOnly(ro: boolean): void; destroy(): void } };

/** Every word the review page shows of its own; review-actions.ts's REVIEW_TEXT says the refusals. */
export const REVIEW_PAGE_TEXT = {
  status: { open: "Not submitted yet", review: "Waiting for your review", accepted: "Accepted", "partly-accepted": "Partly accepted", rejected: "Rejected", "changes-requested": "Changes asked for" } as Record<ReviewStatus, string>,
  ran: (t: string) => `Ran in the branch at ${t}`,
  changedSince: (t: string) => `Changed since its run at ${t}`,
  noRun: "No run recorded in the branch",
  open: "Review changes",
  replace: "Replace your version",
  submitted: "The notebook as submitted",
  unchangedCells: (n: number) => (n === 1 ? "1 unchanged cell" : `${n.toLocaleString("en-US")} unchanged cells`),
  unchangedLines: (n: number) => (n === 1 ? "1 unchanged line" : `${n.toLocaleString("en-US")} unchanged lines`),
  moreCells: (n: number) => (n === 1 ? "1 more changed cell not shown" : `${n.toLocaleString("en-US")} more changed cells not shown`),
  tooLargeText: (a: string, b: string) => `Too large to compare line by line (${a} → ${b}).`,
  tooManyCells: `Too many cells to compare (more than ${CELL_LIMITS.cells.toLocaleString("en-US")}).`,
  noPreview: (a: string, b: string) => `Changed: ${a} → ${b}. No preview for this kind of file.`,
  boardCounts: (added: number, removed: number, changed: number) => [[added, "added"], [removed, "removed"], [changed, "changed"]].filter(([n]) => n).map(([n, w], i) => (i === 0 ? `${n} item${n === 1 ? "" : "s"} ${w}` : `${n} ${w}`)).join(", ") || "No items changed",
  deleted: "Deleted in the branch",
  added: "Added in the branch",
  tooLargeHere: (s: string) => `Too large to show here (${s}).`,
  tooManyCellsHere: (n: number) => `Too many cells to show here (${n.toLocaleString("en-US")}).`,
  outputsTooMany: "Its outputs are too many or too large to show here.",
  notShown: "This output isn't shown here.",
  accept: "Accept",
  reject: "Reject",
  askChanges: "Ask for changes",
  reason: "Reason (optional)",
  note: "A note for the agent (optional)",
  submit: "Submit review",
  noBranches: "No branches yet.",
  gone: "This branch isn't there any more.",
  nothingYet: "Nothing has been committed for review yet.",
  tooManyFiles: (n: number) => `Too many files in the branch to review here (more than ${n.toLocaleString("en-US")}).`,
  tooManyChanged: (n: number) => `Too many changed files to review here (more than ${n.toLocaleString("en-US")}).`,
} as const;

/** The submitted notebook's bounds, checked before it is parsed. */
export const SUBMITTED_LIMITS = Object.freeze({ bytes: 8 * 2 ** 20, cells: CELL_LIMITS.cells });

/** How many files a review lists, at most: each side's files and their paths (UTF-16 units), from its trees, and the
 * files changed (each a row with its choices).  A branch can grow past what git_branch copied; past these, the review
 * says so and lists none.  (Not frozen: tests lower them.) */
export const REVIEW_LIST = { files: 10_000, pathBytes: 2 ** 20, changed: 2000 };

/** Tests' hook: awaited before each read the review makes (a test holds one there). */
export const REVIEW_PAGE_HOOK: { read?: (what: string) => void | Promise<void> } = {};

/** What a review holds and has done, for tests: now, and the most at once. */
export type Counters = { active: number; pending: number; reads: number; mounted: number; subscribed: number; peakActive: number; peakReads: number; peakMounted: number; generations: number; mounts: number };

export type ReviewView = { close(): void; counters(): Counters; idle(): Promise<void> };

const enc = new TextEncoder();
const fmtBytes = (n: number) => (n < 1000 ? `${n} B` : n < 1e6 ? `${(n / 1e3).toFixed(1)} KB` : `${(n / 1e6).toFixed(1)} MB`);
function fmtTime(at: number) {
  const d = new Date(at), today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return d.toLocaleString(undefined, sameDay ? { hour: "numeric", minute: "2-digit" } : { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & { className?: string } = {}, ...kids: (Node | string | null | undefined | false)[]): HTMLElementTagNameMap[K] {
  const e = Object.assign(document.createElement(tag), props);
  for (const k of kids) if (k) e.append(k);
  return e;
}

let styled = false;
function style() {
  if (styled) return;
  styled = true;
  document.head.append(h("style", { textContent: `
.sbrv{font:14px/1.4 system-ui,sans-serif;color:#222}
.sbrv h3{font-size:16px;margin:.4em 0}
.sbrv .st{color:#555;margin:.2em 0 .6em}
.sbrv .file{border-top:1px solid #ddd;padding:.5em 0}
.sbrv .path{font-family:ui-monospace,monospace;cursor:pointer;background:none;border:0;padding:0;color:#0645ad;text-align:left}
.sbrv .run{color:#555;font-size:13px}
.sbrv .dec label{margin-right:1em}
.sbrv .dec input[type=text]{width:60%}
.sbrv .msg{color:#8a1f11;margin:.3em 0}
.sbrv pre.diff{font:12px/1.35 ui-monospace,monospace;margin:.3em 0;white-space:pre-wrap;word-break:break-all}
.sbrv .l-{background:#fdecec}.sbrv .l\\+{background:#e8f5e9}
.sbrv .fold{color:#777;font-style:italic;font-size:12px;margin:.2em 0}
.sbrv .cell{border-left:3px solid #ccc;padding-left:.5em;margin:.3em 0}
.sbrv .cell.add{border-color:#4caf50}.sbrv .cell.del{border-color:#e57373}.sbrv .cell.chg{border-color:#ffb300}
.sbrv textarea{width:100%;min-height:3em}
.sbrv .branches button{display:block;margin:.3em 0;text-align:left;background:none;border:0;color:#0645ad;cursor:pointer}
` }));
}

/** The review of the branch `at.name` (or, with no name, the branches) in `panel`. `o.notebook`: the notebook
 * component's loader. */
export function openReview(host: ReviewHost, at: { name?: string }, panel: HTMLElement, o: { notebook: () => Promise<NotebookModule> }): ReviewView {
  style();
  const c: Counters = { active: 0, pending: 0, reads: 0, mounted: 0, subscribed: 0, peakActive: 0, peakReads: 0, peakMounted: 0, generations: 0, mounts: 0 };
  const peak = () => { c.peakActive = Math.max(c.peakActive, c.active); c.peakReads = Math.max(c.peakReads, c.reads); c.peakMounted = Math.max(c.peakMounted, c.mounted); };
  const root = h("div", { className: "sbrv" });
  panel.replaceChildren(root);
  let closed = false;
  let inner: ReviewView | null = null;
  const idleWaiters: (() => void)[] = [];

  if (!at.name) {
    // ---- the branches: each opens its review here
    void listBranches(host).then((all) => {
      if (closed) return;
      if (!all.length) { root.replaceChildren(h("p", { textContent: REVIEW_PAGE_TEXT.noBranches })); return; }
      root.replaceChildren(h("div", { className: "branches" }, ...all.map((b) => h("button", {
        textContent: `${b.name}${b.title ? `: ${b.title}` : ""} (${REVIEW_PAGE_TEXT.status[b.status]}, ${fmtTime(b.updated)})`,
        onclick: () => { inner = openReview(host, { name: b.name }, panel, o); },
      }))));
    });
    return { close() { closed = true; inner?.close(); }, counters: () => inner?.counters() ?? c, idle: () => inner?.idle() ?? Promise.resolve() };
  }
  const name = at.name;

  // ---- what is shown: captured at each read, handed to Submit as it is
  let fid: string | null = null, ns = "", store: BranchStore | null = null;
  let shown: { review: BranchReview; runs: Map<string, { at: number; oid: string }>; base: Map<string, string>; head: Map<string, string>; changes: { path: string; kind: "added" | "deleted" | "changed" }[] } | null = null;
  let selected: string | null = null, wantSubmitted = false;
  let decisions = new Map<string, { decision: FileDecision["decision"]; reason: string }>();
  let note = "", banner = "", overwrite = new Set<string>(), rowMsg = new Map<string, string>(), offered = new Set<string>();
  let busy = false, submitting: Promise<void> | null = null;
  // (the file opened: its diff's element and the commit it is of; the submitted notebook mounted, with its key)
  let detail: { key: string; el: HTMLElement } | null = null;
  let nb: { key: string; comp: ReturnType<NotebookModule["createNotebook"]>; el: HTMLElement } | null = null;

  // ---- the refresh slot
  let gen = 0, active = false, dirty = false;
  let off: (() => void) | null = null;
  const invalidate = () => {
    if (closed) return;
    gen++;
    if (active) { dirty = true; c.pending = 1; return; }
    kick();
  };
  const kick = () => {
    dirty = false; c.pending = 0;
    active = true; c.active++; c.generations++; peak();
    const g = gen;
    refresh(g).catch((e) => { if (g === gen && !closed) { banner = String(e?.message ?? e); paint(); } }).finally(() => {
      active = false; c.active--;
      if (dirty && !closed) kick();
      else for (const w of idleWaiters.splice(0)) w();
    });
  };
  /** One read, counted, with the tests' hold before it. */
  const read = async <T,>(what: string, p: () => Promise<T>): Promise<T> => {
    c.reads++; peak();
    try { await REVIEW_PAGE_HOOK.read?.(what); return await p(); } finally { c.reads--; }
  };

  const unmount = () => {
    if (!nb) return;
    try { nb.comp.destroy(); } catch {}
    nb.el.remove();
    nb = null; c.mounted--;
  };

  async function refresh(g: number) {
    const stale = () => closed || g !== gen;
    if (!store) {
      store = await openBranchStore(host.dbName);
      ns = await branchStoreName(host.dbName);
      if (stale()) return;
    }
    if (!fid) {
      const b = await read("branch", () => host.branchAtName(name));
      if (stale()) return;
      if (!b) { root.replaceChildren(h("p", { textContent: REVIEW_PAGE_TEXT.gone })); return; }
      fid = b.fid;
      off = onBranch(ns, fid, invalidate); c.subscribed++;
      // (an accept a closed page left: finished now, only as its intent records it; a refusal said)
      try { await resumeAccepting(host, { fid, name }); } catch (e) { banner = String((e as Error)?.message ?? e); }
      if (stale()) return;
    }
    const got = await read("review", () => host.branchReview(fid!, name));
    if (stale()) return;
    if (!got) { unmount(); shown = null; root.replaceChildren(h("p", { textContent: REVIEW_PAGE_TEXT.gone })); return; }
    const runsGot = await read("runs", () => host.branchRuns(fid!, name));
    if (stale()) return;
    const r = got.review;
    if (!r) { shown = null; root.replaceChildren(h("h3", { textContent: name }), h("p", { className: "st", textContent: `${REVIEW_PAGE_TEXT.status.open}. ${REVIEW_PAGE_TEXT.nothingYet}` })); return; }
    const runs = new Map(runsGot?.runs ?? []);
    // (the review state moved: what the person chose for the old one isn't carried over)
    if (shown && shown.review.seq !== r.seq) { decisions = new Map(); overwrite = new Set(); rowMsg = new Map(); offered = new Set(); }
    if (!shown || shown.review.head !== r.head || shown.review.base !== r.base) {
      // (a new commit: its files by blob id, from the trees alone)
      const max = { files: REVIEW_LIST.files, pathBytes: REVIEW_LIST.pathBytes };
      const base = await read("oids", () => store!.oidsAt(r.base, max));
      if (stale()) return;
      const head = base && (await read("oids", () => store!.oidsAt(r.head, max)));
      if (stale()) return;
      const tooMany = (t: string) => { detail = null; unmount(); shown = null; root.replaceChildren(h("h3", { textContent: name }), h("p", { className: "st", textContent: REVIEW_PAGE_TEXT.status[r.status] }), h("p", { textContent: t })); };
      if (!base || !head) return tooMany(REVIEW_PAGE_TEXT.tooManyFiles(REVIEW_LIST.files));
      const changes: { path: string; kind: "added" | "deleted" | "changed" }[] = [];
      for (const [p, id] of head) { const was = base.get(p); if (was === undefined) changes.push({ path: p, kind: "added" }); else if (was !== id) changes.push({ path: p, kind: "changed" }); }
      for (const p of base.keys()) if (!head.has(p)) changes.push({ path: p, kind: "deleted" });
      if (changes.length > REVIEW_LIST.changed) return tooMany(REVIEW_PAGE_TEXT.tooManyChanged(REVIEW_LIST.changed));
      changes.sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
      shown = { review: r, runs, base, head, changes };
      if (selected && !changes.some((x) => x.path === selected)) selected = null;
      // (what was shown for the old commit goes before anything of the new one is painted)
      detail = null; unmount();
    } else shown = { ...shown, review: r, runs };
    paint();
    // (the file opened: read and diffed only if it's not already shown for this commit)
    const key = selected ? `${r.head}\n${selected}` : "";
    if (!selected) { detail = null; unmount(); return; }
    if (!detail || detail.key !== key) {
      unmount();
      const el = await fileDetail(selected, r, stale);
      if (!el || stale()) return;
      detail = { key, el };
      paint();
    }
    if (wantSubmitted && (!nb || nb.key !== key)) { unmount(); await mountSubmitted(selected, r, key, stale); }
    else if (!wantSubmitted) unmount();
  }

  // ---- one file's diff
  async function fileDetail(p: string, r: BranchReview, stale: () => boolean): Promise<HTMLElement | null> {
    const ch = shown!.changes.find((x) => x.path === p)!;
    const box = h("div", { className: "detail" });
    if (ch.kind === "deleted") { box.append(h("p", { textContent: REVIEW_PAGE_TEXT.deleted })); return box; }
    const kind = (await read("kind", () => store!.fullKind(r.head, p)))?.kind ?? "file";
    if (stale()) return null;
    const a = ch.kind === "added" ? new Uint8Array() : await read("blob", () => store!.blobAt(r.base, p).then((b) => b ?? new Uint8Array()));
    if (stale()) return null;
    const b = (await read("blob", () => store!.blobAt(r.head, p))) ?? new Uint8Array();
    if (stale()) return null;
    if (ch.kind === "added") box.append(h("p", { className: "fold", textContent: REVIEW_PAGE_TEXT.added }));
    const sizes = () => [fmtBytes(a.length), fmtBytes(b.length)] as const;
    if (kind === "notebook" || kind === "board") {
      // (each side's canonical JSON: bounded by its bytes and its values before it is parsed)
      if (a.length > REVIEW_DIFF.sideBytes || b.length > REVIEW_DIFF.sideBytes || jsonValues(a) > JSON_LIMITS.side || jsonValues(b) > JSON_LIMITS.side) { box.append(h("p", { textContent: REVIEW_PAGE_TEXT.tooLargeText(...sizes()) })); return box; }
      const dec = new TextDecoder();
      const pa = a.length ? JSON.parse(dec.decode(a)) : null, pb = JSON.parse(dec.decode(b));
      if (kind === "board") {
        const n = boardCounts(pa, pb);
        box.append(h("p", { textContent: n ? REVIEW_PAGE_TEXT.boardCounts(n.added, n.removed, n.changed) : REVIEW_PAGE_TEXT.noPreview(...sizes()) }));
        return box;
      }
      const cellsOf = (d: any): CellKey[] => (Array.isArray(d?.cells) ? d.cells : []).map((x: any) => ({ type: String(x?.type ?? "code"), code: String(x?.code ?? "") }));
      await notebookDiff(box, cellsOf(pa), cellsOf(pb), stale);
      if (stale()) return null;
      const sub = h("details", {}, h("summary", { textContent: REVIEW_PAGE_TEXT.submitted }));
      sub.open = wantSubmitted;
      sub.addEventListener("toggle", () => { if (sub.open === wantSubmitted) return; wantSubmitted = sub.open; if (!wantSubmitted) unmount(); invalidate(); });
      box.append(sub);
      return box;
    }
    // (a data file: text if both sides decode as UTF-8; bounded by its bytes before either is decoded)
    if (a.length > REVIEW_DIFF.sideBytes || b.length > REVIEW_DIFF.sideBytes) { box.append(h("p", { textContent: REVIEW_PAGE_TEXT.tooLargeText(...sizes()) })); return box; }
    let ta: string, tb: string;
    try { const d = new TextDecoder("utf-8", { fatal: true }); ta = d.decode(a); tb = d.decode(b); }
    catch {
      const why = h("p", { textContent: REVIEW_PAGE_TEXT.noPreview(...sizes()) });
      why.title = `${shown!.base.get(p) ?? "none"} → ${shown!.head.get(p)}`;
      box.append(why);
      return box;
    }
    const d = reviewLineDiff(ta, tb);
    const pre = d.ok ? textDiff(d.a, d.b, d.segs) : null;
    box.append(pre ?? h("p", { textContent: REVIEW_PAGE_TEXT.tooLargeText(...sizes()) }));
    return box;
  }

  /** A text diff, three lines of context, longer unchanged runs folded; null past REVIEW_DIFF.renderLines. */
  function textDiff(a: string[], b: string[], segs: Seg[], budget = { lines: REVIEW_DIFF.renderLines }): HTMLElement | null {
    const out = h("pre", { className: "diff" });
    const line = (cls: string, t: string) => { if (--budget.lines < 0) return false; out.append(h("div", { className: cls, textContent: (cls === "l-" ? "- " : cls === "l+" ? "+ " : "  ") + t.replace(/\n$/, "") })); return true; };
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i];
      if (s.t === "-") { for (let k = 0; k < s.n; k++) if (!line("l-", a[s.a + k])) return null; continue; }
      if (s.t === "+") { for (let k = 0; k < s.n; k++) if (!line("l+", b[s.b + k])) return null; continue; }
      const head = i === 0 ? 0 : 3, tail = i === segs.length - 1 ? 0 : 3;
      if (s.n <= head + tail + 1) { for (let k = 0; k < s.n; k++) if (!line("l", a[s.a + k])) return null; continue; }
      for (let k = 0; k < head; k++) if (!line("l", a[s.a + k])) return null;
      out.append(h("div", { className: "fold", textContent: REVIEW_PAGE_TEXT.unchangedLines(s.n - head - tail) }));
      for (let k = s.n - tail; k < s.n; k++) if (!line("l", a[s.a + k])) return null;
    }
    return out;
  }

  /** A notebook's cells, base to head: unchanged runs folded, each changed cell its code's diff, each added or deleted
   * cell its code; one comparison budget and one render budget for the file, the rest counted past them. */
  async function notebookDiff(box: HTMLElement, A: CellKey[], B: CellKey[], stale: () => boolean) {
    const rows = cellDiff(A, B);
    if (!rows) { box.append(h("p", { textContent: REVIEW_PAGE_TEXT.tooManyCells })); return; }
    let budget = REVIEW_DIFF.budget, notShown = 0, k = 0;
    const lines = { lines: REVIEW_DIFF.renderLines };
    for (const r of foldRows(rows)) {
      // (every 50 rows a task's turn, so a close or a change can come in and stop it)
      if (++k % 50 === 0) { await new Promise((r) => setTimeout(r, 0)); if (stale()) return; }
      if ("fold" in r) { box.append(h("div", { className: "fold", textContent: REVIEW_PAGE_TEXT.unchangedCells(r.fold) })); continue; }
      if (notShown) { notShown++; continue; }
      const [a, b] = r.t === "+" ? ["", B[r.b].code] : r.t === "-" ? [A[r.a].code, ""] : [A[r.a].code, B[r.b].code];
      const d = reviewLineDiff(a, b, { budget });
      if (!d.ok) { notShown++; continue; }
      budget -= d.used;
      const pre = textDiff(d.a, d.b, d.segs, lines);
      if (!pre) { notShown++; continue; }
      box.append(h("div", { className: "cell " + (r.t === "+" ? "add" : r.t === "-" ? "del" : "chg") }, pre));
    }
    if (notShown) box.append(h("p", { className: "fold", textContent: REVIEW_PAGE_TEXT.moreCells(notShown) }));
  }

  // ---- the notebook as submitted
  async function mountSubmitted(p: string, r: BranchReview, key: string, stale: () => boolean) {
    const slot = detail?.el.querySelector("details");
    if (!slot) return;
    const say = (t: string) => { slot.querySelector(".why")?.remove(); slot.append(h("p", { className: "why", textContent: t })); };
    let full = await read("full", () => store!.fullAt(r.head, p));
    if (stale() || !full) return;
    if (full.bytes.length > SUBMITTED_LIMITS.bytes || jsonValues(full.bytes) > JSON_LIMITS.full) return say(REVIEW_PAGE_TEXT.tooLargeHere(fmtBytes(full.bytes.length)));
    let text: string | null = new TextDecoder().decode(full.bytes);
    full = null;
    const doc = JSON.parse(text);
    text = null;
    const n = Array.isArray(doc?.cells) ? doc.cells.length : 0;
    if (n > SUBMITTED_LIMITS.cells) return say(REVIEW_PAGE_TEXT.tooManyCellsHere(n));
    // (what may be shown, decided on this one document, in place, before the component sees it)
    const shownOut = filterOutputs(doc, REVIEW_PAGE_TEXT.notShown);
    if ("refused" in shownOut) return say(REVIEW_PAGE_TEXT.outputsTooMany);
    const mod = await read("notebook", () => o.notebook());
    if (stale()) return;
    const el = h("div");
    slot.append(el);
    const comp = mod.createNotebook(el, { kernel: null, readOnly: true, reactive: false, remotePictures: "click" });
    nb = { key, comp, el }; c.mounted++; c.mounts++; peak();
    comp.load(doc);
    comp.setReadOnly(true);
    for (const btn of el.querySelectorAll<HTMLButtonElement>("button")) btn.disabled = true;
  }

  // ---- the page
  function paint() {
    if (closed || !shown) return;
    const r = shown.review;
    const deciding = r.status === "review" && !r.pending && !r.accepting;
    const rows = shown.changes.map((ch) => {
      const fact = runFact(shown!.runs.get("/" + ch.path), shown!.head.get(ch.path));
      const factText = fact.state === "none" ? REVIEW_PAGE_TEXT.noRun : fact.state === "ran" ? REVIEW_PAGE_TEXT.ran(fmtTime(fact.at)) : REVIEW_PAGE_TEXT.changedSince(fmtTime(fact.at));
      const p = "/" + ch.path;
      const pathBtn = h("button", { className: "path", textContent: p + (ch.kind === "deleted" ? `: ${REVIEW_PAGE_TEXT.deleted}` : ""), onclick: () => { selected = selected === ch.path ? null : ch.path; wantSubmitted = false; detail = null; unmount(); paint(); invalidate(); } });
      const kids: (Node | null)[] = [pathBtn, h("div", { className: "run", textContent: factText })];
      const was = r.files?.[p];
      if (deciding) {
        const cur = decisions.get(p);
        const pick = (d: FileDecision["decision"], label: string) => {
          const inp = h("input", { type: "radio", name: "d" + p, checked: cur?.decision === d, onchange: () => { decisions.set(p, { decision: d, reason: decisions.get(p)?.reason ?? "" }); } });
          return h("label", {}, inp, " " + label);
        };
        const reason = h("input", { type: "text", placeholder: REVIEW_PAGE_TEXT.reason, value: cur?.reason ?? "", oninput: () => { const x = decisions.get(p); if (x) x.reason = reason.value; } });
        kids.push(h("div", { className: "dec" }, pick("accepted", REVIEW_PAGE_TEXT.accept), pick("rejected", REVIEW_PAGE_TEXT.reject), pick("changes", REVIEW_PAGE_TEXT.askChanges), reason));
      } else if (was) kids.push(h("div", { className: "run", textContent: `${was.decision === "accepted" ? REVIEW_PAGE_TEXT.accept : was.decision === "rejected" ? REVIEW_PAGE_TEXT.reject : REVIEW_PAGE_TEXT.askChanges}${was.reason ? `: ${was.reason}` : ""}` }));
      const m = rowMsg.get(p);
      if (m) {
        kids.push(h("div", { className: "msg", textContent: m }));
        if (offered.has(p)) kids.push(h("button", { textContent: REVIEW_PAGE_TEXT.replace, onclick: () => { overwrite.add(p); startSubmit(); } }));
      }
      // (a diff only under exactly the commit and file it was made for: never another's while its own is read)
      if (selected === ch.path && detail && detail.key === `${r.head}\n${ch.path}`) kids.push(detail.el);
      return h("div", { className: "file" }, ...kids);
    });
    const parts: (Node | null)[] = [
      h("h3", { textContent: r.title ? `${name}: ${r.title}` : name }),
      h("p", { className: "st", textContent: REVIEW_PAGE_TEXT.status[r.status] + (r.note && !deciding ? `. ${r.note}` : "") }),
      banner ? h("div", { className: "msg", textContent: banner }) : null,
      ...rows,
    ];
    if (deciding) {
      const ta = h("textarea", { placeholder: REVIEW_PAGE_TEXT.note, value: note, oninput: () => { note = ta.value; } });
      parts.push(ta, h("button", { textContent: REVIEW_PAGE_TEXT.submit, disabled: busy, onclick: startSubmit }));
    }
    root.replaceChildren(...parts.filter((x): x is Node => !!x));
  }

  function startSubmit() { if (!submitting) submitting = submit().finally(() => { submitting = null; }); }
  async function submit() {
    if (busy || !shown || !fid) return;
    const r = shown.review;
    busy = true; banner = ""; rowMsg = new Map(); paint();
    const files: Record<string, { decision: FileDecision["decision"]; reason?: string }> = {};
    for (const [p, d] of decisions) files[p] = { decision: d.decision, ...(d.reason.trim() ? { reason: d.reason.trim() } : {}) };
    try {
      await review(host, { fid, name, head: r.head, seq: r.reviewSeq ?? -1 }, { files, ...(note.trim() ? { note: note.trim() } : {}), overwrite: [...overwrite] });
      decisions = new Map(); overwrite = new Set(); offered = new Set(); note = "";
    } catch (e) {
      const m = String((e as Error)?.message ?? e);
      const p = Object.keys(files).find((x) => m === REVIEW_TEXT.mainChanged(x));
      if (p) { rowMsg.set(p, m); offered.add(p); }
      else banner = m;
    } finally {
      busy = false;
      paint();
      invalidate();
    }
  }

  invalidate();
  return {
    close() {
      if (closed) return;
      closed = true; gen++;
      off?.(); off = null; if (c.subscribed) c.subscribed--;
      unmount();
      detail = null; shown = null;
      panel.replaceChildren();
      for (const w of idleWaiters.splice(0)) w();
    },
    counters: () => ({ ...c }),
    // (no refresh under way and no Submit: tests wait on this, never on time)
    async idle() {
      for (;;) {
        if (closed) return;
        if (submitting) { await submitting; continue; }
        if (active) { await new Promise<void>((r) => idleWaiters.push(r)); continue; }
        return;
      }
    },
  };
}
