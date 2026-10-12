// A board as an agent writes it (design/board.md, "The document"): structure,
// not coordinates.  Notes (Markdown with math) and groups of them, each group
// laid out as a row, a column, a grid, or a layered graph of the edges among
// its members; edges between any two items, with labels.  layout() turns it
// into positioned items for the renderer (board.ts): an item with x and y
// keeps them (a person moved it), the rest are placed.

import type { Item, Edge } from "./board";

export interface DocNote {
  id: string;
  kind?: "note";
  title?: string;
  /** Markdown with math ($...$), shown at every zoom */
  text?: string;
  /** Markdown shown only when zoomed in (semantic zoom) */
  detail?: string;
  /** a link: a source file (path#Lline), a paper, a page */
  ref?: string;
  color?: string;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
}

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
}

/** A step of a tour: the camera shows these items while the caption explains them. */
export interface DocStep {
  focus: string | string[];
  /** Markdown */
  say?: string;
}

export interface BoardDoc {
  title?: string;
  /** Markdown, shown before the tour starts */
  intro?: string;
  /** links' base for refs that are paths (e.g. a repository's blob URL) */
  refBase?: string;
  layout?: DocGroup["layout"];
  columns?: number;
  direction?: DocGroup["direction"];
  nodes: DocNode[];
  edges?: DocEdge[];
  steps?: DocStep[];
}

const GAP = 40, PAD = 24, TITLE = 34;

interface Box { w: number; h: number }

/** A note's rendered height at a width (the renderer's measure()). */
export type Measure = (n: DocNote, w: number) => number;

// A note's size: given, measured, or estimated from its text's length (about
// 7 px a character, 20 px a line), with room for the title and the link.
function noteSize(n: DocNote, measure?: Measure): Box {
  if (n.w && n.h) return { w: n.w, h: n.h };
  const w = n.w ?? 260;
  if (measure) return { w, h: n.h ?? Math.max(60, Math.ceil(measure(n, w)) + 2) };
  const chars = (n.text ?? "").length;
  const lines = Math.ceil(chars / Math.max(10, (w - 24) / 7.2)) + (n.text?.match(/\n/g)?.length ?? 0);
  const h = n.h ?? Math.max(70, 24 + (n.title ? 24 : 0) + lines * 20 + (n.detail ? 26 : 0) + (n.ref ? 22 : 0));
  return { w, h };
}

/**
 * Place a board's nodes: returns the renderer's items (groups, notes) and
 * edges, in world coordinates.
 */
export function layout(doc: BoardDoc, measure?: Measure): { items: Item[]; edges: Edge[] } {
  const items: Item[] = [];
  const parentOf = new Map<string, string>(); // node id -> the group directly holding it
  const ids = new Set<string>();
  const walk = (n: DocNode, parent: string | null) => {
    if (ids.has(n.id)) throw new Error(`board: two nodes with id ${n.id}`);
    ids.add(n.id);
    if (parent) parentOf.set(n.id, parent);
    if (n.kind === "group") for (const c of n.children) walk(c, n.id);
  };
  for (const n of doc.nodes) walk(n, null);
  // links: absolute, or paths under the document's refBase
  const refOf = (n: DocNote) => n.ref && doc.refBase && !/^[a-z]+:/i.test(n.ref) ? doc.refBase + n.ref : n.ref;
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
      const b = noteSize(n, measure && ((m, w) => measure({ ...m, ref: refOf(m) }, w)));
      size.set(n.id, b);
      return b;
    }
    const kids = n.children.map((c) => ({ c, b: sizeOf(c) }));
    const pos = arrange(kids.map((k) => ({ id: k.c.id, ...k.b, fixed: k.c.x !== undefined && k.c.y !== undefined ? { x: k.c.x!, y: k.c.y! } : null })), n.layout ?? "graph", n.direction ?? "TB", n.columns,
      edges.flatMap((e) => {
        const members = new Set(n.children.map((c) => c.id));
        const a = memberOf(e.from, members), b = memberOf(e.to, members);
        return a && b && a !== b ? [[a, b] as [string, string]] : [];
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
  const top = doc.nodes.map((n) => ({ id: n.id, ...sizeOf(n), fixed: n.x !== undefined && n.y !== undefined ? { x: n.x!, y: n.y! } : null }));
  const topPos = arrange(top, doc.layout ?? "graph", doc.direction ?? "TB", doc.columns, edges.flatMap((e) => {
    const members = new Set(doc.nodes.map((n) => n.id));
    const a = memberOf(e.from, members), b = memberOf(e.to, members);
    return a && b && a !== b ? [[a, b] as [string, string]] : [];
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
      items.push({ id: n.id, kind: "note", x, y, w: b.w, h: b.h, title: n.title, text: n.text, detail: n.detail, ref: refOf(n), color: n.color, depth, parent });
    }
  };
  for (const n of doc.nodes) {
    const p = topPos.get(n.id)!;
    place(n, p.x, p.y, 0);
  }
  return { items, edges: edges.filter((e) => !e.hidden).map((e, i) => ({ id: `e${i}`, from: e.from, to: e.to, label: e.label })) };
}

interface Node { id: string; w: number; h: number; fixed: { x: number; y: number } | null }

// Positions (top left, relative) for boxes in one container.
function arrange(all: Node[], kind: NonNullable<DocGroup["layout"]>, dir: "TB" | "LR", columns: number | undefined, allLinks: [string, string][]): Map<string, { x: number; y: number }> {
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
function layered(nodes: Node[], links: [string, string][], dir: "TB" | "LR"): Map<string, { x: number; y: number }> {
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
  // coordinates: layers stacked along the direction, each centered across it
  const along = (n: Node) => (dir === "TB" ? n.h : n.w), across = (n: Node) => (dir === "TB" ? n.w : n.h);
  const spans = layers.map((l) => l.reduce((s, v) => s + across(byId.get(v)!), 0) + GAP * Math.max(0, l.length - 1));
  const widest = Math.max(...spans, 0);
  const pos = new Map<string, { x: number; y: number }>();
  let at = 0;
  layers.forEach((l, k) => {
    let c = (widest - spans[k]) / 2;
    for (const v of l) {
      const n = byId.get(v)!;
      pos.set(v, dir === "TB" ? { x: c, y: at } : { x: at, y: c });
      c += across(n) + GAP;
    }
    at += Math.max(...l.map((v) => along(byId.get(v)!))) + GAP * 2;
  });
  return pos;
}
