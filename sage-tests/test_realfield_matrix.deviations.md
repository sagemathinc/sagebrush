# test_realfield_matrix: recorded deviations from Sage 10.9

None in the file. Every line of test_realfield_matrix.out is Sage's output, regenerated with SageMath 10.9.post1 on Nov 11 2026 (`python3 sage-tests/run.py --regen realfield_matrix`).

Over RealField(p), p > 53, Sagebrush takes det, inverse and solve_right from the multiprecision core (mpmath's LU), and Sage uses its own elimination. So the last bits can differ. The file prints results rounded, or as exact distances where both are one rounding from the true value, and checks the rest against exact results over QQ. test/sage-mpmat.test.ts covers what Sage can't be the oracle for: the core is used, the determinant's guard bits, and a solution's rounding direction.

One deliberate deviation (Nov 11 2026, under William's rule that confirmed upstream bugs are fixed, not copied). For the inconsistent, numerically singular system `matrix(RealField(64), [[1,2],[2,4]]).solve_right(vector(RealField(64), [1,3]))`:
  - Sage 10.9 returns `(1.00000000000000000, 0.000000000000000000)`, which doesn't solve the system. Its documentation says `check` is ignored over most inexact rings, so the answer isn't checked.
  - Sagebrush raises `ValueError: matrix equation has no solutions`, as Sage does over QQ. Master already behaves this way, through the field's own elimination.
  - Pinned at 64 and 333 bits, with a vector and with a matrix right-hand side, in test/sage-mpmat.test.ts. A consistent singular system gets Sage's solution, in the file above.
