// A board's questions (`kind: "ask"`, doc.ts DocAsk) and their answers:
// what an answer may be, the problems of a question as written, and the
// questions of a document page by page.  One set of rules for every place
// that takes an answer: `sagebrush board check` and `board answers`
// (src/board-answers.ts), the board's controls, and a host checking a
// submission (web/board-host-protocol.md).

import { askOptions, cleanDoc, formatError, isBoard, pageCount, pageOf, type AskAnswer, type BoardDoc, type DocAsk, type DocNode } from "./doc";

/** The bounds of answers and submissions (web/board-host-protocol.md). */
export const ASK_LIMITS = { text: 10_000, comment: 10_000, options: 100, asks: 200, bytes: 65_536 } as const;
/** A scale's values, at most (from its `min` to its `max`). */
export const SCALE_MAX = 100;

/** A scale's first and last values. */
export const scaleRange = (a: DocAsk): [number, number] => [a.min ?? 1, a.max ?? 5];

// (a value in a message: short, quoted)
const show = (v: unknown) => { const s = JSON.stringify(typeof v === "string" && v.length > 40 ? v.slice(0, 37) + "..." : v); return s === undefined ? String(v) : s; };

/** A finite number as the decimal it is written as (its shortest form,
 * String(v)): n * 10^e, exactly. */
export function decimalOf(v: number): { n: bigint; e: number } {
  const m = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]\d+))?$/.exec(String(v));
  if (!m) throw new Error(`not a finite number: ${v}`);
  const frac = m[3] ?? "";
  return { n: BigInt(m[1] + m[2] + frac), e: Number(m[4] ?? 0) - frac.length };
}

/** Why v is not from + k * step for a whole k, or null if it is
 * (CORR-738-1).  Exactly, with each number taken as the decimal it is
 * written as, as a reader means a step of 0.1: no rounding, at any size.
 * (Past 2^53 that is the shortest decimal that reads back as the number:
 * 2^60 is 1152921504606847000.) */
export function stepProblem(v: number, from: number, step: number): string | null {
  const [x, f, s] = [v, from, step].map(decimalOf), e = Math.min(x.e, f.e, s.e);
  const at = (d: { n: bigint; e: number }) => d.n * 10n ** BigInt(d.e - e);
  return (at(x) - at(f)) % at(s) === 0n ? null : `its answer ${v} is not on its step, ${step}${from ? ` from ${from}` : ""}`;
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
      if (a.step !== undefined && a.step > 0) return stepProblem(ans, a.min ?? 0, a.step);
      return null;
    case "scale": {
      const [lo, hi] = scaleRange(a);
      if (typeof ans !== "number" || !Number.isInteger(ans)) return "its answer is a whole number";
      return ans < lo || ans > hi ? `its answer ${ans} is not from ${lo} to ${hi}` : null;
    }
  }
}

/** Whether a question has an answer (a check question's empty list is one:
 * none chosen), or a note in the reader's own words that is not only spaces
 * (William's rule: any question can be answered in words). */
export const answered = (a: { answer?: unknown; note?: unknown }) => a.answer !== undefined || (typeof a.note === "string" && a.note.trim() !== "");

export interface AskProblem {
  level: "error" | "warning";
  /** the field: "" for the question as a whole */
  field: string;
  message: string;
}

/** The problems of a question as written (its answer's too), past what
 * the format's schema says. */
export function askProblems(a: DocAsk, mode: string = "python"): AskProblem[] {
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
    if (!Number.isSafeInteger(lo) || !Number.isSafeInteger(hi)) err(Number.isSafeInteger(lo) ? "max" : "min", "a scale's min and max are whole numbers, at most 2^53 - 1 from 0");
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
  if (a.note !== undefined && a.note.length > ASK_LIMITS.text) err("note", `its note is longer than ${ASK_LIMITS.text} characters`);
  // its check, hints and next (what checks an answer, and what follows)
  const computed = (a.hints ?? []).some((h) => typeof h !== "string");
  if ((a.check !== undefined || computed) && mode !== "python" && mode !== "sage") err(a.check !== undefined ? "check" : "hints", `checks and computed hints run in Python and Sage boards (for now): this board's language is ${mode}`);
  if (a.check !== undefined && !a.check.trim()) err("check", "an empty check: it is code whose last line is true (right), false (wrong) or a message (wrong, saying why)");
  (a.hints ?? []).forEach((h, k) => { if (typeof h !== "string" && !h.code.trim()) err(`hints[${k}]`, "an empty computed hint: its code's last line is the hint's text"); });
  if (a.check === undefined) {
    if (a.hints?.length) warn("hints", "hints show one by one after wrong attempts, which a `check` decides: with no check, none shows");
    if (a.next) warn("next", "`next` follows a checked answer: with no `check`, the reader is not sent on");
    if (a.checkMs !== undefined) warn("checkMs", "`checkMs` is the deadline of a `check`, and there is none");
    if (a.example !== undefined) warn("example", "`example` is an answer for trying the `check` (`sagebrush board try`), and there is none");
  }
  if (a.example !== undefined) { const why = answerProblem(a, a.example); if (why) err("example", why.replace(/^its answer/, "its example")); }
  if (a.result !== undefined && a.answer === undefined) err("result", "a verdict with no answer: the verdict is the answer's");
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

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);

