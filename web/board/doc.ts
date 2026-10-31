// A board as an agent writes it (design/board.md, "The document"): structure,
// not coordinates.  Notes (Markdown with math) and groups of them, each group
// laid out as a row, a column, a grid, or a layered graph of the edges among
// its members; edges between any two items, with labels.  layout() turns it
// into positioned items for the renderer (board.ts): an item with x and y
// keeps them (a person moved it), the rest are placed.

import { capPreviews, cleanPreview, type Preview } from "./preview";
import { dataUrl } from "../image-size";
import type { Item, Edge } from "./board";
import type { ImageInfo } from "./images";
import { routeSteps, type Rect, type RouteRequest } from "./route";
import { inkOutline } from "./ink";
import { springLayout } from "../graph/spring";

// A stroke's outline, made once: by its id, size and points (a hash of
// them), not again at each layout (5000 strokes: 90 ms each time).  At
// most OUTLINES kept; past that, the cache starts again.
const OUTLINES = 50_000;
const outlines = new Map<string, number[]>();
function outlineOf(n: DocInk): number[] {
  let h = 0x811c9dc5;
  for (const v of n.points) h = Math.imul(h ^ Math.round(v * 100), 16777619);
  const size = n.size ?? INK_SIZE, k = `${n.id}\0${size}\0${n.points.length}\0${h >>> 0}`;
  let o = outlines.get(k);
  if (!o) {
    if (outlines.size >= OUTLINES) outlines.clear();
    outlines.set(k, (o = inkOutline(n.points, { size, streamline: 0, last: true })));
  }
  return o;
}

// Every note has the same optional parts, shown (and edited) in this order:
// its title, its picture, its text, its code with the code's output, its
// detail, its link.  A note that is only a picture is shown as the picture.
// (The doc comments of these interfaces are the format's published field
// reference, web/board-format.md: scripts/board-format-fields.mjs writes it
// from them, so each field needs one, saying what it means to a writer.)
/** A note: the default item. Every part is optional; a note with `code` is a code item. */
export interface DocNote {
  /** required: unique on its page (an edge names it) */
  id: string;
  /** `"note"`, or left out */
  kind?: "note";
  /** a heading (plain text, math allowed) */
  title?: string;
  /** a picture: its name in the document's `images` (letters, digits, `_` and `-`, at most 100 characters) */
  image?: string;
  /** Markdown with math (`$...$`), shown at every zoom */
  text?: string;
  /** code in the board's language (`mode`), run in the reader's browser,
   * its output under it; it makes the note a code item */
  // (one interpreter for the board, reactive as a notebook's cells:
  // web/board/code.ts; documents before October 13, 2026 also said
  // `kind: "code"`)
  code?: string;
  /** `true`: show only the code's output, not the code */
  hideCode?: boolean;
  /** a code item's language, when it is not the board's (`"python"`, `"sage"`, `"magma"` or `"matlab"`; default: the board's `mode`). Each language runs in its own interpreter: languages share no values, so copy data from one to another as literals */
  // (William's item 16, option A: one interpreter for each language a board
  // uses, started when its first item runs; names shared within a language)
  mode?: BoardMode;
  /** a slow code item's output, kept to show before it runs (written by Sagebrush) */
  // (preview.ts, design/outputs.md; last in the file)
  preview?: Preview;
  /** Markdown shown only when zoomed in */
  detail?: string;
  /** a link: a URL, a paper, or a path (`src/file.py#L10`) resolved against `refBase`; or a place on the board: `#p2` (page 2), `#p2-3` (its step 3), `#3` (this page's step 3), `#id` (the page with that id, or the item), `#page-id/item-id` (an item on a page); in Markdown text too, as `[see Boards](#boards)` */
  ref?: string;
  /** a color (`#e8f0fb`, a CSS color name, `rgb(...)`, `hsl(...)`) */
  color?: string;
  /** its outline (a flowchart's); its text is then centered. `diamond` (a decision) is pointed at its left and right and flat at its top and bottom, so that its text fits a note's width, not a true rhombus (which would need twice its text's width and height); `hexagon` is the same, less pointed */
  shape?: NoteShape;
  /** `true`: as wide as its text needs, up to `w` */
  fit?: boolean;
  /** its position, kept once a person moves it: leave it out, and the board places it */
  x?: number;
  /** as `x` */
  y?: number;
  /** its width (default 260; 440 for a code item; for a note with only a picture, the picture's width, up to 480, its height then from the picture's shape) */
  w?: number;
  /** its height (default: as tall as what it shows) */
  h?: number;
}

export type NoteShape = "rect" | "round" | "stadium" | "circle" | "diamond" | "hexagon" | "cylinder" | "subroutine" | "lean-right" | "lean-left" | "trapezoid" | "inv-trapezoid" | "flag";

/** A group: items laid out together, under a title. Groups nest; an edge may join any two items on a page, in any groups. */
export interface DocGroup {
  /** required: unique on its page */
  id: string;
  /** required: `"group"` */
  kind: "group";
  /** a heading (plain text, math allowed) */
  title?: string;
  /** Markdown with math, under the title */
  text?: string;
  /** how its items are laid out (default `graph`: in layers along the edges among them; `spring`: pulled together along the edges, pushed apart elsewhere) */
  layout?: "row" | "column" | "grid" | "graph" | "spring";
  /** `grid` layout: how many columns (default: as square as can be) */
  columns?: number;
  /** `graph` layout: layers top to bottom (`TB`, the default) or left to right (`LR`) */
  direction?: "TB" | "LR";
  /** required: its items (notes, groups, stickers) */
  children: DocNode[];
  /** a color */
  color?: string;
  /** its position, kept once a person moves it: leave it out */
  x?: number;
  /** as `x` */
  y?: number;
  /** its width at least, as a person made it by its corner (it is as wide as this, or as its items need, whichever is more) */
  w?: number;
  /** its height at least, as `w` */
  h?: number;
}

// A pen stroke (ink.ts): where the pen went, with its pressure, drawn as
// an outline whose width follows it.  (x, y) is the corner of its box, the
// points' extent and the pen's size around it; the points are measured from
// that corner.
/** A pen stroke, drawn by a person. Don't write these. */
export interface DocInk {
  /** required: unique on its page */
  id: string;
  /** required: `"ink"` */
  kind: "ink";
  /** required: x, y and pressure (0 to 1) of each point, from the corner (`x`, `y`) */
  // (as drawn: streamlined, a mouse's pressure from its speed, ink.ts InkCapture)
  points: number[];
  /** the pen's width */
  // (each stroke says: a later default changes no old one)
  size?: number;
  /** its color */
  color?: string;
  /** below 1: a highlighter's, which what is under it shows through */
  opacity?: number;
  /** required: the corner of its box */
  x: number;
  /** required: as `x` */
  y: number;
}

// A sticker (stickers.ts): an emoji, or a CoCalc icon by name, shown
// without a frame.  (A picture alone is a note with only a picture.)
/** A sticker: one emoji, or one of CoCalc's icons, shown without a frame. */
export interface DocSticker {
  /** required: unique on its page */
  id: string;
  /** required: `"sticker"` */
  kind: "sticker";
  /** one emoji */
  emoji?: string;
  /** one of CoCalc's icons, by name (a converted CoCalc board), with `color` */
  icon?: string;
  /** an icon's color */
  color?: string;
  /** its position: leave it out, and the board places it */
  x?: number;
  /** as `x` */
  y?: number;
  /** its width (default 64) */
  w?: number;
}

// A question for the board's reader (web/board-host-protocol.md): its
// answer is kept on it.  A reader that doesn't know the kind shows its
// title and text as a note's, so the question is in them.
/** A question for the person reading the board: checkboxes, radio buttons, a list to choose from, a text, a number or a scale. Its answer is kept in it, as `answer`: given on the board with its controls, or written by a host's submission or `sagebrush board answers --apply`. */
export interface DocAsk {
  /** required: unique on its page (an answer names it) */
  id: string;
  /** required: `"ask"` */
  kind: "ask";
  /** a heading (plain text, math allowed) */
  title?: string;
  /** the question: Markdown with math (`$...$`) */
  text?: string;
  /** required: how it is answered: `check` (any of `options`, or without them one yes/no box), `radio` (one of `options`), `choice` (one of `options`, from a list: for many), `text`, `number` or `scale` (a whole number from `min` to `max`) */
  input: AskInput;
  /** `check`, `radio` and `choice`: what may be chosen; each a text, or `{ "value": ..., "label": ... }` to keep its answers when its words change */
  options?: AskOption[];
  /** `true`: it must be answered before the answers are sent */
  required?: boolean;
  /** `number`: the least it takes; `scale`: its first value (default 1) */
  min?: number;
  /** `number`: the most it takes; `scale`: its last value (default 5) */
  max?: number;
  /** `number`: the step between the values it takes */
  step?: number;
  /** `scale`: the words at its low end ("disagree") */
  low?: string;
  /** `scale`: the words at its high end ("agree") */
  high?: string;
  /** `text`: how many lines its field shows (default 1) */
  lines?: number;
  /** the reader's answer in their own words (plain text, English or any language): beside the answer, or in place of it. A question with a note that is not only spaces counts as answered */
  note?: string;
  /** the answer given: for `check` the values chosen (a list; `true` or `false` without options), for `radio` and `choice` the value chosen, for `text` a string, for `number` and `scale` a number */
  answer?: AskAnswer;
  /** code in the board's language that decides whether an answer is right (Python and Sage boards): the answer is bound to `answer`, in a scope of its own that sees the board's names (the board's code runs again after it, so what it changes doesn't last); the value of its last expression is the verdict: `True` (right), `False` (wrong), or a string (wrong, and the string, Markdown with math, is shown). Run when the reader presses Check, within `checkMs` */
  check?: string;
  /** the most milliseconds its check, or a computed hint, may run (a whole number, 1 to 10000; default 2000) */
  checkMs?: number;
  /** hints, one more shown after each wrong attempt: Markdown, or `{ "code": ... }`, run as the check is, its value a string (Markdown) */
  hints?: AskHint[];
  /** where to go after an attempt: the id of a note on this page, for `right` and for `wrong` */
  next?: AskNext;
  /** what the reader's own words (`note`) may show, for the host to decide among (at most 32): each a self-describing name, such as a misconception, and where to go if it is the one (web/board-host-protocol.md, "Deciding") */
  decide?: AskDecide[];
  /** an answer to try its check with (`sagebrush board try` runs it) */
  example?: AskAnswer;
  /** how many times its answer was checked (written by Sagebrush) */
  attempts?: number;
  /** how many of those were wrong: one more hint is shown after each (written by Sagebrush) */
  wrongAttempts?: number;
  /** the last check's verdict: `right`, `wrong` or `error` (written by Sagebrush) */
  result?: AskResult;
  /** Markdown shown only when zoomed in */
  detail?: string;
  /** a color */
  color?: string;
  /** its position: leave it out, and the board places it */
  x?: number;
  /** as `x` */
  y?: number;
  /** its width (default 320) */
  w?: number;
  /** its height (default: as tall as what it shows) */
  h?: number;
}

