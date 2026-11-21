// A Delegate proposal merged into the person's version as it is now (Pair and Delegate plan r1, UI-1): three-way,
// base (the task's snapshot), mine (the person's version now) and theirs (the agent's proposal), and every place both
// changed differently is a conflict the person picks, never settled here. Pure: no page, no store.
//
// A notebook, by cell id (the three descend from one snapshot, so a cell keeps its id on every side):
//   - a cell's content is its type, code, attachments and metadata; its outputs, count and time follow its code and
//     never make a change of their own;
//   - changed on one side: that side's; changed alike on both: once; changed differently on both: a conflict;
//   - removed on one side and unchanged on the other: removed; removed on one side and changed on the other: a
//     conflict (the cell kept or removed, as picked);
//   - added on one side: kept, after the nearest cell before it on its own side that the merge has (else first);
//     added with one id on both, alike: once, else a conflict;
//   - the order is the person's; the agent's moves of existing cells are not applied;
//   - the notebook's other fields (its mode and the rest), key by key, by the same rule; a clash is a conflict.
// Outputs: a cell taken from a side takes that side's outputs, count and time; a cell unchanged on both takes the
// person's, unless only the agent's has outputs (it ran the cell, the person didn't); one changed alike on both takes
// the person's.
//
// A text file, by lines (diff3): each side's changes against the base (review/line-diff.ts, under its bounds), and
// changes that overlap or touch on both sides are one conflict, unless both made the same change. A diff past its
// bounds makes the whole file one conflict.
import { reviewLineDiff, splitLines } from "./line-diff";

export type Cell = { id: string; type?: string; code?: string; outputs?: unknown[]; [k: string]: unknown };
export type Notebook = { cells: Cell[]; [k: string]: unknown };
export type Pick = "mine" | "theirs";
export type CellConflict = { id: string; kind: "cell"; cell: string; mine: Cell | null; theirs: Cell | null };
export type FieldConflict = { id: string; kind: "field"; key: string; mine: unknown; theirs: unknown };
export type NotebookMerge = {
  /** The merged notebook with every conflict still open: each conflict's cell at its place, as `mine` has it (left
   * out where mine has none), each conflicting field as mine. resolveNotebook gives the final one. */
  merged: Notebook;
  conflicts: (CellConflict | FieldConflict)[];
  /** Theirs' cells in the order they'd take, for a conflict that takes theirs where mine has no cell. */
  order: string[];
};

