// A board as one SVG file, without a browser (the CLI's `sagebrush board
// render --svg`): the board's own layout and edge routes (doc.ts), its
// groups and edges as the print view draws them (print.ts backShapes),
// notes as their outlines with their text as SVG text, pen strokes and
// stickers.  Text is measured with DejaVu Sans's widths (Verdana's are
// close), the font the file names, so it is wrapped where it fits; math
// typeset as SVG by the renderer the caller gives (`math`: the CLI's,
// src/board-math.ts), else shown as its TeX; a picture whose bytes are in
// the file (a raster data: URL, or an SVG one) as an <image>, else as a box
// saying so; a code item's outputs as its stored preview has them (text, and
// its one picture), else a line saying they are not stored.
//
// Every text in a board is untrusted: it is only ever character data or a
// quoted attribute, escaped, with characters XML does not allow dropped;
// no element of the document's choosing, no link, no style, no
// foreignObject.  A picture is an <image> whose href is a data: URL only:
// a raster one (PNG, JPEG, GIF or WebP, as image-size.ts reads it) or an
// SVG one in its one form, base64 (pictureUrl), within the board's pixel
// budget.  The SVG's text never enters this file's markup: as an <image>,
// a viewer shows it in its secure mode (no script, nothing loaded from
// elsewhere, SVG 2 section 2.3), so nothing in the file loads from anywhere.  Colors are the document's, which cleanDoc has made
// colors.  Typeset math is the renderer's own paths, which it has checked.

import { Lexer, type Token, type Tokens } from "marked";
import { cleanDoc, layout, lookOf, pageView, refLabel, type BoardDoc, type Measure, type MeasuredNote } from "./doc";
import { backShapes, edgeLabelBox, xmlEscape } from "./print";
import { inkPath } from "./ink";
import { iconEmoji } from "./stickers";
import type { Item } from "./board";
import { previewLabel, type Preview } from "./preview";
import { PixelBudget, imageSize, pictureKey, pictureSize, pictureUrl, svgDataUrl } from "../image-size";

// ---- text: its widths ------------------------------------------------------

// advance widths, thousandths of the size, of " " to "~" (DejaVu Sans, and bold)
const REG = [318, 401, 460, 838, 636, 950, 780, 275, 390, 390, 500, 838, 318, 361, 318, 337, 636, 636, 636, 636, 636, 636, 636, 636, 636, 636, 337, 337, 838, 838, 838, 531, 1000, 684, 686, 698, 770, 632, 575, 775, 752, 295, 295, 656, 557, 863, 748, 787, 603, 787, 695, 635, 611, 732, 684, 989, 685, 611, 685, 390, 337, 390, 838, 500, 500, 613, 635, 550, 635, 615, 352, 635, 634, 278, 278, 579, 278, 974, 634, 612, 635, 635, 411, 521, 392, 634, 592, 818, 592, 592, 525, 636, 337, 636, 838];
const BOLD = [348, 456, 521, 838, 696, 1002, 872, 306, 457, 457, 523, 838, 380, 415, 380, 365, 696, 696, 696, 696, 696, 696, 696, 696, 696, 696, 400, 400, 838, 838, 838, 580, 1000, 774, 762, 734, 830, 683, 683, 821, 837, 372, 372, 775, 637, 995, 837, 850, 733, 850, 770, 720, 682, 812, 774, 1103, 771, 724, 725, 457, 365, 457, 838, 500, 500, 675, 716, 593, 716, 678, 435, 716, 712, 343, 343, 665, 343, 1042, 712, 687, 716, 716, 493, 595, 478, 712, 652, 924, 645, 652, 582, 712, 365, 712, 838];
const MONO = 602;
// (wide: East Asian scripts and emoji, a full em)
const wide = (c: number) => (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe4f) || (c >= 0xff00 && c <= 0xff60) || (c >= 0x1f000 && c <= 0x1faff) || (c >= 0x20000 && c <= 0x3fffd);
interface Run { t: string; b?: boolean; i?: boolean; m?: boolean; math?: MathSvg }
/** Math typeset as SVG (src/board-math.ts): its viewBox and inside, and its
 * width, height and depth below the baseline, in pixels. */
export interface MathSvg { viewBox: string; inner: string; w: number; h: number; d: number }
export type MathRenderer = (tex: string, display: boolean, size: number) => MathSvg | null;
// (the renderer of the board being drawn, and its formulas so far, by size
// and TeX; whether one stayed TeX: boardSvg sets them)
let mathOf: MathRenderer | null = null, mathCache = new Map<string, MathSvg | null>(), mathTex = false;
function typeset(m: string, size: number): MathSvg | null {
  if (!mathOf) { mathTex = true; return null; }
  const display = m.startsWith("$$"), tex = m.slice(display ? 2 : 1, display ? -2 : -1), key = `${display ? "D" : "I"}${size}\u0000${tex}`;
  if (!mathCache.has(key)) mathCache.set(key, mathOf(tex, display, size));
  const r = mathCache.get(key)!;
  if (!r) mathTex = true;
  return r;
}
function width(r: Run, size: number): number {
  if (r.math) return r.math.w;
  let w = 0;
  for (const ch of r.t) {
    const c = ch.codePointAt(0)!;
    w += r.m ? MONO : c >= 32 && c <= 126 ? (r.b ? BOLD : REG)[c - 32] : wide(c) ? 1000 : r.b ? 700 : 640;
  }
  return (w * size) / 1000;
}