export type AskInput = "check" | "radio" | "choice" | "text" | "number" | "scale";
/** One of a question's options, whose `value` its answer names: its `label` (default: the value) is what the reader sees. */
export interface AskChoice {
  /** required: what an answer says when this is chosen */
  value: string;
  /** what the reader sees (Markdown with math; default: `value`) */
  label?: string;
}
export type AskOption = string | AskChoice;
/** A hint computed from the reader's answer. */
export interface AskHintCode {
  /** required: code run as the question's check is, `answer` bound; its value, a string, is the hint (Markdown) */
  code: string;
}
export type AskHint = string | AskHintCode;
/** Where a question leads after an attempt: notes on its page, by id. */
export interface AskNext {
  /** the note to go to after a right answer */
  right?: string;
  /** the note to go to after a wrong one */
  wrong?: string;
}
/** One of the things a reader's own words may show, which the host decides among. */
export interface AskDecide {
  /** required: what it is, in words joined by hyphens, at least three (`confuses-transitive-with-2-transitive`): the name says what it means */
  name: string;
  /** Markdown that makes the name clearer (a rubric), if it needs that */
  about?: string;
  /** the id of an item on this page to go to when it is the one */
  next?: string;
}
export type AskResult = "right" | "wrong" | "error";
export type AskAnswer = string | number | boolean | string[];

export type DocNode = DocNote | DocGroup | DocInk | DocSticker | DocAsk;
/** Whether an item is a note (a code item too). */
export const isNote = (n: DocNode): n is DocNote => n.kind === undefined || n.kind === "note";

/** A slide's card on its page, in board coordinates. */
export interface SlideRect {
  /** required: its left edge */
  x: number;
  /** required: its top edge */
  y: number;
  /** required: its width */
  w: number;
  /** required: its height (16:9 with `w`, say) */
  h: number;
}
/** A page's background. */
export interface PageBackground {
  /** a color: on a slide's card, or behind the whole board */
  color?: string;
  /** a picture's name in `images` (letters, digits, `_` and `-`, at most 100 characters), on a slide's card */
  image?: string;
}

/** An edge between two items on a page, drawn as an arrow from `from` to `to`. */
export interface DocEdge {
  /** required: an item's id */
  from: string;
  /** required: an item's id */
  to: string;
  /** a label on it (plain text) */
  label?: string;
  /** `true`: not drawn, only used to lay out (to place one box below another) */
  hidden?: boolean;
  /** arrowheads: at the end (when left out), `none`, or `both` ends */
  arrow?: "none" | "both";
  /** `dotted` or `thick` (default: a thin line) */
  line?: "dotted" | "thick";
}

/** A step of a tour: the camera shows these items while the caption explains them. */
export interface DocStep {
  /** required: an item's id, or several */
  focus: string | string[];
  /** the caption (Markdown with math) */
  say?: string;
}

/** A page of a board: its own items, edges and tour. */
export interface BoardPage {
  /** needed by templates; unique among the pages */
  id?: string;
  /** the page's title (plain text) */
  title?: string;
  /** Markdown shown before the page's tour (without it, the page's title is shown; on the first page, the document's `intro`) */
  intro?: string;
  /** how the page's items are laid out (default `graph`) */
  layout?: DocGroup["layout"];
  /** as for a group */
  columns?: number;
  /** as for a group */
  direction?: DocGroup["direction"];
  /** the card the page is arranged on, a slide, which Present shows */
  slide?: SlideRect;
  /** the page's background */
  background?: PageBackground;
  /** `true`: other pages can be made from it (it needs an `id`) */
  template?: boolean;
  /** a template page's id: its card, background and items appear under this page's own */
  uses?: string;
  /** required: the page's items */
  nodes: DocNode[];
  /** the edges among them */
  edges?: DocEdge[];
  /** its tour */
  steps?: DocStep[];
}

/** What a board document says it is (written first in every document):
 * `{ format: "sagebrush-board", version: 1, ... }`.  A document without it
 * is taken as version 1 (boards written before October 13, 2026). */
export const FORMAT = "sagebrush-board";
export const VERSION = 1;

/** a board's language (BoardDoc.mode) */
export type BoardMode = "python" | "sage" | "magma" | "matlab";
const MODES = ["sage", "magma", "matlab"] as const, ITEM_MODES = ["python", "sage", "magma", "matlab"] as const;

/** A board: one page (its own `nodes`, `edges` and `steps`), or several (`pages`). */
export interface BoardDoc {
  /** `"sagebrush-board"`: write it first */
  format?: typeof FORMAT;
  /** `1`: write it second */
  version?: number;
  /** the board's title (plain text) */
  title?: string;
  /** the language of its code items, one per board (default `python`) */
  mode?: BoardMode;
  /** `"latest"`, in a downloaded file: run with the newest engine when online (written by Sagebrush) */
  // (export.ts, engine.ts: else the one it was saved with)
  engine?: "latest";
  /** 64 hex digits: the seed of its code's random numbers; without it a fixed
   * default is used, so a board's random numbers are always repeatable */
  // (each code item draws from the hash of it and the item's cell id, and its
  // outputs can be cached: design/outputs.md; BOARD_SEED without one)
  seed?: string;
  /** the toolbar's tools in Edit mode, in order (written by Sagebrush) */
  // (toolbar.ts; else the person's default)
  tools?: string[];
  /** pictures by name: `{w, h, src}` (pixels; `src` a `data:` or `https:` URL). A name is letters, digits, `_` and `-`, at most 100 characters (`plot-1`, not `plot 1` or `figure.png`): a picture by another name is left out, and so is a note's or a background's use of it */
  // (their bytes as data: URLs in a board that left the browser: images.ts)
  images?: Record<string, ImageInfo>;
  /** several pages; a document with pages has no `nodes`, `edges` or `steps` of its own */
  pages?: BoardPage[];
  /** Markdown shown before the tour starts (with pages: on the first page, if it has no `intro` of its own) */
  intro?: string;
  /** the base URL for `ref` links that are paths (e.g. a repository's blob URL) */
  refBase?: string;
  /** how the top-level items are laid out (default `graph`) */
  layout?: DocGroup["layout"];
  /** as for a group */
  columns?: number;
  /** as for a group */
  direction?: DocGroup["direction"];
  /** as for a page */
  slide?: SlideRect;
  /** as for a page */
  background?: PageBackground;
  /** the items of a one-page board */
  nodes?: DocNode[];
  /** the edges among them */
  edges?: DocEdge[];
  /** its tour */
  steps?: DocStep[];
}

/** How many pages a document has. */
export const pageCount = (d: BoardDoc) => (d.pages?.length ? d.pages.length : 1);

/** Page i of a document, as the object holding its nodes, edges and steps
 * (the document itself when it has no pages): changes to it change the document. */
export function pageOf(d: BoardDoc, i: number): BoardPage {
  if (!d.pages?.length) return d as BoardPage;
  return d.pages[Math.max(0, Math.min(d.pages.length - 1, i))];
}

/** The pages shown as pages (Present, JSON Canvas): those that are not
 * templates (a template is shown on the pages made from it), or, when all
 * are templates, all of them. */
export function shownPages(d: BoardDoc): number[] {
  const all = [...Array(pageCount(d)).keys()], own = all.filter((p) => !d.pages?.length || !pageOf(d, p).template);
  return own.length ? own : all;
}

/** The template page that page i is made from (its index), or -1. */
export function templateOf(d: BoardDoc, i: number): number {
  if (!d.pages?.length) return -1;
  const p = pageOf(d, i);
  if (!p.uses || p.template) return -1;
  return d.pages.findIndex((q, k) => k !== i && q.template && q.id === p.uses);
}

/** Page i's slide and background: its own, else its template's. */
export function lookOf(d: BoardDoc, i: number): { slide?: SlideRect; background?: PageBackground } {
  const p = pageOf(d, i), t = templateOf(d, i), q = t >= 0 ? d.pages![t] : undefined;
  return { slide: p.slide ?? q?.slide, background: p.background ?? q?.background };
}

/** Where a link on the board goes (`#p2`, `#p2-3`, `#3`, `#page-id`,
 * `#item-id`, `#page-id/item-id`; round 0's 15), from page `from`: a page
 * (0-based), a step of its tour (-1: its start) and an item; null if it
 * names nothing on the board. */
export function boardLink(d: BoardDoc, from: number, href: string): { page: number; step: number; item?: string } | null {
  if (!href.startsWith("#")) return null;
  let h = href.slice(1);
  try { h = decodeURIComponent(h); } catch {}
  const n = pageCount(d), steps = (p: number) => pageView(d, p).steps?.length ?? 0;
  const has = (p: number, id: string) => { const find = (ns: DocNode[]): boolean => ns.some((x) => x.id === id || (x.kind === "group" && find(x.children))); return find(pageView(d, p).nodes ?? []); };
  let m = /^p(\d+)(?:-(\d+))?$/.exec(h);
  if (m) { const p = Number(m[1]) - 1, k = m[2] ? Number(m[2]) - 1 : -1; return p >= 0 && p < n && k < steps(p) ? { page: p, step: k } : null; }
  if ((m = /^(\d+)$/.exec(h))) { const k = Number(m[1]) - 1; return k >= 0 && k < steps(from) ? { page: from, step: k } : null; }
  const pageNamed = (id: string) => (d.pages?.length ? d.pages.findIndex((p) => p.id === id) : -1);
  const slash = h.indexOf("/");
  if (slash > 0) { const p = pageNamed(h.slice(0, slash)), id = h.slice(slash + 1); return p >= 0 && has(p, id) ? { page: p, step: -1, item: id } : null; }
  const p = pageNamed(h);
  if (p >= 0) return { page: p, step: -1 };
  if (has(from, h)) return { page: from, step: -1, item: h };
  for (let q = 0; q < n; q++) if (has(q, h)) return { page: q, step: -1, item: h };
  return null;
}

