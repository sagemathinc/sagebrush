// "PDF for Gradescope": the page model and fitting, as pure functions over measured heights (CSS pixels at 96 per
// inch), so they are tested without a browser.  The renderer measures each exercise's blocks (a cell's input, one
// output, one paragraph of markdown) at each fitting stage; these functions decide the pages.
//
// Every page is the same box: the paper less 12 mm margins and a running header.  An exercise starts on a new page
// and, in the fixed-length layout, takes exactly its budget of pages, padded with "continued" pages; so every PDF of
// an assignment, and its template, has 1 (the cover) + the sum of the budgets pages.  Text blocks (code, plain output)
// split between pages at line boundaries; pictures never split.

import type { Paper } from "./outline";

export const PX_PER_MM = 96 / 25.4;
export const PAPER: Record<Paper, { w: number; h: number; css: string }> = {
  letter: { w: 8.5 * 96, h: 11 * 96, css: "letter" },
  a4: { w: 210 * PX_PER_MM, h: 297 * PX_PER_MM, css: "A4" },
};
export const MARGIN = 12 * PX_PER_MM;
export const HEADER = 30;

/** The box an exercise's content fills on each page. */
export function contentBox(paper: Paper): { w: number; h: number } {
  const p = PAPER[paper];
  return { w: Math.floor(p.w - 2 * MARGIN), h: Math.floor(p.h - 2 * MARGIN - HEADER) };
}

/**
 * The fitting stages, tried in order until an exercise fits its budget: as is; pictures capped at 45% of the page
 * height; then text at 90% and 80% (the floor: graders must read it).
 */
export const STAGES = [
  { text: 1, pictureCap: null },
  { text: 1, pictureCap: 0.45 },
  { text: 0.9, pictureCap: 0.45 },
  { text: 0.8, pictureCap: 0.45 },
] as const;

/** A measured block: its height, and for text that may split, each line's height (a wrapped line is one taller line)
 * and the space above them. */
export interface Block { h: number; lines?: { hs: number[]; top: number } }
/** A block, or the lines [from, to) of a text block, placed on a page; `scale` < 1 shrinks a picture taller than a page. */
export interface Piece { b: number; from?: number; to?: number; scale?: number }
export interface Page { pieces: Piece[]; used: number }

/** Blocks packed into pages of height `H`, in order: a text block splits at a line boundary, anything else moves whole. */
export function paginate(blocks: Block[], H: number): Page[] {
  const pages: Page[] = [];
  let cur: Page = { pieces: [], used: 0 };
  const next = () => {
    pages.push(cur);
    cur = { pieces: [], used: 0 };
  };
  blocks.forEach((blk, b) => {
    if (cur.used + blk.h <= H) {
      cur.pieces.push({ b });
      cur.used += blk.h;
      return;
    }
    const L = blk.lines;
    if (L && L.hs.length > 1) {
      let from = 0;
      while (from < L.hs.length) {
        const top = from === 0 ? L.top : 0;
        let to = from, used = cur.used + top;
        while (to < L.hs.length && used + L.hs[to] <= H) used += L.hs[to++];
        if (to === from) {
          if (cur.pieces.length) { next(); continue; }
          // (one line taller than a page, a long line wrapped many times: it goes alone, shrunk to the page as a block
          // taller than a page is (fit() refuses one shrunk past the text's floor), never cut)
          to = from + 1;
          used = H;
          cur.pieces.push({ b, from, to, scale: H / (top + L.hs[from]) });
          cur.used = used;
          from = to;
          if (from < L.hs.length) next();
          continue;
        }
        cur.pieces.push({ b, from, to });
        cur.used = used;
        from = to;
        if (from < L.hs.length) next();
      }
      return;
    }
    if (cur.pieces.length) next();
    if (blk.h > H) {
      // (a text block of one line is marked as text, its lines [0, 1), so fit() holds it to the text's floor)
      cur.pieces.push(blk.lines ? { b, from: 0, to: blk.lines.hs.length, scale: H / blk.h } : { b, scale: H / blk.h });
      cur.used = H;
    } else {
      cur.pieces.push({ b });
      cur.used = blk.h;
    }
  });
  if (cur.pieces.length || !pages.length) pages.push(cur);
  return pages;
}

