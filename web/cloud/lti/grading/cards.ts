// Answer cards (grading G1 r5 §3.3): a pure function from (value, spec, outputs) to one card
// per question, in the spec's card order, with §2.3's allocation. Computed in the instructor's
// page (or the rebuild Worker, §5.7), never stored.
//
// `outputs` holds the output references already checked against the collection's verified
// descriptor (A1 r3); this module neither fetches nor verifies, and runs nothing.

import { allocate, type CardFlag, type CellFlag, type ValueCell } from "./allocate.ts";
import type { ValidSpec } from "./spec.ts";

export interface OutputRef {
  state: string;
  full?: string; // the blob reference of the full output
  preview?: string; // a preview's reference, when the full output is over the inline cap
}

export interface CardCell {
  id: string;
  cell_type: string;
  input: string;
  output?: OutputRef;
  role: "prompt" | "answer" | "new";
  flags: CellFlag[];
}

export interface Card {
  question: string;
  title: string;
  kind: string;
  points_c: number;
  prompt?: CardCell;
  cells: CardCell[];
  flags: CardFlag[];
}

export interface Cards {
  cards: Card[];
  before_first: CardCell[];
  excluded: string[];
}

export function buildCards(
  value: readonly ValueCell[],
  spec: ValidSpec,
  templateIds: ReadonlySet<string>,
  outputs: ReadonlyMap<string, OutputRef> = new Map(),
): Cards {
  const byId = new Map(value.map((c) => [c.id, c]));
  const cell = (id: string, role: CardCell["role"], flags: CellFlag[]): CardCell => {
    const c = byId.get(id)!;
    const out: CardCell = {
      id,
      cell_type: typeof c.cell_type === "string" ? c.cell_type : "code",
      input: typeof c.input === "string" ? c.input : "",
      role,
      flags,
    };
    const o = outputs.get(id);
    // (Markdown and raw cells are shown as source only: no outputs)
    if (o && out.cell_type === "code") out.output = { ...o };
    return out;
  };
  const a = allocate(value, spec, templateIds);
  const titles = new Map(spec.questions.map((q) => [q.id, q]));
  return {
    cards: a.cards.map((k) => {
      const q = titles.get(k.question)!;
      const card: Card = {
        question: q.id,
        title: q.title,
        kind: q.kind,
        points_c: q.points_c,
        cells: k.cells.map((p) => cell(p.id, p.role, p.flags)),
        flags: k.flags,
      };
      if (k.prompt) card.prompt = cell(k.prompt.id, "prompt", k.prompt.flags);
      return card;
    }),
    before_first: a.before_first.map((p) => cell(p.id, "new", p.flags)),
    excluded: a.excluded,
  };
}

// RFC 8785 (JCS) for the JSON this module produces: object keys sorted by UTF-16 code units,
// numbers in ES6 form (JSON.stringify's), no whitespace. Non-finite numbers are refused.
export function jcs(v: unknown): string {
  if (v === null || typeof v === "boolean") return JSON.stringify(v);
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error("JCS: non-finite number");
    return JSON.stringify(v);
  }
  if (typeof v === "string") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(jcs).join(",") + "]";
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return "{" + keys.map((k) => JSON.stringify(k) + ":" + jcs(o[k])).join(",") + "}";
  }
  throw new Error(`JCS: unsupported value of type ${typeof v}`);
}