// ---- text: Markdown as lines -----------------------------------------------

/** A line of text: its runs, size, height, and where it starts (left, or
 * centered); `base`: its baseline from its top, when math makes it taller. */
// (a table's row: its cells at their columns' x, and the grid's columns, xs, from 0 to the table's width)
interface Cell { lines: Line[]; x: number; w: number; align: "left" | "center" | "right" }
interface Line { runs: Run[]; size: number; lh: number; indent: number; gap: number; color?: string; box?: "code"; base?: number; cells?: Cell[]; grid?: { xs: number[]; top: boolean; head: boolean }; pic?: { src: string; w: number } }
const FONT = 14, LH = 1.45;
// (a table's cell: its padding; its grid's lines, the header's rule)
const CELL_X = 6, CELL_Y = 3, GRID = "#c8ccd2", GRID_HEAD = "#8a9099";
const ENT: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
const decode = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
  if (e[0] !== "#") return ENT[e.toLowerCase()] ?? m;
  const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1));
  return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
});
// (math kept as its TeX: never read as Markdown)
const MATH = /\$\$[\s\S]+?\$\$|\$[^$\n]+\$/g;

function inline(tokens: Token[] | undefined, style: Omit<Run, "t">, math: string[], out: Run[], size = FONT) {
  for (const t of tokens ?? []) {
    const back = (s: string) => s.replace(/\u0000(\d+)\u0000/g, (_, k) => math[Number(k)]);
    // (text with math: the math typeset, a run of its own, if it can be;
    // else its TeX in the text, as before, so wrapped as one word with what touches it)
    const text = (s: string, st: Omit<Run, "t">) => {
      let acc = "";
      for (const [k, piece] of s.split(/\u0000(\d+)\u0000/).entries()) {
        if (k % 2 === 0) { acc += piece; continue; }
        const tex = math[Number(piece)], m = typeset(tex, size);
        if (!m) { acc += tex; continue; }
        if (acc) out.push({ ...st, t: acc });
        acc = "";
        out.push({ ...st, t: tex, math: m });
      }
      if (acc) out.push({ ...st, t: acc });
    };
    switch (t.type) {
      case "strong": inline(t.tokens, { ...style, b: true }, math, out, size); break;
      case "em": inline(t.tokens, { ...style, i: true }, math, out, size); break;
      case "del": case "link": inline(t.tokens, style, math, out, size); break;
      case "codespan": out.push({ ...style, m: true, t: back(t.text) }); break;
      case "image": out.push({ ...style, i: true, t: `[${back(t.text) || "picture"}]` }); break;
      case "br": out.push({ t: "\n" }); break;
      // (HTML: not shown, as on the board)
      case "html": break;
      default:
        if ("tokens" in t && t.tokens?.length) inline(t.tokens, style, math, out, size);
        else text(decode((t as Tokens.Text).text ?? ""), style);
    }
  }
}

