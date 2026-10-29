import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

// MATLAB mode's sparse solves, rank-13 PR 2 (plan-matlab-nocliffs r6 sections
// 2.4, 2.4a, 2.5; ruling d2): the chunked bandwidths (master's exact result),
// the chunked band path (master's answers, kernels of at most E, its work
// exact), the cost route and its admission fallback, the full and dense
// admissions, and the browser interim.  test/matlab_band_cases.py prints one
// "ok" line per check under the engine; test/matlab_legacy_pin.py (CPython)
// pins the interim's bodies to master's and checks where they're reached.
const TEST = __dirname + "/../../test/";
const LIB = __dirname + "/../../lib/";
const CLI = __dirname + "/../src/cli.js";
const WALL = (ms: number) => ms * (Number(process.env.SAGEBRUSH_TIME_SCALE) || 1);

test("bandwidths, the band path, the route, the fallback table and ruling d2 (test/matlab_band_cases.py)", () => {
  const r = spawnSync(process.execPath, [CLI, TEST + "matlab_band_cases.py"], { encoding: "utf8", timeout: WALL(900000) });
  assert.equal(r.status, 0, r.stderr);
  // (MATLAB's singular-matrix warning is expected, on the zero-pivot fixture only)
  assert.ok(r.stderr.split("\n").every((l) => l === "" || l === "Warning: Matrix is singular to working precision."), r.stderr);
  const lines = r.stdout.trim().split("\n").filter((l) => !l.startsWith("Warning: "));
  assert.ok(lines.every((l) => l.startsWith("ok ")), r.stdout);
  assert.equal(lines.length, 26, r.stdout);
});

test("the first-use fix: small full() and dense solves exempt below SMALL_NEED, cold, chunked; admitted above (test/matlab_firstuse_cases.py)", () => {
  const r = spawnSync(process.execPath, [CLI, TEST + "matlab_firstuse_cases.py"], { encoding: "utf8", timeout: WALL(300000) });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, "");
  const lines = r.stdout.trim().split("\n");
  assert.ok(lines.every((l) => l.startsWith("ok ")), r.stdout);
  assert.equal(lines.length, 9, r.stdout);
});

test("ruling d2's legacy bodies are master's, and reached only from the unmeasured branches (test/matlab_legacy_pin.py)", () => {
  const r = spawnSync("python3", [TEST + "matlab_legacy_pin.py", LIB + "_matlab_sparse.py"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.stdout.trim().split("\n").filter((l) => l.startsWith("ok ")).length, 3, r.stdout);
});

test("ruling d2: master's full and band caps are registered to D0, and only the legacy lines, the constants and the routing floor are", () => {
  const reg = JSON.parse(readFileSync(TEST + "limit-sites.json", "utf8"));
  // (the routing floor, William's D-W1: master's predicate as a route, its own site and follow-up FU-B16-3)
  const FLOOR = "lib/_matlab_sparse.py :: legacy_band_route :: return (2 * kl + ku + 1) * n <= MAX_FULL and n * (kl + 1) * (kl + ku + 1) <= MAX_BAND_WORK #0";
  const caps = Object.entries(reg).filter(([k]) => k.startsWith("lib/_matlab_sparse.py") && /MAX_(FULL|BAND_WORK)\b/.test(k) && !/"""|full_arr :: master's/.test(k) && k !== FLOOR);
  assert.ok(caps.length >= 4, JSON.stringify(caps.map(([k]) => k)));
  for (const [k, v] of caps) assert.match((v as any).owner, /^D0 browser interim \(ruling d2\)/, k);
  assert.ok(caps.every(([k]) => /:: (_legacy_full_arr|_legacy_mldivide|) ::/.test(k)), JSON.stringify(caps.map(([k]) => k)));
  const floor = reg[FLOOR] as any;
  assert.ok(floor && /routing floor/.test(floor.owner), FLOOR);
  assert.deepEqual(floor.disposition, { "2": { followup: "FU-B16-3" }, "3": { followup: "FU-B16-3" } });
});
