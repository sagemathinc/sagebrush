// The reactive notebook's analyzer (src/dataflow.ts) in a Web Worker of its
// own: the names each cell defines and references, for the dependency graph
// (src/notebook-graph.ts).  Not in the page, whose script stays small, and
// not in the interpreter's worker, which is busy while a cell runs.
//
// In:  {id, code, mode}   mode: "python" | "sage" | "magma" | "matlab"
// Out: {id, defs, refs, deleted, mutations} (arrays of names), or {id, error: {kind, message}}
//      (kind "syntax" or "import-star")
//      {id, rename: {name, cells: [{id, code, defines, reads}], taken, mode, sep?}}
//        -> {id, sources: [[cell id, new code, renames?]] | null}: the fix of a name
//        defined by several cells (src/rename.ts; Magma: each cell's renames,
//        {to, before?}, which go beside its code: src/magma.ts PageOrder)
//      {id, code, mode, pageOrder?}: a Magma cell's analysis with its renames
import { analyzeCell, ImportStarError } from "../src/dataflow";
import { renameRedefinitions } from "../src/rename";

self.onmessage = (ev: MessageEvent) => {
  const { id, code, mode, rename, pageOrder } = ev.data;
  if (rename) {
    let sources: [string, string, { to: string; before?: string }?][] | null = null;
    try {
      const po = new Map<string, { to: string; before?: string }>();
      const r = renameRedefinitions(rename.cells, rename.name, new Set(rename.taken), rename.mode, rename.sep ?? "_", po);
      sources = r ? [...r].map(([k, c]) => (po.has(k) ? [k, c, po.get(k)!] : [k, c])) : null;
    } catch {}
    postMessage({ id, sources });
    return;
  }
  try {
    const a = analyzeCell(code, "c", { mode, ...(pageOrder ? { pageOrder } : {}) });
    postMessage({ id, defs: [...a.defs], refs: [...a.refs], deleted: [...a.deleted], mutations: [...(a.mutations ?? [])], imports: [...(a.imports ?? [])] });
  } catch (e: any) {
    postMessage({ id, error: { kind: e instanceof ImportStarError ? "import-star" : "syntax", message: String(e?.message ?? e) } });
  }
};
