// input()'s wait in the browser worker (web/worker.ts's stdin): the run waits
// on a buffer the page (or the runner's frame, web/runner/index.html) fills.
// Int32 [0] the state (0 waiting, 1 a line, 2 end of input), [1] the line's
// length in bytes, then its UTF-8 bytes.  It waits in slices, so a Stop (bit
// 0 of the shared interrupt word) ends it; and a Stop wins over an answer: it
// is checked after every wake and again just before a line or the end of
// input is taken, so a Stop and a late answer landing during the same wait is
// a KeyboardInterrupt, never the line (daybreak3's INPUT-DB3-1).

export type StdinResult = string | null | { interrupted: true };

/** Wait for the answer in `buffer` (8 + max bytes), as above; `intr` is the
 * shared interrupt word (src/runtime/interrupt.ts INTR); `sliceMs` how long
 * each wait may sleep before Stop is checked again. */
export function waitForLine(buffer: SharedArrayBuffer, intr: Int32Array, sliceMs = 100): StdinResult {
  const ctl = new Int32Array(buffer, 0, 2);
  const stopped = () => (Atomics.load(intr, 0) & 1) !== 0;
  for (;;) {
    if (stopped()) return { interrupted: true };
    const state = Atomics.load(ctl, 0);
    if (state !== 0) break;
    Atomics.wait(ctl, 0, 0, sliceMs);
  }
  // (the answer is here: a Stop that came with it still wins)
  if (stopped()) return { interrupted: true };
  if (Atomics.load(ctl, 0) !== 1) return null;
  const max = buffer.byteLength - 8;
  const n = Math.min(Math.max(0, Atomics.load(ctl, 1)), max);
  // (copied out of shared memory first: TextDecoder refuses a shared view)
  return new TextDecoder().decode(new Uint8Array(buffer, 8, n).slice());
}
