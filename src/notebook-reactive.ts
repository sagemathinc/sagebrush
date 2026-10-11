// The reactive notebook's scheduler (design/reactive-notebook.md): what runs
// when a cell is run, edited, added or deleted, in which order, and what is
// stale.  Pure logic behind a small host interface, so that it is tested
// without a browser (test/notebook-reactive.test.ts); web/notebook/notebook.js
// is its host in the page.
//
// marimo's semantics (marimo/_runtime/runtime.py mutate_graph and
// runner/cell_runner.py, Apache-2.0, see NOTICE.md):
//
//   - The graph holds each cell's code as last submitted (run), not as being
//     edited.  Running cells registers their code; cells that were children
//     of a changed cell, and cells whose errors went away, must run too.
//   - Errors (multiple definitions, cycles, syntax) are reported on the
//     cells just submitted, and on previously valid cells only if they are
//     downstream of one: a new cell redefining `x` does not break the cell
//     that defined it first ("no action at a distance").
//   - Running a cell first runs its stale ancestors; then its descendants,
//     in topological order with ties in page order.
//   - Before a cell runs, the names it defined are deleted from the
//     interpreter, so a definition removed from the code really disappears.
//   - A cell that raises cancels its descendants in the run; they wait for it.
//
// Ours besides (each in design/reactive-notebook.md):
//
//   - The budget: cells run automatically (descendants, not the cells asked
//     for) only while their predicted and actual time stays under it.  The
//     rest are marked stale.  Infinity is marimo's autorun, 0 its lazy mode.
//   - Manual cells never run automatically.
//   - #1477: a name several cells define, while no cell reads it, is not an
//     error (src/notebook-graph.ts); when its definers drop to one, that
//     cell reruns, so the value is its own.
//   - A run can mutate several cells at once (an agent's batch of edits) and
//     then runs once.
import { NotebookGraph, type CellError, type GraphCell } from "./notebook-graph";
import type { CellAnalysis } from "./dataflow";

export type Analysis = CellAnalysis | { error: CellError };

export interface CellInfo {
  id: string;
  /** the code now in the editor */
  code: string;
  /** never run automatically */
  manual?: boolean;
}

export type CellState =
  | { state: "queued" }
  | { state: "running" }
  | { state: "done"; ok: boolean; ms: number }
  | { state: "stale"; why: "budget" | "manual" | "ancestor" | "loaded" | "restart" | "interrupted" }
  | { state: "cancelled"; by: string; why: "exception" | "error" | "interrupted" }
  | { state: "error"; errors: CellError[] };

export interface ReactiveHost {
  /** the code cells, in page order */
  cells(): CellInfo[];
  /** a cell's code analyzed (the host may cache by code) */
  analyze(code: string): Promise<Analysis>;
  /**
   * Run a cell's code after deleting the global names `forget`; `ok` false
   * if it raised, `stopped` if it was interrupted or the interpreter
   * restarted.
   */
  execute(id: string, code: string, forget: string[]): Promise<{ ok: boolean; ms: number; stopped?: boolean }>;
  /** delete global names now (a cell deleted or broken) */
  forget(names: string[]): Promise<void>;
  /** a cell's state changed */
  status(id: string, s: CellState): void;
}

export interface RunReport {
  /** the cells that ran, in order */
  ran: string[];
  /** cells left stale (budget, manual, interrupted) */
  stale: string[];
  /** cells that raised */
  failed: string[];
  /** cells that did not run because an ancestor raised or has an error */
  cancelled: string[];
  /** cells with errors that keep them out of the graph's runs */
  errors: Record<string, CellError[]>;
}

interface Registered {
  code: string;
  analysis?: CellAnalysis;
  error?: CellError;
}

