import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

// RealField(p) matrices (p > 53) in the multiprecision core (lib/_sage_mpmat.py):
// what sage-tests/test_realfield_matrix can't show against Sage's output, since
// Sage computes these by its own elimination: that det, inverse and solve_right
// do go through the core, that the determinant is taken with 10 guard bits, and
// that a solution follows the field's directed rounding.

const CLI = __dirname + "/../src/cli.js";
// (each child's wall-clock bound, scaled by SAGEBRUSH_TIME_SCALE as in test/ffmat-heap.test.ts)
const WALL = (ms: number) => ms * (Number(process.env.SAGEBRUSH_TIME_SCALE) || 1);
const sage = (src: string) => {
  const r = spawnSync(process.execPath, [CLI, "--sage", "-c", src], { encoding: "utf8", timeout: WALL(120000) });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim().split("\n");
};

test("det, inverse and solve_right over RealField(p), p > 53, are one call into the core each; p = 53 is not", () => {
  const out = sage(`
import _sage_mpmat as S
calls = []
core = S._core
class Counting:
    def __getattr__(self, name):
        f = getattr(core(), name)
        def g(*a):
            calls.append(name)
            return f(*a)
        return g
S._core = lambda: Counting()
for p in [64, 333, 53]:
    R = RealField(p)
    M = matrix(R, [[4, 1, 0], [1, 3, 1], [0, 1, 2]])
    M.det()
    matrix(R, [[4, 1, 0], [1, 3, 1], [0, 1, 2]]).inverse()
    matrix(R, [[4, 1, 0], [1, 3, 1], [0, 1, 2]]).solve_right(vector(R, [1, 2, 3]))
    matrix(R, [[4, 1, 0], [1, 3, 1], [0, 1, 2]]).solve_right(matrix(QQ, 3, 2, [1, 0, 0, 1, 1, 1]))
    print(p, ' '.join(calls))
    del calls[:]
`);
  assert.deepEqual(out, [
    "64 mat_det mat_inverse mat_lu_solve mat_lu_solve mat_lu_solve",
    "333 mat_det mat_inverse mat_lu_solve mat_lu_solve mat_lu_solve",
    "53",
  ]);
});

test("the determinant is the core's at 10 bits more than the field's, rounded once: correctly rounded here, where at the field's precision it is not", () => {
  // (Hilbert matrices of order 3 and 4: cancellation costs a few bits, which
  // the guard bits absorb; the exact value is the determinant of the entries
  // as rounded into the field)
  const out = sage(`
import _sage_mpmat as S
for p in [64, 100, 200]:
    R = RealField(p)
    for n in [3, 4]:
        H = matrix(R, n, n, lambda i, j: 1 / (i + j + 1))
        exact = R(matrix(QQ, [[x.exact_rational() for x in r] for r in H.rows()]).det())
        a = S._raws(x for r in H.rows() for x in r)
        at_p = S._real(R, S._core().mat_det(a, n, p, "n"))
        print(p, n, H.det() == exact, at_p == exact)
`);
  assert.deepEqual(out, ["64 3 True False", "64 4 True False", "100 3 True False", "100 4 True False", "200 3 True False", "200 4 True False"]);
});

test("an inconsistent, numerically singular system raises, where Sage returns an unchecked vector (a deliberate deviation)", () => {
  // (sage-tests/test_realfield_matrix.deviations.md: Sage 10.9's solve_right
  // turns its check off over an inexact ring and returns (1, 0) here; the
  // consistent system's solution is Sage's, in sage-tests/test_realfield_matrix)
  const out = sage(`
for p in [64, 333]:
    R = RealField(p)
    S = matrix(R, [[1, 2], [2, 4]])
    for b in [vector(R, [1, 3]), matrix(R, [[1, 0], [3, 0]])]:
        try:
            print(p, S.solve_right(b))
        except ValueError as e:
            print(p, "ValueError:", e)
`);
  assert.deepEqual(out, [64, 64, 333, 333].map((p) => `${p} ValueError: matrix equation has no solutions`));
});

test("solve_right rounds in the field's direction (RealField(p, rnd=...)), not to nearest", () => {
  // (3 x = +-1: the core's quotient in the field's rounding; printed as the
  // sign of x - exact: RNDU above, RNDD below, RNDZ toward zero)
  const out = sage(`
for p in [64, 100, 333]:
    row = []
    for rnd in ["RNDU", "RNDD", "RNDZ"]:
        R = RealField(p, rnd=rnd)
        T = matrix(R, [[3]])
        for b in [1, -1]:
            x = T.solve_right(vector(R, [b]))[0].exact_rational()
            row.append(sign(x - b / 3))
    print(p, row)
`);
  for (const line of out) assert.match(line, /^\d+ \[1, 1, -1, -1, -1, 1\]$/, line);
  assert.equal(out.length, 3);
});
