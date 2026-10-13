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

export class BoardCode {
  /** resolves when the interpreter and the notebook are ready (false: they could not be loaded) */
  readonly ready: Promise<boolean>;
  /** a cell's output or state changed (the board lays itself out again) */
  onChange: (() => void) | null = null;
  /** the code highlighter (HTML), once the notebook is loaded */
  highlight: ((src: string) => string) | null = null;
  private nb: any = null;
  private watched = new WeakSet<Element>();
  private observer: MutationObserver | null = null;
  private pending = 0;

  constructor(private base: URL) {
    this.ready = this.start().then(() => true, (e) => {
      console.warn("board: code items cannot run here:", e);
      return false;
    });
  }

  private async start() {
    const mod = await import(new URL("sagebrush-notebook.js", this.base).href);
    // (Python in the runner, an opaque-origin sandboxed frame, as on the notebook page: design/runner.md)
    const runner = new URLSearchParams(location.search).get("runner") !== "0";
    const kernel = new mod.WorkerKernel({ createWorker: () => (runner ? new mod.RunnerWorker(new URL("runner/", this.base).href) : new Worker(new URL("sagebrush-worker.js", this.base), { type: "module" })) });
    kernel.start();
    // (the analyzer of the reactive notebook: a worker of its own, as on the notebook page)
    let worker: Worker | null = null, next = 0;
    const waiting = new Map<number, (m: any) => void>();
    const ask = (msg: any) => {
      if (!worker) {
        worker = new Worker(new URL("sagebrush-analyze.js", this.base), { type: "module" });
        worker.onmessage = (ev) => { const f = waiting.get(ev.data.id); waiting.delete(ev.data.id); f?.(ev.data); };
        worker.onerror = (e) => {
          worker?.terminate();
          worker = null;
          const ws = [...waiting.values()];
          waiting.clear();
          for (const f of ws) f({ error: { kind: "analyzer", message: e?.message || "the analyzer failed" }, sources: null });
        };
      }
      return new Promise<any>((resolve) => { const id = ++next; waiting.set(id, resolve); worker!.postMessage({ id, ...msg }); });
    };
    const analyzer = {
      analyze: (code: string, mode: string) => ask({ code, mode }),
      rename: (request: any) => ask({ rename: request }).then((r) => r.sources),
    };
    // (out of sight, but in the document: the notebook keeps only the output of a cell that is)
    const root = document.createElement("div");
    root.className = "board-code-engine";
    root.setAttribute("aria-hidden", "true");
    root.style.cssText = "position:absolute;left:-100000px;top:0;width:640px;";
    document.body.append(root);
    this.nb = mod.createNotebook(root, { kernel, reactive: true, analyzer, assetBase: new URL(".", this.base).href });
    this.nb.load({ mode: "python", cells: [], autorun: "always" });
    this.highlight = (src) => mod.highlight(src, this.mode === "sage");
    // (a cell's state is its element's class: queued, running, stale, error, cancelled)
    this.observer = new MutationObserver(() => this.changed());
    this.observer.observe(root, { attributes: true, attributeFilter: ["class"], subtree: true });
  }

  // (several changes at once, and many as output streams in: one layout; and
  // after a run, how it ended)
  private changed() {
    if (this.pending) return;
    this.pending = window.setTimeout(() => {
      this.pending = 0;
      this.onChange?.();
      // (and once more after anything was running or waiting: how a run
      // ended is not always a change the observers see)
      const busy = !!this.nb?.cells().some((c: any) => c.el.classList.contains("running") || c.el.classList.contains("queued"));
      if (busy || this.busy) window.setTimeout(() => this.changed(), 250);
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
      new MutationObserver(() => this.changed()).observe(c.out, { childList: true, subtree: true, characterData: true });
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
  sync(items: { id: string; code: string }[], mode: "python" | "sage" = "python"): Promise<string[]> {
    // (one after another: a sync sees what the one before it did)
    const p = this.last.then(() => this.syncNow(items, mode));
    this.last = p.catch(() => {});
    return p;
  }
  private last: Promise<unknown> = Promise.resolve();
  /** the board's language (BoardDoc.mode) */
  mode: "python" | "sage" = "python";
  private async syncNow(items: { id: string; code: string }[], mode: "python" | "sage"): Promise<string[]> {
    if (!(await this.ready)) return [];
    const nb = this.nb;
    const now = nb.cells().filter((c: any) => c.type === "code");
    const before = new Map<string, string>(now.map((c: any) => [c.id, c.ta.value]));
    // (another language: every item runs again, in it)
    const relang = mode !== this.mode;
    this.mode = mode;
    const changed = items.filter((it) => relang || before.get(it.id) !== it.code).map((it) => it.id);
    const same = now.length === items.length && items.every((it, i) => now[i].id === it.id);
    if (changed.length || !same) {
      nb.applyRemote({
        mode,
        cells: items.map((it) => {
          const c = this.cell(it.id);
          return { id: it.id, code: it.code, ...(c ? { outputs: nb.saveOutputs(c.out) } : {}) };
        }),
      }, false);
    }
    if (changed.length) await nb.runCells(changed).finally(() => this.changed());
    return changed;
  }

  /** Run these code items, then what depends on them (resolves to the reactive notebook's report). */
  async run(ids: string[]): Promise<any> {
    return (await this.ready) ? this.nb.runCells(ids).finally(() => this.changed()) : null;
  }
  async runAll(): Promise<any> {
    return (await this.ready) ? this.nb.runAll().finally(() => this.changed()) : null;
  }
  /** Resolves when what was asked for has run (syncs, and what they started). */
  async idle(): Promise<void> {
    await this.last;
    if (await this.ready) await this.nb.runCells([]);
  }
  interrupt() {
    this.nb?.interrupt();
  }
  /** A code item's output as text (pictures by their descriptions), for agents. */
  text(id: string): string {
    const c = this.cell(id);
    return c ? this.nb.outputText(c.out) : "";
  }
}
