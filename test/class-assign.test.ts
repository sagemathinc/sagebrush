import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// __class__ assignment (src/runtime/types.ts object.__class__'s setter), CPython's object_set_class: between mutable
// classes (or modules') whose instances have the same layout, compatible_for_assignment, slots' values kept; refused
// with CPython's words otherwise. test/class_assign_cases.py's .out is CPython 3.14.10's (python3 -I).
const ROOT = join(__dirname, "../..");
const CLI = join(__dirname, "../src/cli.js");
const CASES = join(ROOT, "test/class_assign_cases.py");
const OUT = join(ROOT, "test/class_assign_cases.out");

test("__class__ assignment is CPython 3.14.10's: same slots (sorted), same __dict__, subclasses adding nothing, modules, exceptions, refusals", () => {
  const want = readFileSync(OUT, "utf8").split("\n");
  const got = execFileSync(process.execPath, [CLI, CASES], { encoding: "utf8" }).split("\n");
  assert.ok(want.length > 20, "the recording has every case");
  for (let i = 0; i < Math.max(want.length, got.length); i++) assert.equal(got[i], want[i], `class_assign_cases.py line ${i + 1}`);
});

// (the recording's provenance: CI's CPython, when it is 3.14.10, prints the committed .out)
test("class_assign_cases.out is what CPython 3.14.10 prints", (t) => {
  const v = execFileSync("python3", ["-c", "import sys; print('%d.%d.%d' % sys.version_info[:3])"], { encoding: "utf8" }).trim();
  if (v !== "3.14.10") return t.skip(`python3 is ${v}, not the recording's 3.14.10`);
  assert.equal(execFileSync("python3", ["-I", CASES], { encoding: "utf8" }), readFileSync(OUT, "utf8"));
});
