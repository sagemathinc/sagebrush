import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { libDir } from "../src/compile";
import { R } from "../src/runtime/index";
import { importModule } from "../src/runtime/modules";
import { isType } from "../src/runtime/object";

// Every function of every public builtin module takes the positional
// argument counts CPython's does (math.sqrt(4, 5) was 2.0: a JS function
// ignores extra arguments).  CPython's counts come from inspect.signature
// (test/module_arity_gen.py); a function inspect cannot read, or one CPython
// lacks, must still have its count checked.
void R;
const MODULES = ["math", "cmath", "os", "sys", "time", "gc", "types", "struct", "re", "binascii", "zlib", "array"];
const TEST = __dirname + "/../../test/";

test("every builtin module function checks its positional argument count, as CPython's signature (math.sqrt(4, 5) is a TypeError)", () => {
  // (the library on sys.path, as the CLI puts it: os needs posixpath)
  const path = importModule("sys").path;
  if (!path.includes(libDir())) path.push(libDir());
  const want = JSON.parse(execFileSync("python3", [TEST + "module_arity_gen.py", ...MODULES], { encoding: "utf8" }));
  const unchecked: string[] = [], differ: string[] = [];
  let compared = 0;
  for (const mod of MODULES) {
    const m = importModule(mod);
    for (const k of Object.keys(m)) {
      const f = m[k];
      if (typeof f !== "function" || isType(f)) continue;
      // (functions written in Python bind their own arguments)
      if (f.$pyfn === true && f.$globals !== undefined) continue;
      const got: [number, number] | undefined = f.$argRange;
      if (got === undefined) {
        unchecked.push(`${mod}.${k}`);
        continue;
      }
      const w = want[mod]?.[k];
      if (w === undefined || w === null) continue;
      compared++;
      const hi = w[1] === null ? Infinity : w[1];
      if (got[0] !== w[0] || got[1] !== hi) differ.push(`${mod}.${k}: [${got[0]}, ${got[1]}], CPython [${w[0]}, ${hi}]`);
    }
  }
  assert.deepEqual(unchecked, [], "functions without a count check");
  assert.deepEqual(differ, [], "counts unlike CPython's");
  assert.ok(compared >= 140, `compared ${compared}`);
});

test("calls with the wrong count raise TypeError, and the right ones (defaults, keywords) still work, as CPython (test/module_arity_cases.py)", () => {
  const want = execFileSync("python3", [TEST + "module_arity_cases.py"], { encoding: "utf8" });
  const got = execFileSync(process.execPath, [__dirname + "/../src/cli.js", TEST + "module_arity_cases.py"], { encoding: "utf8" });
  const w = want.split("\n"), g = got.split("\n");
  for (let i = 0; i < Math.max(w.length, g.length); i++) assert.equal(g[i], w[i], `line ${i + 1}`);
});
