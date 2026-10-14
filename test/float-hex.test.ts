import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// float.hex and float.fromhex against CPython 3.14: EXPECTED is what CPython
// prints for PROGRAM (special values, rounding to even at every boundary,
// subnormals, overflow, malformed strings; then a hash over 20000 random
// doubles' hex and 20000 random hex strings' values).
const PROGRAM = String.raw`import struct
cases = [0.0, -0.0, 1.0, -1.0, 0.5, 2.0, 0.1, 1 / 3, 5e-324, -5e-324, 2.2250738585072014e-308, 2.225073858507201e-308,
         1.7976931348623157e308, float("inf"), float("-inf"), float("nan"), 3.14159, 1e22, 1e-310]
for x in cases:
    print(repr(x), x.hex())
strs = ["0x1p0", "0X1P+3", " -0x1.8p1 ", "\t1\n", "0x.8", "0x1.", "+0x1.0000000000000p-1022", "0x0.0000000000001p-1022",
        "0x1p-1074", "0x1p-1075", "0x1.0000000000001p-1075", "0x1.8p-1075", "0x3p-1076", "0x1p-1076", "-0x1p-1080",
        "0x1.fffffffffffffp1023", "0x1.fffffffffffff7p1023", "0x1.fffffffffffff8p1023", "0x1p1024", "0x0.8p1025",
        "0x1.00000000000008p0", "0x1.00000000000018p0", "0x1.000000000000081p0", "0x1.ffffffffffffe8p-1023",
        "inf", "-Infinity", "nAn", "-nan", "0x10p-4", "000x1", "0x0p99999999999999999999", "-0x0p0",
        "0x1p-99999999999999999999", "0x1p99999999999999999999", "", "0x", "0x.p1", "0xg", "1e5", "0x1p", "0x1p+",
        "0x1_0", "- 0x1", "0x1.2.3", " 0x1", "0x+1", "infinityy", "0x1p1.5"]
for s in strs:
    try:
        v = float.fromhex(s)
        print(repr(s), repr(v), v.hex())
    except (ValueError, OverflowError) as e:
        print(repr(s), type(e).__name__, e)
try:
    float.fromhex(1)
except TypeError as e:
    print("TypeError", e)
class F(float):
    pass
print(type(F.fromhex("0x1p1")).__name__, F.fromhex("0x1p1"))
# many: every kind of double (random bit patterns) to hex and back; random hex strings
seed = 1
def nxt():
    global seed
    seed = (seed * 6364136223846793005 + 1442695040888963407) % 2 ** 64
    return seed >> 11
h = 0
def mix(s):
    global h
    for ch in s:
        h = (h * 131 + ord(ch)) % (2 ** 61 - 1)
bad = 0
for i in range(20000):
    b = (nxt() << 11 | nxt() >> 42) % 2 ** 64
    x = struct.unpack("<d", struct.pack("<Q", b))[0]
    t = x.hex()
    mix(t)
    y = float.fromhex(t)
    if not (y == x or (x != x and y != y)) or (x == 0 and t[0] != ("-" if str(x)[0] == "-" else "0")):
        bad += 1
for i in range(20000):
    digits = "".join("0123456789abcdef"[nxt() % 16] for _ in range(1 + nxt() % 20))
    p = nxt() % (len(digits) + 1)
    s = ("-" if nxt() % 2 else "") + "0x" + digits[:p] + "." + digits[p:] + "p" + str(nxt() % 2300 - 1150)
    try:
        t = float.fromhex(s).hex()
    except OverflowError:
        t = "overflow"
    mix(s + "=" + t + ";")
print("round trips that failed:", bad, "hash:", h)
`;
const EXPECTED = [
  "0.0 0x0.0p+0",
  "-0.0 -0x0.0p+0",
  "1.0 0x1.0000000000000p+0",
  "-1.0 -0x1.0000000000000p+0",
  "0.5 0x1.0000000000000p-1",
  "2.0 0x1.0000000000000p+1",
  "0.1 0x1.999999999999ap-4",
  "0.3333333333333333 0x1.5555555555555p-2",
  "5e-324 0x0.0000000000001p-1022",
  "-5e-324 -0x0.0000000000001p-1022",
  "2.2250738585072014e-308 0x1.0000000000000p-1022",
  "2.225073858507201e-308 0x0.fffffffffffffp-1022",
  "1.7976931348623157e+308 0x1.fffffffffffffp+1023",
  "inf inf",
  "-inf -inf",
  "nan nan",
  "3.14159 0x1.921f9f01b866ep+1",
  "1e+22 0x1.0f0cf064dd592p+73",
  "1e-310 0x0.012688b70e62bp-1022",
  "'0x1p0' 1.0 0x1.0000000000000p+0",
  "'0X1P+3' 8.0 0x1.0000000000000p+3",
  "' -0x1.8p1 ' -3.0 -0x1.8000000000000p+1",
  "'\\t1\\n' 1.0 0x1.0000000000000p+0",
  "'0x.8' 0.5 0x1.0000000000000p-1",
  "'0x1.' 1.0 0x1.0000000000000p+0",
  "'+0x1.0000000000000p-1022' 2.2250738585072014e-308 0x1.0000000000000p-1022",
  "'0x0.0000000000001p-1022' 5e-324 0x0.0000000000001p-1022",
  "'0x1p-1074' 5e-324 0x0.0000000000001p-1022",
  "'0x1p-1075' 0.0 0x0.0p+0",
  "'0x1.0000000000001p-1075' 5e-324 0x0.0000000000001p-1022",
  "'0x1.8p-1075' 5e-324 0x0.0000000000001p-1022",
  "'0x3p-1076' 5e-324 0x0.0000000000001p-1022",
  "'0x1p-1076' 0.0 0x0.0p+0",
  "'-0x1p-1080' -0.0 -0x0.0p+0",
  "'0x1.fffffffffffffp1023' 1.7976931348623157e+308 0x1.fffffffffffffp+1023",
  "'0x1.fffffffffffff7p1023' 1.7976931348623157e+308 0x1.fffffffffffffp+1023",
  "'0x1.fffffffffffff8p1023' OverflowError hexadecimal value too large to represent as a float",
  "'0x1p1024' OverflowError hexadecimal value too large to represent as a float",
  "'0x0.8p1025' OverflowError hexadecimal value too large to represent as a float",
  "'0x1.00000000000008p0' 1.0 0x1.0000000000000p+0",
  "'0x1.00000000000018p0' 1.0000000000000004 0x1.0000000000002p+0",
  "'0x1.000000000000081p0' 1.0000000000000002 0x1.0000000000001p+0",
  "'0x1.ffffffffffffe8p-1023' 2.225073858507201e-308 0x0.fffffffffffffp-1022",
  "'inf' inf inf",
  "'-Infinity' -inf -inf",
  "'nAn' nan nan",
  "'-nan' nan nan",
  "'0x10p-4' 1.0 0x1.0000000000000p+0",
  "'000x1' ValueError invalid hexadecimal floating-point string",
  "'0x0p99999999999999999999' 0.0 0x0.0p+0",
  "'-0x0p0' -0.0 -0x0.0p+0",
  "'0x1p-99999999999999999999' 0.0 0x0.0p+0",
  "'0x1p99999999999999999999' OverflowError hexadecimal value too large to represent as a float",
  "'' ValueError invalid hexadecimal floating-point string",
  "'0x' ValueError invalid hexadecimal floating-point string",
  "'0x.p1' ValueError invalid hexadecimal floating-point string",
  "'0xg' ValueError invalid hexadecimal floating-point string",
  "'1e5' 485.0 0x1.e500000000000p+8",
  "'0x1p' ValueError invalid hexadecimal floating-point string",
  "'0x1p+' ValueError invalid hexadecimal floating-point string",
  "'0x1_0' ValueError invalid hexadecimal floating-point string",
  "'- 0x1' ValueError invalid hexadecimal floating-point string",
  "'0x1.2.3' ValueError invalid hexadecimal floating-point string",
  "'\\xa00x1' ValueError invalid hexadecimal floating-point string",
  "'0x+1' ValueError invalid hexadecimal floating-point string",
  "'infinityy' ValueError invalid hexadecimal floating-point string",
  "'0x1p1.5' ValueError invalid hexadecimal floating-point string",
  "TypeError bad argument type for built-in operation",
  "F 2.0",
  "round trips that failed: 0 hash: 65798614376434434"
];

test("float.hex and float.fromhex as CPython's", () => {
  const dir = mkdtempSync(join(tmpdir(), "float-hex-"));
  writeFileSync(join(dir, "fhex.py"), PROGRAM);
  const out = execFileSync(process.execPath, [join(__dirname, "..", "src", "cli.js"), join(dir, "fhex.py")], { encoding: "utf8" });
  assert.deepEqual(out.trimEnd().split("\n"), EXPECTED);
});
