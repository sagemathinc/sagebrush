import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// math against CPython 3.14 (test/math_hunt_cases.py): astra's probe
// (CORR-447-1..5: dist's dimensions, log to base 1, nextafter with no steps,
// degrees/radians near the top of the range, pow(0, -inf)) and the domain
// errors in CPython 3.14's words.
const TEST = __dirname + "/../../test/";
test("math as CPython 3.14: astra's probe and the domain errors' messages", () => {
  const want = execFileSync("python3", [TEST + "math_hunt_cases.py"], { encoding: "utf8" });
  const got = execFileSync(process.execPath, [__dirname + "/../src/cli.js", TEST + "math_hunt_cases.py"], { encoding: "utf8" });
  assert.equal(got, want);
});

// HARD-909-1: an int far past float range takes its logarithm from its bit
// length, found by shifts, never from a string of its binary digits, so a
// 100-million-bit int fits a 96 MiB heap (and int / int too).
test("log, log2 and log10 of a 100-million-bit int are exact and fit a 96 MiB heap, as CPython's (HARD-909-1)", () => {
  const code = [
    "import math",
    "x = 1 << 100000000",
    "print(repr(math.log2(x)), repr(math.log10(x)), repr(math.log(x)), repr(math.log(x, 1 << 50000000)))",
    "print(repr(math.log2(x + 12345)), repr(math.log10(3 ** 2000000)), repr(math.log2(3 ** 2000000)))",
    "print(repr(x // 3 / (1 << 99999990)))",
  ].join("\n");
  const got = execFileSync(process.execPath, ["--max-old-space-size=96", __dirname + "/../src/cli.js", "-c", code], { encoding: "utf8", timeout: 60000 });
  assert.equal(
    got,
    "100000000.0 30102999.56639812 69314718.05599453 2.0\n" +
      "100000000.0 954242.509439325 3169925.0014423123\n" +
      "341.3333333333333\n",
  );
});

// The logarithm of an int of any size, as CPython's (no bound since Oct 24
// 2026: a user's own computation has no default limits; it was 2^27 bits,
// HARD-315-1): its bit length is found with copies of at most 1/64 of it, so
// a 400-million-bit int (50 MB) takes it in a 96 MiB heap.  The one copy of
// the int, for the sticky bit when the bits below the 53 kept are exactly
// half, is admitted against the heap: a MemoryError past half of it.
test("log, log2 and log10 of an int of any size, in a 96 MiB heap, as CPython's; the halfway case's copy admitted against the heap", () => {
  const code = [
    "import math",
    "x = 1 << 400000000",
    "print(repr(math.log(x)), repr(math.log2(x)), repr(math.log10(x)))",
  ].join("\n");
  // (each a program of its own, as a constant such as 1 << 400000000 stays
  // in its code object after del; the guard's is halfway by construction,
  // one allocation: bits 53 apart at the top)
  const atOldBound = ["import math", "print(repr(math.log2((1 << 134217727) + 1)), repr(math.log10((1 << 134217727) + (1 << 134217674))))"].join("\n");
  const guard = ["import math", "y = (2 ** 53 + 1) << 410000000", "try: print(math.log(y))", "except MemoryError as e: print(type(e).__name__, e)"].join("\n");
  const run = (c: string) => execFileSync(process.execPath, ["--max-old-space-size=96", __dirname + "/../src/cli.js", "-c", c], { encoding: "utf8", timeout: 60000 });
  const t = Date.now();
  // (CPython 3.14's on the same program)
  assert.equal(run(code), "277258872.2239781 400000000.0 120411998.26559249\n");
  assert.equal(run(atOldBound), "134217727.0 40403561.77683941\n");
  assert.equal(run(guard), "MemoryError math.log of an int of 410000054 bits needs a copy of it (about 49 MiB) to round correctly, more than half this session's heap\n");
  assert.ok(Date.now() - t < 20000);
});
