// JSON Canvas (jsoncanvas.org, version 1.0: Obsidian's .canvas files) to and
// from boards.  A canvas is cards (text, a file, a link, or a group) at
// places and sizes, and edges between them, by their sides.
//
// Reading one: a text card becomes a note with its Markdown (a heading on
// its first line its title, a python or sage block at its end its code, as
// a board writes them); a link card a note with the link; a file card a note
// naming the file, linked to it (a .canvas file refers to files, it does not
// hold them); a group a group holding what is inside it (by position: nest.ts,
// as a canvas has no tree), its label its title.  Edges keep their labels and
// arrows; their sides are the router's.  The six preset colors become the
// board's own tints, and any other color a tint of itself, as a note's color
// is the background of its text.  Places and widths are kept; heights follow
// the text, as on a board.  What a board has nothing like (a group's
// background picture, a card of a kind it doesn't know, an edge to nothing)
// is left out, and counted.
//
// Writing one: the board as it is laid out (each page, below the one before,
// in a group of its own), its notes as text cards written as above (a note
// that is only a link, a link card; a picture, in its text as a data: URL),
// its groups as groups, its edges as edges.  What a canvas has nothing like
// (the tour, a page's intro, a note's outline) is left out, and counted.

import type { Edge, Item } from "./board";
import { lookOf, pageCount, pageOf, shownPages, type BoardDoc, type BoardPage, type DocEdge, type DocNote } from "./doc";
import { COLORS } from "./colors";
import { nest } from "./nest";

interface CanvasNode { id: string; type: string; x: number; y: number; width: number; height: number; color?: string; text?: string; file?: string; subpath?: string; url?: string; label?: string; background?: string }
interface CanvasEdge { id: string; fromNode: string; toNode: string; fromSide?: string; toSide?: string; fromEnd?: string; toEnd?: string; color?: string; label?: string }
export interface Canvas { nodes?: CanvasNode[]; edges?: CanvasEdge[] }

// the presets, as the board's tints (red, orange, yellow, green, cyan, purple)
const tint = (name: string) => COLORS.find(([n]) => n === name)![1];
const PRESETS: Record<string, string> = { "1": tint("Red"), "2": tint("Orange"), "3": tint("Yellow"), "4": tint("Green"), "5": tint("Teal"), "6": tint("Purple") };

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v * 10) / 10 : 0);
const isNode = (n: any): n is CanvasNode => !!n && typeof n === "object" && typeof n.id === "string" && typeof n.type === "string" && typeof n.width === "number" && typeof n.height === "number";

/** Whether a text is a JSON Canvas file. */
export function isCanvas(text: string): boolean {
  try {
    const c = JSON.parse(text);
    return !!c && typeof c === "object" && !Array.isArray(c) && c.format !== "sagebrush-board" && Array.isArray(c.nodes) && c.nodes.length > 0 && c.nodes.every(isNode);
  } catch {
    return false;
  }
}

// a color of the canvas as a note's: a preset as the board's tint; a hex
// color mixed with white, so text on it reads
function colorIn(c: unknown): string | undefined {
  if (typeof c !== "string") return undefined;
  if (PRESETS[c]) return PRESETS[c];
  const m = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(c.trim());
  if (!m) return undefined;
  const h = m[1].length === 3 ? m[1].replace(/./g, "$&$&") : m[1];
  const mix = (i: number) => Math.round(parseInt(h.slice(i, i + 2), 16) * 0.25 + 255 * 0.75).toString(16).padStart(2, "0");
  return "#" + mix(0) + mix(2) + mix(4);
}
// a note's color as the canvas's: the board's tint as its preset, else as it is (hex only)
function colorOut(c: string | undefined): string | undefined {
  if (!c) return undefined;
  const p = Object.entries(PRESETS).find(([, v]) => v.toLowerCase() === c.toLowerCase());
  return p ? p[0] : /^#[0-9a-f]{6}$/i.test(c) ? c : undefined;
}

// a text card's Markdown as a note: its title (a first-line heading) and its code (a last python or sage block)
function noteOf(text: string): Pick<DocNote, "title" | "text" | "code"> & { sage?: boolean } {
  let t = text.replace(/\r\n/g, "\n").trim(), title: string | undefined, code: string | undefined, sage = false;
  const h = /^#{1,3} +(.+)(\n|$)/.exec(t);
  if (h) { title = h[1].trim(); t = t.slice(h[0].length).trim(); }
  const c = /(^|\n)```(python|py|sage)\n([\s\S]*?)\n?```\s*$/.exec(t);
  if (c) { code = c[3]; sage = c[2] === "sage"; t = t.slice(0, c.index).trim(); }
  return { ...(title ? { title } : {}), ...(t ? { text: t } : {}), ...(code !== undefined ? { code } : {}), ...(sage ? { sage } : {}) };
}

