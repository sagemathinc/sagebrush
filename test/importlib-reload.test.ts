import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

// importlib.reload runs a module's file again in its own namespace, as CPython's does: test/importlib_reload_cases.py
// prints what CPython prints for it, line for line (a module, a self-replacing module, a package, a failure partway,
// the argument checks).
const CLI = join(__dirname, "..", "src", "cli.js");
const CASES = join(__dirname, "..", "..", "test", "importlib_reload_cases.py");

test("importlib_reload_cases.py: reload as CPython 3.14 does it", () => {
  const want = execFileSync("python3", [CASES], { encoding: "utf8" }).split("\n");
  const got = execFileSync(process.execPath, [CLI, CASES], { encoding: "utf8" }).split("\n");
  assert.ok(want.length > 8, "the cases ran under CPython");
  for (let i = 0; i < Math.max(want.length, got.length); i++) assert.equal(got[i], want[i], `importlib_reload_cases.py line ${i + 1}`);
});

test("a module with no source file to read again is refused, saying why", () => {
  const out = execFileSync(process.execPath, [CLI, "-c", `
import importlib, math
try:
    importlib.reload(math)
except NotImplementedError as e:
    print(e)
`], { encoding: "utf8" });
  assert.equal(out, "importlib.reload(math): the module has no source file Sagebrush can read again (a builtin or library module, or one made in memory)\n");
});
