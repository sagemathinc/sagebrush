// A fetch that can't hang: given up when no data arrives for STALL_LIMIT_MS, its response first, then each piece of its
// body, so a slow download that keeps moving finishes however long it takes, and one that stops ends in
// STALL_LIMIT_MS.  The library's chunks are fetched with it (web/worker.ts fetchBytes, and the page's fetches for the
// runner, web/notebook/runner-worker.js fetchFor): a chunk request that never settled held a Sage run queued for good,
// and every later Sage run in that page with it (the grader's plain-worker investigation, #488 #552 #529 #551).
//
// 20 s: in a passing run of web/test-runner.mjs's stuck case (Nov 3), the Sage chunks (13.6 MB the largest) were
// answered within 50 ms of being asked for and finished within 250 ms; 20 s is that whole download 80 times over,
// and the bound is between pieces of data, never on the whole download, so a slow network still gets there.
export const STALL_LIMIT_MS = 20000;

/** What a fetch that stalled throws: `stalled` true, saying for how long nothing came. */
export function stalledError(ms) {
  return Object.assign(new Error(`no data for ${ms / 1000} s`), { stalled: true });
}

/**
 * The bytes at `url` (fetch's `init`), or a throw: HTTP <status> (with `status`) for an answer that isn't ok,
 * stalledError for STALL_LIMIT_MS (`stallMs`) without data, or the fetch's own error.
 * @param {string} url
 * @param {RequestInit} [init]
 * @param {number} [stallMs]
 * @returns {Promise<Uint8Array>}
 */
export async function fetchMoving(url, init = {}, stallMs = STALL_LIMIT_MS) {
  const ac = new AbortController();
  // (a caller's own signal aborts it too, as its own error, never as a stall)
  const own = init.signal;
  if (own?.aborted) throw own.reason;
  const relay = () => ac.abort(own.reason);
  own?.addEventListener("abort", relay, { once: true });
  let stalled = false, timer;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => ((stalled = true), ac.abort()), stallMs);
  };
  // (an error after the stall's abort is the stall's, whatever the browser calls it)
  const why = (e) => (stalled ? stalledError(stallMs) : e);
  arm();
  try {
    let r;
    try {
      r = await fetch(url, { ...init, signal: ac.signal });
    } catch (e) {
      throw why(e);
    }
    if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status}`), { status: r.status });
    if (!r.body) {
      try {
        return new Uint8Array(await r.arrayBuffer());
      } catch (e) {
        throw why(e);
      }
    }
    const reader = r.body.getReader();
    const parts = [];
    let n = 0;
    for (;;) {
      arm();
      let x;
      try {
        x = await reader.read();
      } catch (e) {
        throw why(e);
      }
      if (x.done) break;
      parts.push(x.value);
      n += x.value.byteLength;
    }
    if (parts.length === 1) return parts[0];
    const out = new Uint8Array(n);
    let o = 0;
    for (const p of parts) {
      out.set(p, o);
      o += p.byteLength;
    }
    return out;
  } finally {
    clearTimeout(timer);
    own?.removeEventListener("abort", relay);
  }
}
