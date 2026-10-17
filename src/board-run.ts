// sagebrush board run FILE [--json] [--timeout S] [--store-previews [-o OUT]]:
// every code item of a board run as the board runs it in a browser, here,
// without one, and each item's outputs or its error reported, so that an
// agent writing a board can fix what fails before handing it over.
//
// As the board runs it (web/board/code.ts): one interpreter for the board,
// in its language (BoardDoc.mode), its code items the cells of a reactive
// notebook in the board's reading order (doc.ts codeOrder), scheduled by the
// notebook's own scheduler (src/notebook-reactive.ts: dependencies,
// page-order scoping, a cell that raises cancelling what reads it), each
// run with the seed the board gives it (SHA-256 of "seed:id") and its `_`
// names its own.  The interpreter is src/notebook-session.ts in a worker
// thread, as `sagebrush notebook` runs it, in an empty directory of its own
// (a board's code has no files in a browser).  An item over its time is
// interrupted (KeyboardInterrupt), and if it does not stop, the interpreter
// is stopped and what was left is not run.
//
// --store-previews writes the board with the outputs of its slow items as
// their previews, as the board keeps them (web/board/preview.ts: an item
// over PREVIEW_MS from root; --preview-ms 0: every item), to OUT, else to
// NAME.previews.board.json beside FILE, never over a file that is there
// unless it is named with -o.  Pictures are kept as they are when they fit
// a preview (there is no canvas here to draw them smaller).
//
// Loaded only for `board run` (src/cli.ts), so nothing else starts slower.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, dirname, basename } from "path";
import { createHash } from "crypto";
import { Worker, parentPort } from "worker_threads";
import { boardFromText } from "../web/board/mermaid";
import { canonical, cleanDoc, codeOrder, formatError, isBoard, pageCount, pageView, type BoardDoc, type DocNode, type DocNote } from "../web/board/doc";
import { PREVIEW_MS, imageSize, makePreview, overCap, type Preview, type Raster } from "../web/board/preview";
import { Reactive, SCOPE_SEP, type Analysis, type CellState, type RunReport } from "./notebook-reactive";
import type { CellError } from "./notebook-graph";
import { analyzeCell, ImportStarError } from "./dataflow";
import { renameRedefinitions } from "./rename";
import { oneLine, textLines } from "./terminal-text";
import { CLI_READER, pictureWarning } from "./board-cli";
import { DISPLAY_ENVELOPE, displayCost } from "./output-cost";

const USAGE = `usage: sagebrush board run FILE [--json] [--timeout S] [--figures DIR] [--store-previews [-o OUT] [--preview-ms MS]]
  run every code item of a board as the board runs it in a browser (its
  language, its reactive order and its seeds), and report each item's
  output, or its error; the exit status is 1 if an item failed, has an
  error, was not run or ran out of time
  --json            the report as JSON
  --timeout S       the seconds an item may run (default 60); longer is an error
  --figures DIR     save each item's figures (plots, pictures) in DIR, as
                    ITEM-1.svg and so on (never over a file that is there);
                    the report says each figure's size and what it shows
  --store-previews  write the board with its slow items' outputs as their
                    previews, so it shows them at once: to OUT, else to
                    NAME.previews.board.json beside FILE (not over a file
                    that is there); --preview-ms MS: the items over MS from
                    root (default ${PREVIEW_MS}, as the board keeps them; 0: all)
  The code runs here, as you, as \`sagebrush -c\` runs it: run boards you trust.
`;

/** The seed of a board without one of its own (web/board/code.ts BOARD_SEED). */
const BOARD_SEED = "0".repeat(64);
const hex = (s: string) => createHash("sha256").update(s).digest("hex");

type Status = "ok" | "failed" | "error" | "not run" | "timeout";
interface ItemReport {
  n: number;
  id: string;
  /** its page (from 1), on a board of pages */
  page?: number;
  title?: string;
  status: Status;
  ms?: number;
  stdout: string;
  stderr: string;
  outputs: { type: string; text?: string; bytes?: number; figure?: Figure }[];
  error?: string;
}
/** A figure an item shows (a plot's SVG, a picture): its size in pixels,
 * what it shows (an SVG plot's title), and where --figures saved it. */
export interface Figure {
  w?: number;
  h?: number;
  title?: string;
  path?: string;
}

