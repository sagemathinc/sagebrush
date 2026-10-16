import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// Matrices over RealField(p) and ComplexField(p) with p > 53: their linear
// algebra is done in the field's own precision.  numpy's doubles, padded to
// p bits, were a plausible wrong answer (a 4 x 4 determinant over
// RealField(200) was 5.6193318035993469194977478764485567808151245117187500000000).

const cli = (src: string) => execFileSync(process.execPath, [__dirname + "/../src/cli.js", "--sage", "-c", src], { encoding: "utf8", timeout: 120000 });

test("determinants and solutions over RealField(p) have the field's precision, not a double's", () => {
  // (the 4 x 4 Hilbert matrix: exact values from QQ; numpy's doubles padded
  // to p bits are off by about 2^-43 relative here, the field's own
  // elimination by about 2^(8 - p): checked against 2^(20 - p))
  const src = "for p in (100, 200):\n R = RealField(p)\n rows = [1 / (i + j + 1) for i in range(4) for j in range(4)]\n" +
    " N = matrix(R, 4, 4, [R(x) for x in rows]); E = matrix(QQ, 4, 4, rows)\n d = N.det(); x = E.det()\n" +
    " s = N.solve_right(vector(R, [1, 2, 3, 4])); t = E.solve_right(vector(QQ, [1, 2, 3, 4]))\n" +
    " print(p, abs((d - x) / x) < 2^(20 - p), max(abs((s[i] - t[i]) / t[i]) for i in range(4)) < 2^(20 - p))\n";
  assert.equal(cli(src), "100 True True\n200 True True\n");
});

test("numpy-only methods over RealField(p) and ComplexField(p), p > 53, are refused, not computed in doubles", () => {
  const src = "R = RealField(200); A = matrix(R, 4, 4, [R(i + j + 1).sqrt() for i in range(4) for j in range(4)])\n" +
    "C = ComplexField(100); B = matrix(C, 2, 2, [1, C(0, 1), 2, 3])\n" +
    "for M in (A, B):\n for m in ('eigenvalues', 'eigenvectors_right', 'eigenmatrix_right', 'SVD', 'singular_values', 'QR', 'norm', 'numpy'):\n" +
    "  try:\n   getattr(M, m)(); print(m, 'computed')\n  except NotImplementedError:\n   print(m, 'refused')\n" +
    "print(A.is_symmetric(), matrix(R, [[1, R(2).sqrt()], [R(2).sqrt() + R(2)^-150, 1]]).is_symmetric())\n" +
    // (53 bits stay on numpy, as before)
    "print(matrix(RDF, [[1, 2], [3, 4]]).det(), matrix(RR, 4, 4, [i + (i % 5 == 0) for i in range(16)]).det(), len(matrix(RDF, [[2, 1], [1, 2]]).eigenvalues()))\n";
  const lines = cli(src).trim().split("\n");
  assert.equal(lines.length, 18);
  for (const l of lines.slice(0, 16)) assert.match(l, / refused$/, l);
  assert.equal(lines[16], "True False");
  assert.equal(lines[17], "-2.0 -49.0000000000000 2");
});
