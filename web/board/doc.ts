// A board as an agent writes it (design/board.md, "The document"): structure,
// not coordinates.  Notes (Markdown with math) and groups of them, each group
// laid out as a row, a column, a grid, or a layered graph of the edges among
// its members; edges between any two items, with labels.  layout() turns it
// into positioned items for the renderer (board.ts): an item with x and y
// keeps them (a person moved it), the rest are placed.

import type { Item, Edge } from "./board";
import type { ImageInfo } from "./images";
import { routeSteps, type Rect, type RouteRequest } from "./route";

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

export type DocNode = DocNote | DocGroup;

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
  nodes: DocNode[];
  edges?: DocEdge[];
  steps?: DocStep[];
}

export interface BoardDoc {
  title?: string;
  /** the language of its code items: Python (the default) or Sage (one per board) */
  mode?: "python" | "sage";
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

/** Page i as a one-page document, for layout() (the document's title, refBase and pictures). */
export function pageView(d: BoardDoc, i: number): BoardDoc {
  const p = pageOf(d, i);
  if (p === (d as BoardPage)) return d;
  return { title: d.title, refBase: d.refBase, images: d.images, intro: p.intro, layout: p.layout, columns: p.columns, direction: p.direction, nodes: p.nodes, edges: p.edges, steps: p.steps };
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
const IMAGE_SRC = /^(data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=\s]*|https:\/\/[^\s"'<>\\]+)$/;
function cleanImages(m: any): Record<string, ImageInfo> | undefined {
  if (!m || typeof m !== "object" || Array.isArray(m)) return undefined;
  const out: Record<string, ImageInfo> = {};
  for (const [k, v] of Object.entries(m) as [string, any][]) {
    const w = num(v?.w), h = num(v?.h);
    if (!IMAGE_NAME.test(k) || !w || !h || w <= 0 || h <= 0) continue;
    // (a source that is not a raster image's data: URL or an https: address: the picture is dropped)
    if (v.src !== undefined && !(typeof v.src === "string" && IMAGE_SRC.test(v.src))) continue;
    out[k] = v.src !== undefined ? { w, h, src: v.src } : { w, h };
  }
  return Object.keys(out).length ? out : undefined;
}

export function cleanDoc(d: any): BoardDoc {
  const node = (n: any): DocNode | null => {
    if (!n || typeof n !== "object" || n.id == null) return null;
    if (n.kind === "group") {
      return strip({ id: String(n.id), kind: "group" as const, title: str(n.title), text: str(n.text), layout: one(n.layout, LAYOUTS), columns: num(n.columns), direction: one(n.direction, DIRS),
        children: (Array.isArray(n.children) ? n.children : []).map(node).filter((c: DocNode | null): c is DocNode => !!c), color: safeColor(n.color), x: num(n.x), y: num(n.y) });
    }
    // (kind "code": the code items of documents before every note could have code)
    const code = n.kind === "code" ? (str(n.code) ?? "") : str(n.code);
    return strip({ id: String(n.id), title: str(n.title), image: typeof n.image === "string" && IMAGE_NAME.test(n.image) ? n.image : undefined, text: str(n.text), code, hideCode: code !== undefined && n.hideCode === true ? true : undefined, detail: str(n.detail), ref: str(n.ref),
      color: safeColor(n.color), shape: SHAPES.has(n.shape) ? (n.shape as NoteShape) : undefined, fit: n.fit === true ? true : undefined,
      x: num(n.x), y: num(n.y), w: num(n.w), h: num(n.h) });
  };
  const page = (p: any) => strip({
    id: str(p?.id), title: str(p?.title), intro: str(p?.intro), layout: one(p?.layout, LAYOUTS), columns: num(p?.columns), direction: one(p?.direction, DIRS),
    nodes: Array.isArray(p?.nodes) ? p.nodes.map(node).filter((n: DocNode | null): n is DocNode => !!n) : undefined,
    edges: Array.isArray(p?.edges) ? p.edges.filter((e: any) => e && e.from != null && e.to != null).map((e: any) => strip({ from: String(e.from), to: String(e.to), label: str(e.label),
      hidden: e.hidden === true ? true : undefined, arrow: one(e.arrow, ["none", "both"] as const), line: one(e.line, ["dotted", "thick"] as const) })) : undefined,
    steps: Array.isArray(p?.steps) ? p.steps.filter((t: any) => t && (typeof t.focus === "string" || Array.isArray(t.focus))).map((t: any) => strip({ focus: typeof t.focus === "string" ? t.focus : t.focus.map(String), say: str(t.say) })) : undefined,
  });
  const out: any = strip({ ...page(d), title: str(d?.title), mode: d?.mode === "sage" ? "sage" : undefined, refBase: str(d?.refBase), tools: Array.isArray(d?.tools) ? d.tools.filter((t: unknown) => typeof t === "string") : undefined, images: cleanImages(d?.images) });
  delete out.id;
  if (Array.isArray(d?.pages)) out.pages = d.pages.map(page);
  return out as BoardDoc;
}

export const isBoard = (d: any) => !!d && (Array.isArray(d.nodes) || (Array.isArray(d.pages) && d.pages.every((p: any) => Array.isArray(p?.nodes))));

const GAP = 40, PAD = 24, TITLE = 34;

interface Box { w: number; h: number }

/** A note's rendered height at a width (the renderer's measure()), and
 * optionally the width its text needs, up to a most (for `fit` notes). */
export type Measure = ((n: MeasuredNote, w: number) => number) & { width?: (n: MeasuredNote, max: number) => number };
/** A note as measured: with its picture's name and size (`img`). */
export type MeasuredNote = DocNote & { img?: ImageInfo & { key: string } };

// A note's size: given, measured, or estimated from its text's length (about
// 7 px a character, 20 px a line), with room for the title and the link.
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

const hasCode = (ns: DocNode[]): boolean => ns.some((n) => (n.kind === "group" ? hasCode(n.children) : n.code !== undefined));

/**
 * A board's code items in reading order, which is the order they run in
 * (one interpreter for the board, as a notebook's cells): page by page; on
 * a page, top to bottom and then left to right, and a group's items
 * together, where the group is.  The positions are those of a layout with
 * estimated sizes, so that the order does not change as outputs grow.
 */
export function codeOrder(d: BoardDoc): { id: string; code: string }[] {
  const out: { id: string; code: string }[] = [];
  for (let i = 0; i < pageCount(d); i++) {
    const v = pageView(d, i);
    if (!hasCode(v.nodes ?? [])) continue;
    const { items } = layout(v, undefined, { deferRoutes: true });
    const kids = new Map<string | undefined, Item[]>();
    for (const it of items) if (it.kind === "note" || it.kind === "group") (kids.get(it.parent) ?? kids.set(it.parent, []).get(it.parent)!).push(it);
    const visit = (parent: string | undefined): Item[] => rows(kids.get(parent) ?? []).flatMap((it) => (it.kind === "group" ? visit(it.id) : [it]));
    for (const it of visit(undefined)) if (it.code !== undefined) out.push({ id: it.id, code: it.code });
  }
  return out;
}

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
    if (n.kind !== "group") {
      const b = noteSize(n, measure && Object.assign((m: DocNote, w: number) => measure({ ...m, ref: refOf(m), img: imgOf(m) }, w), { width: measure.width && ((m: DocNote, w: number) => measure.width!({ ...m, ref: refOf(m), img: imgOf(m) }, w)) }), imgOf(n));
      size.set(n.id, b);
      return b;
    }
    const kids = n.children.map((c) => ({ c, b: sizeOf(c) }));
    const pos = arrange(kids.map((k) => ({ id: k.c.id, ...k.b, fixed: k.c.x !== undefined && k.c.y !== undefined ? { x: k.c.x!, y: k.c.y! } : null })), n.layout ?? "graph", n.direction ?? "TB", n.columns,
      edges.flatMap((e) => {
        const members = new Set(n.children.map((c) => c.id));
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
  const topPos = arrange(top, doc.layout ?? "graph", doc.direction ?? "TB", doc.columns, edges.flatMap((e) => {
    const members = new Set(roots.map((n) => n.id));
    const a = memberOf(e.from, members), b = memberOf(e.to, members);
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

// Each edge's route around everything it does not belong to: the outermost
// boxes not holding either end (a group holding an end is entered, and its
// other members are what to go around), along the axis of the layout of the
// smallest group holding both ends.
function* routeEdges(doc: BoardDoc, items: Item[], edges: Edge[], parentOf: Map<string, string>): Generator<void, void> {
  if (!edges.length) return;
  const roots = doc.nodes ?? [];
  const byId = new Map(items.map((it) => [it.id, it]));
  const rect = (id: string): Rect => { const it = byId.get(id)!; return { x0: it.x, y0: it.y, x1: it.x + it.w, y1: it.y + it.h }; };
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
  for (const e of edges) {
    const A = ancestors(e.from), B = ancestors(e.to);
    if (A.has(e.to) || B.has(e.from)) continue; // a group and its member: no line
    const obstacles: Rect[] = [];
    const scan = (ns: DocNode[]) => {
      for (const n of ns) {
        if (n.id === e.from || n.id === e.to) continue;
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
