import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// sage2's core-semantics findings, compared with CPython 3.14: a str
// subclass through str's own methods and as a dict key, __slots__ without
// a __dict__, pickles of methods, builtins, method descriptors and
// datetime's types byte for byte, the 3.14 messages, OSError's subclass
// by errno (test/core_*_cases.py)
const TEST = __dirname + "/../../test/";
for (const name of ["core_semantics_cases.py", "core_datetime_cases.py", "core_oserror_cases.py"]) {
  test(`core semantics as CPython's: ${name}`, () => {
    const want = execFileSync("python3", [TEST + name], { encoding: "utf8" }).split("\n");
    const got = execFileSync(process.execPath, [__dirname + "/../src/cli.js", TEST + name], { encoding: "utf8" }).split("\n");
    for (let i = 0; i < Math.max(want.length, got.length); i++) assert.equal(got[i], want[i], `${name} line ${i + 1}`);
  });
}

// (adjacent \\uD800\\uDC00 escapes: two code points in CPython, which
// Sagebrush's strings would merge into one; refused, CORR-D77-4)
test("raw-unicode-escape refuses escaped surrogates that would merge", () => {
  const code = "for b in (rb'\\uD800\\uDC00', rb'\\U0000D800\\U0000DC00', rb'\\uD800x\\uDC00', rb'\\U00010000'):\n    try: print(len(b.decode('raw-unicode-escape')))\n    except NotImplementedError as e: print('NotImplementedError', e)";
  const got = execFileSync(process.execPath, [__dirname + "/../src/cli.js", "-c", code], { encoding: "utf8" });
  const refused = "NotImplementedError a lone high surrogate followed by a lone low surrogate would become one character in Sagebrush's strings; not supported";
  assert.equal(got, `${refused}\n${refused}\n3\n1\n`);
});
