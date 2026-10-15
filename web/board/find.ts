// Find in a board (Ctrl/Cmd+F, William): what its items say as they are
// written (titles, text and details as Markdown, code, links), never what
// they show (outputs, typeset math).  It searches the document, not the
// page, so on a large board every item is found, mounted or not, on any
// page; the index is made once per version of the document, and a search
// is a scan of its strings.

import { pageCount, pageView, type BoardDoc, type DocNode } from "./doc";

/** An item that says something: its page, its id, and what it says, lower-cased, its parts one per line. */
export interface FindEntry { page: number; id: string; text: string }

const PARTS = ["title", "text", "code", "detail", "ref"] as const;

/** Every item that says something, page by page; on a page in reading
 * order (top to bottom, then left to right, where items are placed; else
 * as the document lists them), a group's items after it. */
export function findIndex(d: BoardDoc): FindEntry[] {
  const out: FindEntry[] = [];
  for (let page = 0; page < pageCount(d); page++) {
    const visit = (ns: DocNode[]) => {
      for (const n of readingOrder(ns)) {
        const x = n as unknown as Record<string, unknown>;
        const text = PARTS.map((k) => (typeof x[k] === "string" ? (x[k] as string) : "")).filter(Boolean).join("\n");
        if (text && typeof x.id === "string") out.push({ page, id: x.id, text: text.toLowerCase() });
        if (Array.isArray(x.children)) visit(x.children as DocNode[]);
      }
    };
    visit(pageView(d, page).nodes ?? []);
  }
  return out;
}

/** The items that say `query` (ignoring case), in the index's order; none for an empty query. */
export function findIn(index: FindEntry[], query: string): FindEntry[] {
  const q = query.toLowerCase();
  return q ? index.filter((e) => e.text.includes(q)) : [];
}

// (a row: items whose tops are within ROW of the row's first)
const ROW = 40;
function readingOrder(ns: DocNode[]): DocNode[] {
  const at = (n: DocNode) => n as unknown as { x?: unknown; y?: unknown };
  if (!ns.every((n) => typeof at(n).x === "number" && typeof at(n).y === "number")) return ns;
  const byTop = [...ns].sort((a, b) => (at(a).y as number) - (at(b).y as number)), out: DocNode[] = [];
  let row: DocNode[] = [], top = 0;
  const flush = () => { out.push(...row.sort((a, b) => (at(a).x as number) - (at(b).x as number))); row = []; };
  for (const n of byTop) {
    if (row.length && (at(n).y as number) >= top + ROW) flush();
    if (!row.length) top = at(n).y as number;
    row.push(n);
  }
  flush();
  return out;
}

/** The ranges of `query` (ignoring case) in an element's text, outputs,
 * typeset math and controls left out; a match may span several text nodes
 * (highlighted code is many). */
export function textRanges(el: Element, query: string): Range[] {
  const q = query.toLowerCase(), nodes: Text[] = [], starts: number[] = [];
  if (!q) return [];
  let all = "";
  const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let t = walk.nextNode() as Text | null; t; t = walk.nextNode() as Text | null) {
    if (t.parentElement?.closest(".board-code-out, .katex, button, textarea, [hidden]")) continue;
    // (a text whose lower case is not as long, as some letters' are not: left out, its offsets would not be its own)
    const s = t.data.toLowerCase();
    if (s.length !== t.data.length) continue;
    nodes.push(t);
    starts.push(all.length);
    all += s;
  }
  const out: Range[] = [];
  const where = (k: number, end: boolean) => {
    // (the text node holding offset k; an end at a node's end stays in it)
    let i = starts.length - 1;
    while (i > 0 && (end ? starts[i] >= k : starts[i] > k)) i--;
    return { node: nodes[i], offset: k - starts[i] };
  };
  for (let k = all.indexOf(q); k >= 0; k = all.indexOf(q, k + q.length)) {
    const a = where(k, false), b = where(k + q.length, true), r = document.createRange();
    r.setStart(a.node, a.offset);
    r.setEnd(b.node, b.offset);
    out.push(r);
  }
  return out;
}
