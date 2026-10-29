// The reactive notebook's dependency graph (design/reactive-notebook.md):
// which cells read what others define, the errors that make the graph
// ill-defined, and the order in which cells run.
//
// The semantics are marimo's (marimo/_runtime/dataflow and
// marimo/_lint/validate_graph.py, Apache-2.0, see NOTICE.md), checked
// against marimo itself by test/notebook-graph.test.ts:
//
//   - B is a child of A when B references a name A defines;
//   - a cell that deletes a name (`del x`) runs after every other cell that
//     references it;
//   - a name defined by several cells is a MultipleDefinitionError on each;
//   - the cells on a cycle get a CycleError;
//   - cells run in topological order, ties going to the page order.
//
// Differences, each deliberate:
//
//   - #1477's relaxation (unless `strict`): several cells may define a name
//     that no cell reads.  Such a name has no edges, so the graph is exact.
//     Once a cell reads it, the definers and the readers have the error (the
//     scheduler shows it only on the cells just run: no action at a distance).
//   - Mutation tracking (unless `strict`): a cell visibly mutating another
//     cell's object (src/dataflow.ts `mutations`) is its updater, run after
//     the definer and other updaters above it, and before the readers.
//   - The same import (`import numpy as np`) in several cells is not a
//     multiple definition: it defines the same thing.
//   - Files (setFiles): a cell that wrote a file in its last run runs before
//     the cells that read it.
//   - A cycle error goes to every cell in a strongly connected component:
//     every cell on a cycle.  marimo records, for each edge added, one path
//     closing a cycle, and so misses some cells (in 70 of the oracle's 3,198
//     notebooks; never a whole cycle).
// (Analysis is given, or done by `options.analyze`, e.g. src/dataflow.ts's
// analyzeCell: the page asks a worker, so that this module stays small.)
import type { CellAnalysis } from "./dataflow";

export type CellError =
  | { kind: "syntax"; message: string }
  // (the analyzer failed: not the code's fault; analyzed again on the next run)
  | { kind: "analyzer"; message: string }
  | { kind: "import-star"; message: string }
  // (reading: the cell reads a name several cells define, under #1477's relaxation)
  | { kind: "multiple-definition"; name: string; cells: string[]; reading?: true }
  | { kind: "cycle"; cells: string[] };

interface Node {
  id: string;
  code: string;
  // undefined when the cell could not be analyzed (its error says why)
  analysis?: AnalysisView;
  error?: CellError;
}

export interface GraphOptions {
  /** marimo's one-definition rule exactly, without #1477's relaxation */
  strict?: boolean;
  /** analyzes a cell given without its analysis (it throws ImportStarError or a syntax error) */
  analyze?: (code: string, id: string) => CellAnalysis;
}

/** A cell: its analysis (or the error analyzing it), or just its code for `analyze`. */
export interface GraphCell {
  id: string;
  code: string;
  analysis?: CellAnalysis | AnalysisView;
  error?: CellError;
}

/**
 * A read-only view of a set: it can be read and iterated, and has no
 * mutator (calling one is a TypeError).  What it shows is private to it.
 */