// ---- the worker thread: the board's interpreter
export function boardRunWorker(data: { dir: string }) {
  const { notebookSession } = require("./notebook-session");
  const port = parentPort!;
  const session = notebookSession((m: any) => port.postMessage(m), {
    captureStreams: true,
    limit: { item: ITEM_OUTPUT_MAX, run: RUN_OUTPUT_MAX, displays: ITEM_DISPLAYS_MAX },
    init: (R: any) => R.importModule("os").chdir(data.dir),
  });
  port.on("message", (m: any) => session.handle(m));
  const { R } = require("./compile");
  session.ready.then(() => port.postMessage({ ready: true, $intr: R.INTR.buffer }));
}

// (seconds: Node's timers are at most 2^31 - 1 ms, CORR-CD6-4)
const MAX_TIMEOUT = 2147483;
// (a message on stderr: a board's text, a file's name, an option, as anyone wrote them, HARD-CD6-3)
const say = (msg: string) => process.stderr.write(`sagebrush board run: ${oneLine(msg)}\n`);

/** The `board run` command; returns the exit code. */
export async function boardRun(argv: string[]): Promise<number> {
  if (argv.includes("-h") || argv.includes("--help")) { process.stdout.write(USAGE); return 0; }
  let file: string | null = null, out: string | null = null, json = false, store = false, timeout = 60, previewMs = PREVIEW_MS, figures: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") json = true;
    else if (a === "--store-previews") store = true;
    else if (a === "-o" || a === "--output") out = argv[++i] ?? null;
    else if (a === "--timeout") timeout = Number(argv[++i]);
    else if (a === "--preview-ms") previewMs = Number(argv[++i]);
    else if (a === "--figures") { figures = argv[++i] ?? null; if (figures === null) { say("--figures takes a directory"); return 2; } }
    else if (a.startsWith("-") && a !== "-") { say(`unknown option ${a}`); process.stderr.write(USAGE); return 2; }
    else if (file === null) file = a;
    else { process.stderr.write(USAGE); return 2; }
  }
  if (file === null || ((argv.includes("-o") || argv.includes("--output")) && out === null)) { process.stderr.write(USAGE); return 2; }
  if (!Number.isFinite(timeout) || timeout <= 0 || timeout > MAX_TIMEOUT) { say(`--timeout takes a number of seconds, more than 0 and at most ${MAX_TIMEOUT}`); return 2; }
  if (!Number.isFinite(previewMs) || previewMs < 0) { say("--preview-ms takes a number of milliseconds, 0 or more"); return 2; }
  if (out !== null && !store) { say("-o is for --store-previews"); return 2; }
  // (where the board with its previews goes: never over a file that is there, unless named)
  const target = !store ? null : out ?? (file === "-" ? null : join(dirname(file), basename(file).replace(/(\.board)?\.json$/i, "").replace(/\.[^.]*$/, "") + ".previews.board.json"));
  if (store && target === null) { say("a board from standard input needs -o OUT for --store-previews"); return 2; }
  // (said early, before anything runs; and the file is made only if it is still not there, HARD-CD6-2)
  if (store && out === null && existsSync(target!)) { say(`${target} is there already: name it with -o to write over it`); return 2; }

  let doc: BoardDoc;
  try {
    const d = boardFromText(readFileSync(file === "-" ? 0 : file, "utf8"), file === "-" ? undefined : basename(file));
    // (as the board says it, in the command line's words: which sagebrush can't read it, and what to do)
    const bad = formatError(d, CLI_READER);
    if (bad) throw new Error(bad);
    if (!isBoard(d)) throw new Error("not a board: a document needs nodes (or pages of them)");
    // (pictures the board leaves out for their names: said, so they can be renamed)
    const pics = pictureWarning(d);
    if (pics) say(pics);
    doc = cleanDoc(d);
  } catch (e: any) {
    say(`${file}: ${e?.message ?? e}`);
    return 1;
  }
  // (items in another language than the board's: refused, before anything runs)
  const other = otherLanguage(doc);
  if (other) { say(`${file}: ${other}`); return 1; }
  const run = await runBoard(doc, timeout);
  const { mode, items, reports, notes, outputs } = run;
  // (the figures, if asked: in DIR)
  if (figures !== null) {
    const why = saveFigures(run, figures);
    if (why) { say(why); return 1; }
  }
  // the board with its previews, if asked
  let wrote: string | null = null;
  if (store && target) {
    const at = new Date().toISOString(), kept = new Map<string, Preview>();
    for (const { key: id, id: item } of items) {
      const r = reports.get(id)!, n = notes.get(id);
      if (!n) continue;
      // (a cell by its page keeps no preview, as the board's: its cell, and seed, change as pages come and go)
      if (id !== item) { delete n.preview; continue; }
      if (r.status !== "ok" && r.status !== "failed") continue;
      const total = run.fromRoot(id);
      const p = total > previewMs || previewMs === 0 ? await makePreview(previewable(outputs.get(id) ?? []), { at, ms: run.times.get(id) ?? 0, total }, keepRaster) : null;
      if (p) n.preview = p;
      else delete n.preview;
    }
    for (const [id, n] of notes) if (n.preview) kept.set(id, n.preview);
    for (const id of overCap(kept)) delete notes.get(id)!.preview;
    // (a file named with -o is written over; else it is made, and only if
    // it is still not there: the board's code, or anyone, may have made
    // it meanwhile, or put a link there, HARD-CD6-2)
    try {
      writeFileSync(target, canonical(doc), { flag: out !== null ? "w" : "wx" });
    } catch (e: any) {
      say(e?.code === "EEXIST" ? `${target} is there now (made while the board ran): not written over; name it with -o to write over it` : `could not write ${target}: ${e?.code ?? e?.message ?? e}`);
      return 1;
    }
    wrote = target;
  }

  // the report
  const list = run.list;
  const count = (s: Status) => list.filter((r) => r.status === s).length;
  const allOk = list.every((r) => r.status === "ok");
  if (json) {
    process.stdout.write(JSON.stringify({ file, title: doc.title ?? null, mode, ok: allOk, items: list, ...(wrote ? { wrote } : {}) }, null, 2) + "\n");
  } else {
    const w = process.stdout;
    if (!list.length) w.write(`${oneLine(file)}: no code items\n`);
    for (const r of list) {
      const head = `${String(r.n).padStart(3)}  ${r.status.toUpperCase().padEnd(8)} ${r.title ? oneLine(JSON.stringify(r.title)) + " " : ""}(${oneLine(JSON.stringify(r.id))}${r.page ? `, page ${r.page}` : ""})${r.ms !== undefined ? `  ${r.ms} ms` : ""}`;
      w.write(head + "\n");
      // (a picture as what it is and its size, not its text: a figure's text says little)
      const body = r.status === "ok" ? [r.stdout, ...r.outputs.map(outputLine)].filter(Boolean).join("\n") : r.error ?? "";
      if (body.trim()) w.write(indent(cutLines(textLines(body.replace(/\n+$/, "")), 40)) + "\n");
    }
    const parts = (["ok", "failed", "error", "timeout", "not run"] as Status[]).filter((s) => count(s)).map((s) => `${count(s)} ${s}`);
    if (list.length) w.write(`${oneLine(file)}: ${parts.join(", ")} (of ${list.length} code item${list.length === 1 ? "" : "s"}, ${mode})\n`);
    if (wrote) w.write(`wrote ${oneLine(wrote)}, with ${[...notes.values()].filter((n) => n.preview).length} preview(s)\n`);
    if (run.dead && run.workerErr.length) process.stderr.write(textLines(run.workerErr.join("")).slice(0, 4000));
  }
  return allOk ? 0 : 1;
}

