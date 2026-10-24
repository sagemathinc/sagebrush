import test from "node:test";
import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";

// Repeated Stops of an engine computation don't pile up dead engine
// instances (PR #112): a Stop traps the WebAssembly engine, the instance is
// dropped, and under Node its memory is collected at once (engine.ts
// reclaimEngine), so 20 back-to-back Stops of F4 (cyclic-8 mod 32003) keep the
// process's RSS within a bound, the session works after each Stop, and the gc
// handle used doesn't reach later contexts.  (Without the collection each
// Stop left about 60 MB for V8's next major collection: 387 -> 643 MB over
// five Stops on VM2.)
const DIST = __dirname + "/..";
const STOPS = 20;
const BOUND_MB = 128; // growth allowed over the RSS after the first Stop

const SETUP = [
  "import sage_all as S",
  "R = S.PolynomialRing(S.GF(32003), 'x', 8)",
  "X = R.gens()",
  "G = [sum(S.prod(X[(j + t) % 8] for t in range(d)) for j in range(8)) for d in range(1, 8)] + [S.prod(X) - 1]",
].join("\n");
const ONE = [
  SETUP,
  "try:",
  "    R.ideal(G).groebner_basis()",
  "    raise ValueError('finished before the Stop')",
  "except KeyboardInterrupt:",
  "    pass",
  "# the session works: a small basis on the same route",
  "x0, x1 = X[0], X[1]",
  "assert list(R.ideal([x0 - x1, x1 - 1]).groebner_basis()) == [x0 - 1, x1 - 1]",
].join("\n");

test("20 back-to-back Stops of F4 keep RSS bounded, the session working, and gc out of later contexts (PR #112)", async () => {
  const w = new Worker(
    `
    const { parentPort, workerData } = require("node:worker_threads");
    const c = require(workerData.dist + "/src/compile.js");
    Promise.resolve(c.initParser && c.initParser()).then(() => {
      c.R.importModule("sys").path.push(c.libDir());
      parentPort.postMessage({ intr: c.R.INTR.buffer });
      const rss = [];
      try {
        // (the first import of the library takes seconds: before any Stop)
        c.execModule(workerData.setup, "<setup>", "__main__");
        for (let i = 0; i < workerData.stops; i++) {
          parentPort.postMessage({ go: i });
          c.execModule(workerData.code, "<test>", "__main__");
          rss.push(Math.round(process.memoryUsage().rss / 1048576));
        }
        const vm = require("node:vm");
        parentPort.postMessage({ done: "ok", rss, gcHere: typeof globalThis.gc, gcFresh: vm.runInNewContext("typeof gc") });
      } catch (e) {
        parentPort.postMessage({ done: c.R.formatException(e).trim().split("\\n").pop(), rss });
      }
    });
    `,
    { eval: true, workerData: { dist: DIST, code: ONE, setup: SETUP, stops: STOPS } },
  );
  const r: any = await new Promise((resolve, reject) => {
    let intr: Int32Array | null = null;
    const timer = setTimeout(() => (w.terminate(), resolve({ done: "timed out" })), 300000);
    w.on("message", (m) => {
      if (m.intr) intr = new Int32Array(m.intr);
      // (Stop 1.5 s into each run: well inside F4, which takes about 5 s)
      if (m.go !== undefined) setTimeout(() => Atomics.store(intr!, 0, 1), 1500);
      if (m.done) (clearTimeout(timer), w.terminate(), resolve(m));
    });
    w.on("error", reject);
  });
  assert.equal(r.done, "ok", JSON.stringify(r));
  assert.equal(r.rss.length, STOPS);
  console.log(`RSS after each Stop (MB): ${r.rss.join(", ")}`);
  const growth = Math.max(...r.rss.slice(1)) - r.rss[0];
  assert.ok(growth <= BOUND_MB, `RSS after each Stop (MB): ${r.rss.join(", ")}; growth ${growth} MB over ${BOUND_MB}`);
  assert.equal(r.gcHere, "undefined", "gc leaked into the worker's global");
  assert.equal(r.gcFresh, "undefined", "gc leaked into a later context");
});
