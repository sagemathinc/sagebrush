// CoCalc's whiteboards and slides (.board, .slides) as Sagebrush boards: a
// one-way converter (Sagebrush boards replace CoCalc's whiteboard; nothing
// goes back).  A CoCalc board is a syncdb file, one JSON element a line,
// {id, type, x, y, w, h, z, page, str, data, ...} (cocalc-ai:
// frame-editors/whiteboard-editor/types.ts):
// - pages are elements {type: "page", data: {pos}}, and an element's `page`
//   is a page's id; in the oldest files there are no page elements, and
//   `page` is a number (1, 2, ...);
// - a note's, a text's and a code cell's content is `str` (Markdown, or
//   code); a note's background is data.color; a code cell's data.kernel
//   and data.hideInput;
// - a frame is a rectangle around elements; an edge joins data.from to
//   data.to;
// - before CoCalc's schema version 1 (data.schemaVersion on its pages),
//   Markdown escaped \( \) \[ \], which were not math: unescaped here, as
//   CoCalc's own migration does.
//
// Notes, texts and code cells become notes (code with its code; a Sage
// kernel makes the board Sage), at their places and widths (their heights
// follow their text); frames become groups holding what is inside them
// (frames within frames, groups within groups); edges become edges.  The
// rest has nothing like it on a board yet (pen strokes, icons, timers,
// stopwatches, chats, terminals, speaker notes, slides' backgrounds): it is
// left out, and counted, so the person is told what was.  Outputs are not
// kept: a board's code runs when it is opened.

import { GROUP_PAD, GROUP_TITLE, type BoardDoc, type BoardPage, type DocEdge, type DocGroup, type DocNode, type DocNote } from "./doc";

const TYPES = new Set(["chat", "code", "edge", "frame", "icon", "note", "page", "pen", "selection", "slide", "stopwatch", "terminal", "text", "timer", "speaker_notes"]);
const NOTE_COLOR = "#fff9c4"; // (CoCalc's note, without a color of its own)

interface El { id: string; type: string; x?: number; y?: number; w?: number; h?: number; z?: number; page?: string | number; str?: string; data?: any; invisible?: boolean; hide?: { w?: number; h?: number } }

const lines = (text: string) => text.split("\n").filter((l) => l.trim());
const element = (e: any): e is El => !!e && typeof e === "object" && !Array.isArray(e) && typeof e.id === "string" && TYPES.has(e.type);

/** Whether a text is a CoCalc whiteboard or slides file (JSON lines of its elements). */
export function isCocalcBoard(text: string): boolean {
  const ls = lines(text);
  if (!ls.length) return false;
  try {
    return ls.slice(0, 50).every((l) => { const e = JSON.parse(l); return element(e) && !("nodes" in e) && !("pages" in e); });
  } catch {
    return false;
  }
}

export interface Converted {
  doc: BoardDoc;
  /** what was left out, by CoCalc's element type: how many */
  left: Record<string, number>;
}

const num = (v: unknown, d = 0) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v * 10) / 10 : d);