/** What running a board's code items gave: each item's report, in the
 * board's reading order, and what --store-previews needs. */
export interface BoardRun {
  mode: string;
  list: ItemReport[];
  items: { key: string; id: string; code: string; page: number }[];
  reports: Map<string, ItemReport>;
  notes: Map<string, DocNote>;
  outputs: Map<string, any[]>;
  /** an item's time from the board's root (ms): its own and what it reads */
  fromRoot: (key: string) => number;
  times: Map<string, number>;
  /** why the interpreter stopped, if it did */
  dead: string | null;
  workerErr: string[];
}

const LANGUAGE: Record<string, string> = { python: "Python", sage: "Sage", magma: "Magma", matlab: "MATLAB" };
/** Why the command line doesn't run this board's code: an item in another
 * language than the board's (item 16).  The board runs each item in its own
 * language; here every item would run in the board's, so a Sage item's
 * print(2^3) would say 1, not 8: refused, saying so, rather than answered
 * wrong (astra's CORR-C5A-2).  null: one language, run as before. */
export function otherLanguage(doc: BoardDoc): string | null {
  const mode = doc.mode ?? "python";
  const order = codeOrder(doc), i = order.findIndex((c) => c.mode !== mode);
  if (i < 0) return null;
  const c = order[i], n = codeNotes(pageView(doc, c.page)).get(c.item);
  return `code item ${i + 1}${n?.title ? ` ${JSON.stringify(n.title)}` : ""} is in ${LANGUAGE[c.mode] ?? c.mode}, not the board's ${LANGUAGE[mode] ?? mode}: the command line runs a board's code in one language only, so it doesn't run this board's (the board itself runs each item in its own language)`;
}

/** Every code item of a (clean) board run as the board runs it (see the
 * top of this file); `timeout` seconds an item.  A board with items in
 * another language than its own is refused (otherLanguage). */
