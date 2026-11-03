// `from m import *` for the modules the notebook allows it for (src/dataflow.ts
// STAR_AMBIENT): each runs, and its names arrive.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { STAR_AMBIENT } from "../src/dataflow";

const cli = join(__dirname, "..", "src", "cli.js");
const run = (args: string[]) => spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });

// (a few names each module gives, checked after its star import)
const NAMES: Record<string, string[]> = {
  math: ["sqrt", "pi", "floor", "gcd"],
  cmath: ["phase", "polar", "rect"],
  random: ["randint", "choice", "shuffle"],
  numpy: ["array", "linspace", "zeros", "pi"],
  "matplotlib.pyplot": ["plot", "show", "subplots", "xlabel"],
  pylab: ["plot", "show", "array", "linspace"],
  "sage.all": ["EllipticCurve", "QQ", "factor"],
};

test("every allowed star import runs and brings its names", () => {
  assert.deepEqual([...STAR_AMBIENT].sort(), Object.keys(NAMES).sort());
  for (const [m, names] of Object.entries(NAMES)) {
    // (builtins.all: numpy's star import replaces all, as in CPython)
    const code = `from ${m} import *\nimport builtins\nprint(builtins.all(n in globals() for n in ${JSON.stringify(names)}))`;
    // (sage.all in Sage mode, where Sage's module paths exist)
    const r = run(m === "sage.all" ? ["--sage", "-c", code] : ["-c", code]);
    assert.equal(r.stdout.trim(), "True", `${m}: ${r.stdout}${r.stderr}`);
  }
});
