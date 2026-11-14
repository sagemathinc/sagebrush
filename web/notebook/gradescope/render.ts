// "PDF for Gradescope": the notebook as fixed pages for the browser's own Save as PDF.  The live cells are copied
// (their rendered Markdown, their code, their outputs as they show), never re-rendered, so the PDF is what the
// student sees.  Each exercise's copy is cut into blocks (one Markdown paragraph, a cell's code, one output), measured
// off screen at each fitting stage (layout.ts STAGES), and placed on pages of one size: the cover, then each
// exercise's pages, with a running header.  Printing shows only those pages, at the paper's size with no margins.

import { contentBox, fit, HEADER, MARGIN, pageList, paginate, PAPER, plan, STAGES, type Block, type Fit, type Mode } from "./layout";
import type { Paper, Section } from "./outline";

/** A cell of the live notebook (web/notebook/notebook.js cells()). */
export interface LiveCell { id: string; type: string; el: HTMLElement; ta: HTMLTextAreaElement; hl: HTMLElement; out: HTMLElement; md: HTMLElement }

// (light colors whatever the theme: the page's own print palette, index.html; fonts and sizes of its own, so the
// notebook's print rules, which shrink its text, change nothing measured here)
const CSS = `
.gs-doc { --bg: #fff; --fg: #111; --muted: #555; --line: #ccc; --cell: #fff; --code: #f4f4f1; --edbg: #f8f8f6; --err: #b3261e;
  --hk: #8a3b8f; --hb: #2a6fb0; --hs: #975200; --hn: #0b7a52; --hc: #5f665f; --hd: #7f5800; --hf: #2350a8;
  color: #111; background: #fff; font: 14px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color-scheme: light; }
.gs-doc * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.gs-measure { position: absolute; left: -100000px; top: 0; visibility: hidden; pointer-events: none; }
.gs-b { display: flow-root; padding-bottom: 6px; }
.gs-b > .mdout { display: block; padding: 0; }
.gs-b > .mdout > :first-child { margin-top: 0; }
.gs-b > .mdout > :last-child { margin-bottom: 0; }
.gs-code, .gs-txt { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; tab-size: 4; font: 13px/1.45 ui-monospace, "SF Mono", Menlo, Consolas, monospace; }
.gs-code { padding: 4px 8px; background: var(--edbg); border-left: 3px solid var(--line); }
.gs-txt { padding: 2px 8px 2px 11px; }
.gs-txt .e { color: var(--err); }
.gs-l { display: block; }
.gs-doc figure.plot { margin: 4px 8px; }
.gs-doc figure.plot svg, .gs-doc figure.plot img, .gs-pic img { display: block; max-width: 100%; height: auto; width: auto; max-height: var(--gs-cap, none); }
.gs-doc .interact input, .gs-doc .interact select, .gs-doc .interact button { font: inherit; }
.gs-page { position: relative; box-sizing: border-box; overflow: hidden; background: #fff; break-after: page; page-break-after: always; }
.gs-page:last-child { break-after: auto; page-break-after: auto; }
.gs-head { display: flex; gap: 12px; justify-content: space-between; align-items: baseline; border-bottom: 1px solid #bbb; font-size: 11px; color: #444; white-space: nowrap; overflow: hidden; }
.gs-head .t { overflow: hidden; text-overflow: ellipsis; }
.gs-box { position: relative; overflow: hidden; }
.gs-blank { color: #777; font-style: italic; text-align: center; padding-top: 30%; }
.gs-cover h1 { font-size: 22px; margin: 0 0 18px; }
.gs-field { display: grid; grid-template-columns: 9em 1fr; align-items: end; gap: 8px; margin: 0 0 14px; font-size: 15px; }
.gs-field .v { border-bottom: 1.5px solid #333; min-height: 1.6em; padding: 0 4px; font-size: 17px; }
.gs-banner { border: 2px solid #b45309; color: #7c2d12; padding: 8px 12px; margin: 18px 0; font-weight: 600; }
.gs-layout { position: absolute; left: ${MARGIN}px; bottom: ${MARGIN}px; font-size: 10px; color: #666; }
/* (a mark in each page's corner: a PDF printed scaled, or with the browser's margins, moves it or cuts it off) */
.gs-mark { position: absolute; right: 6px; bottom: 6px; width: 6px; height: 6px; background: #000; }
#gs-print { display: none; }
@media print {
  body.gs-printing > :not(#gs-print) { display: none !important; }
  body.gs-printing { margin: 0 !important; padding: 0 !important; background: #fff !important; }
  body.gs-printing #gs-print { display: block !important; }
}
`;

