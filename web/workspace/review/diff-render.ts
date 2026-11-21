// What the review page and the Delegate proposal view both draw (moved here from review-page.ts unchanged): the DOM
// helper, the views' style, a text diff with three lines of context, and a notebook's cells compared base to head. In
// the review chunk (sagebrush-review.js) with both views.
import { REVIEW_DIFF, reviewLineDiff, type Seg } from "./line-diff";
import { CELL_LIMITS, cellDiff, foldRows, type CellKey } from "./cells";

/** The words the diffs show; review-page.ts's REVIEW_PAGE_TEXT carries them too. */
export const DIFF_TEXT = {
  unchangedCells: (n: number) => (n === 1 ? "1 unchanged cell" : `${n.toLocaleString("en-US")} unchanged cells`),
  unchangedLines: (n: number) => (n === 1 ? "1 unchanged line" : `${n.toLocaleString("en-US")} unchanged lines`),
  moreCells: (n: number) => (n === 1 ? "1 more changed cell not shown" : `${n.toLocaleString("en-US")} more changed cells not shown`),
  tooManyCells: `Too many cells to compare (more than ${CELL_LIMITS.cells.toLocaleString("en-US")}).`,
} as const;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & { className?: string } = {}, ...kids: (Node | string | null | undefined | false)[]): HTMLElementTagNameMap[K] {
  const e = Object.assign(document.createElement(tag), props);
  for (const k of kids) if (k) e.append(k);
  return e;
}

let styled = false;
/** The views' style, added once. */
export function style() {
  if (styled) return;
  styled = true;
  document.head.append(h("style", { textContent: `
.sbrv{font:14px/1.4 system-ui,sans-serif;color:#222}
.sbrv h3{font-size:16px;margin:.4em 0}
.sbrv .st{color:#555;margin:.2em 0 .6em}
.sbrv .file{border-top:1px solid #ddd;padding:.5em 0}
.sbrv .path{font-family:ui-monospace,monospace;cursor:pointer;background:none;border:0;padding:0;color:#0645ad;text-align:left}
.sbrv .run{color:#555;font-size:13px}
.sbrv .dec label{margin-right:1em}
.sbrv .dec input[type=text]{width:60%}
.sbrv .msg{color:#8a1f11;margin:.3em 0}
.sbrv pre.diff{font:12px/1.35 ui-monospace,monospace;margin:.3em 0;white-space:pre-wrap;word-break:break-all}
.sbrv .l-{background:#fdecec}.sbrv .l\\+{background:#e8f5e9}
.sbrv .fold{color:#777;font-style:italic;font-size:12px;margin:.2em 0}
.sbrv .cell{border-left:3px solid #ccc;padding-left:.5em;margin:.3em 0}
.sbrv .cell.add{border-color:#4caf50}.sbrv .cell.del{border-color:#e57373}.sbrv .cell.chg{border-color:#ffb300}
.sbrv textarea{width:100%;min-height:3em}
.sbrv .branches button{display:block;margin:.3em 0;text-align:left;background:none;border:0;color:#0645ad;cursor:pointer}
` }));
}

/** A text diff, three lines of context, longer unchanged runs folded; null past REVIEW_DIFF.renderLines. */
export function textDiff(a: string[], b: string[], segs: Seg[], budget = { lines: REVIEW_DIFF.renderLines }): HTMLElement | null {
  const out = h("pre", { className: "diff" });
  const line = (cls: string, t: string) => { if (--budget.lines < 0) return false; out.append(h("div", { className: cls, textContent: (cls === "l-" ? "- " : cls === "l+" ? "+ " : "  ") + t.replace(/\n$/, "") })); return true; };
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    if (s.t === "-") { for (let k = 0; k < s.n; k++) if (!line("l-", a[s.a + k])) return null; continue; }
    if (s.t === "+") { for (let k = 0; k < s.n; k++) if (!line("l+", b[s.b + k])) return null; continue; }
    const head = i === 0 ? 0 : 3, tail = i === segs.length - 1 ? 0 : 3;
    if (s.n <= head + tail + 1) { for (let k = 0; k < s.n; k++) if (!line("l", a[s.a + k])) return null; continue; }
    for (let k = 0; k < head; k++) if (!line("l", a[s.a + k])) return null;
    out.append(h("div", { className: "fold", textContent: DIFF_TEXT.unchangedLines(s.n - head - tail) }));
    for (let k = s.n - tail; k < s.n; k++) if (!line("l", a[s.a + k])) return null;
  }
  return out;
}

/** A notebook's cells, base to head: unchanged runs folded, each changed cell its code's diff, each added or deleted
 * cell its code; one comparison budget and one render budget for the file, the rest counted past them. */
export async function notebookDiff(box: HTMLElement, A: CellKey[], B: CellKey[], stale: () => boolean) {
  const rows = cellDiff(A, B);
  if (!rows) { box.append(h("p", { textContent: DIFF_TEXT.tooManyCells })); return; }
  let budget = REVIEW_DIFF.budget, notShown = 0, k = 0;
  const lines = { lines: REVIEW_DIFF.renderLines };
  for (const r of foldRows(rows)) {
    // (every 50 rows a task's turn, so a close or a change can come in and stop it)
    if (++k % 50 === 0) { await new Promise((r) => setTimeout(r, 0)); if (stale()) return; }
    if ("fold" in r) { box.append(h("div", { className: "fold", textContent: DIFF_TEXT.unchangedCells(r.fold) })); continue; }
    if (notShown) { notShown++; continue; }
    const [a, b] = r.t === "+" ? ["", B[r.b].code] : r.t === "-" ? [A[r.a].code, ""] : [A[r.a].code, B[r.b].code];
    const d = reviewLineDiff(a, b, { budget });
    if (!d.ok) { notShown++; continue; }
    budget -= d.used;
    const pre = textDiff(d.a, d.b, d.segs, lines);
    if (!pre) { notShown++; continue; }
    box.append(h("div", { className: "cell " + (r.t === "+" ? "add" : r.t === "-" ? "del" : "chg") }, pre));
  }
  if (notShown) box.append(h("p", { className: "fold", textContent: DIFF_TEXT.moreCells(notShown) }));
}
