// Code items on a board (design/board.md, "Running code"): Python run on
// one interpreter for the whole board, reactively, as a notebook's cells
// are.  The engine is the notebook component itself (web/notebook, loaded
// the first time a board has code): a notebook kept out of sight holds a
// cell per code item, in the board's reading order, and does everything a
// notebook does (the reactive scheduler, page-order scoping, the budget,
// stale marks, per-cell seeds, interacts, widgets, plots, math, 3D).  Each
// cell's output element is shown inside its code item on the board.

/** "": up to date; "error": cannot run (a syntax error, a name defined twice, a cycle); "failed": raised an exception; "cancelled": not run, as one it reads failed */
export type CodeState = "" | "queued" | "running" | "stale" | "error" | "failed" | "cancelled" | "interrupted";

/** Where a board's code engine comes from (design/engines.md): its notebook
 * module, the interpreter's worker, the reactive notebook's analyzer, and
 * where the notebook finds its assets (3D, math).  siteEngine(): the files
 * beside the page; a downloaded file's (engine.ts): bytes it carries or
 * fetches by the engine's id. */
export interface EngineParts {
  module(): Promise<any>;
  worker(mod: any): any;
  analyzer(): Worker;
  assets(): { assetBase?: string; assetUrl?: (name: string) => string | undefined };
}

/** The engine whose files are at `base` (sagebrush-notebook.js, the worker,
 * runner/): Python in the runner, an opaque-origin sandboxed frame
 * (design/runner.md), or with runner false, a plain worker. */
export function siteEngine(base: URL, runner = true): EngineParts {
  const plain = () => new Worker(new URL("sagebrush-worker.js", base), { type: "module" });
  return {
    module: () => import(new URL("sagebrush-notebook.js", base).href),
    worker: (mod) => (runner ? new mod.RunnerWorker(new URL("runner/", base).href, { fallback: plain }) : plain()),
    analyzer: () => new Worker(new URL("sagebrush-analyze.js", base)),
    assets: () => ({ assetBase: new URL(".", base).href }),
  };
}

import { PREVIEW_MS, makePreview, previewLabel, type Preview } from "./preview";

/** The seed of a board without one of its own (BoardDoc.seed). */
export const BOARD_SEED = "0".repeat(64);

export class BoardCode {
  /** resolves when the interpreter and the notebook are ready (false: they could not be loaded) */
  readonly ready: Promise<boolean>;
  /** a cell's output or state changed (the board lays itself out again) */
  onChange: (() => void) | null = null;
  /** why the engine could not start (ready resolved false) */
  error: string | null = null;
  /** the code highlighter (HTML), once the notebook is loaded */
  highlight: ((src: string) => string) | null = null;
  private nb: any = null;
  private watched = new WeakSet<Element>();
  private observer: MutationObserver | null = null;
  private pending = 0;

  private parts: EngineParts;

  /** @param engine the engine's parts, or where its files are (siteEngine(base, opts.runner)) */
  constructor(engine: URL | EngineParts, opts: { runner: boolean } = { runner: true }) {
    this.parts = engine instanceof URL ? siteEngine(engine, opts.runner) : engine;
    this.ready = this.start().then(() => true, (e) => {
      console.warn("board: code items cannot run here:", e);
      this.error = String(e?.message ?? e);
      return false;
    });
  }

  private async start() {
    const mod = await this.parts.module();
    if (this.closed) throw new Error("closed");
    const kernel = (this.kernel = new mod.WorkerKernel({ createWorker: () => this.parts.worker(mod) }));
    kernel.start();
    // (the analyzer of the reactive notebook: a worker of its own, as on the notebook page)
    let next = 0;
    const waiting = new Map<number, (m: any) => void>();
    const ask = (msg: any) => {
      if (this.closed) return Promise.resolve({ error: { kind: "analyzer", message: "closed" }, sources: null });
      if (!this.analyzer) {
        const worker = (this.analyzer = this.parts.analyzer());
        worker.onmessage = (ev) => { const f = waiting.get(ev.data.id); waiting.delete(ev.data.id); f?.(ev.data); };
        worker.onerror = (e) => {
          worker.terminate();
          if (this.analyzer === worker) this.analyzer = null;
          const ws = [...waiting.values()];
          waiting.clear();
          for (const f of ws) f({ error: { kind: "analyzer", message: e?.message || "the analyzer failed" }, sources: null });
        };
      }
      return new Promise<any>((resolve) => { const id = ++next; waiting.set(id, resolve); this.analyzer!.postMessage({ id, ...msg }); });
    };
    const analyzer = {
      analyze: (code: string, mode: string) => ask({ code, mode }),
      rename: (request: any) => ask({ rename: request }).then((r) => r.sources),
    };
    // (out of sight, but in the document: the notebook keeps only the output of a cell that is)
    const root = (this.root = document.createElement("div"));
    root.className = "board-code-engine";
    root.setAttribute("aria-hidden", "true");
    root.style.cssText = "position:absolute;left:-100000px;top:0;width:640px;";
    document.body.append(root);
    this.nb = mod.createNotebook(root, { kernel, reactive: true, analyzer, ...this.parts.assets() });
    this.nb.load({ mode: "python", cells: [], autorun: "always" });
    this.highlight = (src) => mod.highlight(src, this.mode === "sage");
    // (a cell's state is its element's class: queued, running, stale, error, cancelled)
    this.observer = new MutationObserver(() => this.changed());
    this.observer.observe(root, { attributes: true, attributeFilter: ["class"], subtree: true });
  }

