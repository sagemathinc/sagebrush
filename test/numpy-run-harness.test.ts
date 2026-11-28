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

// (each side's status checked on its own: the same output, failing under one side only, is a failure either way;
// sys.implementation.name is "pyjs" under Sagebrush, "cpython" under CPython)
test("numpy-tests/run.py: a program failing on one side only, with the same output, is a failure", () => {
  const sb = harness({ "test_sb_only_fails.py": "import sys; print('same on both sides'); sys.exit(0 if sys.implementation.name == 'cpython' else 3)\n" });
  assert.equal(sb.status, 1, sb.stdout + sb.stderr);
  assert.match(sb.stdout, /exit status: numpy 0, sagebrush 3 \(both must be 0\)/);
  const np = harness({ "test_np_only_fails.py": "import sys; print('same on both sides'); sys.exit(3 if sys.implementation.name == 'cpython' else 0)\n" });
  assert.equal(np.status, 1, np.stdout + np.stderr);
  assert.match(np.stdout, /exit status: numpy 3, sagebrush 0 \(both must be 0\)/);
});

test("numpy-tests/run.py: --dir with no directory is a usage error", () => {
  const r = spawnSync("python3", [RUN, "--dir"], { encoding: "utf8" });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /--dir needs a directory/);
});
