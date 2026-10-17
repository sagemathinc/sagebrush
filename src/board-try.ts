// sagebrush board try FILE [--cases CASES.json | --case 'ID=JSON' ...] [--json]
// [--timeout S]: a board's questions tried with given answers, as a reader
// would answer them, for an evaluator (the teaching boards' grader:
// /scratch/sagebrush-eval/teaching/FORMAT.md).  The board is validated and
// its code items run as `board run` runs them; then each case's answer is
// checked by its question's check (lib/_sb_check.py: the board's names,
// `answer` bound), each hint rendered, and each sequence of answers applied
// to a copy of the board as a reader would, its progress written to a file
// and read back.  The report is JSON whose fields are the grader's.
//
// Every evaluation (a case's check, a hint, each answer of a sequence) runs
// in an interpreter of its own, the board's code run there first, so each
// starts from the state the code leaves ("isolation": "rerun";
// "scope_preserved": null, as it is not compared).  A note without an answer
// is not checked ("in words").  The exit status: 0 when every case could be
// tried (each one's own failure is in its record), 1 when the board can't be
// read, 2 for a wrong command line or cases that can't be tried as given, 3
// when the run was out of time (with what was observed, "complete": false).
//
// Loaded only for `board try` (src/board-cli.ts).

import { createHash } from "crypto";
import { execFileSync } from "child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { cleanDoc, formatError, isBoard, type AskAnswer, type BoardDoc, type DocAsk } from "../web/board/doc";
import { asksOf, ASK_LIMITS } from "../web/board/ask";
import { checkText, FILE_MAX, readBounded } from "./board-check";
import { CLI_READER } from "./board-cli";
import { runBoard, type BoardRun, type Evaluate } from "./board-run";
import { oneLine } from "./terminal-text";

const USAGE = `usage: sagebrush board try FILE [--cases CASES.json | --case 'ID=JSON' ...] [--json] [--timeout S]
  try a board's questions with given answers, as a reader would answer
  them: the board validated, its code run, each answer checked by its
  question's check (in a copy of the board's names), each hint shown, and
  sequences of answers applied as a reader would, their progress saved and
  read back; a report for an evaluator
  --cases F     a JSON file: {"checks": [{"case_id", "ask_id", "answer"?,
                "note"?}], "sequences": [{"ask_id", "answers": [...]}]}
  --case ID=V   a question's id and an answer, as JSON (--case 'q1="1/2"');
                repeated for more
  (neither: each question's \`example\` answer, case_id "example-ID")
  --json        the report as JSON (else a summary)
  --timeout S   the most seconds the whole run may take (default 600)
  The exit status is 0 when every case could be tried, 1 if the board
  can't be read, 2 for a wrong command line or cases that can't be tried
  as given (a case_id twice, a question that isn't there), 3 if the run
  ran out of time.  With --json, a refusal and a run out of time are
  reports too, with "complete": false and the "error".
`;

const say = (msg: string) => process.stderr.write(`sagebrush board try: ${oneLine(msg)}\n`);
const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
export const CASES_MAX = 10_000;
const FRESH = "not compared: each evaluation runs in an interpreter of its own, after the board's code";

interface CheckCase { case_id: string; ask_id: string; answer?: unknown; note?: string }
interface Sequence { ask_id: string; answers: unknown[] }