let styled = false;
function style() {
  if (styled) return;
  styled = true;
  document.head.append(Object.assign(document.createElement("style"), { textContent: CSS }));
}
const h = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text?: string): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

// ------------------------------------------------------------ the copy, as blocks
// A text block is lines (each a span of its own, its inline markup kept), so it can split between any two; anything
// else is one piece.
// (md: a Markdown block, which keeps the notebook's Markdown rules, written for .mdout)
export type Source = { kind: "text"; cls: string; lines: HTMLElement[] } | { kind: "picture" | "block"; node: HTMLElement; md?: boolean };

// The height kept free on every page: a split text block's padding comes again on each of its pieces, and a page can
// begin with one piece and end with another.
const SLACK = 32;
const usable = (paper: Paper) => contentBox(paper).h - SLACK;

/** A node's text as lines, each a .gs-l span holding its part of the inline markup (highlighting, error spans). */
export function splitLines(root: Node): HTMLElement[] {
  const lines: HTMLElement[] = [];
  const stack: Element[] = [];
  let cursor: Node;
  const open = () => {
    const l = h("span", "gs-l");
    lines.push(l);
    cursor = l;
    for (const a of stack) cursor = cursor.appendChild(a.cloneNode(false));
  };
  open();
  const walk = (n: Node) => {
    if (n.nodeType === Node.TEXT_NODE) {
      (n as Text).data.split("\n").forEach((part, i) => {
        if (i) open();
        if (part) cursor.appendChild(document.createTextNode(part));
      });
    } else if (n.nodeType === Node.ELEMENT_NODE) {
      const el = n as Element;
      cursor = cursor.appendChild(el.cloneNode(false));
      stack.push(el);
      for (const k of el.childNodes) walk(k);
      stack.pop();
      cursor = cursor.parentNode!;
    }
  };
  for (const k of root.childNodes) walk(k);
  if (lines.length > 1 && !lines[lines.length - 1].textContent) lines.pop();
  // (an empty line keeps its height)
  for (const l of lines) if (!l.textContent) l.append("​");
  return lines;
}

// (a copy of a live element as it shows: a canvas as its picture, form fields with their current values)
function snapshot(el: HTMLElement): HTMLElement {
  const copy = el.cloneNode(true) as HTMLElement;
  const from = el.querySelectorAll("canvas, input, select, textarea");
  const to = copy.querySelectorAll("canvas, input, select, textarea");
  from.forEach((f, i) => {
    const t = to[i] as HTMLElement;
    if (f instanceof HTMLCanvasElement) {
      // (a 3D view or a graph's canvas sits over its SVG, which is the picture to keep)
      if (f.closest("figure.plot3d, figure.plotgraph")) return t.remove();
      try {
        const img = Object.assign(new Image(), { src: f.toDataURL("image/png"), alt: "" });
        img.style.width = `${f.clientWidth || f.width}px`;
        t.replaceWith(img);
      } catch { t.remove(); }
    } else if (f instanceof HTMLInputElement) {
      if (f.type === "checkbox" || f.type === "radio") (f.checked ? t.setAttribute("checked", "") : t.removeAttribute("checked"));
      else t.setAttribute("value", f.value);
    } else if (f instanceof HTMLSelectElement) {
      [...(t as HTMLSelectElement).options].forEach((o, k) => (k === f.selectedIndex ? o.setAttribute("selected", "") : o.removeAttribute("selected")));
    } else if (f instanceof HTMLTextAreaElement) t.textContent = f.value;
  });
  copy.querySelectorAll(".sb3d-buttons, .player, .fixes, button.copy").forEach((x) => x.remove());
  copy.removeAttribute("id");
  copy.querySelectorAll("[id]").forEach((x) => x.removeAttribute("id"));
  return copy;
}

