import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

// MATLAB mode's sparse LU without fixed caps (plan-matlab-nocliffs r6, PR 1):
// lib/_matlab_colamd.py's ordering, lib/_matlab_lu.py's factorization and
// solves (the column permutation owned by the LU, both directions), the
// admission before every growth (fail closed without a measured figure),
// matlab.lu_work's categories and its refusal before the work, and the
// chunked and segmented paths.  test/matlab_lu_cases.py prints one "ok" line
// per check under the engine; any failure raises there.
const TEST = __dirname + "/../../test/";
const CLI = __dirname + "/../src/cli.js";
const WALL = (ms: number) => ms * (Number(process.env.SAGEBRUSH_TIME_SCALE) || 1);

test("the sparse LU's ordering, permutation, admission, work limit and chunked paths (test/matlab_lu_cases.py)", () => {
  const r = spawnSync(process.execPath, [CLI, TEST + "matlab_lu_cases.py"], { encoding: "utf8", timeout: WALL(600000) });
  assert.equal(r.stderr, "");
  assert.equal(r.status, 0);
  const lines = r.stdout.trim().split("\n");
  assert.ok(lines.every((l) => l.startsWith("ok ")), r.stdout);
  assert.equal(lines.length, 16, r.stdout);
});
