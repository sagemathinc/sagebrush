import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Modules Magma mode's load heap no longer carries (heap-budget.json): Sage mode's HilbertModularForms, the
// sandpiles and MixedIntegerLinearProgram are lazy imports (lib/sage_all.py, lib/_sage_lazy.py), and RDF/CDF past
// the doubles is lib/_sage_rdf_big.py, imported by its first use.  None is loaded at the start; each name works,
// and loads its module, on first use.

const cli = (...args: string[]) => execFileSync(process.execPath, [__dirname + "/../src/cli.js", ...args], { encoding: "utf8" });
const MODS = '["_sage_hmf", "_sage_sandpile", "_sage_milp", "_sage_rdf_big"]';

test("Sage mode loads the four modules on first use, not at the start", () => {
  const dir = mkdtempSync(join(tmpdir(), "sage-lazy-modules-"));
  try {
    const f = join(dir, "lazy.sage");
    writeFileSync(
      f,
      `import sys
mods = ${MODS}
print([m for m in mods if m in sys.modules])
S = sandpiles.Complete(3)
print(isinstance(S, Sandpile), [m for m in mods if m in sys.modules])
p = MixedIntegerLinearProgram()
print(type(p).__name__, [m for m in mods if m in sys.modules])
print(HilbertModularForms.__name__, [m for m in mods if m in sys.modules])
print(CDF(1000, 1).sinh(), [m for m in mods if m in sys.modules])
`,
    );
    assert.equal(
      cli(f),
      "[]\n" +
        "True ['_sage_sandpile']\n" +
        "MixedIntegerLinearProgram ['_sage_sandpile', '_sage_milp']\n" +
        "HilbertModularForms ['_sage_hmf', '_sage_sandpile', '_sage_milp']\n" +
        "+infinity + +infinity*I ['_sage_hmf', '_sage_sandpile', '_sage_milp', '_sage_rdf_big']\n",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Magma mode's load (the load-heap budget's probe) imports none of them", () => {
  assert.equal(cli("-c", `import sys, _magma; print([m for m in ${MODS} if m in sys.modules])`), "[]\n");
});
