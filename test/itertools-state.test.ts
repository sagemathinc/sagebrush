import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// itertools' iterators keep CPython's state (test/itertools_state_cases.py,
// astra's stateful hunt at e4a9ce94, PY-STATE-1..3): islice consumes its
// source up to max(start, stop), groupby compares keys by identity then ==,
// and an exception from the source leaves an iterator as CPython's does
// (most go on; islice, pairwise, batched and zip_longest end).
const TEST = __dirname + "/../../test/";
test("itertools iterators keep CPython's state: islice's consumption, groupby's keys, recovery after a source's exception (PY-STATE-1..3)", () => {
  const want = execFileSync("python3", [TEST + "itertools_state_cases.py"], { encoding: "utf8" });
  const got = execFileSync(process.execPath, [__dirname + "/../src/cli.js", TEST + "itertools_state_cases.py"], { encoding: "utf8" });
  const w = want.split("\n"), g = got.split("\n");
  for (let i = 0; i < Math.max(w.length, g.length); i++) assert.equal(g[i], w[i], `line ${i + 1}`);
});
