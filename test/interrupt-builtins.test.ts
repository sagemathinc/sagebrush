import test from "node:test";
import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";

// Stop (the shared interrupt flag, INTR[0]) reaches a builtin that consumes
// a long iterable: math.fsum(range(10**12)) and math.prod(...) stop with a
// KeyboardInterrupt (ops.forEach polls it), as the notebook's Stop needs.
const DIST = __dirname + "/..";

function interruptAfter(code: string, ms: number): Promise<string> {
  const w = new Worker(
    `
    const { parentPort, workerData } = require("node:worker_threads");
    const c = require(workerData.dist + "/src/compile.js");
    Promise.resolve(c.initParser && c.initParser()).then(() => {
      parentPort.postMessage({ intr: c.R.INTR.buffer });
      try {
        c.execModule(workerData.code, "<test>", "__main__");
        parentPort.postMessage({ done: "finished" });
      } catch (e) {
        parentPort.postMessage({ done: c.R.formatException(e).trim().split("\\n").pop() });
      }
    });
    `,
    { eval: true, workerData: { dist: DIST, code } },
  );
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => (w.terminate(), resolve("not interrupted")), ms + 2000);
    w.on("message", (m) => {
      if (m.intr) setTimeout(() => Atomics.store(new Int32Array(m.intr), 0, 1), ms);
      if (m.done) (clearTimeout(timer), w.terminate(), resolve(m.done));
    });
    w.on("error", reject);
  });
}

test("Stop interrupts math.fsum and math.prod over a long range (HARD-2ED-1)", async () => {
  assert.equal(await interruptAfter("import math\nmath.fsum(range(10**12))", 300), "KeyboardInterrupt");
  assert.equal(await interruptAfter("import math\nmath.prod(range(1, 10**12))", 300), "KeyboardInterrupt");
});
