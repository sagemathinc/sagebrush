import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// Wrong answers and a leak that the external coverage corpora found
// (/scratch/coverage/python: The Python Tutorial, Rosetta Code), each
// compared with what CPython 3.14 prints for the same program.
const TEST = __dirname + "/../../test/";
const cases = (name: string) => {
  const want = execFileSync("python3", [TEST + name], { encoding: "utf8" });
  const got = execFileSync(process.execPath, [__dirname + "/../src/cli.js", TEST + name], { encoding: "utf8", maxBuffer: 1 << 26 });
  const w = want.split("\n"), g = got.split("\n");
  for (let i = 0; i < Math.max(w.length, g.length); i++) assert.equal(g[i], w[i], `${name} line ${i + 1}`);
};

test("a closed stream refuses every operation, in CPython's words: StringIO, BytesIO and files of each mode", () => {
  cases("closed_io_cases.py");
});

test("dir() of a module lists its names (or its own __dir__), not the module type's attributes; ModuleType() sets __package__, __loader__, __spec__", () => {
  cases("dir_module_cases.py");
});

test("an int's decimal conversions are limited to 4300 digits as in CPython, and sys.set_int_max_str_digits changes it", () => {
  cases("int_digits_cases.py");
});

test("int's real and numerator of a big int are the int itself, not an internal error (and Fraction compares with big ints)", () => {
  cases("int_attr_cases.py");
});

test("vars(), dir(), globals() and locals() inside exec() and eval() see their namespaces (no internal error)", () => {
  cases("exec_namespace_cases.py");
});

test("a SyntaxError's attributes, args and str() are CPython's; compile(..., 'single') takes one statement", () => {
  cases("syntax_error_cases.py");
});

test("Sage, Magma and MATLAB have no CPython-style 4300-digit limit on an integer's digits, as those systems (Sagebrush's own ceiling remains: int-digit-limits.test.ts)", () => {
  const run = (args: string[]) => execFileSync(process.execPath, [__dirname + "/../src/cli.js", ...args], { encoding: "utf8" }).trim();
  assert.equal(run(["--sage", "-c", "print(len(str(2^20000)), len(str(int(2)**20000)))"]), "6021 6021");
  assert.equal(run(["--magma", "-c", "print #Sprint(2^20000);"]), "6021");
  assert.equal(run(["-c", "import sys\nprint(sys.get_int_max_str_digits())"]), "4300");
});

test("readlines' hint, each class's own way (an index, or BytesIO's int), counted in characters; a write takes only a real buffer (CORR-606-3, CORR-50F-1)", () => {
  cases("io_hint_cases.py");
  cases("io_hint_descriptor_cases.py");
});

test("compile(..., 'single') reads a decorated or inline compound statement whole before the extra one (CORR-50F-2)", () => {
  cases("single_edges_cases.py");
});