/** Markdown (a note's text) as lines at most `w` wide; `plain`: text as it is (a title). */
function lines(md: string, w: number, size = FONT, color?: string, plain?: Omit<Run, "t">): Line[] {
  const math: string[] = [];
  const src = plain ? md : md.replace(MATH, (m) => `\u0000${math.push(m) - 1}\u0000`);
  const restore = (s: string) => s.replace(/\u0000(\d+)\u0000/g, (_, k) => math[Number(k)]);
  const out: Line[] = [];
  const block = (tokens: Token[], indent: number) => {
    for (const t of tokens) {
      const gap = out.length ? 6 : 0;
      if (t.type === "space" || t.type === "hr") continue;
      if (t.type === "heading") { const s = t.depth <= 1 ? size + 4 : t.depth === 2 ? size + 2 : size + 1; flow(runsOf(t.tokens, { b: true }, s), w - indent, s, indent, gap); }
      else if (t.type === "paragraph" || t.type === "text") flow(runsOf(t.tokens ?? [{ type: "text", raw: t.raw, text: t.text } as Token], {}), w - indent, size, indent, gap);
      else if (t.type === "list") {
        t.items.forEach((item: Tokens.ListItem, k: number) => {
          const mark = t.ordered ? `${(Number(t.start) || 1) + k}. ` : "• ";
          const first = out.length;
          block(item.tokens, indent + 18);
          if (out.length > first) { out[first].runs.unshift({ t: mark }); out[first].indent -= width({ t: mark }, size); if (k) out[first].gap = 2; }
        });
      } else if (t.type === "code") {
        const cs = size - 2;
        restore(t.text).replace(/\t/g, "    ").split("\n").forEach((l: string, k: number) => flow([{ t: l || " ", m: true }], w - indent - 12, cs, indent + 6, k ? 0 : gap, "code"));
      } else if (t.type === "blockquote") block(t.tokens ?? [], indent + 12);
      else if (t.type === "table") table(t as Tokens.Table, indent, gap); else if (t.type === "html") continue;
      else if ("tokens" in t && t.tokens) block(t.tokens as Token[], indent);
    }
  };
  const runsOf = (tokens: Token[] | undefined, style: Omit<Run, "t">, s = size) => { const r: Run[] = []; inline(tokens, style, math, r, s); return r; };
  // (a table, as the board draws one: a grid of cells, its header row bold and ruled off, each column as wide as its
  // widest cell, all narrowed together to fit the note, a cell's text then wrapped in it, each cell aligned as its
  // column's :--- / :---: / ---: says; codex friction P10a)
  const table = (t: Tokens.Table, indent: number, gap: number) => {
    const n = t.header.length;
    const cellRuns = (cells: Tokens.TableCell[], b: boolean) => Array.from({ length: n }, (_, k) => runsOf(cells[k]?.tokens, b ? { b: true } : {}));
    const rows = [cellRuns(t.header, true), ...t.rows.map((r) => cellRuns(r, false))];
    const natural = (rs: Run[]) => rs.reduce((a, r) => a + (r.math ? r.math.w : width(r, size)), 0);
    // (the widths as a browser lays out a table on its own: each column at most as wide as its widest cell, and at
    // least as its longest word; when they don't all fit at their widest, the room past the words' share is given
    // out as each column wants more)
    const longest = (rs: Run[]) => Math.max(0, ...rs.flatMap((r) => (r.math ? [r.math.w] : r.t.split(/\s+/).map((p) => width({ ...r, t: p }, size)))));
    const most = Array.from({ length: n }, (_, k) => Math.max(...rows.map((r) => natural(r[k]))) + 2 * CELL_X);
    const least = Array.from({ length: n }, (_, k) => Math.max(...rows.map((r) => longest(r[k]))) + 2 * CELL_X);
    const room = w - indent, sum = (a: number[]) => a.reduce((x, c) => x + c, 0);
    let cw = most;
    if (sum(most) > room) {
      const spare = room - sum(least), want = sum(most) - sum(least);
      cw = spare <= 0 ? least.map((c) => (c * room) / sum(least)) : least.map((c, k) => c + ((most[k] - least[k]) * spare) / want);
    }
    const xs = [0];
    for (const c of cw) xs.push(xs[xs.length - 1] + c);
    rows.forEach((cells, k) => {
      // (each cell's text wrapped at its column's width, as the rest of a note's text is; the row as tall as its tallest)
      const ls = cells.map((runs, j) => { const into: Line[] = []; flow(runs.length ? runs : [{ t: " " }], Math.max(1, cw[j] - 2 * CELL_X + 0.01), size, 0, 0, undefined, into); return into; });
      out.push({ runs: [], size, lh: Math.max(...ls.map(heightOf)) + 2 * CELL_Y, indent, gap: k ? 0 : gap, color,
        cells: ls.map((lines, j) => ({ lines, x: xs[j], w: cw[j], align: t.align[j] ?? "left" })), grid: { xs, top: k === 0, head: k === 0 } });
    });
  };
  // (runs wrapped into lines at width ww: at spaces, a word longer than a line at a character)
  const flow = (runs: Run[], ww: number, s: number, indent: number, gap: number, box?: "code", into: Line[] = out) => {
    let line: Run[] = [], used = 0, first = true;
    const end = () => {
      // (math taller than the text: the line as tall as it, its baseline lower)
      const ms = line.filter((r) => r.math).map((r) => r.math!);
      const above = Math.max(s * LH * 0.74, ...ms.map((m) => m.h - m.d + 3)), below = Math.max(s * LH * 0.26, ...ms.map((m) => m.d + 3));
      into.push({ runs: line, size: s, lh: ms.length ? above + below : s * LH, indent, gap: first ? gap : 0, color, ...(box ? { box } : {}), ...(ms.length ? { base: above } : {}) });
      line = []; used = 0; first = false;
    };
    for (const r of runs) {
      if (r.t === "\n") { end(); continue; }
      // (a formula: never broken; displayed math on a line of its own)
      if (r.math) {
        const display = r.t.startsWith("$$");
        if (used && (display || used + r.math.w > ww)) { while (line.length && /^ $/.test(line[line.length - 1].t)) { used -= width(line.pop()!, s); } end(); }
        line.push(r);
        used += r.math.w;
        if (display) end();
        continue;
      }
      for (const piece of r.t.split(/(\s+)/)) {
        if (!piece) continue;
        const space = /^\s+$/.test(piece);
        // (what touches a formula's end, its punctuation: never at the start of the next line)
        const glued = !space && line.length > 0 && !!line[line.length - 1].math;
        // (code keeps its spaces as they are, at a line's start too: its indentation)
        const p: Run = { ...r, t: space && box !== "code" ? " " : piece };
        let pw = width(p, s);
        if (space) { if ((used || box === "code") && used + pw <= ww) { line.push(p); used += pw; } continue; }
        if (used + pw > ww && used && !glued) { while (line.length && /^ $/.test(line[line.length - 1].t)) { used -= width(line.pop()!, s); } end(); }
        // (a word wider than the line: broken)
        while (pw > ww && p.t.length > 1) {
          let k = 1;
          while (k < p.t.length && width({ ...p, t: p.t.slice(0, k + 1) }, s) <= ww - used) k++;
          line.push({ ...p, t: p.t.slice(0, k) });
          end();
          p.t = p.t.slice(k);
          pw = width(p, s);
        }
        line.push(p);
        used += pw;
      }
    }
    if (line.length || first) end();
  };
  if (plain) flow([{ ...plain, t: md }], w, size, 0, 0);
  else block(Lexer.lex(src), 0);
  return out;
}
// a run's text cut to fit w, with an ellipsis
function ellipsis(r: Run, size: number, w: number): string {
  if (width(r, size) <= w) return r.t;
  const cs = [...r.t];
  while (cs.length && width({ ...r, t: cs.join("") + "…" }, size) > w) cs.pop();
  return cs.join("") + "…";
}
// a run's text cut to fit w at its start, with an ellipsis: its end kept
function ellipsisStart(r: Run, size: number, w: number): string {
  if (width(r, size) <= w) return r.t;
  const cs = [...r.t];
  while (cs.length && width({ ...r, t: "…" + cs.join("") }, size) > w) cs.shift();
  return "…" + cs.join("");
}
const heightOf = (ls: Line[]) => ls.reduce((h, l) => h + l.lh + l.gap, 0);
const lineWidth = (l: Line) => l.indent + (l.grid ? l.grid.xs[l.grid.xs.length - 1] : l.runs.reduce((w, r) => w + width(r, l.size), 0));