export class SetView<T> {
  readonly #s: Set<T>;
  constructor(items: Iterable<T> = []) {
    this.#s = new Set(items);
    Object.freeze(this);
  }
  get size(): number {
    return this.#s.size;
  }
  has(x: T): boolean {
    return this.#s.has(x);
  }
  keys() {
    return this.#s.keys();
  }
  values() {
    return this.#s.values();
  }
  entries() {
    return this.#s.entries();
  }
  forEach(f: (value: T, key: T, set: SetView<T>) => void, thisArg?: unknown): void {
    for (const x of this.#s) f.call(thisArg, x, x, this);
  }
  [Symbol.iterator]() {
    return this.#s.values();
  }
}

/** A read-only view of a map, as SetView is of a set (its values are frozen by whoever makes it). */
export class MapView<K, V> {
  readonly #m: Map<K, V>;
  /** `live`: instead of a copy of `entries`, a map its owner holds privately and never writes (it replaces it) */
  constructor(entries: Iterable<readonly [K, V]> = [], live?: Map<K, V>) {
    this.#m = live ?? new Map(entries);
    Object.freeze(this);
  }
  get size(): number {
    return this.#m.size;
  }
  has(k: K): boolean {
    return this.#m.has(k);
  }
  get(k: K): V | undefined {
    return this.#m.get(k);
  }
  keys() {
    return this.#m.keys();
  }
  values() {
    return this.#m.values();
  }
  entries() {
    return this.#m.entries();
  }
  forEach(f: (value: V, key: K, map: MapView<K, V>) => void, thisArg?: unknown): void {
    for (const [k, v] of this.#m) f.call(thisArg, v, k, this);
  }
  [Symbol.iterator]() {
    return this.#m.entries();
  }
}

/** A cell's analysis, read-only: its sets and maps are views, and the object is frozen. */
export interface AnalysisView {
  readonly defs: SetView<string>;
  readonly refs: SetView<string>;
  readonly deleted: SetView<string>;
  readonly mutations?: SetView<string>;
  readonly imports?: MapView<string, string>;
  readonly unbinds?: SetView<string>;
}
const analysisViews = new WeakSet<object>();
/** A private, read-only copy of an analysis (one already made is itself). */
export function analysisView(a: CellAnalysis | AnalysisView): AnalysisView {
  if (analysisViews.has(a)) return a as AnalysisView;
  const v: AnalysisView = Object.freeze({
    defs: new SetView(a.defs),
    refs: new SetView(a.refs),
    deleted: new SetView(a.deleted),
    ...(a.mutations ? { mutations: new SetView(a.mutations) } : {}),
    ...(a.imports ? { imports: new MapView<string, string>(a.imports) } : {}),
    ...(a.unbinds ? { unbinds: new SetView(a.unbinds) } : {}),
  });
  analysisViews.add(v);
  return v;
}
/** An error, copied and frozen (with its list of cells). */
export const frozenError = (e: CellError): CellError => Object.freeze("cells" in e ? { ...e, cells: Object.freeze([...e.cells]) as string[] } : { ...e });
// Lists by key, each frozen, in a view.
const listsView = (m: Map<string, string[]>) => new MapView<string, string[]>([...m].map(([k, l]) => [k, Object.freeze(l) as string[]] as const));

// (no parents, or no children)
const NONE = new SetView<string>();
// Whether `to` is `from` or below it, over build()'s edges.
function reaches(childrenOf: Map<string, Set<string>>, from: string, to: string): boolean {
  const seen = new Set([from]);
  const queue = [from];
  while (queue.length) {
    const id = queue.shift()!;
    if (id === to) return true;
    for (const c of childrenOf.get(id) ?? []) if (!seen.has(c)) {
      seen.add(c);
      queue.push(c);
    }
  }
  return false;
}

export class NotebookGraph {
  private nodes = new Map<string, Node>();
  // (each is replaced, never written, and only in build(): the views have no mutators, their lists are frozen)
  private parentsOf = new Map<string, SetView<string>>();
  private childrenOf = new Map<string, SetView<string>>();
  private errorsOf = new MapView<string, CellError[]>();
  private definersOf = new MapView<string, string[]>();
  private updaters = new MapView<string, string[]>();
  private deleters = new MapView<string, string[]>();
  /** replaced by a new frozen object at the end of every build(): while it is the same object, so is everything in the graph */
  private versionNow: object = Object.freeze({});
  private files = new Map<string, { reads: string[]; writes: string[] }>();
  private readonly strict: boolean;
  private readonly analyze?: (code: string, id: string) => CellAnalysis;

  constructor(cells: GraphCell[] = [], options: GraphOptions = {}) {
    this.strict = !!options.strict;
    this.analyze = options.analyze;
    this.set(cells);
  }

