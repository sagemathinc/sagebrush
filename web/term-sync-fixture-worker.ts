// A worker for web/test-term-sync.mjs: the worker's side of the Terminal command's file channel (web/term-sync.ts),
// running a script of requests the test sends, and posting each one's outcome.  `stopAt` makes the worker itself
// latch the channel at a named point of a request (as the page's Stop would, with the same stores), so a test can
// put a Stop exactly between a check and a publication.
import { WorkerChannel, ST, SL } from "./term-sync";

self.onmessage = (e: MessageEvent) => {
  const { control, data, gen, steps, stopAt, waitMs, closedOnly } = e.data;
  const c = new Int32Array(control);
  let armed = stopAt ?? null;
  const ch = new WorkerChannel({
    control, data, gen, waitMs,
    post: (m) => (self as any).postMessage({ msg: m }),
    hook: (point) => {
      if (armed !== null && point === armed) {
        armed = null;
        Atomics.store(c, SL.CLOSED, 1);
        // (closedOnly: the Stop caught between its two stores, CLOSED set and CANCELLED not yet)
        if (!closedOnly) {
          Atomics.store(c, SL.STATE, ST.CANCELLED);
          Atomics.notify(c, SL.STATE);
        }
      }
    },
  });
  for (const s of steps) {
    try {
      const body = s.bodyLength !== undefined ? new Uint8Array(s.bodyLength).map((_, i) => (i * 7 + 3) & 255) : undefined;
      const r: any = ch.request({ op: s.op, args: s.args ?? {} }, { body, max: s.max });
      (self as any).postMessage({ done: { op: s.op, json: r.json, bytesLength: r.bytes?.length, bytesSum: r.bytes ? r.bytes.reduce((a: number, b: number) => (a + b) % 1000003, 0) : undefined } });
    } catch (err: any) {
      (self as any).postMessage({ done: { op: s.op, error: err?.constructor?.name, code: err?.code, message: String(err?.message) } });
    }
  }
  (self as any).postMessage({ end: true, state: Atomics.load(c, SL.STATE), closed: Atomics.load(c, SL.CLOSED) });
};
