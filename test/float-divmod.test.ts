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
