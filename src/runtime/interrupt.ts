// Ctrl-C for Python code and the engines.  The embedding (the notebook
// page, the launcher, the Jupyter kernel) requests it from another thread:
// the array lives in a SharedArrayBuffer when the page is cross-origin
// isolated, and the worker hands it to the page.  Compiled Python loops test
// it once per iteration (`if (INTR[0] & 1) interrupted();`), and the
// WebAssembly engine reads it through its `sagebrush.interrupted` import.
// Elsewhere (Node, a page without isolation) it is a plain array that stays
// 0.  INTR[1] is for the embedding: the notebook's worker skips queued runs
// up to that id.  (In Node, where shared memory is always available, it is
// shared too: the Jupyter kernel interrupts its worker thread through it.)
const g = globalThis as any;
export const INTR: Int32Array =
  typeof SharedArrayBuffer === "function" && (g.crossOriginIsolated || (typeof g.process === "object" && !!g.process.versions?.node && typeof g.window === "undefined" && typeof g.importScripts !== "function"))
    ? new Int32Array(new SharedArrayBuffer(8))
    : new Int32Array(2);

// INTR[0] is a word of named bits, each with its own producer and consumer
// (plan-prompt-worker r3 §6).  Nothing stores to the word: a producer sets
// its bit with Atomics.or, a consumer clears its own with Atomics.and, so no
// one erases another's (a stored 0 or 1 would clear a persistent bit 3).
export const INTR_CTRL_C = 1; //    bit 0: Ctrl-C, a KeyboardInterrupt
export const INTR_FRAME = 2; //     bit 1: a CLI indicator frame is due (item E)
export const INTR_SOFT_STOP = 4; // bit 2: a soft stop of the current call (PR 5a)
export const INTR_GRADING = 8; //   bit 3: a grading allowance is armed (item G; persistent)

/** Request a Ctrl-C: bit 0 set, the others left; and wake a time.sleep
 * waiting on the word. */
export function requestCtrlC(intr: Int32Array = INTR): void {
  Atomics.or(intr, 0, INTR_CTRL_C);
  if (intr.buffer instanceof SharedArrayBuffer) Atomics.notify(intr, 0);
}

/** Whether a Ctrl-C is pending (bit 0), the others ignored. */
export function ctrlCPending(intr: Int32Array = INTR): boolean {
  return (Atomics.load(intr, 0) & INTR_CTRL_C) !== 0;
}

/** Take a pending Ctrl-C: bit 0 cleared, atomically, the others left; true
 * if it was set. */
export function consumeCtrlC(intr: Int32Array = INTR): boolean {
  return (Atomics.and(intr, 0, ~INTR_CTRL_C) & INTR_CTRL_C) !== 0;
}
