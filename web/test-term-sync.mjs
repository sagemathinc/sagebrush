// ci: web-browser/notebook order=226 runner=bun
// The Terminal command's file channel (web/term-sync.ts; PR 3a (b1) design r4 §3.4, §3.5), both ends: the page's
// side here, the worker's in a real Worker thread (web/term-sync-fixture-worker.ts), over SharedArrayBuffers with
// Atomics.wait.  Checks:
// - replies in windows: exactly 1 MiB, 1 MiB + 1 byte, 3.5 MiB; every byte; the page keeps no reply after the last;
// - a write admitted before any body moves, sent in windows, committed whole; refused at admission, no body moves;
// - a refusal is the program's error (its errno code), not a protocol error;
// - bounds before allocation: a reply past what was asked for; a forged total past the protocol cap;
// - a stale or mismatched window (another seq, a skipped offset) is a protocol error;
// - Stop: before the header, during the wait, between windows, at an injected point between a check and a CAS, in
//   the body of a write (nothing committed); after Stop every new request is cancelled (the latch is durable).
//   bun web/test-term-sync.mjs
import { join } from "node:path";

const here = new URL(".", import.meta.url).pathname;
const S = await import(join(here, "term-sync.ts"));
let failures = 0;
const ok = (cond, name) => {
  console.log((cond ? "ok   " : "FAIL ") + name);
  if (!cond) failures++;
};
setTimeout(() => {
  console.log("FAIL the test did not end within 120 s");
  process.exit(1);
}, 120_000).unref();

const MiB = 1 << 20;
const pattern = (n) => new Uint8Array(n).map((_, i) => (i * 7 + 3) & 255);
const sum = (b) => b.reduce((a, x) => (a + x) % 1000003, 0);

// One worker running `steps` against a page channel with `handler`.  `onPage(page, msg)` sees each worker message
// before the page serves it (a test can cancel there).  Resolves with the steps' outcomes and the end state.
function session(handler, steps, { stopAt, onPage, raw, waitMs = 20_000 } = {}) {
  const page = new S.PageChannel(7, handler);
  const w = new Worker(join(here, "term-sync-fixture-worker.ts"));
  const done = [];
  return new Promise((resolve) => {
    w.onmessage = async (e) => {
      const m = e.data;
      if (m.msg) {
        if (onPage) await onPage(page, m.msg);
        if (raw) return raw(page, m.msg);
        try {
          await page.onMessage(m.msg);
        } catch (err) {
          done.push({ pageError: String(err?.message) });
        }
      } else if (m.done) done.push(m.done);
      else if (m.end) {
        w.terminate();
        resolve({ done, end: m, page });
      }
    };
    w.postMessage({ control: page.control, data: page.data, gen: 7, steps, stopAt, waitMs });
  });
}

// ---------------------------------------------------------------- replies in windows
{
  const files = { a: pattern(MiB), b: pattern(MiB + 1), c: pattern(3.5 * MiB), z: new Uint8Array(0) };
  const r = await session(async (h) => (h.op === "read" ? { bytes: files[h.args.path] } : { json: { kind: "file", size: 5 } }), [
    { op: "stat", args: { path: "x" } }, { op: "read", args: { path: "a" } }, { op: "read", args: { path: "b" } }, { op: "read", args: { path: "c" } }, { op: "read", args: { path: "z" } },
  ]);
  ok(JSON.stringify(r.done[0].json) === JSON.stringify({ kind: "file", size: 5 }), "a JSON answer");
  for (const [i, k] of [[1, "a"], [2, "b"], [3, "c"], [4, "z"]])
    ok(r.done[i].bytesLength === files[k].length && r.done[i].bytesSum === sum(files[k]), `a reply of ${files[k].length} bytes, every byte, in windows`);
  ok(r.end.state === S.ST.IDLE && r.page.retained() === 0, "settled: the channel IDLE, and the page keeps no reply");
}

// ---------------------------------------------------------------- writes
{
  let got = null, admitted = 0;
  const r = await session(async (h) => {
    if (h.args.refuse) return { error: { code: "EACCES", message: "w: Permission denied" } };
    admitted++;
    return { admit: async (body) => ((got = body), { json: { fid: "f1", rev: 2 } }) };
  }, [{ op: "write", args: { path: "w" }, bodyLength: 2.5 * MiB }, { op: "write", args: { path: "w", refuse: true }, bodyLength: 3 * MiB }]);
  ok(got && got.length === 2.5 * MiB && sum(got) === sum(pattern(2.5 * MiB)) && JSON.stringify(r.done[0].json) === JSON.stringify({ fid: "f1", rev: 2 }), "a 2.5 MiB write: admitted, sent in windows, committed whole");
  ok(r.done[1].error === "Refused" && r.done[1].code === "EACCES" && admitted === 1, `refused at admission: the program's EACCES, and no body moved (${JSON.stringify(r.done[1])})`);
}