/** A link's words as a note shows them: a GitHub file's path in its
 * repository, else its address without the scheme; decoded where it can be
 * (round 0's 10: every note read "https://github.com/sagemathinc/sag…"). */
export function refLabel(ref: string): string {
  const s = ref.replace(/^https:\/\/github\.com\/[^/]+\/[^/]+\/blob\/[^/]+\//, "").replace(/^https?:\/\//, "");
  try { return decodeURIComponent(s); } catch { return s; }
}

/** Page i as a one-page document, for layout() (the document's title, refBase and pictures; and
 * on the first page, without an intro of its own, the document's: friction 7). */
export function pageView(d: BoardDoc, i: number): BoardDoc {
  const p = pageOf(d, i);
  if (p === (d as BoardPage)) return d;
  // (the seed too: a page's spring layout is the board's, every page alike, CORR-874-1)
  return { title: d.title, mode: d.mode, seed: d.seed, refBase: d.refBase, images: d.images, intro: p.intro ?? (i === 0 ? d.intro : undefined), layout: p.layout, columns: p.columns, direction: p.direction, slide: p.slide, background: p.background, nodes: p.nodes, edges: p.edges, steps: p.steps };
}

/** Whether something is a board document. */
// A document as it may be trusted: it comes from any address (?doc=), a
// file, a paste, an agent, a browser's storage.  Every number a finite
// number, every text a string, every choice one of its values, every color
// a color: nothing in it can reach the page's markup or styles as anything
// but data (the print view writes SVG from positions; a note's color is a
// CSS variable).
const SHAPES = new Set(["rect", "round", "stadium", "circle", "diamond", "hexagon", "cylinder", "subroutine", "lean-right", "lean-left", "trapezoid", "inv-trapezoid", "flag"]);
const COLOR = /^(#[0-9a-f]{3,8}|[a-z]{3,20}|(rgba?|hsla?)\(\s*[-\d.]+%?(deg)?\s*(,\s*[-\d.]+%?\s*){2,3}\))$/i;
export const safeColor = (c: unknown): string | undefined => (typeof c === "string" && COLOR.test(c.trim()) ? c.trim() : undefined);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const str = (v: unknown) => (typeof v === "string" ? v : v == null ? undefined : String(v));
const one = <T extends string>(v: unknown, of: readonly T[]): T | undefined => (of.includes(v as T) ? (v as T) : undefined);
const strip = <T extends object>(o: T): T => { for (const k of Object.keys(o)) if ((o as any)[k] === undefined) delete (o as any)[k]; return o; };
const LAYOUTS = ["row", "column", "grid", "graph", "spring"] as const, DIRS = ["TB", "LR"] as const;
export const ASK_INPUTS = ["check", "radio", "choice", "text", "number", "scale"] as const;
// (an option: a string, or an object with a string value and, if any, a string label)
const askOption = (o: any): AskOption | undefined =>
  typeof o === "string" ? o : o && typeof o === "object" && !Array.isArray(o) && typeof o.value === "string" ? strip({ value: o.value, label: typeof o.label === "string" ? o.label : undefined }) : undefined;
// (an answer: a string, a finite number, true or false, or a list of strings)
const askAnswer = (a: unknown): AskAnswer | undefined =>
  typeof a === "string" || typeof a === "boolean" ? a : num(a) ?? (Array.isArray(a) && a.every((x) => typeof x === "string") ? [...a] : undefined);
// (a picture's name, and where its bytes may be: a raster image's data: URL, or an https: address)
const IMAGE_NAME = /^[\w-]{1,100}$/;
// An object's own entry for a key a board names (an id, an image's name),
// set and read as its own: "__proto__", "constructor" or "toString" are a
// board's to use as any other name, never the object's prototype or its
// methods (an assignment `o[k] = v` to "__proto__" sets the prototype, and
// `o[k]` reads inherited members).
/** Set `o`'s own entry `k`, whatever `k` is. */
export function setOwn<T>(o: Record<string, T>, k: string, v: T): void {
  Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });
}
/** `o`'s own entry `k`, if it has one. */
export function getOwn<T>(o: Record<string, T> | null | undefined, k: string): T | undefined {
  return o && Object.hasOwn(o, k) ? o[k] : undefined;
}
// (data: URLs as image-size.ts reads them, any case of the type and jpg too: one grammar, CORR-68B-1)
const IMAGE_SRC = /^https:\/\/[^\s"'<>\\]+$/;
const imageSrc = (s: string) => IMAGE_SRC.test(s) || dataUrl(s) !== null;
function cleanImages(m: any): Record<string, ImageInfo> | undefined {
  if (!m || typeof m !== "object" || Array.isArray(m)) return undefined;
  const out: Record<string, ImageInfo> = {};
  for (const [k, v] of Object.entries(m) as [string, any][]) {
    const w = num(v?.w), h = num(v?.h);
    if (!IMAGE_NAME.test(k) || !w || !h || w <= 0 || h <= 0) continue;
    // (a source that is not a raster image's data: URL or an https: address: the picture is dropped)
    if (v.src !== undefined && !(typeof v.src === "string" && imageSrc(v.src))) continue;
    setOwn(out, k, v.src !== undefined ? { w, h, src: v.src } : { w, h });
  }
  return Object.keys(out).length ? out : undefined;
}

// a slide's card: four finite numbers, a size; a background: a color, a picture's name
const slideRect = (r: any): SlideRect | undefined => {
  const x = num(r?.x), y = num(r?.y), w = num(r?.w), h = num(r?.h);
  return x !== undefined && y !== undefined && w !== undefined && h !== undefined && w > 0 && h > 0 ? { x, y, w, h } : undefined;
};
const background = (b: any): PageBackground | undefined => {
  const color = safeColor(b?.color), image = typeof b?.image === "string" && IMAGE_NAME.test(b.image) ? b.image : undefined;
  return color || image ? { ...(color ? { color } : {}), ...(image ? { image } : {}) } : undefined;
};

/**
 * A board's picture names that cleanDoc leaves out, as its file has them
 * (in `images`, a note's `image`, a background's): not letters, digits, `_`
 * and `-`, at most 100 characters; each once, in the order met.  For a
 * reader that can say so (the command line), where the board can't.
 */
export function badPictureNames(d: any): string[] {
  const out = new Set<string>();
  const see = (v: unknown) => { if (typeof v === "string" && !IMAGE_NAME.test(v)) out.add(v); };
  const walk = (ns: unknown) => {
    if (!Array.isArray(ns)) return;
    for (const n of ns) {
      if (!n || typeof n !== "object") continue;
      if (n.kind === "group") walk(n.children);
      else if (n.kind !== "ink" && n.kind !== "sticker") see(n.image);
    }
  };
  if (d?.images && typeof d.images === "object" && !Array.isArray(d.images)) for (const k of Object.keys(d.images)) see(k);
  see(d?.background?.image);
  walk(d?.nodes);
  for (const p of Array.isArray(d?.pages) ? d.pages : []) { see(p?.background?.image); walk(p?.nodes); }
  return [...out];
}

/** Steps of work that yield every so often (cleanDocSteps): run through at once by the page, paced by the export,
 * which yields to the browser between them (web/workspace/export/stream.ts). */
export type Steps<T> = Generator<void, T, void>;
const runSteps = <T,>(g: Steps<T>): T => { for (;;) { const r = g.next(); if (r.done) return r.value; } };
/** Each `per` items of a loop, a step. */
const STEP = 256;

export function cleanDoc(d: any): BoardDoc {
  return runSteps(cleanDocSteps(d));
}

/** cleanDoc, in steps: the same code, yielding every STEP items (nodes, a group's children, a stroke's points in
 * blocks, edges, steps, the previews' walk), so the export can clean a large board without one long piece of work. */
export function* cleanDocSteps(d: any): Steps<BoardDoc> {
  let count = 0;
  const tick = function* () { if (++count % STEP === 0) yield; };
  // (a list's items each through f, those it keeps, in order)
  const keep = function* <T, R>(xs: T[], f: (x: T) => Steps<R | null | undefined> | R | null | undefined): Steps<R[]> {
    const out: R[] = [];
    for (const x of xs) {
      const r = f(x);
      const v = r && typeof (r as any).next === "function" && typeof (r as any)[Symbol.iterator] === "function" ? yield* (r as Steps<R | null | undefined>) : (r as R | null | undefined);
      if (v !== null && v !== undefined) out.push(v as R);
      yield* tick();
    }
    return out;
  };
  const node = function* (n: any): Steps<DocNode | null> {
    if (!n || typeof n !== "object" || n.id == null) return null;
    if (n.kind === "group") {
      const children = yield* keep(Array.isArray(n.children) ? n.children : [], node);
      return strip({ id: String(n.id), kind: "group" as const, title: str(n.title), text: str(n.text), layout: one(n.layout, LAYOUTS), columns: num(n.columns), direction: one(n.direction, DIRS),
        children, color: safeColor(n.color), x: num(n.x), y: num(n.y),
        w: groupSide(n.w), h: groupSide(n.h) });
    }
    // (a stroke: its points as numbers, three a point, and its place; else none)
    if (n.kind === "ink") {
      const ps = Array.isArray(n.points) ? n.points.slice(0, n.points.length - (n.points.length % 3)) : [];
      if (!ps.length || num(n.x) === undefined || num(n.y) === undefined) return null;
      // (in blocks of 64Ki numbers, a step each)
      for (let i = 0; i < ps.length; i += 65536) { for (let j = i; j < Math.min(ps.length, i + 65536); j++) if (!(typeof ps[j] === "number" && Number.isFinite(ps[j]))) return null; yield; }
      const size = num(n.size), opacity = num(n.opacity);
      const world: number[] = new Array(ps.length);
      for (let i = 0; i < ps.length; i += 65536) { for (let j = i; j < Math.min(ps.length, i + 65536); j++) world[j] = j % 3 === 0 ? ps[j] + n.x : j % 3 === 1 ? ps[j] + n.y : ps[j]; yield; }
      return inkNode(String(n.id), world, { size: size !== undefined && size > 0 && size <= 200 ? size : undefined, color: safeColor(n.color), opacity: opacity !== undefined && opacity > 0 && opacity < 1 ? opacity : undefined });
    }
    // (a sticker: one emoji, or an icon's name; else none)
    if (n.kind === "sticker") {
      const emoji = oneEmoji(n.emoji), icon = typeof n.icon === "string" && ICON_NAME.test(n.icon) ? n.icon : undefined, w = num(n.w);
      if (!emoji && !icon) return null;
      return strip({ id: String(n.id), kind: "sticker" as const, emoji, icon, color: safeColor(n.color), x: num(n.x), y: num(n.y), w: w !== undefined && w >= 8 && w <= 4000 ? w : undefined });
    }
    // (a question: its input one of those; else, as a reader that doesn't
    // know the kind shows it, a note with its title and text)
    if (n.kind === "ask" && one(n.input, ASK_INPUTS)) {
      const options = Array.isArray(n.options) ? yield* keep(n.options, askOption) : undefined;
      return strip({ id: String(n.id), kind: "ask" as const, title: str(n.title), text: str(n.text), input: n.input as AskInput, options, required: n.required === true ? true : undefined,
        min: num(n.min), max: num(n.max), step: num(n.step), low: str(n.low), high: str(n.high), lines: num(n.lines), answer: askAnswer(n.answer), note: typeof n.note === "string" ? n.note : undefined,
        check: typeof n.check === "string" ? n.check : undefined, checkMs: Number.isInteger(n.checkMs) && n.checkMs >= 1 && n.checkMs <= 10000 ? n.checkMs : undefined,
        hints: Array.isArray(n.hints) ? n.hints.filter((h: unknown) => typeof h === "string" || (!!h && typeof h === "object" && typeof (h as any).code === "string")).map((h: any) => (typeof h === "string" ? h : { code: h.code })) : undefined,
        next: n.next && typeof n.next === "object" && !Array.isArray(n.next) ? strip({ right: typeof n.next.right === "string" ? n.next.right : undefined, wrong: typeof n.next.wrong === "string" ? n.next.wrong : undefined }) : undefined,
        decide: Array.isArray(n.decide) ? n.decide.filter((o: any) => !!o && typeof o === "object" && typeof o.name === "string").map((o: any) => strip({ name: o.name, about: str(o.about), next: str(o.next) })) : undefined,
        example: askAnswer(n.example), attempts: Number.isInteger(n.attempts) && n.attempts >= 0 ? n.attempts : undefined, wrongAttempts: Number.isInteger(n.wrongAttempts) && n.wrongAttempts >= 0 ? n.wrongAttempts : undefined, result: one(n.result, ["right", "wrong", "error"] as const), detail: str(n.detail),
        color: safeColor(n.color), x: num(n.x), y: num(n.y), w: num(n.w), h: num(n.h) });
    }
    // (kind "code": the code items of documents before every note could have code)
    const code = n.kind === "code" ? (str(n.code) ?? "") : str(n.code);
    return strip({ id: String(n.id), title: str(n.title), image: typeof n.image === "string" && IMAGE_NAME.test(n.image) ? n.image : undefined, text: str(n.text), code, hideCode: code !== undefined && n.hideCode === true ? true : undefined, mode: code !== undefined ? one(n.mode, ITEM_MODES) : undefined, detail: str(n.detail), ref: str(n.ref),
      color: safeColor(n.color), shape: SHAPES.has(n.shape) ? (n.shape as NoteShape) : undefined, fit: n.fit === true ? true : undefined,
      x: num(n.x), y: num(n.y), w: num(n.w), h: num(n.h), preview: code !== undefined ? cleanPreview(n.preview) : undefined });
  };
  const edge = (e: any) => (e && e.from != null && e.to != null ? strip({ from: String(e.from), to: String(e.to), label: str(e.label),
    hidden: e.hidden === true ? true : undefined, arrow: one(e.arrow, ["none", "both"] as const), line: one(e.line, ["dotted", "thick"] as const) }) : null);
  const stepOf = (t: any) => (t && (typeof t.focus === "string" || Array.isArray(t.focus)) ? strip({ focus: typeof t.focus === "string" ? t.focus : t.focus.map(String), say: str(t.say) }) : null);
  const page = function* (p: any): Steps<any> {
    const nodes = Array.isArray(p?.nodes) ? yield* keep(p.nodes, node) : undefined;
    const edges = Array.isArray(p?.edges) ? yield* keep(p.edges, edge) : undefined;
    const steps = Array.isArray(p?.steps) ? yield* keep(p.steps, stepOf) : undefined;
    return strip({
      id: str(p?.id), title: str(p?.title), intro: str(p?.intro), layout: one(p?.layout, LAYOUTS), columns: num(p?.columns), direction: one(p?.direction, DIRS),
      slide: slideRect(p?.slide), background: background(p?.background), template: p?.template === true ? true : undefined, uses: str(p?.uses),
      nodes, edges, steps,
    });
  };
  const top = yield* page(d);
  const out: any = strip({ format: FORMAT, version: VERSION, ...top, title: str(d?.title), mode: one(d?.mode, MODES), engine: d?.engine === "latest" ? "latest" : undefined, seed: typeof d?.seed === "string" && /^[0-9a-f]{64}$/.test(d.seed) ? d.seed : undefined, refBase: str(d?.refBase), tools: Array.isArray(d?.tools) ? d.tools.filter((t: unknown) => typeof t === "string") : undefined, images: cleanImages(d?.images) });
  delete out.id;
  if (Array.isArray(d?.pages)) { const pages: any[] = []; for (const p of d.pages) { pages.push(yield* page(p)); yield* tick(); } out.pages = pages; }
  // (previews: at most DOC_MAX in all, every page's, SEC-14C-2)
  const notes: DocNote[] = [];
  const walk = function* (ns: DocNode[] | undefined): Steps<void> { for (const n of ns ?? []) { if (n.kind === "group") yield* walk(n.children); else if (isNote(n) && n.preview) notes.push(n); yield* tick(); } };
  yield* walk(out.nodes);
  for (const p of out.pages ?? []) yield* walk(p.nodes);
  capPreviews(notes);
  return out as BoardDoc;
}

// A document's keys in a file, in this order: what it is, its settings, its
// content, and its pictures (data: URLs, possibly large) last.
const DOC_KEYS = ["format", "version", "title", "mode", "engine", "seed", "refBase", "tools", "intro", "layout", "columns", "direction", "slide", "background", "nodes", "edges", "steps", "pages", "images"];

/**
 * A document as its file holds it (foo.board.json): cleaned (cleanDoc), its
 * keys in a fixed order (format and version first), two spaces of indent,
 * and arrays of numbers or strings on one line.  The same document is always
 * the same text, so a change is a small diff, and reading and writing a file
 * gives it back as it was.
 */
export function canonical(d: BoardDoc): string {
  return boardText(cleanDoc(d));
}

/** boardText's text in parts, for the export to write as it goes (web/workspace/export/stream.ts): the same layout,
 * piece by piece; a string is handed over as `{ s }`, for the reader to write as JSON.stringify writes it (a long one
 * in pieces).  **It must agree with boardText byte for byte**: web/workspace/test-export.mjs proves it, the export's
 * stream cut everywhere, against Download. */
export function* boardTextParts(d: any): Generator<string | { s: string }, void, void> {
  const c: any = d, out: any = {};
  for (const k of DOC_KEYS) if (c[k] !== undefined) out[k] = c[k];
  for (const k of Object.keys(c)) if (!Object.hasOwn(out, k)) Object.defineProperty(out, k, { value: c[k], enumerable: true, writable: true, configurable: true });
  const scalar = function* (x: any): Generator<string | { s: string }, void, void> {
    if (typeof x === "string") yield { s: x };
    else { const j = JSON.stringify(x); if (j !== undefined) yield j; }
  };
  const text = function* (v: any, indent: string): Generator<string | { s: string }, void, void> {
    if (Array.isArray(v)) {
      if (!v.length) { yield "[]"; return; }
      if (v.every((x) => typeof x !== "object" || x === null)) {
        yield "[";
        for (let i = 0; i < v.length; i++) { if (i) yield ", "; yield* scalar(v[i]); }
        yield "]";
        return;
      }
      const i2 = indent + "  ";
      yield "[\n";
      for (let i = 0; i < v.length; i++) { if (i) yield ",\n"; yield i2; yield* text(v[i], i2); }
      yield "\n" + indent + "]";
      return;
    }
    if (v && typeof v === "object") {
      const ks = Object.keys(v).filter((k) => v[k] !== undefined);
      if (!ks.length) { yield "{}"; return; }
      const i2 = indent + "  ";
      yield "{\n";
      for (let i = 0; i < ks.length; i++) { if (i) yield ",\n"; yield i2 + JSON.stringify(ks[i]) + ": "; yield* text(v[ks[i]], i2); }
      yield "\n" + indent + "}";
      return;
    }
    // (as boardText: a value JSON doesn't write, a function say, is the text "undefined")
    if (typeof v === "string") yield { s: v };
    else yield String(JSON.stringify(v));
  };
  yield* text(out, "");
  yield "\n";
}

/** A board's JSON in canonical()'s layout (the format's keys first, two-space
 * indents, short arrays of scalars on one line), as it is: nothing cleaned or
 * dropped.  What `board open --edit` writes (web/board/lossless.ts). */
export function boardText(d: any): string {
  const c: any = d, out: any = {};
  for (const k of DOC_KEYS) if (c[k] !== undefined) out[k] = c[k];
  // (own keys only, defined as own properties: an extension key named "toString", "constructor" or "__proto__" is
  // the board's, never the object's)
  for (const k of Object.keys(c)) if (!Object.hasOwn(out, k)) Object.defineProperty(out, k, { value: c[k], enumerable: true, writable: true, configurable: true });
  const text = (v: any, indent: string): string => {
    if (Array.isArray(v)) {
      if (!v.length) return "[]";
      if (v.every((x) => typeof x !== "object" || x === null)) return "[" + v.map((x) => JSON.stringify(x)).join(", ") + "]";
      const i2 = indent + "  ";
      return "[\n" + v.map((x) => i2 + text(x, i2)).join(",\n") + "\n" + indent + "]";
    }
    if (v && typeof v === "object") {
      const ks = Object.keys(v).filter((k) => v[k] !== undefined);
      if (!ks.length) return "{}";
      const i2 = indent + "  ";
      return "{\n" + ks.map((k) => i2 + JSON.stringify(k) + ": " + text(v[k], i2)).join(",\n") + "\n" + indent + "}";
    }
    return JSON.stringify(v);
  };
  return text(out, "") + "\n";
}

/** Why this cannot be shown as a board of this format (another format, or a
 * later version than this page reads), or null. */
/** Why a document can't be shown, or null.  `reader` and `remedy` name the
 * program reading it and what to do about a later version: the page's by
 * default; the command line says its own (src/board-cli.ts). */
export function formatError(d: any, o: { reader?: string; remedy?: string } = {}): string | null {
  if (d?.format !== undefined && d.format !== FORMAT) return `not a Sagebrush board: its format is "${String(d.format).slice(0, 40)}"`;
  if (d?.version !== undefined && !(Number.isInteger(d.version) && d.version >= 1)) return "not a Sagebrush board: its version is not a number";
  if (d?.version > VERSION) return `this board is in version ${d.version} of the format, from a later Sagebrush; ${o.reader ?? "this page"} reads version ${VERSION}: ${o.remedy ?? "reload it, or update the app"}`;
  // (on a page, an id is one item's: an edge names it)
  const pages: any[] = Array.isArray(d?.pages) ? d.pages : [d];
  for (let i = 0; i < pages.length; i++) {
    const seen = new Set<string>();
    let twice: string | null = null;
    const walk = (ns: unknown) => { if (Array.isArray(ns)) for (const n of ns) { if (!n || typeof n !== "object" || n.id == null || twice) continue; const id = String(n.id); if (seen.has(id)) twice = id; seen.add(id); walk(n.children); } };
    walk(pages[i]?.nodes);
    if (twice !== null) return `not a board this page can show: two items${pages.length > 1 ? ` on page ${i + 1}` : ""} have the id "${String(twice).slice(0, 40)}"`;
  }
  // (and a page's id is one page's: a page made from a template names it, CORR-3D2-3)
  if (Array.isArray(d?.pages)) {
    const seen = new Set<string>();
    for (const p of d.pages) {
      if (p?.id == null) continue;
      const id = String(p.id);
      if (seen.has(id)) return `not a board this page can show: two pages have the id "${id.slice(0, 40)}"`;
      seen.add(id);
    }
  }
  return null;
}

export const isBoard = (d: any) => !!d && (Array.isArray(d.nodes) || (Array.isArray(d.pages) && d.pages.every((p: any) => Array.isArray(p?.nodes))));

const GAP = 40, PAD = 24, TITLE = 34;
/** The gap the layouts keep between items (world units): a new item added below another keeps it too. */
export const ITEM_GAP = GAP;
// (the "spring" layout: how far apart linked items' edges are drawn to, spring.ts `length`)
const SPRING_LENGTH = GAP * 1.5;
// (a group's size as a person made it: a positive number of units, at most a large board's)
const groupSide = (v: unknown) => { const n = num(v); return n !== undefined && n > 0 && n <= 100000 ? n : undefined; };
/** A group's padding, and its title's height (its members' origin is below them). */
export const GROUP_PAD = PAD, GROUP_TITLE = TITLE;

interface Box { w: number; h: number }

/** A note's rendered height at a width (the renderer's measure()), and
 * optionally the width its text needs, up to a most (for `fit` notes). */
export type Measure = ((n: MeasuredNote, w: number) => number) & { width?: (n: MeasuredNote, max: number) => number };
/** A note as measured: with its picture's name and size (`img`). */
export type MeasuredNote = DocNote & { img?: ImageInfo & { key: string } };

// A note's size: given, measured, or estimated from its text's length (about
// 7 px a character, 20 px a line), with room for the title and the link.
/** A sticker's width, unless it says. */
export const STICKER_SIZE = 64;

/** A CoCalc icon's name, as a sticker may have one (and only such reaches a host). */
export const ICON_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** `s` if it is one emoji: one grapheme, at most 16 code units, no ASCII letter and no control character; else undefined. */
export function oneEmoji(s: unknown): string | undefined {
  if (typeof s !== "string") return undefined;
  const t = s.trim();
  if (!t || t.length > 16 || /[A-Za-z]|\p{Cc}/u.test(t)) return undefined;
  return [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(t)].length === 1 ? t : undefined;
}

/** A pen's width, unless a stroke says. */
export const INK_SIZE = 3;

/** A stroke's box: its points, and the pen's size around them. */
export const inkSize = (n: DocInk): Box => {
  const pad = n.size ?? INK_SIZE;
  let w = 0, h = 0;
  for (let i = 0; i + 2 < n.points.length; i += 3) { w = Math.max(w, n.points[i]); h = Math.max(h, n.points[i + 1]); }
  return { w: w + pad, h: h + pad };
};

/** A stroke through `points` (x, y, pressure, ... on the board, as
 * InkCapture keeps them): its
 * corner where its box is, its points measured from there (to a tenth;
 * pressure to a hundredth), as a document keeps it. */
export function inkNode(id: string, points: ArrayLike<number>, o: { size?: number; color?: string; opacity?: number } = {}): DocInk {
  const pad = o.size ?? INK_SIZE;
  let x0 = Infinity, y0 = Infinity;
  for (let i = 0; i + 2 < points.length; i += 3) { x0 = Math.min(x0, points[i]); y0 = Math.min(y0, points[i + 1]); }
  const r = (v: number, k = 10) => Math.round(v * k) / k;
  const pts: number[] = [];
  for (let i = 0; i + 2 < points.length; i += 3) pts.push(r(points[i] - x0 + pad), r(points[i + 1] - y0 + pad), r(Math.min(1, Math.max(0, points[i + 2])), 100));
  return { id, kind: "ink", x: r(x0 - pad), y: r(y0 - pad), points: pts, size: pad, ...(o.color ? { color: o.color } : {}), ...(o.opacity !== undefined && o.opacity < 1 ? { opacity: o.opacity } : {}) };
}

function noteSize(n: DocNote, measure?: Measure, img?: ImageInfo): Box {
  if (n.w && n.h && !n.fit) return { w: n.w, h: n.h };
  // (only a picture: its width, or at most 480; its height from its shape)
  if (img && onlyImage(n)) {
    const w = n.w ?? Math.min(480, img.w);
    return { w, h: Math.round((w * img.h) / img.w) };
  }
  // (code items: wider, for their output)
  const most = n.w ?? (n.code !== undefined ? 440 : 260);
  const longest = Math.max(...[n.title ?? "", ...(n.text ?? "").split("\n")].map((l) => l.length));
  const w = !n.fit ? most : Math.min(most, Math.max(60, Math.ceil(measure?.width ? measure.width(n, most) + 2 : longest * 7.4 + (n.shape && n.shape !== "rect" ? 50 : 26))));
  if (measure) return { w, h: n.h ?? Math.max(60, Math.ceil(measure(n, w)) + 2) };
  const chars = (n.text ?? "").length;
  const lines = Math.ceil(chars / Math.max(10, (w - 24) / 7.2)) + (n.text?.match(/\n/g)?.length ?? 0);
  const code = n.code === undefined ? 0 : 34 + (n.hideCode ? 0 : 18 * n.code.split("\n").length);
  const pic = img ? Math.round(((w - 24) * img.h) / img.w) + 8 : 0;
  const h = n.h ?? Math.max(70, 24 + (n.title ? 24 : 0) + pic + lines * 20 + (n.detail ? 26 : 0) + (n.ref ? 22 : 0) + code);
  return { w, h };
}

/** Whether a note is only a picture (shown as the picture alone). */
export const onlyImage = (n: { image?: string | object; title?: string; text?: string; code?: string; detail?: string; ref?: string }) =>
  !!n.image && !n.title && !n.text && n.code === undefined && !n.detail && !n.ref;

const hasCode = (ns: DocNode[]): boolean => ns.some((n) => (n.kind === "group" ? hasCode(n.children) : isNote(n) && n.code !== undefined));
/** Whether a board has code items, on any page. */
export const anyCode = (d: BoardDoc) => Array.from({ length: pageCount(d) }, (_, i) => pageView(d, i)).some((v) => hasCode(v.nodes ?? []));

/**
 * A board's code items in reading order, which is the order they run in
 * (one interpreter for the board, as a notebook's cells): page by page; on
 * a page, top to bottom and then left to right, and a group's items
 * together, where the group is.  The positions are those of a layout with
 * estimated sizes, so that the order does not change as outputs grow.
 */
export function codeOrder(d: BoardDoc): CodeCell[] {
  const out: CodeCell[] = [];
  for (let i = 0; i < pageCount(d); i++) {
    const v = pageView(d, i);
    if (!hasCode(v.nodes ?? [])) continue;
    const { items } = layout(v, undefined, { deferRoutes: true });
    const kids = new Map<string | undefined, Item[]>();
    for (const it of items) if (it.kind === "note" || it.kind === "group") (kids.get(it.parent) ?? kids.set(it.parent, []).get(it.parent)!).push(it);
    const visit = (parent: string | undefined): Item[] => rows(kids.get(parent) ?? []).flatMap((it) => (it.kind === "group" ? visit(it.id) : [it]));
    for (const it of visit(undefined)) if (it.code !== undefined) out.push({ id: it.id, code: it.code, page: i, item: it.id, mode: (it.mode as BoardMode | undefined) ?? d.mode ?? "python" });
  }
  // (an id is one item's on its page, and may be another's on another
  // page: on one interpreter, those cells are told apart by their page,
  // id@pN; and should an item have that very id, id@pN~2, ~3, ...: one cell
  // each, whatever ids a board has, CORR-79B-1)
  const count = new Map<string, number>();
  for (const c of out) count.set(c.item, (count.get(c.item) ?? 0) + 1);
  const taken = new Set(out.map((c) => c.item));
  for (const c of out) {
    if (count.get(c.item)! < 2) continue;
    let id = `${c.item}@p${c.page + 1}`;
    for (let k = 2; taken.has(id); k++) id = `${c.item}@p${c.page + 1}~${k}`;
    taken.add(id);
    c.id = id;
  }
  return out;
}

/** A code item as a cell of the board's interpreter: `id`, the cell's (its
 * item's id, or, for an id that items on several pages have, `id@pN`, N
 * its page from 1, `~2`, `~3`, ... after it should that be an item's id);
 * `page` (from 0) and `item`, the item's on its page. */
export interface CodeCell { id: string; code: string; page: number; item: string; mode: BoardMode }

// Boxes in rows (a box whose top is above the middle of the row's shortest
// box so far joins it), top to bottom, each row left to right.
function rows(xs: Item[]): Item[] {
  const byTop = [...xs].sort((a, b) => a.y - b.y || a.x - b.x), out: Item[] = [];
  let row: Item[] = [], top = 0, short = 0;
  const flush = () => { out.push(...row.sort((a, b) => a.x - b.x)); row = []; };
  for (const it of byTop) {
    if (row.length && it.y >= top + Math.min(short, it.h) / 2) flush();
    if (!row.length) { top = it.y; short = it.h; }
    short = Math.min(short, it.h);
    row.push(it);
  }
  flush();
  return out;
}

/** A question's options, each its value and what the reader sees. */
export const askOptions = (a: DocAsk): { value: string; label: string }[] => (a.options ?? []).map((o) => (typeof o === "string" ? { value: o, label: o } : { value: o.value, label: o.label ?? o.value }));

/**
 * A question as Markdown: its text, then its options, each marked chosen
 * or not, or the answer given; what a reader without controls shows (the
 * board until it has them, `sagebrush board render`).
 */
export function askMarkdown(a: DocAsk): string {
  const out: string[] = a.text ? [a.text, ""] : [];
  // (answered in words only: answered, nothing said to be missing)
  const words = a.note?.trim() ? a.note : undefined, ans = a.answer, none = words ? "" : "_(not answered yet)_";
  const code = (s: string) => "`" + s.replace(/`/g, "'").replace(/\s+/g, " ") + "`";
  if (a.input === "check" || a.input === "radio" || a.input === "choice") {
    const opts = askOptions(a);
    if (a.input === "check" && !opts.length) out.push(ans === true ? "☑ yes" : ans === false ? "☐ no" : `☐ ${none}`.trimEnd());
    else {
      const chosen = new Set(Array.isArray(ans) ? ans : typeof ans === "string" ? [ans] : []);
      const [on, off] = a.input === "check" ? ["☑", "☐"] : ["◉", "○"];
      for (const o of opts) out.push(`- ${chosen.has(o.value) ? on : off} ${o.label}`);
      // (an answer that names no option: said as it is)
      for (const v of chosen) if (!opts.some((o) => o.value === v)) out.push(`- ${on} ${code(v)} (not one of the options)`);
      // (answered, none chosen; or not answered yet: not the same)
      out.push("", Array.isArray(ans) && !ans.length ? "_(answered: none chosen)_" : ans === undefined ? none : "");
      while (out.at(-1) === "") out.pop();
    }
  } else if (a.input === "text") {
    const said = typeof ans !== "string" ? none : ans.trim() ? ans.split("\n").map((l) => "> " + l).join("\n") : "_(answered: left empty)_";
    if (said) out.push(said);
  } else {
    const lo = a.min ?? (a.input === "scale" ? 1 : undefined), hi = a.max ?? (a.input === "scale" ? 5 : undefined);
    const range = lo !== undefined && hi !== undefined ? `from ${a.low ? `${lo} (${a.low})` : lo} to ${a.high ? `${hi} (${a.high})` : hi}` : lo !== undefined ? `at least ${lo}` : hi !== undefined ? `at most ${hi}` : "";
    out.push([typeof ans === "number" ? `**${ans}**` : none, range].filter((x) => x).join(" · "));
  }
  if (words) {
    while (out.at(-1) === "") out.pop();
    out.push(...(out.length ? [""] : []), "_In the reader's words:_", "", words.split("\n").map((l) => "> " + l).join("\n"));
  }
  if (a.required) out.push("", "_required_");
  return out.join("\n");
}

/** A question as a note: its text the Markdown a reader without controls
 * shows (`sagebrush board render`), and the question itself with it, `ask`,
 * for a reader that has controls (the board: board.ts). */
export function askNote(a: DocAsk): DocNote & { ask: DocAsk } {
  return { ...strip({ id: a.id, title: a.title, text: askMarkdown(a), detail: a.detail, color: a.color, x: a.x, y: a.y, w: a.w ?? 320, h: a.h }), ask: a };
}

/**
 * Place a board's nodes: returns the renderer's items (groups, notes) and
 * edges, in world coordinates.
 */
export function layout(doc: BoardDoc, measure?: Measure, opts: { deferRoutes?: boolean } = {}): { items: Item[]; edges: Edge[]; routing: Generator<void, void> } {
  // (the "spring" layout's seed: the board's, its first 32 bits; none, 0)
  const springSeed = typeof doc.seed === "string" && /^[0-9a-f]{8}/.test(doc.seed) ? parseInt(doc.seed.slice(0, 8), 16) : 0;
  if (doc.pages?.length) doc = pageView(doc, 0);
  const roots = doc.nodes ?? [];
  const items: Item[] = [];
  const parentOf = new Map<string, string>(); // node id -> the group directly holding it
  const ids = new Set<string>();
  const walk = (n: DocNode, parent: string | null) => {
    if (ids.has(n.id)) throw new Error(`board: two nodes with id ${n.id}`);
    ids.add(n.id);
    if (parent) parentOf.set(n.id, parent);
    if (n.kind === "group") for (const c of n.children) walk(c, n.id);
  };
  for (const n of roots) walk(n, null);
  // links: absolute, or paths under the document's refBase
  const refOf = (n: DocNote) => n.ref && doc.refBase && !/^([a-z]+:|#)/i.test(n.ref) ? doc.refBase + n.ref : n.ref;
  // (a note's picture: its name and size, and where its bytes are when not in this browser)
  const imgOf = (n: DocNote) => { const i = n.image ? getOwn(doc.images, n.image) : undefined; return i ? { key: n.image!, ...i } : undefined; };
  const edges = (doc.edges ?? []).filter((e) => ids.has(e.from) && ids.has(e.to) && e.from !== e.to);
  // the member of `members` that holds node `id` (itself, or a group around it)
  const memberOf = (id: string, members: Set<string>): string | null => {
    for (let x: string | undefined = id; x; x = parentOf.get(x)) if (members.has(x)) return x;
    return null;
  };

  // sizes, bottom up; positions relative to the parent, top down
  const size = new Map<string, Box>();
  const rel = new Map<string, { x: number; y: number }>();
  const innerTop = new Map<string, number>(); // a group's members' origin, below its title
  const sizeOf = (n: DocNode): Box => {
    // (a question: as a note saying it, its options and its answer)
    if (n.kind === "ask") n = askNote(n);
    if (n.kind === "ink") {
      const b = inkSize(n);
      size.set(n.id, b);
      return b;
    }
    if (n.kind === "sticker") {
      // (square, as wide as it says)
      const w = n.w ?? STICKER_SIZE, b = { w, h: w };
      size.set(n.id, b);
      return b;
    }
    if (n.kind !== "group") {
      const b = noteSize(n, measure && Object.assign((m: DocNote, w: number) => measure({ ...m, ref: refOf(m), img: imgOf(m) }, w), { width: measure.width && ((m: DocNote, w: number) => measure.width!({ ...m, ref: refOf(m), img: imgOf(m) }, w)) }), imgOf(n));
      size.set(n.id, b);
      return b;
    }
    const kids = n.children.map((c) => ({ c, b: sizeOf(c) }));
    // (its members: once, not once an edge, which on a large board was a set of every item for each edge)
    const members = new Set(n.children.map((c) => c.id));
    const pos = arrange(kids.map((k) => ({ id: k.c.id, ...k.b, fixed: k.c.x !== undefined && k.c.y !== undefined ? { x: k.c.x!, y: k.c.y! } : null, ink: k.c.kind === "ink" })), n.layout ?? "graph", n.direction ?? "TB", n.columns,
      edges.flatMap((e) => {
        const a = memberOf(e.from, members), b = memberOf(e.to, members);
        return a && b && a !== b ? [[a, b, labelWidth(e)] as Link] : [];
      }), springSeed);
    // (a group's members start at its origin: all of them, strokes too, as
    // the editor keeps a group around its members, Editor.contain, UI-FD2-1;
    // but in a group a person sized, members placed stay where they are in
    // it, as the editor leaves them (compact() does not close it up when one
    // leaves), only those above or left of its origin brought in, B3)
    let minX = Math.min(...[...pos.values()].map((p) => p.x)), minY = Math.min(...[...pos.values()].map((p) => p.y));
    if ((n.w !== undefined || n.h !== undefined) && n.children.some((c) => c.x !== undefined && c.y !== undefined)) { minX = Math.min(0, minX); minY = Math.min(0, minY); }
    if (kids.length) for (const [id, p] of pos) pos.set(id, { x: p.x - minX, y: p.y - minY });
    let w = 0, h = 0;
    for (const k of kids) {
      const p = pos.get(k.c.id)!;
      w = Math.max(w, p.x + k.b.w);
      h = Math.max(h, p.y + k.b.h);
    }
    // (as large as its items need, or as a person made it, whichever is larger, B3)
    const bw = Math.max(w + 2 * PAD, 200, n.w ?? 0);
    const top = PAD + (n.title ? TITLE : 0) + (n.text ? (measure ? measure({ id: n.id, text: n.text }, bw - 2 * PAD) : 28) + 8 : 0);
    innerTop.set(n.id, top);
    for (const k of kids) {
      const p = pos.get(k.c.id)!;
      rel.set(k.c.id, { x: PAD + p.x, y: top + p.y });
    }
    const b = { w: bw, h: Math.max(h + top + PAD, n.h ?? 0) };
    size.set(n.id, b);
    return b;
  };
  const top = roots.map((n) => ({ id: n.id, ...sizeOf(n), fixed: n.x !== undefined && n.y !== undefined ? { x: n.x!, y: n.y! } : null, ink: n.kind === "ink" }));
  const rootIds = new Set(roots.map((n) => n.id));
  const topPos = arrange(top, doc.layout ?? "graph", doc.direction ?? "TB", doc.columns, edges.flatMap((e) => {
    const a = memberOf(e.from, rootIds), b = memberOf(e.to, rootIds);
    return a && b && a !== b ? [[a, b, labelWidth(e)] as Link] : [];
  }), springSeed);

  // absolute positions, and the items
  const place = (n: DocNode, x: number, y: number, depth: number, parent?: string) => {
    const b = size.get(n.id)!;
    if (n.kind === "ask") n = askNote(n);
    if (n.kind === "group") {
      items.push({ id: n.id, kind: "group", x, y, w: b.w, h: b.h, title: n.title, text: n.text, color: n.color, depth, parent, inner: { x: x + PAD, y: y + innerTop.get(n.id)! }, ...(n.children.length ? {} : { empty: true }) });
      for (const c of n.children) {
        const p = rel.get(c.id)!;
        place(c, x + p.x, y + p.y, depth + 1, n.id);
      }
    } else if (n.kind === "sticker") {
      items.push({ id: n.id, kind: "sticker", x, y, w: b.w, h: b.h, ...(n.emoji ? { emoji: n.emoji } : {}), ...(n.icon ? { icon: n.icon } : {}), color: n.color, depth, parent });
    } else if (n.kind === "ink") {
      // (its outline, from its corner)
      items.push({ id: n.id, kind: "ink", x, y, w: b.w, h: b.h, outline: outlineOf(n), width: n.size ?? INK_SIZE, color: n.color, depth, parent, ...(n.opacity !== undefined ? { opacity: n.opacity } : {}) });
    } else {
      const img = imgOf(n);
      items.push({ id: n.id, kind: "note", x, y, w: b.w, h: b.h, title: n.title, ...(img ? { image: img } : {}), ...((n as { ask?: DocAsk }).ask ? { ask: (n as { ask?: DocAsk }).ask } : {}), text: n.text, detail: n.detail, ref: refOf(n), color: n.color, depth, parent, ...(n.shape ? { shape: n.shape } : {}), ...(n.code !== undefined ? { code: n.code, ...(n.hideCode ? { hideCode: true } : {}), ...(n.mode ? { mode: n.mode } : {}), ...((n.mode ?? doc.mode ?? "python") !== (doc.mode ?? "python") ? { lang: n.mode } : {}) } : {}) });
    }
  };
  for (const n of roots) {
    const p = topPos.get(n.id)!;
    place(n, p.x, p.y, 0);
  }
  const srcOf = new Map((doc.edges ?? []).map((e, i) => [e, i]));
  const out: Edge[] = edges.filter((e) => !e.hidden).map((e, i) => ({ id: `e${i}`, from: e.from, to: e.to, label: e.label, src: srcOf.get(e), ...(e.arrow ? { arrow: e.arrow } : {}), ...(e.line ? { line: e.line } : {}) }));
  // the edges' routes: now, or (deferRoutes) as the caller runs `routing`;
  // edges are straight until then
  const routing = routeEdges(doc, items, out, parentOf);
  if (!opts.deferRoutes) for (;;) if (routing.next().done) break;
  return { items, edges: out, routing };
}

// Each edge's route around everything it does not belong to (not pen
// strokes, which it crosses): the outermost
// boxes not holding either end (a group holding an end is entered, and its
// other members are what to go around), along the axis of the layout of the
// smallest group holding both ends.
function* routeEdges(doc: BoardDoc, items: Item[], edges: Edge[], parentOf: Map<string, string>): Generator<void, void> {
  if (!edges.length) return;
  const roots = doc.nodes ?? [];
  const byId = new Map(items.map((it) => [it.id, it]));
  // (each item's box made once, shared by every edge's obstacles)
  const rects = new Map<string, Rect>();
  const rect = (id: string): Rect => { let r = rects.get(id); if (!r) { const it = byId.get(id)!; rects.set(id, (r = { x0: it.x, y0: it.y, x1: it.x + it.w, y1: it.y + it.h })); } return r; };
  const ancestors = (id: string) => { const s = new Set<string>(); for (let p = parentOf.get(id); p; p = parentOf.get(p)) s.add(p); return s; };
  const groups = new Map<string, DocGroup>();
  const walk = (ns: DocNode[]) => { for (const n of ns) if (n.kind === "group") { groups.set(n.id, n); walk(n.children); } };
  walk(roots);
  const axisOf = (g: { layout?: DocGroup["layout"]; direction?: DocGroup["direction"] }): "h" | "v" | undefined => {
    const l = g.layout ?? "graph";
    return l === "row" ? "h" : l === "column" ? "v" : l === "graph" ? (g.direction === "LR" ? "h" : "v") : undefined;
  };
  // a group's title and text: kept clear by the edges entering it, and by labels
  const header = (id: string): Rect | null => {
    const it = byId.get(id)!, g = groups.get(id)!;
    if (!it.inner || (!g.title && !g.text)) return null;
    const w = Math.max(g.title ? g.title.length * 9.5 + 48 : 0, g.text ? Math.min(it.w, 600) : 0);
    return { x0: it.x, y0: it.y, x1: it.x + Math.min(it.w, w), y1: it.inner.y - 10 };
  };
  const reqs: RouteRequest[] = [];
  // (the edges drawn straight, spring containers': their points and label)
  const lines = new Map<string, { points: number[]; label: { x: number; y: number } }>();
  let made = 0;
  for (const e of edges) {
    // (between frames, a large board's every 32: each scans the page)
    if (++made % 32 === 0) yield;
    const A = ancestors(e.from), B = ancestors(e.to);
    if (A.has(e.to) || B.has(e.from)) continue; // a group and its member: no line
    // the smallest group holding both: its layout's axis
    let common: string | undefined;
    for (const p of A) if (B.has(p)) { common = p; break; }
    const container = common ? groups.get(common)! : doc;
    // (in a "spring" container: a straight line between the two boxes, as
    // William chose; laid out by no layer direction, it has no axis to bend along)
    if (container.layout === "spring") {
      const line = straight(rect(e.from), rect(e.to));
      if (line) { lines.set(e.id, line); continue; }
    }
    const obstacles: Rect[] = [];
    const scan = (ns: DocNode[]) => {
      for (const n of ns) {
        // (not pen strokes: an edge crosses them, design/board.md)
        if (n.id === e.from || n.id === e.to || n.kind === "ink") continue;
        if (A.has(n.id) || B.has(n.id)) {
          const hd = header(n.id);
          if (hd) obstacles.push(hd);
          scan((n as DocGroup).children);
        }
        else obstacles.push(rect(n.id));
      }
    };
    scan(roots);
    const axis = axisOf(container);
    reqs.push({ id: e.id, a: rect(e.from), b: rect(e.to), obstacles, axis, label: e.label ? { w: e.label.length * 6.8 + 14, h: 20 } : undefined });
  }
  const keepClear = items.filter((it) => it.kind === "note").map((it) => ({ x0: it.x, y0: it.y, x1: it.x + it.w, y1: it.y + it.h }) as Rect);
  for (const id of groups.keys()) { const hd = header(id); if (hd) keepClear.push(hd); }
  const routes = yield* routeSteps(reqs, keepClear);
  // (all at once: an edge keeps the route it was given until now, if any)
  for (const e of edges) {
    const r = routes.get(e.id) ?? lines.get(e.id);
    delete e.points; delete e.lx; delete e.ly;
    if (!r) continue;
    e.points = r.points;
    if (r.label) { e.lx = r.label.x; e.ly = r.label.y; }
  }
}

/** A straight edge from box `a` to box `b`: the segment between their
 * centres, from where it leaves `a` to where it enters `b`, so an
 * arrowhead touches the box; its label at the segment's middle.  Null when
 * there is no such segment (the boxes overlap, or share a centre): the edge
 * is then routed as any other. */
export function straight(a: Rect, b: Rect): { points: number[]; label: { x: number; y: number } } | null {
  const ca = [(a.x0 + a.x1) / 2, (a.y0 + a.y1) / 2], cb = [(b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2];
  const dx = cb[0] - ca[0], dy = cb[1] - ca[1];
  if (!(Math.abs(dx) > 1e-9 || Math.abs(dy) > 1e-9)) return null;
  // (how far along from centre c, towards (sx, sy), the box's border is: the nearer of its two crossings)
  const out = (r: Rect, c: number[], sx: number, sy: number) => {
    const tx = Math.abs(sx) > 1e-9 ? ((sx > 0 ? r.x1 : r.x0) - c[0]) / sx : Infinity;
    const ty = Math.abs(sy) > 1e-9 ? ((sy > 0 ? r.y1 : r.y0) - c[1]) / sy : Infinity;
    return Math.min(tx, ty);
  };
  const ta = out(a, ca, dx, dy), tb = 1 - out(b, cb, -dx, -dy);
  // (the boxes meet or overlap along the line: no segment between them)
  if (!(ta < tb)) return null;
  const p = [ca[0] + dx * ta, ca[1] + dy * ta, ca[0] + dx * tb, ca[1] + dy * tb];
  return { points: p, label: { x: (p[0] + p[2]) / 2, y: (p[1] + p[3]) / 2 } };
}

// (`ink`: a pen stroke, which takes no part in the layout: where it was
// drawn, never laid out, and never what the others are placed beside, B1)
interface Node { id: string; w: number; h: number; fixed: { x: number; y: number } | null; ink?: boolean }

// Positions (top left, relative) for boxes in one container.
// an edge between two boxes laid out together: from, to, its label's width
type Link = [string, string, number];
/** The width an edge's label takes (12 px text). */
export const labelWidth = (e: { label?: string; hidden?: boolean }) => (e.label && !e.hidden ? e.label.length * 6.8 + 14 : 0);

function arrange(all: Node[], kind: NonNullable<DocGroup["layout"]>, dir: "TB" | "LR", columns: number | undefined, allLinks: Link[], seed = 0): Map<string, { x: number; y: number }> {
  const out = new Map<string, { x: number; y: number }>();
  // (positioned boxes keep their places; the others are laid out among themselves)
  const nodes = all.filter((n) => !n.fixed && !n.ink), free = new Set(nodes.map((n) => n.id));
  const links = allLinks.filter(([a, b]) => free.has(a) && free.has(b));
  if (kind === "row" || kind === "column") {
    let at = 0;
    for (const n of nodes) {
      out.set(n.id, kind === "row" ? { x: at, y: 0 } : { x: 0, y: at });
      at += (kind === "row" ? n.w : n.h) + GAP;
    }
  } else if (kind === "grid") {
    for (const [id, p] of grid(nodes, Math.max(1, columns ?? Math.ceil(Math.sqrt(nodes.length))))) out.set(id, p);
  } else if (kind === "spring" && nodes.length) {
    // (web/graph/spring.ts, the board's seed: the same board, the same
    // places, on every runtime; past its caps, null: laid out as a graph)
    const p = springLayout(nodes.map((n) => ({ id: n.id, w: n.w, h: n.h })), links.map(([a, b]) => [a, b] as [string, string]), { seed, gap: GAP, length: SPRING_LENGTH });
    for (const [id, q] of p ?? graph(nodes, links, dir)) out.set(id, q);
  } else {
    for (const [id, p] of graph(nodes, links, dir)) out.set(id, p);
  }
  // (placed beside the positioned ones, when there are both: not beside a
  // pen stroke, which would move them all when one is drawn, B1)
  const fixed = all.filter((n) => n.fixed && !n.ink);
  if (fixed.length && nodes.length) {
    const right = Math.max(...fixed.map((n) => n.fixed!.x + n.w)) + GAP * 2, top = Math.min(...fixed.map((n) => n.fixed!.y));
    for (const [id, p] of out) out.set(id, { x: p.x + right, y: p.y + top });
  }
  for (const n of all) if (n.fixed) out.set(n.id, n.fixed);
  for (const n of all) if (n.ink && !n.fixed) out.set(n.id, { x: 0, y: 0 });
  return out;
}

// A grid of `cols` columns, in order: columns as wide as the widest box;
// each row as tall as its own tallest, so one tall box, a plot, leaves no
// gaps in the other rows.
function grid(nodes: Node[], cols: number): Map<string, { x: number; y: number }> {
  const out = new Map<string, { x: number; y: number }>();
  const cw = Math.max(...nodes.map((n) => n.w), 0), rows: number[] = [];
  nodes.forEach((n, i) => { const r = Math.floor(i / cols); rows[r] = Math.max(rows[r] ?? 0, n.h); });
  const top = [0];
  for (const h of rows) top.push(top[top.length - 1] + h + GAP);
  nodes.forEach((n, i) => out.set(n.id, { x: (i % cols) * (cw + GAP), y: top[Math.floor(i / cols)] }));
  return out;
}

// A graph: one layered layout when its items are all linked, one part (or
// up to four items with no edges, a row, as ever).  Else (friction 5: two
// dozen items, a few of them linked, came out as one row many screens wide,
// every part's first layer and every lone item side by side): each linked
// part laid out on its own, the items with no edges as one grid, and the
// parts, in reading order, packed in rows (top to bottom; with "LR", in
// columns) that wrap, about half again as wide as tall.
function graph(nodes: Node[], links: Link[], dir: "TB" | "LR"): Map<string, { x: number; y: number }> {
  const root = new Map(nodes.map((n) => [n.id, n.id]));
  const find = (v: string): string => { while (root.get(v) !== v) { root.set(v, root.get(root.get(v)!)!); v = root.get(v)!; } return v; };
  const linked = new Set<string>();
  for (const [a, b] of links) if (a !== b) { linked.add(a); linked.add(b); root.set(find(a), find(b)); }
  const parts = new Map<string, Node[]>(), alone: Node[] = [];
  for (const n of nodes) {
    if (!linked.has(n.id)) alone.push(n);
    else { const r = find(n.id); (parts.get(r) ?? parts.set(r, []).get(r)!).push(n); }
  }
  if ((parts.size === 1 && !alone.length) || (!parts.size && alone.length <= 4)) return layered(nodes, links, dir);
  // the blocks, in the order of their first items
  type Block = { first: number; pos: Map<string, { x: number; y: number }>; w: number; h: number };
  const order = new Map(nodes.map((n, i) => [n.id, i]));
  const block = (ns: Node[], pos: Map<string, { x: number; y: number }>): Block => ({
    first: Math.min(...ns.map((n) => order.get(n.id)!)), pos,
    w: Math.max(...ns.map((n) => pos.get(n.id)!.x + n.w)), h: Math.max(...ns.map((n) => pos.get(n.id)!.y + n.h)),
  });
  const blocks: Block[] = [...parts.values()].map((ns) => { const ids = new Set(ns.map((n) => n.id)); return block(ns, layered(ns, links.filter(([a]) => ids.has(a)), dir)); });
  if (alone.length) blocks.push(block(alone, grid(alone, alone.length <= 4 ? alone.length : Math.ceil(Math.sqrt(alone.length * 1.5)))));
  blocks.sort((a, b) => a.first - b.first);
  // packed: along rows (TB) or columns (LR) as long as the longest block or
  // the square root of their area, half again as wide as tall
  const tb = dir === "TB", area = blocks.reduce((s, b) => s + (b.w + 2 * GAP) * (b.h + 2 * GAP), 0);
  const limit = tb ? Math.max(...blocks.map((b) => b.w), Math.sqrt(area * 1.5)) : Math.max(...blocks.map((b) => b.h), Math.sqrt(area / 1.5));
  const out = new Map<string, { x: number; y: number }>();
  let u = 0, v = 0, depth = 0; // along the row, the row's start across, its depth
  for (const b of blocks) {
    const len = tb ? b.w : b.h, deep = tb ? b.h : b.w;
    if (u > 0 && u + len > limit) { v += depth + 2 * GAP; u = 0; depth = 0; }
    for (const [id, p] of b.pos) out.set(id, tb ? { x: u + p.x, y: v + p.y } : { x: v + p.x, y: u + p.y });
    u += len + 2 * GAP;
    depth = Math.max(depth, deep);
  }
  return out;
}

// A layered (Sugiyama-style) layout: cycles broken, layers by longest path,
// orders by barycenters (sweeps down and up), each layer centered.
function layered(nodes: Node[], links: Link[], dir: "TB" | "LR"): Map<string, { x: number; y: number }> {
  const ids = nodes.map((n) => n.id);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const uniq = new Map<string, [string, string]>();
  for (const [a, b] of links) uniq.set(a + "\u0000" + b, [a, b]);
  // break cycles: drop the edges a depth-first search finds going back
  const out = new Map<string, string[]>(ids.map((i) => [i, []]));
  for (const [a, b] of uniq.values()) out.get(a)!.push(b);
  const state = new Map<string, number>(), dag: [string, string][] = [];
  const dfs = (v: string) => {
    state.set(v, 1);
    for (const w of out.get(v)!) {
      if (state.get(w) === 1) continue; // a back edge: left out of the layering
      dag.push([v, w]);
      if (!state.has(w)) dfs(w);
    }
    state.set(v, 2);
  };
  for (const v of ids) if (!state.has(v)) dfs(v);
  // layers: the longest path from a source
  const preds = new Map<string, string[]>(ids.map((i) => [i, []]));
  for (const [a, b] of dag) preds.get(b)!.push(a);
  const layer = new Map<string, number>();
  const depth = (v: string): number => {
    if (layer.has(v)) return layer.get(v)!;
    layer.set(v, 0);
    const d = preds.get(v)!.length ? Math.max(...preds.get(v)!.map((p) => depth(p) + 1)) : 0;
    layer.set(v, d);
    return d;
  };
  for (const v of ids) depth(v);
  const layers: string[][] = [];
  for (const v of ids) (layers[layer.get(v)!] ??= []).push(v);
  // orders: barycenters of the neighbors in the layer before (down) or after (up)
  const succs = new Map<string, string[]>(ids.map((i) => [i, []]));
  for (const [a, b] of dag) succs.get(a)!.push(b);
  const index = new Map<string, number>();
  const reindex = () => layers.forEach((l) => l.forEach((v, i) => index.set(v, i)));
  reindex();
  for (let sweep = 0; sweep < 6; sweep++) {
    const down = sweep % 2 === 0;
    const order = down ? layers.slice(1) : layers.slice(0, -1).reverse();
    for (const l of order) {
      const bc = new Map(l.map((v) => {
        const ns = down ? preds.get(v)! : succs.get(v)!;
        return [v, ns.length ? ns.reduce((s, u) => s + index.get(u)!, 0) / ns.length : index.get(v)!];
      }));
      l.sort((a, b) => bc.get(a)! - bc.get(b)!);
      reindex();
    }
  }
  // coordinates: layers stacked along the direction; across it, each node
  // as near the middle of its neighbors in the layer before as the order
  // and the gaps allow (sweeps down and up), so edges run straight
  const along = (n: Node) => (dir === "TB" ? n.h : n.w), across = (n: Node) => (dir === "TB" ? n.w : n.h);
  const size = (v: string) => across(byId.get(v)!);
  const spans = layers.map((l) => l.reduce((s, v) => s + size(v), 0) + GAP * Math.max(0, l.length - 1));
  const widest = Math.max(...spans, 0);
  const center = new Map<string, number>();
  layers.forEach((l, k) => {
    let c = (widest - spans[k]) / 2;
    for (const v of l) { center.set(v, c + size(v) / 2); c += size(v) + GAP; }
  });
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  for (let sweep = 0; sweep < 8; sweep++) {
    const down = sweep % 2 === 0;
    for (const l of down ? layers.slice(1) : layers.slice(0, -1).reverse()) {
      const want = l.map((v) => { const ns = down ? preds.get(v)! : succs.get(v)!; return ns.length ? mean(ns.map((u) => center.get(u)!)) : center.get(v)!; });
      fit(want, l.map(size)).forEach((c, i) => center.set(l[i], c));
    }
  }
  const lo = Math.min(...[...center].map(([v, c]) => c - size(v) / 2));
  const pos = new Map<string, { x: number; y: number }>();
  let at = 0;
  // (the gap after a layer fits the labels of the edges crossing it: left
  // to right, their width; top to bottom, their height)
  const gapAfter = layers.map(() => GAP * 2);
  for (const [a, b, w] of links) {
    const la = layer.get(a)!, lb = layer.get(b)!;
    if (w && Math.abs(la - lb) === 1) gapAfter[Math.min(la, lb)] = Math.max(gapAfter[Math.min(la, lb)], (dir === "LR" ? w : 20) + 64);
  }
  layers.forEach((l, k) => {
    for (const v of l) {
      const c = center.get(v)! - size(v) / 2 - lo;
      pos.set(v, dir === "TB" ? { x: c, y: at } : { x: at, y: c });
    }
    at += Math.max(...l.map((v) => along(byId.get(v)!))) + gapAfter[k];
  });
  return pos;
}

// The centers nearest `want` (least squares) for boxes of `sizes` in this
// order, at least GAP apart: an isotonic regression, by pooling adjacent
// violators, of the wanted centers less each box's least offset.
function fit(want: number[], sizes: number[]): number[] {
  const off = [0];
  for (let i = 1; i < sizes.length; i++) off.push(off[i - 1] + (sizes[i - 1] + sizes[i]) / 2 + GAP);
  const blocks: { sum: number; n: number }[] = [];
  for (let i = 0; i < want.length; i++) {
    blocks.push({ sum: want[i] - off[i], n: 1 });
    while (blocks.length > 1 && blocks[blocks.length - 2].sum / blocks[blocks.length - 2].n > blocks[blocks.length - 1].sum / blocks[blocks.length - 1].n) {
      const b = blocks.pop()!;
      blocks[blocks.length - 1].sum += b.sum;
      blocks[blocks.length - 1].n += b.n;
    }
  }
  const out: number[] = [];
  for (const b of blocks) for (let k = 0; k < b.n; k++) out.push(b.sum / b.n + off[out.length]);
  return out;
}
