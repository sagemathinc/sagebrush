// The lazy-import shim's session binding (lib/_sage_lazy.py; plan-sage-lazy-chunks
// r2 section 3, astra3's regression for ruling (A)): two Sage-enabled executions
// as __main__ through compile.ts's execModule leave two live namespaces (the
// first run's functions keep their own globals; sys.modules["__main__"] is the
// second's).  Each init string binds its namespace, so a stub resolved from the
// FIRST run's retained function rebinds the slot in both, but never a slot the
// user reassigned.  One assertion per case, each on two fresh namespaces and a
// fresh stub (a stub's slot name is "double": the fixture's function).
import test from "node:test";
import assert from "node:assert/strict";

const c = require("../src/compile");
let ready: Promise<void> | undefined;
const setup = () => (ready ??= (async () => {
  await (c.initParser && c.initParser());
  c.R.importModule("sys").path.push(c.libDir());
})());

let k = 0;
// run 1 makes the stub and a function that uses it; run 2 (a new __main__)
// takes the same stub into its own slot (or a reassigned value); then the
// first run's function resolves it; `check` runs in a third, plain module
function scenario(reassign: boolean, check: string): void {
  const id = ++k;
  c.execModule(
    `import builtins
from _sage_lazy import LazyImport
double = LazyImport("_sage_lazy_fixture", "double", {})
builtins._lazy_case_${id} = {"stub": double, "ns1": globals()}
def use():
    return double(3)
builtins._lazy_case_${id}["use"] = use
`, `<lazy-case-${id}-run1>`, "__main__", false, true);
  c.execModule(
    `import builtins
case = builtins._lazy_case_${id}
double = ${reassign ? `"mine"` : `case["stub"]`}
case["ns2"] = globals()
del case
`, `<lazy-case-${id}-run2>`, "__main__", false, true);
  c.execModule(
    `import builtins, sys
case = builtins._lazy_case_${id}
assert case["use"]() == 6
fixture = sys.modules["_sage_lazy_fixture"]
${check}
`, `<lazy-case-${id}-check>`, `__lazy_case_${id}__`);
}

test("lazy bind: both Sage __main__ runs are live, and each init string bound its namespace", async () => {
  await setup();
  scenario(false, `import _sage_lazy
assert any(ns is case["ns1"] for ns in _sage_lazy._SESSIONS), "run 1 not bound"
assert any(ns is case["ns2"] for ns in _sage_lazy._SESSIONS), "run 2 not bound"
assert case["ns1"] is not case["ns2"]`);
});

test("lazy bind: resolving from the first run's function rebinds the FIRST (older) namespace's slot", async () => {
  await setup();
  scenario(false, `assert case["ns1"]["double"] is fixture.double, case["ns1"]["double"]`);
});

test("lazy bind: resolving from the first run's function rebinds the SECOND (newer) namespace's slot", async () => {
  await setup();
  scenario(false, `assert case["ns2"]["double"] is fixture.double, case["ns2"]["double"]`);
});

test("lazy bind: a slot the user reassigned in the second run is kept", async () => {
  await setup();
  scenario(true, `assert case["ns2"]["double"] == "mine", case["ns2"]["double"]`);
});
