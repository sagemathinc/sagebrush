import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// bytes(n) and bytearray(n): only CPython 3.14's own bounds. Past Py_ssize_t an
// OverflowError, and for bytes past it less a bytes object's 33-byte header ("byte string is too large");
// a negative count a ValueError; anything else as many zero bytes as the host can allocate, more than
// 2**32 included (the allocation is lazy, so 2**32 + 1 costs no memory until written). Where the
// host can't, a MemoryError naming why. The exception classes are CPython's (checked against CPython
// 3.14.4); CPython's MemoryErrors carry no text, these say what was asked and the limit met.
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
print(json.dumps(res))
`);
  const r = JSON.parse(out);
  for (const name of ["bytes", "bytearray"]) {
    assert.deepEqual(r[`${name} 2**32 + 1`], ["ok", 2 ** 32 + 1], name);
    assert.deepEqual(r[`${name} True`], ["ok", 1], name);
    assert.deepEqual(r[`${name} -1`], ["ValueError", "negative count"], name);
    for (const k of ["-2**70", "2**63"]) assert.deepEqual(r[`${name} ${k}`], ["OverflowError", "cannot fit 'int' into an index-sized integer"], `${name} ${k}`);
    assert.deepEqual(r[`${name} 2**53`], ["MemoryError", `${name}(9007199254740992): past the JavaScript engine's limit of 2**53 - 1 bytes`], name);
  }
  // (CPython's bytes refuses its last 33 sizes for its header; bytearray has none: a MemoryError there)
  assert.deepEqual(r["bytes 2**63 - 1"], ["OverflowError", "byte string is too large"]);
  assert.deepEqual(r["bytes 2**63 - 33"], ["OverflowError", "byte string is too large"]);
  assert.deepEqual(r["bytearray 2**63 - 1"], ["MemoryError", "bytearray(9223372036854775807): past the JavaScript engine's limit of 2**53 - 1 bytes"]);
  assert.deepEqual(r["bytearray 2**63 - 33"][0], "MemoryError");
});
