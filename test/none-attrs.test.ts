import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// None's attributes as CPython's: its methods are bound to it and a get/set
// descriptor gives its value (None.__class__ was the descriptor itself, so
// isinstance(None, an ABC such as Fraction) raised TypeError, and
// None.__repr__() could not be called) (test/none_attrs_cases.py)
const TEST = __dirname + "/../../test/";
test("None's methods and descriptors, and isinstance(None, ABCs), as CPython", () => {
  const want = execFileSync("python3", [TEST + "none_attrs_cases.py"], { encoding: "utf8" });
  const got = execFileSync(process.execPath, [__dirname + "/../src/cli.js", TEST + "none_attrs_cases.py"], { encoding: "utf8" });
  const w = want.split("\n"), g = got.split("\n");
  for (let i = 0; i < Math.max(w.length, g.length); i++) assert.equal(g[i], w[i], `line ${i + 1}`);
});
