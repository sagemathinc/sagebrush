import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// Builtins with their own keyword handling take CPython's keywords and
// argument counts (test/kw_adapters_cases.py): cmath and math.isclose bind
// by their signature (cmath's infinities as CPython's too), dict.update and
// dict() refuse two positional arguments, zip reads strict wherever it is,
// and pow takes base=, exp= and mod=.
const TEST = __dirname + "/../../test/";
test("cmath/math.isclose, dict.update, zip and pow keywords as CPython's", () => {
  const want = execFileSync("python3", [TEST + "kw_adapters_cases.py"], { encoding: "utf8" });
  const got = execFileSync(process.execPath, [__dirname + "/../src/cli.js", TEST + "kw_adapters_cases.py"], { encoding: "utf8" });
  const w = want.split("\n"), g = got.split("\n");
  for (let i = 0; i < Math.max(w.length, g.length); i++) assert.equal(g[i], w[i], `line ${i + 1}`);
});