// ---------------------------------------------------------------- refusals and bounds
{
  const r = await session(async (h) => (h.op === "read" ? { bytes: pattern(5000) } : { error: { code: "ENOENT", message: "q: No such file or directory" } }), [
    { op: "stat", args: { path: "q" } }, { op: "read", args: { path: "p" }, max: 4999 },
  ]);
  ok(r.done[0].error === "Refused" && r.done[0].code === "ENOENT", "a refusal is the program's error, with its code");
  ok(r.done[1].error === "ProtocolError" && /past the 4999 asked for/.test(r.done[1].message), `a reply past what was asked for is refused before allocation (${r.done[1].message})`);
}
{
  // (a forged total past the cap: the page's slots written by hand; Int32 holds 2^31 as -2^31, refused either way)
  const r = await session(null, [{ op: "read", args: { path: "p" } }], {
    raw: (page, m) => {
      const c = new Int32Array(page.control);
      Atomics.store(c, S.SL.GEN, 7); Atomics.store(c, S.SL.SEQ, m.fsSync.seq); Atomics.store(c, S.SL.STATUS, S.STATUS.BYTES);
      Atomics.store(c, S.SL.OFFSET, 0); Atomics.store(c, S.SL.WLEN, 10); Atomics.store(c, S.SL.TOTAL, 2 ** 31);
      Atomics.compareExchange(c, S.SL.STATE, S.ST.WAITING, S.ST.READY); Atomics.notify(c, S.SL.STATE);
    },
  });
  ok(r.done[0].error === "ProtocolError" && /out of bounds/.test(r.done[0].message), `a forged total of 2^31 is refused before allocation (${r.done[0].message})`);
}
{
  // (a window for another request: the wrong seq)
  const r = await session(null, [{ op: "read", args: { path: "p" } }], {
    raw: (page, m) => {
      const c = new Int32Array(page.control);
      Atomics.store(c, S.SL.GEN, 7); Atomics.store(c, S.SL.SEQ, m.fsSync.seq + 1); Atomics.store(c, S.SL.STATUS, S.STATUS.BYTES);
      Atomics.store(c, S.SL.OFFSET, 0); Atomics.store(c, S.SL.WLEN, 1); Atomics.store(c, S.SL.TOTAL, 1);
      Atomics.compareExchange(c, S.SL.STATE, S.ST.WAITING, S.ST.READY); Atomics.notify(c, S.SL.STATE);
    },
  });
  ok(r.done[0].error === "ProtocolError" && /another request/.test(r.done[0].message), `a window for another seq is refused (${r.done[0].message})`);
}
{
  // (a continuation at a skipped offset: the page refuses it)
  const page = new S.PageChannel(3, async () => ({ bytes: pattern(3 * MiB) }));
  const c = new Int32Array(page.control);
  Atomics.store(c, S.SL.STATE, S.ST.WAITING);
  await page.onMessage({ fsSync: { gen: 3, seq: 1, op: "read", args: {} } });
  Atomics.store(c, S.SL.STATE, S.ST.WAITING);
  let err = null;
  try {
    await page.onMessage({ fsMore: { gen: 3, seq: 1, offset: 2 * MiB } });
  } catch (e) {
    err = e;
  }
  ok(err instanceof S.ProtocolError && /out of order/.test(err.message), "a continuation at a skipped offset is refused by the page");
}

// ---------------------------------------------------------------- Stop
{
  // before the header: the latch already set
  const r = await session(async () => ({ json: 1 }), [{ op: "stat", args: {} }, { op: "stat", args: {} }], { stopAt: "before-header" });
  ok(r.done.every((d) => d.error === "Cancelled") && r.end.closed === 1, "Stop before the header: cancelled, and every later request too (the latch is durable)");
}
{
  // during the wait: the page cancels while its handler is pending
  let release;
  const r = await session(() => new Promise((res) => (release = res)), [{ op: "stat", args: {} }], {
    onPage: (page) => setTimeout(() => (page.cancel(), release({ json: 1 })), 50),
  });
  ok(r.done[0].error === "Cancelled" && r.end.state === S.ST.CANCELLED, "Stop during the wait: cancelled; the late answer changes nothing");
}
{
  // between windows of a reply
  let n = 0;
  const r = await session(async () => ({ bytes: pattern(3.5 * MiB) }), [{ op: "read", args: {} }], {
    onPage: (page, m) => {
      if (m.fsMore && ++n === 2) page.cancel();
    },
  });
  ok(r.done[0].error === "Cancelled", "Stop between a reply's windows: cancelled");
}
for (const at of ["cas:0->1", "cas:5->1", "cas:5->0", "before-body", "cas:2->3"]) {
  // injected: the worker latches the channel exactly at a check-to-publication point
  let committed = false;
  const steps = at === "before-body" || at === "cas:2->3" ? [{ op: "write", args: {}, bodyLength: 2 * MiB }] : [{ op: "read", args: {} }];
  const r = await session(async (h) => (h.op === "write" ? { admit: async () => ((committed = true), { json: 1 }) } : { bytes: pattern(2 * MiB) }), steps, { stopAt: at });
  ok(r.done[0].error === "Cancelled" && !committed && r.end.closed === 1 && r.end.state === S.ST.CANCELLED, `Stop injected at ${at}: cancelled, nothing committed, the channel stays CANCELLED (${JSON.stringify(r.done[0])})`);
}
{
  // in the body of a write: nothing committed
  let committed = false, n = 0;
  const r = await session(async () => ({ admit: async () => ((committed = true), { json: 1 }) }), [{ op: "write", args: {}, bodyLength: 3 * MiB }], {
    onPage: (page, m) => {
      if (m.fsMore && ++n === 2) page.cancel();
    },
  });
  ok(r.done[0].error === "Cancelled" && !committed, "Stop in a write's body: cancelled, and nothing committed");
}

console.log(failures ? `${failures} FAILED` : "all ok");
process.exit(failures ? 1 : 0);
