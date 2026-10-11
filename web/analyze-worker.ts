// The reactive notebook's analyzer (src/dataflow.ts) in a Web Worker of its
// own: the names each cell defines and references, for the dependency graph
// (src/notebook-graph.ts).  Not in the page, whose script stays small, and
// not in the interpreter's worker, which is busy while a cell runs.
//
// In:  {id, code, mode}   mode: "python" | "sage" | "magma"
// Out: {id, defs, refs, deleted} (arrays of names), or {id, error: {kind, message}}
//      (kind "syntax" or "import-star")
import { analyzeCell, ImportStarError } from "../src/dataflow";

self.onmessage = (ev: MessageEvent) => {
  const { id, code, mode } = ev.data;
  try {
    const a = analyzeCell(code, "c", { mode });
    postMessage({ id, defs: [...a.defs], refs: [...a.refs], deleted: [...a.deleted] });
  } catch (e: any) {
    postMessage({ id, error: { kind: e instanceof ImportStarError ? "import-star" : "syntax", message: String(e?.message ?? e) } });
  }
};
