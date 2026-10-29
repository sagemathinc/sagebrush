// Code items on a board (design/board.md, "Running code"): Python run on
// one interpreter for the whole board, reactively, as a notebook's cells
// are.  The engine is the notebook component itself (web/notebook, loaded
// the first time a board has code): a notebook kept out of sight holds a
// cell per code item, in the board's reading order, and does everything a
// notebook does (the reactive scheduler, page-order scoping, the budget,
// stale marks, per-cell seeds, interacts, widgets, plots, math, 3D).  Each
// cell's output element is shown inside its code item on the board.  The
// board's language (BoardDoc.mode: Python, Sage, Magma or MATLAB) is the
// notebook's.

import type { BoardMode } from "./doc";

/** "": up to date; "error": cannot run (a syntax error, a name defined twice, a cycle); "failed": raised an exception; "cancelled": not run, as one it reads failed */
export type CodeState = "" | "queued" | "running" | "stale" | "error" | "failed" | "cancelled" | "interrupted";
/** A question's check, or a computed hint, as run (BoardCode.exclusive): its value, or why it has none. */
export interface Evaluated { ok: boolean; value?: unknown; error?: string; timedOut?: boolean; undecided?: boolean }
/** What a Check is given to run (BoardCode.exclusive). */
export interface CheckOps { evaluate: (code: string, answer: unknown, ms: number, by?: number) => Promise<Evaluated>; refresh: (ms: number) => Promise<boolean> }

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
import { CACHE_MS, DOC_CAP, ENTRY_MAX, cachedLabel, sizeOf, type CachedOutputs, type OutputCache } from "./outcache";
import { within } from "./idb-open";

/** The seed of a board without one of its own (BoardDoc.seed). */
export const BOARD_SEED = "0".repeat(64);

// (how long a read of the outputs' cache may take before the items run anyway)
const CACHE_READ_MS = 2000;
/** How long an interpreter may take to start, or its analyzer to answer,
 * before it is started (asked) again, once (40 s; a test may set less). */
const startMs = () => Number((globalThis as any).__sbEngineStartMs) || 40_000;
/** Whether the kernel is ready within `ms`; `waits` holds its cancel
 * (false at once, its listener and timer gone), for close(), HARD-9BB-1. */
function started(kernel: any, ms: number, waits: Set<() => void>): Promise<boolean> {
  if (kernel.ready) return Promise.resolve(true);
  return new Promise((resolve) => {
    const done = (ok: boolean) => { clearTimeout(t); off(); waits.delete(cancel); resolve(ok); };
    const cancel = () => done(false);
    const off = kernel.on("ready", () => done(true));
    const t = setTimeout(() => done(!!kernel.ready), ms);
    waits.add(cancel);
  });
}

/** What an interpreter's completions may hold: no more names, nor longer, nor more text in all (daybreak2's HARD-CH-1). */
export const COMPLETION_LIMITS = { matches: 5_000, name: 256, total: 200_000 } as const; // (numpy's and Sage's names fit: dir(numpy) has some 600)
/** An interpreter's answer to { complete: before }, taken only within
 * COMPLETION_LIMITS and as the contract says: a prefix that ends `before`,
 * names that each begin with it.  Anything else is refused (null: Tab then
 * does nothing), never kept in part. */