/** A CoCalc whiteboard or slides file as a Sagebrush board. */
export function fromCocalcBoard(text: string): Converted {
  const els: El[] = [];
  for (const l of lines(text)) {
    try { const e = JSON.parse(l); if (element(e)) els.push(e); } catch { /* (a line that is not an element: CoCalc skips it too) */ }
  }
  const left: Record<string, number> = {};
  const leave = (t: string) => { left[t] = (left[t] ?? 0) + 1; };

  // pages: by their pos; or, in the oldest files, by number
  const pageEls = els.filter((e) => e.type === "page").sort((a, b) => num(a.data?.pos) - num(b.data?.pos));
  const legacy = !pageEls.length || pageEls.some((p) => !(typeof p.data?.schemaVersion === "number" && p.data.schemaVersion >= 1));
  let count: number, pageOf: (e: El) => number;
  if (pageEls.length) {
    const ix = new Map(pageEls.map((p, i) => [p.id, i]));
    count = pageEls.length;
    pageOf = (e) => ix.get(String(e.page)) ?? 0;
  } else {
    count = Math.max(1, ...els.map((e) => (typeof e.page === "number" && e.page >= 1 ? Math.floor(e.page) : 1)));
    pageOf = (e) => (typeof e.page === "number" && e.page >= 1 ? Math.floor(e.page) - 1 : 0);
  }
  const markdown = (s: unknown) => (typeof s === "string" ? (legacy ? s.replace(/\\([()[\]])/g, "$1") : s) : "");

  const pages = Array.from({ length: count }, () => ({ items: [] as El[], frames: [] as El[], edges: [] as El[] }));
  let sage = false;
  for (const e of els) {
    if (e.type === "page" || e.type === "selection") continue; // (a page is made below; a selection is not content)
    if (e.invisible && e.type !== "speaker_notes") { leave(e.type); continue; }
    const p = pages[Math.min(count - 1, pageOf(e))];
    if (e.type === "note" || e.type === "text" || e.type === "code") p.items.push(e);
    else if (e.type === "frame") p.frames.push(e);
    else if (e.type === "edge") p.edges.push(e);
    else leave(e.type);
  }

  const box = (e: El) => ({ x: num(e.x), y: num(e.y), w: Math.max(1, num(e.hide?.w ?? e.w, 260)), h: Math.max(1, num(e.hide?.h ?? e.h, 100)) });
  const note = (e: El): DocNote => {
    const { w } = box(e);
    if (e.type === "code") {
      if (/sage/i.test(String(e.data?.kernel ?? ""))) sage = true;
      return { id: e.id, code: typeof e.str === "string" ? e.str : "", ...(e.data?.hideInput ? { hideCode: true } : {}), w };
    }
    return { id: e.id, text: markdown(e.str), ...(e.type === "note" ? { color: typeof e.data?.color === "string" ? e.data.color : NOTE_COLOR } : {}), w };
  };

  const converted = pages.map(({ items, frames, edges }): BoardPage => {
    // each frame inside the smallest frame holding it whole; each item in the smallest frame holding its middle
    const area = (e: El) => box(e).w * box(e).h;
    const fs = frames.slice().sort((a, b) => area(b) - area(a));
    const holds = (f: El, x: number, y: number) => { const b = box(f); return x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h; };
    const parent = new Map<string, El | null>();
    fs.forEach((f, i) => {
      const b = box(f);
      parent.set(f.id, fs.slice(0, i).reverse().find((g) => g !== f && holds(g, b.x, b.y) && holds(g, b.x + b.w, b.y + b.h)) ?? null);
    });
    for (const e of items) {
      const b = box(e), cx = b.x + b.w / 2, cy = b.y + b.h / 2;
      parent.set(e.id, fs.slice().reverse().find((f) => holds(f, cx, cy)) ?? null);
    }
    // Places.  A group fits what it holds (its members start at its origin,
    // below its padding and title: doc.ts layout), so each note stays where
    // it was on CoCalc's board, and a group is where its members make it.
    const members = (f: El) => [...fs.filter((g) => parent.get(g.id) === f), ...items.filter((e) => parent.get(e.id) === f)];
    const top = (f: El) => GROUP_PAD + (typeof f.str === "string" && f.str.trim() ? GROUP_TITLE : 0);
    const abs = new Map<string, { x: number; y: number }>();
    const absOf = (e: El): { x: number; y: number } => {
      let a = abs.get(e.id);
      if (a) return a;
      const ms = e.type === "frame" ? members(e).map(absOf) : [];
      const b = box(e);
      a = ms.length ? { x: Math.min(...ms.map((m) => m.x)) - GROUP_PAD, y: Math.min(...ms.map((m) => m.y)) - top(e) } : { x: b.x, y: b.y };
      abs.set(e.id, a);
      return a;
    };
    const place = (e: El) => {
      const a = absOf(e), p = parent.get(e.id);
      if (!p) return { x: num(a.x), y: num(a.y) };
      const o = absOf(p);
      return { x: num(a.x - o.x - GROUP_PAD), y: num(a.y - o.y - top(p)) };
    };
    const byZ = (a: El, b: El) => num(a.z) - num(b.z);
    const children = (f: El | null): DocNode[] => [
      ...fs.filter((g) => (parent.get(g.id) ?? null) === f).sort(byZ).map((g): DocGroup => {
        const title = typeof g.str === "string" ? g.str.trim() : "";
        return { id: g.id, kind: "group", ...(title ? { title } : {}), children: children(g), ...place(g) };
      }),
      ...items.filter((e) => (parent.get(e.id) ?? null) === f).sort(byZ).map((e) => ({ ...note(e), ...place(e) })),
    ];
    const ids = new Set([...items, ...frames].map((e) => e.id));
    const es: DocEdge[] = [];
    for (const e of edges) {
      const from = e.data?.from, to = e.data?.to;
      if (typeof from === "string" && typeof to === "string" && ids.has(from) && ids.has(to)) es.push({ from, to });
      else leave("edge");
    }
    return { nodes: children(null), edges: es };
  });

  const doc: BoardDoc = count === 1
    ? { ...(sage ? { mode: "sage" as const } : {}), nodes: converted[0].nodes, edges: converted[0].edges }
    : { ...(sage ? { mode: "sage" as const } : {}), pages: converted.map((p, i) => ({ title: `Page ${i + 1}`, ...p })) };
  return { doc, left };
}

const NAMES: Record<string, [string, string]> = {
  pen: ["pen stroke", "pen strokes"], icon: ["icon", "icons"], timer: ["timer", "timers"], stopwatch: ["stopwatch", "stopwatches"],
  chat: ["chat", "chats"], terminal: ["terminal", "terminals"], speaker_notes: ["page of speaker notes", "pages of speaker notes"],
  slide: ["slide background", "slide backgrounds"], edge: ["connection to something left out", "connections to something left out"],
  note: ["hidden note", "hidden notes"], text: ["hidden text", "hidden texts"], code: ["hidden code cell", "hidden code cells"], frame: ["hidden frame", "hidden frames"],
};
/** What was left out, in words ("3 pen strokes and 1 timer"), or "" if nothing. */
export function leftOut(left: Record<string, number>): string {
  const parts = Object.entries(left).filter(([, n]) => n > 0).map(([t, n]) => `${n} ${(NAMES[t] ?? [t, t])[n === 1 ? 0 : 1]}`);
  return parts.length > 1 ? parts.slice(0, -1).join(", ") + " and " + parts[parts.length - 1] : parts[0] ?? "";
}
