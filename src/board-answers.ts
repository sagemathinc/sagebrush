// sagebrush board answers FILE [--json] [--apply SUBMISSION] [-o OUT]: a
// board's questions (`kind: "ask"`) and the answers kept in it; with
// --apply, a host's submission (web/board-host-protocol.md) written into
// the file first, checked as the host checks it.  So an agent that gets a
// person's answers records them in its board in one step, and reads them
// back the same way.
//
// Loaded only for `board answers` (src/board-cli.ts).

import { closeSync, fsyncSync, openSync, renameSync, statSync, unlinkSync, writeFileSync } from "fs";
import { randomBytes } from "crypto";
import { basename, dirname, join } from "path";
import { cleanDoc, formatError, isBoard, pageCount, type BoardDoc } from "../web/board/doc";
import { answered, answerProblem, answerText, asksOf, ASK_LIMITS, submissionProblem, type PageAsk } from "../web/board/ask";
import { FILE_MAX, readBounded } from "./board-check";
import { CLI_READER } from "./board-cli";
import { oneLine } from "./terminal-text";

const USAGE = `usage: sagebrush board answers FILE [--json] [--apply SUBMISSION] [-o OUT]
  a board's questions (items of kind "ask") and the answers kept in it:
  which are answered, and which required ones are not
  --json              the report as JSON
  --apply SUBMISSION  first write a host's submission into the board: a
                      JSON file (- for standard input) with the "answers"
                      message a board's host passes on (see
                      https://sagebrush.space/board-host-protocol.md); it
                      is checked against the board's questions, and
                      replaces the answers on its page (a question it
                      leaves out is unanswered)
  -o OUT              with --apply: write the board to OUT, not FILE
  The exit status is 1 if the board can't be read, or the submission is
  refused (nothing is written then).
`;

const say = (msg: string) => process.stderr.write(`sagebrush board answers: ${oneLine(msg)}\n`);
const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);

// (the check of a submission, the hosts' too: web/board/ask.ts)
export { submissionProblem };

/** The board's raw JSON with a (checked) submission's answers on its page:
 * every question there has the submission's answer and note, or none.  The
 * rest of the file is as it was. */
export function applySubmission(raw: any, m: any): any {
  const nodes = Array.isArray(raw.pages) ? raw.pages[m.page.number - 1]?.nodes : raw.nodes;
  const walk = (ns: unknown) => {
    if (!Array.isArray(ns)) return;
    for (const n of ns) {
      if (!isObj(n)) continue;
      if (n.kind === "group") walk(n.children);
      else if (n.kind === "ask" && n.id != null) {
        const id = String(n.id), notes = isObj(m.notes) ? m.notes : {};
        if (Object.prototype.hasOwnProperty.call(m.answers, id)) n.answer = m.answers[id];
        else delete n.answer;
        if (Object.prototype.hasOwnProperty.call(notes, id)) n.note = notes[id];
        else delete n.note;
      }
    }
  };
  walk(nodes);
  return raw;
}

/** Write a file whole, then put it in place (never half a board): a new
 * file of a random name beside it, created only if no file or link has
 * that name (SEC-02C-2), with the mode of the file it replaces; removed if
 * anything fails.  The reason it failed, or null. */
export function writeWhole(to: string, text: string): string | null {
  const tmp = join(dirname(to), `.${basename(to)}.${randomBytes(8).toString("hex")}.tmp`);
  let mode = 0o666, made = false, done = false;
  try { mode = statSync(to).mode & 0o777; } catch {}
  try {
    const fd = openSync(tmp, "wx", mode);
    made = true;
    // (all of it: writeFileSync on a descriptor writes until done, where one writeSync may write part, HARD-738-1)
    // (and on the disk before it takes the board's name)
    try { writeFileSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tmp, to);
    done = true;
    return null;
  } catch (e: any) {
    return `${to}: ${e?.code === "EISDIR" ? "a directory" : e?.message ?? e}`;
  } finally {
    if (made && !done) try { unlinkSync(tmp); } catch {}
  }
}

// (the first line of a question, short)
const said = (q: PageAsk) => { const t = (q.ask.title || q.ask.text || "").split("\n").find((l) => l.trim()) ?? ""; return t.length > 70 ? t.slice(0, 67) + "..." : t; };

