// A board, mounted in an element of a page by its host (design/board.md,
// "One package, two hosts"): the board (board.ts), editing (edit.ts,
// inplace.ts), the top bar and its ⋯ menu, the Edit toolbar, the tour's
// caption, TimeTravel's bar, the dialogs (Examples, Import Mermaid, Print).
// Everything that depends on where the board lives is the host's:
// - store: where the document comes from, and where its edits go;
// - images: where pictures' bytes are kept;
// - code: the engine of code items (and so the kernel: in this browser, in
//   the runner, or elsewhere);
// - math: KaTeX;
// - history: TimeTravel's versions;
// - address, title, home, examples, exportHtml: the page's.
// What a host does not provide is not offered (no code engine: code shows
// as text; no history: no TimeTravel; no examples: no Examples…).
// sagebrush.space's board page is one host (page.ts); CoCalc is to be another.
//
// Edit (edit.ts) changes the document; the host keeps it (store.save).  The
// menu downloads it as JSON, opens a JSON file (or drop one on the page), or
// starts a new board.  A Mermaid flowchart opens as a board too (mermaid.ts):
// the Open menu and a dropped file, or Import Mermaid… (pasted); so does a
// CoCalc whiteboard (cocalc.ts).
//
// Code items (notes with code) are run on one interpreter for the board as a
// notebook's cells are, in reading order (code.ts); their output shows under
// their code, or alone (hideCode; { } on the item shows the code: in Edit,
// for the board, otherwise only for this reader).
//
// TimeTravel (history.ts): every change kept is a version; the ⋯ menu's
// TimeTravel shows a bar with a slider over them, to look at any version
// (read only: its code is shown, not run) and Revert to it (an edit,
// undoable).
//
// mountBoard returns the board, `agent` (the API an agent driving the page
// uses, window.sagebrush.board on sagebrush.space: load(doc), focus(ids),
// step(n), snapshot(), edit(f), run(), outputs(), versions(), version(i),
// ...), and destroy().
import { Board, type Camera, type Edge, type Item } from "./board";
import { layout, isBoard, formatError, pageCount, pageOf, pageView, codeOrder, type CodeCell, cleanDoc, anyCode, canonical, templateOf, lookOf, shownPages, type BoardDoc, type BoardPage, type MeasuredNote, type DocNode, type DocNote } from "./doc";
import type { BoardCode } from "./code";
import { overCap, sameOutputs } from "./preview";
import { sizeOf, type CachedOutputs, type OutputCache } from "./outcache";
import { PixelBudget } from "../image-size";
import { loadRemotePicture } from "../safe-html";
import { Toolbar, defaultTools } from "./toolbar";
import { PenRow } from "./pen";
import { effect } from "@preact/signals-core";
import { Editor, tidy } from "./edit";
import { printSheets, type Sheet, type PrintOptions } from "./print";
import { boardFromText, toMermaid, toMermaidMarkdown } from "./mermaid";
import { canvasLeftOut, toCanvas } from "./canvas";
import { render as markdown } from "../markdown";
import { IMAGE_TYPES, prepare, type ImageStore } from "./images";
import { COLORS } from "./colors";
import type { Version } from "./history";
import { track, active } from "./focus";
import css from "./board.css" with { type: "text" };

/** Where a board's document comes from, and where its edits go. */
export interface BoardStore {
  /** The document to show (and the original, before this browser's or this
   * person's edits, for Revert; and a notice to show, e.g. what a conversion
   * left out); null: nothing (the benchmark's boards are set by hand). */
  load(): Promise<{ doc: BoardDoc; original?: BoardDoc | null; notice?: string } | null>;
  /** Keep the document as it is now (after every change kept). */
  save(doc: BoardDoc): void;
  /** Forget the edits: the original is the document again (Revert). */
  revert?(): void;
  /** This document's name in this browser, kept beside it, not in it: its
   * output cache's (outcache.ts) and its history's; `fresh`: another
   * document is shown here, so a new name (SEC-B88-1; each its own
   * TimeTravel).  None: no cache, one history. */
  documentId?(fresh: boolean): string;
  /** Whether the document was written in this browser (a new board), kept
   * beside it; `set`: so it is now.  Its notes' remote pictures show at
   * once; else each when clicked (William, SEC-89C-3). */
  writtenHere?(set?: boolean): boolean;
  /** The document as it is elsewhere, when it changes there (another person;
   * or newer than the copy load() gave at once: cached.ts), with a notice
   * for the caption (a merge's); shown in place, `f` resolving once it is
   * (edits made before were made from the one before).  Returns: stop. */
  subscribe?(f: (doc: BoardDoc, notice?: string) => void | Promise<void>): () => void;
}
/** TimeTravel's versions (history.ts's BoardHistory). */
export interface BoardTimeTravel {
  record(d: BoardDoc): unknown;
  versions(): Version[];
  docAt(time: string): BoardDoc;
  on(f: () => void): () => void;
  close?(): void;
}
export interface BoardHost {
  store?: BoardStore;
  /** where pictures' bytes are kept (images.ts: Images, this browser's IndexedDB) */
  images: ImageStore;
  /** a CoCalc icon by its name (a converted board's stickers), as the host draws it; none: an emoji close to it (stickers.ts) */
  icon?(name: string): Element | null;
  /** the engine of code items, made the first time a board has code (the document then) */
  code?: (d: BoardDoc) => BoardCode;
  /** KaTeX, loaded the first time a board has math */
  math?: () => Promise<{ typeset(el: Element): void }>;
  /** TimeTravel's history, asked for the first time it is needed */
  history?: (id: string | null) => Promise<BoardTimeTravel | null>;
  /** Forget the versions of the document named `id` (another document is shown in its place), opened or not. */
  dropHistory?: (id: string | null) => Promise<void>;
  /** where the page and step shown are kept (#p2-3: the address's hash) */
  address?: { get(): string; set(hash: string): void };
  /** the board's title changed (the page's title follows it) */
  title?(title: string): void;
  /** where "Sagebrush" in the top bar goes */
  home?: string;
  /** the example boards (Examples…) */
  examples?: { list(): Promise<{ title: string; about: string; href: string; current?: boolean }[]> };
  /** where slow code items' outputs are kept between visits (outcache.ts; design/outputs.md) */
  outputs?: OutputCache;
  /** the board as one HTML file (Download as HTML); with `python`, the file
   * carries the code's engine, so its code runs without the network; with
   * `outputs`, the slow items' outputs computed here (BoardCode.carry()) */
  exportHtml?(d: BoardDoc, o?: { python?: boolean; outputs?: CachedOutputs[] }): Promise<string>;
  /** whether exportHtml can carry the engine, and about how much more that is ("6 MB") */
  exportPython?(d: BoardDoc): string | null;
}

// (its stylesheet, once a page, first: the page's own rules win; it goes
// with the last board unmounted)
let mounted = 0;
function addStyle() {
  mounted++;
  if (document.querySelector("style[data-sbb-css]")) return;
  const s = document.createElement("style");
  s.dataset.sbbCss = "";
  s.textContent = css;
  document.head.prepend(s);
}

// The parts around the board: the top bar and its ⋯ menu, the tour's
// caption, TimeTravel's bar, the dialogs.  (Fixed markup, no content.)
const CHROME = `<div data-sbb="top"><a data-sbb="home" href="/">Sagebrush</a><span data-sbb="title"></span><span data-sbb="pages" hidden><button data-sbb="pgprev" title="Previous page (PageUp)" aria-label="Previous page">‹</button><select data-sbb="pgsel" title="Page"></select><button data-sbb="pgnext" title="Next page (PageDown)" aria-label="Next page">›</button></span><span data-sbb="hint" hidden>Drag to move (into or out of groups) · double-click to write, add, or edit an edge · shift-drag to connect · Delete · ⌘Z</span><button data-sbb="edit" aria-pressed="false" aria-label="Edit" title="Move, write, add and connect notes">✎<span class="lbl"> Edit</span></button><button data-sbb="fit" title="Show everything (0)" aria-label="Show everything">⤢</button><span class="menuwrap"><button data-sbb="menubtn" title="More" aria-label="More">⋯</button><div data-sbb="menu" class="menu" hidden><button data-sbb="newboard">New board</button><button data-sbb="open">Open… (JSON, JSON Canvas, Mermaid, a CoCalc board)</button><button data-sbb="mermaid">Import Mermaid…</button><button data-sbb="examples">Examples…</button><hr><button data-sbb="addpage">Add a page</button><button data-sbb="pageprops">Page…</button><button data-sbb="rmpage" hidden>Delete this page</button><button data-sbb="tidy">Tidy (automatic layout)</button><div data-sbb="lang" role="group" aria-label="The language of this board's code">Code: <button data-mode="python" aria-pressed="true">Python</button><button data-mode="sage" aria-pressed="false">Sage</button><button data-mode="magma" aria-pressed="false">Magma</button><button data-mode="matlab" aria-pressed="false">MATLAB</button></div><hr><button data-sbb="present">Present (a slideshow)</button><button data-sbb="print">Print or save as PDF…</button><button data-sbb="html">Download as HTML (one file)</button><button data-sbb="download">Download JSON</button><button data-sbb="canvas">Download JSON Canvas</button><button data-sbb="copyjson">Copy JSON</button><button data-sbb="timetravel">TimeTravel…</button><button data-sbb="revert" hidden>Revert to the original</button></div></span><input data-sbb="openfile" type="file" accept=".json,.canvas,.mmd,.mermaid,.md,.board,.slides,application/json,text/markdown,text/plain" hidden></div>
<div data-sbb="pr-mask" hidden></div><div data-sbb="pr-say" hidden></div><div data-sbb="pr-bar" hidden><button data-sbb="pr-prev" title="Back (←)" aria-label="Back">‹</button><span data-sbb="pr-where"></span><button data-sbb="pr-next" title="Next (→, Space)" aria-label="Next">›</button><button data-sbb="pr-exit" title="Stop (Esc)" aria-label="Stop presenting">✕</button></div>
<div data-sbb="tour" hidden><div data-sbb="say"></div><div data-sbb="nav"><div><button data-sbb="prev" title="Back (←)" aria-label="Back" disabled>←</button><button data-sbb="next" title="Next (→)" aria-label="Next">→</button></div><span data-sbb="where"></span></div></div>
<div data-sbb="tt" hidden role="group" aria-label="TimeTravel"><input type="range" data-sbb="ttslider" min="0" max="0" value="0" aria-label="Version"><span data-sbb="ttwhen"></span><button data-sbb="ttrevert" title="Make the board this version again (undo takes it back)">Revert</button><button data-sbb="ttclose" title="Close (Esc): the board as it is" aria-label="Close">✕</button></div>
<dialog data-sbb="exdlg"><h3>Example boards</h3><div data-sbb="exlist"></div><form method="dialog"><button>Close</button></form></dialog>
<dialog data-sbb="mmdlg"><h3>Import a Mermaid flowchart</h3><form method="dialog"><p class="prnote">Paste a flowchart (<code>graph</code> or <code>flowchart</code>), or Markdown with <code>\`\`\`mermaid</code> blocks (a page each). The board lays it out and routes its edges, so labels do not overlap. It replaces this board (Undo brings it back).</p><textarea data-sbb="mmtext" spellcheck="false" placeholder="flowchart LR&#10;  A[Start] --> B{Is it?}&#10;  B -->|Yes| C[OK]&#10;  B -->|No| D[Rethink]"></textarea><div data-sbb="mmerr"></div><div class="prbtns"><button value="cancel" formnovalidate>Cancel</button><button data-sbb="mm-go" class="be-done">Import</button></div></form></dialog>
<dialog data-sbb="pgdlg"><h3>Page</h3><form data-sbb="pgform" method="dialog">
<fieldset data-sbb="pg-title-set"><label>Title <input type="text" data-sbb="pg-title" maxlength="200"></label></fieldset>
<fieldset><label><input type="checkbox" data-sbb="pg-slide"> A slide (16:9): a card it is arranged on, which Present shows</label></fieldset>
<fieldset data-sbb="pg-tpl-set"><label><input type="checkbox" data-sbb="pg-template"> A template: pages made from it show its card, background and items under their own</label></fieldset>
<fieldset data-sbb="pg-uses-set"><label>Made from <select data-sbb="pg-uses"></select></label></fieldset>
<fieldset><legend>Background</legend><div data-sbb="pg-colors" role="group" aria-label="Background color"></div></fieldset>
<fieldset data-sbb="pg-pic-set"><button type="button" data-sbb="pg-pic">Picture…</button><button type="button" data-sbb="pg-nopic">No picture</button><span data-sbb="pg-pic-on"></span></fieldset>
<div class="prbtns"><button value="cancel" formnovalidate>Cancel</button><button data-sbb="pg-go" class="be-done">Done</button></div></form></dialog>
<dialog data-sbb="htmldlg"><h3>Download as HTML</h3><form data-sbb="htmlform" method="dialog">
<p class="prnote">One file, which opens in any browser. To run its code, it loads Sagebrush from the web, unless in offline mode.</p>
<fieldset data-sbb="html-py-set"><label><input type="checkbox" name="python" data-sbb="html-py"> Offline mode: code runs without the network <span data-sbb="html-size"></span></label></fieldset>
<fieldset data-sbb="html-out-set"><label><input type="checkbox" name="outputs" data-sbb="html-out" checked> Slow code's outputs, so they show at once <span data-sbb="html-out-size"></span></label></fieldset>
<fieldset><legend>Its code runs with</legend><label><input type="radio" name="engine" value="pinned" checked> the version of Sagebrush it was saved with</label><label><input type="radio" name="engine" value="latest"> the latest version, when online (else that one)</label></fieldset>
<div class="prbtns"><button value="cancel" formnovalidate>Cancel</button><button data-sbb="html-go" class="be-done">Download</button></div></form></dialog>
<dialog data-sbb="prdlg"><h3>Print or save as PDF</h3><form data-sbb="prform" method="dialog">
<fieldset><legend>What</legend><label><input type="radio" name="mode" value="pages" data-sbb="pr-pages" checked> Every page <span data-sbb="pr-pages-n"></span></label><label><input type="radio" name="mode" value="tour" data-sbb="pr-tour"> The tour <span data-sbb="pr-tour-n"></span></label></fieldset>
<fieldset><legend>Paper</legend><label><input type="radio" name="paper" value="letter" checked> Letter</label><label><input type="radio" name="paper" value="a4"> A4</label><span class="sep"></span><label><input type="radio" name="orient" value="landscape" checked> Landscape</label><label><input type="radio" name="orient" value="portrait"> Portrait</label></fieldset>
<p class="prnote">Your browser's print dialog opens next: choose <b>Save as PDF</b> as its destination for a PDF. Text stays text, and math and arrows stay sharp at any zoom.</p>
<div class="prbtns"><button value="cancel" formnovalidate>Cancel</button><button data-sbb="pr-go" class="be-done">Print…</button></div></form></dialog>`;

