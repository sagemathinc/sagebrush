// A document's code run as a reactive notebook runs it, without a browser (plan L1b r4b §2, step 2a): one interpreter
// (src/notebook-session.ts in a worker thread, the one `sagebrush board run` starts: cli.ts boardRunWorker, spawned by
// its workerData), and the notebook's own scheduler over the document's cells (src/notebook-reactive.ts: the graph from
// analyzeCell, page-order scoping by rename, a cell that raises cancelling what reads it, the budget). Used by
// `sagebrush latex run` (step 2b); `sagebrush board run` adopts it next (step 2c, @sagebrush's condition), so the two
// keep one semantics; until then test/reactive-session.test.ts runs the shared fixtures through both. The messages are
// board-run's (#532's cycleText, with the cells' noun, when it lands).
//
// The interpreter's rules are board-run's, as reviewed there: at most START_GRACE_MS to start and to warm up; an item's
// time from when the interpreter begins it (or, absolute, from when it is posted); over it, interrupted
// (KeyboardInterrupt), and the interpreter stopped 2 s later if it doesn't stop; a stopped interpreter runs nothing more.
// The code runs here, as you, as `sagebrush -c` runs it.
import { Worker } from "worker_threads";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { sessionLimits } from "./limits";
import { requestCtrlC } from "./runtime/interrupt";
import { Reactive, SCOPE_SEP, type Analysis, type CellState, type RunReport } from "./notebook-reactive";
import type { CellError } from "./notebook-graph";
import { analyzeCell, ImportStarError } from "./dataflow";
import { renameRedefinitions } from "./rename";

export type Mode = "python" | "sage" | "magma" | "matlab";
/** what one run sent back: its time, whether it raised, ran out of time, or found the interpreter stopped */
export interface Sent { ms: number; error: boolean; timedOut: boolean; dead: boolean; evaluated?: string }

const START_GRACE_MS = 60_000;
const clamp = (ms: number) => Math.min(ms, 2 ** 31 - 1);

export interface Interpreter {
  /** one run: code with its options; its messages (outputs) to `on`; resolves when it is done */
  send(msg: { cell: string; code: string; opts?: Record<string, unknown> }, on: (m: any) => void, limitMs?: number, absolute?: boolean): Promise<Sent>;
  /** why the interpreter stopped, if it did */
  dead(): string | null;
  /** its stderr, the first lines */
  err: string[];
  close(): Promise<void>;
}

/** The interpreter in a worker thread of this process's own bundle (`entry`: by default the script running), in a
 * directory of its own, warmed up. `label` names a cell in what it says when one is stopped. */
export async function startInterpreter(o: { mode: Mode; entry?: string; label?: (cell: string) => string }): Promise<Interpreter> {
  const dir = mkdtempSync(join(tmpdir(), "sagebrush-run-"));
  const label = o.label ?? ((c: string) => c);
  const sinks = new Map<number, (m: any) => void>();
  const err: string[] = [];
  let dead: string | null = null, intr: Int32Array | null = null, nextId = 1;
  const worker = new Worker(o.entry ?? require.main?.filename ?? process.argv[1], { workerData: { sagebrushBoardRun: { dir }, sagebrushLimits: sessionLimits() }, stdout: true, stderr: true });
  worker.stdout?.resume();
  worker.stderr?.on("data", (b) => { if (err.length < 100) err.push(String(b)); });
  await new Promise<void>((resolve) => {
    const late = setTimeout(() => { dead ??= `the interpreter did not start within ${START_GRACE_MS / 1000} s`; void worker.terminate(); resolve(); }, START_GRACE_MS);
    worker.on("message", (m: any) => {
      if (m.ready) { clearTimeout(late); intr = new Int32Array(m.$intr); return resolve(); }
      sinks.get(m.id)?.(m);
    });
    worker.on("error", (e: any) => { dead = String(e?.message ?? e); resolve(); for (const f of [...sinks.values()]) f({ done: true, error: true, ms: 0, dead: true }); });
    worker.on("exit", () => { dead ??= "the interpreter stopped"; resolve(); for (const f of [...sinks.values()]) f({ done: true, error: true, ms: 0, dead: true }); });
  });
  const send: Interpreter["send"] = (msg, on, limit = Infinity, absolute = false) => new Promise<Sent>((resolve) => {
    if (dead) return resolve({ ms: 0, error: true, timedOut: false, dead: true });
    const id = nextId++;
    let timedOut = false, timer: any = null, kill: any = null, started = false;
    sinks.set(id, (m) => {
      if (m.start && limit < Infinity && limit > 0 && !started && !absolute && !timedOut) { started = true; clearTimeout(timer); timer = setTimeout(over, clamp(limit)); }
      if (!m.done && !m.skipped) return on(m);
      sinks.delete(id);
      clearTimeout(timer);
      clearTimeout(kill);
      resolve({ ms: m.ms ?? 0, error: !!m.error || !!m.skipped, timedOut, dead: !!m.dead, ...(typeof m.evaluated === "string" ? { evaluated: m.evaluated } : {}) });
    });
    const over = () => {
      timedOut = true;
      if (intr) { Atomics.store(intr, 1, id); requestCtrlC(intr); }
      kill = setTimeout(() => { dead = `the interpreter was stopped: ${label(msg.cell)} did not stop when interrupted`; void worker.terminate(); }, 2000);
    };
    if (limit < Infinity && limit > 0) timer = setTimeout(over, absolute ? clamp(limit) : START_GRACE_MS);
    worker.postMessage({ id, code: msg.code, sage: o.mode === "sage", magma: o.mode === "magma", matlab: o.mode === "matlab", ...(msg.opts ?? {}) });
  });
  // (warmed up first, untimed but for START_GRACE_MS: its parser, Sage's one-time load, its first imports)
  if (!dead) await send({ cell: "warm-up", code: "" }, () => {}, START_GRACE_MS, true);
  return {
    send, dead: () => dead, err,
    close: async () => { await worker.terminate(); rmSync(dir, { recursive: true, force: true }); },
  };
}

