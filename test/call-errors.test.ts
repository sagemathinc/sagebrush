import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// A compiled function's call errors and its code object's signature fields, as CPython 3.14.10's (sage2's #912
// findings): test/call_errors_cases.py; its .out is CPython 3.14.10's (python3 -I).
const ROOT = join(__dirname, "../..");
const CLI = join(__dirname, "../src/cli.js");
const CASES = join(ROOT, "test/call_errors_cases.py");
const OUT = join(ROOT, "test/call_errors_cases.out");

test("call errors name the function by its __qualname__ and list every missing argument; co_varnames and co_flags as CPython 3.14.10's", () => {
  const want = readFileSync(OUT, "utf8").split("\n");
  const got = execFileSync(process.execPath, [CLI, CASES], { encoding: "utf8" }).split("\n");
  assert.ok(want.length > 50, "the recording has every case");
  for (let i = 0; i < Math.max(want.length, got.length); i++) assert.equal(got[i], want[i], `call_errors_cases.py line ${i + 1}`);
});

// (the recording's provenance: CI's CPython, when it is 3.14.10, prints the committed .out)
test("call_errors_cases.out is what CPython 3.14.10 prints", (t) => {
  const v = execFileSync("python3", ["-c", "import sys; print('%d.%d.%d' % sys.version_info[:3])"], { encoding: "utf8" }).trim();
  if (v !== "3.14.10") return t.skip(`python3 is ${v}, not the recording's 3.14.10`);
  assert.equal(execFileSync("python3", ["-I", CASES], { encoding: "utf8" }), readFileSync(OUT, "utf8"));
});

// help()'s signature line reads co_varnames: CPython's order, and "/" after the positional-only parameters
test("help()'s signature line is CPython's inspect.signature, *args, keyword-only and positional-only parameters included", (t) => {
  const v = execFileSync("python3", ["-c", "import sys; print(sys.version_info[:2] >= (3, 12))"], { encoding: "utf8" }).trim();
  if (v !== "True") return t.skip("no python3 3.12 or later");
  const f = join(ROOT, "test/help_signature_cases.py");
  const want = execFileSync("python3", ["-I", f, "inspect"], { encoding: "utf8" });
  assert.equal(want.split("\n").length, 11);
  assert.equal(execFileSync(process.execPath, [CLI, f], { encoding: "utf8" }), want);
});