  // (several changes at once, and many as output streams in: one layout; and
  // after a run, how it ended)
  private changed() {
    if (this.pending || this.closed) return;
    this.pending = window.setTimeout(() => {
      this.pending = 0;
      this.onChange?.();
      // (and once more after anything was running or waiting: how a run
      // ended is not always a change the observers see)
      const busy = !!this.nb?.cells().some((c: any) => c.el.classList.contains("running") || c.el.classList.contains("queued"));
      if ((busy || this.busy) && !this.closed) window.setTimeout(() => this.changed(), 250);
      this.busy = busy;
    }, 60);
  }
  private busy = false;

  private cell(id: string): any {
    return this.nb?.cells().find((c: any) => c.id === id) ?? null;
  }

  /** A code item's output element (shown in its item; a copy for printing and measuring). */
  output(id: string, copy = false): HTMLElement | null {
    const c = this.cell(id);
    if (!c) return null;
    if (!this.watched.has(c.out)) {
      this.watched.add(c.out);
      // (its size, not its every change: a 3D view rewrites its labels every
      // frame as it turns, and the board is laid out again only for a size)
      const o = new ResizeObserver(() => this.changed());
      o.observe(c.out);
      this.outputs.push(o);
    }
    return copy ? (c.out.cloneNode(true) as HTMLElement) : c.out;
  }

  /** As the notebook tells agents (its graph()): running, waiting, or how its last run ended. */
  state(id: string): CodeState {
    const c = this.cell(id);
    if (!c) return "";
    const cls = c.el.classList, end = this.nb.reactive?.outcome?.get(id);
    return cls.contains("running") ? "running" : cls.contains("queued") ? "queued" : cls.contains("error") ? "error"
      : end === "cancelled" || cls.contains("cancelled") ? "cancelled" : cls.contains("stale") ? "stale"
      : end === "exception" ? "failed" : end === "stopped" ? "interrupted" : "";
  }

  /**
   * The board's code items, in reading order: the notebook's cells become
   * them (matched by id, outputs kept; a moved item, or a deleted one,
   * changes what others read: those rerun), and the new ones and those whose
   * code changed run, then what depends on them.  Resolves to the ids run.
   */
  sync(items: { id: string; code: string; preview?: Preview }[], mode: "python" | "sage" = "python", seed?: string): Promise<string[]> {
    // (one after another: a sync sees what the one before it did)
    const p = this.last.then(() => this.syncNow(items, mode, seed ?? BOARD_SEED));
    this.last = p.catch(() => {});
    return p;
  }
  private last: Promise<unknown> = Promise.resolve();
  /** the board's language (BoardDoc.mode) */
  mode: "python" | "sage" = "python";
  /** the board's seed (BoardDoc.seed) */
  seed = BOARD_SEED;
  private async syncNow(items: { id: string; code: string; preview?: Preview }[], mode: "python" | "sage", seed: string): Promise<string[]> {
    if (!(await this.ready)) return [];
    const nb = this.nb;
    const now = nb.cells().filter((c: any) => c.type === "code");
    const before = new Map<string, string>(now.map((c: any) => [c.id, c.ta.value]));
    // (another language or seed: every item runs again, in it)
    const relang = mode !== this.mode || seed !== this.seed;
    this.mode = mode;
    this.seed = seed;
    const changed = items.filter((it) => relang || before.get(it.id) !== it.code).map((it) => it.id);
    const same = now.length === items.length && items.every((it, i) => now[i].id === it.id);
    // items new here with a preview (a slow item's output, kept in the file:
    // preview.ts): shown, as stale, and not run, nor what reads them, until
    // someone runs them: manual cells until then.  (Items already here, in
    // another language or with another seed, all run.)
    const held = items.filter((it) => it.preview && !before.has(it.id));
    if (relang) for (const id of [...this.held]) if (before.has(id)) this.held.delete(id);
    for (const it of held) this.held.add(it.id);
    // (an item held whose code changed: run, as any edit)
    for (const id of changed) if (!held.some((it) => it.id === id)) this.held.delete(id);
    if (changed.length || !same) {
      nb.applyRemote({
        mode,
        seed,
        cells: items.map((it) => {
          const c = this.cell(it.id);
          const manual = this.held.has(it.id) ? { metadata: { sagebrush: { manual: true } } } : {};
          if (held.includes(it)) return { id: it.id, code: it.code, outputs: it.preview!.outputs, ms: it.preview!.ms, ...manual };
          return { id: it.id, code: it.code, ...(c ? { outputs: nb.saveOutputs(c.out) } : {}), ...manual };
        }),
      }, false);
    }
    for (const it of held) {
      const c = this.cell(it.id);
      if (c) c.out.dataset.preview = previewLabel(it.preview!);
    }
    if (!changed.length) return changed;
    let report: any;
    if (held.length && nb.reactive) {
      // (every item registered, those not changed kept as they are; then the
      // others run, but not what reads a held one, which would run it)
      await nb.reactive.load({ stale: true, fresh: new Set(items.filter((it) => !changed.includes(it.id)).map((it) => it.id)) });
      const blocked: Set<string> = nb.reactive.graph.closure(held.map((it) => it.id));
      report = await nb.runCells(changed.filter((id) => !blocked.has(id))).finally(() => this.changed());
    } else report = await nb.runCells(changed).finally(() => this.changed());
    this.ran(report);
    return changed;
  }