// ---- notes: their boxes ----------------------------------------------------

const PAD_X = 10, PAD_Y = 8, TITLE = 15;
// (an outline other than a rectangle: its side padding, as board.css's)
const sidePad = (shape?: string) => (!shape || shape === "rect" || shape === "round" ? PAD_X : shape === "stadium" || shape === "circle" ? 18 : shape === "subroutine" ? 16 : shape === "cylinder" ? PAD_X : 26);
// a note's content: its title, text, code, picture and link, as lines at width w
function content(n: { title?: string; text?: string; code?: string; hideCode?: boolean; ref?: string; img?: { w: number; h: number }; preview?: Preview }, w: number): { ls: Line[]; pic?: number } {
  const ls: Line[] = [];
  if (n.title) ls.push(...lines(n.title.replace(/\n/g, " "), w, TITLE, undefined, { b: true }));
  let pic: number | undefined;
  if (n.img) pic = Math.round((w * n.img.h) / n.img.w);
  if (n.text) { const t = lines(n.text, w); if (t.length && ls.length) t[0].gap = 4; ls.push(...t); }
  if (n.code !== undefined && !n.hideCode) {
    // (the code, wrapped as the board's pre-wrap does: a fenced block, its fence longer than any run of backticks in it)
    const fence = "`".repeat(Math.max(3, ...[...n.code.matchAll(/`+/g)].map((m) => m[0].length + 1)));
    const cl = lines(`${fence}\n${n.code}\n${fence}`, w, 14.5);
    if (cl.length) cl[0].gap = ls.length ? 6 : 0;
    ls.push(...cl);
  }
  if (n.code !== undefined) ls.push(...outputLines(n.preview, w));
  // (a link: one line, cut with an ellipsis, as on the board; text only)
  // (its words as on the board, and too long, its start cut, not its end: the file's name is the part a reader wants, round 0's 10)
  if (n.ref) ls.push({ runs: [{ t: "↗ " + ellipsisStart({ t: refLabel(n.ref), m: true }, 11, w - width({ t: "↗ ", m: true }, 11)), m: true }], size: 11, lh: 16, indent: 0, gap: 6, color: "#2a6f2f" });
  return { ls, pic };
}
// (a preview's picture: a raster of the types previews keep, its size from its header)
const PREVIEW_IMAGES = ["image/png", "image/jpeg", "image/webp"];
// a code item's outputs as its stored preview has them (preview.ts: text cut, at most one
// picture, cleaned when the file was read): text as code, stderr in the error color, the
// picture at most as wide as the note, and when they were computed; without a preview, a
// line saying they are on the board
function outputLines(p: Preview | undefined, w: number): Line[] {
  if (!p) return [{ runs: [{ t: "(output not stored)", i: true }], size: 11, lh: 16, indent: 0, gap: 4, color: "#667" }];
  const out: Line[] = [];
  const text = (t: string, color?: string) => {
    const body = t.replace(/\n$/, "");
    if (!body) return;
    const fence = "`".repeat(Math.max(3, ...[...body.matchAll(/`+/g)].map((m) => m[0].length + 1)));
    const ls = lines(`${fence}\n${body}\n${fence}`, w, 13);
    if (ls.length) ls[0].gap = 4;
    if (color) for (const l of ls) l.color = color;
    out.push(...ls);
  };
  for (const o of p.outputs) {
    if (o.output_type === "stream") { text(o.text, o.name === "stderr" ? "#b3261e" : undefined); continue; }
    const type = PREVIEW_IMAGES.find((t) => typeof o.data[t] === "string"), size = type ? imageSize(type, o.data[type]) : null;
    if (type && size && size.w > 0 && size.h > 0) {
      const dw = Math.min(w, size.w);
      out.push({ runs: [], size: 11, lh: Math.round((dw * size.h) / size.w), indent: 0, gap: 6, pic: { src: `data:${type};base64,${o.data[type]}`, w: dw } });
      continue;
    }
    // (an SVG picture, as a preview keeps it (its text): as an <image> of its base64 data: URL, never its markup)
    const svg = typeof o.data["image/svg+xml"] === "string" ? svgDataUrl(o.data["image/svg+xml"]) : null, ss = svg ? pictureUrl(svg) : null, sz = ss ? pictureSize(ss.type, ss.base64) : null;
    if (svg && sz) {
      const dw = Math.min(w, sz.w);
      out.push({ runs: [], size: 11, lh: Math.round((dw * sz.h) / sz.w), indent: 0, gap: 6, pic: { src: svg, w: dw } });
      continue;
    }
    const t = o.data["text/plain"] ?? o.data["text/markdown"] ?? o.data["text/latex"];
    if (typeof t === "string") text(t);
  }
  out.push({ runs: [{ t: previewLabel(p).replace(/ Run to update\.$/, ""), i: true }], size: 11, lh: 16, indent: 0, gap: 4, color: "#667" });
  return out;
}
/** The measure layout() asks for: a note's height at a width, and its natural width. */
export const measure: Measure = Object.assign(
  (n: MeasuredNote, w: number) => {
    const inner = w - 2 * sidePad(n.shape) - 2, c = content({ ...n, img: n.img }, inner);
    return heightOf(c.ls) + (c.pic ? c.pic + 8 : 0) + 2 * PAD_Y + 2 + (n.shape === "cylinder" ? 10 : 0);
  },
  { width: (n: MeasuredNote, max: number) => Math.max(0, ...content(n, max - 2 * sidePad(n.shape) - 2).ls.map(lineWidth)) + 2 * sidePad(n.shape) + 2 },
);

// ---- the file --------------------------------------------------------------

// XML's characters only, escaped (text and quoted attributes alike; the print view's too)
const esc = xmlEscape;
// (a number written: finite, a tenth at most; places and sizes are clamped first, HARD-270-2)
const n1 = (v: number) => (Number.isFinite(v) ? String(Math.round(v * 10) / 10) : "0");
const LIM = 1e7;
const BG = "#fafaf7", TEXT = "#1d241a";

function outline(it: Item, fill: string): string {
  const { x, y, w, h } = it, s = it.shape ?? "rect", X = n1(x), Y = n1(y), W = n1(w), H = n1(h);
  const poly = (pts: [number, number][]) => `<polygon points="${pts.map(([a, b]) => `${n1(x + a)},${n1(y + b)}`).join(" ")}" fill="${fill}" stroke="#000" stroke-opacity=".28" stroke-width="1.2"/>`;
  switch (s) {
    case "diamond": return poly([[16, 0], [w - 16, 0], [w, h / 2], [w - 16, h], [16, h], [0, h / 2]]);
    case "hexagon": return poly([[12, 0], [w - 12, 0], [w, h / 2], [w - 12, h], [12, h], [0, h / 2]]);
    case "lean-right": return poly([[14, 0], [w, 0], [w - 14, h], [0, h]]);
    case "lean-left": return poly([[0, 0], [w - 14, 0], [w, h], [14, h]]);
    case "trapezoid": return poly([[14, 0], [w - 14, 0], [w, h], [0, h]]);
    case "inv-trapezoid": return poly([[0, 0], [w, 0], [w - 14, h], [14, h]]);
    case "flag": return poly([[0, 0], [w, 0], [w, h], [0, h], [14, h / 2]]);
  }
  const rx = s === "round" ? 16 : s === "stadium" || s === "circle" ? Math.min(w, h) / 2 : 8;
  const box = `<rect x="${X}" y="${Y}" width="${W}" height="${H}" rx="${n1(rx)}" fill="${fill}" stroke="#000" stroke-opacity=".12"/>`;
  if (s === "cylinder") return `<rect x="${X}" y="${Y}" width="${W}" height="${H}" rx="${n1(w / 2)}" ry="14" fill="${fill}" stroke="#000" stroke-opacity=".12"/><path d="M${X} ${n1(y + 14)}A${n1(w / 2)} 14 0 0 0 ${n1(x + w)} ${n1(y + 14)}" fill="none" stroke="#000" stroke-opacity=".2"/>`;
  if (s === "subroutine") return box + `<path d="M${n1(x + 6)} ${Y}V${n1(y + h)}M${n1(x + w - 6)} ${Y}V${n1(y + h)}" stroke="#000" stroke-opacity=".4"/>`;
  return box;
}

// a run as a tspan (its style as attributes)
const tspan = (r: Run) => (r.b || r.i || r.m ? `<tspan${r.b ? ' font-weight="bold"' : ""}${r.i ? ' font-style="italic"' : ""}${r.m ? ' font-family="DejaVu Sans Mono, Menlo, Consolas, monospace"' : ""}>${esc(r.t)}</tspan>` : esc(r.t));

// (the board's pictures drawn so far, within the pixel budget the board itself keeps: boardSvg sets it)
let pixels = new PixelBudget();
// whether a picture's source may be drawn: a raster data: URL whose header gives a size, or an SVG one in its one
// form whose root does, within the budget
function picOk(src: string): boolean {
  const u = pictureUrl(src);
  return !!u && pixels.take(pictureSize(u.type, u.base64), pictureKey(src)) === null;
}
// runs from x on the baseline: runs of one style next to each other, one tspan; a formula, its own SVG, at the place
// the text before it ends, as the file's font measures it
function drawRuns(out: string[], ls: Run[], x: number, base: number, size: number, color?: string) {
  let runs: Run[] = [], rx = x, sx = x;
  const flush = () => { if (runs.length) out.push(`<text x="${n1(sx)}" y="${n1(base)}" font-size="${n1(size)}"${color ? ` fill="${color}"` : ""} xml:space="preserve">${runs.map(tspan).join("")}</text>`); runs = []; };
  for (const r of ls) {
    if (r.math) {
      flush();
      out.push(`<svg x="${n1(rx)}" y="${n1(base - (r.math.h - r.math.d))}" width="${n1(r.math.w)}" height="${n1(r.math.h)}" viewBox="${r.math.viewBox}" overflow="visible" color="${color ?? TEXT}">${r.math.inner}</svg>`);
      rx += r.math.w;
      sx = rx;
      continue;
    }
    const p = runs[runs.length - 1];
    if (p && !p.b === !r.b && !p.i === !r.i && !p.m === !r.m) p.t += r.t; else runs.push({ ...r });
    rx += width(r, size);
  }
  flush();
}
function textBlock(ls: Line[], x: number, y: number, w: number, center: boolean): string {
  const out: string[] = [];
  let at = y;
  for (const l of ls) {
    at += l.gap;
    // (a picture: an <image> of a raster data: URL, the only source a line's picture has)
    if (l.pic) {
      if (picOk(l.pic.src)) out.push(`<image x="${n1(x)}" y="${n1(at)}" width="${n1(l.pic.w)}" height="${n1(l.lh)}" href="${esc(l.pic.src)}"/>`);
      else out.push(`<rect x="${n1(x)}" y="${n1(at)}" width="${n1(l.pic.w)}" height="${n1(l.lh)}" rx="4" fill="#000" fill-opacity=".06"/>`);
      at += l.lh;
      continue;
    }
    if (l.box === "code") out.push(`<rect x="${n1(x)}" y="${n1(at)}" width="${n1(w)}" height="${n1(l.lh)}" fill="#000" fill-opacity=".05"/>`);
    const lw = lineWidth(l) - l.indent;
    const tx = center ? x + (w - lw) / 2 : x + l.indent;
    const base = at + (l.base ?? l.lh * 0.74);
    if (l.cells && l.grid) {
      // (a table's row: its grid's lines, the header's rule darker, then each cell's runs, cut to the cell)
      const { xs } = l.grid, right = tx + xs[xs.length - 1], bottom = at + l.lh;
      // (as paths, the one element the file's lines are: its top if first, its columns' edges, its bottom; the
      // header's bottom its own, darker and heavier)
      const d = (l.grid.top ? `M${n1(tx)} ${n1(at)}H${n1(right)}` : "") + xs.map((gx) => `M${n1(tx + gx)} ${n1(at)}V${n1(bottom)}`).join("") + (l.grid.head ? "" : `M${n1(tx)} ${n1(bottom)}H${n1(right)}`);
      out.push(`<path d="${d}" fill="none" stroke="${GRID}"/>`);
      if (l.grid.head) out.push(`<path d="M${n1(tx)} ${n1(bottom)}H${n1(right)}" fill="none" stroke="${GRID_HEAD}" stroke-width="1.5"/>`);
      for (const c of l.cells) {
        const room = c.w - 2 * CELL_X;
        let cy = at + CELL_Y;
        for (const cl of c.lines) {
          const used = lineWidth(cl);
          const cx = tx + c.x + CELL_X + (c.align === "center" ? (room - used) / 2 : c.align === "right" ? room - used : 0);
          drawRuns(out, cl.runs, cx, cy + (cl.base ?? cl.lh * 0.74), cl.size, l.color);
          cy += cl.lh;
        }
      }
      at += l.lh;
      continue;
    }
    drawRuns(out, l.runs, tx, base, l.size, l.color);
    at += l.lh;
  }
  return out.join("");
}

/** A page of a board (the first, by default) as an SVG file; `left`: what
 * it shows only in part; `overflow`: the notes whose text does not fit
 * their box (one of a given size, cut there as on the board). */
// (an edge's label's plate: its 12 px text as DejaVu Sans sets it, and a margin)
const labelPlate = (label: string) => width({ t: label }, 12) + 10;
export function boardSvg(doc: BoardDoc, o: { page?: number; math?: MathRenderer } = {}): { svg: string; left: string[]; overflow: string[] } {
  mathOf = o.math ?? null;
  mathCache = new Map();
  mathTex = false;
  pixels = new PixelBudget();
  try { return drawBoard(doc, o); } finally { mathOf = null; mathCache = new Map(); pixels = new PixelBudget(); }
}
function drawBoard(doc: BoardDoc, o: { page?: number }): { svg: string; left: string[]; overflow: string[] } {
  const d = cleanDoc(doc), v = pageView(d, o.page ?? 0), left = new Set<string>(), overflow: string[] = [];
  const { items, edges } = layout(v, measure);
  // (places within ten million, sizes from 1 to ten million: a board's
  // numbers, however large, never make a number SVG cannot use, HARD-270-2)
  let clamped = false;
  const c = (v: number, lo = -LIM, hi = LIM) => { const r = Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : 0; if (r !== v) clamped = true; return r; };
  for (const it of items) {
    it.x = c(it.x); it.y = c(it.y); it.w = c(it.w, 1); it.h = c(it.h, 1);
    if (it.outline) it.outline = it.outline.map((p) => c(p));
  }
  for (const e of edges) {
    if (e.points) e.points = e.points.map((p) => c(p));
    if (e.lx !== undefined) e.lx = c(e.lx);
    if (e.ly !== undefined) e.ly = c(e.ly);
  }
  // the page's look: its slide's card, its background (CORR-270-3)
  const look = lookOf(d, o.page ?? 0), slide = look.slide && { x: c(look.slide.x), y: c(look.slide.y), w: c(look.slide.w, 1), h: c(look.slide.h, 1) }, bg = look.background;
  if (clamped) left.add("places or sizes out of range (brought within it)");
  if (bg?.image) left.add("the page's background picture");
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const it of items) { x0 = Math.min(x0, it.x); y0 = Math.min(y0, it.y); x1 = Math.max(x1, it.x + it.w); y1 = Math.max(y1, it.y + it.h); }
  for (const e of edges) for (let i = 0; i < (e.points?.length ?? 0); i += 2) { x0 = Math.min(x0, e.points![i]); x1 = Math.max(x1, e.points![i]); y0 = Math.min(y0, e.points![i + 1]); y1 = Math.max(y1, e.points![i + 1]); }
  // (and the edges' labels' plates, as wide as their text in the font the SVG says: round 0's 13, a label at the page's edge cut off)
  for (const e of edges) { const b = edgeLabelBox(e, labelPlate); if (b) { x0 = Math.min(x0, b.x0); x1 = Math.max(x1, b.x1); y0 = Math.min(y0, b.y0); y1 = Math.max(y1, b.y1); } }
  if (slide) { x0 = Math.min(x0, slide.x); y0 = Math.min(y0, slide.y); x1 = Math.max(x1, slide.x + slide.w); y1 = Math.max(y1, slide.y + slide.h); }
  if (!items.length && !slide) { x0 = y0 = 0; x1 = y1 = 100; }
  const M = 24;
  x0 -= M; y0 -= M; x1 += M; y1 += M;
  const box = { x0, y0, x1, y1 }, W = x1 - x0, H = y1 - y0;
  // (the background: behind the whole board, or, with a slide, on its card)
  const out: string[] = [`<rect x="${n1(x0)}" y="${n1(y0)}" width="${n1(W)}" height="${n1(H)}" fill="${slide || !bg?.color ? BG : esc(bg.color)}"/>`];
  if (slide) {
    out.push(`<rect x="${n1(slide.x)}" y="${n1(slide.y)}" width="${n1(slide.w)}" height="${n1(slide.h)}" fill="#fff" stroke="#000" stroke-opacity=".18"/>`);
    if (bg?.color) out.push(`<rect x="${n1(slide.x)}" y="${n1(slide.y)}" width="${n1(slide.w)}" height="${n1(slide.h)}" fill="${esc(bg.color)}"/>`);
  }
  out.push(backShapes(items, edges, box, labelPlate));
  const clips: string[] = [];
  // groups' titles and text, outer first
  for (const g of items.filter((it) => it.kind === "group").sort((a, b) => (a.depth ?? 0) - (b.depth ?? 0))) {
    // (its title one line, cut with "…", as on the board: the layout keeps one line's band for it, friction 10)
    const title: Line[] = g.title ? [{ runs: [{ t: ellipsis({ t: g.title.replace(/\n/g, " "), b: true }, 17, Math.max(40, g.w - 48)), b: true }], size: 17, lh: 17 * LH, indent: 0, gap: 0, color: "#24301f" }] : [];
    const ls = [...title, ...(g.text ? lines(g.text, Math.min(g.w - 48, 600)) : [])];
    // (its whole title kept, as the group's <title>, when the line shows it cut: UI-0CC-2)
    if (ls.length) out.push(g.title ? `<g><title>${xmlEscape(g.title.replace(/\n/g, " "))}</title>${textBlock(ls, g.x + 24, g.y + 14, g.w - 48, false)}</g>` : textBlock(ls, g.x + 24, g.y + 14, g.w - 48, false));
  }
  // notes, inner last; each clipped to its box, as on the board
  const notes = items.filter((it) => it.kind === "note" || it.kind === "shape").sort((a, b) => (a.depth ?? 0) - (b.depth ?? 0));
  // (the code items' stored previews, by id: the layout's items don't carry them)
  const previews = new Map<string, Preview>();
  const walk = (ns: readonly any[] | undefined) => { for (const n of ns ?? []) { if (n?.kind === "group") walk(n.children); else if (n?.preview && n.code !== undefined) previews.set(n.id, n.preview); } };
  walk(v.nodes);
  notes.forEach((it, k) => {
    const fill = esc(it.color ?? "#fff"), sp = sidePad(it.shape), centered = !!it.shape;
    const preview = it.code !== undefined ? previews.get(it.id) : undefined;
    const c = content({ title: it.title, text: it.text, code: it.code, hideCode: it.hideCode, ref: it.ref, img: it.image, preview }, it.w - 2 * sp - 2);
    if (it.code !== undefined && !preview) left.add(previews.size ? "code's outputs (of the items with no stored preview)" : "code's outputs");
    clips.push(`<clipPath id="c${k}"><rect x="${n1(it.x)}" y="${n1(it.y)}" width="${n1(it.w)}" height="${n1(it.h)}" rx="8"/></clipPath>`);
    const h = heightOf(c.ls) + (c.pic ? c.pic + 8 : 0);
    if (h + 2 * PAD_Y + 2 + (it.shape === "cylinder" ? 10 : 0) > it.h + 0.5 || c.ls.some((l) => lineWidth(l) > it.w - 2 * sp - 2 + 0.5)) overflow.push(it.id);
    let ty = it.y + PAD_Y + 1 + (it.shape === "cylinder" ? 10 : 0);
    if (centered) ty = Math.max(ty, it.y + (it.h - h) / 2);
    let body = "";
    // (the picture itself when its bytes are in the file and within the budget, else a box saying so)
    const src = it.image?.src;
    if (c.pic && src !== undefined && picOk(src)) {
      body += `<image x="${n1(it.x + sp + 1)}" y="${n1(ty)}" width="${n1(it.w - 2 * sp - 2)}" height="${n1(c.pic)}" href="${esc(src)}" preserveAspectRatio="xMidYMid meet"/>`;
      ty += c.pic + 8;
    } else if (c.pic) {
      left.add("pictures (shown as a box)");
      body += `<rect x="${n1(it.x + sp + 1)}" y="${n1(ty)}" width="${n1(it.w - 2 * sp - 2)}" height="${n1(c.pic)}" rx="4" fill="#000" fill-opacity=".06"/><text x="${n1(it.x + it.w / 2)}" y="${n1(ty + c.pic / 2 + 4)}" text-anchor="middle" font-size="11" fill="#667">picture</text>`;
      ty += c.pic + 8;
    }
    body += textBlock(c.ls, it.x + sp + 1, ty, it.w - 2 * sp - 2, centered);
    out.push(outline(it, fill) + `<g clip-path="url(#c${k})" fill="${TEXT}">${body}</g>`);
  });
  // stickers: an emoji, as large as the sticker
  for (const s of items.filter((it) => it.kind === "sticker")) {
    const e = s.emoji ?? (s.icon ? iconEmoji(s.icon) : "");
    if (e) out.push(`<text x="${n1(s.x + s.w / 2)}" y="${n1(s.y + s.h * 0.82)}" text-anchor="middle" font-size="${n1(s.w * 0.86)}">${esc(e)}</text>`);
  }
  // pen strokes, over all
  for (const it of items.filter((it) => it.kind === "ink" && it.outline)) out.push(`<path d="${inkPath(it.outline!.map((p, i) => p + (i % 2 ? it.y : it.x)), 1)}" fill="${esc(it.color ?? TEXT)}"${it.opacity !== undefined ? ` fill-opacity="${it.opacity}"` : ""}/>`);
  if (mathTex) left.add("math (shown as its TeX)");
  const title = v.title ?? d.title;
  const svg = `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${n1(W)}" height="${n1(H)}" viewBox="${n1(x0)} ${n1(y0)} ${n1(W)} ${n1(H)}" font-family="DejaVu Sans, Verdana, sans-serif" font-size="${FONT}">` +
    (title ? `<title>${esc(title)}</title>` : "") + `<defs>${clips.join("")}</defs>` + out.join("") + "</svg>\n";
  return { svg, left: [...left], overflow };
}
