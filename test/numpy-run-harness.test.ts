import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// numpy-tests/run.py's own rule: a program must exit 0 on both sides, not merely with the same status. A program
// that fails under CPython and under Sagebrush alike (a missing fixture, here) printed nothing on either side, and the
// harness reported it as identical; the control, a program that prints the same line on both, agrees.
const RUN = join(__dirname, "..", "..", "numpy-tests", "run.py");

function harness(programs: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "numpy-run-"));
  try {
    for (const [name, text] of Object.entries(programs)) writeFileSync(join(dir, name), text);
    return spawnSync("python3", [RUN, "--dir", dir, "-v"], { encoding: "utf8" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("numpy-tests/run.py: a program failing on both sides is a failure; the same output with status 0 agrees", () => {
  const failing = harness({ "test_missing_fixture.py": "open('no-such-fixture.json')\n" });
  assert.equal(failing.status, 1, failing.stdout + failing.stderr);
  assert.match(failing.stdout, /test_missing_fixture\.py\s+DIFF/);
  assert.match(failing.stdout, /exit status: numpy 1, sagebrush 1 \(both must be 0\)/);
  const agreeing = harness({ "test_ok.py": "print('same on both sides')\n" });
  assert.equal(agreeing.status, 0, agreeing.stdout + agreeing.stderr);
  assert.match(agreeing.stdout, /1\/1 identical/);
});
