import test from "node:test";
import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import { execFileSync, spawnSync } from "node:child_process";

// int <-> decimal str conversions: no default limit in any mode (Sagebrush's
// int_max_str_digits default is 0, where CPython's is 4300, and its own
// 4,000,000-digit ceiling is gone: a user's own computation has no default
// limits, Oct 24 2026); the only bound is memory, admitted before a
// conversion starts; and a large one can be stopped (HARD-606-1).
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

test("Stop interrupts a large decimal conversion, both ways", async () => {
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

test("no default limit: conversions past the old 4,000,000-digit ceiling, as CPython's; memory admitted at once in a small heap; a set limit is CPython's", () => {
  const code = [
    "import sys, time",
    "print(sys.get_int_max_str_digits(), sys.flags.int_max_str_digits, sys.int_info.default_max_str_digits)",
    "# (just past the old ceiling, both ways: CPython 3.14 with its limit off gives 4000001 111)",
    "print(len(str(10 ** 4_000_000)), int('1' * 4_000_001) % 1000)",
    "# (past this 96 MiB heap: refused before any digit is made)",
    "for f in (lambda: str(1 << 100_000_000), lambda: '%d' % (1 << 100_000_000), lambda: format(1 << 100_000_000, ','), lambda: int('1' * 40_000_000)):",
    "    t = time.perf_counter()",
    "    try:",
    "        f()",
    "        print('converted')",
    "    except MemoryError as e:",
    "        print(time.perf_counter() - t < 2, e)",
    "sys.set_int_max_str_digits(4300)",
    "try:",
    "    str(10 ** 4300)",
    "except ValueError as e:",
    "    print(e)",
  ].join("\n");
  const r = spawnSync(process.execPath, ["--max-old-space-size=96", CLI, "-c", code], { encoding: "utf8", timeout: 60000 });
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.trim().split("\n");
  assert.equal(lines[0], "0 0 0");
  assert.equal(lines[1], "4000001 111");
  const to = "True converting an int of about 30103000 digits needs about 106 MiB, more than this session's 96 MiB";
  assert.deepEqual(lines.slice(2, 5), [to, to, to]);
  assert.equal(lines[5], "True converting an int of about 40000000 digits needs about 140 MiB, more than this session's 96 MiB");
  assert.equal(lines[6], "Exceeds the limit (4300 digits) for integer string conversion; use sys.set_int_max_str_digits() to increase the limit");
});

test("a user's report: an integer of 6,000,001 digits prints in full, in Sage mode and in Python mode, with no setting", () => {
  // (William met the old 4,000,000-digit ceiling, which no setting lifted,
  // while trying Sagebrush, Oct 22 2026: "It's not hard to hit")
  const want = "1" + "0".repeat(5_999_999) + "7";
  for (const [args, code] of [
    [["--sage"], "x = 10^6000000 + 7\nprint(x)"],
    [[], "x = 10**6000000 + 7\nprint(x)"],
  ] as [string[], string][]) {
    const out = execFileSync(process.execPath, [CLI, ...args, "-c", code], { encoding: "utf8", maxBuffer: 64 * 2 ** 20, timeout: 120000 });
    assert.equal(out.length, want.length + 1, args.join(" ") || "python");
    assert.ok(out === want + "\n", args.join(" ") || "python");
  }
});

// The heap's figure that admits a conversion is read once a session: Bun's
// getHeapStatistics takes about 12 ms a call, and reading it at each of the
// 4,400 conversions of micropython's int_big_div timed that test out there.
// (V8's own call, counted here by a preload: at most once for the session,
// with 4,400 small conversions and 3 large ones)
test("the heap's figure is read once a session, not at each conversion", () => {
  const { mkdtempSync, writeFileSync, rmSync } = require("node:fs");
  const { join } = require("node:path");
  const dir = mkdtempSync(join(require("node:os").tmpdir(), "sb-heapreads-"));
  try {
    const pre = join(dir, "count.js");
    writeFileSync(pre, `const v8 = require("node:v8"), f = v8.getHeapStatistics; let n = 0;
v8.getHeapStatistics = function () { n++; return f.apply(this, arguments); };
process.on("exit", () => process.stderr.write("reads " + n + "\\n"));`);
    const code = "for a in (10**24, 12349083434598210349871029923874109871234789):\n    for b in range(1, 2201):\n        s = str(a // b)\nfor k in range(3):\n    s = str(10**500000 + k)\nprint(len(s))";
    const r = spawnSync(process.execPath, ["--require", pre, CLI, "-c", code], { encoding: "utf8", timeout: 120000 });
    assert.equal(r.stdout, "500001\n");
    const reads = Number(/reads (\d+)/.exec(r.stderr)?.[1]);
    assert.ok(reads <= 1, r.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
