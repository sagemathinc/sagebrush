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
export interface DocNote {
  id: string;
  kind?: "note";
  title?: string;
  /** a picture: its name in the document's `images` (images.ts) */
  image?: string;
  /** Markdown with math ($...$), shown at every zoom */
  text?: string;
  /** Python, run on the board's interpreter (reactive, as a notebook's cells:
   * web/board/code.ts), its output under it: a note with code is a code item.
   * (Documents before October 13, 2026 also said `kind: "code"`.) */
  code?: string;
  /** show only the code's output, not the code */
  hideCode?: boolean;
  /** a slow code item's output, kept to show before it runs (preview.ts,
   * design/outputs.md); last in the file */
  preview?: Preview;
  /** Markdown shown only when zoomed in (semantic zoom) */
  detail?: string;
  /** a link: a source file (path#Lline), a paper, a page */
  ref?: string;
  color?: string;
  /** its outline (a flowchart's: Mermaid's shapes); its text is then centered */
  shape?: NoteShape;
  /** as wide as its text needs, up to `w` (default 260), rather than `w` */
  fit?: boolean;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
}

export type NoteShape = "rect" | "round" | "stadium" | "circle" | "diamond" | "hexagon" | "cylinder" | "subroutine" | "lean-right" | "lean-left" | "trapezoid" | "inv-trapezoid" | "flag";

export interface DocGroup {
  id: string;
  kind: "group";
  title?: string;
  text?: string;
  layout?: "row" | "column" | "grid" | "graph";
  /** grid layout: how many columns (default: as square as can be) */
  columns?: number;
  /** graph layout: layers top to bottom (TB, the default) or left to right (LR) */
  direction?: "TB" | "LR";
  children: DocNode[];
  color?: string;
  x?: number;
  y?: number;
}

// A pen stroke (ink.ts): where the pen went, with its pressure, drawn as
// an outline whose width follows it.  (x, y) is the corner of its box, the
// points' extent and the pen's size around it; the points are measured from
// that corner.
export interface DocInk {
  id: string;
  kind: "ink";
  /** x, y, pressure (0 to 1), ...: as drawn (streamlined, a mouse's
   * pressure from its speed: ink.ts InkCapture), so drawn as they are */
  points: number[];
  /** the pen's width (each stroke says: a later default changes no old one) */
  size?: number;
  color?: string;
  /** below 1: a highlighter's, which what is under it shows through */
  opacity?: number;
  x: number;
  y: number;
}

// A sticker (stickers.ts): an emoji, or a CoCalc icon by name, shown
// without a frame, as wide as `w` (default 64).  (A picture alone is a
// note with only a picture.)
export interface DocSticker {
  id: string;
  kind: "sticker";
  /** one emoji (one grapheme) */
  emoji?: string;
  /** one of CoCalc's icons, by name (a converted CoCalc board), and its color */
  icon?: string;
  color?: string;
  x?: number;
  y?: number;
  w?: number;
}

export type DocNode = DocNote | DocGroup | DocInk | DocSticker;

/** A slide's card on its page (board coordinates). */
export interface SlideRect { x: number; y: number; w: number; h: number }
/** A page's background: a color; a picture's name in `images`. */
export interface PageBackground { color?: string; image?: string }

export interface DocEdge {
  from: string;
  to: string;
  label?: string;
  /** used to lay out, not drawn (to place one box below another) */
  hidden?: boolean;
  /** arrowheads: at the end (the default), none, or both ends */
  arrow?: "none" | "both";
  line?: "dotted" | "thick";
}

/** A step of a tour: the camera shows these items while the caption explains them. */
export interface DocStep {
  focus: string | string[];
  /** Markdown */
  say?: string;
}

/** A page of a board: its own notes, edges and tour. */
export interface BoardPage {
  id?: string;
  title?: string;
  intro?: string;
  layout?: DocGroup["layout"];
  columns?: number;
  direction?: DocGroup["direction"];
  /** a slide: the card (16:9, say) the page is arranged on, which Present shows */
  slide?: SlideRect;
  /** the page's background: a color (on the card, or behind the whole board); a picture (on a slide's card) */
  background?: PageBackground;
  /** a template: other pages can be made from it (it needs an id) */
  template?: boolean;
  /** made from this template page (its id): its card, background and items under the page's own */
  uses?: string;
  nodes: DocNode[];
  edges?: DocEdge[];
  steps?: DocStep[];
}