const PICTURE = /^(IMG|SVG|CANVAS)$/i;
function cellSources(c: LiveCell, outputs: boolean): Source[] {
  const out: Source[] = [];
  if (c.type === "markdown") {
    for (const k of c.md.children) {
      const only = k.children.length === 1 && !k.textContent?.trim() && PICTURE.test(k.children[0].tagName);
      out.push({ kind: only ? "picture" : "block", node: snapshot(k as HTMLElement), md: true });
    }
    return out;
  }
  if (c.type !== "code") {
    if (c.ta.value.trim()) out.push({ kind: "text", cls: "gs-txt", lines: splitLines(document.createTextNode(c.ta.value)) });
    return out;
  }
  if (c.ta.value.trim()) {
    // (the highlighted copy when it is up to date: the editor's pre may end in a filler line)
    const n = c.ta.value.split("\n").length;
    const src = c.hl?.textContent?.startsWith(c.ta.value) ? c.hl : document.createTextNode(c.ta.value);
    out.push({ kind: "text", cls: "gs-code", lines: splitLines(src).slice(0, n) });
  }
  if (outputs) for (const k of c.out.children as HTMLCollectionOf<HTMLElement>) {
    if (k.classList.contains("stdin") || k.classList.contains("fixes")) continue;
    if (k.tagName === "PRE") out.push({ kind: "text", cls: "gs-txt", lines: splitLines(k) });
    else if (k.tagName === "FIGURE" || PICTURE.test(k.tagName)) out.push({ kind: "picture", node: snapshot(k) });
    else out.push({ kind: "block", node: snapshot(k) });
  }
  return out;
}

/** A source's element: the lines [from, to) of a text one, or a copy of the rest. */
function make(s: Source, from?: number, to?: number): HTMLElement {
  const b = h("div", "gs-b");
  if (s.kind === "text") {
    const pre = b.appendChild(h("pre", s.cls));
    for (const l of s.lines.slice(from ?? 0, to ?? s.lines.length)) pre.append(l.cloneNode(true));
  } else {
    const n = s.node.cloneNode(true);
    if (s.md) b.appendChild(h("div", "mdout")).append(n);
    else b.append(n);
  }
  return b;
}

// ------------------------------------------------------------ measuring
export interface Exercise { title: string; budget: number; first: string; sources: Source[]; stages: Block[][] }

function stageStyle(el: HTMLElement, st: (typeof STAGES)[number], H: number) {
  el.style.setProperty("--gs-cap", st.pictureCap == null ? "none" : `${Math.floor(st.pictureCap * H)}px`);
}
function applyStage(b: HTMLElement, s: Source, st: (typeof STAGES)[number]) {
  if (s.kind !== "picture" && st.text !== 1) b.style.zoom = String(st.text);
}

/** Each exercise's blocks measured at each stage, in a box of the paper's content width (the template: no outputs). */
export async function measure(secs: Section[], live: Map<string, LiveCell>, paper: Paper, { outputs = true } = {}): Promise<Exercise[]> {
  style();
  const box = contentBox(paper);
  const H = usable(paper);
  const root = document.body.appendChild(h("div", "sbnb gs-doc gs-measure"));
  root.style.width = `${box.w}px`;
  const exercises: Exercise[] = [];
  try {
    for (const s of secs) {
      const sources = s.cells.flatMap((c) => (live.has(c.id) ? cellSources(live.get(c.id)!, outputs) : []));
      exercises.push({ title: s.exercise.title, budget: s.exercise.pages, first: s.exercise.cell, sources, stages: [] });
    }
    await waitPictures(exercises.flatMap((e) => e.sources.flatMap((s) => (s.kind === "text" ? [] : [s.node]))));
    for (const st of STAGES) {
      stageStyle(root, st, H);
      for (const e of exercises) {
        root.replaceChildren();
        const els = e.sources.map((s) => {
          const b = make(s);
          applyStage(b, s, st);
          return root.appendChild(b);
        });
        await document.fonts?.ready;
        e.stages.push(els.map((b, i) => {
          const r = b.getBoundingClientRect();
          const s = e.sources[i];
          if (s.kind !== "text") return { h: Math.ceil(r.height) };
          const ls = [...b.querySelectorAll(".gs-l")];
          const hs = ls.map((l) => l.getBoundingClientRect().height);
          // (the padding above and below, counted with the first piece; the others' is in SLACK)
          const sum = hs.reduce((a, x) => a + x, 0);
          return { h: Math.ceil(r.height), lines: { hs, top: Math.max(0, r.height - sum) } };
        }));
      }
    }
  } finally {
    root.remove();
  }
  return exercises;
}

async function waitPictures(nodes: HTMLElement[]) {
  const imgs = nodes.flatMap((n) => (n instanceof HTMLImageElement ? [n] : [...n.querySelectorAll("img")]));
  await Promise.all(imgs.map((i) => i.decode().catch(() => {})));
}

/** The pages an exercise's content takes as it is (the first stage). */
export function contentPages(e: Exercise, paper: Paper): number {
  return paginate(e.stages[0], usable(paper)).length;
}

/** The fit of each exercise to its budget. */
export function fits(exercises: Exercise[], paper: Paper): Fit[] {
  return exercises.map((e) => fit(e.stages, usable(paper), e.budget));
}

