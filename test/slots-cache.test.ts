import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// __slots__ reads through the attribute-read sites' cache (src/runtime/object.ts siteGet's k 2: a slot member's
// value read from the instance's own runtime key, about 17 times faster than the generic lookup it replaces):
// test/slots_cache_cases.py runs each read site often enough to be cached, then changes the class, the instance or
// the object under it. Its .out is CPython 3.14.10's (python3 -I); the same with the backstop off
// (SAGEBRUSH_HARDENED=0), which generates the sites without their own-property check.
const ROOT = join(__dirname, "../..");
const CLI = join(__dirname, "../src/cli.js");
const CASES = join(ROOT, "test/slots_cache_cases.py");
const OUT = join(ROOT, "test/slots_cache_cases.out");

for (const hardened of ["1", "0"]) {
  test(`__slots__ reads through a cached site are CPython 3.14.10's: unset, deleted, shadowed, replaced, foreign members (SAGEBRUSH_HARDENED=${hardened})`, () => {
    const want = readFileSync(OUT, "utf8").split("\n");
    const env = { ...process.env, SAGEBRUSH_HARDENED: hardened };
    const got = execFileSync(process.execPath, [CLI, CASES], { encoding: "utf8", env }).split("\n");
    assert.ok(want.length > 18, "the recording has every case");
    for (let i = 0; i < Math.max(want.length, got.length); i++) assert.equal(got[i], want[i], `slots_cache_cases.py line ${i + 1}`);
  });
}

// (the recording's provenance: CI's CPython, when it is 3.14.10, prints the committed .out)
test("slots_cache_cases.out is what CPython 3.14.10 prints", (t) => {
  const v = execFileSync("python3", ["-c", "import sys; print('%d.%d.%d' % sys.version_info[:3])"], { encoding: "utf8" }).trim();
  if (v !== "3.14.10") return t.skip(`python3 is ${v}, not the recording's 3.14.10`);
  assert.equal(execFileSync("python3", ["-I", CASES], { encoding: "utf8" }), readFileSync(OUT, "utf8"));
});
