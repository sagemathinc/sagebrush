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
import { Board, type Camera, type CodeHost, type Edge, type Item, plainTitle } from "./board";
import { renderFileMenu, fileMenuKey } from "../workspace/filemenu";
import { boardFileText } from "../workspace/file-bytes";
import { answered, asksOf, ASK_LIMITS } from "./ask";
import { uuid, type AnswerChannel } from "./channel";
import { setOwn, boardLink, layout, isBoard, isNote, type AskAnswer, type DocAsk, formatError, pageCount, pageOf, pageView, codeOrder, type CodeCell, cleanDoc, anyCode, canonical, templateOf, lookOf, shownPages, type BoardDoc, type BoardPage, type MeasuredNote, type DocNode, type DocNote, type BoardMode } from "./doc";
import type { BoardCode, Evaluated } from "./code";
import type { DocEntry } from "../docsearch";
import { BoardCodes } from "./codes";
import { overCap, sameOutputs } from "./preview";
import { sizeOf, type CachedOutputs, type OutputCache } from "./outcache";
import { PixelBudget } from "../image-size";
import { loadRemotePicture } from "../safe-html";
import { Toolbar, defaultTools } from "./toolbar";
import { PenRow } from "./pen";
import { effect } from "@preact/signals-core";
import { Editor, tidy } from "./edit";
import { findIndex, findIn, textRanges, type FindEntry } from "./find";
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
  /** Whether Edit is offered (`hidden`: not at all) and allowed now (not: left, with `why` said), as it
   * changes, the current state at once.  None: always.  Returns: stop. */
  editing?(f: (s: { allowed: boolean; hidden?: boolean; why?: string }) => void): () => void;
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
  /** an interpreter for a language (a board's items may be in several: codes.ts) */
  code?: (d: BoardDoc, mode: BoardMode) => BoardCode;
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
  /** which Sagebrush runs this board's code: the site's version, its build (as
   * `sagebrush --version` says it) and its engine; or only the engine (round 0's 17) */
  version?: () => Promise<BoardVersion | null>;
  /** where slow code items' outputs are kept between visits (outcache.ts; design/outputs.md) */
  outputs?: OutputCache;
  /** the board as one HTML file (Download as HTML); with `python`, the file
   * carries the code's engine, so its code runs without the network; with
   * `outputs`, the slow items' outputs computed here (BoardCode.carry()) */
  exportHtml?(d: BoardDoc, o?: { python?: boolean; outputs?: CachedOutputs[] }): Promise<string>;
  /** whether Ctrl/Cmd+S downloads the board as HTML (default); false: the
   * key is left to the browser, as on a page that is itself a saved board
   * (an exported file), whose ⋯ menu still downloads it again */
  saveKey?: boolean;
  /** whether exportHtml can carry the engine, and about how much more that is ("6 MB") */
  exportPython?(d: BoardDoc): string | null;
  /** New board: a new board of its own, in this language, opened in this
   * one's place (this one stays as it is); none: this board emptied, as an
   * edit (Undo brings it back).  Throws, saying why, if it can't be kept
   * (this board then stays) */
  newBoard?(mode: string): void | Promise<void>;
  /** Duplicate: a copy of this board as a board of its own, opened in its place; none: no Duplicate.  Throws as newBoard does */
  duplicate?(d: BoardDoc): void | Promise<void>;
  /** The File menu's items that need the host's files (web/workspace/filemenu.ts): a new notebook or
   * folder, Open… (the file browser as a dialog), Recent, and Delete (this board to Trash); none: disabled */
  /** A board brought in from a file (an upload, a drop, Open as…): its code doesn't run until the person
   * presses "Run this board's code" (an interim, until design/capabilities.md's gate); `codeResumed` when they do. */
  codePaused?: boolean;
  codeResumed?(): void;
  /** Sagebrush's own board page: the File menu shows what the host can't do here disabled
   * (design/workspace-files.md §3); otherwise (the library in another site) it is hidden */
  fullFileMenu?: boolean;
  files?: {
    newNotebook?(mode: string): void | Promise<void>;
    newFolder?(): void | Promise<void>;
    open?(): void;
    recent?(): Promise<{ label: string; title?: string; open: () => void }[]>;
    delete?(): void | Promise<void>;
    /** Upload… and files dropped on the board (not pictures), in `mode` (the board's): the rule of
     * design §3 (workspace/upload.ts); what to say, if anything.  None: a file opens in this board, as before. */
    upload?(files: File[], mode: string): Promise<string | void>;
  };
  /** whether a board with nothing in it opens in Edit (default); false: as any other (an exported file, a frame's) */
  editBlank?: boolean;
  /** the function search's index of a language (web/docsearch.ts), shown
   * beside a code item being written; none (or null for a language): no search */
  docs?: (lang: string) => Promise<DocEntry[] | null>;
  /** where the reader's answers go (web/board-host-protocol.md: a frame's
   * channel to its host): a page with questions then has Submit, and a
   * question with `decide`, "Get feedback on my words".  Read once the board
   * is loaded (a frame's channel comes with its board) */
  answers?: AnswerChannel | null;
}