export interface Cell { key: string; code: string }
export interface CellsRun {
  reactive: Reactive;
  /** each cell's last state, as the scheduler said it */
  states: Map<string, CellState>;
  failed: Set<string>;
  cancelled: Set<string>;
  timedOut: Set<string>;
  /** a syntax error as the interpreter says it */
  syntax: Map<string, string>;
  /** each cell's error, in words (the notebook's: a cycle, a name defined twice, syntax), for those with one */
  errors: Map<string, string>;
}

/** The cells run as the reactive notebook runs them, in this interpreter. Two explicit behaviours (@sagebrush's
 * ruling on daybreak3's #557 HOLD), never one implicit: `only: [N]`, N and its stale ancestors, nothing after (`latex
 * run --item N`); `descendantsWithinMs` added, also its descendants within that autorun budget, by each one's last
 * measured time (`lastMs`), a slower one left stale (the editor's Run). Neither given: all. Each run's messages go to
 * `onMessage`.
 * `seedOf` gives each cell's seed; `timeoutMs` an item's time. `noun` names cells in the errors ("item", "block"). */
export async function runCells(interp: Interpreter, cells: Cell[], o: { mode: Mode; seedOf: (key: string) => string; timeoutMs: number; onMessage: (key: string, m: any) => void; only?: string[]; descendantsWithinMs?: number; lastMs?: Map<string, number>; label?: (key: string) => string; noun?: string }): Promise<CellsRun> {
  const timedOut = new Set<string>(), syntax = new Map<string, string>(), states = new Map<string, CellState>();
  const analyses = new Map<string, Analysis>();
  // (the cells actually sent to the interpreter in this run: a cancelled one never was)
  const executed = new Set<string>();
  const mangle = (id: string) => id.replace(/[^A-Za-z0-9]/g, "");
  const reactive = new Reactive({
    cells: () => cells.map((c) => ({ id: c.key, code: c.code })),
    async analyze(code) {
      if (!analyses.has(code)) {
        let a: Analysis;
        try { a = analyzeCell(code, "c", { mode: o.mode }); } catch (e: any) { a = { error: { kind: e instanceof ImportStarError ? "import-star" : "syntax", message: String(e?.message ?? e) } }; }
        analyses.set(code, a);
      }
      return analyses.get(code)!;
    },
    async execute(id, code, forget, scoped) {
      executed.add(id);
      const r = await interp.send({ cell: id, code, opts: { forget, mangle: mangle(id), seed: o.seedOf(id), ...(scoped && Object.keys(scoped).length ? { scoped } : {}) } }, (m) => o.onMessage(id, m), o.timeoutMs);
      if (r.timedOut) timedOut.add(id);
      return { ok: !r.error, ms: r.ms, ...(r.timedOut ? { stopped: true, interrupted: true } : r.dead ? { stopped: true } : {}) };
    },
    forget: (names) => interp.send({ cell: "forget", code: "", opts: { forget: names } }, () => {}).then(() => {}),
    rename: async (q) => {
      try { const r = renameRedefinitions(q.cells, q.name, new Set(q.taken), o.mode, SCOPE_SEP); return r ? [...r] : null; } catch { return null; }
    },
    status: (id, st) => states.set(id, st),
  });
  // (each cell's last measured time, for the budget: from an earlier run, the results file's)
  for (const [k, ms] of o.lastMs ?? []) if (Number.isFinite(ms) && ms >= 0) reactive.times.set(k, ms);
  const failed = new Set<string>(), cancelled = new Set<string>();
  const note = (r: RunReport) => { for (const id of r.failed) failed.add(id); for (const id of r.cancelled) cancelled.add(id); };
  if (cells.length) {
    await reactive.load({ stale: true });
    const budget = o.only ? o.descendantsWithinMs ?? 0 : Infinity;
    // (each cell's predicted time, as the budget counts it: its last measured time before this run)
    const predicted = new Map(reactive.times);
    note(o.only ? await reactive.run(o.only, { budget }) : await reactive.runAll());
    // (a cell out of time stops the scheduler's run, as Stop does in a notebook; the interpreter is still there: the
    //  others run, but not what reads a cell out of time. With `only`, what was asked; with descendantsWithinMs, also
    //  its descendants that weren't reached, each within the budget by its last time, in page order: one that timed
    //  out stays stale, the independent ones after it still run (daybreak3's DB3-RS-3))
    const asked = new Set(o.only ?? cells.map((c) => c.key));
    const optional = o.only && budget > 0 ? reactive.graph.closure(o.only, { inclusive: false }) : new Set<string>();
    // (the budget is one for the whole Run: what the descendants actually run took, by their predicted times, the one
    //  out of time too and a cancelled one not, is spent, and each retry has only what is left: daybreak3's DB3-RS-3)
    let spent = 0;
    for (const id of optional) if (executed.has(id)) spent += predicted.get(id) ?? 0;
    for (let round = 0; round < cells.length && timedOut.size && !interp.dead(); round++) {
      const blocked = reactive.graph.closure([...timedOut]);
      const left = cells.map((c) => c.key).filter((id) => (asked.has(id) || optional.has(id)) && !reactive.outcome.has(id) && !reactive.errors.has(id) && !blocked.has(id) && !cancelled.has(id))
        .filter((id) => { if (asked.has(id)) return true; const t = predicted.get(id) ?? 0; if (spent + t > budget) return false; spent += t; return true; });
      if (!left.length) break;
      const before = reactive.outcome.size;
      note(await reactive.run(left, { budget: Math.max(0, budget - spent) }));
      if (reactive.outcome.size === before) break;
    }
    // (a syntax error: the interpreter says it, where, in the document's language; such code defines nothing)
    for (const { key: id, code } of cells) {
      const errs = reactive.errors.get(id);
      if (!errs?.length || !errs.every((e) => e.kind === "syntax") || interp.dead()) continue;
      let said = "";
      await interp.send({ cell: id, code, opts: { mangle: mangle(id), seed: o.seedOf(id) } }, (m) => { if (m.output_type === "stream" && m.name === "stderr" && said.length < 65536) said += m.text; else if (m.stream === "stderr" && typeof m.text === "string" && said.length < 65536) said += m.text; }, o.timeoutMs);
      if (said.trim()) syntax.set(id, said.trim());
    }
  }
  const label = o.label ?? ((k: string) => k), noun = o.noun ?? "cell";
  const errors = new Map<string, string>();
  for (const { key: id } of cells) {
    const errs = reactive.errors.get(id);
    if (errs?.length) errors.set(id, syntax.get(id) ?? errs.map((e) => errorText(e, label, (n) => reactive.written(n), noun)).join("\n"));
  }
  return { reactive, states, failed, cancelled, timedOut, syntax, errors };
}

// (as the notebook says them, web/notebook/notebook.js errorText; with the document's word for its cells)
function errorText(e: CellError, label: (id: string) => string, written: (n: string) => string, noun: string): string {
  const list = (ids: string[]) => ids.map(label).join(", ").replace(/, ([^,]*)$/, " and $1");
  switch (e.kind) {
    case "multiple-definition":
      return e.reading
        ? `${written(e.name)} is defined by ${list(e.cells)}, so this ${noun} cannot tell which one it reads. Rename it in all but one of them.`
        : `${written(e.name)} is also defined by ${list(e.cells)}. A name read by other ${noun}s can be defined by only one ${noun}: rename it in one of them, or start it with _ to keep it private to its ${noun}.`;
    case "cycle":
      // (#532 makes this notebook-graph.ts cycleText(e, label, written, noun), with its fix in words: taken when it lands)
      return `${list(e.cells)} depend on each other in a cycle, so none of them can run first. Move a definition to break it.`;
    case "import-star":
      return e.message;
    case "analyzer":
      return `This ${noun} could not be analyzed (${e.message}).`;
    default:
      return /^SyntaxError\b/.test(e.message) ? e.message : `SyntaxError: ${e.message}`;
  }
}
