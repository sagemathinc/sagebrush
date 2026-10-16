import test from "node:test";
import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import { execFileSync, spawnSync } from "node:child_process";

// HARD-606-1: int <-> decimal str conversions have a ceiling no setting
// lifts (sys.set_int_max_str_digits(0), which Sage, Magma and MATLAB modes
// set, included), and below it a large one can be stopped.
const DIST = __dirname + "/..";
const CLI = DIST + "/src/cli.js";

function interruptAfter(code: string, ms: number): Promise<{ last: string; late: number }> {
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
    let stoppedAt = 0;
    const timer = setTimeout(() => (w.terminate(), resolve({ last: "not interrupted", late: Infinity })), ms + 20000);
    w.on("message", (m) => {
      if (m.intr) setTimeout(() => ((stoppedAt = Date.now()), Atomics.store(new Int32Array(m.intr), 0, 1)), ms);
      if (m.done) (clearTimeout(timer), w.terminate(), resolve({ last: m.done, late: Date.now() - stoppedAt }));
    });
    w.on("error", reject);
  });
}

test("Stop interrupts a decimal conversion just under the ceiling, both ways, with the limit off", async () => {
  // (the value and the text are made first, in a loop that also polls; the
  // conversion itself takes seconds, and Stop lands in it)
  const big = "import sys\nsys.set_int_max_str_digits(0)\nx = (1 << 13_000_000) - 1\n";
  const r1 = await interruptAfter(big + "while True:\n    s = str(x)\n", 1500);
  assert.equal(r1.last, "KeyboardInterrupt");
  assert.ok(r1.late < 3000, `stopped ${r1.late} ms after Stop`);
  const r2 = await interruptAfter("import sys\nsys.set_int_max_str_digits(0)\ns = '7' * 3_900_000\nwhile True:\n    v = int(s)\n", 1500);
  assert.equal(r2.last, "KeyboardInterrupt");
  assert.ok(r2.late < 3000, `stopped ${r2.late} ms after Stop`);
});

test("past Sagebrush's ceiling a conversion is refused at once, even with the limit off, in a small heap", () => {
  const code = [
    "import sys, time",
    "sys.set_int_max_str_digits(0)",
    "for f in (lambda: str(1 << 100_000_000), lambda: str(10 ** 4_000_100), lambda: int('1' * 4_000_001), lambda: int('9_' * 4_000_000 + '9'), lambda: '%d' % (1 << 14_000_000), lambda: format(1 << 14_000_000, ',')):",
    "    t = time.perf_counter()",
    "    try:",
    "        f()",
    "        print('converted')",
    "    except ValueError as e:",
    "        print(time.perf_counter() - t < 2, e)",
    "sys.set_int_max_str_digits(10_000_000)",
    "try:",
    "    str(1 << 14_000_000)",
    "except ValueError as e:",
    "    print(e)",
    "print(len(str(10 ** 3_999_999)), int('1' * 4_000_000) % 1000)",
  ].join("\n");
  const r = spawnSync(process.execPath, ["--max-old-space-size=96", CLI, "-c", code], { encoding: "utf8", timeout: 60000 });
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.trim().split("\n");
  const hard = "Exceeds Sagebrush's limit (4000000 digits) for integer string conversion";
  for (const l of lines.slice(0, 6)) assert.ok(l.startsWith("True " + hard), l);
  assert.equal(lines[2], `True ${hard}: value has 4000001 digits; no setting raises this limit`);
  assert.equal(lines[6], `${hard}; no setting raises this limit`);
  assert.equal(lines[7], "4000000 111");
});

test("large conversions by pieces are exact: decimal both ways, and int() in bases 2 to 36", () => {
  const code = [
    "import sys",
    "sys.set_int_max_str_digits(0)",
    "# (values with irregular digits, from powers of 3 and 7)",
    "for bits in (64, 53000, 54000, 70001, 200003, 1000001, 3000017):",
    "    for sign in (1, -1):",
    "        x = sign * ((3 ** (bits * 5 // 8) * 7 ** (bits // 50)) | (1 << (bits - 1)))",
    "        s = str(x)",
    "        print(bits, len(s), s[:30], s[-30:], int(s) == x)",
    "for t, b in (('z' * 70000, 36), ('6' * 90001, 7), ('12' * 40000, 3), ('_'.join(['9'] * 50000), 10), ('10' * 60000, 10), ('f' * 100000, 16), ('1' * 100000, 2), ('3' * 50000, 4), ('v' * 30000, 32), ('0o' + '7' * 50000, 0), ('0' * 30000 + '5', 10)):",
    "    v = int(t, b)",
    "    print(b, len(t), v % 999999937, v.bit_length())",
  ].join("\n");
  const want = execFileSync("python3", ["-c", code], { encoding: "utf8" });
  assert.equal(execFileSync(process.execPath, [CLI, "-c", code], { encoding: "utf8" }), want);
});

test("a float formatted with a huge precision costs only the zeros it pads with, as CPython's", () => {
  // (a double has at most 1074 fraction digits; '%.1000000f' % 1e300 used to
  // compute 10**1000000 and its digits, and hung)
  const code = [
    "for v in (1e300, 5e-324, -2.5, 1/3, 0.0, 1.7976931348623157e308):",
    "    for p in (1074, 1075, 1100, 1101, 3000):",
    "        s = f'{v:.{p}f}'; e = f'{v:.{p}e}'; g = f'{v:.{p}g}'",
    "        print(len(s), s[:40], s[-5:], e[:30], e[-8:], g[:30], len(g), '%.*f' % (p, v) == s)",
    "print(len(f'{1e300:.10000000f}'), len('%.3000000e' % 2.5))",
  ].join("\n");
  const want = execFileSync("python3", ["-c", code], { encoding: "utf8" });
  assert.equal(execFileSync(process.execPath, [CLI, "-c", code], { encoding: "utf8", timeout: 30000 }), want);
});

test("the powers kept between conversions stay small, whatever bases and sizes are converted (HARD-50F-1)", async () => {
  await import("../src/compile"); // (the runtime, initialized)
  const F = await import("../src/runtime/format");
  // (large conversions in many bases, then the kept powers: a few hundred KB
  // at most; the larger powers were each conversion's own)
  for (let base = 3; base <= 36; base++) {
    if ((base & (base - 1)) === 0) continue;
    const digits = "z0123456789abcdefghijklmnopqrstuvwxy".slice(1, base + 1).repeat(Math.ceil(300_000 / base));
    F.parseDigits(digits.slice(0, 300_000), base);
  }
  // (CPython's 4300-digit limit lifted, as Sage, Magma and MATLAB modes do)
  const saved = F.intDigits.max;
  F.intDigits.max = 0;
  try {
    F.decimalOf(10n ** 1_000_000n - 1n);
  } finally {
    F.intDigits.max = saved;
  }
  assert.ok(F.sharedPowerBytes() < 1_000_000, `kept ${F.sharedPowerBytes()} bytes`);
});