/** What a board document says it is (written first in every document):
 * `{ format: "sagebrush-board", version: 1, ... }`.  A document without it
 * is taken as version 1 (boards written before October 13, 2026). */
export const FORMAT = "sagebrush-board";
export const VERSION = 1;

/** a board's language (BoardDoc.mode) */
export type BoardMode = "python" | "sage" | "magma" | "matlab";
const MODES = ["sage", "magma", "matlab"] as const;

export interface BoardDoc {
  format?: typeof FORMAT;
  /** the format's version: 1 */
  version?: number;
  title?: string;
  /** the language of its code items: Python (the default), Sage, Magma or MATLAB (one per board) */
  mode?: BoardMode;
  /** in a downloaded file (export.ts, engine.ts), the engine its code runs
   * with: the latest, when online; else (the default) the one it was saved with */
  engine?: "latest";
  /** the seed of its code's random numbers (64 hex digits): each code item
   * draws from the hash of it and the item's id, so the same board draws the
   * same numbers, and its outputs can be cached (design/outputs.md); a board
   * without one uses BOARD_SEED */
  seed?: string;
  /** the toolbar's tools in Edit mode (toolbar.ts), in order; else the person's default */
  tools?: string[];
  /** the pictures notes show, by name: each one's size (and its bytes, as a
   * data: URL, in a board that left the browser: images.ts) */
  images?: Record<string, ImageInfo>;
  /** pages, each with its own nodes, edges and steps; without them the
   * document is one page (its own nodes, edges and steps) */
  pages?: BoardPage[];
  /** Markdown, shown before the tour starts */
  intro?: string;
  /** links' base for refs that are paths (e.g. a repository's blob URL) */
  refBase?: string;
  layout?: DocGroup["layout"];
  columns?: number;
  direction?: DocGroup["direction"];
  /** a slide: the card (16:9, say) the page is arranged on, which Present shows */
  slide?: SlideRect;
  /** the page's background: a color (on the card, or behind the whole board); a picture (on a slide's card) */
  background?: PageBackground;
  /** (a document with pages has none of its own) */
  nodes?: DocNode[];
  edges?: DocEdge[];
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

/** Page i as a one-page document, for layout() (the document's title, refBase and pictures). */
export function pageView(d: BoardDoc, i: number): BoardDoc {
  const p = pageOf(d, i);
  if (p === (d as BoardPage)) return d;
  return { title: d.title, refBase: d.refBase, images: d.images, intro: p.intro, layout: p.layout, columns: p.columns, direction: p.direction, slide: p.slide, background: p.background, nodes: p.nodes, edges: p.edges, steps: p.steps };
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
const LAYOUTS = ["row", "column", "grid", "graph"] as const, DIRS = ["TB", "LR"] as const;
// (a picture's name, and where its bytes may be: a raster image's data: URL, or an https: address)
const IMAGE_NAME = /^[\w-]{1,100}$/;
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
    out[k] = v.src !== undefined ? { w, h, src: v.src } : { w, h };
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

export function cleanDoc(d: any): BoardDoc {
  const node = (n: any): DocNode | null => {
    if (!n || typeof n !== "object" || n.id == null) return null;
    if (n.kind === "group") {
      return strip({ id: String(n.id), kind: "group" as const, title: str(n.title), text: str(n.text), layout: one(n.layout, LAYOUTS), columns: num(n.columns), direction: one(n.direction, DIRS),
        children: (Array.isArray(n.children) ? n.children : []).map(node).filter((c: DocNode | null): c is DocNode => !!c), color: safeColor(n.color), x: num(n.x), y: num(n.y) });
    }
    // (a stroke: its points as numbers, three a point, and its place; else none)
    if (n.kind === "ink") {
      const ps = Array.isArray(n.points) ? n.points.slice(0, n.points.length - (n.points.length % 3)) : [];
      if (!ps.length || !ps.every((v: unknown) => typeof v === "number" && Number.isFinite(v)) || num(n.x) === undefined || num(n.y) === undefined) return null;
      const size = num(n.size), opacity = num(n.opacity);
      const world = ps.map((v: number, i: number) => (i % 3 === 0 ? v + n.x : i % 3 === 1 ? v + n.y : v));
      return inkNode(String(n.id), world, { size: size !== undefined && size > 0 && size <= 200 ? size : undefined, color: safeColor(n.color), opacity: opacity !== undefined && opacity > 0 && opacity < 1 ? opacity : undefined });
    }
    // (a sticker: one emoji, or an icon's name; else none)
    if (n.kind === "sticker") {
      const emoji = oneEmoji(n.emoji), icon = typeof n.icon === "string" && ICON_NAME.test(n.icon) ? n.icon : undefined, w = num(n.w);
      if (!emoji && !icon) return null;
      return strip({ id: String(n.id), kind: "sticker" as const, emoji, icon, color: safeColor(n.color), x: num(n.x), y: num(n.y), w: w !== undefined && w >= 8 && w <= 4000 ? w : undefined });
    }
    // (kind "code": the code items of documents before every note could have code)
    const code = n.kind === "code" ? (str(n.code) ?? "") : str(n.code);
    return strip({ id: String(n.id), title: str(n.title), image: typeof n.image === "string" && IMAGE_NAME.test(n.image) ? n.image : undefined, text: str(n.text), code, hideCode: code !== undefined && n.hideCode === true ? true : undefined, detail: str(n.detail), ref: str(n.ref),
      color: safeColor(n.color), shape: SHAPES.has(n.shape) ? (n.shape as NoteShape) : undefined, fit: n.fit === true ? true : undefined,
      x: num(n.x), y: num(n.y), w: num(n.w), h: num(n.h), preview: code !== undefined ? cleanPreview(n.preview) : undefined });
  };
  const page = (p: any) => strip({
    id: str(p?.id), title: str(p?.title), intro: str(p?.intro), layout: one(p?.layout, LAYOUTS), columns: num(p?.columns), direction: one(p?.direction, DIRS),
    slide: slideRect(p?.slide), background: background(p?.background), template: p?.template === true ? true : undefined, uses: str(p?.uses),
    nodes: Array.isArray(p?.nodes) ? p.nodes.map(node).filter((n: DocNode | null): n is DocNode => !!n) : undefined,
    edges: Array.isArray(p?.edges) ? p.edges.filter((e: any) => e && e.from != null && e.to != null).map((e: any) => strip({ from: String(e.from), to: String(e.to), label: str(e.label),
      hidden: e.hidden === true ? true : undefined, arrow: one(e.arrow, ["none", "both"] as const), line: one(e.line, ["dotted", "thick"] as const) })) : undefined,
    steps: Array.isArray(p?.steps) ? p.steps.filter((t: any) => t && (typeof t.focus === "string" || Array.isArray(t.focus))).map((t: any) => strip({ focus: typeof t.focus === "string" ? t.focus : t.focus.map(String), say: str(t.say) })) : undefined,
  });
  const out: any = strip({ format: FORMAT, version: VERSION, ...page(d), title: str(d?.title), mode: one(d?.mode, MODES), engine: d?.engine === "latest" ? "latest" : undefined, seed: typeof d?.seed === "string" && /^[0-9a-f]{64}$/.test(d.seed) ? d.seed : undefined, refBase: str(d?.refBase), tools: Array.isArray(d?.tools) ? d.tools.filter((t: unknown) => typeof t === "string") : undefined, images: cleanImages(d?.images) });
  delete out.id;
  if (Array.isArray(d?.pages)) out.pages = d.pages.map(page);
  // (previews: at most DOC_MAX in all, every page's, SEC-14C-2)
  const notes: DocNote[] = [];
  const walk = (ns: DocNode[] | undefined) => { for (const n of ns ?? []) n.kind === "group" ? walk(n.children) : n.kind !== "ink" && n.kind !== "sticker" && n.preview && notes.push(n); };
  walk(out.nodes);
  for (const p of out.pages ?? []) walk(p.nodes);
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
  const c: any = cleanDoc(d), out: any = {};
  for (const k of DOC_KEYS) if (c[k] !== undefined) out[k] = c[k];
  for (const k of Object.keys(c)) if (!(k in out)) out[k] = c[k];
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

const hasCode = (ns: DocNode[]): boolean => ns.some((n) => (n.kind === "group" ? hasCode(n.children) : n.kind !== "ink" && n.kind !== "sticker" && n.code !== undefined));
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
    for (const it of visit(undefined)) if (it.code !== undefined) out.push({ id: it.id, code: it.code, page: i, item: it.id });
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
export interface CodeCell { id: string; code: string; page: number; item: string }

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

/**
 * Place a board's nodes: returns the renderer's items (groups, notes) and
 * edges, in world coordinates.
 */
export function layout(doc: BoardDoc, measure?: Measure, opts: { deferRoutes?: boolean } = {}): { items: Item[]; edges: Edge[]; routing: Generator<void, void> } {
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
  const refOf = (n: DocNote) => n.ref && doc.refBase && !/^[a-z]+:/i.test(n.ref) ? doc.refBase + n.ref : n.ref;
  // (a note's picture: its name and size, and where its bytes are when not in this browser)
  const imgOf = (n: DocNote) => { const i = n.image ? doc.images?.[n.image] : undefined; return i ? { key: n.image!, ...i } : undefined; };
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
    const pos = arrange(kids.map((k) => ({ id: k.c.id, ...k.b, fixed: k.c.x !== undefined && k.c.y !== undefined ? { x: k.c.x!, y: k.c.y! } : null })), n.layout ?? "graph", n.direction ?? "TB", n.columns,
      edges.flatMap((e) => {
        const a = memberOf(e.from, members), b = memberOf(e.to, members);
        return a && b && a !== b ? [[a, b, labelWidth(e)] as Link] : [];
      }));
    // (a group's members start at its origin)
    const minX = Math.min(...[...pos.values()].map((p) => p.x)), minY = Math.min(...[...pos.values()].map((p) => p.y));
    if (kids.length) for (const [id, p] of pos) pos.set(id, { x: p.x - minX, y: p.y - minY });
    let w = 0, h = 0;
    for (const k of kids) {
      const p = pos.get(k.c.id)!;
      w = Math.max(w, p.x + k.b.w);
      h = Math.max(h, p.y + k.b.h);
    }
    const bw = Math.max(w + 2 * PAD, 200);
    const top = PAD + (n.title ? TITLE : 0) + (n.text ? (measure ? measure({ id: n.id, text: n.text }, bw - 2 * PAD) : 28) + 8 : 0);
    innerTop.set(n.id, top);
    for (const k of kids) {
      const p = pos.get(k.c.id)!;
      rel.set(k.c.id, { x: PAD + p.x, y: top + p.y });
    }
    const b = { w: bw, h: h + top + PAD };
    size.set(n.id, b);
    return b;
  };
  const top = roots.map((n) => ({ id: n.id, ...sizeOf(n), fixed: n.x !== undefined && n.y !== undefined ? { x: n.x!, y: n.y! } : null }));
  const rootIds = new Set(roots.map((n) => n.id));
  const topPos = arrange(top, doc.layout ?? "graph", doc.direction ?? "TB", doc.columns, edges.flatMap((e) => {
    const a = memberOf(e.from, rootIds), b = memberOf(e.to, rootIds);
    return a && b && a !== b ? [[a, b, labelWidth(e)] as Link] : [];
  }));

  // absolute positions, and the items
  const place = (n: DocNode, x: number, y: number, depth: number, parent?: string) => {
    const b = size.get(n.id)!;
    if (n.kind === "group") {
      items.push({ id: n.id, kind: "group", x, y, w: b.w, h: b.h, title: n.title, text: n.text, color: n.color, depth, parent, inner: { x: x + PAD, y: y + innerTop.get(n.id)! } });
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
      items.push({ id: n.id, kind: "note", x, y, w: b.w, h: b.h, title: n.title, ...(img ? { image: img } : {}), text: n.text, detail: n.detail, ref: refOf(n), color: n.color, depth, parent, ...(n.shape ? { shape: n.shape } : {}), ...(n.code !== undefined ? { code: n.code, ...(n.hideCode ? { hideCode: true } : {}) } : {}) });
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
  let made = 0;
  for (const e of edges) {
    // (between frames, a large board's every 32: each scans the page)
    if (++made % 32 === 0) yield;
    const A = ancestors(e.from), B = ancestors(e.to);
    if (A.has(e.to) || B.has(e.from)) continue; // a group and its member: no line
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
    // the smallest group holding both: its layout's axis
    let common: string | undefined;
    for (const p of A) if (B.has(p)) { common = p; break; }
    const axis = axisOf(common ? groups.get(common)! : doc);
    reqs.push({ id: e.id, a: rect(e.from), b: rect(e.to), obstacles, axis, label: e.label ? { w: e.label.length * 6.8 + 14, h: 20 } : undefined });
  }
  const keepClear = items.filter((it) => it.kind === "note").map((it) => ({ x0: it.x, y0: it.y, x1: it.x + it.w, y1: it.y + it.h }) as Rect);
  for (const id of groups.keys()) { const hd = header(id); if (hd) keepClear.push(hd); }
  const routes = yield* routeSteps(reqs, keepClear);
  // (all at once: an edge keeps the route it was given until now, if any)
  for (const e of edges) {
    const r = routes.get(e.id);
    delete e.points; delete e.lx; delete e.ly;
    if (!r) continue;
    e.points = r.points;
    if (r.label) { e.lx = r.label.x; e.ly = r.label.y; }
  }
}

interface Node { id: string; w: number; h: number; fixed: { x: number; y: number } | null }

// Positions (top left, relative) for boxes in one container.
// an edge between two boxes laid out together: from, to, its label's width
type Link = [string, string, number];
/** The width an edge's label takes (12 px text). */
export const labelWidth = (e: { label?: string; hidden?: boolean }) => (e.label && !e.hidden ? e.label.length * 6.8 + 14 : 0);

function arrange(all: Node[], kind: NonNullable<DocGroup["layout"]>, dir: "TB" | "LR", columns: number | undefined, allLinks: Link[]): Map<string, { x: number; y: number }> {
  const out = new Map<string, { x: number; y: number }>();
  // (positioned boxes keep their places; the others are laid out among themselves)
  const nodes = all.filter((n) => !n.fixed), free = new Set(nodes.map((n) => n.id));
  const links = allLinks.filter(([a, b]) => free.has(a) && free.has(b));
  if (kind === "row" || kind === "column") {
    let at = 0;
    for (const n of nodes) {
      out.set(n.id, kind === "row" ? { x: at, y: 0 } : { x: 0, y: at });
      at += (kind === "row" ? n.w : n.h) + GAP;
    }
  } else if (kind === "grid") {
    const cols = Math.max(1, columns ?? Math.ceil(Math.sqrt(nodes.length)));
    const cw = Math.max(...nodes.map((n) => n.w), 0), ch = Math.max(...nodes.map((n) => n.h), 0);
    nodes.forEach((n, i) => out.set(n.id, { x: (i % cols) * (cw + GAP), y: Math.floor(i / cols) * (ch + GAP) }));
  } else {
    for (const [id, p] of layered(nodes, links, dir)) out.set(id, p);
  }
  // (placed beside the positioned ones, when there are both)
  const fixed = all.filter((n) => n.fixed);
  if (fixed.length && nodes.length) {
    const right = Math.max(...fixed.map((n) => n.fixed!.x + n.w)) + GAP * 2, top = Math.min(...fixed.map((n) => n.fixed!.y));
    for (const [id, p] of out) out.set(id, { x: p.x + right, y: p.y + top });
  }
  for (const n of fixed) out.set(n.id, n.fixed!);
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
