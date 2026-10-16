import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

// A conversion hook (__index__, __int__, __float__) returning an instance of
// a strict subclass of int or float: its value with CPython 3.14's
// DeprecationWarning (raised under an "error" filter); another type a
// TypeError; an int or float subclass's own __float__ used, as CPython's
// (test/subclass_results_cases.py; its .out is CPython 3.14's).
const TEST = __dirname + "/../../test/";
const CLI = __dirname + "/../src/cli.js";
test("conversion hooks' subclass results warn, other results are TypeError, as CPython", () => {
  const got = execFileSync(process.execPath, [CLI, TEST + "subclass_results_cases.py"], { encoding: "utf8" });
  assert.equal(got, readFileSync(TEST + "subclass_results_cases.out", "utf8"));
});
// Which conversions call a subclass's own hook (float(), int(), complex()),
// and which read its value (an index, math, cmath), as CPython's
// (test/subclass_overrides_cases.py; its .out is CPython 3.14's)
test("a subclass's own conversion hooks are called where CPython calls them, and only there", () => {
  const got = execFileSync(process.execPath, [CLI, TEST + "subclass_overrides_cases.py"], { encoding: "utf8" });
  assert.equal(got, readFileSync(TEST + "subclass_overrides_cases.out", "utf8"));
});
// The hooks bound as special methods, a subclass result made exact
// (test/subclass_binding_cases.py; its .out is CPython 3.14's)
test("float(), int() and complex() bind their hooks as special methods and give exact results", () => {
  const got = execFileSync(process.execPath, [CLI, TEST + "subclass_binding_cases.py"], { encoding: "utf8" });
  assert.equal(got, readFileSync(TEST + "subclass_binding_cases.out", "utf8"));
});
