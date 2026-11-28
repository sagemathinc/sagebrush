import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// The Python evaluator's order of evaluation and its semantics, compared with CPython 3.14 line for line (the
// Codex audit R07, one section a finding, test/eval_order_cases.py): in and not in, the item before the container;
// a method looked up on its receiver before its arguments run; keywords and ** mappings each where it stands; an
// optimized range loop's callable before its arguments; an f-string's conversion before its format specification;
// a class statement's ** mappings, its metaclass included; yield from a list or a tuple through the iterator
// protocol; eval() and locals() in a comprehension inlined in a function seeing the function's locals.
const TEST = __dirname + "/../../test/";
test("evaluation order and semantics as CPython's: eval_order_cases.py", () => {
  const name = "eval_order_cases.py";
  const want = execFileSync("python3", [TEST + name], { encoding: "utf8" }).split("\n");
  const got = execFileSync(process.execPath, [__dirname + "/../src/cli.js", TEST + name], { encoding: "utf8" }).split("\n");
  for (let i = 0; i < Math.max(want.length, got.length); i++) assert.equal(got[i], want[i], `${name} line ${i + 1}`);
});
