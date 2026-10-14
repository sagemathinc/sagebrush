// A board on paper (Print, or Save as PDF): one sheet per page, or per step
// of a tour with its caption.  Notes are the board's own elements (their text
// selectable, their math KaTeX's, both vector in a PDF); groups and edges,
// which the screen draws on a canvas, are SVG here, so nothing is a bitmap.

import { INK, farLabel, plainTitle, type Backdrop, type Board, type Item, type Edge } from "./board";
import { inkPath } from "./ink";

export interface Sheet {
  items: Item[];
  edges: Edge[];
  /** the world box to show (fitted to the sheet) */
  box: { x0: number; y0: number; x1: number; y1: number };
  title?: string;
  /** Markdown under the picture (a tour step's caption) */
  caption?: string;
  /** a line in the corner: "2 / 7" */
  folio?: string;
  /** the page's slide and background (board.ts Backdrop) */
  backdrop?: Backdrop;
}

export interface PrintOptions {
  paper?: "letter" | "a4";
  orientation?: "landscape" | "portrait";
}

// The sheet's printable box in CSS pixels (96 per inch), inside 0.4 in margins.
function sheetSize(o: PrintOptions) {
  const [w, h] = o.paper === "a4" ? [8.27, 11.69] : [8.5, 11];
  const [W, H] = o.orientation === "portrait" ? [w, h] : [h, w];
  return { W: (W - 0.8) * 96, H: (H - 0.8) * 96, css: `${o.paper === "a4" ? "A4" : "letter"} ${o.orientation ?? "landscape"}` };
}

