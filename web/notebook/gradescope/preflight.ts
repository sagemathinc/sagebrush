// "PDF for Gradescope": what the student dialog checks before a PDF is made, as pure functions over a notebook's
// cells and what the page knows of each (whether it ran, changed since, ended in an error, shows something
// interactive), so they are tested without a browser.  Nothing here blocks saving: each finding names its exercise
// and its cell, and the dialog offers to go there first.

import type { Cell, Section } from "./outline";
import { headingText } from "./outline";

/** What the page knows of a code cell beyond its text. */
export interface CellState { ran: boolean; edited: boolean; error: boolean; interactive: boolean }

export type FindingKind = "name" | "missing" | "unrun" | "edited" | "error" | "interactive";
export interface Finding { kind: FindingKind; text: string; exercise?: string; cell?: string }

// (a placeholder left in the template: blanks, brackets, "your name")
const PLACEHOLDER = /^(?:[\s_.\-–—]*|\[[^\]]*\]|<[^>]*>|\(?\s*your\s+name.*|name)$/i;
const clean = (s: string) => s.replace(/[*_`]+/g, " ").replace(/\s+/g, " ").trim();

function field(text: string, label: RegExp): string {
  for (const line of text.split("\n")) {
    const m = label.exec(headingText(line) || line);
    if (!m) continue;
    const v = clean(m[1] ?? "");
    return PLACEHOLDER.test(v) ? "" : v.slice(0, 120);
  }
  return "";
}

/**
 * The name and collaborators a student wrote in the notebook's front matter (the Markdown before the first exercise):
 * a "Name:" line and an "I collaborated with:" (or "Collaborators:") line; "" for a line still holding the template's
 * placeholder, or none.
 */
export function studentInfo(cells: Cell[], firstExerciseCell?: string): { name: string; collaborators: string } {
  const end = firstExerciseCell ? cells.findIndex((c) => c.id === firstExerciseCell) : -1;
  const front = (end >= 0 ? cells.slice(0, end) : cells).filter((c) => c.type === "markdown").map((c) => c.code).join("\n");
  return {
    name: field(front, /^[\s>*_-]*(?:your\s+)?(?:full\s+)?name\s*[:：]\s*(.*)$/i),
    collaborators: field(front, /^[\s>*_-]*(?:i\s+)?collaborat\w*(?:\s+with)?\s*[:：]\s*(.*)$/i),
  };
}

// (code that does nothing when run: blank, or comments only)
const idle = (code: string) => code.split("\n").every((l) => /^\s*(?:(?:#|%|\/\/).*)?$/.test(l));

/** What a student should look at before saving, in notebook order: each with the exercise and the cell it is in. */
export function findings(secs: Section[], missing: { title: string }[], state: (id: string) => CellState | undefined, name: string): Finding[] {
  const out: Finding[] = [];
  if (!name.trim()) out.push({ kind: "name", text: "Your name isn't filled in: Gradescope reads it from page 1." });
  for (const m of missing) out.push({ kind: "missing", exercise: m.title, text: `${m.title}'s heading isn't in this notebook any more: its pages will be blank.` });
  for (const s of secs) {
    const title = s.exercise.title;
    const counts = { unrun: [] as string[], edited: [] as string[], error: [] as string[], interactive: [] as string[] };
    for (const c of s.cells) {
      // (a code cell has no type in a snapshot)
      if ((c.type ?? "code") !== "code" || idle(c.code)) continue;
      const st = state(c.id);
      if (!st) continue;
      if (!st.ran) counts.unrun.push(c.id);
      else if (st.edited) counts.edited.push(c.id);
      if (st.error) counts.error.push(c.id);
      if (st.interactive) counts.interactive.push(c.id);
    }
    const n = (ids: string[], one: string, many: string) => (ids.length === 1 ? one : many.replace("#", String(ids.length)));
    if (counts.unrun.length) out.push({ kind: "unrun", exercise: title, cell: counts.unrun[0], text: `${title}: ${n(counts.unrun, "a code cell hasn't run, so it has no output", "# code cells haven't run, so they have no output")}.` });
    if (counts.edited.length) out.push({ kind: "edited", exercise: title, cell: counts.edited[0], text: `${title}: ${n(counts.edited, "a cell changed since it ran: its output may not match its code", "# cells changed since they ran: their output may not match their code")}.` });
    if (counts.error.length) out.push({ kind: "error", exercise: title, cell: counts.error[0], text: `${title}: ${n(counts.error, "a cell shows an error", "# cells show errors")}.` });
    if (counts.interactive.length) out.push({ kind: "interactive", exercise: title, cell: counts.interactive[0], text: `${title}: ${n(counts.interactive, "an interactive output is printed as it shows now", "# interactive outputs are printed as they show now")}.` });
  }
  return out;
}