/** A JSON Canvas as a board, and what was left out (by kind: how many). */
export function fromCanvas(text: string): { doc: BoardDoc; left: Record<string, number> } {
  const c = JSON.parse(text) as Canvas;
  const left: Record<string, number> = {};
  const leave = (k: string) => { left[k] = (left[k] ?? 0) + 1; };
  const boxed = (n: CanvasNode, z: number) => ({ id: n.id, x: num(n.x), y: num(n.y), w: Math.max(1, num(n.width)), h: Math.max(1, num(n.height)), z, n });
  // (ids are a canvas's own, and unique, by its spec, but not always: the
  // first keeps its id, the next ones are id-2, id-3, ...; an edge naming one
  // goes to the first)
  const taken = new Set((c.nodes ?? []).filter(isNode).map((n) => n.id)), used = new Set<string>();
  const nodes = (c.nodes ?? []).filter(isNode).map((n) => {
    if (!used.has(n.id)) { used.add(n.id); return n; }
    let k = 2;
    while (taken.has(`${n.id}-${k}`) || used.has(`${n.id}-${k}`)) k++;
    used.add(`${n.id}-${k}`);
    return { ...n, id: `${n.id}-${k}` };
  });
  const frames = nodes.map(boxed).filter((b) => b.n.type === "group");
  const cards = nodes.map(boxed).filter((b) => ["text", "file", "link"].includes(b.n.type));
  for (const n of nodes) {
    if (!["text", "file", "link", "group"].includes(n.type)) leave("card");
    else if (n.type === "group" && n.background) leave("background");
  }
  let sage = false;
  const note = ({ n, w }: { n: CanvasNode; w: number }): DocNote => {
    const color = colorIn(n.color);
    const base: DocNote = { id: n.id, w, ...(color ? { color } : {}) };
    if (n.type === "link") return { ...base, ref: String(n.url ?? "") };
    if (n.type === "file") {
      const file = String(n.file ?? "");
      return { ...base, title: file.split("/").pop() || file, ref: file + (typeof n.subpath === "string" ? n.subpath : "") };
    }
    const { sage: s, ...m } = noteOf(String(n.text ?? ""));
    if (s) sage = true;
    return { ...base, ...m };
  };
  const tree = nest(frames, cards, ({ n }) => ({ id: n.id, ...(n.label?.trim() ? { title: n.label.trim() } : {}), ...(colorIn(n.color) ? { color: colorIn(n.color) } : {}) }), note);
  const ids = new Set([...frames, ...cards].map((b) => b.id));
  const edges: DocEdge[] = [];
  for (const e of c.edges ?? []) {
    if (!e || typeof e.fromNode !== "string" || typeof e.toNode !== "string" || !ids.has(e.fromNode) || !ids.has(e.toNode)) { leave("edge"); continue; }
    const from = e.fromEnd === "arrow", to = (e.toEnd ?? "arrow") === "arrow";
    const label = typeof e.label === "string" && e.label.trim() ? { label: e.label.trim() } : {};
    // (an arrow only at its start: the same edge the other way)
    if (from && !to) edges.push({ from: e.toNode, to: e.fromNode, ...label });
    else edges.push({ from: e.fromNode, to: e.toNode, ...label, ...(from && to ? { arrow: "both" as const } : !to ? { arrow: "none" as const } : {}) });
  }
  return { doc: { ...(sage ? { mode: "sage" as const } : {}), nodes: tree, edges }, left };
}