/** A question's check or computed hint, run in the board's interpreter
 * once its code items have run (`sagebrush board try`): its verdict
 * (lib/_sb_check.py), or why there is none. */
export type Evaluate = (code: string, answer: unknown, ms: number) => Promise<{ ok: boolean; value?: unknown; error?: string; isolated?: boolean; preserved?: boolean | null; reason?: string | null; timedOut: boolean }>;

export async function runBoard(doc: BoardDoc, timeout: number, after?: (evaluate: Evaluate, run: BoardRun) => Promise<void>): Promise<BoardRun> {
  const mode = doc.mode ?? "python";
  const other = otherLanguage(doc);
  if (other) throw new Error(other);
  const seed = typeof doc.seed === "string" && /^[0-9a-f]{64}$/.test(doc.seed) ? doc.seed : BOARD_SEED;
  // the code items, as the board runs them (doc.ts codeOrder): page by page,
  // each page in reading order; one cell for each, `key` (an id items on
  // several pages have is told apart by its page: its cell's id is id@pN, or
  // id@pN~2, ~3, ..., CORR-CD6-1, CORR-239-1), `id` its item's
  const pages = pageCount(doc);
  const items = codeOrder(doc).map(({ id, item, code, page }) => ({ key: id, id: item, code, page }));
  const notes = new Map<string, DocNote>();
  for (let page = 0; page < pages; page++) {
    const on = codeNotes(pageView(doc, page));
    for (const it of items) if (it.page === page && on.has(it.id)) notes.set(it.key, on.get(it.id)!);
  }
  const reports = new Map<string, ItemReport>(items.map(({ key, id, page }, i) => [key, { n: i + 1, id, ...(pages > 1 ? { page: page + 1 } : {}), title: notes.get(key)?.title, status: "not run", stdout: "", stderr: "", outputs: [] }]));
  // (each cell's seed from its id, as the board's notebook draws it: an id one item has is its cell's)
  const seedOf = (key: string) => hex(`${seed}:${key}`);
  const label = (id: string) => { const r = reports.get(id); return r ? `item ${r.n}${r.title ? ` ${JSON.stringify(r.title)}` : ""}` : "an item"; };

  // the interpreter, and what each run sends back
  const dir = mkdtempSync(join(tmpdir(), "sagebrush-board-"));
  const outputs = new Map<string, any[]>(); // (Jupyter's outputs, as the notebook saves them)
  const kept = { run: 0 }; // (the bytes of output kept in all: collect)
  let ran = 0, worker: Worker | null = null, intr: Int32Array | null = null, dead: string | null = null;
  const sinks = new Map<number, (m: any) => void>();
  let nextId = 1;
  const workerErr: string[] = [];
  try {
    if (items.length) {
      worker = new Worker(require.main?.filename ?? process.argv[1], { workerData: { sagebrushBoardRun: { dir } }, stdout: true, stderr: true });
      worker.stdout.resume();
      worker.stderr.on("data", (b) => { if (workerErr.length < 100) workerErr.push(String(b)); });
      await new Promise<void>((resolve, reject) => {
        worker!.on("message", (m: any) => {
          if (m.ready) { intr = new Int32Array(m.$intr); return resolve(); }
          sinks.get(m.id)?.(m);
        });
        worker!.on("error", (e: any) => { dead = String(e?.message ?? e); reject(e); for (const f of [...sinks.values()]) f({ done: true, error: true, ms: 0, dead: true }); });
        worker!.on("exit", () => { dead ??= "the interpreter stopped"; for (const f of [...sinks.values()]) f({ done: true, error: true, ms: 0, dead: true }); });
      });
    }
    // (one run: code with its options; its messages to `on`; resolves when it is done)
    const send = (msg: any, on: (m: any) => void, limit = Infinity) => new Promise<{ ms: number; error: boolean; timedOut: boolean; dead: boolean; evaluated?: string }>((resolve) => {
      if (dead || !worker) return resolve({ ms: 0, error: true, timedOut: false, dead: true });
      const id = nextId++;
      let timedOut = false, timer: any = null, kill: any = null;
      sinks.set(id, (m) => {
        if (!m.done && !m.skipped) return on(m);
        sinks.delete(id);
        clearTimeout(timer);
        clearTimeout(kill);
        resolve({ ms: m.ms ?? 0, error: !!m.error || !!m.skipped, timedOut, dead: !!m.dead, ...(typeof m.evaluated === "string" ? { evaluated: m.evaluated } : {}) });
      });
      if (limit < Infinity && limit > 0) timer = setTimeout(() => {
        // over its time: interrupted (KeyboardInterrupt), and if it does not stop, the interpreter stopped
        timedOut = true;
        if (intr) { Atomics.store(intr, 1, id); Atomics.store(intr, 0, 1); }
        kill = setTimeout(() => { dead = `the interpreter was stopped: ${label(msg.cell)} did not stop when interrupted`; worker?.terminate(); }, 2000);
      }, limit);
      worker.postMessage({ id, code: msg.code, sage: mode === "sage", magma: mode === "magma", matlab: mode === "matlab", ...msg.opts });
    });
    const timedOut = new Set<string>();
    const syntax = new Map<string, string>(); // (syntax errors, as the interpreter says them)
    const states = new Map<string, CellState>(); // (each item's last state, as the scheduler says it)
    const analyses = new Map<string, Analysis>();
    const reactive = new Reactive({
      cells: () => items.map((it) => ({ id: it.key, code: it.code })),
      async analyze(code) {
        if (!analyses.has(code)) {
          let a: Analysis;
          try { a = analyzeCell(code, "c", { mode }); } catch (e: any) { a = { error: { kind: e instanceof ImportStarError ? "import-star" : "syntax", message: String(e?.message ?? e) } }; }
          analyses.set(code, a);
        }
        return analyses.get(code)!;
      },
      async execute(id, code, forget, scoped) {
        const list: any[] = [];
        outputs.set(id, list);
        const r = await send({ cell: id, code, opts: { forget, mangle: id.replace(/[^A-Za-z0-9]/g, ""), seed: seedOf(id), ...(scoped && Object.keys(scoped).length ? { scoped } : {}) } }, (m) => collect(list, m, kept), timeout * 1000);
        ran++;
        if (r.timedOut) timedOut.add(id);
        return { ok: !r.error, ms: r.ms, ...(r.timedOut ? { stopped: true, interrupted: true } : r.dead ? { stopped: true } : {}) };
      },
      forget: (names) => send({ code: "", opts: { forget: names } }, () => {}).then(() => {}),
      rename: async (q) => {
        try {
          const r = renameRedefinitions(q.cells, q.name, new Set(q.taken), mode, SCOPE_SEP);
          return r ? [...r] : null;
        } catch {
          return null;
        }
      },
      status: (id, st) => states.set(id, st),
    });
    const failed = new Set<string>(), cancelled = new Set<string>();
    const note = (r: RunReport) => { for (const id of r.failed) failed.add(id); for (const id of r.cancelled) cancelled.add(id); };
    if (items.length) {
      await reactive.load({ stale: true });
      note(await reactive.runAll());
      // (an item out of time stops the scheduler's run, as Stop does in a
      // notebook; the interpreter is still there: the others run, but not
      // what reads an item out of time)
      for (let round = 0; round < items.length && timedOut.size && !dead; round++) {
        const blocked = reactive.graph.closure([...timedOut]);
        const left = items.map((it) => it.key).filter((id) => !reactive.outcome.has(id) && !reactive.errors.has(id) && !blocked.has(id) && !cancelled.has(id));
        if (!left.length) break;
        const before = reactive.outcome.size;
        note(await reactive.run(left, { budget: Infinity }));
        if (reactive.outcome.size === before) break;
      }
      // (a syntax error: the interpreter says it, where, in the board's
      // language, as the notebook shows it; such code defines nothing)
      for (const { key: id, code } of items) {
        const errs = reactive.errors.get(id);
        if (!errs?.length || !errs.every((e) => e.kind === "syntax") || dead) continue;
        const list: any[] = [];
        await send({ cell: id, code, opts: { mangle: id.replace(/[^A-Za-z0-9]/g, ""), seed: seedOf(id) } }, (m) => collect(list, m, kept), timeout * 1000);
        const said = summary(list).stderr.trim();
        if (said) syntax.set(id, said);
      }
    }

    // each item: how it ended, its outputs, its error
    const late = items.length ? reactive.graph.closure([...timedOut]) : new Set<string>();
    for (const { key: id } of items) {
      const r = reports.get(id)!, list = outputs.get(id) ?? [];
      Object.assign(r, summary(list));
      const errs = reactive.errors.get(id);
      const ms = reactive.times.get(id);
      if (ms !== undefined && reactive.outcome.has(id)) r.ms = Math.round(ms);
      if (errs?.length) { r.status = "error"; r.error = syntax.get(id) ?? errs.map((e) => errorText(e, label, (n) => reactive.written(n))).join("\n"); r.stdout = r.stderr = ""; r.outputs = []; }
      else if (timedOut.has(id)) { r.status = "timeout"; r.error = `ran out of time: stopped after ${timeout} s` + (r.stderr ? "\n" + r.stderr : ""); }
      else if (reactive.outcome.get(id) === "ok" && !failed.has(id)) r.status = "ok";
      else if (failed.has(id) || reactive.outcome.get(id) === "exception") { r.status = "failed"; r.error = r.stderr.trim() || "raised an error"; }
      else {
        r.status = "not run";
        const st = states.get(id), by = st?.state === "cancelled" ? st : null;
        const slow = [...timedOut].find((t) => t !== id && late.has(id) && reactive.graph.closure([t]).has(id));
        r.error = slow ? `not run: ${label(slow)}, which it depends on, ran out of time` : by ? `not run: ${label(by.by)}, which it depends on, ${by.why === "exception" ? "raised an error" : by.why === "error" ? "has an error" : "was interrupted"}` : dead ? `not run: ${dead}` : cancelled.has(id) ? "not run: an item it depends on did not run" : "not run";
      }
    }

    const result: BoardRun = {
      mode, list: items.map(({ key }) => reports.get(key)!), items, reports, notes, outputs,
      fromRoot: (key) => (items.length ? reactive.fromRoot(key).ms : 0), times: reactive.times, dead, workerErr,
    };
    // (questions' checks and hints, in the interpreter the code ran in: `board try`)
    if (after) {
      if (!worker && !dead) {
        // (a board with no code items: an interpreter for its checks all the same)
        worker = new Worker(require.main?.filename ?? process.argv[1], { workerData: { sagebrushBoardRun: { dir } }, stdout: true, stderr: true });
        worker.stdout.resume();
        worker.stderr.on("data", (b) => { if (workerErr.length < 100) workerErr.push(String(b)); });
        await new Promise<void>((resolve, reject) => {
          worker!.on("message", (m: any) => { if (m.ready) { intr = new Int32Array(m.$intr); return resolve(); } sinks.get(m.id)?.(m); });
          worker!.on("error", (e: any) => { dead = String(e?.message ?? e); reject(e); });
          worker!.on("exit", () => { dead ??= "the interpreter stopped"; for (const f of [...sinks.values()]) f({ done: true, error: true, ms: 0, dead: true }); });
        });
      }
      let n = 0;
      await after(async (code, answer, ms) => {
        const r = await send({ cell: `check${++n}`, code: "", opts: { evaluate: { code, answer }, seed: seedOf("check") } }, () => {}, ms);
        if (r.timedOut) return { ok: false, error: `it ran out of time (${ms} ms)`, timedOut: true };
        if (r.dead || r.evaluated === undefined) return { ok: false, error: dead ?? "the interpreter stopped", timedOut: false };
        const v = JSON.parse(r.evaluated);
        return { ok: !!v.ok, ...(v.ok ? { value: v.value } : { error: String(v.error) }), isolated: v.isolated !== false, preserved: v.preserved ?? null, reason: typeof v.reason === "string" ? v.reason : null, timedOut: false };
      }, result);
    }
    return result;
  } finally {
    await worker?.terminate();
    rmSync(dir, { recursive: true, force: true });
  }
}