export function admitCompletion(m: unknown, before: string): { matches: string[]; prefix: string } | null {
  if (!m || typeof m !== "object") return null;
  const { matches, prefix } = m as { matches?: unknown; prefix?: unknown };
  if (!Array.isArray(matches) || matches.length > COMPLETION_LIMITS.matches) return null;
  if (typeof prefix !== "string" || prefix.length > before.length || !before.endsWith(prefix)) return null;
  let total = 0;
  for (const x of matches) {
    if (typeof x !== "string" || x.length > COMPLETION_LIMITS.name || !x.startsWith(prefix)) return null;
    if ((total += x.length) > COMPLETION_LIMITS.total) return null;
  }
  return { matches: matches.slice(), prefix };
}

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
  constructor(engine: URL | EngineParts, private opts: { runner?: boolean; observeRunner?: (kernel: any, mod: any) => () => void } = { runner: true }) {
    this.parts = engine instanceof URL ? siteEngine(engine, opts.runner ?? true) : engine;
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
    this.stopRunnerInfo = this.opts.observeRunner?.(kernel, mod);
    kernel.start();
    // (the analyzer of the reactive notebook: a worker of its own, as on the notebook page)
    let next = 0;
    // (each question: who settles it, and the worker it was asked of)
    const waiting = this.asks;
    // (an analyzer that doesn't answer in time: its worker never started, or
    // hung: a new one is asked again, once; then the cell says so, rather
    // than the board waiting for good)
    const ask = (msg: any, again = false): Promise<any> => {
      if (this.closed) return Promise.resolve({ error: { kind: "analyzer", message: "closed" }, sources: null });
      if (!this.analyzer) {
        const worker = (this.analyzer = this.parts.analyzer());
        // (a worker answers, or fails, only its own questions: one replaced
        // after a deadline can't settle its successor's, HARD-9BB-1)
        worker.onmessage = (ev) => { const q = waiting.get(ev.data?.id); if (!q || q.w !== worker) return; waiting.delete(ev.data.id); q.settle(ev.data); };
        worker.onerror = (e) => {
          worker.terminate();
          if (this.analyzer === worker) this.analyzer = null;
          for (const [id, q] of [...waiting]) if (q.w === worker) { waiting.delete(id); q.settle({ error: { kind: "analyzer", message: e?.message || "the analyzer failed" }, sources: null }); }
        };
      }
      return new Promise<any>((resolve) => {
        const id = ++next, w = this.analyzer!;
        const timer = setTimeout(() => {
          if (!waiting.delete(id)) return;
          if (this.analyzer === w) { w.terminate(); this.analyzer = null; }
          resolve(again || this.closed ? { error: { kind: "analyzer", message: `the analyzer did not answer in ${startMs() / 1000} s` }, sources: null } : ask(msg, true));
        }, startMs());
        waiting.set(id, { w, settle: (d) => { clearTimeout(timer); resolve(d); } });
        w.postMessage({ id, ...msg });
      });
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
    if (this.pictures) this.nb.usePictures?.(this.pictures);
    this.highlight = (src) => (this.mode === "matlab" ? mod.highlightMatlab(src) : mod.highlight(src, this.mode === "sage"));
    // (a cell's state is its element's class: queued, running, stale, error, cancelled)
    this.observer = new MutationObserver(() => this.changed());
    this.observer.observe(root, { attributes: true, attributeFilter: ["class"], subtree: true });
    // (the interpreter started: else, after startMs(), started again, once;
    // still not ready, it can't run here, and says so, rather than every
    // run, idle() and outputs() waiting for good: its worker's script was
    // seen never to load, test-export on a busy VM)
    // (closed meanwhile: not ready, and nothing started again, HARD-9BB-1)
    const ok = await started(kernel, startMs(), this.waits);
    if (this.closed) throw new Error("closed");
    if (!ok) {
      kernel.restart("\nThe interpreter did not start, and was started again.\n");
      const again = await started(kernel, startMs(), this.waits);
      if (this.closed) throw new Error("closed");
      if (!again) throw new Error(`the interpreter did not start in ${(2 * startMs()) / 1000} s`);
    }
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
  sync(items: { id: string; code: string; preview?: Preview }[], mode: BoardMode = "python", seed?: string): Promise<string[]> {
    // (one after another: a sync sees what the one before it did)
    return this.queued(() => this.syncNow(items, mode, seed ?? BOARD_SEED));
  }
  // (syncs and runs one after another: a sync, its language's interpreter
  // among what it changes, never during a run, CORR-79B-2)
  private last: Promise<unknown> = Promise.resolve();
  private queued<T>(f: () => Promise<T>): Promise<T> {
    const p = this.last.then(f);
    this.last = p.catch(() => {});
    return p;
  }
  /** whether the interpreter has been given anything to run (since it started) */
  private started = false;
  /** the board's language (BoardDoc.mode) */
  mode: BoardMode = "python";
  /** the board's seed (BoardDoc.seed) */
  seed = BOARD_SEED;
  private async syncNow(items: { id: string; code: string; preview?: Preview }[], mode: BoardMode, seed: string): Promise<string[]> {
    if (!(await this.ready)) return [];
    const nb = this.nb;
    const now = nb.cells().filter((c: any) => c.type === "code");
    const before = new Map<string, string>(now.map((c: any) => [c.id, c.ta.value]));
    // (another language or seed: every item runs again, in it)
    const relang = mode !== this.mode || seed !== this.seed;
    // (another language: a new interpreter, nothing of the last one's left
    // in it, such as Sage's pi in a MATLAB board's code; once it has been
    // given anything to run, finished or not)
    if (mode !== this.mode && this.started) {
      const k = this.kernel, ready = new Promise<void>((resolve) => { const off = k.on("ready", () => { off(); resolve(); }); });
      k.restart();
      await ready;
      this.started = false;
      if (this.closed) return [];
    }
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
    // (an item held whose code changed: run, as any edit, and what it holds with it)
    this.release(changed.filter((id) => before.has(id) && this.held.has(id)));
    // (another document: its outputs drawn in its pictures' pixels, not the last one's, CORR-A48-2)
    if (this.recount && this.pictures) nb.usePictures?.(this.pictures);
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
    // (another document: the outputs kept counted in its pictures' pixels,
    // once its own are in place, SEC-4DF-1; and those are drawn in them, not
    // in the last document's, CORR-A48-2)
    if (this.recount && this.pictures) {
      this.recount = false;
      nb.recountPictures?.();
    }
    if (!changed.length) return changed;
    let report: any;
    const fresh = items.filter((it) => !before.has(it.id)), ns = this.cacheDoc();
    if (nb.reactive && (held.length || (this.cache && ns && fresh.length))) {
      // (every item registered, those not changed kept as they are)
      await nb.reactive.load({ stale: true, fresh: new Set(items.filter((it) => !changed.includes(it.id)).map((it) => it.id)) });
      // items new here whose outputs the board's cache has, under their keys
      // now (outcache.ts): shown as computed, and held as previews are
      const hits = new Map<string, CachedOutputs>();
      if (this.cache && ns && fresh.length) {
        const keys = await nb.outputKeys();
        const want = new Map(fresh.map((it) => [keys?.[it.id]?.key, it.id]).filter(([k]) => !!k) as [string, string][]);
        // (the cache is a shortcut: one that doesn't answer within
        // CACHE_READ_MS is taken as empty, and the items run, rather than the
        // board's code never running; an IndexedDB open can stay unanswered
        // for good, web/board/idb-open.ts, test-idb-stall.mjs)
        const got = await within(this.cache.get(ns, [...want.keys()]).catch(() => new Map<string, CachedOutputs>()), CACHE_READ_MS, new Map<string, CachedOutputs>());
        for (const [k, e] of got) hits.set(want.get(k)!, e);
      }
      if (hits.size) {
        for (const id of hits.keys()) this.held.add(id);
        nb.applyRemote({
          mode,
          seed,
          cells: items.map((it) => {
            const c = this.cell(it.id), e = hits.get(it.id);
            const manual = this.held.has(it.id) ? { metadata: { sagebrush: { manual: true } } } : {};
            if (e) return { id: it.id, code: it.code, outputs: e.outputs, ms: e.ms, ...manual };
            if (held.includes(it)) return { id: it.id, code: it.code, outputs: it.preview!.outputs, ms: it.preview!.ms, ...manual };
            return { id: it.id, code: it.code, ...(c ? { outputs: nb.saveOutputs(c.out) } : {}), ...manual };
          }),
        }, false);
        for (const [id, e] of hits) {
          const c = this.cell(id);
          if (c) Object.assign(c.out.dataset, { preview: cachedLabel(e), cached: "1" });
          this.shown.set(id, e);
        }
      }
      // (then the others run, but not what reads a held one, which would run it)
      const blocked: Set<string> = nb.reactive.graph.closure([...held.map((it) => it.id), ...hits.keys()]);
      this.started = true;
      report = await nb.runCells(changed.filter((id) => !blocked.has(id))).finally(() => this.changed());
    } else {
      this.started = true;
      report = await nb.runCells(changed).finally(() => this.changed());
    }
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
    if (ids.length) this.runs++;
    const at = new Date().toISOString();
    for (const id of ids) {
      this.gens.set(id, this.generation(id) + 1);
      this.shown.delete(id);
      this.ranAt.set(id, at);
      const c = this.cell(id);
      if (c) {
        delete c.out.dataset.preview;
        delete c.out.dataset.cached;
      }
    }
    if (ids.length) {
      this.onRan?.(ids);
      this.keepOutputs(ids).catch((e) => console.warn("board: the outputs' cache:", e));
    }
  }

  /** the board's output cache (outcache.ts: the host's), if any */
  cache: OutputCache | null = null;
  /** an item over this many ms from root keeps its outputs in the cache */
  cacheMs = CACHE_MS;
  /** The board's pictures' pixels (image-size.ts): its code's are counted
   * in it too (mount.ts gives a new one for each document shown, CORR-71A-2). */
  usePictures(budget: unknown) {
    this.pictures = budget;
    this.recount = true;
  }
  private pictures: unknown = null;
  // (the outputs shown to be counted in it, once the new document's items are in place)
  private recount = false;
  /** the cache's name for the board shown, from its host's store (mount.ts
   * outputsId: not the board's seed, which is portable); none, no cache */
  cacheId: string | null = null;
  private cacheDoc(): string | null {
    return this.cacheId;
  }
  /** After a run: the outputs of the items that ran and are slow from root
   * into the cache (each of one run, as previews are), then the board's
   * cache swept, its items' keys now marked. */
  private async keepOutputs(ids: string[]) {
    // (the cache's name checked again after every wait: another board shown
    // meanwhile has dropped this one's, which nothing may write again, SEC-975-4)
    const cache = this.cache, ns = this.cacheDoc();
    if (!cache || !ns) return;
    const gens = new Map(ids.map((id) => [id, this.generation(id)]));
    const keys = await this.nb.outputKeys();
    if (!keys || this.cacheDoc() !== ns) return;
    const at = new Date().toISOString();
    const entries: (CachedOutputs & { id: string })[] = [];
    for (const id of ids) {
      const c = this.cell(id), k = keys[id], state = this.state(id);
      // (not: running again, interrupted, after a widget moved, or one that read files, whose bytes its key doesn't say)
      if (!c || !k?.key || k.widget || k.reads || (state !== "" && state !== "failed") || this.generation(id) !== gens.get(id) || k.fromRoot <= this.cacheMs) continue;
      entries.push({ id, key: k.key, outputs: this.nb.saveOutputs(c.out), at, ms: Math.round(k.ms ?? 0), total: Math.round(k.fromRoot) });
    }
    // (and each item's run again: a later run's entry, written meanwhile, isn't overwritten by this one's, CORR-4DF-2)
    for (const { id, ...e } of entries) {
      if (this.cacheDoc() !== ns) return;
      if (this.generation(id) !== gens.get(id)) continue;
      await cache.put(ns, e);
    }
    // (marking the items' keys as they are now, not as they were before the
    // writes: a newer run's entry is live, CORR-A48-3)
    // (and none if any item ran while they were found: that run sweeps with
    // newer ones, and this sweep's could miss its entry, CORR-68B-2)
    if (!entries.length) return;
    const runs = this.runs;
    const now = await this.nb.outputKeys();
    if (now && this.cacheDoc() === ns && this.runs === runs) await cache.sweep(ns, new Set(Object.values(now).map((k: any) => k.key).filter(Boolean)));
  }
  // the entries shown from the cache, by item, until it runs; when each item last ran
  private shown = new Map<string, CachedOutputs>();
  private ranAt = new Map<string, string>();
  /**
   * What a downloaded board carries (design/outputs.md, section 3): the
   * outputs the cache would keep for its items as they are now (over
   * cacheMs from root; up to date or failed; none after a widget moved or
   * that read files), computed here or shown from the cache, the slowest
   * first, at most DOC_CAP in all.  Previews are in the board already.
   */
  async carry(): Promise<CachedOutputs[]>;
  /** ...and only if the items are these, in this language and with this
   * seed, when the outputs are read (the document exported: else null) */
  async carry(expect: { mode: BoardMode; seed?: string; items: { id: string; code: string }[] }): Promise<CachedOutputs[] | null>;
  async carry(expect?: { mode: BoardMode; seed?: string; items: { id: string; code: string }[] }): Promise<CachedOutputs[] | null> {
    if (!(await this.ready)) return [];
    await this.last;
    const same = () => {
      if (!expect) return true;
      const cs = this.nb.cells().filter((c: any) => c.type === "code");
      return this.mode === expect.mode && this.seed === (expect.seed ?? BOARD_SEED) && cs.length === expect.items.length && cs.every((c: any, i: number) => c.id === expect.items[i].id && c.ta.value === expect.items[i].code);
    };
    // (each output read between two readings of the keys, with no run
    // finished meanwhile: an item whose key is the same in both is of its
    // key, CORR-2D0-1; else, read again)
    let out: CachedOutputs[] = [];
    for (let tries = 0; ; tries++) {
      if (tries === 5) return [];
      const runs = this.runs, gens = new Map(this.gens);
      const keys = await this.nb.outputKeys();
      if (this.closed) return [];
      if (!same()) return null;
      out = [];
      const ids: string[] = [];
      for (const c of this.nb.cells()) {
        const id = c.id, k = keys?.[id], state = this.state(id), e = this.shown.get(id);
        if (!k?.key || k.widget || k.reads || this.generation(id) !== (gens.get(id) ?? 0)) continue;
        // (one shown from the cache is held, so marked stale: still its key's)
        if (e) {
          if (e.key !== k.key || !(state === "" || state === "failed" || state === "stale")) continue;
          out.push({ key: e.key, outputs: e.outputs, at: e.at, ms: e.ms, total: e.total, ...(e.engine ? { engine: e.engine } : {}) });
        } else if ((state === "" || state === "failed") && !this.held.has(id) && this.ranAt.has(id) && k.fromRoot > this.cacheMs) {
          out.push({ key: k.key, outputs: this.nb.saveOutputs(c.out), at: this.ranAt.get(id)!, ms: Math.round(k.ms ?? 0), total: Math.round(k.fromRoot) });
        } else continue;
        ids.push(id);
      }
      const again = await this.nb.outputKeys();
      if (!same()) return null;
      if (this.runs === runs && ids.every((id, i) => again?.[id]?.key === out[i].key)) break;
    }
    out.sort((a, b) => b.total - a.total);
    let total = 0;
    return out.filter((e) => {
      const n = sizeOf(e.outputs);
      if (n > ENTRY_MAX || total + n > DOC_CAP) return false;
      total += n;
      return true;
    });
  }
  /** an item over this many ms from root keeps a preview (preview.ts) */
  previewMs = PREVIEW_MS;
  /** how many times each item has run here: a preview is of one run (SEC-14C-1) */
  private gens = new Map<string, number>();
  /** runs finished here, of any item (a sweep's mark is of one moment: keepOutputs) */
  private runs = 0;
  generation(id: string): number {
    return this.gens.get(id) ?? 0;
  }
  /**
   * Previews of these items' outputs as they are now: an item over previewMs
   * from root, its preview; under it, null (it needs none); each with the
   * run it is of (generation()), so a preview finished after a later run
   * can be dropped.  Absent: an item whose output is not one to keep
   * (running, interrupted, a widget moved, or run again meanwhile).
   */
  async previews(ids: string[]): Promise<Map<string, { preview: Preview | null; gen: number }>> {
    const out = new Map<string, { preview: Preview | null; gen: number }>();
    if (!(await this.ready)) return out;
    const gens = new Map(ids.map((id) => [id, this.generation(id)]));
    const keys = await this.nb.outputKeys();
    // (every output taken now, before any picture is drawn again)
    const now = ids.flatMap((id) => {
      const c = this.cell(id), k = keys?.[id], state = this.state(id);
      if (!c || !k || k.widget || (state !== "" && state !== "failed") || this.generation(id) !== gens.get(id)) return [];
      return [{ id, k, gen: gens.get(id)!, outputs: k.fromRoot > this.previewMs ? this.nb.saveOutputs(c.out) : null }];
    });
    const at = new Date().toISOString();
    for (const { id, k, gen, outputs } of now) {
      out.set(id, { preview: outputs ? await makePreview(outputs, { at, ms: k.ms ?? 0, total: k.fromRoot }) : null, gen });
    }
    return out;
  }

  /** Run these code items, then what depends on them (resolves to the reactive notebook's report). */
  run(ids: string[]): Promise<any> {
    return this.queued(async () => {
      if (!(await this.ready)) return null;
      this.release(ids);
      this.started = true;
      const report = await this.nb.runCells(ids).finally(() => this.changed());
      this.ran(report);
      return report;
    });
  }
  runAll(): Promise<any> {
    return this.queued(async () => {
      if (!(await this.ready)) return null;
      this.release(null);
      this.started = true;
      const report = await this.nb.runAll().finally(() => this.changed());
      this.ran(report);
      return report;
    });
  }
  /** A board question's Check, whole: `f` runs alone in this interpreter's
   * queue, no sync, run or other Check between its steps, given what it
   * needs without queueing again: `evaluate` (a check or computed hint,
   * WorkerKernel.evaluate, within `ms`) and `refresh` (a new interpreter,
   * every item run in it, the new interpreter's start included, within
   * `ms`: else false, and what still runs is interrupted, which takes up to
   * 2 s more before the interpreter is restarted instead).  A check may change the board's names, so a Check refreshes
   * after each evaluation (the coordinator's rule for CORR-A19-1); each
   * step is bounded, so the queue is. */
  exclusive<T>(f: (ops: CheckOps) => Promise<T>): Promise<T> {
    return this.queued(() => f({ evaluate: (code, answer, ms, by) => this.evaluateNow(code, answer, ms, by), refresh: (ms) => this.refreshNow(ms) }));
  }
  private async evaluateNow(code: string, answer: unknown, ms: number, by?: number): Promise<Evaluated> {
    if (!(await this.ready) || !this.kernel) return { ok: false, error: "the interpreter is not running" };
    return this.kernel.evaluate(code, answer, this.mode, ms, by);
  }
  private async refreshNow(ms: number): Promise<boolean> {
    if (!(await this.ready)) return false;
    // (the whole of it within `ms`: the new interpreter's start too, which
    // may never come, HARD-729-1; past it, its listener is gone and false)
    const until = Date.now() + Math.max(0, ms);
    const k = this.kernel;
    let off = () => {}, timer: ReturnType<typeof setTimeout> | undefined;
    const ready = new Promise<boolean>((resolve) => {
      off = k.on("ready", () => resolve(true));
      timer = setTimeout(() => resolve(false), Math.max(0, until - Date.now()));
    });
    k.restart("");
    const started = await ready.finally(() => { off(); clearTimeout(timer); });
    if (!started || this.closed) return false;
    this.release(null);
    this.started = true;
    const run = this.nb.runAll().finally(() => this.changed());
    const over = new Promise<"over">((res) => { timer = setTimeout(() => res("over"), Math.max(0, until - Date.now())); });
    const got = await Promise.race([run, over]).finally(() => clearTimeout(timer));
    if (got === "over") {
      // (what still runs interrupted: within 2 s, else the interpreter restarted, WorkerKernel.interrupt)
      this.interrupt();
      this.ran(await run.catch(() => null));
      return false;
    }
    this.ran(got);
    return true;
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
    // (a start waited for, and the analyzer's questions: settled now, their
    // timers gone, rather than at their deadlines, HARD-9BB-1)
    for (const cancel of [...this.waits]) cancel();
    for (const q of [...this.asks.values()]) q.settle({ error: { kind: "analyzer", message: "closed" }, sources: null });
    this.asks.clear();
    clearTimeout(this.pending);
    this.pending = 0;
    this.observer?.disconnect();
    for (const o of this.outputs.splice(0)) o.disconnect();
    this.nb?.destroy();
    this.nb = null;
    this.kernel?.close();
    this.stopRunnerInfo?.();
    this.stopRunnerInfo = undefined;
    this.kernel = null;
    this.analyzer?.terminate();
    this.analyzer = null;
    this.root?.remove();
    this.root = null;
  }
  private closed = false;
  // (the start waited for: their cancels; the analyzer's questions not yet answered)
  private waits = new Set<() => void>();
  private asks = new Map<number, { w: Worker; settle: (d: any) => void }>();
  private kernel: any = null;
  private stopRunnerInfo?: () => void;
  /** The completions of `before`, the code on the caret's line up to it, as
   * the notebook's Tab asks its interpreter ({ complete }, src/interactive.ts):
   * the names, and the prefix of `before` they complete; null before the
   * interpreter runs, or if it restarted meanwhile. */
  async complete(before: string): Promise<{ matches: string[]; prefix: string } | null> {
    if (!(await this.ready) || !this.kernel) return null;
    return admitCompletion(await this.kernel.ask({ complete: before }, this.mode, null), before);
  }
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
