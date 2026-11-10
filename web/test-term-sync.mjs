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
function session(handler, steps, { stopAt, onPage, raw, waitMs = 20_000, pageHook, closedOnly } = {}) {
  const page = new S.PageChannel(7, handler, pageHook ? (pt) => pageHook(page, pt) : undefined);
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
    w.postMessage({ control: page.control, data: page.data, gen: 7, steps, stopAt, waitMs, closedOnly });
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
  // (a forged negative total with an empty window: refused before any allocation)
  const r = await session(null, [{ op: "read", args: { path: "p" } }], {
    raw: (page, m) => {
      const c = new Int32Array(page.control);
      Atomics.store(c, S.SL.GEN, 7); Atomics.store(c, S.SL.SEQ, m.fsSync.seq); Atomics.store(c, S.SL.STATUS, S.STATUS.BYTES);
      Atomics.store(c, S.SL.OFFSET, 0); Atomics.store(c, S.SL.WLEN, 0); Atomics.store(c, S.SL.TOTAL, -5);
      Atomics.compareExchange(c, S.SL.STATE, S.ST.WAITING, S.ST.READY); Atomics.notify(c, S.SL.STATE);
    },
  });
  ok(r.done[0].error === "ProtocolError" && /out of bounds/.test(r.done[0].message), `a forged negative total is refused before allocation (${r.done[0].error}: ${r.done[0].message})`);
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

{
  // (a duplicate continuation: the same offset twice; the page refuses the second)
  const page = new S.PageChannel(3, async () => ({ bytes: pattern(3 * MiB) }));
  const c = new Int32Array(page.control);
  Atomics.store(c, S.SL.STATE, S.ST.WAITING);
  await page.onMessage({ fsSync: { gen: 3, seq: 1, op: "read", args: {} } });
  Atomics.store(c, S.SL.STATE, S.ST.WAITING);
  await page.onMessage({ fsMore: { gen: 3, seq: 1, offset: MiB } });
  Atomics.store(c, S.SL.STATE, S.ST.WAITING);
  let err = null;
  try {
    await page.onMessage({ fsMore: { gen: 3, seq: 1, offset: MiB } });
  } catch (e) {
    err = e;
  }
  ok(err instanceof S.ProtocolError, "a duplicate continuation (the same offset twice) is refused by the page");
  // (a header out of sequence: seq 3 after 1)
  let err2 = null;
  try {
    await page.onMessage({ fsSync: { gen: 3, seq: 3, op: "read", args: {} } });
  } catch (e) {
    err2 = e;
  }
  ok(err2 instanceof S.ProtocolError, "a request header out of sequence is refused by the page");
}
{
  // (the previous request never settled: the channel isn't IDLE, so the next request's first edge is a protocol error)
  const control = new SharedArrayBuffer(S.CONTROL_BYTES), data = new SharedArrayBuffer(S.WINDOW);
  Atomics.store(new Int32Array(control), S.SL.STATE, S.ST.READY);
  const w = new S.WorkerChannel({ control, data, gen: 1, post: () => {} });
  let err = null;
  try {
    w.request({ op: "stat", args: {} });
  } catch (e) {
    err = e;
  }
  ok(err instanceof S.ProtocolError && /not 0/.test(err.message), `a request when the last one never settled (the missing final edge): a protocol error (${err?.message})`);
}
{
  // (the channel's own sizes and generation, exactly: a control buffer of another size, aligned or not, or a gen past
  // Int32 (it would alias in the GEN slot) is a protocol error at construction, before any request)
  const data = new SharedArrayBuffer(S.WINDOW);
  const make = (bytes, gen) => {
    try {
      new S.WorkerChannel({ control: new SharedArrayBuffer(bytes), data, gen, post: () => {} });
      return "made";
    } catch (e) {
      return e instanceof S.ProtocolError ? "refused" : String(e);
    }
  };
  const got = [make(S.CONTROL_BYTES - 4, 1), make(S.CONTROL_BYTES + 1, 1), make(S.CONTROL_BYTES + 64, 1), make(S.CONTROL_BYTES, S.CAP + 1), make(S.CONTROL_BYTES, -1), make(S.CONTROL_BYTES, S.CAP), make(S.CONTROL_BYTES, 0)];
  ok(JSON.stringify(got) === JSON.stringify(["refused", "refused", "refused", "refused", "refused", "made", "made"]), `control buffers of 60, 65, 128 bytes and gens CAP+1, -1 refused; gens CAP and 0 made (${got})`);
}
{
  // (a page that never wakes the worker: the injected deadline reports it, never a hang)
  const r = await session(null, [{ op: "stat", args: {} }], { raw: () => {}, waitMs: 300 });
  ok(r.done[0].error === "ProtocolError" && /deadline/.test(r.done[0].message), `a missing answer is reported at the injected deadline (${r.done[0].message})`);
}

{
  // (a window at the wrong offset: the page publishes window 0 again where the next is due)
  let sent = 0;
  const r = await session(null, [{ op: "read", args: { path: "p" } }], {
    raw: (page, m) => {
      const c = new Int32Array(page.control);
      const seq = m.fsSync ? m.fsSync.seq : m.fsMore.seq;
      Atomics.store(c, S.SL.GEN, 7); Atomics.store(c, S.SL.SEQ, seq); Atomics.store(c, S.SL.STATUS, S.STATUS.BYTES);
      Atomics.store(c, S.SL.OFFSET, 0); Atomics.store(c, S.SL.WLEN, MiB); Atomics.store(c, S.SL.TOTAL, 2 * MiB);
      sent++;
      Atomics.compareExchange(c, S.SL.STATE, S.ST.WAITING, S.ST.READY); Atomics.notify(c, S.SL.STATE);
    },
  });
  ok(r.done[0].error === "ProtocolError" && /a window at 0, not 1048576/.test(r.done[0].message) && sent === 2, `a window at the wrong offset is refused before its bytes are taken (${r.done[0].message})`);
}

{
  // (a write the page answers with success without admitting it: the body never moved, so the worker refuses it)
  const r = await session(null, [{ op: "write", args: {}, bodyLength: 5 }], {
    raw: (page, m) => {
      const c = new Int32Array(page.control);
      const bytes = new TextEncoder().encode(JSON.stringify({ fid: "x", rev: 1 }));
      new Uint8Array(page.data).set(bytes);
      Atomics.store(c, S.SL.GEN, 7); Atomics.store(c, S.SL.SEQ, m.fsSync.seq); Atomics.store(c, S.SL.STATUS, S.STATUS.JSON);
      Atomics.store(c, S.SL.OFFSET, 0); Atomics.store(c, S.SL.WLEN, bytes.length); Atomics.store(c, S.SL.TOTAL, bytes.length);
      Atomics.compareExchange(c, S.SL.STATE, S.ST.WAITING, S.ST.READY); Atomics.notify(c, S.SL.STATE);
    },
  });
  ok(r.done[0].error === "ProtocolError" && /without admitting/.test(r.done[0].message), `a write answered "done" without its admission is refused: no success without the body (${r.done[0].message})`);
}

{
  // (a path past PATH_MAX in any of a request's paths, a rename's from and to included: refused before posting)
  const long = "/w/" + "x".repeat(S.PATH_MAX);
  const r = await session(async () => ({ json: 1 }), [{ op: "rename", args: { from: long, to: "/w/b" } }, { op: "rename", args: { from: "/w/a", to: long } }, { op: "stat", args: { path: long } }]);
  ok(r.done.every((d) => d.error === "Refused" && d.code === "ENAMETOOLONG"), `a path past PATH_MAX (a rename's from or to, or a path) is refused before posting (${r.done.map((d) => d.code)})`);
}

// ---------------------------------------------------------------- forged windows, each refused by the worker (TESTS 976-1)
const forge = (fn) => (page, m) => {
  const c = new Int32Array(page.control);
  const seq = m.fsSync ? m.fsSync.seq : m.fsMore.seq;
  fn(c, seq, m, page);
  Atomics.notify(c, S.SL.STATE);
};
const put = (c, f) => { for (const [k, v] of Object.entries(f)) Atomics.store(c, S.SL[k], v); };
for (const [what, steps, raw, re] of [
  ["a window of another generation", [{ op: "stat", args: {} }], forge((c, seq) => { put(c, { GEN: 8, SEQ: seq, STATUS: S.STATUS.JSON, OFFSET: 0, WLEN: 1, TOTAL: 1 }); Atomics.compareExchange(c, S.SL.STATE, S.ST.WAITING, S.ST.READY); }), /another request/],
  ["a TOTAL that changes in window 2", [{ op: "read", args: {} }], forge((c, seq, m) => { put(c, { GEN: 7, SEQ: seq, STATUS: S.STATUS.BYTES, OFFSET: m.fsSync ? 0 : MiB, WLEN: MiB, TOTAL: m.fsSync ? 2 * MiB : 3 * MiB }); Atomics.compareExchange(c, S.SL.STATE, S.ST.WAITING, S.ST.READY); }), /out of bounds/],
  ["an empty window before the end", [{ op: "read", args: {} }], forge((c, seq) => { put(c, { GEN: 7, SEQ: seq, STATUS: S.STATUS.BYTES, OFFSET: 0, WLEN: 0, TOTAL: 10 }); Atomics.compareExchange(c, S.SL.STATE, S.ST.WAITING, S.ST.READY); }), /empty window before the end/],
  ["a STATUS that changes between windows", [{ op: "read", args: {} }], forge((c, seq, m) => { put(c, { GEN: 7, SEQ: seq, STATUS: m.fsSync ? S.STATUS.BYTES : S.STATUS.JSON, OFFSET: m.fsSync ? 0 : MiB, WLEN: MiB, TOTAL: 2 * MiB }); Atomics.compareExchange(c, S.SL.STATE, S.ST.WAITING, S.ST.READY); }), /status changed/],
  ["an ACK after the last body window", [{ op: "write", args: {}, bodyLength: 10 }], forge((c, seq, m) => { if (m.fsSync) { put(c, { GEN: 7, SEQ: seq }); Atomics.compareExchange(c, S.SL.STATE, S.ST.WAITING, S.ST.ADMITTED); } else Atomics.compareExchange(c, S.SL.STATE, S.ST.BODY, S.ST.ACK); }), /ACK after the last body window/],
]) {
  const r = await session(null, steps, { raw, waitMs: 3000 });
  ok(r.done[0].error === "ProtocolError" && re.test(r.done[0].message), `${what}: refused by the worker (${r.done[0].message})`);
}

// ---------------------------------------------------------------- the page's own checks (TESTS 976-2)
for (const length of [-1, S.CAP + 1, 1.5]) {
  const page = new S.PageChannel(3, async () => ({ admit: async () => ({ json: 1 }) }));
  Atomics.store(new Int32Array(page.control), S.SL.STATE, S.ST.WAITING);
  let err = null;
  try {
    await page.onMessage({ fsSync: { gen: 3, seq: 1, op: "write", args: {}, length } });
  } catch (e) {
    err = e;
  }
  ok(err instanceof S.ProtocolError, `a header declaring length ${length} is refused by the page`);
}
{
  let commits = 0;
  const page = new S.PageChannel(3, async () => ({ admit: async () => (commits++, { json: 1 }) }));
  const c = new Int32Array(page.control);
  Atomics.store(c, S.SL.STATE, S.ST.WAITING);
  await page.onMessage({ fsSync: { gen: 3, seq: 1, op: "write", args: {}, length: 10 } });
  put(c, { SEQ: 1, OFFSET: 0, WLEN: 10, TOTAL: 11, STATE: S.ST.BODY });
  let err = null;
  try {
    await page.onMessage({ fsMore: { gen: 3, seq: 1, offset: 0 } });
  } catch (e) {
    err = e;
  }
  ok(err instanceof S.ProtocolError && commits === 0, `a body whose TOTAL isn't the admitted length is refused, nothing committed (${err?.message})`);
}

// ---------------------------------------------------------------- PATH_MAX, exactly (TESTS 976-5)
{
  const at = "/" + "x".repeat(S.PATH_MAX - 1), over = "/" + "x".repeat(S.PATH_MAX);
  const r = await session(async () => ({ json: { ok: 1 } }), [{ op: "stat", args: { path: at } }, { op: "stat", args: { path: over } }]);
  ok(r.done[0].json?.ok === 1 && r.done[1].error === "Refused" && r.done[1].code === "ENAMETOOLONG", `a path of PATH_MAX bytes is sent; PATH_MAX + 1 is refused (${JSON.stringify(r.done.map((d) => d.code ?? "ok"))})`);
}

// ---------------------------------------------------------------- no reply kept after a non-empty one (TESTS 976-6)
{
  const r = await session(async () => ({ bytes: pattern(3.5 * MiB) }), [{ op: "read", args: {} }]);
  ok(r.done[0].bytesLength === 3.5 * MiB && r.page.retained() === 0, `after the last window of a 3.5 MiB reply, the page keeps nothing (${r.page.retained()})`);
}

// ---------------------------------------------------------------- Stop
{
  // (TESTS 976-3: a Stop at before-body: the data window is never touched)
  const r = await session(async () => ({ admit: async () => ({ json: 1 }) }), [{ op: "write", args: {}, bodyLength: 64 }], { stopAt: "before-body" });
  const untouched = new Uint8Array(r.page.data).subarray(0, 64).every((b) => b === 0);
  ok(r.done[0].error === "Cancelled" && untouched, `Stop before the body's first window: cancelled, and the data window untouched (${untouched})`);
}
{
  // (TESTS 976-4: a Stop at the page's before-commit point: nothing committed)
  let committed = false;
  const r = await session(async () => ({ admit: async () => ((committed = true), { json: 1 }) }), [{ op: "write", args: {}, bodyLength: 10 }], {
    pageHook: (page, pt) => {
      if (pt === "before-commit") page.cancel();
    },
  });
  ok(r.done[0].error === "Cancelled" && !committed, "Stop at the page's commit point: cancelled, nothing committed");
}
{
  // the page's own publication raced by Stop: cancelled at the page's WAITING->READY edge, the CANCELLED stays
  const r = await session(async () => ({ json: 1 }), [{ op: "stat", args: {} }], {
    pageHook: (page, pt) => {
      if (pt === `cas:${S.ST.WAITING}->${S.ST.READY}`) page.cancel();
    },
  });
  ok(r.done[0].error === "Cancelled" && r.end.state === S.ST.CANCELLED, "Stop at the page's own publishing edge: the answer never lands, the channel stays CANCELLED");
}
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
for (const at of ["cas:5->0", "cas:0->1", "cas:2->3"]) {
  // (SEC-CANCEL-2: the Stop between its two stores, CLOSED set and CANCELLED not yet: the CAS succeeds, and still the
  // request must not return as settled; at ADMITTED->BODY a write's)
  const steps = at === "cas:2->3" ? [{ op: "write", args: {}, bodyLength: 10 }] : [{ op: "stat", args: {} }];
  const r = await session(async (h) => (h.op === "write" ? { admit: async () => ({ json: 1 }) } : { json: { ok: 1 } }), steps, { stopAt: at, closedOnly: true, waitMs: 2000 });
  ok(r.done[0].error === "Cancelled" && r.end.closed === 1, `Stop caught between its two stores at ${at}: the request is cancelled, never settled (${JSON.stringify(r.done[0])})`);
}
{
  // (SEC-ONCE-4: a zero-length body's commit runs exactly once, whatever continuations arrive while it runs)
  let commits = 0, release;
  const page = new S.PageChannel(3, async () => ({ admit: (b) => (commits++, new Promise((res) => (release = () => res({ json: { n: b.length } })))) }));
  const c = new Int32Array(page.control);
  Atomics.store(c, S.SL.STATE, S.ST.WAITING);
  await page.onMessage({ fsSync: { gen: 3, seq: 1, op: "write", args: {}, length: 0 } });
  const body = () => {
    Atomics.store(c, S.SL.SEQ, 1); Atomics.store(c, S.SL.OFFSET, 0); Atomics.store(c, S.SL.WLEN, 0); Atomics.store(c, S.SL.TOTAL, 0);
    Atomics.store(c, S.SL.STATE, S.ST.BODY);
  };
  body();
  const first = page.onMessage({ fsMore: { gen: 3, seq: 1, offset: 0 } });
  body();
  let err = null;
  try {
    await page.onMessage({ fsMore: { gen: 3, seq: 1, offset: 0 } });
  } catch (e) {
    err = e;
  }
  release();
  await first;
  ok(commits === 1 && err instanceof S.ProtocolError, `a zero-length write: committed exactly once; a duplicate continuation while it commits is refused (${commits} commits, ${err?.message})`);
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
