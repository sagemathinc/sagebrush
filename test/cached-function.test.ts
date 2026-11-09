import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// cached_method keeps a method's results in the instance's own __dict__ (lib/_sage_cached.py, astra's C1 on
// #912): no table outside the instance, so a dropped instance drops its cache; a class with no __dict__ is refused.
const TEST = __dirname + "/../../test/";
test("cached_method stores per instance, nowhere else, and refuses an instance with no __dict__", () => {
  const out = execFileSync(process.execPath, [__dirname + "/../src/cli.js", "--sage", TEST + "cached_function_cases.sage"], { encoding: "utf8", timeout: 120000 });
  assert.deepEqual(out.trim().split("\n"), [
    "module containers unchanged after 200 instances -> True",
    "cache in the instance's __dict__ -> ['_cache__h', '_cache__m', '_cache__me']",
    "live hits -> (14, 8, 3)",
    "distinct instances -> (2, 4, True)",
    "self result -> True",
    "clear_cache -> (None, {((1,), ()): 8}, 8, 4)",
    "a.m.clear_cache -> (None, False, 14, 5)",
    "slots class -> NotImplementedError: cached_method on an instance with no __dict__ (a class with __slots__) is not available in Sagebrush yet",
    "C.f() through the class -> 1",
    "C.g(C(), 3) through the class -> 3",
  ]);
});
