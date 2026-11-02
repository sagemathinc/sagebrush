# test_matrix_sr_charpoly: recorded deviations from Sage 10.9

Checked against real Sage 10.9 on Nov 2 2026 (VM2, SageMath version 10.9, Release Date: 2026-05-04): the oracle run of this exact file (input b219cdc2, output 18f64a26; frozen in /scratch/sage2-notes/kernel/linalg/4b2/impl/oracle2). 45 of the 48 lines of test_matrix_sr_charpoly.out are Sage's output. The 3 below are ours:

- S13, `matrix([[sqrt(2), -1], [pi, e^2]]).charpoly()`: Sage `x^2 + (-sqrt(2) - e^2)*x + pi + sqrt(2)*e^2`, ours `x^2 + (-e^2 - sqrt(2))*x + sqrt(2)*e^2 + pi`. The same polynomial; the print order of the constants sqrt(2), e and pi is the symbolic engine's, not this lane's.
- S31, the charpoly of a 0 x 0 matrix: Sage `TypeError: ECL says: charpoly: matrix must be square; found 1 rows, 0 columns.` (Maxima's error), ours `1`, the characteristic polynomial of a 0 x 0 matrix (Sage's own answer over QQ).
- S33, the charpoly of a 1 x 2 matrix: Sage the same ECL TypeError, ours `ValueError: matrix must be square` (Sage's error for every other base ring).

Not tested: `latex()` of the characteristic polynomial (Sage's `x^{2} + \left(-x - y\right) x + x y - 1`), which this lane doesn't provide.