export class Reactive {
  /** the cells' code as last submitted (the graph's) */
  private registered = new Map<string, Registered>();
  graph = new NotebookGraph();
  /** cells whose errors are shown (and keep them from running) */
  errors = new Map<string, CellError[]>();
  stale = new Set<string>();
  /** each cell's last run time (ms), for the budget's prediction */
  times = new Map<string, number>();
  /** how each cell's last run ended */
  outcome = new Map<string, "ok" | "exception" | "stopped">();
  /** ms of automatic runs allowed after an action; Infinity = autorun, 0 = lazy */
  budget = 2000;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private host: ReactiveHost) {}

  /** The code the graph has for a cell (undefined: never submitted). */
  submitted(id: string): string | undefined {
    return this.registered.get(id)?.code;
  }

  /**
   * Take the notebook as it is, as when it is opened: every cell's code is
   * registered and, if `stale`, marked stale (its outputs, if any, are from
   * another session).  Nothing runs.
   */
  load(opts: { stale?: boolean } = {}): Promise<RunReport> {
    return this.serial(async () => {
      const cells = this.host.cells();
      await this.registerAll(cells.map((c) => c.id), cells);
      this.errors = new Map(this.graph.errors);
      for (const [id, errors] of this.errors) this.host.status(id, { state: "error", errors });
      if (opts.stale ?? true) for (const c of cells) if (!this.errors.has(c.id)) this.markStale(c.id, "loaded");
      return this.report([], [], [], []);
    });
  }

  /** The interpreter restarted: every cell is stale. */
  restarted(): void {
    this.outcome.clear();
    for (const id of this.graph.ids) if (!this.errors.has(id)) this.markStale(id, "restart");
  }

  /**
   * Run cells (their code as now in the editor) and delete others, as one
   * action: then their stale ancestors, and their descendants within the
   * budget.  `budget` overrides the notebook's for this action (an agent
   * wanting everything up to date: Infinity).
   */
  run(ids: string[], opts: { remove?: string[]; budget?: number; all?: boolean } = {}): Promise<RunReport> {
    return this.serial(() => this.mutateAndRun(ids, opts.remove ?? [], opts.budget ?? this.budget, !!opts.all));
  }

  /** Delete cells (already gone from the page): their names go, and the cells reading them rerun. */
  remove(ids: string[]): Promise<RunReport> {
    return this.run([], { remove: ids });
  }

  /** Run every cell, in graph order, whatever the budget. */
  runAll(): Promise<RunReport> {
    return this.serial(() => this.mutateAndRun(this.host.cells().map((c) => c.id), [], Infinity, true));
  }

  /** Cells moved: only the order of ties changes. */
  reordered(): void {
    const order = this.host.cells().map((c) => c.id);
    this.graph.set(order.filter((id) => this.registered.has(id)).map((id) => this.graphCell(id)));
  }

  /** The stale cells, in run order, and their predicted time. */
  staleSummary(): { cells: string[]; ms: number } {
    const cells = this.graph.order(this.stale);
    return { cells, ms: cells.reduce((s, id) => s + (this.times.get(id) ?? 0), 0) };
  }

  // ---------------------------------------------------------------------

  private serial<T>(f: () => Promise<T>): Promise<T> {
    const p = this.queue.then(f, f);
    this.queue = p.catch(() => {});
    return p;
  }

  private graphCell(id: string): GraphCell {
    const r = this.registered.get(id)!;
    return { id, code: r.code, analysis: r.analysis, error: r.error };
  }

  private async registerAll(ids: string[], cells: CellInfo[]): Promise<void> {
    const byId = new Map(cells.map((c) => [c.id, c]));
    for (const id of ids) {
      const c = byId.get(id);
      if (!c) continue;
      const prev = this.registered.get(id);
      if (prev && prev.code === c.code) continue;
      const a = await this.host.analyze(c.code);
      this.registered.set(id, "error" in a ? { code: c.code, error: a.error } : { code: c.code, analysis: a });
    }
    this.graph.set(cells.filter((c) => this.registered.has(c.id)).map((c) => this.graphCell(c.id)));
  }

  private defsOf(id: string): string[] {
    return [...(this.registered.get(id)?.analysis?.defs ?? [])];
  }

  private markStale(id: string, why: Extract<CellState, { state: "stale" }>["why"]): void {
    this.stale.add(id);
    this.host.status(id, { state: "stale", why });
  }

  private report(ran: string[], stale: string[], failed: string[], cancelled: string[]): RunReport {
    return { ran, stale, failed, cancelled, errors: Object.fromEntries(this.errors) };
  }

  private async mutateAndRun(ids: string[], remove: string[], budget: number, all: boolean): Promise<RunReport> {
    const cells = this.host.cells();
    const present = new Set(cells.map((c) => c.id));
    ids = ids.filter((id) => present.has(id));
    const before = new Set(this.graph.ids);
    const errorsBefore = new Set(this.errors.keys());
    const definersBefore = new Map([...this.graph.definers].map(([n, ds]) => [n, ds.length]));
    // children of the cells whose registration changes, before it does
    const oldChildren = new Set<string>();
    const forgetNow = new Set<string>();
    const changed = new Set<string>();
    for (const id of ids) {
      const prev = this.registered.get(id);
      if (!prev || prev.code === cells.find((c) => c.id === id)!.code) continue;
      changed.add(id);
      for (const c of this.graph.children(id)) oldChildren.add(c);
      // its old names go (unless it had an error, and so never ran this code)
      if (!this.errors.has(id)) for (const n of this.defsOf(id)) forgetNow.add(n);
    }
    for (const id of remove) {
      if (!this.registered.has(id)) continue;
      changed.add(id);
      for (const c of this.graph.children(id)) oldChildren.add(c);
      if (!this.errors.has(id)) for (const n of this.defsOf(id)) forgetNow.add(n);
      this.registered.delete(id);
      this.stale.delete(id);
      this.times.delete(id);
      this.outcome.delete(id);
    }
    for (const id of ids) if (!this.registered.has(id)) changed.add(id);
    await this.registerAll(ids, cells.filter((c) => present.has(c.id)));
    // registering may have dropped cells no longer on the page
    for (const id of [...this.registered.keys()]) if (!present.has(id)) this.registered.delete(id);
    this.graph.set(cells.filter((c) => this.registered.has(c.id)).map((c) => this.graphCell(c.id)));
    const inGraph = new Set(this.graph.ids);

    // errors: kept on previously valid cells only downstream of a submitted one
    const submitted = new Set(ids);
    const downstream = this.graph.closure(submitted);
    const errors = new Map<string, CellError[]>();
    const keepAlive = new Set<string>();
    for (let [id, es] of this.graph.errors) {
      // reading a name another cell made ambiguous is an error only for a cell just run
      if (!submitted.has(id) && !errorsBefore.has(id)) es = es.filter((e) => !(e.kind === "multiple-definition" && e.reading));
      if (!es.length) continue;
      const previouslyValid = before.has(id) && !submitted.has(id) && !errorsBefore.has(id);
      if (previouslyValid && !downstream.has(id)) {
        for (const n of this.defsOf(id)) keepAlive.add(n);
        continue;
      }
      errors.set(id, es);
    }
    for (const id of errorsBefore) if (!inGraph.has(id)) errorsBefore.delete(id);
    this.errors = errors;
    // a cell with an error has no state: its names go, except those a valid cell defines
    for (const id of errors.keys()) {
      if (!errorsBefore.has(id) && before.has(id) && !changed.has(id)) for (const n of this.defsOf(id)) if (!keepAlive.has(n)) forgetNow.add(n);
      this.stale.delete(id);
      this.host.status(id, { state: "error", errors: errors.get(id)! });
    }
    // names another valid cell still defines, as it last ran (#1477's write-only names), stay
    for (const n of [...forgetNow]) if ((this.graph.definers.get(n) ?? []).some((d) => !changed.has(d) && !errors.has(d))) forgetNow.delete(n);
    if (forgetNow.size) await this.host.forget([...forgetNow]);

    const noLongerErrors = [...errorsBefore].filter((id) => !errors.has(id) && inGraph.has(id));
    const transitioned = [...errors.keys()].filter((id) => !errorsBefore.has(id) && before.has(id));
    const roots = new Set(ids.filter((id) => !errors.has(id)));
    const auto = new Set<string>([...oldChildren, ...noLongerErrors]);
    for (const id of transitioned) for (const c of this.graph.children(id)) if (!errors.has(c)) auto.add(c);
    // #1477: a name whose definers dropped to one: that one reruns
    for (const [n, k] of definersBefore) {
      const ds = this.graph.definers.get(n);
      if (k > 1 && ds?.length === 1 && !errors.has(ds[0])) auto.add(ds[0]);
    }
    for (const id of [...auto]) if (!inGraph.has(id) || roots.has(id) || errors.has(id)) auto.delete(id);

    // what runs: the roots and their stale ancestors; then, automatically,
    // everything downstream of them and of `auto`
    const required = new Set(roots);
    for (const a of this.graph.closure(roots, { children: false, inclusive: false })) {
      if (this.stale.has(a) && !errors.has(a)) required.add(a);
    }
    const downstreamAll = this.graph.closure([...required, ...auto]);
    const optional = [...downstreamAll].filter((id) => !required.has(id) && !errors.has(id));
    return this.execute(required, optional, budget, all);
  }

  private async execute(required: Set<string>, optional: string[], budget: number, all: boolean): Promise<RunReport> {
    const manual = new Set(this.host.cells().filter((c) => c.manual).map((c) => c.id));
    // optional cells not run: manual ones, and everything downstream of them
    const held = new Set<string>();
    for (const id of optional) if (manual.has(id) && !all) for (const d of this.graph.closure([id])) if (!required.has(d)) held.add(d);
    let auto = optional.filter((id) => !held.has(id));
    const predicted = auto.reduce((s, id) => s + (this.times.get(id) ?? 0), 0);
    // (budget 0, lazy: nothing runs automatically)
    if (!all && (budget <= 0 || predicted > budget)) {
      for (const id of auto) held.add(id);
      auto = [];
    }
    const order = this.graph.order([...required, ...auto]);
    const ran: string[] = [], failed: string[] = [], cancelled: string[] = [];
    const stale = new Set<string>();
    for (const id of held) {
      stale.add(id);
      this.markStale(id, manual.has(id) ? "manual" : budget <= 0 || predicted > budget ? "budget" : "ancestor");
    }
    for (const id of order) this.host.status(id, { state: "queued" });
    const blockedBy = new Map<string, { by: string; why: "exception" | "error" | "interrupted" }>();
    let autoMs = 0;
    let stopped = false;
    const forgetLater: string[] = [];
    for (const id of order) {
      const isAuto = !required.has(id);
      if (stopped || (isAuto && !all && autoMs > budget)) {
        stale.add(id);
        this.markStale(id, stopped ? "interrupted" : "budget");
        continue;
      }
      // waiting for an ancestor: one that raised in this run (or before, and not rerun), or has an error
      let block = blockedBy.get(id);
      if (!block) {
        for (const p of this.graph.parents(id)) {
          if (this.errors.has(p)) block = { by: p, why: "error" };
          else if (!order.includes(p) && this.outcome.get(p) === "exception") block = { by: p, why: "exception" };
          else if (!order.includes(p) && this.outcome.get(p) === "stopped") block = { by: p, why: "interrupted" };
          else if (stale.has(p)) {
            stale.add(id);
            this.markStale(id, "ancestor");
            block = undefined;
            break;
          }
          if (block) break;
        }
        if (stale.has(id)) continue;
      }
      if (block) {
        cancelled.push(id);
        this.cancelDescendants(id, block, blockedBy, order);
        this.outcome.delete(id);
        forgetLater.push(...this.defsOf(id));
        this.host.status(id, { state: "cancelled", ...block });
        continue;
      }
      this.host.status(id, { state: "running" });
      const r = await this.host.execute(id, this.registered.get(id)!.code, this.defsOf(id));
      ran.push(id);
      this.stale.delete(id);
      this.times.set(id, r.ms);
      if (isAuto) autoMs += r.ms;
      if (r.stopped) {
        this.outcome.set(id, "stopped");
        stopped = true;
        this.host.status(id, { state: "done", ok: false, ms: r.ms });
        continue;
      }
      this.outcome.set(id, r.ok ? "ok" : "exception");
      this.host.status(id, { state: "done", ok: r.ok, ms: r.ms });
      if (!r.ok) {
        failed.push(id);
        this.cancelDescendants(id, { by: id, why: "exception" }, blockedBy, order);
      }
    }
    if (forgetLater.length) await this.host.forget(forgetLater);
    return this.report(ran, [...stale], failed, cancelled);
  }

  private cancelDescendants(id: string, block: { by: string; why: "exception" | "error" | "interrupted" }, blockedBy: Map<string, typeof block>, order: string[]): void {
    for (const d of this.graph.closure([id], { inclusive: false })) if (order.includes(d) && !blockedBy.has(d)) blockedBy.set(d, block);
  }
}