  /** Replace the notebook's cells (in page order); unchanged code is not analyzed again. */
  set(cells: GraphCell[]): void {
    const old = this.nodes;
    this.nodes = new Map();
    for (const c of cells) {
      const prev = old.get(c.id);
      let node: Node;
      // (the graph keeps its own read-only copies: nothing the caller holds can change them)
      if (c.analysis || c.error) node = { id: c.id, code: c.code, analysis: c.analysis ? analysisView(c.analysis) : undefined, error: c.error ? frozenError(c.error) : undefined };
      else if (prev && prev.code === c.code) node = prev;
      else node = this.analyzeNode(c.id, c.code);
      this.nodes.set(c.id, node);
    }
    this.build();
  }

  private analyzeNode(id: string, code: string): Node {
    if (!this.analyze) throw new Error(`cell ${id}: no analysis`);
    try {
      return { id, code, analysis: analysisView(this.analyze(code, id)) };
    } catch (e: any) {
      const kind = e?.name === "ImportStarError" ? "import-star" : "syntax";
      return { id, code, error: { kind, message: String(e?.message ?? e) } };
    }
  }

  get ids(): string[] {
    return [...this.nodes.keys()];
  }
  /** a cell's analysis: a read-only view */
  analysis(id: string): AnalysisView | undefined {
    return this.nodes.get(id)?.analysis;
  }
  /** a cell's parents (read-only) */
  parents(id: string): SetView<string> {
    return this.parentsOf.get(id) ?? NONE;
  }
  /** a cell's children (read-only) */
  children(id: string): SetView<string> {
    return this.childrenOf.get(id) ?? NONE;
  }
  /** each cell's errors (cells without errors are absent; read-only, the lists frozen) */
  get errors(): MapView<string, CellError[]> {
    return this.errorsOf;
  }
  /** each name's defining cells, in page order (read-only) */
  get definers(): MapView<string, string[]> {
    return this.definersOf;
  }
  /** each name's updaters: the cells mutating its object, in page order (not when strict; read-only) */
  get updatersOf(): MapView<string, string[]> {
    return this.updaters;
  }
  /** each name's deleters: the cells deleting it (`del x`), in page order (read-only) */
  get deletersOf(): MapView<string, string[]> {
    return this.deleters;
  }
  /** a new frozen object whenever anything in the graph changed (every change ends in build()) */
  get version(): object {
    return this.versionNow;
  }

