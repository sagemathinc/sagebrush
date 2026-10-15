import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// math.ldexp and math.frexp as CPython's: one rounding (half to even) at the
// subnormal boundary, OverflowError on overflow, huge exponents, and the
// argument errors; compared with python3 itself.
const PROGRAM = String.raw`
import math, random, struct
rng = random.Random(1074)
cases = [(1.0, -1074), (1.5, -1074), (0.75, -1073), (128.0, -1080), (3.0, -1076), (1.0, -1075), (1.0, -1076),
         (1.0, 1023), (1.9, 1023), (0.99, 1024), (1.0, 1024), (-1.0, 1024), (5e-324, 1074), (5e-324, 2097),
         (5e-324, 2098), (2.2250738585072014e-308, -52), (2.2250738585072014e-308, -53), (-3.0, -1076),
         (0.0, 10**30), (-0.0, -5), (float("inf"), -5), (float("-inf"), 10**30), (float("nan"), 3),
         (1.0, 10**30), (1.0, -10**30), (-1.0, -10**30), (1.0, True), (7, 2), (1.0, 1.5), (1.0, "2"), (1.0, None)]
for _ in range(400):
    m = struct.unpack("<d", struct.pack("<Q", rng.getrandbits(52) | (1023 << 52)))[0] * rng.choice([1, -1])
    cases.append((m, rng.randrange(-1140, -1015)))
for _ in range(100):
    # exact ties at the subnormal boundary: odd integers times a power of 2
    cases.append((float(rng.randrange(1, 2 ** 20) * 2 + 1), rng.randrange(-1100, -1070)))
for x, e in cases:
    try:
        print(repr(math.ldexp(x, e)))
    except (OverflowError, TypeError) as ex:
        print(type(ex).__name__, ex)
for x in [5e-324, 1e-310, -2.5e-320, 2.2250738585072014e-308, 1.7976931348623157e308, 0.1, -0.0]:
    m, e = math.frexp(x)
    print(repr(m), e, math.ldexp(m, e) == x)
`;

test("math.ldexp and math.frexp print what CPython's print", () => {
  const want = execFileSync("python3", ["-c", PROGRAM], { encoding: "utf8" });
  const got = execFileSync(process.execPath, [__dirname + "/../src/cli.js", "-c", PROGRAM], { encoding: "utf8" });
  assert.equal(got, want);
});