// The output kept: an item's at most ITEM_OUTPUT_MAX bytes, the run's at
// most RUN_OUTPUT_MAX; past them the rest is dropped as it comes, never
// kept, and said once (a loop printing faster than the item's timeout
// would otherwise fill the memory of the whole command, HARD-5DF-3).
export const ITEM_OUTPUT_MAX = 4 * 2 ** 20, RUN_OUTPUT_MAX = 32 * 2 ** 20;
// (and at most this many displays an item, each charged its envelope too:
// notebook-session.ts displayCost, HARD-58F-1)
export const ITEM_DISPLAYS_MAX = 10000;
const sizes = new WeakMap<any[], { used: number; cut: boolean; displays: number }>();

const CUT_WHY = { item: `${ITEM_OUTPUT_MAX / 2 ** 20} MB for this item`, run: `${RUN_OUTPUT_MAX / 2 ** 20} MB for the whole board`, displays: `${ITEM_DISPLAYS_MAX} displays for this item` };
const cutNote = (why: keyof typeof CUT_WHY) => ({ output_type: "stream", name: "stderr", text: `\n[output cut: past ${CUT_WHY[why]}; the rest was not kept]\n` });

// a run's messages, as the notebook keeps them (Jupyter's outputs): streams
// joined, displays as display_data, clear_output() as it says
function collect(list: any[], m: any, kept: { run: number }) {
  if (m.target != null) return; // (an @interact's own output area: shown when it is moved)
  const size = sizes.get(list) ?? { used: 0, cut: false, displays: 0 };
  sizes.set(list, size);
  if (m.clear) { kept.run -= size.used; size.used = 0; size.cut = false; size.displays = 0; list.length = 0; return; }
  // (the worker cut the rest where it was written)
  if (m.cut) {
    if (!size.cut) list.push(cutNote(m.cut in CUT_WHY ? m.cut : "item"));
    size.cut = true;
    return;
  }
  const bytes = m.stream ? String(m.text ?? "").length : m.display ? displayCost(m.display) : m.interact ? DISPLAY_ENVELOPE + JSON.stringify(m.interact).length : 0;
  if ((m.display || m.interact) && !size.cut && ++size.displays > ITEM_DISPLAYS_MAX) {
    size.cut = true;
    list.push(cutNote("displays"));
    return;
  }
  if (size.cut) return;
  if (size.used + bytes > ITEM_OUTPUT_MAX || kept.run + bytes > RUN_OUTPUT_MAX) {
    size.cut = true;
    list.push(cutNote(size.used + bytes > ITEM_OUTPUT_MAX ? "item" : "run"));
    return;
  }
  size.used += bytes;
  kept.run += bytes;
  if (m.stream) {
    const last = list[list.length - 1];
    if (last?.output_type === "stream" && last.name === m.stream) last.text += m.text;
    else list.push({ output_type: "stream", name: m.stream, text: m.text });
  } else if (m.display) list.push({ output_type: "display_data", data: m.display, metadata: {} });
  else if (m.interact) list.push({ output_type: "display_data", data: { "text/plain": "[interactive controls]" }, metadata: {} });
}

