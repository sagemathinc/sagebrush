// A board's questions (`kind: "ask"`, doc.ts DocAsk) and their answers:
// what an answer may be, the problems of a question as written, and the
// questions of a document page by page.  One set of rules for every place
// that takes an answer: `sagebrush board check` and `board answers`
// (src/board-answers.ts), the board's controls, and a host checking a
// submission (web/board-host-protocol.md).

import { askOptions, pageCount, pageOf, type AskAnswer, type BoardDoc, type DocAsk, type DocNode } from "./doc";

/** The bounds of answers and submissions (web/board-host-protocol.md). */
export const ASK_LIMITS = { text: 10_000, comment: 10_000, options: 100, asks: 200, bytes: 65_536 } as const;
/** A scale's values, at most (from its `min` to its `max`). */
export const SCALE_MAX = 100;

/** A scale's first and last values. */
export const scaleRange = (a: DocAsk): [number, number] => [a.min ?? 1, a.max ?? 5];

// (a value in a message: short, quoted)
const show = (v: unknown) => { const s = JSON.stringify(typeof v === "string" && v.length > 40 ? v.slice(0, 37) + "..." : v); return s === undefined ? String(v) : s; };

/** Whether v is from + k * step for a whole k: the nearest such value
 * within a few units in the last place of the larger of the two (a step of
 * 0.1 is not exact in binary), never a fraction of a step however many
 * steps from `from` (CORR-738-1); not when the steps can't be counted. */
export function onStep(v: number, from: number, step: number): boolean {
  const k = Math.round((v - from) / step), near = from + k * step;
  if (!Number.isFinite(k) || !Number.isFinite(near)) return false;
  return Math.abs(v - near) <= 8 * Number.EPSILON * Math.max(Math.abs(v), Math.abs(near), Number.MIN_VALUE);
}

/** Why `ans` is not an answer the question takes, or null if it is one. */
export function answerProblem(a: DocAsk, ans: unknown): string | null {
  const opts = askOptions(a), values = new Set(opts.map((o) => o.value));
  const among = (v: unknown) => (typeof v === "string" && values.has(v) ? null : `${show(v)} is not one of its options' values (${opts.slice(0, 5).map((o) => show(o.value)).join(", ")}${opts.length > 5 ? ", ..." : ""})`);
  switch (a.input) {
    case "check": {
      if (!opts.length) return typeof ans === "boolean" ? null : "a yes/no box's answer is true or false";
      if (!Array.isArray(ans)) return "its answer is a list of its options' values (a check question takes any of them)";
      if (ans.length > ASK_LIMITS.options) return `its answer lists more than ${ASK_LIMITS.options} values`;
      const seen = new Set<unknown>();
      for (const v of ans) {
        const why = among(v);
        if (why) return why;
        if (seen.has(v)) return `${show(v)} is in its answer twice`;
        seen.add(v);
      }
      return null;
    }
    case "radio":
    case "choice":
      if (typeof ans !== "string") return "its answer is one of its options' values (a string)";
      return among(ans);
    case "text":
      if (typeof ans !== "string") return "its answer is a string";
      return ans.length > ASK_LIMITS.text ? `its answer is longer than ${ASK_LIMITS.text} characters` : null;
    case "number":
      if (typeof ans !== "number" || !Number.isFinite(ans)) return "its answer is a finite number";
      if (a.min !== undefined && ans < a.min) return `its answer ${ans} is less than its min, ${a.min}`;
      if (a.max !== undefined && ans > a.max) return `its answer ${ans} is more than its max, ${a.max}`;
      if (a.step !== undefined && a.step > 0 && !onStep(ans, a.min ?? 0, a.step)) return `its answer ${ans} is not on its step, ${a.step}${a.min !== undefined ? ` from ${a.min}` : ""}`;
      return null;
    case "scale": {
      const [lo, hi] = scaleRange(a);
      if (typeof ans !== "number" || !Number.isInteger(ans)) return "its answer is a whole number";
      return ans < lo || ans > hi ? `its answer ${ans} is not from ${lo} to ${hi}` : null;
    }
  }
}

/** Whether a question has an answer (a check question's empty list is one: none chosen). */
export const answered = (a: DocAsk) => a.answer !== undefined;

export interface AskProblem {
  level: "error" | "warning";
  /** the field: "" for the question as a whole */
  field: string;
  message: string;
}

/** The problems of a question as written (its answer's too), past what
 * the format's schema says. */