  // Everything is computed in local collections, then published as read-only views, and the version
  // replaced: the one place the graph changes.
  private build(): void {
    const ids = this.ids;
    const parentsOf = new Map<string, Set<string>>(ids.map((id) => [id, new Set<string>()]));
    const childrenOf = new Map<string, Set<string>>(ids.map((id) => [id, new Set<string>()]));
    const errorsOf = new Map<string, CellError[]>();
    const definers = new Map<string, string[]>();
    const readers = new Map<string, string[]>();
    const deleters = new Map<string, string[]>();
    const updatersOf = new Map<string, string[]>();
    const addError = (id: string, e: CellError) => {
      const l = errorsOf.get(id);
      if (l) l.push(e);
      else errorsOf.set(id, [e]);
    };
    const push = (m: Map<string, string[]>, k: string, v: string) => {
      const l = m.get(k);
      if (l) l.push(v);
      else m.set(k, [v]);
    };
    for (const [id, node] of this.nodes) {
      if (node.error) errorsOf.set(id, [node.error]);
      const a = node.analysis;
      if (!a) continue;
      for (const n of a.defs) push(definers, n, id);
      // (ours: `except E as x` binds x, then deletes it: a definition, after
      // which x is gone, as in plain Python)
      if (!this.strict) for (const n of a.unbinds ?? []) if (!a.defs.has(n)) push(definers, n, id);
      for (const n of a.refs) push(readers, n, id);
      for (const n of a.deleted) push(deleters, n, id);
    }
    const edge = (p: string, c: string) => {
      if (p === c) return;
      childrenOf.get(p)!.add(c);
      parentsOf.get(c)!.add(p);
    };
    for (const [name, ds] of definers) {
      const rs = readers.get(name);
      // (ours: the same import in several cells defines the same thing)
      const what = ds.map((d) => this.nodes.get(d)!.analysis?.imports?.get(name));
      const sameImport = !this.strict && what[0] !== undefined && what.every((w) => w === what[0]);
      if (ds.length > 1 && (this.strict || rs) && !sameImport) {
        for (const d of ds) addError(d, { kind: "multiple-definition", name, cells: ds.filter((x) => x !== d) });
        // #1477: and on the cells reading it, which may be the ones that made it an error
        if (!this.strict) for (const r of rs ?? []) if (!ds.includes(r)) addError(r, { kind: "multiple-definition", name, cells: ds, reading: true });
      }
      for (const r of rs ?? []) for (const d of ds) edge(d, r);
    }
    // a cell deleting a name runs after the others reading it (and, ours,
    // after the cell defining it: there is nothing to delete before)
    for (const [name, xs] of deleters) for (const r of readers.get(name) ?? []) for (const x of xs) edge(r, x);
    if (!this.strict) for (const [name, xs] of deleters) for (const d of definers.get(name) ?? []) for (const x of xs) edge(d, x);
    // Mutation tracking (ours, unless strict): the cells mutating a name's
    // object (its updaters) run after its definer, in page order, and before
    // the cells reading it.
    if (!this.strict) {
      for (const [id, node] of this.nodes) for (const n of node.analysis?.mutations ?? []) if (definers.has(n)) push(updatersOf, n, id);
      for (const [name, us] of updatersOf) {
        for (let i = 0; i + 1 < us.length; i++) edge(us[i], us[i + 1]);
        for (const r of readers.get(name) ?? []) if (!us.includes(r)) for (const u of us) edge(u, r);
      }
    }
    for (const scc of this.components((v) => childrenOf.get(v)!)) {
      if (scc.length > 1) for (const id of scc) addError(id, { kind: "cycle", cells: scc });
    }
    // Files (ours): a cell that wrote a file in its last run, before one that
    // read it.  Edges found by running, so never made into cycles: one that
    // would close a cycle is left out.
    const fileReaders = new Map<string, string[]>();
    for (const [id, io] of this.files) if (this.nodes.has(id)) for (const f of io.reads) push(fileReaders, f, id);
    for (const [id, io] of this.files) {
      if (!this.nodes.has(id)) continue;
      for (const f of io.writes) for (const r of fileReaders.get(f) ?? []) {
        if (r !== id && !childrenOf.get(id)!.has(r) && !reaches(childrenOf, r, id)) edge(id, r);
      }
    }
    // published: read-only views, the lists frozen
    this.parentsOf = new Map(ids.map((id) => [id, new SetView(parentsOf.get(id)!)]));
    this.childrenOf = new Map(ids.map((id) => [id, new SetView(childrenOf.get(id)!)]));
    this.errorsOf = new MapView<string, CellError[]>([...errorsOf].map(([id, es]) => [id, Object.freeze(es.map(frozenError)) as CellError[]] as const));
    this.definersOf = listsView(definers);
    this.updaters = listsView(updatersOf);
    this.deleters = listsView(deleters);
    this.versionNow = Object.freeze({});
  }

  /** The files each cell read and wrote in its last run (a page's writer-to-reader edges): copied, so the caller's map can't change the graph. */
  setFiles(files: Map<string, { reads: string[]; writes: string[] }>): void {
    this.files = new Map([...files].map(([id, io]) => [id, Object.freeze({ reads: Object.freeze([...io.reads]) as string[], writes: Object.freeze([...io.writes]) as string[] })]));
    this.build();
  }
  /** The cells that read a file in their last run. */
  readersOf(path: string): string[] {
    return this.ids.filter((id) => this.files.get(id)?.reads.includes(path));
  }