// ------------------------------------------------------------ the pages
/** layout: which outline the pages follow (outlineHash), on the cover. */
export interface Doc { title: string; name: string; collaborators: string; date: string; paper: Paper; mode: Mode; layout: string }

/** An exercise as the outline has it, in its order: measured and fitted, or null when its heading isn't there. */
export interface Item { title: string; budget: number; ex: Exercise | null; fit: Fit | null }

/** The print view (#gs-print, to be put under body), or the error that makes the fixed layout impossible. */
export function build(doc: Doc, items: Item[]): { el: HTMLElement; pages: number; list: string } | { error: string } {
  style();
  const blank: Fit = { stage: 0, pages: [{ pieces: [], used: 0 }], fits: true, over: 0 };
  const all = items.map((it) => ({ ...it, fit: it.ex && it.fit ? it.fit : blank }));
  const p = plan(all, doc.mode);
  if ("error" in p) return { error: p.error };
  const paper = PAPER[doc.paper], box = contentBox(doc.paper);
  const root = h("div", "sbnb gs-doc");
  root.id = "gs-print";
  root.dataset.paper = doc.paper;
  root.dataset.pages = String(p.pages);
  const page = () => {
    const pg = root.appendChild(h("section", "gs-page"));
    Object.assign(pg.style, { width: `${paper.w}px`, height: `${paper.h}px`, padding: `${MARGIN}px` });
    pg.append(h("div", "gs-mark"));
    return pg;
  };
  const list = pageList(p.exercises);
  // the cover
  {
    const c = page();
    c.classList.add("gs-cover");
    c.append(h("h1", "", doc.title));
    for (const [k, v] of [["Name", doc.name], ["Collaborators", doc.collaborators], ["Date", doc.date]]) {
      const f = c.appendChild(h("div", "gs-field"));
      f.append(h("span", "k", k), h("div", "v", v));
    }
    if (doc.mode === "variable") c.append(h("div", "gs-banner", "Variable length: this PDF doesn't match the assignment's template. In Gradescope, match each question to its pages yourself."));
    c.append(h("div", "gs-layout", `${p.pages} pages · layout ${doc.layout}`));
  }
  let n = 1;
  for (let i = 0; i < p.exercises.length; i++) {
    const pl = p.exercises[i], ex = all[i].ex, st = all[i].fit.stage;
    const total = pl.pages.length + pl.padding;
    for (let k = 0; k < total; k++) {
      n++;
      const pg = page();
      const head = pg.appendChild(h("div", "gs-head"));
      head.style.height = `${HEADER - 8}px`;
      head.style.marginBottom = "8px";
      head.append(h("span", "t", `${doc.title} · ${pl.title}${total > 1 ? ` · page ${k + 1} of ${total}` : ""}`), h("span", "", `${n} / ${p.pages}`));
      const b = pg.appendChild(h("div", "gs-box"));
      Object.assign(b.style, { width: `${box.w}px`, height: `${box.h}px` });
      stageStyle(b, STAGES[st], usable(doc.paper));
      if (!ex) { b.append(h("div", "gs-blank", `${pl.title}: not in this notebook`)); continue; }
      if (k >= pl.pages.length) { b.append(h("div", "gs-blank", `${pl.title} (continued): left blank`)); continue; }
      for (const piece of pl.pages[k].pieces) {
        const s = ex.sources[piece.b];
        const el = make(s, piece.from, piece.to);
        applyStage(el, s, STAGES[st]);
        if (piece.scale) el.style.zoom = String(piece.scale * (Number(el.style.zoom) || 1));
        b.append(el);
      }
    }
  }
  return { el: root, pages: p.pages, list };
}

/** Show only the print view while printing, at the paper's size with no margins; resolves when the dialog closes. */
export async function printView(el: HTMLElement, paper: Paper, print: () => void | Promise<void> = () => window.print()): Promise<void> {
  document.getElementById("gs-print")?.remove();
  document.body.append(el);
  await waitPictures([el]);
  const pageStyle = document.head.appendChild(Object.assign(document.createElement("style"), { textContent: `@page { size: ${PAPER[paper].css}; margin: 0; }` }));
  document.body.classList.add("gs-printing");
  let printed = false;
  const after = () => (printed = true);
  window.addEventListener("afterprint", after);
  try {
    // (window.print() returns when the print dialog closes; afterprint may come just after)
    await print();
    if (!printed) await new Promise<void>((r) => { window.addEventListener("afterprint", () => r(), { once: true }); setTimeout(r, 1000); });
  } finally {
    window.removeEventListener("afterprint", after);
    document.body.classList.remove("gs-printing");
    pageStyle.remove();
    el.remove();
  }
}
