// Ctrl-C for Python code and the engines.  The embedding (the notebook
// page) sets INTR[0] = 1 from another thread: the array lives in a
// SharedArrayBuffer when the page is cross-origin isolated, and the worker
// hands it to the page.  Compiled Python loops test it once per iteration
// (`if (INTR[0]) interrupted();`), and the WebAssembly engine reads it
// through its `sagebrush.interrupted` import.  Elsewhere (Node, a page
// without isolation) it is a plain array that stays 0.  INTR[1] is for the
// embedding: the notebook's worker skips queued runs up to that id.
// (In Node, where shared memory is always available, it is shared too: the
// Jupyter kernel interrupts its worker thread through it.)
const g = globalThis as any;
export const INTR: Int32Array =
  typeof SharedArrayBuffer === "function" && (g.crossOriginIsolated || (typeof g.process === "object" && !!g.process.versions?.node && typeof g.window === "undefined" && typeof g.importScripts !== "function"))
    ? new Int32Array(new SharedArrayBuffer(8))
    : new Int32Array(2);
