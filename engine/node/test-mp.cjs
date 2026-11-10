// The native multiprecision core's buffer lifecycle (src/mp.rs): run after engine/node/build.sh as
// node engine/node/test-mp.cjs [path to sagebrush.node].  Checks: a buffer detached behind the core is
// refused with an error and the next call is exact; growth detaches the old buffer (a stale view reads
// nothing); each worker has its own session, and terminating one leaves the main thread's exact.
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

if (!isMainThread) {
  let s = 0;
  for (let i = 0; i < workerData.n; i++) s += isqrt(i * i + i); // = i
  parentPort.postMessage(s);
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
    const w = new Worker(__filename, { workerData: { addon, n: 1e9 } });
    await new Promise((r) => setTimeout(r, 50));
    await w.terminate();
    ok(isqrt(12345) === 111, "the main thread exact after a worker is terminated mid-run");
    process.exit(bad ? 1 : 0);
  })().catch((e) => {
    console.log("FAIL", e);
    process.exit(1);
  });
}