/** The cases, checked: why they can't be tried, or them. */
export function readCases(raw: unknown, asks: Map<string, DocAsk>): { checks: CheckCase[]; sequences: Sequence[] } | string {
  if (!isObj(raw)) return "the cases are a JSON object: {\"checks\": [...], \"sequences\": [...]}";
  const checks = raw.checks ?? [], sequences = raw.sequences ?? [];
  if (!Array.isArray(checks) || !Array.isArray(sequences)) return "checks and sequences are lists";
  if (checks.length + sequences.length > CASES_MAX) return `more than ${CASES_MAX} cases`;
  // (every answer of a sequence a case too, counted before anything runs, HARD-A19-2)
  let total = checks.length;
  for (const s of sequences) if (isObj(s) && Array.isArray(s.answers) && (total += s.answers.length) > CASES_MAX) return `more than ${CASES_MAX} cases, counting each answer of a sequence`;
  const seen = new Set<string>();
  for (const [i, c] of checks.entries()) {
    if (!isObj(c) || typeof c.case_id !== "string" || typeof c.ask_id !== "string") return `checks[${i}]: a case has a case_id and an ask_id (strings)`;
    if (seen.has(c.case_id)) return `checks[${i}]: the case_id ${JSON.stringify(c.case_id.slice(0, 60))} is there twice`;
    seen.add(c.case_id);
    if (!asks.has(c.ask_id)) return `checks[${i}]: no question has the id ${JSON.stringify(c.ask_id.slice(0, 60))}`;
    if (c.answer === undefined && typeof c.note !== "string") return `checks[${i}]: a case has an answer, or a note, or both`;
    if (c.note !== undefined && typeof c.note !== "string") return `checks[${i}]: a note is a string`;
  }
  for (const [i, s] of sequences.entries()) {
    if (!isObj(s) || typeof s.ask_id !== "string" || !Array.isArray(s.answers) || !s.answers.length) return `sequences[${i}]: a sequence has an ask_id and a list of answers`;
    if (!asks.has(s.ask_id)) return `sequences[${i}]: no question has the id ${JSON.stringify(s.ask_id.slice(0, 60))}`;
  }
  return { checks: checks as CheckCase[], sequences: sequences as Sequence[] };
}

/** This sagebrush: its version, its build, and the commit it was built from when that is known. */
function runtime(): { version: string; engine: string | null; build: string | null; commit: string | null } {
  const g = globalThis as any;
  let commit: string | null = process.env.SAGEBRUSH_COMMIT && /^[0-9a-f]{40}$/.test(process.env.SAGEBRUSH_COMMIT) ? process.env.SAGEBRUSH_COMMIT : null;
  if (!commit) {
    try {
      const at = dirname(require.main?.filename ?? process.argv[1]);
      const sha = execFileSync("git", ["-C", at, "rev-parse", "HEAD"], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }).trim();
      const dirty = execFileSync("git", ["-C", at, "status", "--porcelain", "--untracked-files=no"], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }).trim();
      if (/^[0-9a-f]{40}$/.test(sha) && !dirty) commit = sha;
    } catch {}
  }
  // (the engine: this CLI, by its entry file's SHA-256, first 20 hex digits; a release's CLI is one file)
  let engine: string | null = null;
  try { engine = "cli-" + createHash("sha256").update(readFileSync(require.main?.filename ?? process.argv[1])).digest("hex").slice(0, 20); } catch {}
  return { version: g.__SAGEBRUSH_VERSION__ ?? "dev", engine, build: g.__SAGEBRUSH_BUILD_ID__ ?? null, commit };
}

type Verdict = { outcome: "right" | "wrong" | "error"; raw: unknown; message: string | null; error: string | null; timedOut: boolean; undecided?: boolean };
async function verdict(ev: Evaluate, a: DocAsk, answer: unknown): Promise<Verdict> {
  if (a.check === undefined) return { outcome: "error", raw: null, message: null, error: "the question has no check", timedOut: false };
  const r = await ev(a.check, answer, a.checkMs ?? 2000);
  // (a check that can't decide, a board check helper's verdict: an error, said so, and told apart)
  if (!r.ok) return { outcome: "error", raw: null, message: null, error: r.undecided ? "could not decide: " + (r.error ?? "") : r.error ?? "it failed", timedOut: r.timedOut, undecided: !!r.undecided };
  const v = r.value;
  return { outcome: v === true ? "right" : "wrong", raw: v, message: typeof v === "string" ? v : null, error: null, timedOut: false };
}

