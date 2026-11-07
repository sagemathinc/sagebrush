import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

// difflib, CPython 3.14's own Lib/difflib.py, lazily embedded (P3b-1, @sagebrush's ruling Nov 7): test/difflib_cases.py
// prints what CPython prints for it, line for line. The reference is the newest 3.14 patch release (CI's "3.14").
const CLI = join(__dirname, "..", "src", "cli.js");
const CASES = join(__dirname, "..", "..", "test", "difflib_cases.py");

test("difflib_cases.py: SequenceMatcher, unified/context/ndiff, restore, get_close_matches, Differ, HtmlDiff, diff_bytes, as CPython 3.14 prints them", () => {
  const want = execFileSync("python3", [CASES], { encoding: "utf8" }).split("\n");
  const got = execFileSync(process.execPath, [CLI, CASES], { encoding: "utf8" }).split("\n");
  assert.ok(want.length > 60, "the cases ran under CPython");
  for (let i = 0; i < Math.max(want.length, got.length); i++) assert.equal(got[i], want[i], `difflib_cases.py line ${i + 1}`);
});
