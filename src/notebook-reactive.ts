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
//     for) only while their time fits in it: in graph order, a cell runs if
//     its last run time fits in what is left, and otherwise waits, stale,
//     with the cells below it.  Infinity is marimo's autorun, 0 its lazy mode.
//   - Manual cells never run automatically.
//   - #1477: a name several cells define, while no cell reads it, is not an
//     error (src/notebook-graph.ts); when its definers drop to one, that
//     cell reruns, so the value is its own.
//   - A run can mutate several cells at once (an agent's batch of edits) and
//     then runs once.
//   - Mutation tracking: a cell mutating another's object runs with its
//     family (the definer, then the updaters in page order), and the readers
//     after them (src/notebook-graph.ts).
//   - Files: the files each run read and wrote give writer-to-reader edges;
//     readers of a file just written, or changed outside (filesChanged), rerun.
//   - Page-order scoping (with host.rename): a name defined by several cells
//     and read is, for each cell, its nearest definition above it, as when a
//     Jupyter notebook is read from the top.  The code that runs is renamed
//     (x, xʹ2, xʹ3, ...: SCOPE_SEP), so each definition is its own variable
//     and the graph stays exact; the page shows the code as written.
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
  // (submitted: the cell was just run, so a syntax error can be shown by running it)
  | { state: "error"; errors: CellError[]; submitted?: boolean };

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
  execute(id: string, code: string, forget: string[]): Promise<{ ok: boolean; ms: number; stopped?: boolean; files?: { reads: string[]; writes: string[] } }>;
  /** delete global names now (a cell deleted or broken) */
  forget(names: string[]): Promise<void>;
  /** a cell's state changed */
  status(id: string, s: CellState): void;
  /**
   * Page-order scoping (optional): the new sources giving `name` one
   * defining cell, each later definition renamed (src/rename.ts
   * renameRedefinitions, with SCOPE_SEP), or null if it cannot be done.
   */
  rename?(request: { name: string; cells: { id: string; code: string; defines: boolean; reads: boolean }[]; taken: string[] }): Promise<[string, string][] | null>;
}