const GROUP = "#eef2ea", EDGE = "#5f7457";
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// Groups (outer first) and edges as SVG, in world coordinates.
function backSvg(items: Item[], edges: Edge[], box: Sheet["box"]): string {
  const byId = new Map(items.map((it) => [it.id, it]));
  const out: string[] = [];
  // (clipped here to the sheet: Chrome's PDFs do not always clip shapes far
  // larger than the page, a group of thousands of notes seen close up)
  const M = 40, cx0 = box.x0 - M, cy0 = box.y0 - M, cx1 = box.x1 + M, cy1 = box.y1 + M;
  for (const g of items.filter((it) => it.kind === "group").sort((a, b) => (a.depth ?? 0) - (b.depth ?? 0))) {
    const x0 = Math.max(g.x, cx0), y0 = Math.max(g.y, cy0), x1 = Math.min(g.x + g.w, cx1), y1 = Math.min(g.y + g.h, cy1);
    if (x0 >= x1 || y0 >= y1) continue;
    out.push(`<rect x="${x0}" y="${y0}" width="${x1 - x0}" height="${y1 - y0}" rx="14" fill="${esc(g.color ?? GROUP)}" stroke="rgba(0,0,0,.18)" stroke-width="1"/>`);
  }
  const labels: string[] = [];
  for (const e of edges) {
    const a = byId.get(e.from), b = byId.get(e.to);
    if (!a || !b) continue;
    let p = e.points;
    if (!p) {
      // straight, border to border
      const ax = a.x + a.w / 2, ay = a.y + a.h / 2, bx = b.x + b.w / 2, by = b.y + b.h / 2, dx = bx - ax, dy = by - ay;
      const t = (it: Item) => Math.min(dx ? it.w / 2 / Math.abs(dx) : Infinity, dy ? it.h / 2 / Math.abs(dy) : Infinity);
      const t0 = t(a), t1 = 1 - t(b);
      if (t1 <= t0) continue;
      p = [ax + dx * t0, ay + dy * t0, ax + dx * t1, ay + dy * t1];
    }
    let ex0 = Infinity, ey0 = Infinity, ex1 = -Infinity, ey1 = -Infinity;
    for (let i = 0; i < p.length; i += 2) { ex0 = Math.min(ex0, p[i]); ex1 = Math.max(ex1, p[i]); ey0 = Math.min(ey0, p[i + 1]); ey1 = Math.max(ey1, p[i + 1]); }
    if (ex1 < cx0 || ex0 > cx1 || ey1 < cy0 || ey0 > cy1) continue;
    const n = p.length, head = 9, end = e.arrow !== "none", start = e.arrow === "both";
    const ex = p[n - 2], ey = p[n - 1], ddx = ex - p[n - 4], ddy = ey - p[n - 3], len = Math.hypot(ddx, ddy) || 1, ux = ddx / len, uy = ddy / len;
    const sl = Math.hypot(p[2] - p[0], p[3] - p[1]) || 1, vx = (p[0] - p[2]) / sl, vy = (p[1] - p[3]) / sl;
    // rounded corners (radius 10, or half the shorter segment)
    let d = start ? `M${p[0] - vx * head * 0.8} ${p[1] - vy * head * 0.8}` : `M${p[0]} ${p[1]}`;
    for (let i = 2; i < n - 2; i += 2) {
      const r = Math.min(10, Math.hypot(p[i] - p[i - 2], p[i + 1] - p[i - 1]) / 2, Math.hypot(p[i + 2] - p[i], p[i + 3] - p[i + 1]) / 2);
      const ix = (p[i - 2] - p[i]), iy = (p[i - 1] - p[i + 1]), il = Math.hypot(ix, iy) || 1;
      const ox = (p[i + 2] - p[i]), oy = (p[i + 3] - p[i + 1]), ol = Math.hypot(ox, oy) || 1;
      d += ` L${p[i] + (ix / il) * r} ${p[i + 1] + (iy / il) * r} Q${p[i]} ${p[i + 1]} ${p[i] + (ox / ol) * r} ${p[i + 1] + (oy / ol) * r}`;
    }
    d += end ? ` L${ex - ux * head * 0.8} ${ey - uy * head * 0.8}` : ` L${ex} ${ey}`;
    out.push(`<path d="${d}" fill="none" stroke="${EDGE}" stroke-width="${e.line === "thick" ? 3.2 : 1.6}"${e.line === "dotted" ? ' stroke-dasharray="4 4"' : ""}/>`);
    const tip = (x: number, y: number, ux: number, uy: number) => `<path d="M${x} ${y}L${x - ux * head - uy * head * 0.45} ${y - uy * head + ux * head * 0.45}L${x - ux * head + uy * head * 0.45} ${y - uy * head - ux * head * 0.45}Z" fill="${EDGE}"/>`;
    if (end) out.push(tip(ex, ey, ux, uy));
    if (start) out.push(tip(p[0], p[1], vx, vy));
    if (e.label) {
      const x = e.lx ?? (p[0] + ex) / 2, y = e.ly ?? (p[1] + ey) / 2, w = e.label.length * 6.8 + 10;
      labels.push(`<rect x="${x - w / 2}" y="${y - 9}" width="${w}" height="18" fill="#fafaf7" fill-opacity=".95"/><text x="${x}" y="${y}" text-anchor="middle" dominant-baseline="middle" font-size="12" fill="#3d4a37">${esc(e.label)}</text>`);
    }
  }
  const w = box.x1 - box.x0, h = box.y1 - box.y0;
  return `<svg xmlns="http://www.w3.org/2000/svg" class="pr-back" style="position:absolute;left:${box.x0}px;top:${box.y0}px;overflow:visible" width="${w}" height="${h}" viewBox="${box.x0} ${box.y0} ${w} ${h}" font-family="system-ui, sans-serif">${out.join("")}${labels.join("")}</svg>`;
}

/**
 * Lay the sheets out in a print root (#board-print) and open the browser's
 * print dialog (Save as PDF is one of its destinations); `dialog: false`
 * only builds them (for Page.printToPDF, or a look).  Returns the root.
 */
