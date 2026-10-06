// Ctrl-C for Python code and the engines.  The embedding (the notebook
// page) sets INTR[0] = 1 from another thread: the array lives in a
// SharedArrayBuffer when the page is cross-origin isolated, and the worker
// hands it to the page.  Compiled Python loops test it once per iteration
// (`if (INTR[0]) interrupted();`), and the WebAssembly engine reads it
// through its `sagebrush.interrupted` import.  Elsewhere (Node, a page
// without isolation) it is a plain array that stays 0.  INTR[1] is for the
// embedding: the notebook's worker skips queued runs up to that id.
export const INTR: Int32Array =
  (globalThis as any).crossOriginIsolated && typeof SharedArrayBuffer === "function" ? new Int32Array(new SharedArrayBuffer(8)) : new Int32Array(2);
