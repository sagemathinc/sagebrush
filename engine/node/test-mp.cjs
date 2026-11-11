// The native multiprecision core's buffer lifecycle (src/mp.rs): run after engine/node/build.sh as
// node engine/node/test-mp.cjs [path to sagebrush.node].  Checks: a buffer detached behind the core is
// refused with an error and the next call is exact; growth detaches the old buffer (a stale view reads
// nothing); each worker has its own session, Stop (mp_interrupt) is per session: an idle or late request has no
// effect, a concurrent worker's call runs on; terminating a worker leaves the main thread's exact.
const { Worker, isMainThread, parentPort, workerData } = require("node:worker_threads");
const path = require("node:path");
const addon = workerData?.addon ?? process.argv[2] ?? path.join(__dirname, "sagebrush.node");
const N = require(addon).mp;

// isqrt(x) through the core's registers, x < 2^32
function isqrt(x) {
  const q = N.mp_io(1) >> 2, u = new Uint32Array(N.mp_buffer());
  u[q] = x >>> 0;
  u[q + 1] = 0;
  if (N.mp_set_ix(0, 0, 1) < 0 || N.mp_run(24, 0, 0) !== 1 || N.mp_out(0) !== 2) throw new Error("isqrt call");
  return new Float64Array(N.mp_buffer(), 0, 8)[0];
}

// pi to `bits` bits in the core (pi_fixed), on this thread: [outcome, ms]
function pi(bits) {
  const t = Date.now();
  try {
    N.mp_run(19, bits, 0);
    return ["done", Date.now() - t];
  } catch (e) {
    return [e.message, Date.now() - t];
  }
}

if (!isMainThread) {
  if (workerData.pi) {
    // (commands from the main thread: "pi" runs the long call, posting "go" and the session id just
    // before it starts; "isqrt" a short one; "end" ends)
    parentPort.on("message", (m) => {
      if (m === "pi") {
        parentPort.postMessage({ go: N.mp_session() });
        parentPort.postMessage({ r: pi(workerData.pi) });
      } else if (m === "isqrt") parentPort.postMessage({ isqrt: isqrt(12345) });
      else process.exit(0);
    });
    parentPort.postMessage({ ready: true });
  } else {
    let s = 0;
    for (let i = 0; i < workerData.n; i++) s += isqrt(i * i + i); // = i
    parentPort.postMessage(s);
  }
} else {
  let bad = 0;
  const ok = (c, what) => {
    bad += !c;
    console.log((c ? "ok   " : "FAIL ") + what);
  };
  ok(isqrt(12345) === 111, "isqrt(12345) = 111");
  const b = N.mp_buffer();
  structuredClone(b, { transfer: [b] });
  let refused = false;
  try {
    N.mp_set_ix(0, 0, 1);
  } catch (e) {
    refused = /detached or resized/.test(e.message);
  }
  ok(refused, "a buffer detached behind the core is refused");
  ok(isqrt(12345) === 111, "the next call is exact");
  const old = new Uint32Array(N.mp_buffer());
  N.mp_io(100000);
  ok(old.length === 0 && N.mp_buffer().byteLength >= 800064, "growth detaches the old buffer");
  ok(isqrt(99999999) === 9999, "exact after growth");
  const run = (n) =>
    new Promise((res, rej) => {
      const w = new Worker(__filename, { workerData: { addon, n } });
      w.on("message", res);
      w.on("error", rej);
    });
  (async () => {
    const want = (n) => { let s = 0; for (let i = 0; i < n; i++) s += i; return s; };
    const [a, c] = await Promise.all([run(2000), run(3000)]);
    ok(a === want(2000) && c === want(3000), "two workers, each its own session, exact");
    // Stop is per session: mp_interrupt(id) stops that session's running call only.  A worker driven by
    // messages: next(w) is its next message.
    const BITS = 12e6;
    const full = pi(BITS);
    N.mp_reset();
    const spawn = () => {
      const w = new Worker(__filename, { workerData: { addon, pi: BITS } });
      const q = [], waiting = [];
      w.on("message", (m) => (waiting.length ? waiting.shift()(m) : q.push(m)));
      w.next = () => (q.length ? Promise.resolve(q.shift()) : new Promise((r) => waiting.push(r)));
      return w;
    };
    // an idle request on the main session: no effect on its next call
    N.mp_interrupt(N.mp_session());
    ok(isqrt(12345) === 111, "an idle Stop of the main session leaves its next call exact");
    // a worker's long call stopped from the main thread, mid-run
    const wa = spawn(), wb = spawn();
    await wa.next();
    await wb.next();
    wa.postMessage("pi");
    wb.postMessage("pi");
    const ida = (await wa.next()).go, idb = (await wb.next()).go;
    await new Promise((r) => setTimeout(r, Math.min(300, full[1] / 4)));
    N.mp_interrupt(ida);
    const ra = (await wa.next()).r, rb = (await wb.next()).r;
    console.log("     pi to", BITS, "bits:", full, "; stopped:", ra, "; the other:", rb);
    ok(ida !== idb, "each worker its own session");
    ok(full[0] === "done" && ra[0] === "the multiprecision core was interrupted (Stop)" && ra[1] < full[1] / 2,
      "Stop of one session ends that worker's native call mid-run");
    ok(rb[0] === "done", "the other worker's concurrent call runs to its end");
    ok((await (wa.postMessage("isqrt"), wa.next())).isqrt === 111, "the stopped worker's session exact after its Stop");
    // a late request, after the call ended: no effect on the session's next call
    N.mp_interrupt(idb);
    ok((await (wb.postMessage("isqrt"), wb.next())).isqrt === 111, "a late Stop leaves that session's next call exact");
    ok(isqrt(12345) === 111, "the main thread exact throughout");
    wa.postMessage("end");
    wb.postMessage("end");
    // a worker terminated while it is inside a native call: the main thread's session is untouched
    const w = spawn();
    await w.next();
    w.postMessage("pi");
    await w.next();
    await new Promise((r) => setTimeout(r, 100));
    await w.terminate();
    ok(isqrt(12345) === 111, "the main thread exact after a worker is terminated inside a native call");
    process.exit(bad ? 1 : 0);
  })().catch((e) => {
    console.log("FAIL", e);
    process.exit(1);
  });
}