const OUT_KEYS = new Set(["outputs", "n", "ms", "exec_count", "execution_count"]);
/** A cell's content, as text, for comparing: everything but its outputs, count and time, keys sorted. */
function content(c: Cell | undefined): string | null {
  if (!c) return null;
  const k = Object.keys(c).filter((x) => !OUT_KEYS.has(x)).sort();
  return JSON.stringify(k.map((x) => [x, x === "type" ? c.type ?? "code" : c[x]]));
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const byId = (cells: Cell[]) => new Map(cells.map((c) => [String(c.id), c]));

export function mergeNotebooks(base: Notebook, mine: Notebook, theirs: Notebook): NotebookMerge {
  const B = byId(base.cells ?? []), M = byId(mine.cells ?? []), T = byId(theirs.cells ?? []);
  const conflicts: (CellConflict | FieldConflict)[] = [];
  // (what each cell id becomes: a cell, removed (null), or a conflict)
  const take = new Map<string, Cell | null>();
  const conflictOf = new Map<string, CellConflict>();
  const ids = new Set([...B.keys(), ...M.keys(), ...T.keys()]);
  for (const id of ids) {
    const b = B.get(id), m = M.get(id), t = T.get(id);
    const cb = content(b), cm = content(m), ct = content(t);
    const mineChanged = cm !== cb, theirsChanged = ct !== cb;
    // (unchanged on both: the person's, outputs and all, unless only theirs has outputs (the agent ran it, the
    //  person didn't); changed by theirs alone: theirs')
    const ran = (c: Cell | undefined) => Array.isArray(c?.outputs) && c!.outputs!.length > 0;
    if (!mineChanged && !theirsChanged) take.set(id, (!ran(m) && ran(t) ? t : m) ?? null);
    else if (!mineChanged) take.set(id, t ?? null);
    else if (!theirsChanged) take.set(id, m ?? null);
    else if (cm === ct) take.set(id, m ?? null);
    else {
      const c: CellConflict = { id: `cell:${id}`, kind: "cell", cell: id, mine: m ?? null, theirs: t ?? null };
      conflicts.push(c);
      conflictOf.set(id, c);
      take.set(id, m ?? null);
    }
  }
  // (the order: the person's; then each cell only theirs has (added by them, or kept by a conflict), after its
  // nearest earlier cell on theirs' side that is placed, else first)
  const order: string[] = (mine.cells ?? []).map((c) => String(c.id));
  const placed = new Set(order);
  let prev: string | null = null;
  for (const c of theirs.cells ?? []) {
    const id = String(c.id);
    if (!placed.has(id) && (take.get(id) || conflictOf.has(id))) {
      const at = prev === null ? 0 : order.indexOf(prev) + 1;
      order.splice(at, 0, id);
      placed.add(id);
    }
    if (placed.has(id)) prev = id;
  }
  const cells = order.map((id) => take.get(id)).filter((c): c is Cell => !!c);
  // (the notebook's other fields, key by key)
  const merged: Notebook = { cells } as Notebook;
  const keys = new Set([...Object.keys(base), ...Object.keys(mine), ...Object.keys(theirs)].filter((k) => k !== "cells"));
  for (const k of [...keys].sort()) {
    const b = base[k], m = mine[k], t = theirs[k];
    let v: unknown;
    if (same(m, b)) v = t;
    else if (same(t, b) || same(m, t)) v = m;
    else { conflicts.push({ id: `field:${k}`, kind: "field", key: k, mine: m, theirs: t }); v = m; }
    if (v !== undefined) merged[k] = v;
  }
  return { merged, conflicts, order };
}

/** The final notebook: each conflict as picked (every conflict must have a pick). */
export function resolveNotebook(r: NotebookMerge, picks: Record<string, Pick>): Notebook {
  const missing = r.conflicts.filter((c) => picks[c.id] !== "mine" && picks[c.id] !== "theirs").map((c) => c.id);
  if (missing.length) throw new Error(`not picked: ${missing.join(", ")}`);
  const cellPick = new Map<string, Cell | null>();
  for (const c of r.conflicts) if (c.kind === "cell") cellPick.set(c.cell, picks[c.id] === "mine" ? c.mine : c.theirs);
  const now = new Map(r.merged.cells.map((c) => [String(c.id), c]));
  const cells: Cell[] = [];
  for (const id of r.order) {
    const c = cellPick.has(id) ? cellPick.get(id) : now.get(id);
    if (c) cells.push(c);
  }
  const out: Notebook = { ...r.merged, cells };
  for (const c of r.conflicts) {
    if (c.kind !== "field") continue;
    const v = picks[c.id] === "mine" ? c.mine : c.theirs;
    if (v === undefined) delete out[c.key];
    else out[c.key] = v;
  }
  return out;
}

export type TextPart = { kind: "same"; text: string } | { kind: "conflict"; id: string; base: string; mine: string; theirs: string };
export type TextMerge = { parts: TextPart[]; conflicts: number };

type Hunk = { a0: number; a1: number; lines: string[] };
function hunks(base: string, side: string): Hunk[] | null {
  const d = reviewLineDiff(base, side);
  if (!d.ok) return null;
  const out: Hunk[] = [];
  let cur: Hunk | null = null;
  for (const s of d.segs) {
    if (s.t === "=") { if (cur) out.push(cur); cur = null; continue; }
    cur ??= { a0: s.a, a1: s.a, lines: [] };
    if (s.t === "-") cur.a1 = s.a + s.n;
    else cur.lines.push(...d.b.slice(s.b, s.b + s.n));
  }
  if (cur) out.push(cur);
  return out;
}

/** Three-way merge of a text file by lines. */
export function mergeText(base: string, mine: string, theirs: string): TextMerge {
  if (mine === theirs || theirs === base) return { parts: [{ kind: "same", text: mine }], conflicts: 0 };
  if (mine === base) return { parts: [{ kind: "same", text: theirs }], conflicts: 0 };
  const hm = hunks(base, mine), ht = hunks(base, theirs);
  if (!hm || !ht) return { parts: [{ kind: "conflict", id: "text:0", base, mine, theirs }], conflicts: 1 };
  const B = splitLines(base);
  const all = [...hm.map((h) => ({ ...h, side: 0 })), ...ht.map((h) => ({ ...h, side: 1 }))].sort((x, y) => x.a0 - y.a0 || x.a1 - y.a1);
  const parts: TextPart[] = [];
  const keep = (text: string) => { if (!text) return; const p = parts.at(-1); if (p?.kind === "same") p.text += text; else parts.push({ kind: "same", text }); };
  let at = 0, n = 0;
  for (let i = 0; i < all.length; ) {
    // (a group: hunks that overlap or touch, on either side)
    let a0 = all[i].a0, a1 = all[i].a1;
    const group = [all[i++]];
    while (i < all.length && all[i].a0 <= a1) { a1 = Math.max(a1, all[i].a1); group.push(all[i++]); }
    keep(B.slice(at, a0).join(""));
    // (each side's text for the group's base range: its own hunks, base lines between them)
    const sideText = (side: number) => {
      let s = "", p = a0;
      for (const h of group.filter((g) => g.side === side)) { s += B.slice(p, h.a0).join("") + h.lines.join(""); p = h.a1; }
      return s + B.slice(p, a1).join("");
    };
    const sides = new Set(group.map((g) => g.side));
    if (sides.size === 1) keep(sideText(group[0].side));
    else {
      const m = sideText(0), t = sideText(1);
      if (m === t) keep(m);
      else parts.push({ kind: "conflict", id: `text:${n++}`, base: B.slice(a0, a1).join(""), mine: m, theirs: t });
    }
    at = a1;
  }
  keep(B.slice(at).join(""));
  return { parts, conflicts: n };
}

/** The final text: each conflict as picked. */
export function resolveText(r: TextMerge, picks: Record<string, Pick>): string {
  return r.parts.map((p) => {
    if (p.kind === "same") return p.text;
    const k = picks[p.id];
    if (k !== "mine" && k !== "theirs") throw new Error(`not picked: ${p.id}`);
    return k === "mine" ? p.mine : p.theirs;
  }).join("");
}
