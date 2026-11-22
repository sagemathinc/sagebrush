// A Delegate task's proposal, for the person to read (Pair and Delegate plan r1, UI-2): the files the agent changed
// against the task's snapshot, each with its diff, and a notebook as proposed. In the review chunk
// (sagebrush-review.js) with the review page, whose diff renderers it shares (diff-render.ts). Nothing here runs
// code, and nothing here decides: the decisions (Merge, Close, Ask for changes) are the host page's, in `o.actions`.
//
// From a ProposalSource (the page's view of the host: tasks.diff and tasks.file), never from the workspace:
//   - the list, from source.diff(): the base and proposal commits, the round, and each file with its change;
//   - a file's diff when its row is opened (a proposal of one file: opened at once): both sides read (source.file),
//     then admitted to the preview only if each is at most PROPOSAL_LIMITS.bytes of UTF-8; a notebook (.ipynb text,
//     read by the notebook module's fromFile) cell by cell, any other text line by line, anything else "No preview";
//     and a notebook's proposed document, read only and not reactive, with outputs.ts's filter, under a details;
//   - a .tex file's line diff, and under it the document rendered (the LaTeX page module's mountEditor, read only,
//     its preview alone: the engine worker's render, no code run), as proposed or as it was (Before), one at a time;
//     only this file: what it includes (\input, \includegraphics) isn't read from the proposal;
//   - one file open at a time; a newer open, a refresh or a close drops what an older one read (its generation).
import { h, notebookDiff, style, textDiff } from "./diff-render";
import { reviewLineDiff, utf8Length } from "./line-diff";
import { CELL_LIMITS, type CellKey } from "./cells";
import { filterOutputs } from "./outputs";

export type ProposalFile = { path: string; kind: string; change: "added" | "modified" | "deleted" };
export type ProposalDiff = { base: string; proposal: string; round: number; seq: number; files: ProposalFile[] };
export type ProposalSource = {
  diff(): Promise<ProposalDiff>;
  /** A file as stored at a commit: a notebook's .ipynb text, a text file's text; null if it isn't there. */
  file(path: string, commit: string): Promise<string | null>;
};
/** The notebook component's module, as the pages load it: its component, and its reading of an .ipynb text. */
export type ProposalNotebookModule = {
  createNotebook(root: HTMLElement, opts: Record<string, unknown>): { load(doc: unknown): void; setReadOnly(ro: boolean): void; destroy(): void };
  fromFile(name: string, text: string): { cells: { id?: string; type?: string; code?: string }[] };
};
/** The LaTeX page module (sagebrush-latex.js), as the pages load it: its read-only preview of one document's text. */
export type ProposalLatexModule = {
  mountEditor(root: HTMLElement, opts: { text: string; readOnly: boolean; layout: "preview" }): { destroy(): void };
};
export type ProposalView = { close(): void; refresh(): void; idle(): Promise<void> };

export const PROPOSAL_LIMITS = Object.freeze({ bytes: 4 * 2 ** 20, files: 2000 });

export const PROPOSAL_TEXT = {
  title: (round: number) => (round > 1 ? `Proposal, round ${round}` : "Proposal"),
  commits: (base: string, proposal: string, n: number) => `${n === 1 ? "1 file" : `${n.toLocaleString("en-US")} files`} changed · from ${base.slice(0, 7)} to ${proposal.slice(0, 7)}`,
  change: { added: "added", modified: "changed", deleted: "deleted" } as Record<ProposalFile["change"], string>,
  proposed: "The notebook as proposed",
  noPreview: "No preview for this kind of file.",
  tooLarge: "Too large to show here.",
  tooLargeText: "Too large to compare line by line.",
  tooManyCells: `Too many cells to show here (more than ${CELL_LIMITS.cells.toLocaleString("en-US")}).`,
  outputsTooMany: "Its outputs are too many or too large to show here.",
  notShown: "This output isn't shown here.",
  unreadable: "Couldn't read this file.",
  tooManyFiles: `Too many changed files to show here (more than ${PROPOSAL_LIMITS.files.toLocaleString("en-US")}).`,
  failed: "Couldn't load the proposal.",
  rendered: "The document",
  asProposed: "As proposed",
  before: "Before",
  noRender: "Can't show the rendered document here.",
  onlyThisFile: "Only this file is rendered: the files it includes aren't shown here.",
  nothing: "No files changed.",
} as const;

