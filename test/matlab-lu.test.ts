import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

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
  assert.equal(lines.length, 20, r.stdout);
});

test("the LU's own chunk: the interim imports no _matlab_lu, a measured solve does (test/matlab_lu_lazy_cases.py)", () => {
  const r = spawnSync(process.execPath, [CLI, TEST + "matlab_lu_lazy_cases.py"], { encoding: "utf8", timeout: WALL(120000) });
  assert.equal(r.stderr, "");
  assert.equal(r.status, 0);
  const lines = r.stdout.trim().split("\n");
  assert.ok(lines.every((l) => l.startsWith("ok ")), r.stdout);
  assert.equal(lines.length, 3, r.stdout);
});

test("the browser interim (ruling d): master's LU caps are registered to D0, and only master's lines are", () => {
  const reg = JSON.parse(readFileSync(TEST + "limit-sites.json", "utf8"));
  const caps = Object.entries(reg).filter(([k]) => k.startsWith("lib/_matlab_sparse.py") && /MAX_LU_(FILL|WORK)/.test(k));
  assert.equal(caps.length, 4, JSON.stringify(caps.map(([k]) => k)));
  for (const [k, v] of caps) assert.match((v as any).owner, /^D0 browser interim/, k);
  // (the fallback's sites live only in _legacy_lu and the two constants; python's D0 follow-up, a figure
  // for js-heap and js-arraybuffer in the browser, deletes them and this test with them)
  assert.ok(caps.every(([k]) => /:: (_legacy_lu|) ::/.test(k)), JSON.stringify(caps.map(([k]) => k)));
});
