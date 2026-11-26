// "PDF for Gradescope": which cells make up each exercise of a notebook, and the outline the instructor saves in the
// handout (`metadata.sagebrush.gradescope`), so that every student's PDF has the same pages as the template.
//
// An outline names each exercise's first cell and its page budget.  Without one, exercises are detected from
// headings: a markdown cell whose first visible words are "Exercise 5.", "Question 2:", "Problem 3)" or "Part 1."
// (emphasis, HTML and heading marks ignored).  An exercise runs from its first cell to the cell before the next one;
// the cells before the first exercise (the instructions) are not part of the PDF.

export type Paper = "letter" | "a4";
export interface Exercise { id: string; title: string; cell: string; pages: number }
export interface Outline { v: 1; paper: Paper; exercises: Exercise[] }
/** A notebook cell as the page's snapshot has it. */
export interface Cell { id: string; type?: string; code: string; outputs?: unknown[]; n?: string | null; metadata?: Record<string, unknown> }
export interface Section { exercise: Exercise; cells: Cell[] }

export const LIMITS = { exercises: 200, pages: 20, title: 120 };
const HEADING = /^(exercise|question|problem|part)\s+(\d{1,3}[a-z]?)\s*[.:)]/i;

/** The first visible words of a markdown cell: HTML tags, heading marks, emphasis and entities removed. */
export function headingText(md: string): string {
  for (const raw of md.split("\n")) {
    const line = raw
      .replace(/<[^>]*>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/&[a-z]+;/gi, "")
      .replace(/^\s*(#{1,6}|>)\s*/, "")
      .replace(/[*_`~]/g, "")
      .trim();
    if (line) return line;
  }
  return "";
}

/** The exercise a markdown cell starts, if its first visible words say so. */
export function headingOf(md: string): { kind: string; num: string } | null {
  const m = HEADING.exec(headingText(md));
  return m ? { kind: m[1][0].toUpperCase() + m[1].slice(1).toLowerCase(), num: m[2].toLowerCase() } : null;
}

/** Exercises found from headings, each with one page; ids unique ("exercise-5", then "exercise-5-2" if repeated). */
export function detect(cells: Cell[]): Exercise[] {
  const out: Exercise[] = [], seen = new Set<string>();
  for (const c of cells) {
    if (c.type !== "markdown") continue;
    const h = headingOf(c.code);
    if (!h) continue;
    let id = `${h.kind.toLowerCase()}-${h.num}`;
    for (let k = 2; seen.has(id); k++) id = `${h.kind.toLowerCase()}-${h.num}-${k}`;
    seen.add(id);
    out.push({ id, title: `${h.kind} ${h.num}`, cell: c.id, pages: 1 });
    if (out.length >= LIMITS.exercises) break;
  }
  return out;
}

/** The outline in a notebook's metadata, checked strictly; null if there is none; a reason if it's malformed. */
export function readOutline(metadata: unknown): Outline | null | { error: string } {
  const g = (metadata as { sagebrush?: { gradescope?: unknown } } | undefined)?.sagebrush?.gradescope;
  if (g === undefined) return null;
  const bad = (why: string) => ({ error: `the notebook's Gradescope outline ${why}` });
  if (!g || typeof g !== "object" || Array.isArray(g)) return bad("isn't an object");
  const o = g as Record<string, unknown>;
  if (Object.keys(o).some((k) => !["v", "paper", "exercises"].includes(k))) return bad("has an unknown field");
  if (o.v !== 1) return bad("has an unknown version");
  if (o.paper !== "letter" && o.paper !== "a4") return bad("names an unknown paper size");
  if (!Array.isArray(o.exercises) || o.exercises.length === 0 || o.exercises.length > LIMITS.exercises) return bad("has no exercises, or too many");
  const ids = new Set<string>(), cellIds = new Set<string>();
  for (const e of o.exercises as unknown[]) {
    if (!e || typeof e !== "object" || Array.isArray(e)) return bad("has an exercise that isn't an object");
    const x = e as Record<string, unknown>;
    if (Object.keys(x).some((k) => !["id", "title", "cell", "pages"].includes(k))) return bad("has an exercise with an unknown field");
    if (typeof x.id !== "string" || !/^[a-z0-9-]{1,40}$/.test(x.id) || ids.has(x.id)) return bad("has a missing or repeated exercise id");
    if (typeof x.title !== "string" || !x.title.trim() || x.title.length > LIMITS.title) return bad(`has a bad title for ${x.id}`);
    if (typeof x.cell !== "string" || !x.cell || cellIds.has(x.cell)) return bad(`has a missing or repeated first cell for ${x.id}`);
    if (!Number.isInteger(x.pages) || (x.pages as number) < 1 || (x.pages as number) > LIMITS.pages) return bad(`has a page budget for ${x.id} outside 1–${LIMITS.pages}`);
    ids.add(x.id);
    cellIds.add(x.cell);
  }
  return { v: 1, paper: o.paper, exercises: (o.exercises as Exercise[]).map((e) => ({ id: e.id, title: e.title, cell: e.cell, pages: e.pages })) };
}

/** `metadata` with `outline` stored (or removed, for null), leaving everything else as it was. */
export function withOutline(metadata: Record<string, unknown> | undefined, outline: Outline | null): Record<string, unknown> {
  const md = { ...(metadata ?? {}) };
  const sb = { ...((md.sagebrush as Record<string, unknown> | undefined) ?? {}) };
  if (outline) sb.gradescope = outline;
  else delete sb.gradescope;
  md.sagebrush = sb;
  return md;
}

/**
 * The cells of each exercise, in the notebook's order.  An exercise whose first cell isn't in the notebook any more is
 * reported, not dropped, so the PDF never silently loses a question; exercises keep the outline's order.
 */
export function sections(cells: Cell[], exercises: Exercise[]): { sections: Section[]; missing: Exercise[] } {
  const at = new Map(cells.map((c, i) => [c.id, i]));
  const starts = exercises.filter((e) => at.has(e.cell)).map((e) => ({ e, i: at.get(e.cell)! })).sort((a, b) => a.i - b.i);
  const range = new Map<string, Cell[]>();
  starts.forEach((s, k) => range.set(s.e.id, cells.slice(s.i, k + 1 < starts.length ? starts[k + 1].i : cells.length)));
  const missing = exercises.filter((e) => !at.has(e.cell));
  return { sections: exercises.filter((e) => range.has(e.id)).map((e) => ({ exercise: e, cells: range.get(e.id)! })), missing };
}

/** The outline to use: the notebook's own, else one detected now (Letter, one page each); null when there are none. */
export function outlineFor(doc: { cells: Cell[]; metadata?: unknown }): { outline: Outline | null; source: "saved" | "detected" | "none"; error?: string } {
  const saved = readOutline(doc.metadata);
  if (saved && !("error" in saved)) return { outline: saved, source: "saved" };
  const found = detect(doc.cells);
  const error = saved && "error" in saved ? saved.error : undefined;
  if (!found.length) return { outline: null, source: "none", ...(error ? { error } : {}) };
  return { outline: { v: 1, paper: "letter", exercises: found }, source: "detected", ...(error ? { error } : {}) };
}

/**
 * A short name for an outline's layout (its paper, and each exercise's first cell and pages), shown on every PDF's
 * cover, so a PDF made from a copy with an older outline is told apart from the template's: FNV-1a, 6 hex digits.
 */
export function outlineHash(o: Outline): string {
  const text = JSON.stringify([o.v, o.paper, o.exercises.map((e) => [e.id, e.cell, e.pages])]);
  let x = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) x = Math.imul(x ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return x.toString(16).padStart(8, "0").slice(0, 6);
}