export type BoardApi = ReturnType<typeof mountBoard>;

/** Mount a board in `root` (which the host places and sizes), with what the host provides. */
// The code notes of a document, by their cells' ids (codeOrder: every
// page, in groups too; an id on several pages, each page's its own).
function codeNotes(d: BoardDoc): Map<string, DocNote> {
  const out = new Map<string, DocNote>(), cells = codeOrder(d);
  for (let i = 0; i < pageCount(d); i++) {
    const on = new Map<string, DocNote>();
    const walk = (ns: DocNode[] | undefined) => {
      for (const n of ns ?? []) {
        if (n.kind === "group") walk(n.children);
        else if (n.kind !== "ink" && n.kind !== "sticker" && n.code !== undefined) on.set(n.id, n);
      }
    };
    walk(pageOf(d, i).nodes);
    for (const c of cells) if (c.page === i && on.has(c.item)) out.set(c.id, on.get(c.item)!);
  }
  return out;
}
// Code items in reading order with their previews (code.ts shows a preview,
// and doesn't run it, when it opens).  Only an item whose cell is its id's:
// one whose id other pages' items have too is a cell by its page, and its
// cell (and its seed) changes as those come and go, so a preview kept may be
// another cell's: it has none, and runs (CORR-79B-3). Nor, once its own
// again, does an item that was one since the board was loaded, until it has
// run as its own (what it kept may be dropped only after a later sync takes
// it, CORR-BB9-1): byPage, those items.
function withPreviews(d: BoardDoc, order: CodeCell[], byPage: Set<string>) {
  const notes = codeNotes(d);
  return order.map(({ id, code, item }) => { const p = id === item && !byPage.has(item) ? notes.get(id)?.preview : undefined; return p ? { id, code, preview: p } : { id, code }; });
}

