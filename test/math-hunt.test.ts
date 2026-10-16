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

// HARD-315-1: past Sagebrush's bound (2^27 bits) the logarithm is refused,
// promptly and in a 96 MiB heap, rather than computed from copies of the int.
test("log, log2 and log10 of an int past 2^27 bits are refused promptly in a 96 MiB heap (HARD-315-1)", () => {
  const code = [
    "import math",
    "x = 1 << 400000000",
    "for f in (math.log, math.log2, math.log10):",
    "    try: print(f(x))",
    "    except OverflowError as e: print(type(e).__name__, e)",
    "del x",
    "print(repr(math.log2((1 << 134217727) + 1)), repr(math.log10((1 << 134217727) + (1 << 134217674))))",
  ].join("\n");
  const t = Date.now();
  const got = execFileSync(process.execPath, ["--max-old-space-size=96", __dirname + "/../src/cli.js", "-c", code], { encoding: "utf8", timeout: 60000 });
  const msg = "OverflowError int too large: Sagebrush takes the logarithm of an int of at most 134217728 bits\n";
  assert.equal(got, msg + msg + msg + "134217727.0 40403561.77683941\n");
  assert.ok(Date.now() - t < 20000);
});
