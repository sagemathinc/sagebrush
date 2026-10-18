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

test("QQ of a literal of more than 15 digits: its own precision (57 bits for 17 digits), as Sage", async () => {
  // (the expected values are Sage's; RealNumber('...') is how the
  // preparser writes a literal)
  const code = "import sage_all as S\nx = S.RealNumber('1.2345678901234567')\nraise ValueError(' '.join(str(v) for v in [x.prec(), S.QQ(x), S.Rational(x), S.QQ(x + 0.0), S.QQ(S.RealNumber('0.123456789012345'))]))";
  assert.equal(await run(code, null), "ValueError: 57 524005478/424444441 524005478/424444441 89163235/72222221 42523979/344444233");
});

test("an integral literal of more than 15 digits is its 54-bit value (CORR-28E-3a)", async () => {
  // (Sage: QQ(9007199254740993.0) is 9007199254740993, which 53 bits cannot hold)
  for (const f of ["QQ", "Rational"]) {
    const code = `import sage_all as S\nraise ValueError(str(S.${f}(S.RealNumber('9007199254740993.0'))))`;
    assert.equal(await run(code, null), "ValueError: 9007199254740993");
  }
});

test("x + 0 and x * 1 with an int keep a literal in Sage only for a Python int; here they are refused (CORR-28E-3b)", async () => {
  // (in this runtime a Sage Integer is a Python int: which rule applies
  // cannot be known, so QQ refuses rather than guess; under CPython the
  // two are told apart)
  const cases = ["x + 0", "0 + x", "x * 1", "1 * x", "sum([x])", "-(x + 0)"];
  for (const c of cases) {
    const code = `import sage_all as S\nx = S.RealNumber('1e-20')\ny = ${c}\ntry:\n    S.QQ(y)\nexcept NotImplementedError as e:\n    raise ValueError(str(e)[:45])`;
    assert.equal(await run(code, null), "ValueError: QQ of x + 0 or x * 1 for a decimal literal x", c);
  }
  // (bools are Python bools everywhere: x + False is the literal, as in Sage)
  const lit = "import sage_all as S\nx = S.RealNumber('1e-20')\nraise ValueError(str(S.QQ(x + False)) + ' ' + str(S.QQ(x * True)))";
  assert.equal(await run(lit, null), "ValueError: 1/99999999999999990439 1/99999999999999990439");
});

test("an ambiguous x + 0 keeps its mark through RR, copies and RealNumber, and every conversion that reads a literal's digits refuses it (CORR-28E-3)", async () => {
  const head = "import sage_all as S, copy\nb = S.RealNumber('1e-20') + 0\n";
  for (const c of ["S.QQ(S.RR(b))", "S.QQ(copy.copy(b))", "S.QQ(S.RealNumber(b))", "S.QQ(-b)", "S.RealField(100)(b)", "S.Rational(S.RealField(100)(b))", "S.RIF(b)", "S.RealField(30)(b)"]) {
    const code = head + `try:\n    ${c}\nexcept NotImplementedError as e:\n    raise ValueError(str(e).split(' x + 0 or x * 1 for a decimal literal x ')[0])`;
    const got = await run(code, null);
    assert.ok(got === "ValueError: QQ of" || got === "ValueError: converting", c + " -> " + got);
  }
  // (a plain value converts: float(b); and arithmetic at 53 bits goes on,
  // where digits and value agree: sum([RR(1e308)] * 4) starts from int 0)
  assert.equal(await run(head + "raise ValueError(str(S.QQ(float(b))))", null), "ValueError: 1/99999999999999997962");
  assert.equal(await run("import sage_all as S\nraise ValueError(str(sum([S.RR(S.RealNumber('1e308'))] * 4)))", null), "ValueError: 4.00000000000000e308");
});