  /** the strongly connected components (Tarjan), each in page order, over `children` (build()'s edges) */
  private components(children: (id: string) => Set<string>): string[][] {
    const index = new Map<string, number>(), low = new Map<string, number>();
    const stack: string[] = [], on = new Set<string>(), out: string[][] = [];
    const page = new Map(this.ids.map((id, i) => [id, i]));
    let n = 0;
    // iterative, so that a long chain of cells cannot overflow the stack
    for (const start of this.ids) {
      if (index.has(start)) continue;
      const work: [string, Iterator<string>][] = [];
      const open = (v: string) => {
        index.set(v, n);
        low.set(v, n++);
        stack.push(v);
        on.add(v);
        work.push([v, children(v)[Symbol.iterator]()]);
      };
      open(start);
      while (work.length) {
        const [v, it] = work[work.length - 1];
        const next = it.next();
        if (!next.done) {
          const w = next.value;
          if (!index.has(w)) open(w);
          else if (on.has(w)) low.set(v, Math.min(low.get(v)!, index.get(w)!));
          continue;
        }
        work.pop();
        if (work.length) {
          const u = work[work.length - 1][0];
          low.set(u, Math.min(low.get(u)!, low.get(v)!));
        }
        if (low.get(v) === index.get(v)) {
          const scc: string[] = [];
          let w: string;
          do {
            w = stack.pop()!;
            on.delete(w);
            scc.push(w);
          } while (w !== v);
          out.push(scc.sort((x, y) => page.get(x)! - page.get(y)!));
        }
      }
    }
    return out;
  }

  /** The given cells and their descendants (or ancestors). */
  closure(ids: Iterable<string>, { children = true, inclusive = true } = {}): Set<string> {
    const start = [...ids];
    const seen = new Set(start), out = new Set(inclusive ? start : []);
    const queue = [...start];
    while (queue.length) {
      const id = queue.shift()!;
      for (const r of children ? this.children(id) : this.parents(id)) {
        if (seen.has(r)) continue;
        seen.add(r);
        out.add(r);
        queue.push(r);
      }
    }
    return out;
  }

  /**
   * The given cells in topological order, ties going to the page order
   * (marimo's topological_sort).  Cells on a cycle among them are left out.
   */
  order(ids: Iterable<string>): string[] {
    const set = new Set(ids);
    const page = new Map(this.ids.map((id, i) => [id, i]));
    const degree = new Map<string, number>();
    for (const id of set) degree.set(id, [...this.parents(id)].filter((p) => set.has(p)).length);
    // a binary heap on page position
    const heap: string[] = [];
    const less = (a: string, b: string) => page.get(a)! < page.get(b)!;
    const pushHeap = (x: string) => {
      heap.push(x);
      let i = heap.length - 1;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (!less(heap[i], heap[p])) break;
        [heap[i], heap[p]] = [heap[p], heap[i]];
        i = p;
      }
    };
    const popHeap = (): string => {
      const top = heap[0], last = heap.pop()!;
      if (heap.length) {
        heap[0] = last;
        let i = 0;
        for (;;) {
          const l = 2 * i + 1, r = l + 1;
          let m = i;
          if (l < heap.length && less(heap[l], heap[m])) m = l;
          if (r < heap.length && less(heap[r], heap[m])) m = r;
          if (m === i) break;
          [heap[i], heap[m]] = [heap[m], heap[i]];
          i = m;
        }
      }
      return top;
    };
    for (const id of set) if (degree.get(id) === 0) pushHeap(id);
    const out: string[] = [];
    while (heap.length) {
      const id = popHeap();
      out.push(id);
      for (const c of this.children(id)) {
        if (!set.has(c)) continue;
        const d = degree.get(c)! - 1;
        degree.set(c, d);
        if (d === 0) pushHeap(c);
      }
    }
    return out;
  }
}