/** Why a submission can't be applied to a board (as cleanDoc leaves it),
 * or null.  `m` is JSON data (parsed from text). */
export function submissionProblem(d: BoardDoc, m: any): string | null {
  if (!isObj(m) || m.sagebrush !== "answers" || m.version !== 1) return 'not a submission: a host\'s "answers" message, {"sagebrush": "answers", "version": 1, "page": {"number": N}, "answers": {...}, ...}';
  const n = m.page?.number;
  if (!Number.isInteger(n) || n < 1 || n > pageCount(d)) return `its page.number is not a page of the board (from 1 to ${pageCount(d)})`;
  if (!isObj(m.answers)) return "its answers are not an object (a question's id to its answer)";
  // (notes: a question's id to the reader's own words, which answer it too)
  const notes = m.notes ?? {};
  if (!isObj(notes)) return "its notes are not an object (a question's id to the reader's own words)";
  if (m.comment !== undefined && (typeof m.comment !== "string" || m.comment.length > ASK_LIMITS.comment)) return `its comment is not a string of at most ${ASK_LIMITS.comment} characters`;
  const keys = Object.keys(m.answers);
  if (keys.length > ASK_LIMITS.asks) return `more than ${ASK_LIMITS.asks} answers`;
  const said = Object.keys(notes);
  if (said.length > ASK_LIMITS.asks) return `more than ${ASK_LIMITS.asks} notes`;
  // (each question of the page once, and as the board can ask it: else
  // which question an answer is to, and what it may be, is not clear;
  // cleanDoc's caller has refused ids twice on a page, CORR-02C-1)
  const asks = new Map<string, DocAsk>();
  for (const { ask: a } of asksOf(d).filter((q) => q.page === n)) {
    if (asks.has(a.id)) return `two questions on page ${n} have the id ${JSON.stringify(a.id.slice(0, 60))}`;
    asks.set(a.id, a);
    const bad = askProblems(a).find((x) => x.level === "error" && x.field !== "answer");
    if (bad) return `the question ${JSON.stringify(a.id.slice(0, 60))} can't be answered as written (${bad.field || "it"}: ${bad.message}): sagebrush board check says what to fix`;
  }
  for (const k of keys) {
    const a = asks.get(k);
    if (!a) return `an answer to ${JSON.stringify(k.slice(0, 60))}, which is no question on page ${n}`;
    const why = answerProblem(a, m.answers[k]);
    if (why) return `the answer to ${JSON.stringify(k.slice(0, 60))}: ${why}`;
  }
  for (const k of said) {
    if (!asks.has(k)) return `a note to ${JSON.stringify(k.slice(0, 60))}, which is no question on page ${n}`;
    if (typeof notes[k] !== "string" || notes[k].length > ASK_LIMITS.text) return `the note to ${JSON.stringify(k.slice(0, 60))} is not a string of at most ${ASK_LIMITS.text} characters`;
  }
  // (a required question: answered, or said in words)
  // (each its own: a question named constructor or __proto__ reads nothing a plain object inherits, CORR-299-1)
  const own = (o: object, k: string) => (Object.prototype.hasOwnProperty.call(o, k) ? (o as any)[k] : undefined);
  for (const a of asks.values()) if (a.required && !answered({ answer: own(m.answers, a.id), note: own(notes, a.id) })) return `the required question ${JSON.stringify(a.id.slice(0, 60))} is not answered`;
  return null;
}

