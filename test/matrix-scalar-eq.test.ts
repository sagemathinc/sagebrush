// A matrix or a vector compared with a scalar, in Sage mode and in Magma
// mode, each with its own rules over the same matrices (William's report:
// matrix(QQ, 1, [1]) == 1 was False in Sage mode).  The cases are Sage
// 10.10's and Magma V2.18-5's answers (sage-tests/test_matrix_scalar_eq
// has the full table).
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cli = join(__dirname, "..", "src", "cli.js");
const dir = mkdtempSync(join(tmpdir(), "sb-mateq-"));

function run(mode: "--sage" | "--magma", code: string) {
  const f = join(dir, "t" + Math.random().toString(36).slice(2) + (mode === "--sage" ? ".sage" : ".m"));
  writeFileSync(f, code);
  return spawnSync(process.execPath, [cli, mode, f], { encoding: "utf8" });
}

test("Sage mode: square matrices equal c times the identity where the rings meet; others an integral zero", () => {
  const r = run("--sage", [
    "a = matrix(QQ, 1, [1])",
    "print(a == 1, 1 == a, a != 1, 1 != a, a == 1/2)",
    "print(matrix(ZZ, [[2, 0], [0, 2]]) == GF(3)(2), matrix(QQ, [[1, 0], [0, 1]]) == GF(3)(1), matrix(ZZ, [[1, 0], [0, 1]]) == 1.0)",
    "print(matrix(GF(3), [[2, 0], [0, 2]]) == -1, matrix(GF(3), [[2, 0], [0, 2]]) == 1/2, matrix(GF(3), [[2, 0], [0, 2]]) == Mod(5, 6))",
    "print(matrix(ZZ, 2, 3) == 0, matrix(ZZ, 2, 3) == QQ(0), matrix(GF(3), 2, 3) == GF(3)(0), matrix(ZZ, [[1, 0, 0], [0, 1, 0]]) == 1)",
    "print(matrix(ZZ, 0, 0) == 5, matrix(QQ, 0, 0) == GF(3)(2), matrix(ZZ, 0, 2) == 1)",
    "print(vector(ZZ, [0, 0]) == 0, vector(GF(3), [0, 0]) == 3, vector(QQ, [0, 0]) == QQ(0), vector(GF(3), [0, 0]) == 0)",
    "A = matrix(QQ, [[1, 2], [3, 4]]); print(A * A.inverse() == 1, A + 0 == A, matrix(ZZ, 2, 3) + 0 == 0)",
  ].join("\n") + "\n");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, [
    "True True False False False",
    "True False True",
    "True False True",
    "True False False False",
    "True False False",
    "True False False True",
    "True True True",
  ].join("\n") + "\n");
});

test("Sage mode: an immutable c times the identity hashes as c (dict lookups agree with ==)", () => {
  const r = run("--sage", [
    "M = matrix(ZZ, [[3, 0], [0, 3]]); M.set_immutable()",
    "N = matrix(ZZ, [[1, 1], [0, 1]]); N.set_immutable()",
    "print(hash(M) == hash(3), {3: 'three'}[M], M in {3}, hash(N) == hash(1))",
    "Z = matrix(ZZ, 2, 2); Z.set_immutable(); print(hash(Z) == hash(0))",
  ].join("\n") + "\n");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "True three True False\nTrue\n");
});

test("zero matrices of any shape hash as 0, in one pass over the entries; vectors compare symmetrically (#89 review)", () => {
  const r = run("--sage", [
    // CORR-EQ89-2: rectangular, empty and square zero matrices are found under 0, as in Sage
    "d = {0: 'zero', 3: 'three'}",
    "for M in [matrix(ZZ, 2, 3), matrix(ZZ, 0, 0), matrix(QQ, 3, 1), matrix(ZZ, 2, 2), matrix(ZZ, [[3, 0], [0, 3]])]:",
    "    M.set_immutable()",
    "    print(d.get(M), end=' ')",
    "print()",
    // LIMIT-EQ89-1: one streaming pass, each row iterated once, no copy of the rows
    "from _sage_ffmat import _matrix_hash",
    "class Row(list):",
    "    n = 0",
    "    def __iter__(self):",
    "        Row.n += 1",
    "        return list.__iter__(self)",
    "print(_matrix_hash([Row([3, 0]), Row([0, 3])], 2) == hash(3), Row.n)",
    "Row.n = 0",
    "print(_matrix_hash([Row([1, 2]), Row([3, 4])], 2) == _matrix_hash([[1, 2], [3, 4]], 2), Row.n)",
    // CORR-EQ89-1: both orders for vectors of rings with no common parent, and with one
    "a, b = vector(SR, [1]), vector(GF(3), [1])",
    "print(a == b, b == a, a != b, b != a)",
    "print(vector(ZZ, [4]) == vector(GF(3), [1]), vector(GF(3), [1]) == vector(ZZ, [4]))",
  ].join("\n") + "\n");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "zero zero zero zero three \nTrue 2\nTrue 2\nFalse False True True\nTrue True\n");
});

test("Magma mode keeps Magma's rules: a square matrix eq an integer, a non-square one or a vector is an error", () => {
  const ok = run("--magma", [
    "A := Matrix(Integers(), 2, 2, [1,0,0,1]); A eq 1; 1 eq A; A ne 1; A eq 2;",
    "B := Matrix(Rationals(), 1, 1, [1]); B eq 1; B eq 1/2;",
    "D := Matrix(GF(3), 2, 2, [2,0,0,2]); D eq 2; D eq -1;",
    "F := Matrix(Integers(), 0, 0, []); F eq 1;",
  ].join("\n") + "\n");
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.stdout, "true\ntrue\nfalse\nfalse\ntrue\nfalse\ntrue\ntrue\ntrue\n");
  for (const code of ["C := Matrix(Integers(), 2, 3, [0,0,0,0,0,0]); C eq 0;", "v := Vector(Integers(), [0,0]); v eq 0;"]) {
    const r = run("--magma", code + "\n");
    assert.match(r.stdout + r.stderr, /Runtime error in 'eq': Bad argument types/, code);
  }
});