export function mountBoard(root: HTMLElement, host: BoardHost) {
  addStyle();
  root.classList.add("sbb");
  const board = new Board(root);
  root.insertAdjacentHTML("beforeend", CHROME);
  // (a remote picture shown when clicked: safe-html.ts remotePicture)
  root.addEventListener("click", loadRemotePicture, true);
  // (the parts, found within root by their data-sbb: no ids, which two
  // boards on a page, or the host's own elements, would share)
  const $ = (part: string) => root.querySelector<HTMLElement>(`[data-sbb="${part}"]`)!;
  ($("home") as HTMLAnchorElement).href = host.home ?? "/";
  // pictures: where the host keeps them (by name); a board that carries them (data: URLs) gives them up on the way in
  const images = host.images;
  board.imageUrl = (name) => images.url(name);
  board.icon = host.icon ? (name) => host.icon!(name) : null;
  // (listeners on the page, taken off by destroy())
  const offs: (() => void)[] = [];
  const on = (t: EventTarget, type: string, f: (e: any) => void, capture = false) => { t.addEventListener(type, f, capture); offs.push(() => t.removeEventListener(type, f, capture)); };
  // (the page's keys are this board's only when it is the active one: focus.ts)
  offs.push(track(root));
  const mine = () => active(root);
  let doc: BoardDoc | null = null;
  // (a code item on the page shown: its cell's id, codeOrder's)
  let cellOf = new Map<string, string>();
  const cell = (id: string) => cellOf.get(id) ?? id;
  // (items that were cells by their page since the board was loaded: withPreviews)
  const byPage = new Set<string>();
  let at = -1; // the tour's step; -1 before it starts
  let pageIx = 0, shownPage = -1; // the page shown
  let placed: { id: string; kind: string; x: number; y: number; w: number; h: number }[] = [];
  let routingGen = 0, routed = false;

  let mathModule: Promise<{ typeset: (el: Element) => void }> | null = null;
  const hasMath = (s: string) => /\$|\\\(|\\\[/.test(s);

  // (a note's height at a width, measured once)
  const heights = new Map<string, number>();
  // (the document as it came, before this browser's or this person's edits: Revert)
  let original: BoardDoc | null = null;
  // (documents loaded: a preview computed for one is not kept in another)
  let loads = 0;
  // The name of the shown document's output cache (outcache.ts): the host
  // store's, beside the document and not in it, since a document's seed is
  // portable and anyone can copy it (SEC-B88-1).  Another document shown
  // here (loaded, opened, a new board, reverted) gets a new one, and the
  // old one's outputs go (SEC-B88-3).
  let outputsId: string | null = null, docId: string | null = null;
  // (one document's pictures' pixels, image-size.ts: the pictures it
  // carries, its notes' and its code's, afresh for each document shown, CORR-71A-2)
  let docPixels = new PixelBudget();
  // (whether the document was written in this browser: its remote pictures shown at once)
  let writtenHere = false;
  function newOutputs(fresh: boolean) {
    // (first: what is being written was the document's before, CORR-A48-4)
    editor.drop();
    const old = outputsId, was = docId;
    docId = host.store?.documentId?.(fresh) ?? null;
    outputsId = host.outputs ? docId : null;
    if (fresh && old && old !== outputsId) host.outputs?.drop(old).catch(() => {});
    if (code) code.cacheId = outputsId;
    docPixels = new PixelBudget();
    code?.usePictures(docPixels);
    board.epoch++;
    // (and its history: another document's, the one before gone with what it recorded)
    // (the document replaced: its name, if it had one, or none where the host names none)
    if (fresh || docId !== was) newHistory(fresh && (was !== null || docId === null) ? was : undefined);
  }

  // a page made from a template: the template's items and edges under its
  // `own` (inert: shown, not the page's to edit; their code shown on the
  // template's page only, unless `keepCode`: a JSON Canvas).  Their ids are
  // "tpl:...", or "tpl2:..." and so on: a prefix none of the page's own ids
  // starts with (CORR-00C-1)
  function underlay(d: BoardDoc, i: number, own: { items: Item[]; edges: Edge[] }, keepCode = false): { items: Item[]; edges: Edge[] } {
    const t = templateOf(d, i);
    if (t < 0) return { items: [], edges: [] };
    const taken = [...own.items, ...own.edges].map((x) => x.id);
    let pre = "tpl:";
    for (let k = 2; taken.some((s) => s.startsWith(pre)); k++) pre = `tpl${k}:`;
    const tl = layout(pageView(d, t), measure), id = (s: string) => pre + s;
    return {
      items: tl.items.map((it) => ({ ...it, id: id(it.id), parent: it.parent && id(it.parent), inert: true, ...(keepCode ? {} : { code: undefined, order: undefined, hideCode: undefined }) })),
      edges: tl.edges.map((e) => ({ ...e, id: id(e.id), from: id(e.from), to: id(e.to), src: undefined })),
    };
  }

  // (each load is a new generation: a show() of an earlier one, resuming
  // from an await, then does nothing more; nor does any once the board is
  // destroyed, CORR-C08-1)
  let loadGen = 0, destroyed = false;
  /** Lay out and draw a document, the camera where it is (`view`: a version
   * being looked at in TimeTravel, which is not the document and does not
   * run).  False if it was overtaken (another document loaded, the board
   * destroyed) and drew nothing. */
  async function show(d: BoardDoc, view = false): Promise<boolean> {
    const g = loadGen, over = () => destroyed || g !== loadGen;
    if (over()) return false;
    // (another document than the one shown, during a drag or resize: the
    // gesture dropped, nothing of it kept in this one, CORR-59E-1; the same
    // one laid out again waits for its release, below)
    const replacing = !view && d !== doc;
    if (replacing && editor.moving) editor.cancelGesture();
    const bad = formatError(d);
    if (bad) throw new Error(bad);
    if (!isBoard(d)) throw new Error("board: a document needs nodes (or pages of them)");
    // (only data: whatever it came from, REACT-XSS)
    d = cleanDoc(d);
    await images.absorb(d, docPixels);
    if (over()) return false;
    await images.ensure(Object.keys(d.images ?? {}));
    if (over()) return false;
    if (!view) doc = d;
    pageIx = Math.max(0, Math.min(pageCount(d) - 1, pageIx));
    const v = flipped.size ? flip(pageView(d, pageIx)) : pageView(d, pageIx);
    board.markdown = (s) => markdown(s, { pixels: docPixels, remote: writtenHere ? true : "click" });
    if (host.math && hasMath(JSON.stringify(d))) {
      // KaTeX: the host's, loaded the first time a board has math
      mathModule ??= host.math();
      const m = await mathModule;
      if (over()) return false;
      board.typeset = (el) => m.typeset(el);
    }
    // (edges' routes are found between frames: large boards show at once,
    // their edges straight until routed)
    const laid = premeasure(v);
    if (templateOf(d, pageIx) >= 0) premeasure(pageView(d, templateOf(d, pageIx)));
    const { items, edges, routing } = laid ?? layout(v, measure, { deferRoutes: true });
    // (laid out again after an edit: an edge whose ends did not move keeps its
    // route until the new ones are ready, so only the moved items' edges are
    // straight meanwhile; the new routes replace them all at once)
    const before = new Map((shownPage === pageIx ? board.edgeList() : []).map((e) => [`${e.from}\0${e.to}\0${e.label ?? ""}`, e]));
    const now = new Map(items.map((it) => [it.id, it]));
    const still = (id: string) => {
      const a = board.item(id), b = now.get(id);
      return !!a && !!b && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
    };
    for (const e of edges) {
      const old = before.get(`${e.from}\0${e.to}\0${e.label ?? ""}`);
      if (old?.points && still(e.from) && still(e.to)) { e.points = old.points; e.lx = old.lx; e.ly = old.ly; }
    }
    // code items: their places in the reading order; the engine runs what changed
    const order = codeOrder(d);
    const nth = new Map(order.map((c, i) => [c.id, i + 1]));
    // (the board's items are the page's: their cells, by their ids on it)
    cellOf = new Map(order.filter((c) => c.page === pageIx).map((c) => [c.item, c.id]));
    for (const it of items) if (it.code !== undefined) it.order = nth.get(cellOf.get(it.id) ?? it.id);
    if (!view) for (const c of order) if (c.id !== c.item) byPage.add(c.item);
    if (!view && (order.length || code)) engine()?.sync(withPreviews(d, order, byPage), d.mode ?? "python", d.seed).catch((e) => console.warn("board: code items:", e));
    for (const b of root.querySelectorAll<HTMLButtonElement>("[data-sbb=lang] button")) b.setAttribute("aria-pressed", String(b.dataset.mode === (d.mode ?? "python")));
    // (a template's under the page's own)
    const under = underlay(d, pageIx, { items, edges });
    // (code items' heights were for these two layouts, the page's and its template's: PERF-F2A-1)
    codeHeights.clear();
    // (an item being dragged or resized: not put back where the document has
    // it; the board laid out again once it is let go, CI Oct 14)
    if (editor.moving && !view && !replacing) { relayoutHeld = true; return true; }
    board.setItems([...under.items, ...items], [...under.edges, ...edges]);
    // (the page's slide and background, or its template's)
    const look = lookOf(d, pageIx);
    board.backdrop = look.slide || look.background ? { slide: look.slide, ...look.background } : null;
    toolbar.tools.value = d.tools ?? defaultTools();
    shownPage = pageIx;
    const gen = ++routingGen;
    routed = false;
    // (routed now if that is quick, 40 ms; the rest between frames)
    const work = (budget: number) => {
      if (gen !== routingGen) return;
      const t0 = performance.now();
      while (performance.now() - t0 < budget) {
        if (routing.next().done) { routed = true; board.request(); return; }
      }
      setTimeout(() => work(12), 0);
    };
    // (routed now if that is quick: 40 ms; laid out again after an edit,
    // the routes it had kept meanwhile, 8: the edit is drawn first)
    work(before.size ? 8 : 40);
    placed = items.map(({ id, kind, x, y, w, h }) => ({ id, kind, x, y, w, h }));
    host.title?.(d.title ?? "");
    // (not while it is being renamed)
    if (!$("title").querySelector("input")) $("title").textContent = d.title ?? "";
    // (the tour's caption: not over TimeTravel's bar; a notice, until the next edit)
    $("tour").hidden = view || (!v.steps?.length && !v.intro && !notice);
    if (notice && !view && !v.steps?.length && !v.intro) caption(notice, "");
    pageBar();
    // (compared with the original as it is shown: cleaned, so that its keys'
    // order, or the format's name and version added, are no edit)
    if (original && originalKey?.[0] !== original) originalKey = [original, shownKey(cleanDoc(original))];
    $("revert").hidden = view || !original || originalKey![1] === shownKey(d);
    return true;
  }
  /** Draw again what is shown: the document, or the version being looked at (false: nothing drawn). */
  const redraw = () => (viewing ? show(viewing, true) : doc ? show(doc) : Promise.resolve(false));
  // (a board's pictures aside: carried, or kept here, they are the same)
  const shownKey = (d: BoardDoc) => JSON.stringify({ ...d, images: undefined });
  let originalKey: [BoardDoc, string] | null = null;

  // A reader's { } outside Edit: the code items whose code shows (or hides)
  // otherwise than the board says, for this reader only.
  const flipped = new Set<string>();
  function flip(v: BoardDoc): BoardDoc {
    const node = (n: any): any => (n.kind === "group" ? { ...n, children: n.children.map(node) } : flipped.has(n.id) && n.code !== undefined ? { ...n, hideCode: !n.hideCode } : n);
    return { ...v, nodes: (v.nodes ?? []).map(node) };
  }
  board.onToggleCode = (id) => {
    if (editor.on) { flipped.delete(id); editor.toggleCode(id); return; }
    if (!flipped.delete(id)) flipped.add(id);
    redraw().catch(fail);
  };

  const heightKey = (n: MeasuredNote, w: number) => JSON.stringify([n.title, n.text, n.detail, n.ref, n.shape, n.img?.w, n.img?.h, w]);
  const widthKey = (n: MeasuredNote, max: number) => JSON.stringify(["w", n.title, n.text, n.detail, n.ref, n.shape, n.img?.w, n.img?.h, max]);
  // (code items' heights measured with the rest for one layout: premeasure)
  const codeHeights = new Map<string, number>();
  function measure(n: MeasuredNote, w: number) {
    // (a code item's height changes with its output: measured each time)
    if (n.code !== undefined) {
      const k = n.id + "\0" + heightKey(n, w), h = codeHeights.get(k);
      if (h !== undefined) { codeHeights.delete(k); return h; }
      return board.measure({ ...n, kind: "note", order: 1, image: n.img }, w);
    }
    const k = heightKey(n, w);
    let h = heights.get(k);
    if (h === undefined) heights.set(k, (h = board.measure({ ...n, kind: "note", image: n.img }, w)));
    return h;
  }
  // (and a `fit` note's width)
  measure.width = (n: MeasuredNote, max: number) => {
    const k = widthKey(n, max);
    let w = heights.get(k);
    if (w === undefined) heights.set(k, (w = board.measureWidth({ ...n, kind: "note", image: n.img }, max)));
    return w;
  };
  // What layout() will measure for `v`, measured at once: the notes all put
  // on the page together and read after one layout of it, not one layout
  // each (a large board's first drawing: 1000 notes, 250 ms of the 440).
  // Found by laying it out with a measure that only notes what it is asked:
  // the widths first (a fitted note's height is measured at its width), then
  // the heights.  Nothing to measure (an edit, every note measured before):
  // that layout is the board's, given back, not made twice.
  function premeasure(v: BoardDoc): ReturnType<typeof layout> | undefined {
    for (let pass = 0; pass < 2; pass++) {
      const hs = new Map<string, [MeasuredNote, number]>(), ws = new Map<string, [MeasuredNote, number]>();
      const ask = Object.assign((n: MeasuredNote, w: number) => {
        const k = n.code !== undefined ? n.id + "\0" + heightKey(n, w) : heightKey(n, w), h = (n.code !== undefined ? codeHeights : heights).get(k);
        if (h === undefined) hs.set(k, [n, w]);
        return h ?? 60;
      }, { width: (n: MeasuredNote, max: number) => { const k = widthKey(n, max), w = heights.get(k); if (w === undefined) ws.set(k, [n, max]); return w ?? max; } });
      const laid = layout(v, ask, { deferRoutes: true });
      if (!pass && !ws.size && !hs.size) return laid;
      if (ws.size) {
        const got = board.measureMany([...ws.values()].map(([n, max]) => ({ it: { ...n, kind: "note" as const, image: n.img }, w: max, width: true })));
        [...ws.keys()].forEach((k, i) => heights.set(k, got[i]));
        continue;
      }
      if (hs.size) {
        const got = board.measureMany([...hs.values()].map(([n, w]) => ({ it: { ...n, kind: "note" as const, image: n.img, ...(n.code !== undefined ? { order: 1 } : {}) }, w })));
        [...hs].forEach(([k, [n]], i) => (n.code !== undefined ? codeHeights : heights).set(k, got[i]));
      }
      return undefined;
    }
    return undefined;
  }

  // The engine of code items: the host's (none: the code shows, as text, as in an exported file)
  let code: BoardCode | null = null;
  function engine(): BoardCode | null {
    if (code || !host.code) return code;
    const c = (code = host.code(doc!));
    c.onChange = () => { board.codeStates(); relayout(); };
    c.onRan = (ids) => { keepPreviews(c, ids).catch((e) => console.warn("board: previews:", e)); };
    c.cache = host.outputs ?? null;
    c.cacheId = outputsId;
    c.usePictures(docPixels);
    c.ready.then((ok) => {
      // (it could not start: the caption says why, until the next edit)
      if (!ok) {
        if (code === c && c.error) say(`**The code can't run here:** ${c.error}`);
        return;
      }
      board.setCode({ highlight: (s) => c.highlight!(s), output: (id, copy) => c.output(cell(id), copy), state: (id) => c.state(cell(id)), run: (id) => { c.run([cell(id)]); } });
      relayout();
    });
    return c;
  }
  // Previews of slow code items (preview.ts, design/outputs.md): after a run,
  // an item that ran keeps one if it is slow from root and loses it if not,
  // written only when what it shows changed, and not as a step to undo
  // (each of one run: dropped if its item ran again, or another board was
  // loaded, while its picture was drawn, SEC-14C-1)
  async function keepPreviews(c: BoardCode, ids: string[]) {
    const loaded = loads;
    const got = await c.previews(ids);
    if (!got.size || code !== c || loads !== loaded) return;
    await editor.commit((d) => {
      const notes = codeNotes(d), own = new Set(codeOrder(d).filter((x) => x.id === x.item).map((x) => x.id));
      for (const [id, { preview: p, gen }] of got) {
        const n = notes.get(id);
        if (!n || c.generation(id) !== gen) continue;
        // (a cell by its page keeps none: withPreviews; one that ran as its own, what it showed)
        if (p === null || !own.has(id)) delete n.preview;
        else if (!sameOutputs(p, n.preview)) n.preview = p;
        if (own.has(id)) byPage.delete(id);
      }
      const kept = new Map([...notes].filter(([, n]) => n.preview).map(([id, n]) => [id, n.preview!]));
      for (const id of overCap(kept)) delete notes.get(id)!.preview;
    }, false, false);
  }

  // (laid out again as outputs change size: once a frame at most; never
  // while items are dragged or resized, which a layout would put back where
  // the document has them: once they are let go)
  let relayoutFrame = 0, relayoutHeld = false;
  function relayout() {
    if (editor.moving) { relayoutHeld = true; return; }
    // (and if an item came to be dragged or resized meanwhile: once it is let go)
    if (!relayoutFrame) relayoutFrame = requestAnimationFrame(() => { relayoutFrame = 0; if (editor.moving) { relayoutHeld = true; return; } redraw().catch(fail); });
  }
  // (fonts that came after notes were measured, KaTeX's among them: the
  // notes measured again, or their text would overflow them)
  if (document.fonts) on(document.fonts, "loadingdone", () => { heights.clear(); relayout(); });

  /** Show a document from the start: the whole board, or the page and step in the address (#N, #pP, #pP-N). */
  async function load(d: BoardDoc, stored = false) {
    loads++;
    loadGen++;
    byPage.clear();
    newOutputs(!stored);
    // (a document loaded from elsewhere was not written here; the one kept, as it says)
    writtenHere = stored ? host.store?.writtenHere?.() ?? false : host.store?.writtenHere?.(false) ?? false;
    const m = /^#(?:p(\d+)(?:-(\d+))?|(\d+))$/.exec(host.address?.get() ?? "");
    pageIx = m?.[1] ? Number(m[1]) - 1 : 0;
    closeTimeTravel(false);
    if (!(await show(d))) return;
    if (boardHistory) remember();
    at = -1;
    const n = Number(m?.[2] ?? m?.[3] ?? 0);
    step(n && pageView(d, pageIx).steps?.length ? n - 1 : -1, true);
  }

  /** Show page i (0-based), from its start. */
  async function page(i: number) {
    if (!doc) return;
    // (first: what is being written is kept on its own page)
    editor.clear();
    pageIx = Math.max(0, Math.min(pageCount(viewing ?? doc) - 1, i));
    if (!(await redraw())) return;
    step(-1, true);
  }

  // the page picker: shown when there are pages
  function pageBar() {
    const d = doc!, n = pageCount(d), sel = $("pgsel") as HTMLSelectElement;
    $("pages").hidden = n < 2;
    sel.replaceChildren(...Array.from({ length: n }, (_, i) => new Option(`${i + 1}. ${pageOf(d, i).title || "Page " + (i + 1)}${d.pages?.length && pageOf(d, i).template ? " (template)" : ""}`, String(i))));
    sel.value = String(pageIx);
    ($("pgprev") as HTMLButtonElement).disabled = pageIx <= 0;
    ($("pgnext") as HTMLButtonElement).disabled = pageIx >= n - 1;
    $("rmpage").hidden = n < 2;
  }

  /** The steps of the page shown. */
  const steps = () => (doc ? pageView(doc, pageIx).steps ?? [] : []);
  const hashFor = (i: number) => (pageIx ? `#p${pageIx + 1}${i >= 0 ? "-" + (i + 1) : ""}` : i >= 0 ? `#${i + 1}` : "");

  function caption(md: string, where: string) {
    const el = $("say");
    el.classList.remove("open");
    el.innerHTML = markdown(md);
    if (board.typeset && hasMath(md)) board.typeset(el);
    $("where").textContent = where;
    // the camera keeps clear of the title bar and the caption
    board.insets = { top: 44, right: 0, left: 0, bottom: $("tour").hidden ? 0 : $("tour").offsetHeight + 18 };
  }

  /** Go to step `i` of the tour (-1: the whole board, and the intro). */
  function step(i: number, now = false) {
    const ss = steps();
    at = Math.max(-1, Math.min(ss.length - 1, i));
    if (at < 0) {
      caption((doc && pageView(doc, pageIx).intro) ?? "", ss.length ? `${ss.length} steps` : "");
      // (a slide: its card)
      const s = doc && lookOf(doc, pageIx).slide;
      if (s) { const c = board.cameraFor(s.x, s.y, s.x + s.w, s.y + s.h); if (now) board.setCamera(c); else board.flyTo(c); }
      else board.focus(undefined, now);
    } else {
      const s = ss[at];
      caption(s.say ?? "", `${at + 1} / ${ss.length}`);
      board.focus(typeof s.focus === "string" ? [s.focus] : s.focus, now);
    }
    host.address?.set(hashFor(at));
    ($("prev") as HTMLButtonElement).disabled = at < 0;
    ($("next") as HTMLButtonElement).disabled = at >= ss.length - 1;
  }

  // (on a phone the caption is one line: a tap shows it whole, or one line again)
  $("say").onclick = (e) => {
    if ((e.target as Element).closest("a")) return;
    $("say").classList.toggle("open");
    board.insets = { ...board.insets, bottom: $("tour").hidden ? 0 : $("tour").offsetHeight + 18 };
  };
  $("prev").onclick = () => step(at - 1);
  $("next").onclick = () => step(at + 1);
  $("fit").onclick = () => board.focus();
  on(window, "keydown", (e: KeyboardEvent) => {
    if (!mine() || e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.metaKey || e.ctrlKey || e.altKey) return;
    // (items selected in Edit: the arrow keys move them; in Edit, Space held pans)
    if (editor.hasSelection && e.key.startsWith("Arrow")) return;
    if (editor.on && e.key === " ") return;
    if (e.key === "ArrowRight" || e.key === " ") step(at + 1);
    else if (e.key === "ArrowLeft") step(at - 1);
    // (Esc stopping a tool, or a selection, in Edit is the editor's: the camera stays)
    else if ((e.key === "Escape" && !editor.escapes) || e.key === "0") step(-1);
    else if (e.key === "PageDown") page(pageIx + 1).catch(fail);
    else if (e.key === "PageUp") page(pageIx - 1).catch(fail);
    else if (e.key === "+" || e.key === "=") board.zoomAt(1.25, board.el.clientWidth / 2, board.el.clientHeight / 2);
    else if (e.key === "-") board.zoomAt(0.8, board.el.clientWidth / 2, board.el.clientHeight / 2);
    else return;
    e.preventDefault();
  });

  function fail(e: unknown) {
    if (destroyed) return;
    $("tour").hidden = false;
    caption("**This board could not be shown:** " + String((e as Error)?.message ?? e).replace(/[<>&]/g, ""), "");
  }

  // the document: the host's (none: nothing is shown until load(), as for the benchmark's boards)
  // (a document the host or an agent loads meanwhile wins: the store's,
  // arriving later, is not shown over it)
  const opening = loads;
  const opened = host.store?.load().then((r) => {
    if (!r || loads !== opening) return;
    original = r.original ?? null;
    converted = r.notice ?? "";
    return load(r.doc, true).then(sayConverted);
  }).catch(fail);

  // editing, and keeping what was edited
  const editor = new Editor(board, () => doc, async (d) => {
    // (an edit, an agent's say, while a version is looked at: the board as it is)
    closeTimeTravel(false);
    notice = "";
    const prev = doc, g = loadGen;
    // (not drawn, the board destroyed meanwhile: the edit is still saved; another board loaded: not)
    if (!(await show(d))) {
      if (destroyed && g === loadGen) {
        // (and a version of it: recorded before the history is closed, CORR-54B-2)
        const kept = cleanDoc(d);
        host.store?.save(kept);
        if (!remembered && prev && prev !== replaced) toRecord.push(prev);
        remembered = true;
        toRecord.push(kept);
      }
      return;
    }
    // (the document as shown: its pictures' bytes are kept apart, by the host's images)
    host.store?.save(doc!);
    remember(prev);
  }, (d) => pageOf(d, pageIx));
  editor.isActive = mine;
  // a document from elsewhere (the store's: another person's change, or the
  // remote's, newer than the copy shown first): shown in place, the same
  // document (its camera, outputs and history kept), once the first is; the
  // undo steps before it forgotten, so that an undo cannot write the older
  // document back over it
  // (one after another: an older one never drawn over a newer; resolved once shown, for the store)
  let elsewhere: Promise<unknown> = opened ?? Promise.resolve();
  const unsubscribe = host.store?.subscribe?.((d, note) => {
    const shown = elsewhere.then(async () => {
      if (destroyed || !doc) return;
      closeTimeTravel(false);
      const prev = doc;
      editor.forget();
      if (!(await show(d))) return;
      remember(prev);
      if (note) say(note);
    });
    elsewhere = shown.catch(fail);
    return shown;
  });
  if (unsubscribe) offs.push(unsubscribe);
  // The board's title: in Edit, a click renames it where it is (Enter, or
  // leaving, keeps the name, as an edit; Esc does not)
  const titleEl = $("title");
  titleEl.onclick = () => {
    if (!editor.on || !doc || titleEl.querySelector("input")) return;
    const input = Object.assign(document.createElement("input"), { value: doc.title ?? "", placeholder: "Untitled board" });
    input.setAttribute("aria-label", "The board's title");
    titleEl.replaceChildren(input);
    input.focus();
    input.select();
    let done = false;
    const finish = (keep: boolean) => {
      if (done) return;
      done = true;
      const t = input.value.trim(), was = doc?.title ?? "";
      titleEl.textContent = keep ? t : was;
      if (keep && t !== was) editor.commit((d) => { if (t) d.title = t; else delete d.title; });
    };
    input.onkeydown = (e) => {
      e.stopPropagation();
      if (e.key === "Enter") { e.preventDefault(); finish(true); input.blur(); }
      else if (e.key === "Escape") { e.preventDefault(); finish(false); }
    };
    input.onblur = () => finish(true);
  };
  editor.onSettled = () => { if (relayoutHeld) { relayoutHeld = false; relayout(); } };
  editor.onRun = (id) => { code?.run([cell(id)]); };
  editor.highlight = () => code?.highlight ?? null;
  editor.images = images;
  const editBtn = $("edit");
  editBtn.onclick = () => { closeTimeTravel(); editor.setOn(!editor.on); };
  offs.push(effect(() => {
    editBtn.setAttribute("aria-pressed", String(editor.editing.value));
    $("hint").hidden = !editor.editing.value;
    root.classList.toggle("sbb-editing", editor.editing.value);
  }));
  // the toolbar, in Edit mode: adds at the middle of the view
  const center = () => { const v = board.view(); return { x: (v.x0 + v.x1) / 2, y: (v.y0 + v.y1) / 2 }; };
  const toolbar = new Toolbar(root, [
    { id: "select", label: "Select", icon: "↖", title: "Select: drag on the background to select what the rectangle holds (Space-drag pans); Esc to stop", toggle: editor.selecting },
    { id: "note", label: "Note", icon: "¶", title: "Add a note (Markdown, with math)", run: () => { const c = center(); editor.addNote(c.x, c.y); } },
    { id: "code", label: "Code", icon: "{ }", title: "Add a note with Python code (any note can have code: + Code in its editor)", run: () => { const c = center(); editor.addCode(c.x, c.y); } },
    { id: "image", label: "Image", icon: "▨", title: "Add pictures (or paste one, or drop files on the board)", run: () => pickImages() },
    { id: "sticker", label: "Sticker", icon: "☺", title: "Add a sticker: an emoji (double-click one to change it)", run: () => editor.pickSticker({ at: center(), under: toolbar.el }) },
    { id: "group", label: "Group", icon: "▣", title: "Add a group (drag notes into it)", run: () => { const c = center(); editor.addGroup(c.x, c.y); } },
    { id: "connect", label: "Connect", icon: "⤳", title: "Connect notes: tap one, then another (or shift-drag from one to the other); Esc to stop", toggle: editor.connecting },
    { id: "draw", label: "Draw", icon: "✎", title: "Draw: drag to draw (a pen's pressure counts; once a pen has drawn, a finger pans); Esc to stop", toggle: editor.drawing },
    { id: "erase", label: "Erase", icon: "⌫", title: "Erase: drag across strokes to remove them; Esc to stop", toggle: editor.erasing },
    { id: "page", label: "Page", icon: "⧉", title: "Add a page after this one", run: () => $("addpage").click() },
    { id: "undo", label: "↶", icon: "↶", title: "Undo (Ctrl+Z)", run: () => editor.undo() },
    { id: "redo", label: "↷", icon: "↷", title: "Redo (Ctrl+Shift+Z)", run: () => editor.redo() },
  // (which tools a board shows is a setting, not an edit to undo)
  ], editor.editing, (ids) => editor.commit((d) => { d.tools = ids; }, false, false));
  // the pen row: the pen's color and width, a highlighter, the eraser (pen.ts)
  const pen = new PenRow(root, editor.drawing, editor.erasing, () => toolbar.el);
  editor.onPickPicture = () => pickImages();
  editor.penStyle = () => pen.style();
  // pictures chosen from files (or the camera, on a phone), added in the middle of the view
  function pickImages() {
    const input = Object.assign(document.createElement("input"), { type: "file", accept: "image/png,image/jpeg,image/gif,image/webp", multiple: true });
    // (in the DOM, out of sight: some browsers do not open the chooser for a detached input)
    input.className = "sb-fileinput";
    input.style.cssText = "position:fixed;left:-9999px";
    input.onchange = () => { input.remove(); const c = center(); if (input.files?.length) editor.addImages(input.files, c.x, c.y).catch(fail); };
    // (one at most: a chooser cancelled earlier left its input behind)
    for (const old of document.querySelectorAll("input.sb-fileinput")) old.remove();
    document.body.append(input);
    input.click();
  }
  const menu = $("menu");
  $("menubtn").onclick = (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; };
  on(window, "click", () => { menu.hidden = true; });
  // (foo.board.json: the board's file, canonical JSON)
  const fileName = () => ((doc?.title ?? "board").replace(/[^\w-]+/g, "-").replace(/^-|-$/g, "").toLowerCase() || "board") + ".board.json";
  $("examples").onclick = async () => {
    const list = $("exlist");
    try {
      const ex = await host.examples!.list();
      list.replaceChildren(...ex.map((e) => {
        const a = document.createElement("a");
        a.href = e.href;
        if (e.current) a.className = "current";
        a.append(Object.assign(document.createElement("b"), { textContent: e.title }), Object.assign(document.createElement("span"), { textContent: e.about }));
        return a;
      }));
    } catch (e) {
      list.textContent = "The examples could not be loaded: " + String(e);
    }
    ($("exdlg") as HTMLDialogElement).showModal();
  };
  $("tidy").onclick = () => editor.commit((d) => { const p = pageOf(d, pageIx); Object.assign(p, tidy(p)); });
  // the language of the board's code (one per board): Python or Sage
  for (const b of root.querySelectorAll<HTMLButtonElement>("[data-sbb=lang] button")) {
    b.onclick = () => editor.commit((d) => { const m = b.dataset.mode; if (m === "sage" || m === "magma" || m === "matlab") d.mode = m; else delete d.mode; });
  }
  $("pgprev").onclick = () => page(pageIx - 1).catch(fail);
  $("pgnext").onclick = () => page(pageIx + 1).catch(fail);
  ($("pgsel") as HTMLSelectElement).onchange = (e) => { page(Number((e.target as HTMLSelectElement).value)).catch(fail); (e.target as HTMLElement).blur(); };
  // a document's own nodes, edges and tour become its first page
  const PAGE_KEYS = ["intro", "layout", "columns", "direction", "slide", "background", "nodes", "edges", "steps"] as const;
  function paged(d: BoardDoc): BoardPage[] {
    if (!d.pages?.length) {
      const p: any = { title: "Page 1" };
      for (const k of PAGE_KEYS) if (d[k] !== undefined) { p[k] = d[k]; delete d[k]; }
      p.nodes ??= [];
      d.pages = [p];
    }
    return d.pages!;
  }
  $("addpage").onclick = async () => {
    let n = 0;
    // (made from the template the page shown uses, or is)
    await editor.commit((d) => {
      const ps = paged(d), cur = ps[pageIx], uses = cur?.template ? cur.id : cur?.uses;
      ps.splice(pageIx + 1, 0, { title: `Page ${ps.length + 1}`, nodes: [], ...(uses ? { uses } : {}) });
      n = pageIx + 1;
    });
    await page(n);
    if (!editor.on) editBtn.click();
  };
  // Page…: the page's title (a board with pages), whether it is a slide,
  // its background color, a slide's picture; Done is one undo step
  const pgdlg = $("pgdlg") as HTMLDialogElement;
  let pend: { color?: string; image?: string; info?: { w: number; h: number } } = {};
  const swatches = $("pg-colors");
  for (const [name, c] of [["None", ""], ["White", "#ffffff"], ...COLORS] as [string, string][]) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "pg-c";
    b.title = name;
    b.setAttribute("aria-label", name);
    b.dataset.color = c;
    if (c) b.style.setProperty("--c", c);
    b.onclick = () => { pend.color = c || undefined; pgShow(); };
    swatches.append(b);
  }
  const pgShow = () => {
    const slide = ($("pg-slide") as HTMLInputElement).checked, tpl = ($("pg-template") as HTMLInputElement).checked;
    $("pg-uses-set").hidden = tpl || ($("pg-uses") as HTMLSelectElement).options.length < 2;
    for (const b of swatches.querySelectorAll<HTMLButtonElement>("button")) b.setAttribute("aria-pressed", String((b.dataset.color || undefined) === pend.color));
    $("pg-pic-set").hidden = !slide;
    $("pg-nopic").hidden = !pend.image;
    $("pg-pic-on").textContent = pend.image ? "a picture covers the card" : "";
  };
  $("pg-slide").onchange = $("pg-template").onchange = pgShow;
  $("pageprops").onclick = () => {
    if (!doc) return;
    const p = pageOf(doc, pageIx);
    $("pg-title-set").hidden = !doc.pages?.length;
    ($("pg-title") as HTMLInputElement).value = p.title ?? "";
    ($("pg-slide") as HTMLInputElement).checked = !!p.slide;
    // (templates: a board with pages; this page one, or made from one of the others)
    const paged = !!doc.pages?.length;
    $("pg-tpl-set").hidden = !paged;
    ($("pg-template") as HTMLInputElement).checked = paged && !!p.template;
    const uses = $("pg-uses") as HTMLSelectElement, tpls = paged ? doc.pages!.map((q, k) => [q, k] as const).filter(([q, k]) => q.template && q.id && k !== pageIx) : [];
    uses.replaceChildren(new Option("No template", ""), ...tpls.map(([q, k]) => new Option(q.title || `Page ${k + 1}`, q.id!)));
    uses.value = p.uses && tpls.some(([q]) => q.id === p.uses) ? p.uses : "";
    pend = { color: p.background?.color, image: p.background?.image };
    pgShow();
    pgdlg.showModal();
  };
  $("pg-pic").onclick = () => {
    const input = Object.assign(document.createElement("input"), { type: "file", accept: "image/png,image/jpeg,image/gif,image/webp" });
    input.className = "sb-fileinput";
    input.style.cssText = "position:fixed;left:-9999px";
    input.onchange = async () => {
      input.remove();
      const f = input.files?.[0], p = f && (await prepare(f));
      if (!p) return;
      pend.image = await images.put(p.blob);
      pend.info = { w: p.w, h: p.h };
      pgShow();
    };
    for (const old of document.querySelectorAll("input.sb-fileinput")) old.remove();
    document.body.append(input);
    input.click();
  };
  $("pg-nopic").onclick = () => { pend.image = undefined; pgShow(); };
  $("pg-go").onclick = async (e) => {
    e.preventDefault();
    pgdlg.close();
    const title = ($("pg-title") as HTMLInputElement).value.trim(), slide = ($("pg-slide") as HTMLInputElement).checked;
    const card = slide && !pageOf(doc!, pageIx).slide ? cardAround() : null;
    await editor.commit((d) => {
      const p = pageOf(d, pageIx);
      if (d.pages?.length) {
        p.title = title || undefined;
        const tpl = ($("pg-template") as HTMLInputElement).checked, uses = ($("pg-uses") as HTMLSelectElement).value;
        if (tpl) { p.template = true; p.id ??= "t" + Math.random().toString(36).slice(2, 8); delete p.uses; }
        else { delete p.template; if (uses) p.uses = uses; else delete p.uses; }
      }
      if (!slide) delete p.slide;
      else if (card) p.slide = card;
      const bg = { ...(pend.color ? { color: pend.color } : {}), ...(slide && pend.image ? { image: pend.image } : {}) };
      if (Object.keys(bg).length) p.background = bg;
      else delete p.background;
      if (slide && pend.image && pend.info) (d.images ??= {})[pend.image] = pend.info;
    });
  };
  // a new slide's card: 16:9, around what the page holds (or the view, on an empty page), with a margin
  function cardAround() {
    const b = board.bounds() ?? board.view(), m = Math.max(40, (b.x1 - b.x0) * 0.06);
    const bw = b.x1 - b.x0 + 2 * m, bh = b.y1 - b.y0 + 2 * m;
    const w = Math.round(Math.max(bw, (bh * 16) / 9)), h = Math.round((w * 9) / 16);
    return { x: Math.round((b.x0 + b.x1) / 2 - w / 2), y: Math.round((b.y0 + b.y1) / 2 - h / 2), w, h };
  }
  $("rmpage").onclick = async () => {
    const p = pageOf(doc!, pageIx);
    if (pageCount(doc!) < 2 || (p.nodes?.length && !confirm(`Delete the page “${p.title || "Page " + (pageIx + 1)}” and everything on it? (Undo brings it back.)`))) return;
    await editor.commit((d) => {
      d.pages!.splice(pageIx, 1);
      // (one page left: the document's own again)
      if (d.pages!.length === 1) { const [q] = d.pages!; delete d.pages; for (const k of PAGE_KEYS) if (q[k] !== undefined) (d as any)[k] = q[k]; }
    });
    await page(Math.min(pageIx, pageCount(doc!) - 1));
  };
  $("download").onclick = async () => {
    const a = document.createElement("a");
    // (with its pictures)
    a.href = URL.createObjectURL(new Blob([canonical(await images.inline(doc!))], { type: "application/json" }));
    a.download = fileName();
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  // Download JSON Canvas (canvas.ts): the board as it is laid out, each page
  // below the one before (a template's items on each page made from it, as
  // shown; CORR-00C-3); what a canvas has nothing like is said in the caption
  async function canvasText() {
    const d = await images.inline(doc!);
    const { canvas, left } = toCanvas(d, (i) => {
      const l = layout(pageView(d, i), measure), u = underlay(d, i, l, true);
      return { items: [...u.items, ...l.items], edges: [...u.edges, ...l.edges] };
    });
    return { text: JSON.stringify(canvas, null, "\t") + "\n", left: canvasLeftOut(left) };
  }
  $("canvas").onclick = async () => {
    if (!doc) return;
    try {
      const { text, left } = await canvasText();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([text], { type: "application/json" }));
      a.download = fileName().replace(/\.board\.json$/, ".canvas");
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      if (left) say(`Downloaded as JSON Canvas. Left out, as a canvas has nothing like them: ${left}.`);
    } catch (e) {
      fail(e);
    }
  };
  // Download as HTML: the board in one file (export.ts); a board with code
  // asks first whether the file carries Sagebrush (offline mode: every
  // language's runtime), and which version it runs
  const htmldlg = $("htmldlg") as HTMLDialogElement;
  // (the outputs it would carry, as they were when the dialog opened)
  let carried: CachedOutputs[] = [];
  $("html").onclick = async () => {
    if (!doc) return;
    if (!anyCode(doc)) return void downloadHtml(false);
    const size = host.exportPython?.(doc) ?? null;
    $("html-py-set").hidden = !size;
    ($("html-py") as HTMLInputElement).checked = false;
    $("html-size").textContent = size ? `(the file is about ${size} larger)` : "";
    carried = (await code?.carry().catch(() => [])) ?? [];
    const bytes = carried.reduce((s, e) => s + sizeOf(e.outputs), 0);
    $("html-out-set").hidden = !carried.length;
    ($("html-out") as HTMLInputElement).checked = true;
    $("html-out-size").textContent = `(${bytes < 1e6 ? `${Math.max(1, Math.round(bytes / 1e3))} kB` : `${(bytes / 1e6).toFixed(1)} MB`})`;
    for (const r of root.querySelectorAll<HTMLInputElement>("[data-sbb=htmlform] input[name=engine]")) r.checked = r.value === (doc.engine ?? "pinned");
    htmldlg.showModal();
  };
  $("html-go").onclick = async (e) => {
    e.preventDefault();
    const f = new FormData($("htmlform") as HTMLFormElement);
    htmldlg.close();
    // (which version it runs is the board's: kept in it)
    const use = f.get("engine") === "latest" ? "latest" : undefined;
    if (doc && use !== doc.engine) await editor.commit((d) => { if (use) d.engine = use; else delete d.engine; });
    // (the outputs as they are now: not as when the dialog opened, another board perhaps, CORR-2D0-1)
    await downloadHtml(f.get("python") === "on", f.get("outputs") === "on" && carried.length > 0);
  };
  /** The document to export and, with `outputs`, its slow items' outputs:
   * of the same moment, the notebook's code that of this document (else read
   * again), so a file never carries an output of code it doesn't have
   * (CORR-2D0-1, CORR-2BF-1). */
  async function toExport(outputs: boolean): Promise<{ d: BoardDoc; outputs: CachedOutputs[] }> {
    for (let i = 0; i < 5; i++) {
      const d = doc!;
      if (!outputs || !code) return { d, outputs: [] };
      const got = await code.carry({ mode: d.mode ?? "python", seed: d.seed, items: codeOrder(d) }).catch(() => []);
      if (got && doc === d) return { d, outputs: got };
      await new Promise((r) => setTimeout(r, 100));
    }
    return { d: doc!, outputs: [] };
  }
  async function downloadHtml(python: boolean, outputs = false) {
    if (!doc) return;
    try {
      const a = document.createElement("a");
      const x = await toExport(outputs);
      a.href = URL.createObjectURL(new Blob([await host.exportHtml!(await images.inline(x.d), { python, outputs: x.outputs })], { type: "text/html" }));
      a.download = fileName().replace(/\.board\.json$/, ".html");
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    } catch (e) {
      fail(e);
    }
  }
  // (what the host does not have is not offered: an exported file has no examples beside it)
  $("examples").hidden = !host.examples;
  $("html").hidden = !host.exportHtml;
  $("copyjson").onclick = async () => navigator.clipboard?.writeText(canonical(await images.inline(doc!)));
  async function openText(text: string, name?: string) {
    const d = boardFromText(text, name, (md) => { converted = md; });
    const bad = formatError(d);
    if (bad) throw new Error(bad);
    if (!isBoard(d)) throw new Error("not a board: a document needs nodes (or pages of them)");
    pageIx = 0;
    newOutputs(true);
    writtenHere = host.store?.writtenHere?.(false) ?? false;
    await editor.commit((cur) => { for (const k of Object.keys(cur)) delete (cur as any)[k]; Object.assign(cur, d); });
    board.focus(undefined, true);
    sayConverted();
  }
  // (a CoCalc board, converted: said in the caption, with what was left out,
  // until the next edit)
  let converted = "", notice = "";
  function sayConverted() {
    if (!converted) return;
    say(converted);
    converted = "";
  }
  /** A notice in the caption, until the next edit. */
  function say(md: string) {
    notice = md;
    $("tour").hidden = false;
    caption(notice, "");
  }
  const picker = $("openfile") as HTMLInputElement;
  $("open").onclick = () => picker.click();
  // (a file read while another document is loaded, by an agent or the
  // host: that one, newer, wins; the file, read too late, is not opened
  // over it)
  picker.onchange = async () => {
    const f = picker.files?.[0], g = loadGen;
    picker.value = "";
    if (!f) return;
    const text = await f.text().catch(fail);
    if (typeof text === "string" && g === loadGen && !destroyed) await openText(text, f.name).catch(fail);
  };
  // (files dropped on this board)
  on(root, "dragover", (e: DragEvent) => e.preventDefault());
  on(root, "drop", async (e: DragEvent) => {
    e.preventDefault();
    // pictures: added where they were dropped (in Edit); another file opens as a board
    const files = [...(e.dataTransfer?.files ?? [])];
    const pics = files.filter((f) => IMAGE_TYPES.test(f.type));
    if (pics.length) {
      if (!editor.on) editor.setOn(true);
      const w = board.toWorld(e.clientX, e.clientY);
      await editor.addImages(pics, w.x, w.y).catch(fail);
      return;
    }
    const f = files[0], g = loadGen;
    if (!f) return;
    const text = await f.text().catch(fail);
    if (typeof text === "string" && g === loadGen && !destroyed) await openText(text, f.name).catch(fail);
  });
  // Import Mermaid…: a flowchart pasted in
  const mmdlg = $("mmdlg") as HTMLDialogElement, mmtext = $("mmtext") as HTMLTextAreaElement;
  $("mermaid").onclick = () => { $("mmerr").textContent = ""; mmdlg.showModal(); mmtext.focus(); };
  $("mm-go").onclick = async (e) => {
    e.preventDefault();
    try {
      await openText(mmtext.value);
      mmdlg.close();
    } catch (err) {
      $("mmerr").textContent = String((err as Error)?.message ?? err);
    }
  };
  $("newboard").onclick = () => (newOutputs(true), (writtenHere = host.store?.writtenHere?.(true) ?? false), editor.commit((d) => {
    for (const k of Object.keys(d)) delete (d as any)[k];
    Object.assign(d, { title: "Untitled board", seed: [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, "0")).join(""), nodes: [] });
    pageIx = 0;
  })).then(() => { if (!editor.on) editBtn.click(); });
  $("revert").onclick = async () => {
    if (!original) return;
    pageIx = 0;
    newOutputs(true);
    writtenHere = host.store?.writtenHere?.(false) ?? false;
    await editor.commit((d) => { for (const k of Object.keys(d)) delete (d as any)[k]; Object.assign(d, JSON.parse(JSON.stringify(original))); });
    // (the original again: no edits of it are kept)
    host.store?.revert?.();
    board.focus(undefined, true);
  };
  // Print, or save as PDF: the sheets
  /** Sheets for printing: each page whole ("pages"), or each step of each
   * page's tour with its caption ("tour"; a page with no tour, whole). */
  function sheets(mode: "pages" | "tour" = "pages"): Sheet[] {
    const d = doc!, n = pageCount(d), out: Sheet[] = [];
    // (a template is no sheet of its own, unless all are; a page made from one has its items under its own)
    for (const i of shownPages(d)) {
      const v = pageView(d, i), own = layout(v, measure), under = underlay(d, i, own);
      const items = [...under.items, ...own.items], edges = [...under.edges, ...own.edges];
      const box = (ids?: string[]) => {
        const its = ids ? items.filter((it) => ids.includes(it.id)) : items;
        if (!its.length) return { x0: 0, y0: 0, x1: 400, y1: 300 };
        return { x0: Math.min(...its.map((it) => it.x)), y0: Math.min(...its.map((it) => it.y)), x1: Math.max(...its.map((it) => it.x + it.w)), y1: Math.max(...its.map((it) => it.y + it.h)) };
      };
      const title = d.pages?.length ? [d.title, pageOf(d, i).title || `Page ${i + 1}`].filter(Boolean).join(" — ") : d.title;
      // (a slide: its sheet is its card; and its backdrop under it all)
      const look = lookOf(d, i), sl = look.slide;
      const backdrop = sl || look.background ? { slide: sl, ...look.background } : undefined;
      const whole = sl ? { x0: sl.x, y0: sl.y, x1: sl.x + sl.w, y1: sl.y + sl.h } : box();
      const where = n > 1 ? `page ${i + 1} of ${n}` : "";
      const ss = mode === "tour" ? v.steps ?? [] : [];
      if (!ss.length || v.intro) out.push({ items, edges, box: whole, title, caption: mode === "tour" ? v.intro : undefined, folio: where, backdrop });
      ss.forEach((s, k) => out.push({ items, edges, box: box(typeof s.focus === "string" ? [s.focus] : s.focus), title, caption: s.say, folio: [where, `step ${k + 1} of ${ss.length}`].filter(Boolean).join(", "), backdrop }));
    }
    return out;
  }
  async function printBoard(o: PrintOptions & { mode?: "pages" | "tour"; dialog?: boolean } = {}) {
    if (!doc) return null;
    // (math typeset in sheets too)
    return printSheets(board, sheets(o.mode), { ...o, markdown: (s) => markdown(s, { pixels: docPixels, remote: writtenHere ? true : "click" }) });
  }
  const prdlg = $("prdlg") as HTMLDialogElement;
  $("print").onclick = () => {
    const d = doc!, tours = Array.from({ length: pageCount(d) }, (_, i) => pageView(d, i).steps?.length ?? 0).reduce((a, b) => a + b, 0);
    const n = pageCount(d);
    $("pr-pages-n").textContent = n > 1 ? `${n} pages, a sheet each` : "the whole board, on one sheet";
    ($("pr-tour") as HTMLInputElement).disabled = !tours;
    $("pr-tour-n").textContent = tours ? `${tours} steps, a sheet each with its caption (and a page's intro, with the whole page)` : "this board has no tour";
    if (!tours) ($("pr-pages") as HTMLInputElement).checked = true;
    prdlg.showModal();
  };
  $("pr-go").onclick = async (e) => {
    e.preventDefault();
    const f = new FormData($("prform") as HTMLFormElement);
    prdlg.close();
    await printBoard({ mode: f.get("mode") as "pages" | "tour", paper: f.get("paper") as "letter" | "a4", orientation: f.get("orient") as "landscape" | "portrait" });
  };
  // Present (⋯): a slideshow, the whole screen: each page (a slide's card,
  // fitted, the rest dark around it; or the page whole), then its tour's
  // steps, each step's words under it (not the page's intro: a slide's
  // speaker notes).  → Space PageDown next, ← PageUp back, Home End, Esc
  // leaves, the page, step and camera as they were.  Code items run as
  // ever: a slide is live.
  let presenting: { frames: { page: number; step: number }[]; i: number; fs?: boolean; asked?: boolean; was: { camera: Camera; page: number; at: number; editing: boolean; insets: typeof board.insets } } | null = null;
  let idle = 0;
  const prMask = $("pr-mask");
  async function present(on: boolean) {
    if (!doc || !!presenting === on) return;
    if (on) {
      const frames: { page: number; step: number }[] = [];
      // (a template is shown on the pages made from it, not on its own;
      // all templates: themselves, CORR-00C-2)
      for (const p of shownPages(doc)) {
        frames.push({ page: p, step: -1 });
        (pageView(doc, p).steps ?? []).forEach((_, k) => frames.push({ page: p, step: k }));
      }
      presenting = { frames, i: 0, was: { camera: { ...board.camera }, page: pageIx, at, editing: editor.on, insets: { ...board.insets } } };
      editor.setOn(false);
      root.classList.add("sbb-present");
      for (const id of ["pr-bar", "pr-say"]) $(id).hidden = false;
      presenting.asked = !!root.requestFullscreen;
      root.requestFullscreen?.().catch(() => {});
      board.onRender = placeMask;
      wake();
      // (where it was: the frame of the page and step shown)
      const i = frames.findIndex((f) => f.page === pageIx && f.step === Math.max(-1, at));
      await showFrame(Math.max(0, i));
    } else {
      const was = presenting!.was;
      presenting = null;
      presentGen++;
      board.onRender = null;
      root.classList.remove("sbb-present");
      for (const id of ["pr-bar", "pr-say", "pr-mask"]) $(id).hidden = true;
      if (document.fullscreenElement === root) document.exitFullscreen?.().catch(() => {});
      if (was.page !== pageIx) await page(was.page);
      step(was.at, true);
      board.insets = was.insets;
      board.setCamera(was.camera);
      if (was.editing) editor.setOn(true);
    }
  }
  // (each move, and leaving, is a new generation: a move whose page took
  // a while to draw, overtaken by a later one, then does nothing more)
  let presentGen = 0;
  async function showFrame(i: number, now = false) {
    const P = presenting, g = ++presentGen;
    if (!P || !doc) return;
    const k = Math.max(0, Math.min(P.frames.length - 1, i)), f = P.frames[k];
    if (f.page !== pageIx) {
      // (the page drawn, not its whole view: the frame says where the camera goes)
      editor.clear();
      pageIx = f.page;
      if (!(await redraw()) || g !== presentGen || presenting !== P || !doc) return;
    }
    P.i = k;
    const v = pageView(doc, pageIx), s = lookOf(doc, pageIx).slide, st = f.step >= 0 ? v.steps?.[f.step] : undefined;
    at = f.step;
    board.insets = { top: 0, right: 0, bottom: 0, left: 0 };
    // (a slide's card fills the screen one way, the rest dark: letterboxed)
    const W = board.el.clientWidth, H = board.el.clientHeight;
    let cam: Camera | null = null;
    if (st) {
      const ids = typeof st.focus === "string" ? [st.focus] : st.focus, b = board.bounds(ids);
      if (b) cam = board.cameraFor(b.x0, b.y0, b.x1, b.y1, 2);
    } else if (s) {
      const z = Math.min(W / s.w, H / s.h);
      cam = { x: s.x - (W / z - s.w) / 2, y: s.y - (H / z - s.h) / 2, z };
    } else {
      const b = board.bounds();
      if (b) cam = board.cameraFor(b.x0, b.y0, b.x1, b.y1);
    }
    prMask.hidden = !s;
    if (cam) { if (now) board.setCamera(cam); else board.flyTo(cam, 350); }
    const say = $("pr-say");
    say.innerHTML = st?.say ? markdown(st.say, { pixels: docPixels, remote: writtenHere ? true : "click" }) : "";
    if (st?.say && board.typeset && hasMath(st.say)) board.typeset(say);
    say.hidden = !st?.say;
    $("pr-where").textContent = `${P.i + 1} / ${P.frames.length}`;
    ($("pr-prev") as HTMLButtonElement).disabled = P.i <= 0;
    ($("pr-next") as HTMLButtonElement).disabled = P.i >= P.frames.length - 1;
  }
  // (the dark around a slide's card: where the card is on the screen, as the camera moves)
  function placeMask() {
    const s = doc && presenting ? lookOf(doc, pageIx).slide : undefined;
    if (!s) return;
    const c = board.camera;
    Object.assign(prMask.style, { left: (s.x - c.x) * c.z + "px", top: (s.y - c.y) * c.z + "px", width: s.w * c.z + "px", height: s.h * c.z + "px" });
  }
  // (the controls fade while the pointer is still)
  function wake() {
    root.classList.remove("sbb-idle");
    clearTimeout(idle);
    idle = window.setTimeout(() => root.classList.add("sbb-idle"), 2500);
  }
  $("present").onclick = () => present(true).catch(fail);
  $("pr-prev").onclick = () => showFrame((presenting?.i ?? 0) - 1).catch(fail);
  $("pr-next").onclick = () => showFrame((presenting?.i ?? 0) + 1).catch(fail);
  $("pr-exit").onclick = () => present(false).catch(fail);
  on(root, "pointermove", () => { if (presenting) wake(); });
  // (and with any pointer put down, a finger's tap too; a tap on a control
  // faded out only brings them back, it does not press it unseen)
  let woken = false;
  on(root, "pointerdown", (e: PointerEvent) => {
    if (!presenting) return;
    woken = root.classList.contains("sbb-idle") && !!(e.target as Element).closest?.("[data-sbb=pr-bar]");
    wake();
  }, true);
  on($("pr-bar"), "click", (e: MouseEvent) => { if (woken) { woken = false; e.preventDefault(); e.stopImmediatePropagation(); } }, true);
  // (the board's size changed: full screen, a phone turned: the frame fitted
  // again, once the board has its new size: a window's resize comes first,
  // and a camera fitted then is fitted to the old one)
  board.onResize = () => { if (presenting) showFrame(presenting.i, true).catch(fail); };
  // (leaving the full screen a presentation entered, by the browser's own Esc
  // say, leaves Present; an Esc that left Present itself has left full screen
  // too: nothing more happens; full screen granted once Present was left is left)
  on(document, "fullscreenchange", () => {
    const full = document.fullscreenElement === root;
    if (!presenting) { if (full) document.exitFullscreen?.().catch(() => {}); return; }
    // (one granted late, asked for by an earlier presentation, when this one could not ask: left)
    if (full && !presenting.asked) return void document.exitFullscreen?.().catch(() => {});
    if (full) presenting.fs = true;
    else if (presenting.fs) return void present(false).catch(fail);
    requestAnimationFrame(() => presenting && showFrame(presenting.i, true).catch(fail));
  });
  on(window, "keydown", (e: KeyboardEvent) => {
    if (!presenting || !mine() || e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.metaKey || e.ctrlKey || e.altKey) return;
    const i = presenting.i, k = e.key;
    if (k === "ArrowRight" || k === " " || k === "PageDown" || k === "Enter") showFrame(i + 1).catch(fail);
    else if (k === "ArrowLeft" || k === "PageUp" || k === "Backspace") showFrame(i - 1).catch(fail);
    else if (k === "Home") showFrame(0).catch(fail);
    else if (k === "End") showFrame(presenting.frames.length - 1).catch(fail);
    else if (k === "Escape") present(false).catch(fail);
    else return;
    e.preventDefault();
    e.stopImmediatePropagation();
  }, true);

  // (⌘P prints the sheets, not the screen)
  on(window, "keydown", (e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "p" && doc && mine()) { e.preventDefault(); $("print").click(); }
  });

  function outputs() {
    return doc ? codeOrder(doc).map(({ id, code: src }) => ({ id, code: src, state: code?.state(id) ?? "", output: code?.text(id) ?? "" })) : [];
  }

  // Measure frames while the camera moves along `path` (one camera per frame):
  // the intervals between frames and the time render() takes in each.
  async function bench(path: Camera[]) {
    const intervals: number[] = [], work: number[] = [];
    let last = performance.now();
    for (const c of path) {
      await new Promise<void>((r) => requestAnimationFrame(() => {
        const t0 = performance.now();
        board.setCamera(c);
        board.render();
        work.push(performance.now() - t0);
        intervals.push(t0 - last);
        last = t0;
        r();
      }));
    }
    const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(p * xs.length))];
    return {
      frames: path.length,
      interval: { p50: pct(intervals, 0.5), p95: pct(intervals, 0.95), max: Math.max(...intervals) },
      work: { p50: pct(work, 0.5), p95: pct(work, 0.95), max: Math.max(...work) },
      mounted: board.stats.mounted, mounts: board.stats.mounts, drawn: board.stats.drawn,
    };
  }
  // TimeTravel: the host's history (none: no TimeTravel), asked for the first
  // time it is needed: the first edit, or the menu's TimeTravel.
  let boardHistory: BoardTimeTravel | null = null;
  let historyReady: Promise<BoardTimeTravel | null> | null = null;
  // (the history before, being forgotten: the next one opens once it is)
  let historyGone: Promise<unknown> = Promise.resolve();
  // (each document shown its generation: an open finishing after another
  // document was shown is not the board's history; the one replacing it
  // records into it what was its, and closes it, CORR-CA3-2)
  let historyGen = 0, historyShut = false;
  function timeTravel(): Promise<BoardTimeTravel | null> {
    if (!host.history || historyShut) return Promise.resolve(null);
    if (historyReady) return historyReady;
    const g = historyGen;
    return (historyReady = historyGone.then(() => host.history!(docId)).then((h) => {
      if (g !== historyGen) return h;
      h?.on(() => { if (!$("tt").hidden) ttUpdate(); });
      return (boardHistory = h);
    }, (e) => {
      console.warn("board: TimeTravel:", e);
      return null;
    }));
  }
  // Another document is shown: its own history, opened when it is next
  // needed; the one before closed, and the versions of the document it
  // replaced (`forget`, its name) dropped, whether its history was opened
  // or not (CORR-F75-1: after a reload it is opened only when needed)
  function newHistory(forget?: string | null) {
    closeTimeTravel(false);
    const old = historyReady;
    historyGen++;
    historyReady = null;
    boardHistory = null;
    remembered = false;
    replaced = doc;
    // (the versions it was yet to record: the one before's, recorded there before it is closed)
    const pending = toRecord.splice(0);
    historyGone = Promise.all([historyGone, old?.then((h) => { if (h) for (const d of pending) h.record(d); h?.close?.(); })])
      .then(() => (forget !== undefined ? host.dropHistory?.(forget) : undefined))
      .catch((e) => console.warn("board: TimeTravel:", e));
  }
  // Keep the board as a version (and, the first time, the board as it was
  // before this change, if the history does not have it yet: not the
  // document it replaced, New board, Open…, Revert, which was another's).
  let remembered = false, replaced: BoardDoc | null = null;
  // (recorded once the edit is drawn, not before: a large board's version
  // is a moment's work, its first one, the whole board, longer; in order,
  // and at once when the history is read)
  let toRecord: BoardDoc[] = [], recordFrame = 0;
  function remember(prev?: BoardDoc | null) {
    if (!remembered && prev && prev !== replaced) toRecord.push(prev);
    remembered = true;
    if (doc) toRecord.push(doc);
    if (!recordFrame) recordFrame = requestAnimationFrame(() => setTimeout(() => { recordFrame = 0; if (toRecord.length) recordNow().catch((e) => console.warn("board: TimeTravel:", e)); }, 0));
  }
  // The versions waiting, recorded: taken with their history (the
  // document's as it is now) before anything is waited for (CORR-CA3-1)
  function recordNow(): Promise<BoardTimeTravel | null> {
    const list = toRecord.splice(0), ready = timeTravel();
    return ready.then((h) => { if (h) for (const d of list) h.record(d); return h; });
  }
  // (and when the page goes away or out of sight: recorded, CORR-CA3-3)
  const recordPending = () => { if (toRecord.length) recordNow().catch((e) => console.warn("board: TimeTravel:", e)); };
  on(window, "pagehide", recordPending);
  on(document, "visibilitychange", () => { if (document.visibilityState === "hidden") recordPending(); });
  // (the history of the document shown, its versions recorded; another shown meanwhile: its)
  async function currentHistory(): Promise<BoardTimeTravel | null> {
    for (;;) {
      const g = historyGen, h = await recordNow();
      if (g === historyGen) return h;
    }
  }
  // The bar: a slider over the versions (the newest at the right), when, Revert, ✕.
  let viewing: BoardDoc | null = null;
  let liveCode: Board["code"] = null;
  const slider = $("ttslider") as HTMLInputElement;
  async function openTimeTravel() {
    const g = historyGen;
    const h = await recordNow();
    // (another document shown meanwhile: nothing more, CORR-CA3-2)
    if (g !== historyGen || destroyed) return;
    if (!h || !doc) { fail(new Error("TimeTravel is not available here (it keeps its history in this browser's storage)")); return; }
    h.record(doc);
    remembered = true;
    editor.setOn(false);
    $("tour").hidden = true;
    $("tt").hidden = false;
    // (code is shown, not run: the live outputs are the board's as it is now)
    liveCode = board.code;
    board.setCode(null);
    slider.max = String(h.versions().length - 1);
    slider.value = slider.max;
    ttUpdate();
    slider.focus();
  }
  function ttUpdate() {
    const vs = boardHistory?.versions() ?? [];
    const atEnd = slider.value === slider.max;
    slider.max = String(Math.max(0, vs.length - 1));
    if (atEnd) slider.value = slider.max;
    const i = Number(slider.value), v = vs[i];
    if (!v) return;
    $("ttwhen").textContent = `Version ${i + 1} of ${vs.length} · ${new Date(v.ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}`;
    ($("ttrevert") as HTMLButtonElement).disabled = i === vs.length - 1;
    viewing = boardHistory!.docAt(v.time);
    redraw().catch(fail);
  }
  /** Close the bar: the board as it is again (`now`: drawn at once). */
  function closeTimeTravel(now = true) {
    if ($("tt").hidden) return;
    $("tt").hidden = true;
    viewing = null;
    if (liveCode) board.setCode(liveCode);
    liveCode = null;
    if (now) redraw().catch(fail);
  }
  let ttFrame = 0;
  slider.oninput = () => { if (!ttFrame) ttFrame = requestAnimationFrame(() => { ttFrame = 0; ttUpdate(); }); };
  $("timetravel").onclick = () => openTimeTravel();
  $("ttclose").onclick = () => closeTimeTravel();
  $("ttrevert").onclick = async () => {
    const v = viewing;
    if (!v) return;
    closeTimeTravel(false);
    // (an edit like any other: undoable, and a version itself; the toolbar's tools are a setting, left as they are)
    await editor.commit((d) => { const tools = d.tools; for (const k of Object.keys(d)) delete (d as any)[k]; Object.assign(d, JSON.parse(JSON.stringify(v))); if (tools) d.tools = tools; else delete d.tools; });
  };
  on(window, "keydown", (e: KeyboardEvent) => { if (e.key === "Escape" && !$("tt").hidden && mine()) { e.preventDefault(); e.stopImmediatePropagation(); closeTimeTravel(); } }, true);
  $("timetravel").hidden = !host.history;

  return {
    board,
    bench,
    /** Unmount: what is being written is kept first; then nothing of the
     * board is left (its listeners and effects, the code engine and its
     * interpreter, TimeTravel's history, its elements; its stylesheet with
     * the last board on the page). */
    async destroy() {
      // (first, at once: whatever is waiting draws nothing more, CORR-C08-1;
      // what is being written is still kept, saved though not drawn)
      destroyed = true;
      presenting = null;
      presentGen++;
      routingGen++;
      await editor.destroy();
      for (const f of offs.splice(0)) f();
      toolbar.destroy();
      pen.destroy();
      code?.close();
      code = null;
      // (the versions waiting, recorded first, CORR-CA3-3)
      cancelAnimationFrame(recordFrame);
      if (toRecord.length) await recordNow().catch((e) => console.warn("board: TimeTravel:", e));
      // (and the history closed, one still opening too, once it is: not the
      // board's, nor listened to, CORR-54B-1)
      historyShut = true;
      const last = historyReady;
      historyGen++;
      historyReady = null;
      boardHistory = null;
      last?.then((h) => h?.close?.(), () => {});
      cancelAnimationFrame(relayoutFrame);
      clearTimeout(idle);
      presenting = null;
      presentGen++; // (no more of Present's moves)
      cancelAnimationFrame(ttFrame);
      routingGen++; // (no more routing)
      board.destroy();
      // (what it put in the page: printed sheets, a file chooser left open)
      document.getElementById("board-print")?.remove();
      for (const i of document.querySelectorAll("input.sb-fileinput")) i.remove();
      root.replaceChildren();
      root.classList.remove("sbb");
      if (--mounted === 0) document.querySelector("style[data-sbb-css]")?.remove();
    },
    agent: {
      /** Show a board document (see web/board/doc.ts); resolves when it is laid out. */
      load,
      /** Fly to these item ids (all items when none). */
      focus: (ids?: string[]) => board.focus(ids),
      /** Go to step n of the tour (0-based; -1 for the whole board). */
      step,
      /** A Mermaid flowchart (or Markdown with some) as a board document, to load(), or to edit first. */
      fromMermaid: (text: string) => boardFromText(text),
      /** The board as one self-contained HTML file (its text); with `outputs`, carrying its slow items' outputs. */
      exportHtml: async (o?: { python?: boolean; outputs?: boolean }) => {
        const x = await toExport(!!o?.outputs);
        return host.exportHtml!(await images.inline(x.d), { python: o?.python, outputs: x.outputs });
      },
      /** the document as a file carries it: with its pictures (data: URLs) */
      portable: () => images.inline(doc!),
      /** the board's file (foo.board.json), as Download JSON writes it */
      json: async () => canonical(await images.inline(doc!)),
      /** the board as a JSON Canvas (Download JSON Canvas), and what that left out, in words */
      canvas: () => canvasText(),
      /** the page shown as a Mermaid flowchart (with `all`, every page, as Markdown), and what that left out, in words */
      mermaid: (o?: { all?: boolean }) => (doc ? (o?.all ? toMermaidMarkdown(doc) : toMermaid(doc, pageIx)) : null),
      /** Code items slower than this from root (ms; default 10 s) keep a preview of their output in the document (design/outputs.md). */
      setPreviewThreshold(ms: number) { const c = engine(); if (c && Number.isFinite(ms) && ms >= 0) c.previewMs = ms; },
      /** each code item's output key, time from root, and whether a widget moved since it ran (design/outputs.md) */
      outputKeys: async () => (await engine()?.outputKeys()) ?? null,
      /** Show page n (0-based). */
      page,
      /** Lay out the sheets to print (mode "pages" or "tour"; paper "letter" or "a4"; orientation) and open the print dialog, unless dialog: false. */
      /** Present (a slideshow): on or off; the frame shown, and how many */
      present: async (on = true) => { await present(on); return presenting ? { frame: presenting.i, of: presenting.frames.length } : null; },
      print: async (o: PrintOptions & { mode?: "pages" | "tour"; dialog?: boolean } = {}) => { const r = await printBoard(o); return r?.querySelectorAll(".pr-sheet").length ?? 0; },
      /** The document, the tour's step, the camera, and the laid out items' boxes. */
      snapshot: () => ({ doc, page: pageIx, pages: doc ? pageCount(doc) : 0, step: at, camera: board.camera, view: board.view(), items: placed, routed, edges: board.edgeList().map(({ id, from, to, points, label, lx, ly, src }) => ({ id, from, to, points, label, lx, ly, src })), selectedEdge: board.selectedEdge }),
      /** Change the document (undoable, as an edit): f gets a copy to modify. */
      edit: (f: (d: BoardDoc) => void) => editor.commit(f),
      /** Run code items (all when none are given), then what depends on them; resolves to outputs(). */
      run: async (ids?: string[]) => {
        const c = engine();
        if (c) { await c.idle(); await (ids ? c.run(ids) : c.runAll()); }
        return outputs();
      },
      /** Code items in reading order: their state ("" when up to date, or queued, running, stale, error, cancelled) and output as text, after what was asked for has run. */
      outputs: async () => { await code?.idle(); return outputs(); },
      /** Turn Edit mode on or off. */
      editing: (on: boolean) => editor.setOn(on),
      /** TimeTravel: the versions kept in this browser, oldest first ({index, ms}). */
      versions: async () => (await currentHistory())?.versions().map(({ index, ms }) => ({ index, ms })) ?? [],
      /** The board at version i (a document, as load() takes it). */
      version: async (i: number) => { const h = await currentHistory(), v = h?.versions()[i]; return v ? h!.docAt(v.time) : null; },
    },
  };
}