/** The `board answers` command; returns the exit code. */
export async function boardAnswers(argv: string[]): Promise<number> {
  if (argv.includes("-h") || argv.includes("--help")) { process.stdout.write(USAGE); return 0; }
  let file: string | null = null, json = false, apply: string | null = null, out: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") json = true;
    else if (a === "--apply") { apply = argv[++i] ?? null; if (apply === null) { say("--apply takes a submission's file"); return 2; } }
    else if (a === "-o" || a === "--output") { out = argv[++i] ?? null; if (out === null) { say("-o takes a file"); return 2; } }
    else if (a.startsWith("-") && a !== "-") { say(`unknown option ${a}`); process.stderr.write(USAGE); return 2; }
    else if (file === null) file = a;
    else { process.stderr.write(USAGE); return 2; }
  }
  if (file === null) { process.stderr.write(USAGE); return 2; }
  if (out !== null && apply === null) { say("-o is for --apply"); return 2; }
  if (apply === "-" && file === "-") { say("the board and the submission can't both be standard input"); return 2; }
  if (apply !== null && file === "-" && out === null) { say("a board from standard input needs -o OUT for --apply"); return 2; }
  const read = (f: string, max: number, what: string): any => {
    const bytes = readBounded(f, max);
    if (bytes === null) throw new Error(`${f}: too large for ${what} (at most ${max >= 2 ** 20 ? `${max / 2 ** 20} MB` : `${max / 1024} KiB`})`);
    try { return JSON.parse(bytes.toString("utf8")); } catch (e: any) { throw new Error(`${f}: not JSON (${String(e?.message ?? e).slice(0, 120)})`); }
  };
  let raw: any, doc: BoardDoc, sub: any = null;
  try {
    raw = read(file, FILE_MAX, "a board");
    const bad = isObj(raw) ? formatError(raw, CLI_READER) : "not a board: a board is a JSON object";
    if (bad) throw new Error(`${file}: ${bad}`);
    if (!isBoard(raw)) throw new Error(`${file}: not a board: a document needs nodes (or pages of them)`);
    doc = cleanDoc(raw);
    if (apply !== null) sub = read(apply, ASK_LIMITS.bytes, "a submission");
  } catch (e: any) {
    say(String(e?.message ?? e));
    return 1;
  }
  if (sub !== null) {
    const why = submissionProblem(doc, sub);
    if (why) { say(`${apply === "-" ? "(standard input)" : apply}: refused, nothing written: ${why}`); return 1; }
    raw = applySubmission(raw, sub);
    doc = cleanDoc(raw);
    const why2 = writeWhole(out ?? file, JSON.stringify(raw, null, 2) + "\n");
    if (why2) { say(why2); return 1; }
  }
  const qs = asksOf(doc), done = qs.filter((q) => answered(q.ask)), missing = qs.filter((q) => q.ask.required && !answered(q.ask));
  const applied = sub ? { page: sub.page.number, id: typeof sub.id === "string" ? sub.id : null, name: sub.name ?? null, revision: sub.revision ?? null, comment: typeof sub.comment === "string" ? sub.comment : "" } : undefined;
  if (json) {
    process.stdout.write(JSON.stringify({
      file, questions: qs.map((q) => {
        const why = q.ask.answer !== undefined ? answerProblem(q.ask, q.ask.answer) : null;
        return { page: q.page, ...(q.pageId ? { pageId: q.pageId } : {}), ...(q.pageTitle ? { pageTitle: q.pageTitle } : {}), id: q.ask.id, input: q.ask.input, ...(q.ask.title ? { title: q.ask.title } : {}), ...(q.ask.text ? { text: q.ask.text } : {}),
          required: !!q.ask.required, ...(q.ask.options ? { options: q.ask.options.map((o) => (typeof o === "string" ? { value: o, label: o } : { value: o.value, label: o.label ?? o.value })) } : {}),
          answer: q.ask.answer ?? null, note: q.ask.note ?? null, ...(why ? { problem: why } : {}) };
      }),
      answered: done.length, missing: missing.map((q) => ({ page: q.page, id: q.ask.id })), complete: missing.length === 0, ...(applied ? { applied } : {}),
    }, null, 2) + "\n");
    return 0;
  }
  const w = process.stdout, name = oneLine(file === "-" ? "(standard input)" : basename(out ?? file));
  if (applied) w.write(`${name}: wrote the answers to page ${applied.page}${applied.comment ? `, with the comment ${oneLine(JSON.stringify(applied.comment.length > 200 ? applied.comment.slice(0, 197) + "..." : applied.comment))}` : ""}\n`);
  w.write(`${name}: ${qs.length} question${qs.length === 1 ? "" : "s"}, ${done.length} answered${missing.length ? `; required, not answered: ${missing.map((q) => oneLine(JSON.stringify(q.ask.id))).join(", ")}` : ""}\n`);
  let page = 0;
  for (const q of qs) {
    if (q.page !== page && pageCount(doc) > 1) w.write(`page ${q.page}${q.pageTitle ? ` (${oneLine(q.pageTitle)})` : ""}:\n`);
    page = q.page;
    const why = q.ask.answer !== undefined ? answerProblem(q.ask, q.ask.answer) : null;
    // (its answer, and the reader's words: either, or both)
    const words = q.ask.note?.trim() ? q.ask.note : undefined, lines: string[] = [];
    if (q.ask.answer !== undefined || !words) lines.push(`${oneLine(answerText(q.ask))}${why ? `  (not an answer it takes: ${oneLine(why)})` : ""}`);
    if (words) lines.push(`in words: ${oneLine(JSON.stringify(words.length > 200 ? words.slice(0, 197) + "..." : words))}`);
    w.write(`  ${oneLine(q.ask.id)} [${q.ask.input}${q.ask.required ? ", required" : ""}] ${oneLine(said(q))}\n${lines.map((l) => "    " + l + "\n").join("")}`);
  }
  return 0;
}
