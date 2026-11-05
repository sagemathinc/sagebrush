// Live data's page-side admission (design-data-access r3.1 §1, "One admission
// point"): every {liveData} message a worker sends, a plain Worker's or a
// RunnerWorker's (its frame forwards the operation unchanged and keeps the
// buffer, web/runner/index.html), comes here, from WorkerKernel.  Nothing in
// the message is trusted: it is checked again as it arrives (its form, its
// operation and parameters, src/live-data.ts), bound to the worker, its
// interpreter's generation, the run and the call that asked, and answered
// only while all of those still hold.  The key a worker gives (its tag and a
// count) correlates its answer; it authorizes nothing.  A worker keeps one tag
// and counts up, so its state here is that tag and the highest count seen (a
// fixed size, however many calls): a key of another tag, or a count not above
// the highest, is refused, never answered (astra's LIVE691-SEEN-1).
//
// The adapter does the fetching: it holds the reader's FRED key (page memory
// only, design §3.9) and attaches it on the way out, so the key never goes
// to the worker.  adapter.fetch(op, params, signal) gives the answer's JSON
// bytes, an async iterable of Uint8Array chunks ({dates, values}), or throws
// {code} with one of the closed error codes.  No adapter (until the broker
// and relay exist, step 4): every request is `unavailable`.
//
// Each call is bounded: at most LIVE_MAX_BYTES read (the stream is cut, and
// the call aborted, past it), in at most LIVE_MAX_PIECES pieces, empty ones
// counted too (astra's LIVE691-PARTS-1), copied as they come into one buffer
// that never grows past the bytes read, and LIVE_DEADLINE_MS long.  It is aborted (its
// signal) on Stop, on the deadline, on Forget or sign-out, and when the
// interpreter is replaced or closed; an aborted call's late result is
// dropped, never written.

import { checkParams, checkAnswer, LIVE_ERRORS, LIVE_MAX_BYTES, LIVE_DEADLINE_MS } from "../../src/live-data.ts";

const KEY = /^[a-z0-9]{1,16}\.[1-9][0-9]{0,8}$/;
const plain = (o) => o !== null && typeof o === "object" && !Array.isArray(o) && Object.getPrototypeOf(o) === Object.prototype;
const UNAVAILABLE = { error: "unavailable" };
// (the stream's pieces a call reads, empty ones too: past this it is unavailable, so a stream of tiny or empty
// pieces is bounded in work as its bytes are)
export const LIVE_MAX_PIECES = 4096;

export class LiveCalls {
  /**
   * @param {{fetch(op: string, params: object, signal: AbortSignal): Promise<AsyncIterable<Uint8Array>>} | null} adapter
   * @param {{deadlineMs?: number, maxBytes?: number}} [o]
   */
  constructor(adapter, { deadlineMs = LIVE_DEADLINE_MS, maxBytes = LIVE_MAX_BYTES, maxPieces = LIVE_MAX_PIECES } = {}) {
    this.adapter = adapter ?? null;
    this.deadlineMs = deadlineMs;
    this.maxBytes = maxBytes;
    this.maxPieces = maxPieces;
    // calls in flight: {worker, gen, id, key, ctrl, timer, done}
    this.calls = new Set();
    // per worker, its keys' tag and the highest count seen: {tag, high} (a key is answered at most once)
    this.seen = new WeakMap();
  }

  /**
   * A {liveData} message `m` from worker `w` of generation `gen`; `active()`
   * says whether the call may still be answered (its worker current, its run
   * in flight); `send(answer)` writes the answer where the worker waits.
   */
  admit(m, w, gen, active, send) {
    const d = m.liveData;
    const plainWorker = typeof SharedArrayBuffer === "function" && m.buffer instanceof SharedArrayBuffer;
    // (the buffer a plain worker waits on: its exact size, or none, a runner's frame having kept it)
    if (plainWorker && m.buffer.byteLength !== 8 + LIVE_MAX_BYTES) return;
    if (!plainWorker && m.buffer != null) return;
    if (!Number.isInteger(m.id) || !plain(d) || Object.keys(d).length !== 3 || typeof d.key !== "string" || !KEY.test(d.key)) return send(UNAVAILABLE);
    const [tag, count] = [d.key.slice(0, d.key.indexOf(".")), Number(d.key.slice(d.key.indexOf(".") + 1))];
    const seen = this.seen.get(w);
    // (another tag, or a count not above the highest: a key asked before, or never this worker's: nothing, and
    // never an earlier answer)
    if (seen && (seen.tag !== tag || count <= seen.high)) return;
    if (seen) seen.high = count;
    else this.seen.set(w, { tag, high: count });
    const c = checkParams(d.op, d.params);
    if ("refused" in c || !active()) return send(UNAVAILABLE);
    if (!this.adapter) return send(UNAVAILABLE);
    // (one call per run: an earlier one of the same run, still open, is over)
    for (const o of this.calls) if (o.worker === w && o.id === m.id) this.finish(o);
    const call = { worker: w, gen, id: m.id, key: d.key, ctrl: new AbortController(), timer: null, done: false };
    this.calls.add(call);
    const answer = (a) => {
      if (call.done) return;
      this.finish(call);
      if (active()) send(a);
    };
    call.timer = setTimeout(() => answer({ error: "timeout" }), this.deadlineMs);
    this.run(d.op, c.params, call).then(answer, (e) => answer({ error: LIVE_ERRORS.includes(e?.code) ? e.code : "unavailable" }));
  }

  async run(op, params, call) {
    const body = await this.adapter.fetch(op, params, call.ctrl.signal);
    // (each piece copied into one buffer as it comes, none kept: the buffer at most doubles past the bytes read,
    // and never past maxBytes)
    let buf = new Uint8Array(0);
    let n = 0, pieces = 0;
    for await (const chunk of body) {
      if (call.done) throw { code: "unavailable" };
      if (!(chunk instanceof Uint8Array)) throw { code: "unavailable" };
      // (cut as soon as it is over, in bytes or in pieces: no more of it is read or kept)
      if (++pieces > this.maxPieces || n + chunk.length > this.maxBytes) {
        call.ctrl.abort();
        throw { code: "unavailable" };
      }
      if (n + chunk.length > buf.length) {
        const b = new Uint8Array(Math.min(this.maxBytes, Math.max(n + chunk.length, 2 * buf.length, 4096)));
        b.set(buf.subarray(0, n));
        buf = b;
      }
      buf.set(chunk, n);
      n += chunk.length;
    }
    let ok;
    try {
      ok = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buf.subarray(0, n)));
    } catch {
      throw { code: "unavailable" };
    }
    return checkAnswer({ ok });
  }

  finish(call) {
    if (call.done) return;
    call.done = true;
    clearTimeout(call.timer);
    call.ctrl.abort();
    this.calls.delete(call);
  }

  /** Abort the calls `which` picks (all by default): Stop (a run's), Forget,
   * sign-out, an interpreter replaced or closed.  None of them is answered. */
  abort(which = () => true) {
    for (const c of [...this.calls]) if (which(c)) this.finish(c);
  }
}