/** The separator of page-order scoping's names: `xʹ2` (U+02B9, a letter Python allows in names). */
export const SCOPE_SEP = "\u02b9";
/** A name as written (without page-order scoping's suffix). */
export const written = (name: string) => name.replace(/\u02b9\d+$/, "");

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
  /** the code as written and submitted */
  source: string;
  /** the code that runs: the source with page-order scoping's renames */
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
  /** the files each cell read and wrote in its last run */
  files = new Map<string, { reads: string[]; writes: string[] }>();
  /** ms of automatic runs allowed after an action; Infinity = autorun, 0 = lazy */
  budget = 2000;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(readonly host: ReactiveHost) {}

  /** The code the graph has for a cell, as written (undefined: never submitted). */
  submitted(id: string): string | undefined {
    return this.registered.get(id)?.source;
  }
  /** The code that runs for a cell (page-order scoping's renames applied). */
  effective(id: string): string | undefined {
    return this.registered.get(id)?.code;
  }

  /**
   * Take the notebook as it is, as when it is opened: every cell's code is
   * registered and, if `stale`, marked stale (its outputs, if any, are from
   * another session).  Nothing runs.
   */
  load(opts: { stale?: boolean; fresh?: Set<string> } = {}): Promise<RunReport> {
    return this.serial(async () => {
      const cells = this.host.cells();
      await this.registerAll(new Map(cells.map((c) => [c.id, c.code])), cells);
      this.errors = new Map(this.graph.errors);
      for (const [id, errors] of this.errors) this.host.status(id, { state: "error", errors });
      if (opts.stale ?? true) for (const c of cells) if (!this.errors.has(c.id) && !opts.fresh?.has(c.id)) this.markStale(c.id, "loaded");
      return this.report([], [], [], []);
    });
  }

  /**
   * The notebook's language changed: every cell is analyzed again (in it)
   * and stale.
   */
  reset(): Promise<RunReport> {
    this.registered.clear();
    this.errors.clear();
    this.stale.clear();
    this.outcome.clear();
    this.files.clear();
    this.graph = new NotebookGraph();
    return this.load({ stale: true });
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

  /**
   * Cells moved (or deleted elsewhere): the order of ties changes, and with
   * page-order scoping, which definition a cell reads: those rerun.
   */
  reordered(): Promise<RunReport> {
    return this.serial(() => this.mutateAndRun([], [], this.budget, false));
  }

  /** Files changed outside the cells (an upload): the cells that read them rerun, within the budget. */
  filesChanged(paths: string[]): Promise<RunReport> {
    return this.serial(async () => {
      const readers = new Set(paths.flatMap((p) => this.graph.readersOf(p)).filter((id) => !this.errors.has(id)));
      if (!readers.size) return this.report([], [], [], []);
      const optional = [...this.graph.closure(readers)].filter((id) => !this.errors.has(id));
      return this.execute(new Set(), optional, this.budget, false);
    });
  }

  /**
   * Values changed outside the cells (widgets moved: their global names):
   * the cells reading them rerun, within the budget, except `exclude` (the
   * cell showing the widgets).
   */
  namesChanged(names: string[], exclude: string[] = []): Promise<RunReport> {
    return this.serial(async () => {
      const readers = this.graph.ids.filter((id) => !exclude.includes(id) && !this.errors.has(id) && names.some((n) => this.registered.get(id)?.analysis?.refs.has(n)));
      if (!readers.length) return this.report([], [], [], []);
      const optional = [...this.graph.closure(readers)].filter((id) => !exclude.includes(id) && !this.errors.has(id));
      return this.execute(new Set(), optional, this.budget, false);
    });
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
  /** A cell's analysis of its code as written (for display and export: no scoping renames). */
  async writtenAnalysis(id: string): Promise<CellAnalysis | null> {
    const r = this.registered.get(id);
    if (!r) return null;
    const a = await this.host.analyze(r.source);
    return "error" in a ? null : a;
  }

  // Register these sources (id -> code as written, in page order), with
  // their effective code; the graph is rebuilt.
  private async registerAll(sources: Map<string, string>, cells: CellInfo[], eff?: Map<string, string>): Promise<void> {
    eff ??= await this.effectiveCodes(sources);
    for (const [id, source] of sources) {
      const code = eff.get(id) ?? source;
      const prev = this.registered.get(id);
      if (prev && prev.code === code) {
        prev.source = source;
        continue;
      }
      const a = await this.host.analyze(code);
      this.registered.set(id, "error" in a ? { source, code, error: a.error } : { source, code, analysis: a });
    }
    this.graph.set(cells.filter((c) => this.registered.has(c.id)).map((c) => this.graphCell(c.id)));
  }

  // Page-order scoping: the code each cell runs.  A name defined by several
  // cells (not all the same import) and read by one is renamed in the later
  // definitions and the cells reading them; names that cannot be renamed
  // keep their multiple-definition error.
  private async effectiveCodes(sources: Map<string, string>): Promise<Map<string, string>> {
    const eff = new Map(sources);
    if (!this.host.rename || sources.size < 2) return eff;
    const an = new Map<string, CellAnalysis>();
    for (const [id, code] of sources) {
      const a = await this.host.analyze(code);
      if (!("error" in a)) an.set(id, a);
    }
    const definers = new Map<string, string[]>(), readers = new Set<string>(), taken = new Set<string>();
    for (const [id, a] of an) {
      for (const n of a.defs) (definers.get(n) ?? definers.set(n, []).get(n)!).push(id);
      for (const n of a.refs) readers.add(n);
      for (const n of [...a.defs, ...a.refs]) taken.add(n);
    }
    const conflicts = [...definers].filter(([n, ds]) => {
      if (ds.length < 2 || !readers.has(n)) return false;
      const what = ds.map((d) => an.get(d)!.imports?.get(n));
      return !(what[0] !== undefined && what.every((w) => w === what[0]));
    }).map(([n]) => n).sort();
    for (const name of conflicts) {
      const cells = [...sources.keys()].map((id) => ({ id, code: eff.get(id)!, defines: !!an.get(id)?.defs.has(name), reads: !!an.get(id)?.refs.has(name) }));
      const r = await this.host.rename({ name, cells, taken: [...taken] });
      if (!r) continue;
      for (const [id, code] of r) {
        eff.set(id, code);
      }
      for (let k = 2; k <= cells.length + 1; k++) taken.add(name + SCOPE_SEP + k);
    }
    return eff;
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
    // the names whose objects changed or deleted cells mutated
    const oldMutations = new Set<string>();
    // cells deleted elsewhere (no longer on the page) go as removed ones do
    for (const id of this.registered.keys()) if (!present.has(id) && !remove.includes(id)) remove = [...remove, id];
    // the sources after this action, in page order, and the code each runs
    const sources = new Map<string, string>();
    for (const c of cells) {
      if (remove.includes(c.id)) continue;
      if (ids.includes(c.id)) sources.set(c.id, c.code);
      else if (this.registered.has(c.id)) sources.set(c.id, this.registered.get(c.id)!.source);
    }
    const eff = await this.effectiveCodes(sources);
    // (cells whose code to run changed though they were not run: page-order scoping)
    const rescoped = new Set<string>();
    for (const [id, prev] of this.registered) {
      if (!sources.has(id) || ids.includes(id) || prev.code === eff.get(id)) continue;
      rescoped.add(id);
    }
    for (const id of [...ids, ...rescoped]) {
      const prev = this.registered.get(id);
      if (!prev || prev.code === eff.get(id)) continue;
      changed.add(id);
      for (const c of this.graph.children(id)) oldChildren.add(c);
      for (const n of prev.analysis?.mutations ?? []) oldMutations.add(n);
      // its old names go (unless it had an error, and so never ran this code)
      if (!this.errors.has(id)) for (const n of this.defsOf(id)) forgetNow.add(n);
    }
    for (const id of remove) {
      if (!this.registered.has(id)) continue;
      changed.add(id);
      for (const c of this.graph.children(id)) oldChildren.add(c);
      for (const n of this.registered.get(id)!.analysis?.mutations ?? []) oldMutations.add(n);
      if (!this.errors.has(id)) for (const n of this.defsOf(id)) forgetNow.add(n);
      this.registered.delete(id);
      this.stale.delete(id);
      this.times.delete(id);
      this.outcome.delete(id);
      this.files.delete(id);
    }
    for (const id of ids) if (!this.registered.has(id)) changed.add(id);
    await this.registerAll(sources, cells.filter((c) => present.has(c.id)), eff);
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
      this.host.status(id, { state: "error", errors: errors.get(id)!, ...(submitted.has(id) ? { submitted: true } : {}) });
    }
    // names another valid cell still defines, as it last ran (#1477's write-only names), stay
    for (const n of [...forgetNow]) if ((this.graph.definers.get(n) ?? []).some((d) => !changed.has(d) && !errors.has(d))) forgetNow.delete(n);
    if (forgetNow.size) await this.host.forget([...forgetNow]);

    const noLongerErrors = [...errorsBefore].filter((id) => !errors.has(id) && inGraph.has(id));
    const transitioned = [...errors.keys()].filter((id) => !errorsBefore.has(id) && before.has(id));
    const roots = new Set(ids.filter((id) => !errors.has(id)));
    const auto = new Set<string>([...oldChildren, ...noLongerErrors, ...rescoped]);
    for (const id of transitioned) for (const c of this.graph.children(id)) if (!errors.has(c)) auto.add(c);
    // #1477: a name whose definers dropped to one: that one reruns
    for (const [n, k] of definersBefore) {
      const ds = this.graph.definers.get(n);
      if (k > 1 && ds?.length === 1 && !errors.has(ds[0])) auto.add(ds[0]);
    }
    for (const id of [...auto]) if (!inGraph.has(id) || roots.has(id) || errors.has(id)) auto.delete(id);

    // mutation tracking: an updater (a cell mutating another's object) runs
    // with its family: the definer first, then every updater, in page order,
    // so that a mutation is never applied twice.  Also when an updater's
    // code changed or it was deleted (its old mutations are undone).
    const families = (names: Iterable<string>, into: Set<string>) => {
      for (const n of names) {
        const ds = (this.graph.definers.get(n) ?? []).filter((d) => !errors.has(d));
        if (ds.length !== 1) continue;
        into.add(ds[0]);
        for (const u of this.graph.updatersOf.get(n) ?? []) if (!errors.has(u)) into.add(u);
      }
    };
    families([...roots].flatMap((id) => [...(this.registered.get(id)?.analysis?.mutations ?? [])]), roots);
    families(oldMutations, roots.size ? roots : auto);
    for (const id of [...auto]) if (roots.has(id)) auto.delete(id);

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

  private async execute(required: Set<string>, optional: string[], budget: number, all: boolean, followAgain = false): Promise<RunReport> {
    const manual = new Set(this.host.cells().filter((c) => c.manual).map((c) => c.id));
    // optional cells not run: manual ones, and everything downstream of them
    const held = new Set<string>();
    for (const id of optional) if (manual.has(id) && !all) for (const d of this.graph.closure([id])) if (!required.has(d)) held.add(d);
    const auto = optional.filter((id) => !held.has(id));
    const order = this.graph.order([...required, ...auto]);
    const ran: string[] = [], failed: string[] = [], cancelled: string[] = [];
    const stale = new Set<string>();
    for (const id of held) {
      stale.add(id);
      this.markStale(id, manual.has(id) ? "manual" : "ancestor");
    }
    for (const id of order) this.host.status(id, { state: "queued" });
    const blockedBy = new Map<string, { by: string; why: "exception" | "error" | "interrupted" }>();
    // the budget: in graph order, each automatic cell runs if its last time
    // still fits in what is left (a cell never run counts as 0); one that does
    // not waits, stale, with the cells below it (budget 0, lazy: none run)
    let autoMs = 0;
    let stopped = false;
    const forgetLater: string[] = [];
    const followUp = new Set<string>();
    for (const id of order) {
      const isAuto = !required.has(id);
      if (stopped) {
        stale.add(id);
        this.markStale(id, "interrupted");
        continue;
      }
      if (isAuto && !all && (budget <= 0 || autoMs + (this.times.get(id) ?? 0) > budget) && ![...this.graph.parents(id)].some((p) => stale.has(p))) {
        stale.add(id);
        this.markStale(id, "budget");
        continue;
      }
      // waiting for an ancestor: one that raised in this run (or before, and not rerun), or has an error
      let block = blockedBy.get(id);
      if (!block) {
        for (const p of this.graph.parents(id)) {
          if (this.errors.has(p) && this.suppliesOnly(p, id)) block = { by: p, why: "error" };
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
      // files: what it read and wrote this time; a file it wrote, read by
      // cells not in this run, makes them run after it (within the budget)
      const io = r.files ?? { reads: [], writes: [] };
      const prevIo = this.files.get(id);
      if (io.reads.length || io.writes.length || prevIo) {
        if (io.reads.length || io.writes.length) this.files.set(id, io);
        else this.files.delete(id);
        this.graph.setFiles(this.files);
        for (const f of io.writes) for (const reader of this.graph.readersOf(f)) {
          if (reader !== id && !order.includes(reader) && !this.errors.has(reader)) followUp.add(reader);
        }
      }
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
    // readers of files written in this run (once: a writer they lead back to is not rerun)
    if (followUp.size && !stopped && !followAgain) {
      const more = [...this.graph.closure(followUp)].filter((id) => !ran.includes(id) && !this.errors.has(id));
      const r2 = await this.execute(new Set(), more, all ? Infinity : Math.max(0, budget - autoMs), all, true);
      return this.report([...ran, ...r2.ran], [...new Set([...stale, ...r2.stale])], [...failed, ...r2.failed], [...cancelled, ...r2.cancelled]);
    }
    return this.report(ran, [...stale], failed, cancelled);
  }

  // Whether a cell with an error is the only definer of a name `id` reads
  // (else, as a second definition, it takes nothing from it).
  private suppliesOnly(p: string, id: string): boolean {
    const refs = this.registered.get(id)?.analysis?.refs;
    for (const n of this.defsOf(p)) {
      if (!refs?.has(n)) continue;
      if (!(this.graph.definers.get(n) ?? []).some((d) => d !== p && !this.errors.has(d))) return true;
    }
    return false;
  }

  private cancelDescendants(id: string, block: { by: string; why: "exception" | "error" | "interrupted" }, blockedBy: Map<string, typeof block>, order: string[]): void {
    for (const d of this.graph.closure([id], { inclusive: false })) if (order.includes(d) && !blockedBy.has(d)) blockedBy.set(d, block);
  }
}
