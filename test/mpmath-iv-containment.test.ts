import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

// mpmath's iv intervals contain the true value (design/mpmath-core.md: iv is a rigorous enclosure): libmpi.py's
// 'sagebrush' branch checks the floor and ceiling of exp, log, atan, atan2, pi, gamma, rgamma and loggamma at
// prec + 64 and + 128 bits
// and moves an endpoint outward until that value is safely inside. Upstream mpmath 1.3.0 trusts the directed
// rounding, which can land on the wrong side: iv.log(1 + 2**-21) at 24 bits was [floor, floor], below the true
// value. The 'python' backend, the rollback, keeps upstream's intervals: its counts show the cases are live.
const CLI = join(__dirname, "../src/cli.js");
const CASES = join(__dirname, "../../test/mpmath_iv_containment_cases.py");
const run = (backend: string | null) => {
  const env = { ...process.env };
  delete env.SAGEBRUSH_MPMATH_BACKEND;
  if (backend !== null) env.SAGEBRUSH_MPMATH_BACKEND = backend;
  const r = spawnSync(process.execPath, [CLI, CASES], { encoding: "utf8", env });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
};

test("mpmath's intervals contain the true value: log near 1; exp, log, atan, sin, cos and the gamma family at near ties", () => {
  assert.equal(run(null), `backend sagebrush
log of 1 + 2^-k, k = 1..300, 8 precisions: 2400 cases, 0 miss
near ties, exp : 1720 cases, 0 miss
near ties, log : 1376 cases, 0 miss
near ties, atan : 1720 cases, 0 miss
near ties, sin : 1720 cases, 0 miss
near ties, cos : 1720 cases, 0 miss
log(1 + 2^-21) at 24 bits: ((0, 4194303, -43, 22), (0, 16777213, -45, 24))
exact: ((0, 1, 0, 1), (0, 1, 0, 1)) ((0, 0, 0, 0), (0, 0, 0, 0)) ((0, 0, 0, 0), (0, 0, 0, 0))
pi: ((0, 884279719003555, -48, 50), (0, 7074237752028441, -51, 53))
gamma, rgamma of 2^-24 at 3 bits: ((0, 7, 21, 3), (0, 1, 24, 1)) ((0, 1, -24, 1), (0, 5, -26, 3))
loggamma(1/4) at 24 bits: ((0, 2701179, -21, 22), (0, 10804717, -23, 24))
exact: ((0, 3, 3, 2), (0, 3, 3, 2)) ((0, 1, -1, 1), (0, 1, -1, 1)) ((0, 0, 0, 0), (0, 0, 0, 0)) ((0, 0, 0, 0), (0, 0, 0, 0)) ((0, 3, 3, 2), (0, 3, 3, 2)) ((0, 0, 0, 0), (0, 0, 0, 0))
near ties, gamma : 1440 cases, 0 miss
near ties, rgamma : 1440 cases, 0 miss
near ties, loggamma : 1440 cases, 0 miss
near ties, factorial : 1440 cases, 0 miss
`);
});

test("the rollback backend keeps upstream mpmath's intervals, which miss on the same cases", () => {
  assert.equal(run("python"), `backend python
log of 1 + 2^-k, k = 1..300, 8 precisions: 2400 cases, 1042 miss
near ties, exp : 1720 cases, 83 miss
near ties, log : 1376 cases, 21 miss
near ties, atan : 1720 cases, 293 miss
near ties, sin : 1720 cases, 0 miss
near ties, cos : 1720 cases, 0 miss
log(1 + 2^-21) at 24 bits: ((0, 16777211, -45, 24), (0, 4194303, -43, 22))
exact: ((0, 1, 0, 1), (0, 1, 0, 1)) ((0, 0, 0, 0), (0, 0, 0, 0)) ((0, 0, 0, 0), (0, 0, 0, 0))
pi: ((0, 884279719003555, -48, 50), (0, 7074237752028441, -51, 53))
gamma, rgamma of 2^-24 at 3 bits: ((0, 1, 24, 1), (0, 1, 24, 1)) ((0, 1, -24, 1), (0, 1, -24, 1))
loggamma(1/4) at 24 bits: ((0, 10804717, -23, 24), (0, 2701179, -21, 22))
exact: ((0, 3, 3, 2), (0, 3, 3, 2)) ((0, 1, -1, 1), (0, 1, -1, 1)) ((0, 0, 0, 0), (0, 0, 0, 0)) ((0, 0, 0, 0), (0, 0, 0, 0)) ((0, 3, 3, 2), (0, 3, 3, 2)) ((0, 0, 0, 0), (0, 0, 0, 0))
near ties, gamma : 1440 cases, 10 miss
near ties, rgamma : 1440 cases, 10 miss
near ties, loggamma : 1440 cases, 364 miss
near ties, factorial : 1440 cases, 0 miss
`);
});