// (its stylesheet, once a page, first: the page's own rules win; it goes
// with the last board unmounted)
// Find's marked words: one highlight for the page ("sb-find", board.css),
// made of every mounted board's own ranges, so that two boards don't take
// each other's, and a board destroyed takes only its own (CORR-8CE-2)
const findRanges = new Map<object, Range[]>();
function setFindRanges(owner: object, ranges: Range[] | null) {
  const reg = (CSS as any).highlights, H = (globalThis as any).Highlight;
  if (ranges?.length) findRanges.set(owner, ranges);
  else findRanges.delete(owner);
  if (!reg || !H) return;
  const all = [...findRanges.values()].flat();
  if (all.length) reg.set("sb-find", new H(...all));
  else reg.delete("sb-find");
}

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
// (the toolbar's Code: a note with code in the board's language)
const LANGUAGE_NAMES: Record<string, string> = { python: "Python", sage: "Sage", magma: "Magma", matlab: "MATLAB" };
const codeTitle = (mode: string) => `Add a note with ${LANGUAGE_NAMES[mode] ?? "Python"} code (any note can have code: + Code in its editor)`;
const CHROME = `<div data-sbb="top"><a data-sbb="home" href="/">Sagebrush</a><span data-sbb="title"></span><button data-sbb="runpaused" hidden title="This board came from a file you brought in: its code hasn't run yet">▶ Run this board's code</button><span data-sbb="pages" hidden><button data-sbb="pgprev" title="Previous page (PageUp)" aria-label="Previous page">‹</button><select data-sbb="pgsel" title="Page"></select><button data-sbb="pgnext" title="Next page (PageDown)" aria-label="Next page">›</button></span><button data-sbb="submitbtn" hidden title="Send your answers to whoever made this board" aria-haspopup="dialog">Submit</button><button data-sbb="help" title="Help: what the keys and gestures do (?)" aria-label="Help">?</button><button data-sbb="edit" aria-pressed="false" aria-label="Edit" title="Move, write, add and connect notes">✎<span class="lbl"> Edit</span></button><button data-sbb="fit" title="Show everything (0)" aria-label="Show everything">⤢</button><span class="menuwrap"><button data-sbb="filebtn" title="New, open, download" aria-haspopup="menu">File<span class="caret"> ▾</span></button><div data-sbb="filemenu" class="menu" role="menu" aria-label="File" hidden></div></span><span class="menuwrap"><button data-sbb="menubtn" title="Pages, layout, language, Present, TimeTravel" aria-label="More" aria-haspopup="menu">⋯</button><div data-sbb="menu" class="menu" hidden><button data-sbb="addpage">Add a page</button><button data-sbb="pageprops">Page…</button><button data-sbb="rmpage" hidden>Delete this page</button><button data-sbb="tidy">Tidy (automatic layout)</button><button data-sbb="mermaid">Import Mermaid…</button><button data-sbb="revert" hidden>Revert to the original</button><div data-sbb="lang" role="group" aria-label="The language of this board's code">Code: <button data-mode="python" aria-pressed="true">Python</button><button data-mode="sage" aria-pressed="false">Sage</button><button data-mode="magma" aria-pressed="false">Magma</button><button data-mode="matlab" aria-pressed="false">MATLAB</button></div><hr><button data-sbb="present">Present (a slideshow)</button><button data-sbb="timetravel">TimeTravel…</button><button data-sbb="term" hidden title="A bash shell on your workspace's files">Terminal</button><div data-sbb="ver" class="ver" hidden></div><hr><button data-sbb="helpitem">Help: keys and gestures…</button></div></span><input data-sbb="openfile" type="file" accept=".json,.html,.htm,.canvas,.mmd,.mermaid,.md,.board,.slides,application/json,text/html,text/markdown,text/plain" hidden></div>
<div data-sbb="pr-mask" hidden></div><div data-sbb="pr-say" hidden></div><div data-sbb="pr-bar" hidden><button data-sbb="pr-prev" title="Back (←)" aria-label="Back">‹</button><span data-sbb="pr-where"></span><button data-sbb="pr-next" title="Next (→, Space)" aria-label="Next">›</button><button data-sbb="pr-exit" title="Stop (Esc)" aria-label="Stop presenting">✕</button></div>
<div data-sbb="tour" hidden><div data-sbb="say"></div><div data-sbb="nav"><div><button data-sbb="prev" title="Back (←)" aria-label="Back" disabled>←</button><button data-sbb="next" title="Next (→)" aria-label="Next">→</button></div><span data-sbb="where"></span></div></div>
<div data-sbb="find" hidden role="search" aria-label="Find in this board"><input data-sbb="findq" type="text" placeholder="Find in this board" aria-label="Find in this board" spellcheck="false" autocomplete="off"><span data-sbb="findn" aria-live="polite"></span><button data-sbb="findprev" title="Previous (Shift+Enter)" aria-label="Previous match">↑</button><button data-sbb="findnext" title="Next (Enter)" aria-label="Next match">↓</button><button data-sbb="findx" title="Close (Esc)" aria-label="Close Find">✕</button></div>
<div data-sbb="submit" hidden role="dialog" aria-label="Submit your answers"><div data-sbb="subhead"></div><label data-sbb="sublabel">A comment for whoever made this board (optional; math in $…$ is typeset)<textarea data-sbb="subcomment" rows="3" placeholder="Anything to add?"></textarea></label><div data-sbb="subpreview" class="board-text" hidden></div><div data-sbb="subrow"><button data-sbb="subsend">Send</button><button data-sbb="subclose">Close</button></div><div data-sbb="substatus" class="board-text" role="status" aria-live="polite"></div></div>
<div data-sbb="tt" hidden role="group" aria-label="TimeTravel"><input type="range" data-sbb="ttslider" min="0" max="0" value="0" aria-label="Version"><span data-sbb="ttwhen"></span><button data-sbb="ttrevert" title="Make the board this version again (undo takes it back)">Revert</button><button data-sbb="ttclose" title="Close (Esc): the board as it is" aria-label="Close">✕</button></div>
<dialog data-sbb="helpdlg" aria-label="Using a board"><h3>Using a board</h3>
<h4>Looking</h4><ul>
<li><kbd>→</kbd> or <kbd>Space</kbd>, <kbd>←</kbd>: the tour's next and previous step; <kbd>Esc</kbd>: the board as it opens; <kbd>0</kbd>: all of it, however small</li>
<li>Drag the background to move about; <kbd>+</kbd> <kbd>−</kbd>, Ctrl and the wheel, or two fingers to zoom</li>
<li><kbd>PageDown</kbd> <kbd>PageUp</kbd>: the next and previous page</li>
<li><kbd>Ctrl</kbd>+<kbd>F</kbd> (<kbd>⌘</kbd><kbd>F</kbd>): find words in the board</li>
</ul>
<h4>Editing (✎ Edit)</h4><ul>
<li>Drag an item to move it, into a group or out of one</li>
<li>Double-click an item to write in it; the background, to add a note there; an edge, to label it</li>
<li>Shift-drag from one note to another to connect them</li>
<li>Shift-click to select several, or shift-drag a rectangle over the background; <kbd>Ctrl</kbd>+<kbd>A</kbd>: everything</li>
<li>The arrow keys move what is selected (with Shift, ten at a time); <kbd>Delete</kbd> removes it; <kbd>Enter</kbd> writes in it</li>
<li>A code item's <kbd>Shift</kbd>+<kbd>Enter</kbd> runs it, and what depends on it</li>
<li><kbd>Ctrl</kbd>+<kbd>Z</kbd> (<kbd>⌘</kbd><kbd>Z</kbd>) undoes; with Shift, redoes</li>
</ul>
<h4>More</h4><ul>
<li><a href="https://sagebrush.space/board-format.md" target="_blank" rel="noopener">The board format</a>: what a board's file holds, for people and agents writing one</li>
<li><a href="https://sagebrush.space/articles/notebook/01-how-cells-run" target="_blank" rel="noopener">How cells run</a>: a board's code items run as a notebook's cells do</li>
<li><a href="https://sagebrush.space/articles/" target="_blank" rel="noopener">All the articles</a></li>
</ul>
<form method="dialog"><button>Close</button></form></dialog>
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

/** Which Sagebrush a board's code runs with (/version.json, as `sagebrush --version`). */
export interface BoardVersion { version?: string; build?: string; engine?: string }
/** The largest file Open… or a drop reads: well past a board downloaded as
 * HTML with every language's engine in it (about 10 MB) and its pictures
 * (CoCalc shows boards of up to 16 MB). */
export const FILE_MAX = 128 * 2 ** 20;

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
        else if (isNote(n) && n.code !== undefined) on.set(n.id, n);
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
// (code shown as text, its language's highlighter not loaded yet)
const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
function withPreviews(d: BoardDoc, order: CodeCell[], byPage: Set<string>) {
  const notes = codeNotes(d);
  return order.map(({ id, code, item, mode }) => { const p = id === item && !byPage.has(item) ? notes.get(id)?.preview : undefined; return p ? { id, code, mode, preview: p } : { id, code, mode }; });
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
  // (code paused until the person runs it: a board brought in from a file, host.codePaused)
  let paused = !!host.codePaused;
  // The one File menu, as the notebook's (design/workspace-files.md §3):
  // drawn by filemenu.ts with this board's keys; what isn't here, disabled
  renderFileMenu($("filemenu"), {
    attr: "data-sbb",
    keys: { newNotebook: "newnotebook", newBoard: "newboard", newFolder: "newfolder", fromExample: "examples", open: "openfiles", upload: "open", saveCopy: "duplicate", rename: "rename", print: "print", share: "share", delete: "deleteboard" },
    disabled: {
      newNotebook: !host.files?.newNotebook, newFolder: !host.files?.newFolder, fromExample: !host.examples, open: !host.files?.open,
      saveCopy: !host.duplicate, share: true, delete: !host.files?.delete,
    },
    downloads: [
      { key: "download", label: ".board.json" },
      { key: "html", label: "HTML (one file)", disabled: !host.exportHtml },
      { key: "canvas", label: "JSON Canvas" },
      { key: "copyjson", label: "Copy JSON" },
    ],
    recent: host.files?.recent,
    // (Sagebrush's board page shows what it can't do here disabled; a board
    // in another site's page offers only what its host gives)
    hideDisabled: !host.fullFileMenu,
    chosen: () => { $("filemenu").hidden = true; },
  });
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
  // (and none of its dialogs open, Help, Print…: that one has the keys, the
  // board's shortcuts waiting until it closes, and Esc is the browser's,
  // closing it; astra's UI-D74-1)
  const mine = () => active(root) && !root.querySelector("dialog[open]");
  let doc: BoardDoc | null = null;
  // (a code item on the page shown: its cell's id, codeOrder's)
  let cellOf = new Map<string, string>();
  const cell = (id: string) => cellOf.get(id) ?? id;
  // (items that were cells by their page since the board was loaded: withPreviews)
  const byPage = new Set<string>();
  let at = -1; // the tour's step; -1 before it starts
  let pageIx = 0, shownPage = -1; // the page shown
  let pageGen = 0; // page()'s: only the page asked for last starts its tour
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
  // (the checks running, by question: any version of the document whose
  // answer to it is another than the one checked makes theirs stale, even
  // if a later one puts the first value back, CORR-A19-4)
  const checking = new Map<string, { given: string; stale: boolean }>();
  // (the last submission of the Submit bar: its id, what it sent, and how
  // it stands; and the answers given being kept, which a press awaits)
  type Sent = { id: string; key: string; state: "sending" | "late" | "received" | "refused"; message?: string };
  let sub: Sent | null = null;
  let answering: Promise<unknown> = Promise.resolve();
  // (each decision's question as it was asked: its page, its id and askSig then)
  // (`choice`: Something else, the reader's own words chosen, bound to the
  // question as defined (its page and all of it but the reader's answers),
  // not to their words: astra's CORR-E29-2, CORR-548-1)
  const decidedSigs = new Map<string, { page: number; id: string; sig: string | null; choice?: boolean }>();
  // (each Check's question as it was checked, the same way: its page's
  // identity and the question's definition; done, its answer and verdict
  // too; one entry for each key, its own object, CORR-F11-1)
  type CheckSig = { page: number; id: string; sig: string | null; done: boolean };
  const checkSigs = new Map<string, CheckSig>();
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
  // (why the last save of what was written failed; null once one is kept)
  let unkept: unknown = null;
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
  // (the board's language, as the toolbar's Code says it)
  let codeMode = "python";
  async function show(d: BoardDoc, view = false): Promise<boolean> {
    const g = loadGen, over = () => destroyed || g !== loadGen;
    if (over()) return false;
    // (another document than the one shown, during a drag or resize: the
    // gesture dropped, nothing of it kept in this one, CORR-59E-1; the same
    // one laid out again waits for its release, below)
    const replacing = !view && d !== doc;
    // (the document shown, drawn again (a relayout, a refit): if another is
    // shown meanwhile, an edit's while this one awaited its pictures, this
    // one stands down, or it would put the older document back)
    const again = !view ? doc : null;
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
    if (!view && !replacing && doc !== again) return false;
    if (!view) {
      // (each decision, pending or done, kept only while its page's
      // question, as defined, has the words it was asked about: any other
      // document (an edit, the API's, Undo, Redo) that changes them, or
      // removes it, drops it, so that changing them back doesn't bring it
      // back either, CORR-B21-1)
      for (const [key, was] of decidedSigs) if ((was.choice ? checkSig(d, was.page, was.id, false) : askSig(d, was.page, was.id)) !== was.sig) { decidedSigs.delete(key); board.askDecided.delete(key); }
      // (and each Check's, pending or done: another page at its place (the pages reordered), or its question changed, drops it, CORR-F11-1)
      for (const [key, was] of checkSigs) if (checkSig(d, was.page, was.id, was.done) !== was.sig) { checkSigs.delete(key); board.askFeedback.delete(key); }
      if (checking.size) {
        // (another version of the board's code: every check running is for the code before, CORR-729-1)
        const codeKey = (x: BoardDoc | null) => (x ? JSON.stringify([x.mode ?? null, x.seed ?? null, codeOrder(x).map((c) => [c.id, c.mode, c.code])]) : "");
        if (codeKey(doc) !== codeKey(d)) for (const run of checking.values()) run.stale = true;
        // (each question by its page and id: an id is its page's own)
        const was = new Map(doc ? asksOf(doc).map((q) => [askKey(q.page, q.ask.id), JSON.stringify(q.ask.answer ?? null)]) : []);
        for (const q of asksOf(d)) {
          const k = askKey(q.page, q.ask.id), run = checking.get(k), now = JSON.stringify(q.ask.answer ?? null);
          if (run && now !== was.get(k) && now !== run.given) run.stale = true;
        }
      }
      doc = d;
    }
    board.onDecide = host.answers && !view ? decideWords : null;
    pageIx = Math.max(0, Math.min(pageCount(d) - 1, pageIx));
    board.askScope = askKey(pageIx + 1, "");
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
    // (a board brought in from a file: its code waits for the person's "Run this board's code")
    if (paused) $("runpaused").hidden = !order.length;
    else if (!view && (order.length || code)) engine()?.sync(withPreviews(d, order, byPage), d.mode ?? "python", d.seed).catch((e) => console.warn("board: code items:", e));
    for (const b of root.querySelectorAll<HTMLButtonElement>("[data-sbb=lang] button")) b.setAttribute("aria-pressed", String(b.dataset.mode === (d.mode ?? "python")));
    // (the toolbar's Code: the board's language; its tool's title reads it
    // when the toolbar's menu is drawn, UI-231-1, and what is drawn already,
    // the button and an open menu's row (on document.body), is told now)
    codeMode = d.mode ?? "python";
    for (const el of root.querySelectorAll<HTMLElement>(".board-toolbar [data-tool=code][data-tip]")) el.dataset.tip = codeTitle(codeMode);
    for (const el of [...root.querySelectorAll<HTMLElement>("[data-tool=code][title]"), ...document.querySelectorAll<HTMLElement>(".board-toolbar-panel [data-tool=code][title]")]) el.title = codeTitle(codeMode);
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
    // (only when they are other tools: a new list each drawing rebuilt the
    // toolbar's buttons under the pointer, so "⋯" flickered as it was hovered)
    const tools = d.tools ?? defaultTools();
    if (JSON.stringify(tools) !== JSON.stringify(toolbar.tools.value)) toolbar.tools.value = tools;
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
    // (and on a board of pages, always: its arrows go on to the next page, UI-118-2)
    $("tour").hidden = view || (!v.steps?.length && !v.intro && !notice && pageCount(d) < 2);
    if (notice && !view && !v.steps?.length && !v.intro) caption(notice, "");
    pageBar();
    // (compared with the original as it is shown: cleaned, so that its keys'
    // order, or the format's name and version added, are no edit)
    if (original && originalKey?.[0] !== original) originalKey = [original, shownKey(cleanDoc(original))];
    $("revert").hidden = view || !original || originalKey![1] === shownKey(d);
    submitBar();
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
  // (a question answered with its controls: kept in the document, as any
  // change; not in a version being looked at, which is not the document)
  const answer = (id: string, patch: { answer?: AskAnswer | null; note?: string | null }) => {
    if (viewing) return;
    // (what the host decided was of the words before: gone with them)
    // (pending too: its answer, when it comes, is to words no longer there, and dropped, CORR-B21-1)
    // (but "Something else", the reader's own words chosen, stands as they write them)
    if ("note" in patch || askOn(pageIx + 1, id)?.input === "text") {
      const k = askKey(pageIx + 1, id);
      // (its signature, the question's, kept with it)
      if (board.askDecided.get(k)?.chosen === "") board.askDecided.set(k, { chosen: "" });
      else { board.askDecided.delete(k); decidedSigs.delete(k); }
    }
    answering = editor.answer(id, patch).catch(fail);
  };
  board.onAnswer = answer;
  // (a question's answer checked: its check run in the board's interpreter,
  // with a deadline; the verdict kept with the answer, the check's words and
  // the hints shown so far only here.  One Check runs alone in its
  // language's interpreter, no sync, run or other Check between its steps:
  // the board's code run again in a new interpreter if anything was
  // evaluated there since it last was; then the check; then, before each
  // computed hint, the code run again, so the hint sees the state the code
  // leaves, not the check's; and once more at the end, so that what runs
  // next does too (the coordinator's rule for CORR-A19-1).  Each step is
  // bounded: a run of the code REFRESH_MS, the check checkMs, and the
  // computed hints, with the runs before them, share 2 x checkMs, at most
  // 20 s (HARD-A19-1, HARD-729-1).)
  const REFRESH_MS = 60_000;
  // (the languages where something was evaluated since the board's code last ran in a new interpreter)
  const dirty = new Set<BoardMode>();
  const check = async (id: string, given: AskAnswer) => {
    // (the question of the page shown, by its page and id: another page may have a question of that id, CORR-B21-2's sibling)
    const page = pageIx + 1, key = askKey(page, id);
    const c = engine(), a = askOn(page, id);
    if (viewing || !c || !a?.check) return;
    const mode: BoardMode = doc!.mode ?? "python", ms = a.checkMs ?? 2000, test = a.check;
    // (what it ran on: a completion for another document, another engine, or
    // a question whose answer or check changed meanwhile is dropped, CORR-A19-4)
    // (the field checked may be saved meanwhile, as it loses its focus: that answer is the one checked, not another)
    // (and the board's code it ran with: a result for code since changed, as an edit, is dropped too, CORR-729-1)
    const codeOf = (d: BoardDoc | null) => (d ? JSON.stringify([d.mode ?? null, d.seed ?? null, codeOrder(d).map((x) => [x.id, x.mode, x.code])]) : "");
    const loaded = loads, was = JSON.stringify(a.answer ?? null), checked = JSON.stringify(given), ranWith = codeOf(doc);
    const run = { given: checked, stale: false };
    checking.set(key, run);
    const stale = () => {
      const now = askOn(page, id), ans = JSON.stringify(now?.answer ?? null);
      return run.stale || checkSigs.get(key) !== mine || loads !== loaded || code !== c || !!viewing || !now || now.check !== a.check || (ans !== was && ans !== checked) || codeOf(doc) !== ranWith;
    };
    board.askFeedback.set(key, { pending: true });
    const mine: CheckSig = { page, id, sig: checkSig(doc!, page, id, false), done: false };
    checkSigs.set(key, mine);
    redraw().catch(fail);
    const done = await c.exclusive(mode, async (ops) => {
      const reset = async (within: number) => {
        if (!dirty.has(mode)) return true;
        const ok = within > 0 && (await ops.refresh(Math.min(REFRESH_MS, within)));
        if (ok) dirty.delete(mode);
        return ok;
      };
      const evaluate = (code: string, within: number, by?: number) => { dirty.add(mode); return ops.evaluate(code, given, within, by); };
      const r: Evaluated = (await reset(REFRESH_MS)) ? await evaluate(test, ms) : { ok: false, error: `the board's code didn't finish running again within ${REFRESH_MS / 1000} s, so it wasn't checked` };
      const outcome = !r.ok ? "error" : r.value === true ? "right" : "wrong";
      const message = !r.ok ? (r.undecided ? "The check could not decide: " : "The check failed: ") + (r.error ?? "it could not run") : typeof r.value === "string" ? r.value : null;
      // (the hints shown after this attempt: the computed ones computed now, with the same answer)
      const until = Date.now() + Math.min(2 * ms, 20_000), left = () => Math.min(ms, until - Date.now());
      const wrong = (a.wrongAttempts ?? 0) + (outcome === "wrong" ? 1 : 0);
      const hints: (string | null)[] = [];
      for (const [k, h] of (a.hints ?? []).slice(0, Math.min(wrong, ASK_LIMITS.hints)).entries()) {
        if (typeof h === "string") { hints[k] = null; continue; }
        if (left() < 1 || !(await reset(until - Date.now())) || left() < 1) { hints[k] = "(this hint was not computed: this check's time ran out)"; continue; }
        // (all of it, the interpreter taking it up too, by the hints' shared deadline, HARD-729-1)
        const got = await evaluate(h.code, left(), until);
        hints[k] = got.ok && typeof got.value === "string" ? got.value : "(this hint could not be computed: " + (got.ok ? "it gave no text" : got.error ?? "it could not run") + ")";
      }
      await reset(REFRESH_MS);
      return { outcome, message, hints } as const;
    });
    if (!done) { checking.delete(key); board.askFeedback.delete(key); if (checkSigs.get(key) === mine) checkSigs.delete(key); redraw().catch(fail); return; }
    const { outcome, message, hints } = done;
    if (checking.get(key) === run) checking.delete(key);
    if (stale()) { if (checkSigs.get(key) === mine) { checkSigs.delete(key); board.askFeedback.delete(key); } redraw().catch(fail); return; }
    board.askFeedback.set(key, { message, hints });
    // (kept with the question it checked, on its page, whichever page is shown now)
    await editor.attempt(id, given, outcome, page - 1).catch(fail);
    // (what it said, kept while that page's question is as it was answered and checked)
    if (checkSigs.get(key) === mine && doc) checkSigs.set(key, { page, id, sig: checkSig(doc, page, id, true), done: true });
    redraw().then((drawn) => { if (drawn && pageIx + 1 === page) board.keepClear(id); }).catch(fail);
  };
  const checked = host.code ? (id: string, given: AskAnswer) => { const key = askKey(pageIx + 1, id); check(id, given).catch((e) => { board.askFeedback.delete(key); checkSigs.delete(key); fail(e); }); } : null;
  board.onCheck = checked;

  // The Submit bar, where the host takes answers (a frame's channel,
  // web/board-host-protocol.md): the page's answers, the reader's own words
  // and a comment, sent as one submission.  "Once": Send is disabled in its
  // own click, until the host says received or refused; with no answer in
  // 30 s it offers Send again, the same id; answers changed since,
  // a new id.  And a question's words decided among its `decide` options,
  // when the reader asks (the host's model), shown with the question.
  // (the wait before Send again; a test's shorter one, as __sbEvaluateStartMs is for the kernel's)
  const sendAgainMs = () => (globalThis as any).__sbSendAgainMs ?? 30_000;
  const comment = $("subcomment") as HTMLTextAreaElement, sendBtn = $("subsend") as HTMLButtonElement;
  // (the questions of the page shown, and what the reader gave them, as a submission sends them)
  function pageAnswers() {
    if (!doc) return null;
    const n = pageIx + 1, qs = asksOf(doc).filter((q) => q.page === n);
    const answers: Record<string, AskAnswer> = {}, notes: Record<string, string> = {}, missing: string[] = [];
    for (const { ask: a } of qs) {
      // (by its id, whatever it is: "__proto__" too, the object's own entry, not its prototype)
      if (a.answer !== undefined) setOwn(answers, a.id, a.answer);
      if (a.note?.trim()) setOwn(notes, a.id, a.note);
      if (a.required && !answered(a)) missing.push(plainTitle(a.title || a.text || a.id).slice(0, 60));
    }
    const p = pageOf(doc, pageIx), many = !!doc.pages?.length;
    const page = { number: n, ...(many && p.id ? { id: p.id } : {}), ...(many && p.title ? { title: p.title } : {}) };
    return { page, answers, notes, count: qs.length, done: qs.filter((q) => answered(q.ask)).length, missing };
  }
  const subKey = (pa: NonNullable<ReturnType<typeof pageAnswers>>) => JSON.stringify([pa.page, pa.answers, pa.notes, comment.value]);
  // (the bar as things stand: shown only with a channel and a page with questions, not over a version looked at)
  function submitBar() {
    const pa = host.answers && !viewing ? pageAnswers() : null;
    const shown = !!pa && pa.count > 0;
    $("submitbtn").hidden = !shown;
    if (!shown) { $("submit").hidden = true; return; }
    const same = !!sub && sub.key === subKey(pa!), long = comment.value.length > ASK_LIMITS.comment;
    const status = $("substatus"), say = (md: string) => { status.innerHTML = markdown(md); typesetIn(status); };
    $("subhead").textContent = `${pa!.count === 1 ? "The question" : `The ${pa!.count} questions`} on ${pageCount(doc!) > 1 ? `page ${pa!.page.number}` : "this board"}: ${pa!.done} answered.`;
    $("submitbtn").textContent = sub?.state === "sending" ? "Sending…" : same && sub!.state === "received" ? "Submitted ✓" : "Submit";
    sendBtn.textContent = sub && (sub.state === "late" || sub.state === "refused") && same ? "Send again" : "Send";
    sendBtn.disabled = sub?.state === "sending" || (same && sub!.state === "received") || pa!.missing.length > 0 || long;
    if (sub?.state === "sending") say("Sending…");
    else if (long) say(`The comment is longer than ${ASK_LIMITS.comment} characters.`);
    else if (pa!.missing.length) say(`**Answer the required questions first:** ${pa!.missing.map(esc).join("; ")}. A question answered in your own words counts.`);
    else if (sub?.state === "late") say(same ? "No answer yet from the page this board is in. You can send again: it won't arrive twice." : "No answer yet about your last answers. Send to send these instead.");
    else if (sub?.state === "received") say(same ? "**Received.** Whoever made this board has your answers." : "**Received** your earlier answers. You've changed them since: send to send these too.");
    else if (sub?.state === "refused") say(`**Not sent:** ${esc(sentence(sub.message ?? "refused"))} ${same ? "You can send again, or change your answers first." : "Send to try with your answers as they are now."}`);
    else say("");
  }
  // (a host's words, shown as text in Markdown: nothing in them formats or links)
  const esc = (s: string) => s.replace(/[\\`*_[\]<>#!|~$]/g, "\\$&");
  // (a host's words as a sentence: its own full stop, or one added)
  const sentence = (s: string) => (/[.!?]$/.test(s.trim()) ? s.trim() : s.trim() + ".");
  const typesetIn = (el: HTMLElement) => { if (board.typeset && hasMath(el.textContent ?? "")) board.typeset(el); };
  // (the comment shown typeset under its field, as a question's words are, a moment after typing stops)
  let commentSoon = 0;
  comment.addEventListener("input", () => {
    clearTimeout(commentSoon);
    commentSoon = window.setTimeout(() => {
      const pv = $("subpreview");
      pv.hidden = !/\$[^$]+\$/.test(comment.value) || comment.value.length > ASK_LIMITS.comment;
      if (!pv.hidden) {
        pv.innerHTML = markdown(comment.value, { pixels: docPixels });
        // (KaTeX loaded for the comment's math, if the board had none)
        if (host.math) (mathModule ??= host.math()).then((m) => { if (pv.isConnected) m.typeset(pv); }).catch(() => {});
      }
      submitBar();
    }, 200);
  });
  // (the id a send awaits the answer to, and the timer that offers Send again: one of each)
  let awaiting: string | null = null, lateTimer = 0;
  async function send() {
    const ch = host.answers;
    if (sendBtn.disabled || !ch) return;
    // (disabled in this click, before anything else, Once)
    sendBtn.disabled = true;
    const g = loadGen;
    // (an answer still being kept, as its field lost its focus to this press: sent with the rest)
    await answering;
    const pa = pageAnswers();
    if (g !== loadGen || destroyed || !pa || pa.missing.length || sub?.state === "sending") { submitBar(); return; }
    const key = subKey(pa), id = sub && sub.key === key && sub.state !== "received" ? sub.id : uuid();
    const mine: Sent = sub?.id === id ? sub : { id, key, state: "sending" };
    mine.state = "sending";
    sub = mine;
    submitBar();
    clearTimeout(lateTimer);
    lateTimer = window.setTimeout(() => { if (sub === mine && mine.state === "sending") { mine.state = "late"; submitBar(); } }, sendAgainMs());
    const answer = ch.submit(id, { page: pa.page, answers: pa.answers, notes: pa.notes, comment: comment.value });
    // (sent again: the channel's one promise of that id, which a send already awaits)
    if (awaiting === id) return;
    awaiting = id;
    const r = await answer;
    if (awaiting === id) awaiting = null;
    if (sub !== mine || destroyed) return;
    clearTimeout(lateTimer);
    if ("received" in r) mine.state = "received";
    else if ("refused" in r) { mine.state = "refused"; mine.message = r.refused; }
    // (given up on, unanswered: Send again sends it again)
    else mine.state = "late";
    submitBar();
  }
  sendBtn.onclick = () => { send().catch(fail); };
  $("submitbtn").onclick = () => {
    const p = $("submit");
    p.hidden = !p.hidden;
    if (!p.hidden) { submitBar(); comment.focus(); }
  };
  $("subclose").onclick = () => { $("submit").hidden = true; };
  // (a question's words decided among its options: the host asked, its answer shown with the question; stale (another document, other words) dropped)
  // (a question's key, for its decision and its check: its page and its id, which is the page's own, CORR-B21-2)
  const askKey = (page: number, id: string) => `p${page}/${id}`;
  // (a question's definition and words as a decision depends on them: its
  // page, all of it but its answer, note, verdict, attempts and place, and
  // its words; null if the page has no such question)
  // (a question as its Check's feedback depends on it: its page's identity
  // (its id), all of it but its note, verdict, attempts and place, and,
  // done, its answer and verdict; null if the page has no such question)
  function checkSig(d: BoardDoc, page: number, id: string, done: boolean): string | null {
    if (page > pageCount(d)) return null;
    const a = asksOf(d).find((q) => q.page === page && q.ask.id === id)?.ask;
    if (!a) return null;
    const { answer: _a, note: _n, result: _r, attempts: _t, wrongAttempts: _w, x: _x, y: _y, w: _ww, h: _h, ...def } = a as DocAsk & { x?: number; y?: number; w?: number; h?: number };
    return JSON.stringify([pageOf(d, page - 1).id ?? null, def, done ? [a.answer ?? null, a.result ?? null] : null]);
  }
  function askSig(d: BoardDoc, page: number, id: string): string | null {
    if (page > pageCount(d)) return null;
    const a = asksOf(d).find((q) => q.page === page && q.ask.id === id)?.ask;
    if (!a) return null;
    const { answer: _a, note: _n, result: _r, attempts: _t, wrongAttempts: _w, x: _x, y: _y, w: _ww, h: _h, ...def } = a as DocAsk & { x?: number; y?: number; w?: number; h?: number };
    return JSON.stringify([pageOf(d, page - 1).id ?? null, def, wordsOf(a)]);
  }
  // (the words a question has now, as kept: its note, or a text question's answer)
  const wordsOf = (a: DocAsk | undefined) => (a ? (a.note?.trim() ? a.note : a.input === "text" && typeof a.answer === "string" ? a.answer : "") : "");
  const askOn = (page: number, id: string) => (doc ? asksOf(doc).find((q) => q.page === page && q.ask.id === id)?.ask : undefined);
  const decide = async (id: string, words: string) => {
    const ch = host.answers, pa = pageAnswers();
    if (!ch || !pa || viewing) return;
    const page = pa.page.number, key = askKey(page, id), g = loadGen, mark = { pending: true };
    board.askDecided.set(key, mark);
    redraw().catch(fail);
    // (the words being kept first, as the field lost its focus to this press)
    await answering;
    if (board.askDecided.get(key) !== mark || !doc || wordsOf(askOn(page, id)) !== words) { if (board.askDecided.get(key) === mark) board.askDecided.delete(key); redraw().catch(fail); return; }
    const sig = askSig(doc, page, id);
    decidedSigs.set(key, { page, id, sig });
    const r = await ch.decide(pa.page, id, words);
    // (another document, or other words since: this answer is not theirs, dropped, CORR-B21-1)
    if (g !== loadGen || destroyed || board.askDecided.get(key) !== mark) return;
    const a = askOn(page, id);
    if (!doc || askSig(doc, page, id) !== sig) { board.askDecided.delete(key); decidedSigs.delete(key); redraw().catch(fail); return; }
    // (only a name of this question's own options, on its own page: anything else said so, never shown as the host's words)
    const names = new Set(a?.decide?.map((o) => o.name) ?? []);
    board.askDecided.set(key, "refused" in r ? { refused: r.refused } : r.option === null || names.has(r.option) ? { option: r.option } : { refused: "the answer was not one of this question's ideas" });
    // (what it says, and where to go next, clear of the caption)
    redraw().then((drawn) => { if (drawn && pageIx + 1 === page) board.keepClear(id, true); }).catch(fail);
  };
  // (set as each document is shown: a host's channel comes with its board)
  function decideWords(id: string, words: string) {
    decide(id, words).catch((e) => { board.askDecided.delete(askKey(pageIx + 1, id)); decidedSigs.delete(askKey(pageIx + 1, id)); fail(e); });
  }
  // (another document: what was sent and decided was the last one's)
  function forgetAnswered() {
    sub = null;
    board.askDecided.clear();
    decidedSigs.clear();
    checkSigs.clear();
  }
  // (a question's card grown or shrunk: laid out again, its element kept, so its field keeps its text and focus)
  // (and, grown, kept clear of the caption, which never covers it)
  // (a reader's choice, or their asking for the options again: bound to the
  // question as it is now and to their words, as a host's decision is;
  // Something else, their own words chosen, to the question only, as it
  // stands while they write them: astra's CORR-548-1)
  board.onChoose = (id) => {
    const page = pageIx + 1, key = askKey(page, id);
    if (!doc || viewing) return;
    if (board.askDecided.get(key)?.chosen === "") decidedSigs.set(key, { page, id, sig: checkSig(doc, page, id, false), choice: true });
    else decidedSigs.set(key, { page, id, sig: askSig(doc, page, id) });
  };
  board.onAskResize = (id, grown, bottom) => { redraw().then((drawn) => { if (drawn && grown) board.keepClear(id, bottom); }).catch(fail); };
  board.onToggleCode = (id) => {
    if (editor.on) { flipped.delete(id); editor.toggleCode(id); return; }
    if (!flipped.delete(id)) flipped.add(id);
    redraw().catch(fail);
  };

  // (a question's height also as its fields are open, as far as it has grown (UI-448-2) and with what its check said, and what the host decided its words show)
  const askState = (n: MeasuredNote) => { const a = (n as { ask?: DocAsk }).ask; return a ? [a, board.askOpen.has(a.id), board.askGrown.get(a.id) ?? 0, board.askFeedback.get(board.askScope + a.id) ?? null, board.askDecided.get(board.askScope + a.id) ?? null] : null; };
  const atLeastGrown = (n: MeasuredNote, h: number) => { const a = (n as { ask?: DocAsk }).ask; return a ? Math.max(h, board.askGrown.get(a.id) ?? 0) : h; };
  const heightKey = (n: MeasuredNote, w: number) => JSON.stringify([n.title, n.text, n.detail, n.ref, n.shape, n.img?.w, n.img?.h, w, askState(n)]);
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
    if (h === undefined) heights.set(k, (h = atLeastGrown(n, board.measure({ ...n, kind: "note", image: n.img }, w))));
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
        [...hs].forEach(([k, [n]], i) => (n.code !== undefined ? codeHeights : heights).set(k, atLeastGrown(n, got[i])));
      }
      return undefined;
    }
    return undefined;
  }

  // The engine of code items: the host's (none: the code shows, as text, as in an exported file)
  // (one interpreter for each language its items are in: codes.ts, item 16)
  let code: BoardCodes | null = null;
  function engine(): BoardCodes | null {
    if (code || !host.code) return code;
    const c = (code = new BoardCodes((mode) => host.code!(doc!, mode)));
    c.onChange = () => { board.codeStates(); relayout(); };
    c.onRan = (ids) => { keepPreviews(c, ids).catch((e) => console.warn("board: previews:", e)); };
    c.cache = host.outputs ?? null;
    c.cacheId = outputsId;
    c.usePictures(docPixels);
    // (a language's interpreter could not start: the caption says why, until the next edit)
    c.onError = (why) => { if (code === c) say(plain("The code can't run here:", why)); };
    const codeHost: CodeHost = { highlight: (s, id) => c.highlight(s, cell(id)) ?? escapeHtml(s), output: (id, copy) => c.output(cell(id), copy), state: (id) => c.state(cell(id)), run: (id) => { c.run([cell(id)]); } };
    // (an interpreter ready later, made as its language's items came: their
    // code shown again, highlighted now, UI-C5A-1)
    c.onReady = () => { if (code === c && board.code === codeHost) { board.setCode(codeHost); relayout(); } };
    c.ready.then((ok) => {
      if (!ok) return;
      board.setCode(codeHost);
      relayout();
    });
    return c;
  }
  // Previews of slow code items (preview.ts, design/outputs.md): after a run,
  // an item that ran keeps one if it is slow from root and loses it if not,
  // written only when what it shows changed, and not as a step to undo
  // (each of one run: dropped if its item ran again, or another board was
  // loaded, while its picture was drawn, SEC-14C-1)
  async function keepPreviews(c: BoardCodes, ids: string[]) {
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
    dirty.clear();
    forgetAnswered();
    loadGen++;
    // (Find's matches were the old document's: gone, before its items are
    // drawn again, CORR-F33-1; its query asked of the new one once shown)
    forgetFound();
    byPage.clear();
    newOutputs(!stored);
    // (a document loaded from elsewhere was not written here; the one kept, as it says)
    writtenHere = stored ? host.store?.writtenHere?.() ?? false : host.store?.writtenHere?.(false) ?? false;
    const m = /^#(?:p(\d+)(?:-(\d+))?|(\d+))$/.exec(host.address?.get() ?? "");
    pageIx = m?.[1] ? Number(m[1]) - 1 : 0;
    // (a page of the old document still being drawn: not shown over this one)
    pageGen++;
    closeTimeTravel(false);
    if (!(await show(d))) return;
    if (boardHistory) remember();
    at = -1;
    const n = Number(m?.[2] ?? m?.[3] ?? 0);
    step(n && pageView(d, pageIx).steps?.length ? n - 1 : -1, true);
    // (a board the page opens with nothing in it, a new one: all there is to do
    // is write in it, so in Edit, William; a document loaded into the page
    // later, an agent's or Open…'s, leaves Edit as it is)
    if (loads === 1 && host.editBlank !== false && !editor.on && !editBtn.hidden && Array.from({ length: pageCount(d) }, (_, i) => pageView(d, i).nodes ?? []).every((ns) => !ns.length)) editBtn.click();
    if (!findBar.hidden && findQ.value) findNow();
    refitAfterRun().catch(fail);
  }

  // A board is fitted as it opens, before its code has run; its outputs then
  // make it larger, and what they push down or out may start out of view.
  // So once the code has first run, its outputs drawn, the view is fitted
  // again, as the board now is, unless the reader has moved it meanwhile
  // (William): told the camera to move at all, a flight not yet begun
  // included (Find, a double-click; CORR-300-1)
  async function refitAfterRun() {
    const c = code, loaded = loads, moves = board.moves;
    if (!c) return;
    await c.idle();
    // (code that can't run here has no first run: nothing to fit again)
    if (!(await c.ready)) return;
    // (its pictures decoded, so the layout has their sizes)
    await Promise.all([...root.querySelectorAll<HTMLImageElement>(".board-world img")].map((i) => i.decode().catch(() => {})));
    if (loads !== loaded || code !== c || presenting || viewing || !(await redraw()) || loads !== loaded || board.moves !== moves) return;
    // (the camera only: the caption, and a notice in it, stay as they are)
    look();
  }

  /** Show page i (0-based), from its start (`end`: at its tour's last step). */
  async function page(i: number, end = false) {
    if (!doc) return;
    // (first: what is being written is kept on its own page)
    editor.clear();
    const g = ++pageGen;
    pageIx = Math.max(0, Math.min(pageCount(viewing ?? doc) - 1, i));
    // (the cursor the new page's, page and step together, while it is drawn;
    // and only the page asked for last is shown, as its tour starts, UI-118-1)
    at = end ? steps().length - 1 : -1;
    if (!(await redraw()) || g !== pageGen) return;
    // (Find's item outlined and marked only on its own page: another item
    // there may have its id, CORR-8CE-1)
    if (found[foundAt] && found[foundAt].page !== pageIx) unmark();
    step(end ? steps().length - 1 : -1, true);
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

  // Links to places on the board (`#p2`, `#p2-3`, `#3`, `#page-id`,
  // `#item-id`, `#page-id/item-id`) in a note's ref, its text, the caption:
  // a click goes there, a move of the reader's (round 0's 15); one naming
  // nothing does nothing (the address is the tour's)
  // (an item's link says what it goes to: its title, or its text's first
  // line (its math's source, its Markdown dropped), cut short; never its id)
  const NEXT_STEP = "Go to the next step", LABEL_MAX = 60;
  const firstLine = (text: string) => {
    const line = text.split("\n").find((l) => l.trim()) ?? "";
    const plain = plainTitle(line.replace(/!\[[^\]]*\]\([^)]*\)/g, "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/\*\*|__|`|^\s*(?:#+|>|[-+*])\s+/g, "")).replace(/\s+/g, " ").trim();
    if (plain.length <= LABEL_MAX) return plain;
    const cut = plain.slice(0, LABEL_MAX), at = cut.lastIndexOf(" ");
    return (at > LABEL_MAX / 2 ? cut.slice(0, at) : cut) + "…";
  };
  board.linkLabel = (ref) => {
    const l = doc && boardLink(doc, pageIx, ref);
    if (!l) return null;
    if (l.item) { const it = (function find(ns: DocNode[]): DocNode | undefined { for (const x of ns) { if (x.id === l.item) return x; if (x.kind === "group") { const y = find(x.children); if (y) return y; } } })(pageView(doc!, l.page).nodes ?? []); const n = it as { title?: string; text?: string } | undefined; return plainTitle(n?.title ?? "") || firstLine(n?.text ?? "") || NEXT_STEP; }
    return pageOf(doc!, l.page).title || (pageCount(doc!) > 1 ? `Page ${l.page + 1}` : doc!.title || "the start");
  };
  on(root, "click", (e: MouseEvent) => {
    const a = (e.target as Element | null)?.closest?.("a[href^='#']") as HTMLAnchorElement | null;
    if (!a || !root.contains(a) || a.closest(".board-editing")) return;
    e.preventDefault();
    const l = doc && boardLink(doc, pageIx, a.getAttribute("href") ?? "");
    if (!l) return;
    go(async () => {
      const g = loadGen, other = l.page !== pageIx;
      if (other) {
        const p = page(l.page), mine = pageGen;
        await p;
        // (the link is retired with its document, or when another page was
        // asked for meanwhile: nothing of it is done to what is shown now, UI-07E-2)
        if (destroyed || g !== loadGen || mine !== pageGen || pageIx !== l.page) return;
      }
      if (l.item) board.focus([l.item]);
      // (a page's start on the page shown too: its intro, the tour from the
      // top, as from another page, UI-07E-1; page() has shown it otherwise)
      else if (l.step >= 0 || !other) step(l.step);
    });
  }, true);

  /** The steps of the page shown. */
  const steps = () => (doc ? pageView(doc, pageIx).steps ?? [] : []);
  const hashFor = (i: number) => (pageIx ? `#p${pageIx + 1}${i >= 0 ? "-" + (i + 1) : ""}` : i >= 0 ? `#${i + 1}` : "");

  function caption(md: string | HTMLElement, where: string) {
    const el = $("say");
    el.classList.remove("open");
    if (typeof md === "string") {
      el.innerHTML = markdown(md);
      if (board.typeset && hasMath(md)) board.typeset(el);
    } else el.replaceChildren(md);
    $("where").textContent = where;
    // the camera keeps clear of the title bar and the caption
    board.insets = { top: 44, right: 0, left: 0, bottom: $("tour").hidden ? 0 : $("tour").offsetHeight + 18 };
  }

  /** Go to step `i` of the tour (-1: the whole board, and the intro). */
  function step(i: number, now = false) {
    const ss = steps();
    at = Math.max(-1, Math.min(ss.length - 1, i));
    if (at < 0) caption(intro(), ss.length ? `${ss.length} step${ss.length === 1 ? "" : "s"}` : "");
    else caption(ss[at].say ?? "", `${at + 1} / ${ss.length}`);
    look(now);
    host.address?.set(hashFor(at));
    // (back and on across pages: only the board's own start and end stop them, B4)
    ($("prev") as HTMLButtonElement).disabled = at < 0 && pageIx <= 0;
    ($("next") as HTMLButtonElement).disabled = at >= ss.length - 1 && pageIx >= pageTotal() - 1;
  }
  // The tour on, and back: past a page's last step to the next page's start,
  // and back before its start to the previous page's last step, so that →
  // alone goes through every tour of every page (William's B4)
  const pageTotal = () => (doc ? pageCount(viewing ?? doc) : 0);
  const onward = () => (at < steps().length - 1 ? step(at + 1) : pageIx < pageTotal() - 1 ? page(pageIx + 1) : undefined);
  const back = () => (at > -1 ? step(at - 1) : pageIx > 0 ? page(pageIx - 1, true) : undefined);
  // The reader's moves (the arrows, keys, the page picker), one after
  // another: one asked for while a page is still being drawn is made from
  // where that page lands, never from the old page's step (astra's
  // UI-118-1); one still waiting as another document loads (or a file is
  // opened, or dropped) is dropped, and a new document's moves don't wait
  // for the last one's (astra, on 3df6006)
  let moving: Promise<unknown> = Promise.resolve(), waiting = 0, movesOf = 0;
  function go(move: () => unknown) {
    const g = loadGen;
    if (movesOf !== g) { movesOf = g; moving = Promise.resolve(); waiting = 0; }
    const run = () => (g === loadGen && !destroyed ? move() : undefined);
    if (!waiting) {
      const r = run();
      if (!(r instanceof Promise)) return;
      moving = r;
    } else moving = moving.then(run);
    waiting++;
    moving = moving.catch(fail).finally(() => { if (movesOf === g) waiting--; });
  }
  /** What the caption says before a page's tour: its intro, or else its title, as text (friction 9). */
  function intro(): string | HTMLElement {
    const v = doc && pageView(doc, pageIx);
    if (v?.intro) return v.intro;
    const t = document.createElement("strong");
    t.textContent = doc?.pages?.length ? pageOf(doc, pageIx).title || `Page ${pageIx + 1}` : doc?.title ?? "";
    return t;
  }

  // (the camera on the step shown: the whole board, or its slide's card, or the step's items)
  function look(now = false) {
    const ss = steps();
    if (at < 0) {
      // (a slide: its card)
      const s = doc && lookOf(doc, pageIx).slide;
      if (s) { const c = board.cameraFor(s.x, s.y, s.x + s.w, s.y + s.h); if (now) board.setCamera(c); else board.flyTo(c); }
      // (the whole board, as legible as it can be: from its start if it is large, friction 6)
      else board.overview(now);
    } else {
      const s = ss[at];
      board.focus(typeof s.focus === "string" ? [s.focus] : s.focus, now);
    }
  }

  // (on a phone the caption is one line: a tap shows it whole, or one line again)
  $("say").onclick = (e) => {
    if ((e.target as Element).closest("a")) return;
    $("say").classList.toggle("open");
    board.insets = { ...board.insets, bottom: $("tour").hidden ? 0 : $("tour").offsetHeight + 18 };
  };
  $("prev").onclick = () => go(back);
  $("next").onclick = () => go(onward);
  $("fit").onclick = () => board.focus();
  // (reading, a click on a group's title band shows its whole title, or hides it; a click elsewhere, none: UI-0CC-2)
  board.onTitleClick = (id) => { if (!editor.on) board.reveal(id && id !== board.revealedId ? id : null); else if (board.revealedId) board.reveal(null); };
  on(window, "keydown", (e: KeyboardEvent) => {
    if (!mine() || e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.metaKey || e.ctrlKey || e.altKey) return;
    // (items selected in Edit: the arrow keys move them; in Edit, Space held pans)
    if (editor.hasSelection && e.key.startsWith("Arrow")) return;
    if (editor.on && e.key === " ") return;
    if (e.key === "ArrowRight" || e.key === " ") go(onward);
    else if (e.key === "ArrowLeft") go(back);
    // (Esc stopping a tool, or a selection, in Edit is the editor's: the camera stays)
    else if (e.key === "Escape" && !editor.escapes) go(() => step(-1));
    // (0, as the button that says so: everything, out of the tour; Esc, the board as it opens)
    else if (e.key === "0") go(() => { step(-1); board.focus(); });
    else if (e.key === "?") help();
    else if (e.key === "PageDown") go(() => page(pageIx + 1));
    else if (e.key === "PageUp") go(() => page(pageIx - 1));
    else if (e.key === "+" || e.key === "=") board.zoomAt(1.25, board.el.clientWidth / 2, board.el.clientHeight / 2);
    else if (e.key === "-") board.zoomAt(0.8, board.el.clientWidth / 2, board.el.clientHeight / 2);
    else return;
    e.preventDefault();
  });

  function fail(e: unknown) {
    if (destroyed) return;
    $("tour").hidden = false;
    // (as text, not Markdown: an error says what a file said, its format or
    // an id, which is anyone's: as Markdown, a picture in it was fetched, SEC-36E-1)
    caption(plain("This board could not be shown:", String((e as Error)?.message ?? e)), "");
  }
  // A caption of a bold head and text, as text.
  function plain(head: string, text: string): HTMLElement {
    const p = document.createElement("p"), b = document.createElement("strong");
    b.textContent = head;
    p.append(b, " " + text);
    return p;
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
        try { host.store?.save(kept); } catch {}
        if (!remembered && prev && prev !== replaced) toRecord.push(prev);
        remembered = true;
        toRecord.push(kept);
      }
      return;
    }
    // (the document as shown: its pictures' bytes are kept apart, by the
    // host's images; not kept, said, HARD-7F9-1)
    try { host.store?.save(doc!); unkept = null; } catch (e: any) { unkept = e; say(`**Not kept in this browser:** ${String(e?.message ?? e)}. Download the board (File) to keep it.`); }
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
  editor.onRun = (id) => { if (paused) return resumeCode(); code?.run([cell(id)]); };
  editor.highlight = (id) => { const c = code; return c && c.highlight("", cell(id)) !== null ? (src: string) => c.highlight(src, cell(id))! : null; };
  // (Tab's completions, from the interpreter of the code's language, as the notebook's; and the host's function search)
  editor.complete = (mode, before) => code?.complete(mode as BoardMode, before) ?? Promise.resolve(null);
  editor.docs = host.docs ?? null;
  editor.images = images;
  const editBtn = $("edit");
  editBtn.onclick = () => { closeTimeTravel(); editor.setOn(!editor.on); };
  // (a CoCalc board, converted: said in the caption, with what was left out,
  // until the next edit; and a notice, there until the next edit too: declared
  // before the store's editing hook, which may say why at once)
  let converted = "", notice: string | HTMLElement = "";
  // (whether Edit is offered and allowed, as the store says: a frame its host doesn't let edit offers none; one
  // paused at its bound, or whose host ended editing, leaves Edit and says why: web/board-host-protocol.md)
  const offEditing = host.store?.editing?.((s) => {
    editBtn.hidden = !!s.hidden;
    editBtn.toggleAttribute("disabled", !s.allowed);
    editBtn.title = s.allowed ? "" : s.why ?? "";
    if (!s.allowed && editor.on) editor.setOn(false);
    if (s.why) say(s.why.startsWith("**") ? s.why : `**${s.why}**`);
  });
  if (offEditing) offs.push(offEditing);
  offs.push(effect(() => {
    editBtn.setAttribute("aria-pressed", String(editor.editing.value));
    root.classList.toggle("sbb-editing", editor.editing.value);
    // (Find's bar under the Edit toolbar, once it is shown or gone)
    requestAnimationFrame(placeFind);
  }));
  // the toolbar, in Edit mode: adds at the middle of the view
  const center = () => { const v = board.view(); return { x: (v.x0 + v.x1) / 2, y: (v.y0 + v.y1) / 2 }; };
  const toolbar = new Toolbar(root, [
    { id: "select", label: "Select", icon: "↖", title: "Select: drag on the background to select what the rectangle holds (Space-drag pans); Esc to stop", toggle: editor.selecting },
    { id: "note", label: "Note", icon: "¶", title: "Add a note (Markdown, with math)", run: () => { const c = center(); editor.addNote(c.x, c.y, true); } },
    { id: "code", label: "Code", icon: "{ }", get title() { return codeTitle(codeMode); }, run: () => { const c = center(); editor.addCode(c.x, c.y, true); } },
    { id: "image", label: "Image", icon: "▨", title: "Add pictures (or paste one, or drop files on the board)", run: () => pickImages() },
    { id: "sticker", label: "Sticker", icon: "☺", title: "Add a sticker: an emoji (double-click one to change it)", run: () => editor.pickSticker({ at: center(), under: toolbar.el }) },
    { id: "group", label: "Group", icon: "▣", title: "Add a group (drag notes into it)", run: () => { const c = center(); editor.addGroup(c.x, c.y, true); } },
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
  // the top bar's two menus, File and ⋯, as the notebook's: one open at a time; a click anywhere closes it
  const menus = [[$("filebtn"), $("filemenu")], [$("menubtn"), $("menu")]] as const;
  for (const [b, m] of menus) {
    b.onclick = (e) => {
      e.stopPropagation();
      const open = m.hidden;
      for (const [, x] of menus) x.hidden = true;
      m.hidden = !open;
      if (open && m === $("menu")) showVersion();
    };
  }
  // (at the ⋯ menu's foot, which Sagebrush runs this board's code, as text,
  // asked each time: the engine that runs it may be chosen, or change, after
  // the first time, CORR-20A-1; round 0's 17, to compare with `sagebrush --version`)
  const versionOf = () => (host.version ? host.version().catch(() => null) : Promise.resolve(null));
  function showVersion() {
    versionOf().then((v) => {
      const el = $("ver"), parts = v ? [v.version && `Sagebrush ${v.version}`, v.build && `build ${v.build}`, v.engine && `engine ${v.engine.slice(0, 12)}`].filter(Boolean) : [];
      el.textContent = parts.join(" · ");
      el.title = v ? "Which Sagebrush runs this board's code (compare `sagebrush --version`)" + (v.engine ? `: engine ${v.engine}` : "") : "";
      el.hidden = !parts.length;
    });
  }
  on(window, "click", () => { for (const [, m] of menus) m.hidden = true; });
  // (foo.board.json: the board's file, canonical JSON)
  const fileName = () => ((doc?.title ?? "board").replace(/[^\w-]+/g, "-").replace(/^-|-$/g, "").toLowerCase() || "board") + ".board.json";
  // Help: what the keys and gestures do, and where to read more (the ? in
  // the top bar, ⋯'s Help, or ?), where the hint once was (William's B5)
  const help = () => { const h = $("helpdlg") as HTMLDialogElement; if (!h.open) h.showModal(); };
  $("help").onclick = help;
  $("helpitem").onclick = help; // (the menu closes, as at any click)
  // (a dialog that only shows something, Help and Examples: a click outside
  // it, on its backdrop, closes it, as Esc does; a press that starts inside
  // it, selecting its text, and ends outside doesn't (William, Oct 17).  The
  // dialogs with fields to fill in close only by their buttons or Esc)
  const closeOnBackdrop = (d: HTMLDialogElement) => {
    let fromOutside = false;
    const outside = (e: MouseEvent) => { const r = d.getBoundingClientRect(); return e.target === d && (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom); };
    on(d, "pointerdown", (e: PointerEvent) => { fromOutside = outside(e); });
    on(d, "click", (e: MouseEvent) => { if (fromOutside && outside(e)) d.close(); fromOutside = false; });
  };
  closeOnBackdrop($("helpdlg") as HTMLDialogElement);
  closeOnBackdrop($("exdlg") as HTMLDialogElement);
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
  $("pgprev").onclick = () => go(() => page(pageIx - 1));
  $("pgnext").onclick = () => go(() => page(pageIx + 1));
  ($("pgsel") as HTMLSelectElement).onchange = (e) => { const n = Number((e.target as HTMLSelectElement).value); go(() => page(n)); (e.target as HTMLElement).blur(); };
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
    a.href = URL.createObjectURL(new Blob([await boardFileText(doc!, images)], { type: "application/json" }));
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
  $("copyjson").onclick = async () => navigator.clipboard?.writeText(canonical(await images.inline(doc!)));
  async function openText(text: string, name?: string) {
    const d = boardFromText(text, name, (md) => { converted = md; });
    const bad = formatError(d);
    if (bad) throw new Error(bad);
    if (!isBoard(d)) throw new Error("not a board: a document needs nodes (or pages of them)");
    pageIx = 0;
    newOutputs(true);
    forgetAnswered();
    writtenHere = host.store?.writtenHere?.(false) ?? false;
    // (another document: what the last one was still drawing (a page, an
    // edit) not shown over it, its reader's moves dropped, as for a load;
    // astra, on 3df6006)
    loadGen++;
    pageGen++;
    await editor.commit((cur) => { for (const k of Object.keys(cur)) delete (cur as any)[k]; Object.assign(cur, d); });
    // (its own caption from its start: not the last document's intro and
    // tour, the welcome's on /board/, friction 7)
    step(-1, true);
    sayConverted();
  }
  function sayConverted() {
    if (!converted) return;
    say(converted);
    converted = "";
  }
  /** A notice in the caption, until the next edit. */
  function say(md: string | HTMLElement) {
    notice = md;
    $("tour").hidden = false;
    caption(notice, "");
  }
  // A file opened or dropped, as text: refused by its size, before it is
  // read, past FILE_MAX (HARD-36E-2)
  async function readFile(f: File): Promise<string> {
    if (f.size > FILE_MAX) throw new Error(`too large to open: ${Math.ceil(f.size / 2 ** 20)} MB (at most ${FILE_MAX / 2 ** 20} MB)`);
    return f.text();
  }
  const picker = $("openfile") as HTMLInputElement;
  $("open").onclick = () => picker.click();
  // (with the host's files: Upload's rule, design §3, any files, several)
  if (host.files?.upload) { picker.multiple = true; picker.removeAttribute("accept"); }
  // "Run this board's code": the person's consent, for a board brought in from a file (or a cell's own ▶)
  function resumeCode() {
    if (!paused) return;
    paused = false;
    $("runpaused").hidden = true;
    host.codeResumed?.();
    const d = doc;
    if (d) { const order = codeOrder(d); if (order.length) engine()?.sync(withPreviews(d, order, byPage), d.mode ?? "python", d.seed).catch((e) => console.warn("board: code items:", e)); }
  }
  $("runpaused").onclick = resumeCode;
  // (what is being written kept first, and kept by the host: else this board stays, nothing uploaded
  // and why said, as New board's (astra's CORR-4B3-2))
  async function uploadToHost(files: File[]) {
    await editor.keepWriting();
    elsewhereNot("Not uploaded", async () => {
      const said = await host.files!.upload!(files, doc?.mode ?? "python");
      if (said && !destroyed) say(said);
    });
  }
  // (a file read while another document is loaded, by an agent or the
  // host: that one, newer, wins; the file, read too late, is not opened
  // over it)
  picker.onchange = async () => {
    const files = [...(picker.files ?? [])], f = files[0], g = loadGen;
    picker.value = "";
    if (!f) return;
    if (host.files?.upload) return uploadToHost(files);
    const text = await readFile(f).catch(fail);
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
    if (host.files?.upload) return uploadToHost(files);
    const text = await readFile(f).catch(fail);
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
  // (a board of its own, where the host keeps several: what is being written kept first)

  // (one that can't be kept: not gone to, this board staying, and why said)
  // (nor while what was written here isn't kept: kept now, or this board
  // stays, HARD-933-1)
  const elsewhereNot = (what: string, f: () => void | Promise<void>) => {
    if (unkept && doc && host.store) {
      try { host.store.save(doc); unkept = null; } catch (e: any) { return say(`**${what}:** this board isn't kept in this browser (${String(e?.message ?? e)}), so it stays open. Download it (File) to keep it.`); }
    }
    // (a host that makes the board elsewhere first, the workspace's: its failure said too)
    try { void Promise.resolve(f()).catch((e: any) => say(`**${what}:** ${String(e?.message ?? e)}.`)); } catch (e: any) { say(`**${what}:** ${String(e?.message ?? e)}.`); }
  };
  $("duplicate").onclick = async () => {
    await editor.keepWriting();
    if (doc) elsewhereNot("No copy made", () => host.duplicate!(doc!));
  };
  $("newboard").onclick = async () => {
    if (!host.newBoard) return emptyBoard();
    await editor.keepWriting();
    elsewhereNot("No new board made", () => host.newBoard!(doc?.mode ?? "python"));
  };
  // (the File menu's items that are the host's files: as New board's, what is being written kept first)
  $("newnotebook").onclick = async () => {
    await editor.keepWriting();
    elsewhereNot("No new notebook made", () => host.files!.newNotebook!(doc?.mode ?? "python"));
  };
  $("newfolder").onclick = () => elsewhereNot("No folder made", () => host.files!.newFolder!());
  $("openfiles").onclick = () => host.files?.open?.();
  $("deleteboard").onclick = async () => {
    await editor.keepWriting();
    elsewhereNot("Not moved to Trash", () => host.files!.delete!());
  };
  // (Rename…: the title, renamed where it is, in Edit)
  $("rename").onclick = () => { if (!editor.on) editBtn.click(); $("title").click(); };
  // (Ctrl+Alt+N a new notebook, Ctrl+O Open…: the File menu's keys, as on the notebook page)
  on(window, "keydown", (e: KeyboardEvent) => {
    const it = fileMenuKey(e);
    if (!it) return;
    const b = $("filemenu").querySelector<HTMLButtonElement>(`[data-item="${it}"]`);
    if (!b || b.disabled) return;
    e.preventDefault();
    b.click();
  });
  const emptyBoard = () => (newOutputs(true), (writtenHere = host.store?.writtenHere?.(true) ?? false), editor.commit((d) => {
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
  // (⌘S downloads the board as one HTML file, as ⋯ Download as HTML does,
  // not the page (William); what is being written in a note is kept first.
  // Seen before a field's own keys; with a dialog open, nothing more)
  on(window, "keydown", async (e: KeyboardEvent) => {
    if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey || e.key.toLowerCase() !== "s" || !doc || !mine() || !host.exportHtml || host.saveKey === false) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (root.querySelector("dialog[open]")) return;
    await editor.keepWriting();
    $("html").click();
  }, true);

  // Find (Ctrl/Cmd+F, William): a small bar over the board, searching what
  // its items say as written, in the document (find.ts); Enter and
  // Shift+Enter go to the next and the previous item that says it, on its
  // page, in view, outlined, the words marked; Esc closes it
  const findBar = $("find"), findQ = $("findq") as HTMLInputElement;
  let found: FindEntry[] = [], foundAt = -1, findGen = 0;
  // (this board's own part of the page's highlight: gone with it)
  const findOwner = {};
  offs.push(() => setFindRanges(findOwner, null));
  const indexes = new WeakMap<BoardDoc, FindEntry[]>();
  const findDoc = () => viewing ?? doc;
  const index = () => { const d = findDoc()!; let x = indexes.get(d); if (!x) indexes.set(d, (x = findIndex(d))); return x; };
  // (under the top bar, or under the Edit toolbar when it shows)
  function placeFind() {
    if (findBar.hidden) return;
    const tb = root.querySelector(".board-toolbar:not([hidden])")?.getBoundingClientRect();
    findBar.style.top = tb?.height ? `${Math.round(tb.bottom - root.getBoundingClientRect().top + 6)}px` : "";
  }
  function openFind() {
    findBar.hidden = false;
    placeFind();
    findQ.focus();
    findQ.select();
  }
  function closeFind() {
    findBar.hidden = true;
    forgetFound();
  }
  // (no match: none counted, outlined or marked, and a mark still coming dropped)
  function forgetFound() {
    found = [];
    foundAt = -1;
    findGen++;
    unmark();
  }
  function unmark() {
    board.setFound(null);
    setFindRanges(findOwner, null);
  }
  // (as it is typed: the first item on the page shown or after it, else the first)
  function findNow() {
    if (!findDoc()) return;
    found = findIn(index(), findQ.value);
    foundAt = found.length ? Math.max(0, found.findIndex((e) => e.page >= pageIx)) : -1;
    showFound().catch(fail);
  }
  // (the next or the previous, from the one shown, by its page and id, ids
  // being unique only on a page; the document may have changed since, CORR-8CE-1)
  function findStep(dir: 1 | -1) {
    if (!findDoc()) return;
    const was = found[foundAt];
    found = findIn(index(), findQ.value);
    const k = was ? found.findIndex((e) => e.id === was.id && e.page === was.page) : -1;
    foundAt = !found.length ? -1 : k < 0 ? (dir > 0 ? 0 : found.length - 1) : (k + dir + found.length) % found.length;
    showFound().catch(fail);
  }
  async function showFound() {
    const g = ++findGen, e = found[foundAt];
    $("findn").textContent = !findQ.value ? "" : found.length ? `${foundAt + 1} of ${found.length}` : "No matches";
    findBar.classList.toggle("none", !!findQ.value && !found.length);
    if (!e) return unmark();
    if (e.page !== pageIx) await page(e.page);
    if (g !== findGen || !board.item(e.id)) return;
    board.setFound(e.id);
    revealFound(e.id);
    markFound(e.id, g);
  }
  // In view, below the bars, at the zoom it is (or close enough to read):
  // the board moves only if the item is not wholly in view.
  function revealFound(id: string) {
    const b = board.bounds([id]);
    if (!b) return;
    const c = board.camera, i = board.insets, W = board.el.clientWidth, H = board.el.clientHeight;
    const top = Math.max(i.top, findBar.getBoundingClientRect().bottom - board.el.getBoundingClientRect().top) + 8, bottom = H - i.bottom - 8;
    const z = c.z >= 0.5 ? c.z : Math.min(1, board.cameraFor(b.x0, b.y0, b.x1, b.y1, 1).z);
    const sx = (x: number) => (x - c.x) * c.z, sy = (y: number) => (y - c.y) * c.z;
    if (z === c.z && sx(b.x0) >= i.left && sx(b.x1) <= W - i.right && sy(b.y0) >= top && sy(b.y1) <= bottom) return;
    const y = (b.y1 - b.y0) * z <= bottom - top ? (b.y0 + b.y1) / 2 - (top + bottom) / 2 / z : b.y0 - top / z;
    board.flyTo({ x: (b.x0 + b.x1) / 2 - (i.left + (W - i.left - i.right) / 2) / z, y, z });
  }
  // (its words marked, once it is mounted; not where a browser has no highlights)
  function markFound(id: string, g: number, tries = 60) {
    const reg = (CSS as any).highlights, H = (globalThis as any).Highlight;
    if (!reg || !H || g !== findGen) return;
    const el = board.element(id);
    if (!el) { if (tries > 0) requestAnimationFrame(() => markFound(id, g, tries - 1)); return; }
    setFindRanges(findOwner, textRanges(el, findQ.value));
  }
  on(window, "keydown", (e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "f" && doc && mine() && !presenting) {
      e.preventDefault();
      e.stopImmediatePropagation();
      openFind();
    } else if (e.key === "Escape" && !findBar.hidden && mine() && (e.target === findQ || !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) && !board.editing && !root.querySelector("dialog[open]")) {
      e.preventDefault();
      e.stopImmediatePropagation();
      closeFind();
    }
  }, true);
  findQ.addEventListener("input", findNow);
  findQ.addEventListener("keydown", (e) => {
    // (the board's keys are not for this field)
    e.stopPropagation();
    if (e.key === "Enter") { e.preventDefault(); findStep(e.shiftKey ? -1 : 1); }
  });
  $("findprev").onclick = () => findStep(-1);
  $("findnext").onclick = () => findStep(1);
  $("findx").onclick = closeFind;

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
    // (a version being looked at: its questions shown, not answered, CORR-448-3)
    board.onAnswer = null;
    board.onCheck = null;
    redraw().catch(fail);
  }
  /** Close the bar: the board as it is again (`now`: drawn at once). */
  function closeTimeTravel(now = true) {
    if ($("tt").hidden) return;
    $("tt").hidden = true;
    viewing = null;
    board.onAnswer = answer;
    board.onCheck = checked;
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
    /** What is being written where it is, ended and kept in the document (the host saves it): before
     * the host leaves the board, whichever way (astra's CORR-BCD-1). */
    keepWriting: () => editor.keepWriting(),
    writing: () => editor.writing,
    /** Nothing written or changed by the person while the page makes where it goes (astra's CORR-134-1). */
    freeze: (on: boolean) => editor.holdForLeaving(on),
    /** The board's title made `t` if it is `was` (its file renamed by the
     * page, CORR-0B0-2): saved as a change of this page's, not a step to undo. */
    retitle: (t: string, was: string) => (doc && (doc.title ?? "") === was ? editor.commit((d) => { d.title = t; }, false, false) : Promise.resolve(null)),
    /** Unmount: what is being written is kept first; then nothing of the
     * board is left (its listeners and effects, the code engine and its
     * interpreter, TimeTravel's history, its elements; its stylesheet with
     * the last board on the page). */
    async destroy() {
      // (first, at once: whatever is waiting draws nothing more, CORR-C08-1;
      // what is being written is still kept, saved though not drawn; Find's
      // mark still coming dropped, F33)
      destroyed = true;
      findGen++;
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
      /** Which Sagebrush runs this board's code: { version, build, engine } (any of them; null when the host does not say). */
      engine: () => versionOf(),
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
      json: async () => boardFileText(doc!, images),
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
