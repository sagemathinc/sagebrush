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
  | { kind: "import-star"; message: string }
  // (reading: the cell reads a name several cells define, under #1477's relaxation)
  | { kind: "multiple-definition"; name: string; cells: string[]; reading?: true }
  | { kind: "cycle"; cells: string[] };

interface Node {
  id: string;
  code: string;
  // undefined when the cell could not be analyzed (its error says why)
  analysis?: CellAnalysis;
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
  analysis?: CellAnalysis;
  error?: CellError;
}

export class NotebookGraph {
  private nodes = new Map<string, Node>();
  private parentsOf = new Map<string, Set<string>>();
  private childrenOf = new Map<string, Set<string>>();
  private errorsOf = new Map<string, CellError[]>();
  /** each name's defining cells, in page order */
  readonly definers = new Map<string, string[]>();
  /** each name's updaters: the cells mutating its object, in page order (not when strict) */
  readonly updatersOf = new Map<string, string[]>();
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
      if (c.analysis || c.error) node = { id: c.id, code: c.code, analysis: c.analysis, error: c.error };
      else if (prev && prev.code === c.code) node = prev;
      else node = this.analyzeNode(c.id, c.code);
      this.nodes.set(c.id, node);
    }
    this.build();
  }

  private analyzeNode(id: string, code: string): Node {
    if (!this.analyze) throw new Error(`cell ${id}: no analysis`);
    try {
      return { id, code, analysis: this.analyze(code, id) };
    } catch (e: any) {
      const kind = e?.name === "ImportStarError" ? "import-star" : "syntax";
      return { id, code, error: { kind, message: String(e?.message ?? e) } };
    }
  }

  get ids(): string[] {
    return [...this.nodes.keys()];
  }
  analysis(id: string): CellAnalysis | undefined {
    return this.nodes.get(id)?.analysis;
  }
  parents(id: string): Set<string> {
    return this.parentsOf.get(id) ?? new Set();
  }
  children(id: string): Set<string> {
    return this.childrenOf.get(id) ?? new Set();
  }
  /** each cell's errors (cells without errors are absent) */
  get errors(): Map<string, CellError[]> {
    return this.errorsOf;
  }

  private build(): void {
    const ids = this.ids;
    this.parentsOf = new Map(ids.map((id) => [id, new Set()]));
    this.childrenOf = new Map(ids.map((id) => [id, new Set()]));
    this.errorsOf = new Map();
    this.definers.clear();
    const readers = new Map<string, string[]>();
    const deleters = new Map<string, string[]>();
    const push = (m: Map<string, string[]>, k: string, v: string) => {
      const l = m.get(k);
      if (l) l.push(v);
      else m.set(k, [v]);
    };
    for (const [id, node] of this.nodes) {
      if (node.error) this.errorsOf.set(id, [node.error]);
      const a = node.analysis;
      if (!a) continue;
      for (const n of a.defs) push(this.definers, n, id);
      for (const n of a.refs) push(readers, n, id);
      for (const n of a.deleted) push(deleters, n, id);
    }
    const edge = (p: string, c: string) => {
      if (p === c) return;
      this.childrenOf.get(p)!.add(c);
      this.parentsOf.get(c)!.add(p);
    };
    for (const [name, ds] of this.definers) {
      const rs = readers.get(name);
      // (ours: the same import in several cells defines the same thing)
      const what = ds.map((d) => this.nodes.get(d)!.analysis?.imports?.get(name));
      const sameImport = !this.strict && what[0] !== undefined && what.every((w) => w === what[0]);
      if (ds.length > 1 && (this.strict || rs) && !sameImport) {
        for (const d of ds) this.addError(d, { kind: "multiple-definition", name, cells: ds.filter((x) => x !== d) });
        // #1477: and on the cells reading it, which may be the ones that made it an error
        if (!this.strict) for (const r of rs ?? []) if (!ds.includes(r)) this.addError(r, { kind: "multiple-definition", name, cells: ds, reading: true });
      }
      for (const r of rs ?? []) for (const d of ds) edge(d, r);
    }
    // a cell deleting a name runs after the others reading it
    for (const [name, xs] of deleters) for (const r of readers.get(name) ?? []) for (const x of xs) edge(r, x);
    // Mutation tracking (ours, unless strict): the cells mutating a name's
    // object (its updaters) run after its definer, in page order, and before
    // the cells reading it.
    this.updatersOf.clear();
    if (!this.strict) {
      for (const [id, node] of this.nodes) for (const n of node.analysis?.mutations ?? []) if (this.definers.has(n)) push(this.updatersOf, n, id);
      for (const [name, us] of this.updatersOf) {
        for (let i = 0; i + 1 < us.length; i++) edge(us[i], us[i + 1]);
        for (const r of readers.get(name) ?? []) if (!us.includes(r)) for (const u of us) edge(u, r);
      }
    }
    for (const scc of this.components()) {
      if (scc.length > 1) for (const id of scc) this.addError(id, { kind: "cycle", cells: scc });
    }
    // Files (ours): a cell that wrote a file in its last run, before one that
    // read it.  Edges found by running, so never made into cycles: one that
    // would close a cycle is left out.
    const fileReaders = new Map<string, string[]>();
    for (const [id, io] of this.files) if (this.nodes.has(id)) for (const f of io.reads) push(fileReaders, f, id);
    for (const [id, io] of this.files) {
      if (!this.nodes.has(id)) continue;
      for (const f of io.writes) for (const r of fileReaders.get(f) ?? []) {
        if (r !== id && !this.childrenOf.get(id)!.has(r) && !this.closure([r]).has(id)) edge(id, r);
      }
    }
  }

  /** The files each cell read and wrote in its last run (a page's writer-to-reader edges). */
  setFiles(files: Map<string, { reads: string[]; writes: string[] }>): void {
    this.files = files;
    this.build();
  }
  /** The cells that read a file in their last run. */
  readersOf(path: string): string[] {
    return this.ids.filter((id) => this.files.get(id)?.reads.includes(path));
  }

  private addError(id: string, e: CellError): void {
    const l = this.errorsOf.get(id);
    if (l) l.push(e);
    else this.errorsOf.set(id, [e]);
  }

  /** the strongly connected components (Tarjan), each in page order */
  private components(): string[][] {
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
        work.push([v, this.children(v)[Symbol.iterator]()]);
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