/** An output in a report's words: a figure as its size and what it shows
 * (and where it was saved); a picture of no known size as its kind and bytes. */
export function outputLine(o: ItemReport["outputs"][number]): string {
  const f = o.figure;
  if (f) {
    const size = f.w && f.h ? ` ${f.w}×${f.h}` : "";
    const title = f.title ? `: ${f.title.length > 200 ? f.title.slice(0, 200) + "…" : f.title}` : "";
    return `figure${size}${title}${f.path ? ` (saved ${oneLine(f.path)})` : ""}`;
  }
  return o.bytes ? `[${o.type}, ${Math.max(1, Math.round(o.bytes / 1024))} kB]` : o.text ?? "";
}

// A display's picture as a figure: an SVG's size (its width and height, or
// its viewBox) and title; a raster picture's size (image-size.ts).
const unescape = (s: string) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
function figureOf(type: string, data: string): Figure | null {
  if (type === "image/svg+xml") {
    const root = /<svg\b[^>]*>/.exec(data)?.[0] ?? "";
    const num = (name: string) => { const m = new RegExp(`\\b${name}="([\\d.]+)(px)?"`).exec(root); return m ? Math.round(Number(m[1])) : undefined; };
    let w = num("width"), h = num("height");
    const vb = /viewBox="[-\d.]+ [-\d.]+ ([\d.]+) ([\d.]+)"/.exec(root);
    if ((w === undefined || h === undefined) && vb) { w = Math.round(Number(vb[1])); h = Math.round(Number(vb[2])); }
    const t = /<title>([^<]*)<\/title>/.exec(data);
    return { ...(w && h ? { w, h } : {}), ...(t ? { title: unescape(t[1]) } : {}) };
  }
  if (/^image\/(png|jpeg|gif|webp)$/.test(type)) {
    const size = imageSize(type, data);
    return size ? { w: size.w, h: size.h } : {};
  }
  return null;
}
const EXT: Record<string, string> = { "image/svg+xml": "svg", "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };

/** Each item's figures written to dir (made if it isn't there), as
 * ITEM-1.svg and so on, never over a file that is there; each figure's
 * report then says where.  Why not, if it can't. */
export function saveFigures(run: BoardRun, dir: string): string | null {
  try {
    mkdirSync(dir, { recursive: true });
  } catch (e: any) {
    return `--figures: can't make ${oneLine(dir)}: ${oneLine(String(e?.code ?? e?.message ?? e))}`;
  }
  try {
    saveEach(run, dir);
  } catch (e: any) {
    return String(e?.message ?? e);
  }
  return null;
}
function saveEach(run: BoardRun, dir: string) {
  for (const { key } of run.items) {
    const r = run.reports.get(key)!;
    const pictures = (run.outputs.get(key) ?? []).filter((o: any) => o.output_type === "display_data").map((o: any) => Object.keys(o.data ?? {}).find((t) => t in EXT) ? o.data : null).filter(Boolean);
    const figs = r.outputs.filter((o) => o.figure);
    // (an item's id as a file's name: letters, digits, _ and -, and its page's mark)
    const base = key.replace(/[^\w-]+/g, "_").slice(0, 60) || "item";
    pictures.forEach((data: any, k: number) => {
      const type = Object.keys(data).find((t) => t in EXT)!, text = String(data[type]);
      let path: string, n = k + 1;
      do path = join(dir, `${base}-${n++}.${EXT[type]}`); while (existsSync(path));
      try {
        writeFileSync(path, type === "image/svg+xml" ? text : Buffer.from(text, "base64"), { flag: "wx" });
        if (figs[k]?.figure) figs[k].figure!.path = path;
      } catch (e: any) {
        throw new Error(`--figures: can't write ${oneLine(path)}: ${oneLine(String(e?.code ?? e?.message ?? e))}`);
      }
    });
  }
}

// stdout, stderr, and each display's text (or its kind and size)
function summary(list: any[]): Pick<ItemReport, "stdout" | "stderr" | "outputs"> {
  let stdout = "", stderr = "";
  const outputs: ItemReport["outputs"] = [];
  for (const o of list) {
    if (o.output_type === "stream") (o.name === "stderr" ? (stderr += o.text) : (stdout += o.text));
    else {
      const d = o.data ?? {}, text = d["text/plain"] ?? d["text/markdown"] ?? d["text/latex"];
      const other = Object.keys(d).find((t) => !t.startsWith("text/"));
      const figure = other ? figureOf(other, String(d[other])) : null;
      if (other && !/^text\/plain$/.test(other)) outputs.push({ type: other, bytes: String(d[other]).length, ...(typeof text === "string" ? { text } : {}), ...(figure ? { figure } : {}) });
      else if (typeof text === "string") outputs.push({ type: d["text/plain"] !== undefined ? "text/plain" : Object.keys(d)[0], text });
    }
  }
  return { stdout, stderr, outputs };
}

// (as the notebook says them, web/notebook/notebook.js errorText; items for cells)
function errorText(e: CellError, label: (id: string) => string, written: (n: string) => string): string {
  const list = (ids: string[]) => ids.map(label).join(", ").replace(/, ([^,]*)$/, " and $1");
  switch (e.kind) {
    case "multiple-definition":
      return e.reading
        ? `${written(e.name)} is defined by ${list(e.cells)}, so this item cannot tell which one it reads. Rename it in all but one of them.`
        : `${written(e.name)} is also defined by ${list(e.cells)}. A name read by other items can be defined by only one item: rename it in one of them, or start it with _ to keep it private to its item.`;
    case "cycle":
      return `${list(e.cells)} depend on each other in a cycle, so none of them can run first. Move a definition to break it.`;
    case "import-star":
      return `${e.message} Import the names you use (from m import a, b), or the module (import m).`;
    case "analyzer":
      return `This item could not be analyzed (${e.message}).`;
    default:
      return /^SyntaxError\b/.test(e.message) ? e.message : `SyntaxError: ${e.message}`;
  }
}

// (a display whose picture a preview can't hold here, an SVG plot: left
// out, its text too, which says only "<Figure ...>"; the board shows the
// picture once it runs)
const KEPT = /^image\/(png|jpeg|webp)$/;
const previewable = (list: any[]) => list.filter((o) => o.output_type !== "display_data" || !Object.keys(o.data ?? {}).some((t) => t.startsWith("image/")) || Object.keys(o.data).some((t) => KEPT.test(t)));

// A picture kept as it is, if it fits a preview (no canvas here to draw it smaller).
const keepRaster: Raster = async (src, maxWidth) => {
  const m = /^data:(image\/(?:png|jpeg|webp));base64,(.*)$/.exec(src);
  if (!m) return null;
  const s = imageSize(m[1], m[2]);
  return s && s.w <= maxWidth ? [m[1], m[2]] : null;
};

// The board's code notes by id, every page, in groups too.
function codeNotes(d: BoardDoc): Map<string, DocNote> {
  const out = new Map<string, DocNote>();
  const walk = (ns: DocNode[] | undefined) => {
    for (const n of ns ?? []) {
      if (n.kind === "group") walk(n.children);
      else if ((n.kind === undefined || n.kind === "note") && n.code !== undefined) out.set(n.id, n);
    }
  };
  for (let i = 0; i < pageCount(d); i++) walk(pageView(d, i).nodes);
  return out;
}

const indent = (s: string) => s.split("\n").map((l) => "       " + l).join("\n");
const cutLines = (s: string, max: number) => { const ls = s.split("\n"); return ls.length <= max ? s : [...ls.slice(0, max - 5), `… ${ls.length - max + 1} more lines …`, ...ls.slice(-4)].join("\n"); };
