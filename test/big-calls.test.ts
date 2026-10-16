import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// Calls with hundreds of thousands of positional arguments, f(*xs)
// (test/big_calls_cases.py): compiled functions, methods, classes and the
// variadic builtins take them as CPython does, through array forms rather
// than a JS spread (V8 puts spread arguments on the stack: a RecursionError).
const TEST = __dirname + "/../../test/";
test("f(*xs) with 300,000 arguments: functions, methods, classes, struct.pack, print, min/max, format, set operations, gcd, zip, as CPython", () => {
  const want = execFileSync("python3", [TEST + "big_calls_cases.py"], { encoding: "utf8" });
  const got = execFileSync(process.execPath, [__dirname + "/../src/cli.js", TEST + "big_calls_cases.py"], { encoding: "utf8", timeout: 120000 });
  const w = want.split("\n"), g = got.split("\n");
  for (let i = 0; i < Math.max(w.length, g.length); i++) assert.equal(g[i], w[i], `line ${i + 1}`);
});