// a note as a text card's Markdown
function markdownOf(it: Item, mode: string): string {
  const parts: string[] = [];
  if (it.title) parts.push("## " + it.title.replace(/\n/g, " "));
  if (it.image?.src) parts.push(`![${it.title ?? ""}](${it.image.src})`);
  if (it.text) parts.push(it.text);
  if (it.code !== undefined) parts.push("```" + mode + "\n" + it.code + "\n```");
  if (it.detail) parts.push(it.detail);
  if (it.ref) parts.push(/^https?:\/\//.test(it.ref) ? `<${it.ref}>` : it.ref);
  return parts.join("\n\n");
}

/** A board as a JSON Canvas: each page as `laid(page)` lays it out (below
 * the one before, in a group of its own when there are several), and what
 * was left out (by kind: how many). */
export function toCanvas(doc: BoardDoc, laid: (page: number) => { items: Item[]; edges: Edge[] }): { canvas: Canvas; left: Record<string, number> } {
  const nodes: CanvasNode[] = [], edges: CanvasEdge[] = [], left: Record<string, number> = {};
  const leave = (k: string, n = 1) => { if (n > 0) left[k] = (left[k] ?? 0) + n; };
  const mode = doc.mode === "sage" ? "sage" : "python";
  const n = pageCount(doc), paged = !!doc.pages?.length && n > 1;
  // (a template's own page left out, said so: its items are on the pages made from it, as `laid` gives them)
  const shown = new Set(shownPages(doc));
  let y0 = 0;
  for (let i = 0; i < n; i++) {
    if (!shown.has(i)) { leave("template"); continue; }
    const page: BoardPage = pageOf(doc, i), look = lookOf(doc, i);
    const { items, edges: es } = laid(i);
    const id = (s: string) => (paged ? `p${i + 1}-${s}` : s);
    leave("step", page.steps?.length ?? 0);
    leave("intro", page.intro ? 1 : 0);
    leave("slidecard", look.slide ? 1 : 0);
    leave("pagebg", look.background ? 1 : 0);
    leave("edge", (page.edges ?? []).filter((e) => e.hidden).length);
    if (!items.length) continue;
    const x0 = Math.min(...items.map((it) => it.x)), top = Math.min(...items.map((it) => it.y));
    const PAD = 40, TITLE = paged ? 40 : 0;
    const at = (it: Item) => ({ x: Math.round(it.x - x0 + (paged ? PAD : 0)), y: Math.round(it.y - top + y0 + (paged ? PAD + TITLE : 0)), width: Math.round(it.w), height: Math.round(it.h) });
    const right = Math.max(...items.map((it) => it.x + it.w)) - x0, bottom = Math.max(...items.map((it) => it.y + it.h)) - top;
    if (paged) nodes.push({ id: `page-${i + 1}`, type: "group", x: 0, y: y0, width: Math.round(right + 2 * PAD), height: Math.round(bottom + 2 * PAD + TITLE), label: page.title || `Page ${i + 1}` });
    // (groups below their members: outer ones first)
    for (const it of items.filter((x) => x.kind === "group").sort((a, b) => (a.depth ?? 0) - (b.depth ?? 0))) {
      const color = colorOut(it.color);
      nodes.push({ id: id(it.id), type: "group", ...at(it), ...(it.title ? { label: it.title } : {}), ...(color ? { color } : {}) });
    }
    for (const it of items.filter((x) => x.kind === "note")) {
      const color = colorOut(it.color);
      if (it.shape && it.shape !== "rect") leave("outline");
      if (it.image && !it.image.src) leave("picture");
      const onlyLink = it.ref && /^https?:\/\//.test(it.ref) && !it.title && !it.text && it.code === undefined && !it.detail && !it.image;
      nodes.push(onlyLink ? { id: id(it.id), type: "link", ...at(it), url: it.ref!, ...(color ? { color } : {}) } : { id: id(it.id), type: "text", ...at(it), text: markdownOf(it, mode), ...(color ? { color } : {}) });
    }
    leave("ink", items.filter((x) => x.kind === "ink" || x.kind === "shape").length);
    es.forEach((e, k) => edges.push({ id: id(`e${k + 1}`), fromNode: id(e.from), toNode: id(e.to), ...(e.label ? { label: e.label } : {}), ...(e.arrow === "none" ? { toEnd: "none" } : e.arrow === "both" ? { fromEnd: "arrow", toEnd: "arrow" } : {}) }));
    y0 += bottom + (paged ? 2 * PAD + TITLE : 0) + 200;
  }
  return { canvas: { nodes, edges }, left };
}

const WORDS: Record<string, [string, string]> = {
  card: ["card of a kind a board doesn't have", "cards of kinds a board doesn't have"], background: ["group's background picture", "groups' background pictures"],
  edge: ["connection to something left out", "connections to something left out"], step: ["step of the tour", "steps of the tour"],
  intro: ["page's intro", "pages' intros"], outline: ["note's outline", "notes' outlines"], picture: ["picture not in this browser", "pictures not in this browser"],
  template: ["template page (its items are on the pages made from it)", "template pages (their items are on the pages made from them)"],
  ink: ["pen stroke", "pen strokes"], slidecard: ["slide's card", "slides' cards"], pagebg: ["page's background", "pages' backgrounds"],
};
/** What was left out, in words ("4 steps of the tour and 1 page's intro"), or "" if nothing. */
export function canvasLeftOut(left: Record<string, number>): string {
  const parts = Object.entries(left).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${(WORDS[k] ?? [k, k])[n === 1 ? 0 : 1]}`);
  return parts.length > 1 ? parts.slice(0, -1).join(", ") + " and " + parts[parts.length - 1] : parts[0] ?? "";
}
