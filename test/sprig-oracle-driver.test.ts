import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The oracle driver (sprig-tests/oracle.py, design/sprig-mvp.md §7.1) refuses any nonzero exit of the oracle, for a
// case, for `--version` and for the limits probe, even when the oracle printed complete, valid-looking output; and
// then run.py records nothing. A fake oracle stands in for Mathics3 here: it prints the driver's markers like a good
// run, and exits 7 in the one call the test names.
const root = join(__dirname, "..", "..");

function fakeOracle(dir: string, failOn: "case" | "version" | "limits" | "none"): string {
  const p = join(dir, "fake-oracle.py");
  writeFileSync(p, `#!/usr/bin/env python3
import sys
FAIL = ${JSON.stringify(failOn)}
if "--version" in sys.argv:
    print("Mathics3 10.0.1")
    print("Running on a fake")
    sys.exit(7 if FAIL == "version" else 0)
src = sys.stdin.read()
M = "@@@SPRIG@@@"
if " LIMITS " in src:
    print(M + " LIMITS {200, 4096, {MaxIterations \\u29f4 65535}}")
    sys.exit(7 if FAIL == "limits" else 0)
print(M + " BEGIN")
print(M + " RESULT 2")
print(M + " FULLFORM 2")
print(M + " ORDERLESS {Plus, Times, Max, Min, GCD, LCM, Xor}")
print(M + " END")
sys.exit(7 if FAIL == "case" else 0)
`);
  chmodSync(p, 0o755);
  return p;
}

function runOracle(failOn: "case" | "version" | "limits" | "none") {
  const dir = mkdtempSync(join(tmpdir(), "sprig-drv-"));
  const fake = fakeOracle(dir, failOn);
  const cases = join(dir, "cases.json");
  writeFileSync(cases, JSON.stringify([{ file: "t", id: "a", code: "1 + 1\n" }, { file: "t", id: "b", code: "2\n" }]));
  return spawnSync("python3", [join(root, "sprig-tests", "oracle.py"), fake, cases], { encoding: "utf8", timeout: 60000 });
}

test("a good oracle run is recorded (the fake itself works)", () => {
  const p = runOracle("none");
  assert.equal(p.status, 0, p.stderr);
  const j = JSON.parse(p.stdout);
  assert.equal(j.results.length, 2);
  assert.equal(j.record.version, "Mathics3 10.0.1");
});

for (const where of ["case", "version", "limits"] as const) {
  test(`a nonzero exit of the oracle (${where}) is refused, and nothing is printed`, () => {
    const p = runOracle(where);
    assert.notEqual(p.status, 0);
    assert.equal(p.stdout, "");
    assert.match(p.stderr, /the oracle exited 7/);
  });
}

test("run.py --regen records nothing when the oracle fails: no output or provenance changes", () => {
  const base = mkdtempSync(join(tmpdir(), "sprig-regen-"));
  cpSync(join(root, "sprig-tests"), join(base, "sprig-tests"), { recursive: true });
  const fake = fakeOracle(base, "case");
  const out = join(base, "sprig-tests", "arith", "test_1.out.json");
  const prov = join(base, "sprig-tests", "PROVENANCE.json");
  const before = [readFileSync(out, "utf8"), readFileSync(prov, "utf8")];
  const p = spawnSync("python3", [join(base, "sprig-tests", "run.py"), "--regen", join(base, "sprig-tests", "arith", "test_1.sprig")],
    { encoding: "utf8", timeout: 60000, env: { ...process.env, SPRIG_ORACLE: fake } });
  assert.notEqual(p.status, 0);
  assert.match(p.stderr + p.stdout, /the oracle failed/);
  assert.deepEqual([readFileSync(out, "utf8"), readFileSync(prov, "utf8")], before);
});