/** The `board try` command; returns the exit code. */
export async function boardTry(argv: string[]): Promise<number> {
  if (argv.includes("-h") || argv.includes("--help")) { process.stdout.write(USAGE); return 0; }
  let file: string | null = null, casesFile: string | null = null, json = false, timeout = 600;
  const inline: [string, string][] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") json = true;
    else if (a === "--cases") { casesFile = argv[++i] ?? null; if (casesFile === null) { say("--cases takes a file"); return 2; } }
    else if (a === "--case") {
      const v = argv[++i], m = v === undefined ? null : /^([^=]+)=([\s\S]*)$/.exec(v);
      if (!m) { say("--case takes ID=JSON, such as --case 'q1=\"1/2\"'"); return 2; }
      inline.push([m[1], m[2]]);
    } else if (a === "--timeout") timeout = Number(argv[++i]);
    else if (a.startsWith("-") && a !== "-") { say(`unknown option ${a}`); process.stderr.write(USAGE); return 2; }
    else if (file === null) file = a;
    else { process.stderr.write(USAGE); return 2; }
  }
  if (file === null) { process.stderr.write(USAGE); return 2; }
  if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 86400) { say("--timeout takes a number of seconds, more than 0 and at most 86400"); return 2; }

  // (refused before anything runs: said, and with --json a report saying so, incomplete)
  let sha: string | null = null;
  const refuse = (status: 1 | 2, msg: string) => {
    say(msg);
    if (json) process.stdout.write(JSON.stringify({ schema_version: 1, complete: false, error: msg, board_sha256: sha, runtime: runtime(), validation: null, code: [], checks: [], hints: [], interaction: [] }, null, 2) + "\n");
    return status;
  };
  // the board: its exact bytes, read and checked
  let bytes: Buffer, raw: any, doc: BoardDoc;
  try {
    const b = readBounded(file, FILE_MAX);
    if (b === null) throw new Error(`too large for the board to open (at most ${FILE_MAX / 2 ** 20} MB)`);
    bytes = b;
    sha = createHash("sha256").update(bytes).digest("hex");
    raw = JSON.parse(bytes.toString("utf8"));
    const bad = isObj(raw) ? formatError(raw, CLI_READER) : "not a board: a board is a JSON object";
    if (bad) throw new Error(bad);
    if (!isBoard(raw)) throw new Error("not a board: a document needs nodes (or pages of them)");
    doc = cleanDoc(raw);
  } catch (e: any) {
    return refuse(1, `${file}: ${e?.message ?? e}`);
  }
  const asks = new Map<string, DocAsk>();
  for (const q of asksOf(doc)) if (!asks.has(q.ask.id)) asks.set(q.ask.id, q.ask);
  // the cases
  let given: unknown;
  try {
    if (casesFile !== null) {
      const c = readBounded(casesFile, 64 * 2 ** 20);
      if (c === null) throw new Error("the cases file is past 64 MB");
      given = JSON.parse(c.toString("utf8"));
    } else given = { checks: inline.length ? [] : [...asks.values()].filter((a) => a.example !== undefined).map((a) => ({ case_id: `example-${a.id}`, ask_id: a.id, answer: a.example })) };
    // (--case beside a file of sequences only: its checks begin here)
    if (inline.length && isObj(given) && given.checks === undefined) given.checks = [];
    if (inline.length && !(isObj(given) && Array.isArray(given.checks))) throw new Error("its checks are a list");
    for (const [k, [id, v]] of inline.entries()) (given as any).checks.push({ case_id: `case-${k + 1}`, ask_id: id, answer: JSON.parse(v) });
  } catch (e: any) {
    return refuse(2, `the cases: ${e?.message ?? e}`);
  }
  // (cases that can't be tried as given, a case_id twice, a question that isn't there: refused before anything runs, exit 2 as agreed)
  const cases = readCases(given, asks);
  if (typeof cases === "string") return refuse(2, cases);
  if (casesFile === null && !inline.length && !cases.checks.length) { process.stderr.write(USAGE); return refuse(2, "nothing to try: no question has an `example`; give --case or --cases"); }

  const report: any = {
    schema_version: 1, complete: false, board_sha256: sha, runtime: runtime(),
    validation: { ok: true, errors: [] as string[] }, code: [] as any[], checks: [] as any[], hints: [] as any[], interaction: [] as any[],
  };
  const problems = checkText(bytes.toString("utf8")).problems.filter((p) => p.level === "error");
  report.validation = { ok: !problems.length, errors: problems.map((p) => `${p.path || "(the board)"}: ${p.message}`) };

  // the whole run, within --timeout: what was observed by then said, incomplete
  let outOfTime = false;
  const deadline = new Promise<"timeout">((r) => setTimeout(() => { outOfTime = true; r("timeout"); }, timeout * 1000).unref());
  const work = (async () => {
    // Every evaluation (a case's check, a hint, a sequence's answer) runs in
    // an interpreter of its own, the board's code run in it first: what one
    // check does to the board's values never reaches another (the
    // coordinator's rule for CORR-A19-1; astra2's CORR-A19-2).
    type Session = { ev: Evaluate; run: BoardRun; close: () => Promise<void> };
    const open = () => new Promise<Session>((ready, fail) => {
      let release!: () => void;
      const released = new Promise<void>((r) => (release = r));
      const done = runBoard(doc, 60, async (ev, run) => { ready({ ev, run, close: async () => { release(); await done.catch(() => {}); } }); await released; });
      done.then(() => fail(new Error("the board's code could not be run")), fail);
    });
    let session = await open(), dirty = false;
    const ev: Evaluate = async (code, answer, ms) => {
      if (dirty) { await session.close(); session = await open(); dirty = false; }
      dirty = true;
      return session.ev(code, answer, ms);
    };
    try {
    {
      const run = session.run;
      report.code = run.list.map((r) => ({ id: r.id, ok: r.status === "ok", error: r.status === "ok" ? null : r.error ?? r.status, timed_out: r.status === "timeout" }));
      // each case: its answer checked (none: in words), from the board's state
      const firstWrong = new Map<string, unknown>();
      for (const c of cases.checks) {
        if (outOfTime) return;
        const a = asks.get(c.ask_id)!, note = typeof c.note === "string" ? c.note : null;
        if (c.answer === undefined) {
          report.checks.push({ case_id: c.case_id, ask_id: c.ask_id, answer: null, note, outcome: "in words", raw_result: null, message: null, error: null, timed_out: false, check_invoked: false, undecided: false, scope_preserved: null, scope_preserved_reason: "no check ran", isolation: null, note_preserved: note !== null, next: null });
          continue;
        }
        // ("rerun": in an interpreter of its own, the board's code run first; whether the board's names were left as they were is not said)
        const v = await verdict(ev, a, c.answer), isolation = "rerun";
        if (v.outcome === "wrong" && !firstWrong.has(c.ask_id)) firstWrong.set(c.ask_id, c.answer);
        report.checks.push({ case_id: c.case_id, ask_id: c.ask_id, answer: c.answer, note, outcome: v.outcome, raw_result: v.outcome === "error" ? null : v.raw, message: v.message, error: v.error, timed_out: v.timedOut, check_invoked: true, undecided: !!v.undecided, scope_preserved: null, scope_preserved_reason: FRESH, isolation, note_preserved: note !== null || null, next: v.outcome === "right" ? a.next?.right ?? null : v.outcome === "wrong" ? a.next?.wrong ?? null : null });
      }
      // each hint, as shown: a computed one with its question's first wrong answer
      for (const [id, a] of asks) {
        for (const [index, h] of (a.hints ?? []).slice(0, ASK_LIMITS.hints).entries()) {
          if (outOfTime) return;
          if (typeof h === "string") { report.hints.push({ ask_id: id, index, rendered: h, error: null, timed_out: false }); continue; }
          const r = await ev(h.code, firstWrong.has(id) ? firstWrong.get(id) : null, a.checkMs ?? 2000);
          const ok = r.ok && typeof r.value === "string";
          report.hints.push({ ask_id: id, index, rendered: ok ? r.value : null, error: ok ? null : r.ok ? "its value is not a string" : r.error ?? "it failed", timed_out: r.timedOut });
        }
      }
      // each sequence: answered in turn on a copy of the board, its progress saved and read back
      for (const s of cases.sequences) {
        if (outOfTime) return;
        const a = asks.get(s.ask_id)!, outcomes: string[] = [], shown: number[] = [];
        let attempts = 0, wrong = 0, result: string | null = null, last: unknown = null;
        for (const answer of s.answers) {
          const v = await verdict(ev, a, answer);
          // (an error is the check's, not the reader's attempt: not counted, as the board doesn't, CORR-A19-6)
          if (v.outcome !== "error") attempts++;
          result = v.outcome;
          last = answer;
          outcomes.push(v.outcome);
          if (v.outcome === "wrong") { wrong++; for (let k = 0; k < Math.min(wrong, a.hints?.length ?? 0, ASK_LIMITS.hints); k++) if (!shown.includes(k)) shown.push(k); }
        }
        const copy = JSON.parse(bytes.toString("utf8"));
        setProgress(copy, s.ask_id, { answer: last, attempts, wrongAttempts: wrong, result });
        const dir = mkdtempSync(join(tmpdir(), "sagebrush-try-"));
        let back: DocAsk | undefined;
        try {
          writeFileSync(join(dir, "board.json"), JSON.stringify(copy));
          back = asksOf(cleanDoc(JSON.parse(readFileSync(join(dir, "board.json"), "utf8")))).find((q) => q.ask.id === s.ask_id)?.ask;
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
        report.interaction.push({ ask_id: s.ask_id, sequence: outcomes, hints_shown: shown, attempts_after_reload: back?.attempts ?? null, result_after_reload: back?.result ?? null, answer_preserved_after_reload: JSON.stringify(back?.answer) === JSON.stringify(last) });
      }
    }
    } finally {
      await session.close();
    }
    return "done" as const;
  })();
  const how = await Promise.race([work, deadline]);
  report.complete = how === "done";
  if (!report.complete) report.error = `the run ran out of time (${timeout} s): what was observed by then is here`;
  if (json) process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  else {
    const w = process.stdout, count = (o: string) => report.checks.filter((c: any) => c.outcome === o).length;
    w.write(`${oneLine(file)}: ${report.validation.ok ? "valid" : `${report.validation.errors.length} problem(s)`}; ${report.code.filter((c: any) => c.ok).length} of ${report.code.length} code items ran; ${report.checks.length} case(s): ${count("right")} right, ${count("wrong")} wrong, ${count("error")} error, ${count("in words")} in words\n`);
    for (const c of report.checks) w.write(`  ${oneLine(c.case_id)} [${oneLine(c.ask_id)}] ${c.outcome}${c.message ? `: ${oneLine(c.message)}` : c.error ? `: ${oneLine(c.error)}` : ""}\n`);
    if (!report.complete) w.write(`incomplete: ${report.error}\n`);
  }
  // (out of time: the interpreter still running is not waited for)
  if (!report.complete) process.exit(3);
  return 0;
}

/** A question's progress written into a board's raw JSON, as the board keeps it. */
function setProgress(raw: any, id: string, p: { answer: unknown; attempts: number; wrongAttempts: number; result: string | null }) {
  const walk = (ns: unknown): boolean => {
    if (!Array.isArray(ns)) return false;
    for (const n of ns) {
      if (!isObj(n)) continue;
      if (n.kind === "group" && walk(n.children)) return true;
      if (n.kind === "ask" && String(n.id) === id) {
        n.answer = p.answer as AskAnswer;
        n.attempts = p.attempts;
        n.wrongAttempts = p.wrongAttempts;
        if (p.result) n.result = p.result;
        return true;
      }
    }
    return false;
  };
  if (Array.isArray(raw.pages)) { for (const pg of raw.pages) if (walk(pg?.nodes)) return; }
  else walk(raw.nodes);
}
