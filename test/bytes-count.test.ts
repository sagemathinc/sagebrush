import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// bytes(n) and bytearray(n): only the bounds of 64-bit CPython 3.14. Past Py_ssize_t (2**63 - 1 there)
// an OverflowError, and for bytes past it less a bytes object's 33-byte header ("byte string is too large");
// a negative count a ValueError; anything else as many zero bytes as the host can allocate, more than
// 2**32 included. (On the host this was measured on, 64-bit Linux, 2**32 + 1 zero bytes reserve address
// space without committing their pages until they are written.) Past 2**53 - 1, the largest count a
// JavaScript number holds exactly and the upper bound checked, a MemoryError without trying; an engine may
// refuse a smaller allocation, and that RangeError becomes a MemoryError too. The exception classes are
// 64-bit CPython's (checked against CPython 3.14.4); CPython's MemoryErrors carry no text, these say what
// was asked and the limit met.
const py = (code: string) => execFileSync(process.execPath, [__dirname + "/../src/cli.js", "-c", code], { encoding: "utf8" });

test("bytes(n) and bytearray(n): past 2**32, CPython's bounds, and a MemoryError that names the limit", () => {
  const out = py(`
import json
res = {}
def t(label, f):
    try:
        res[label] = ["ok", f()]
    except BaseException as e:
        res[label] = [type(e).__name__, str(e)]
for f in (bytes, bytearray):
    name = f.__name__
    t(name + " 2**32 + 1", lambda: len(f(2**32 + 1)))
    t(name + " True", lambda: f(True) == f(1) and len(f(True)))
    for label, n in (("-1", -1), ("-2**70", -2**70), ("2**63", 2**63), ("2**63 - 1", 2**63 - 1), ("2**63 - 33", 2**63 - 33), ("2**53", 2**53)):
        t(name + " " + label, lambda: f(n))
class C:
    def __index__(self): return 2**64
t("bytes C", lambda: bytes(C()))
print(json.dumps(res))
`);
  const r = JSON.parse(out);
  for (const name of ["bytes", "bytearray"]) {
    assert.deepEqual(r[`${name} 2**32 + 1`], ["ok", 2 ** 32 + 1], name);
    assert.deepEqual(r[`${name} True`], ["ok", 1], name);
    assert.deepEqual(r[`${name} -1`], ["ValueError", "negative count"], name);
    for (const k of ["-2**70", "2**63"]) assert.deepEqual(r[`${name} ${k}`], ["OverflowError", "cannot fit 'int' into an index-sized integer"], `${name} ${k}`);
    assert.deepEqual(r[`${name} 2**53`], ["MemoryError", `${name}(9007199254740992): past JavaScript's limit of 2**53 - 1 bytes`], name);
  }
  // (CPython's bytes refuses its last 33 sizes for its header; bytearray has none: a MemoryError there)
  assert.deepEqual(r["bytes 2**63 - 1"], ["OverflowError", "byte string is too large"]);
  assert.deepEqual(r["bytes 2**63 - 33"], ["OverflowError", "byte string is too large"]);
  assert.deepEqual(r["bytearray 2**63 - 1"], ["MemoryError", "bytearray(9223372036854775807): past JavaScript's limit of 2**53 - 1 bytes"]);
  assert.deepEqual(r["bytearray 2**63 - 33"][0], "MemoryError");
  // (named by the object's own type, as CPython's PyNumber_AsSsize_t)
  assert.deepEqual(r["bytes C"], ["OverflowError", "cannot fit 'C' into an index-sized integer"]);
});

// (the host's refusal, made deterministic: Uint8Array throws the engine's RangeError at one length, and
// bytes(n) and bytearray(n) of that length raise the named MemoryError; another error is not renamed)
test("bytes(n) and bytearray(n): an allocation the engine refuses is a MemoryError naming the count", () => {
  const DIST = __dirname + "/..";
  const N = 2 ** 40 + 7;
  const js = `
const Real = Uint8Array;
globalThis.Uint8Array = class extends Real {
  constructor(...a) {
    if (a[0] === ${N}) throw new RangeError("Array buffer allocation failed");
    if (a[0] === ${N + 1}) throw new TypeError("not an allocation failure");
    if (a[0] === ${N + 2}) throw new RangeError("Invalid typed array length: ${N + 2}");
    if (a[0] === ${N + 3}) throw new RangeError("Maximum call stack size exceeded");
    super(...a);
  }
};
const c = require(${JSON.stringify(DIST + "/src/compile.js")});
Promise.resolve(c.initParser && c.initParser()).then(() => c.execModule(\`
import sys
for f in (bytes, bytearray):
    for n in (${N}, ${N + 1}, ${N + 2}, ${N + 3}):
        try:
            f(n)
            print(f.__name__, n, "made")
        except BaseException as e:
            print(f.__name__, n, type(e).__name__, str(e).split(chr(10))[0])
sys.stdout.flush()
\`, "<alloc>", "__main__"));
`;
  const out = execFileSync(process.execPath, ["-e", js], { encoding: "utf8" }).trim().split("\n");
  for (const name of ["bytes", "bytearray"]) {
    assert.ok(out.includes(`${name} ${N} MemoryError ${name}(${N}): the computer couldn't give the ${N} bytes it needed`), out.join("\n"));
    assert.ok(out.some((l) => l.startsWith(`${name} ${N + 1} `) && !l.includes("MemoryError")), out.join("\n"));
    // (the engine's own largest array is no shortage of memory; a call stack's RangeError is not renamed a MemoryError)
    assert.ok(out.includes(`${name} ${N + 2} MemoryError ${name}(${N + 2}): past the largest byte array this JavaScript engine makes`), out.join("\n"));
    assert.ok(out.some((l) => l.startsWith(`${name} ${N + 3} `) && !l.includes("MemoryError")), out.join("\n"));
  }
});