export function askProblems(a: DocAsk): AskProblem[] {
  const out: AskProblem[] = [];
  const err = (field: string, message: string) => out.push({ level: "error", field, message });
  const warn = (field: string, message: string) => out.push({ level: "warning", field, message });
  const choosing = a.input === "check" || a.input === "radio" || a.input === "choice";
  const opts = askOptions(a);
  if (!a.text && !a.title) err("", "a question with no `text` (nor `title`): the reader sees nothing to answer");
  if (choosing) {
    if ((a.input === "radio" || a.input === "choice") && !opts.length) err("options", `a ${a.input} question needs \`options\`: the values the reader chooses one of`);
    if (opts.length > ASK_LIMITS.options) err("options", `more than ${ASK_LIMITS.options} options`);
    const seen = new Set<string>();
    for (const o of opts) {
      if (seen.has(o.value)) err("options", `the value ${show(o.value)} is in its options twice: an answer names one option`);
      seen.add(o.value);
    }
    if (a.input === "radio" && opts.length > 12) warn("input", `${opts.length} options: \`choice\` shows them as a list to choose from, which fits many`);
  } else if (a.options !== undefined) warn("options", `\`options\` are for check, radio and choice questions: a ${a.input} question leaves them aside`);
  if (a.input === "number") {
    if (a.min !== undefined && a.max !== undefined && a.min > a.max) err("min", `its min (${a.min}) is more than its max (${a.max})`);
    if (a.step !== undefined && !(a.step > 0)) err("step", "its step is more than 0");
  } else if (a.step !== undefined) warn("step", `\`step\` is for a number question: a ${a.input} question leaves it aside`);
  if (a.input === "scale") {
    const [lo, hi] = scaleRange(a);
    if (!Number.isInteger(lo) || !Number.isInteger(hi)) err(Number.isInteger(lo) ? "max" : "min", "a scale's min and max are whole numbers");
    else if (lo >= hi) err("min", `its min (${lo}) is not less than its max (${hi})`);
    else if (hi - lo + 1 > SCALE_MAX) err("max", `a scale of more than ${SCALE_MAX} values (from ${lo} to ${hi}): a number question takes a range`);
  } else {
    if (a.input !== "number" && (a.min !== undefined || a.max !== undefined)) warn(a.min !== undefined ? "min" : "max", `\`min\` and \`max\` are for number and scale questions: a ${a.input} question leaves them aside`);
    if (a.low !== undefined || a.high !== undefined) warn(a.low !== undefined ? "low" : "high", `\`low\` and \`high\` are for a scale question: a ${a.input} question leaves them aside`);
  }
  if (a.lines !== undefined) {
    if (a.input !== "text") warn("lines", `\`lines\` is for a text question: a ${a.input} question leaves it aside`);
    else if (!Number.isInteger(a.lines) || a.lines < 1 || a.lines > 50) err("lines", "a text field's lines are a whole number from 1 to 50");
  }
  if (a.answer !== undefined) { const why = answerProblem(a, a.answer); if (why) err("answer", why); }
  return out;
}

export interface PageAsk {
  /** its page, from 1 */
  page: number;
  /** its page's id and title, if it has them */
  pageId?: string;
  pageTitle?: string;
  ask: DocAsk;
}

/** The questions of a document (as cleanDoc leaves it), page by page, in
 * the order written, those in groups too. */
export function asksOf(d: BoardDoc): PageAsk[] {
  const out: PageAsk[] = [];
  for (let i = 0; i < pageCount(d); i++) {
    const p = pageOf(d, i), many = !!d.pages?.length;
    const walk = (ns: DocNode[] | undefined) => {
      for (const n of ns ?? []) {
        if (n.kind === "group") walk(n.children);
        else if (n.kind === "ask") out.push({ page: i + 1, ...(many && p.id ? { pageId: p.id } : {}), ...(many && p.title ? { pageTitle: p.title } : {}), ask: n });
      }
    };
    walk(p.nodes);
  }
  return out;
}

/** An answer as a reader reads it: an option's label for its value; quoted text. */
export function answerText(a: DocAsk, ans: AskAnswer | undefined = a.answer): string {
  if (ans === undefined) return "(not answered)";
  const opts = askOptions(a), label = (v: string) => { const o = opts.find((x) => x.value === v); return o && o.label !== o.value ? `${JSON.stringify(v)} (${o.label})` : JSON.stringify(v); };
  if (Array.isArray(ans)) return ans.length ? ans.map(label).join(", ") : "(none chosen)";
  if (typeof ans === "boolean") return ans ? "yes" : "no";
  if (typeof ans === "number") return String(ans);
  return a.input === "radio" || a.input === "choice" ? label(ans) : JSON.stringify(ans);
}