export async function printSheets(board: Board, sheets: Sheet[], o: PrintOptions & { dialog?: boolean; markdown?: (s: string) => string } = {}): Promise<HTMLElement> {
  document.getElementById("board-print")?.remove();
  const { W, H, css } = sheetSize(o);
  const root = document.createElement("div");
  root.id = "board-print";
  const style = document.createElement("style");
  style.textContent = `@page { size: ${css}; margin: 0.4in; }
@media print {
  html, body { height: auto !important; overflow: visible !important; background: #fff !important; }
  body > *:not(#board-print) { display: none !important; }
  #board-print { display: block !important; }
}
#board-print { display: none; }
#board-print .pr-sheet { width: ${W}px; height: ${H}px; position: relative; overflow: hidden; break-after: page; page-break-after: always; display: flex; flex-direction: column; font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; color: #1d241a; }
#board-print .pr-sheet:last-child { break-after: auto; page-break-after: auto; }
#board-print .pr-head { display: flex; justify-content: space-between; align-items: baseline; font-size: 12px; color: #556; margin-bottom: 6px; }
#board-print .pr-head b { font-size: 15px; color: #1d241a; }
#board-print .pr-view { position: relative; flex: 1; overflow: hidden; contain: strict; }
#board-print .pr-world { position: absolute; left: 0; top: 0; transform-origin: 0 0; }
#board-print .pr-caption { margin-top: 8px; padding-top: 8px; border-top: 1px solid #ddd; font-size: 14px; }
#board-print .pr-caption p { margin: 0 0 4px; }
#board-print * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
#board-print .board-item:not(.board-shape-subroutine) { box-shadow: none; }
#board-print .board-detail { opacity: 1; }
#board-print .board-code-run, #board-print .board-code-toggle { display: none; }`;
  root.append(style);
  for (const s of sheets) {
    const sheet = document.createElement("section");
    sheet.className = "pr-sheet";
    if (s.title || s.folio) {
      const head = document.createElement("div");
      head.className = "pr-head";
      head.append(Object.assign(document.createElement("b"), { textContent: s.title ?? "" }), Object.assign(document.createElement("span"), { textContent: s.folio ?? "" }));
      sheet.append(head);
    }
    const view = document.createElement("div");
    view.className = "pr-view";
    sheet.append(view);
    let cap: HTMLElement | null = null;
    if (s.caption) {
      cap = document.createElement("div");
      cap.className = "pr-caption";
      cap.innerHTML = o.markdown ? o.markdown(s.caption) : esc(s.caption);
      board.typeset?.(cap);
      sheet.append(cap);
    }
    root.append(sheet);
    // (the view's size is known once the sheet is in the page: measure it then)
    (sheet as any)._fill = () => {
      const vw = view.clientWidth || W, vh = view.clientHeight || H;
      const pad = 12, bw = s.box.x1 - s.box.x0 + 2 * pad, bh = s.box.y1 - s.box.y0 + 2 * pad;
      const k = Math.min(vw / bw, vh / bh, 1.5);
      // (the world the sheet shows: the box, centered, and what is around it)
      const v = { x0: (s.box.x0 + s.box.x1) / 2 - vw / k / 2, y0: (s.box.y0 + s.box.y1) / 2 - vh / k / 2, x1: (s.box.x0 + s.box.x1) / 2 + vw / k / 2, y1: (s.box.y0 + s.box.y1) / 2 + vh / k / 2 };
      const world = document.createElement("div");
      world.className = "pr-world";
      world.style.transform = `scale(${k}) translate(${-v.x0}px, ${-v.y0}px)`;
      world.innerHTML = backSvg(s.items, s.edges, v);
      // (the page's backdrop under all: the slide's card, the background's color, a picture on the card;
      // made as elements, their styles set as properties: nothing of the document is markup)
      const bd = s.backdrop;
      if (bd) {
        const r = bd.slide ?? { x: v.x0, y: v.y0, w: v.x1 - v.x0, h: v.y1 - v.y0 };
        const layer = (style: (st: CSSStyleDeclaration) => void) => {
          const el = document.createElement("div");
          Object.assign(el.style, { position: "absolute", left: r.x + "px", top: r.y + "px", width: r.w + "px", height: r.h + "px" });
          style(el.style);
          return el;
        };
        const layers: HTMLElement[] = [];
        if (bd.slide) layers.push(layer((st) => { st.background = "#fff"; st.boxShadow = "0 1px 6px rgba(0, 0, 0, .18)"; }));
        if (bd.color) layers.push(layer((st) => { st.backgroundColor = bd.color!; }));
        const url = bd.slide && bd.image ? board.imageUrl?.(bd.image) : undefined;
        if (url) layers.push(layer((st) => { st.backgroundImage = `url(${JSON.stringify(url)})`; st.backgroundSize = "cover"; st.backgroundPosition = "center"; }));
        world.prepend(...layers);
      }
      // groups (outer first), then notes, then ink over them as on screen
      const shown = s.items.filter((it) => !(it.x > v.x1 || it.x + it.w < v.x0 || it.y > v.y1 || it.y + it.h < v.y0));
      const rank = (it: Item) => (it.kind === "group" ? (it.depth ?? 0) : 1000);
      // (text too small to read on paper, under 4 px: as the screen far out,
      // boxes with the titles that are legible, and the groups' titles)
      const far = 12 * k < 4;
      if (far) {
        sheet.dataset.far = "1";
        const out: string[] = [];
        for (const it of shown) {
          if (it.kind !== "note" && it.kind !== "shape") continue;
          out.push(`<rect x="${it.x}" y="${it.y}" width="${it.w}" height="${it.h}" fill="${esc(it.color ?? "#9cc28f")}"${it.w * k > 8 ? ` stroke="rgba(0,0,0,.2)" stroke-width="${0.5 / k}"` : ""}/>`);
          const fs = 6 / k;
          const t = farLabel(it);
          if (t && t.length * fs * 0.55 < it.w - 4 / k) out.push(`<text x="${it.x + 3 / k}" y="${it.y + fs * 1.2}" font-size="${fs}" fill="#10140f">${esc(t)}</text>`);
        }
        // (a map's rule, as on screen: a group is labeled while 100 to 1,000
        // pixels wide, unless it has no groups inside)
        const parents = new Set(shown.filter((it) => it.kind === "group").map((it) => it.parent).filter(Boolean));
        for (const g of shown.filter((it) => it.kind === "group" && it.title)) {
          if (g.w * k < 100 || (g.w * k > 1000 && parents.has(g.id))) continue;
          const fs = Math.min(14 / k, (g.w / (plainTitle(g.title!).length * 0.6)));
          if (fs * k >= 7) out.push(`<text x="${g.x + 6 / k}" y="${g.y + fs * 1.1}" font-size="${fs}" font-weight="600" fill="#1d241a" stroke="#fafaf7" stroke-width="${3 / k}" paint-order="stroke">${esc(plainTitle(g.title!))}</text>`);
        }
        world.insertAdjacentHTML("beforeend", `<svg xmlns="http://www.w3.org/2000/svg" style="position:absolute;left:${v.x0}px;top:${v.y0}px;overflow:visible" width="${v.x1 - v.x0}" height="${v.y1 - v.y0}" viewBox="${v.x0} ${v.y0} ${v.x1 - v.x0} ${v.y1 - v.y0}" font-family="system-ui, sans-serif">${out.join("")}</svg>`);
      }
      for (const it of far ? [] : shown.filter((it) => it.kind !== "ink").sort((a, b) => rank(a) - rank(b))) {
        // (a group: its header, at its top left, and no larger than the sheet)
        if (it.kind === "group" && (it.x + 700 < v.x0 || it.y + 200 < v.y0)) continue;
        const el = board.content(it, true);
        const w = it.kind === "group" ? Math.min(it.w, v.x1 - it.x + 40) : it.w, h = it.kind === "group" ? Math.min(it.h, v.y1 - it.y + 40) : it.h;
        el.style.cssText = `left:${it.x}px;top:${it.y}px;width:${w}px;height:${h}px;` + (it.color && it.kind !== "group" ? `--c:${it.color};` : "");
        world.append(el);
      }
      const ink = shown.filter((it) => it.kind === "ink" && (it.points || it.outline));
      if (ink.length) {
        const paths = ink.map((it) => {
          // (a pen's stroke: its outline, filled)
          if (it.outline) return `<path d="${inkPath(it.outline.map((v, i) => v + (i % 2 ? it.y : it.x)), 1)}" fill="${esc(it.color ?? INK)}"${it.opacity !== undefined ? ` fill-opacity="${it.opacity}"` : ""}/>`;
          const p = it.points!;
          let d = "";
          for (let i = 0; i < p.length; i += 2) d += (i ? "L" : "M") + (it.x + p[i]).toFixed(1) + " " + (it.y + p[i + 1]).toFixed(1);
          return `<path d="${d}" fill="none" stroke="${esc(it.color ?? "#2a6f2f")}" stroke-width="${it.width ?? 2}" stroke-linecap="round" stroke-linejoin="round"/>`;
        });
        const b = { x0: v.x0, y0: v.y0, w: v.x1 - v.x0, h: v.y1 - v.y0 };
        world.insertAdjacentHTML("beforeend", `<svg xmlns="http://www.w3.org/2000/svg" style="position:absolute;left:${b.x0}px;top:${b.y0}px;overflow:visible;z-index:2" width="${b.w}" height="${b.h}" viewBox="${b.x0} ${b.y0} ${b.w} ${b.h}">${paths.join("")}</svg>`);
      }
      view.append(world);
    };
  }
  document.body.append(root);
  // lay out each sheet's picture at its measured size (shown for that moment)
  await document.fonts?.ready;
  root.style.cssText = "display:block;position:absolute;left:-100000px;top:0";
  for (const sheet of root.querySelectorAll<HTMLElement>(".pr-sheet")) (sheet as any)._fill();
  root.style.cssText = "";
  await document.fonts?.ready;
  if (o.dialog !== false) {
    const done = () => { removeEventListener("afterprint", done); root.remove(); };
    addEventListener("afterprint", done);
    print();
  }
  return root;
}
