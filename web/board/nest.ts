// Boxes on a plane as a board's tree (the converters: cocalc.ts, canvas.ts).
// Frames are rectangles around what is inside them, as CoCalc's frames and
// JSON Canvas's groups are: each frame goes in the smallest frame holding it
// whole, each item in the smallest frame holding its middle.  Frames become
// groups, items notes, and each keeps its place: a group fits what it holds
// (its members start at its origin, below its padding and title: doc.ts
// layout), so a note stays where it was, and a group is where its members
// make it.

import { GROUP_PAD, GROUP_TITLE, type DocGroup, type DocInk, type DocNode, type DocNote, type DocSticker } from "./doc";

export interface Box { id: string; x: number; y: number; w: number; h: number; z: number }

const round = (v: number) => Math.round(v * 10) / 10;

/** The tree of `frames` and `items`: a frame's group by `group` (its title,
 * whether it has one, decides where its members start), an item's note (or
 * stroke) by `note`; each placed, siblings in the order of their z. */
export function nest<F extends Box, I extends Box>(frames: F[], items: I[], group: (f: F) => Omit<DocGroup, "kind" | "children" | "x" | "y">, note: (i: I) => DocNote | DocInk | DocSticker): DocNode[] {
  const fs = frames.slice().sort((a, b) => b.w * b.h - a.w * a.h);
  const holds = (f: Box, x: number, y: number) => x >= f.x && x <= f.x + f.w && y >= f.y && y <= f.y + f.h;
  const parent = new Map<string, F | null>();
  fs.forEach((f, i) => parent.set(f.id, fs.slice(0, i).reverse().find((g) => g !== f && holds(g, f.x, f.y) && holds(g, f.x + f.w, f.y + f.h)) ?? null));
  for (const e of items) parent.set(e.id, fs.slice().reverse().find((f) => holds(f, e.x + e.w / 2, e.y + e.h / 2)) ?? null);
  const groups = new Map(fs.map((f) => [f.id, group(f)]));
  const members = (f: F) => [...fs.filter((g) => parent.get(g.id) === f), ...items.filter((e) => parent.get(e.id) === f)];
  const top = (f: F) => GROUP_PAD + (groups.get(f.id)!.title ? GROUP_TITLE : 0);
  const abs = new Map<string, { x: number; y: number }>();
  const absOf = (e: Box): { x: number; y: number } => {
    let a = abs.get(e.id);
    if (a) return a;
    const f = groups.has(e.id) ? (e as F) : null;
    const ms = f ? members(f).map(absOf) : [];
    a = f && ms.length ? { x: Math.min(...ms.map((m) => m.x)) - GROUP_PAD, y: Math.min(...ms.map((m) => m.y)) - top(f) } : { x: e.x, y: e.y };
    abs.set(e.id, a);
    return a;
  };
  const place = (e: Box) => {
    const a = absOf(e), p = parent.get(e.id);
    if (!p) return { x: round(a.x), y: round(a.y) };
    const o = absOf(p);
    return { x: round(a.x - o.x - GROUP_PAD), y: round(a.y - o.y - top(p)) };
  };
  const byZ = (a: Box, b: Box) => a.z - b.z;
  const children = (f: F | null): DocNode[] => [
    ...fs.filter((g) => (parent.get(g.id) ?? null) === f).sort(byZ).map((g): DocGroup => {
      const { id, ...rest } = groups.get(g.id)!;
      return { id, kind: "group", ...rest, children: children(g), ...place(g) };
    }),
    ...items.filter((e) => (parent.get(e.id) ?? null) === f).sort(byZ).map((e) => ({ ...note(e), ...place(e) })),
  ];
  return children(null);
}