const isNotebook = (f: ProposalFile) => f.kind === "notebook" || /\.ipynb$/i.test(f.path);
const isTex = (f: ProposalFile) => f.kind === "tex" || /\.tex$/i.test(f.path);
// (a document that reads other files: \input, \include, \includegraphics, \bibliography and the like, not a comment)
const includes = (t: string) => /(^|[^\\%])\\(input|include|includegraphics|bibliography|addbibresource|lstinputlisting|verbatiminput)\b/m.test(t.replace(/(^|[^\\])%.*$/gm, "$1"));
const keysOf = (d: { cells: { type?: string; code?: string }[] } | null): CellKey[] => (d?.cells ?? []).map((c) => ({ type: c.type ?? "code", code: String(c.code ?? "") }));

/** The proposal from `source` in `panel`, with `o.actions` (the host page's buttons) at its foot. */
export function openProposal(source: ProposalSource, panel: HTMLElement, o: { notebook: () => Promise<ProposalNotebookModule>; latex?: (() => Promise<ProposalLatexModule>) | null; actions?: HTMLElement }): ProposalView {
  style();
  let gen = 0, closed = false, mounted: { destroy(): void } | null = null, busy: Promise<void> = Promise.resolve();
  const root = h("div", { className: "sbrv sbpv" });
  panel.replaceChildren(root);
  const unmount = () => { try { mounted?.destroy(); } catch {} mounted = null; };

  function draw() {
    const my = ++gen;
    unmount();
    root.replaceChildren(h("p", { className: "st", textContent: "…" }));
    busy = (async () => {
      let d: ProposalDiff;
      try { d = await source.diff(); } catch { if (my === gen && !closed) root.replaceChildren(h("p", { className: "msg", textContent: PROPOSAL_TEXT.failed })); return; }
      if (my !== gen || closed) return;
      const list = h("div");
      root.replaceChildren(
        h("h3", { textContent: PROPOSAL_TEXT.title(d.round) }),
        h("p", { className: "st", textContent: PROPOSAL_TEXT.commits(d.base, d.proposal, d.files.length) }),
        list,
      );
      if (o.actions) root.append(o.actions);
      if (!d.files.length) { list.append(h("p", { className: "st", textContent: PROPOSAL_TEXT.nothing })); return; }
      if (d.files.length > PROPOSAL_LIMITS.files) { list.append(h("p", { className: "msg", textContent: PROPOSAL_TEXT.tooManyFiles })); return; }
      for (const f of d.files) {
        const row = h("div", { className: "file" });
        const open = h("button", { className: "path", type: "button", textContent: f.path });
        const body = h("div");
        open.onclick = () => void openFile(f, d, body, my);
        row.append(open, h("span", { className: "run", textContent: " " + PROPOSAL_TEXT.change[f.change] }), body);
        list.append(row);
      }
      // (one file changed: opened at once)
      if (d.files.length === 1) await openFile(d.files[0], d, list.querySelector(".file > div:last-child") as HTMLElement, my);
    })();
  }

  async function openFile(f: ProposalFile, d: ProposalDiff, body: HTMLElement, my: number) {
    const fileGen = ++gen;
    const stale = () => closed || gen !== fileGen;
    unmount();
    for (const b of root.querySelectorAll(".file > div")) b.replaceChildren();
    const say = (t: string, cls = "st") => body.append(h("p", { className: cls, textContent: t }));
    let a: string | null = null, b: string | null = null;
    try {
      [a, b] = await Promise.all([f.change === "added" ? null : source.file(f.path, d.base), f.change === "deleted" ? null : source.file(f.path, d.proposal)]);
    } catch { if (!stale()) say(PROPOSAL_TEXT.unreadable, "msg"); return; }
    if (stale()) return;
    // (admitted to the preview by each side's UTF-8 bytes, after the read: the read itself is the host's bound)
    if (utf8Length(a ?? "") > PROPOSAL_LIMITS.bytes || utf8Length(b ?? "") > PROPOSAL_LIMITS.bytes) return say(PROPOSAL_TEXT.tooLarge);
    if (isNotebook(f)) {
      let mod: ProposalNotebookModule;
      try { mod = await o.notebook(); } catch { if (!stale()) say(PROPOSAL_TEXT.unreadable, "msg"); return; }
      if (stale()) return;
      let A: ReturnType<ProposalNotebookModule["fromFile"]> | null = null, B: ReturnType<ProposalNotebookModule["fromFile"]> | null = null;
      try { A = a === null ? null : mod.fromFile(f.path, a); B = b === null ? null : mod.fromFile(f.path, b); } catch { return say(PROPOSAL_TEXT.unreadable, "msg"); }
      if ((A?.cells.length ?? 0) > CELL_LIMITS.cells || (B?.cells.length ?? 0) > CELL_LIMITS.cells) return say(PROPOSAL_TEXT.tooManyCells);
      await notebookDiff(body, keysOf(A), keysOf(B), stale);
      if (stale() || !B) return;
      // (the notebook as proposed: what may be shown decided on this one document, before the component sees it)
      const slot = h("details", {}, h("summary", { textContent: PROPOSAL_TEXT.proposed }));
      body.append(slot);
      const shown = filterOutputs(B, PROPOSAL_TEXT.notShown);
      if ("refused" in shown) { slot.append(h("p", { className: "st", textContent: PROPOSAL_TEXT.outputsTooMany })); return; }
      const el = h("div");
      slot.append(el);
      const comp = mod.createNotebook(el, { kernel: null, readOnly: true, reactive: false, remotePictures: "click" });
      mounted = comp;
      comp.load(B);
      comp.setReadOnly(true);
      for (const btn of el.querySelectorAll<HTMLButtonElement>("button")) btn.disabled = true;
      return;
    }
    // (a line diff only for text: a text or code file, or a data file whose name says it is text)
    const texty = f.kind === "text" || f.kind === "code" || /\.(txt|md|py|sage|m|mag|js|json|tex|csv|tsv|bib|sty|cls)$/i.test(f.path);
    if (!texty) return say(PROPOSAL_TEXT.noPreview);
    const dd = reviewLineDiff(a ?? "", b ?? "");
    const pre = dd.ok ? textDiff(dd.a, dd.b, dd.segs) : null;
    body.append(pre ?? h("p", { className: "st", textContent: PROPOSAL_TEXT.tooLargeText }));
    if (isTex(f) && o.latex) await rendered(body, a, b, stale);
    void my;
  }

  // (the .tex rendered under its diff: as proposed, or Before (the base's), one mounted at a time; a newer open, a
  //  refresh or a close drops it (unmount), and a module that can't load leaves the diff as it is)
  async function rendered(body: HTMLElement, a: string | null, b: string | null, stale: () => boolean) {
    let mod: ProposalLatexModule;
    try { mod = await o.latex!(); } catch { if (!stale()) body.append(h("p", { className: "msg", textContent: PROPOSAL_TEXT.noRender })); return; }
    if (stale() || typeof mod?.mountEditor !== "function") { if (!stale()) body.append(h("p", { className: "msg", textContent: PROPOSAL_TEXT.noRender })); return; }
    const sides = ([[PROPOSAL_TEXT.asProposed, b], [PROPOSAL_TEXT.before, a]] as const).filter(([, t]) => t !== null) as [string, string][];
    const box = h("div", { className: "tex-rendered" });
    const tabs = h("p", { className: "st" }, h("strong", { textContent: PROPOSAL_TEXT.rendered + " " }));
    const host = h("div");
    const note = h("p", { className: "st" });
    const buttons: HTMLButtonElement[] = [];
    const show = (i: number) => {
      unmount();
      buttons.forEach((x, j) => { x.setAttribute("aria-pressed", String(j === i)); x.style.fontWeight = j === i ? "600" : ""; });
      note.textContent = includes(sides[i][1]) ? PROPOSAL_TEXT.onlyThisFile : "";
      const el = h("div");
      host.replaceChildren(el);
      try { mounted = mod.mountEditor(el, { text: sides[i][1], readOnly: true, layout: "preview" }); } catch { host.replaceChildren(h("p", { className: "msg", textContent: PROPOSAL_TEXT.noRender })); }
    };
    sides.forEach(([label], i) => {
      const x = h("button", { type: "button", textContent: label });
      x.onclick = () => show(i);
      buttons.push(x);
      tabs.append(x, " ");
    });
    box.append(tabs, note, host);
    body.append(box);
    show(0);
  }

  draw();
  return {
    close() { closed = true; gen++; unmount(); panel.replaceChildren(); },
    refresh() { if (!closed) draw(); },
    idle: () => busy,
  };
}