/** The smallest text a grader can read: the last stage's text size.  A line shrunk below it can't be printed. */
export const TEXT_FLOOR = STAGES[STAGES.length - 1].text;
/** The size text prints at on these pages at a stage of text size `text`: its smallest shrunk line's, else `text`. */
export function textScale(pages: Page[], text: number): number {
  let least = 1;
  for (const p of pages) for (const x of p.pieces) if (x.from !== undefined && x.scale !== undefined) least = Math.min(least, x.scale);
  return text * least;
}

/**
 * `illegible`: a line of text would print below TEXT_FLOOR (one line taller than a page, shrunk to fit it), so no PDF
 * is offered, fixed or variable; `smallest` is the size it would print at.
 */
export interface Fit { stage: number; pages: Page[]; fits: boolean; over: number; illegible?: boolean; smallest?: number }

/**
 * The first stage at which an exercise's blocks fit `budget` pages with every line readable; if none does, the last
 * stage's pages and how many pages too long it is (to a tenth, at least 0.1), or that a line can't be printed.
 */
export function fit(stages: Block[][], H: number, budget: number): Fit {
  let last: Page[] = [];
  let smallest = 1;
  for (let s = 0; s < stages.length; s++) {
    last = paginate(stages[s], H);
    smallest = textScale(last, STAGES[Math.min(s, STAGES.length - 1)].text);
    const legible = smallest >= TEXT_FLOOR - 1e-9;
    if (last.length <= budget && legible) return { stage: s, pages: last, fits: true, over: 0 };
  }
  const extra = last.length - 1 + last[last.length - 1].used / H - budget;
  const illegible = smallest < TEXT_FLOOR - 1e-9;
  return { stage: stages.length - 1, pages: last, fits: false, over: Math.max(0.1, Math.round(extra * 10) / 10), ...(illegible ? { illegible, smallest } : {}) };
}

export type Mode = "fixed" | "variable";
export interface Planned { title: string; first: number; pages: Page[]; padding: number }

/**
 * The document's pages after the cover (page 1).  Fixed: each exercise takes exactly its budget (pages it doesn't use
 * are "continued" pages); an exercise that doesn't fit makes the fixed layout impossible.  Variable: each exercise takes
 * the pages it needs.
 */
export function plan(exercises: { title: string; budget: number; fit: Fit }[], mode: Mode): { pages: number; exercises: Planned[] } | { error: string } {
  let at = 2;
  const out: Planned[] = [];
  for (const e of exercises) {
    if (e.fit.illegible) return { error: `${e.title} has a line too long to print: it would be ${Math.round((e.fit.smallest ?? 0) * 100)}% of its size` };
    if (mode === "fixed" && !e.fit.fits) return { error: `${e.title} is about ${e.fit.over} ${e.fit.over === 1 ? "page" : "pages"} longer than its ${e.budget} ${e.budget === 1 ? "page" : "pages"}` };
    const n = mode === "fixed" ? e.budget : e.fit.pages.length;
    out.push({ title: e.title, first: at, pages: e.fit.pages, padding: n - e.fit.pages.length });
    at += n;
  }
  return { pages: at - 1, exercises: out };
}

/** Gradescope's outline as text: the name on page 1, then each exercise's pages. */
export function pageList(planned: Planned[]): string {
  const span = (p: Planned) => {
    const last = p.first + p.pages.length + p.padding - 1;
    return last === p.first ? `page ${p.first}` : `pages ${p.first}–${last}`;
  };
  return ["Name: page 1", ...planned.map((p) => `${p.title}: ${span(p)}`)].join("\n");
}