/** What a host posted on a channel: the board's text, and its name and revision (web/board-host-protocol.md). */
export interface Posted { text: string; name?: string | null; revision?: string | null }
export type Checked = { ok: true; submission: Submission } | { ok: false; id?: string; message: string };
/** A submission as checkSubmission returns it: only these fields. */
export interface Submission {
  id: string;
  name: string | null;
  revision: string | null;
  page: { number: number; id?: string; title?: string };
  answers: Record<string, AskAnswer>;
  notes: Record<string, string>;
  comment: string;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// (a board's questions, read once for each text posted: kept with that
// text, and read again if the posted object now has another, HARD-A6E-2)
const boards = new WeakMap<Posted, { text: string; d: BoardDoc | string }>();
function boardOf(posted: Posted): BoardDoc | string {
  const kept = boards.get(posted);
  if (kept && kept.text === posted.text) return kept.d;
  let d: BoardDoc | string;
  try {
    const raw = JSON.parse(posted.text);
    const bad = raw && typeof raw === "object" && !Array.isArray(raw) ? formatError(raw) : "not a board";
    d = bad ? `the board posted can't take answers: ${bad}` : isBoard(raw) ? cleanDoc(raw) : "the board posted can't take answers: it is not a board";
  } catch {
    d = "the board posted has no questions (it is not a board's JSON)";
  }
  boards.set(posted, { text: posted.text, d });
  return d;
}

/**
 * A host's check of a submission, against the board it posted on that
 * channel (web/board-host-protocol.md, "Checking a submission"): plain
 * JSON data, at most 64 KiB as UTF-8, every field as the protocol says,
 * and every answer and note one its question takes.  Ok: the submission
 * with only its known fields (quote only this).  Not: why, in Sagebrush's
 * words, and its id if it had a valid one (to say `refused`).
 */
export function checkSubmission(posted: Posted, m: unknown): Checked {
  const id = isObj(m) && typeof m.id === "string" && UUID.test(m.id) ? m.id : undefined;
  const no = (message: string): Checked => ({ ok: false, ...(id ? { id } : {}), message });
  // (plain JSON, walked without recursion before anything reads it:
  // structured clone carries cycles and other types.  Values counted as
  // they are found, before a container's are taken, and its characters as
  // a lower bound of its size: a wide or long one refused before anything
  // the size of it is made, HARD-A6E-1)
  const MAX = 10_000, tooMany = "a submission has more than 10000 values", tooBig = `a submission is at most ${ASK_LIMITS.bytes / 1024} KiB`;
  const stack: [unknown, number][] = [[m, 1]];
  let found = 1, chars = 0;
  while (stack.length) {
    const [v, depth] = stack.pop()!;
    if (typeof v === "string") { if ((chars += v.length) > ASK_LIMITS.bytes) return no(tooBig); continue; }
    if (v === null || typeof v === "boolean") continue;
    if (typeof v === "number") { if (!Number.isFinite(v)) return no("a submission's numbers are finite"); continue; }
    if (depth > 4) return no("a submission nests at most 4 deep");
    if (Array.isArray(v)) {
      if (Object.getPrototypeOf(v) !== Array.prototype) return no("a submission is plain JSON data");
      if ((found += v.length) > MAX) return no(tooMany);
      for (let i = 0; i < v.length; i++) stack.push([v[i], depth + 1]);
      continue;
    }
    if (typeof v !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(v))) return no("a submission is plain JSON data");
    // (its own keys one at a time, never a list of them all: its prototype is Object's or none)
    for (const k in v) {
      if (!Object.prototype.hasOwnProperty.call(v, k)) continue;
      if (++found > MAX) return no(tooMany);
      if ((chars += k.length) > ASK_LIMITS.bytes) return no(tooBig);
      stack.push([(v as any)[k], depth + 1]);
    }
  }
  let bytes: number;
  try { bytes = new TextEncoder().encode(JSON.stringify(m)).length; } catch { return no("a submission is plain JSON data"); }
  if (bytes > ASK_LIMITS.bytes) return no(`a submission is at most ${ASK_LIMITS.bytes / 1024} KiB`);
  if (!isObj(m) || m.sagebrush !== "answers" || m.version !== 1) return no("not a submission");
  if (!id) return no("a submission's id is a UUID");
  if ((m.name ?? null) !== (posted.name ?? null) || (m.revision ?? null) !== (posted.revision ?? null)) return no("a submission's name and revision are those of the board posted on its channel");
  if (!isObj(m.page)) return no("a submission's page is an object");
  if (m.notes !== undefined && !isObj(m.notes)) return no("a submission's notes are an object");
  const d = boardOf(posted);
  if (typeof d === "string") return no(d);
  const why = submissionProblem(d, m);
  if (why) return no(why);
  const n = m.page.number as number, p = pageOf(d, n - 1), many = !!d.pages?.length;
  if (m.page.id !== undefined && m.page.id !== (many ? p.id : undefined)) return no("a submission's page id is not its page's");
  if (m.page.title !== undefined && m.page.title !== (many ? p.title : undefined)) return no("a submission's page title is not its page's");
  const own = (o: any) => Object.fromEntries(Object.keys(o ?? {}).map((k) => [k, o[k]]));
  return { ok: true, submission: { id, name: m.name ?? null, revision: m.revision ?? null, page: { number: n, ...(typeof m.page.id === "string" ? { id: m.page.id } : {}), ...(typeof m.page.title === "string" ? { title: m.page.title } : {}) },
    answers: own(m.answers), notes: own(m.notes), comment: typeof m.comment === "string" ? m.comment : "" } };
}
