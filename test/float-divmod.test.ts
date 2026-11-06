import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// Float floor division, modulo and divmod, and the math module's fmod,
// remainder, isclose, fsum, modf and their neighbours, at signed zeros,
// infinities, nan, subnormals and the largest doubles, in every position,
// with ints mixed in and through divmod's binary protocol: exactly what
// CPython 3.14 prints (test/float_divmod_cases.py; CI runs Python 3.14).
const CASES = __dirname + "/../../test/float_divmod_cases.py";

test("float //, % and divmod, and math's fmod, remainder, isclose, fsum and modf, as CPython's", () => {
  const want = execFileSync("python3", [CASES], { encoding: "utf8" });
  const got = execFileSync(process.execPath, [__dirname + "/../src/cli.js", CASES], { encoding: "utf8", maxBuffer: 1 << 26 });
  assert.ok(want.split("\n").length > 1400, "cases: " + want.split("\n").length);
  const w = want.split("\n"), g = got.split("\n");
  for (let i = 0; i < Math.max(w.length, g.length); i++) assert.equal(g[i], w[i], "line " + (i + 1));
});

test("keyword arguments from **mappings as CPython merges them: duplicates, string keys, any mapping (CORR-2ED-2)", () => {
  const cases = __dirname + "/../../test/kwargs_merge_cases.py";
  const want = execFileSync("python3", [cases], { encoding: "utf8" });
  const got = execFileSync(process.execPath, [__dirname + "/../src/cli.js", cases], { encoding: "utf8" });
  assert.equal(got, want);
});

test("a float's digits under e, f, g and %, str % and bytes %, at every power of ten and its neighbours, and an int past the largest float under a float type (OverflowError), as CPython's", () => {
  // (test/float_format_cases.py: the exponent exact, not log10's, so format(1e-7, '.17g') is '9.9999999999999995e-08';
  //  x * 100 past the largest float is 'inf%'; format(2**1024, 'f') raises, as float(2**1024) does; astra2's F004)
  const cases = __dirname + "/../../test/float_format_cases.py";
  const want = execFileSync("python3", [cases], { encoding: "utf8" });
  const got = execFileSync(process.execPath, [__dirname + "/../src/cli.js", cases], { encoding: "utf8", maxBuffer: 1 << 26 });
  assert.ok(want.split("\n").length > 3800, "cases: " + want.split("\n").length);
  const w = want.split("\n"), g = got.split("\n");
  for (let i = 0; i < Math.max(w.length, g.length); i++) assert.equal(g[i], w[i], "line " + (i + 1));
});
