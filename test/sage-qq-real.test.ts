import test from "node:test";
import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";

// QQ of a real number (lib/sage_all.py _simplest_rational): the precision
// limit is checked before any exact conversion, the largest admitted case
// (16384 bits, a continued fraction of all 1s) finishes in a bounded time,
// and Stop interrupts it (daybreak2's limits review of
// sage-qq-float-conversion).
const DIST = __dirname + "/..";

// The last line of what the code raised ("finished" if nothing); Stop is
// set after `stopAfter` ms (never when it is null).
function run(code: string, stopAfter: number | null, limit = 120000): Promise<string> {
  const w = new Worker(
    `
    const { parentPort, workerData } = require("node:worker_threads");
    const c = require(workerData.dist + "/src/compile.js");
    Promise.resolve(c.initParser && c.initParser()).then(() => {
      c.R.importModule("sys").path.push(c.libDir());
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
    const timer = setTimeout(() => (w.terminate(), resolve("timed out")), limit);
    w.on("message", (m) => {
      if (m.intr && stopAfter !== null) setTimeout(() => Atomics.store(new Int32Array(m.intr), 0, 1), stopAfter);
      if (m.done) (clearTimeout(timer), w.terminate(), resolve(m.done));
    });
    w.on("error", reject);
  });
}

const GOLDEN = "import sage_all as S\nR = S.RealField(16384)\nx = (1 + R(5).sqrt()) / 2\n";

test("QQ of a real above 16384 bits is refused before any exact conversion", async () => {
  const code = [
    "import sage_all as S",
    "def spy(*a, **k):",
    "    raise AssertionError('an exact conversion before the refusal')",
    "S._real_qq = spy",
    "S._QQ_exact = spy",
    "x = S.RealField(16385)(2).sqrt()",
    "try:",
    "    S.QQ(x)",
    "except NotImplementedError as e:",
    "    raise ValueError(str(e))",
  ].join("\n");
  assert.equal(await run(code, null), "ValueError: QQ of a real number of more than 16384 bits of precision is not implemented");
});

test("QQ of a 16384-bit golden ratio (CF terms all 1) finishes and rounds back", async () => {
  // (about 1.5 s on the VMs; the limit is generous)
  const code = GOLDEN + "import time\nt = time.perf_counter()\nq = S.QQ(x)\ndt = time.perf_counter() - t\nassert R(q) == x\nassert dt < 60, dt\nraise ValueError('ok')";
  assert.equal(await run(code, null), "ValueError: ok");
});

test("Stop interrupts QQ of a 16384-bit real", async () => {
  // (the value is built first; then a long run of conversions, so that
  // Stop lands in the continued fraction: 100 of them take minutes)
  const code = GOLDEN + "import time\nt = time.perf_counter()\nfor _ in range(100):\n    S.QQ(x)\n";
  const t0 = Date.now();
  assert.equal(await run(code, 5000, 60000), "KeyboardInterrupt");
  assert.ok(Date.now() - t0 < 30000, "Stop took " + (Date.now() - t0) + " ms");
});
