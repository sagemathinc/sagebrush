// Allocating a student's cells to questions (grading G1 r5 §2.3). Total, pure and
// deterministic: every cell of the value gets exactly one place, as a question's prompt, one
// card's answer cell, "before the first question", or "excluded (template, not in the spec)".
//
// Question tags are never read from the student's document: the owned cells come only from
// the spec of the exact bundle the collection was made against.

import { cmpId, type ValidSpec } from "./spec.ts";

export interface ValueCell {
  id: string;
  pos?: unknown;
  cell_type?: string;
  input?: string;
  [k: string]: unknown;
}

export type CellFlag = "moved" | "position invalid";
export type CardFlag = "prompt missing" | "answer missing" | "reordered";

export interface PlacedCell {
  id: string;
  role: "answer" | "new";
  flags: CellFlag[];
}

export interface AllocatedCard {
  question: string;
  prompt: { id: string; flags: CellFlag[] } | null;
  cells: PlacedCell[]; // in submitted order
  flags: CardFlag[];
}

export interface Allocation {
  cards: AllocatedCard[]; // in the spec's card order
  before_first: { id: string; flags: CellFlag[] }[];
  excluded: string[]; // template cells named by no question
}

export class AllocationError extends Error {}

const validPos = (p: unknown): p is number => typeof p === "number" && Number.isFinite(p);

// Step 0: the submitted order, by (pos, id); cells whose pos isn't a finite number go after
// every valid one, by id.
export function submittedOrder<T extends ValueCell>(cells: readonly T[]): T[] {
  return [...cells].sort((a, b) => {
    const va = validPos(a.pos);
    const vb = validPos(b.pos);
    if (va && vb) return (a.pos as number) - (b.pos as number) || cmpId(a.id, b.id);
    if (va !== vb) return va ? -1 : 1;
    return cmpId(a.id, b.id);
  });
}

export function allocate(cells: readonly ValueCell[], spec: ValidSpec, templateIds: ReadonlySet<string>): Allocation {
  const seen = new Set<string>();
  for (const c of cells) {
    if (typeof c.id !== "string") throw new AllocationError("a cell has no id");
    if (seen.has(c.id)) throw new AllocationError(`cell id "${c.id}" appears twice in the value`);
    seen.add(c.id);
  }

  // Step 1: classification maps (the spec's validation makes them disjoint and single-valued).
  const anchorOf = new Map<string, string>();
  const answerOf = new Map<string, string>();
  for (const q of spec.questions) {
    anchorOf.set(q.anchor, q.id);
    for (const a of q.answers) answerOf.set(a, q.id);
  }

  const cards = new Map<string, AllocatedCard>();
  for (const q of spec.questions) cards.set(q.id, { question: q.id, prompt: null, cells: [], flags: [] });
  const before_first: Allocation["before_first"] = [];
  const excluded: string[] = [];

  // Steps 2–3: walk the submitted order; the present anchors are the only boundaries.
  const anchorIndex = new Map<string, number>(); // question -> submitted index of its anchor
  let current: string | null = null; // the question of the nearest preceding present anchor
  const order = submittedOrder(cells);
  order.forEach((c, i) => {
    const flags: CellFlag[] = validPos(c.pos) ? [] : ["position invalid"];
    const prompted = anchorOf.get(c.id);
    if (prompted !== undefined) {
      cards.get(prompted)!.prompt = { id: c.id, flags };
      anchorIndex.set(prompted, i);
      current = prompted;
      return;
    }
    const owned = answerOf.get(c.id);
    if (owned !== undefined) {
      if (current !== owned) flags.unshift("moved");
      cards.get(owned)!.cells.push({ id: c.id, role: "answer", flags });
      return;
    }
    if (templateIds.has(c.id)) {
      excluded.push(c.id);
      return;
    }
    if (current === null) before_first.push({ id: c.id, flags });
    else cards.get(current)!.cells.push({ id: c.id, role: "new", flags });
  });

  // Step 4: card flags.
  const templateIndex = new Map(spec.questions.map((q, k) => [q.id, k]));
  for (const q of spec.questions) {
    const card = cards.get(q.id)!;
    if (card.prompt === null) card.flags.push("prompt missing");
    if (card.prompt === null && card.cells.length === 0) card.flags.push("answer missing");
    const mine = anchorIndex.get(q.id);
    if (mine !== undefined) {
      const k = templateIndex.get(q.id)!;
      const reordered = spec.questions.some((p) => {
        const theirs = anchorIndex.get(p.id);
        return templateIndex.get(p.id)! < k && theirs !== undefined && mine < theirs;
      });
      if (reordered) card.flags.push("reordered");
    }
  }

  return { cards: spec.questions.map((q) => cards.get(q.id)!), before_first, excluded };
}
