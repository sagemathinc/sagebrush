import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// Builtins' argument checks and formatting, compared with CPython 3.14
// (test/builtin_args_cases.py): @sagebrush-astra3's sweep A01-A14 and the
// inputs around each.
const TEST = __dirname + "/../../test/";
test("builtin argument checks: CPython 3.14's (astra3 sweep A01-A14)", () => {
  const name = "builtin_args_cases.py";
  const want = execFileSync("python3", [TEST + name], { encoding: "utf8" }).split("\n");
  const got = execFileSync(process.execPath, [__dirname + "/../src/cli.js", TEST + name], { encoding: "utf8" }).split("\n");
  for (let i = 0; i < Math.max(want.length, got.length); i++) assert.equal(got[i], want[i], `${name} line ${i + 1}`);
});

// (daybreak2 HARD-DF7-1: a result past V8's string length counted in UTF-16
// units, an astral fill two each, an expandtabs suffix too, is a prompt
// MemoryError, never a host RangeError; CPython, with no such limit, may
// build these, so they are Sagebrush's own checks)
test("results longer than a string can be are a MemoryError, counted in UTF-16 units", () => {
  const cases = [
    "'x'.ljust(2**28 + 10, '\\U0001f600')", "'x'.rjust(2**28 + 10, '\\U0001f600')", "'x'.center(2**28 + 10, '\\U0001f600')",
    "'\\U0001f600'.zfill(2**29 - 24)", "('\\t' * 511 + 'x' * 1100000).expandtabs(2**20)", "('\\t' * 600).expandtabs(2**20)",
    "'x'.ljust(2**40)", "b'x'.center(2**40)", "bytearray(b'x').zfill(2**40)",
  ];
  const src = cases.map((c) => `try:\n    ${c}\nexcept MemoryError as e:\n    print(type(e).__name__)`).join("\n");
  const out = execFileSync(process.execPath, [__dirname + "/../src/cli.js", "-c", src], { encoding: "utf8" }).trimEnd().split("\n");
  assert.deepEqual(out, cases.map(() => "MemoryError"));
});

// (astra CORR-3C7-4: pow(base, exp, mod) as CPython 3.14's ternary_op and
// slot_nb_power, every pairing of Python classes, builtin numbers and
// their subclasses with an int, float, object or no modulus, the methods
// each calls listed)
test("three-argument pow dispatches as CPython 3.14's", () => {
  const name = "ternary_pow_cases.py";
  const want = execFileSync("python3", [TEST + name], { encoding: "utf8" }).split("\n");
  const got = execFileSync(process.execPath, [__dirname + "/../src/cli.js", TEST + name], { encoding: "utf8" }).split("\n");
  for (let i = 0; i < Math.max(want.length, got.length); i++) assert.equal(got[i], want[i], `${name} line ${i + 1}`);
});

// (astra CORR-3C7-5: a memoryview's or array's bytes are a copy without an
// export held, so one taken before an argument converted by Python code,
// which could write into, resize or release its exporter, is refused,
// never an answer from the copy; bytes and bytearray stay live, and with
// no such later argument a memoryview or array is used as before)
test("a memoryview or array argument before one converted by Python code is refused", () => {
  const src = `
from array import array
class N:
    def __index__(self): return 1
for recv in (b'abc', bytearray(b'abc')):
    for old in (memoryview(bytearray(b'a')), array('B', [97])):
        for f in (lambda: recv.replace(old, b'x', N()), lambda: recv.replace(b'a', memoryview(b'x'), N())):
            try:
                print(f())
            except NotImplementedError as e:
                print(type(e).__name__, 'memoryview or array' in str(e))
    print(recv.replace(memoryview(b'a'), array('B', [120]), 1), recv.replace(b'a', b'x', N()))
`;
  const out = execFileSync(process.execPath, [__dirname + "/../src/cli.js", "-c", src], { encoding: "utf8" }).trimEnd().split("\n");
  const no = "NotImplementedError True";
  assert.deepEqual(out, [no, no, no, no, "b'xbc' b'xbc'", no, no, no, no, "bytearray(b'xbc') bytearray(b'xbc')"]);
});