  /** items shown with their previews, not run yet (manual cells until they are) */
  private held = new Set<string>();
  /** Items about to run on request (all: run all): the held ones among them, above and below them, are held no longer. */
  private release(ids: string[] | null) {
    if (!this.held.size) return;
    const g = this.nb.reactive?.graph;
    const near = ids && g ? new Set<string>([...g.closure(ids), ...g.closure(ids, { children: false })]) : null;
    for (const id of [...this.held]) {
      if (near && !near.has(id)) continue;
      this.held.delete(id);
      const c = this.cell(id);
      if (c) this.nb.setManual(c, false);
    }
  }
  /** Called with the items that ran, after each run (sync, ▶, run all). */
  onRan: ((ids: string[]) => void) | null = null;
  private ran(report: any) {
    const ids: string[] = Array.isArray(report?.ran) ? report.ran : [];
    for (const id of ids) {
      const c = this.cell(id);
      if (c) delete c.out.dataset.preview;
    }
    if (ids.length) this.onRan?.(ids);
  }
  /** an item over this many ms from root keeps a preview (preview.ts) */
  previewMs = PREVIEW_MS;
  /**
   * Previews of these items' outputs as they are now: an item over previewMs
   * from root, its preview; under it, null (it needs none).  Absent: an item
   * whose output is not one to keep (running, interrupted, a widget moved).
   */
  async previews(ids: string[]): Promise<Map<string, Preview | null>> {
    const out = new Map<string, Preview | null>();
    if (!(await this.ready)) return out;
    const keys = await this.nb.outputKeys();
    for (const id of ids) {
      const c = this.cell(id), k = keys?.[id], state = this.state(id);
      if (!c || !k || k.widget || (state !== "" && state !== "failed")) continue;
      out.set(id, k.fromRoot > this.previewMs ? await makePreview(this.nb.saveOutputs(c.out), { at: new Date().toISOString(), ms: k.ms ?? 0, total: k.fromRoot }) : null);
    }
    return out;
  }

  /** Run these code items, then what depends on them (resolves to the reactive notebook's report). */
  async run(ids: string[]): Promise<any> {
    if (!(await this.ready)) return null;
    this.release(ids);
    const report = await this.nb.runCells(ids).finally(() => this.changed());
    this.ran(report);
    return report;
  }
  async runAll(): Promise<any> {
    if (!(await this.ready)) return null;
    this.release(null);
    const report = await this.nb.runAll().finally(() => this.changed());
    this.ran(report);
    return report;
  }
  /** Resolves when what was asked for has run (syncs, and what they started). */
  async idle(): Promise<void> {
    await this.last;
    if (await this.ready) await this.nb.runCells([]);
  }
  interrupt() {
    this.nb?.interrupt();
  }
  /** Stop for good (the board is unmounted): the notebook, the interpreter
   * (its worker, or the runner's frame), the analyzer, the observers, the
   * element kept out of sight. */
  close() {
    this.closed = true;
    clearTimeout(this.pending);
    this.pending = 0;
    this.observer?.disconnect();
    for (const o of this.outputs.splice(0)) o.disconnect();
    this.nb?.destroy();
    this.nb = null;
    this.kernel?.close();
    this.kernel = null;
    this.analyzer?.terminate();
    this.analyzer = null;
    this.root?.remove();
    this.root = null;
  }
  private closed = false;
  private kernel: any = null;
  private analyzer: Worker | null = null;
  private root: HTMLElement | null = null;
  private outputs: ResizeObserver[] = [];
  /** Each code item's output key, time from root and whether a widget moved
   * since it ran (design/outputs.md; the notebook's outputKeys()). */
  async outputKeys(): Promise<Record<string, { key: string | null; ms: number | null; fromRoot: number; untimed: number; widget: boolean }> | null> {
    if (!(await this.ready)) return null;
    await this.last;
    return this.nb.outputKeys();
  }
  /** A code item's output as text (pictures by their descriptions), for agents. */
  text(id: string): string {
    const c = this.cell(id);
    return c ? this.nb.outputText(c.out) : "";
  }
}
