# test_matrix_sr_eigen: recorded deviations from Sage 10.10

Checked against real Sage 10.10 (`/scratch/sage-oracle/sage/sage`) on Nov 6 2026. Lines 1-21 of
test_matrix_sr_eigen.out are Sage's output, verbatim. Lines 22-26 are Sagebrush's, recorded here
for review. None of them is a wrong value.

Same values and multiplicities, in a different order. Sage orders the eigenvalues of a matrix
over SR as Maxima's `solve` returns them. Sagebrush uses the QQ factor order for exact entries
(which is Sage's order on lines 1-2 and 18) and its own `solve`'s order for symbolic entries
(Sage's order on lines 4-7):

- Line 22, `matrix(SR, [[1, 1, 0], [0, 2, 0], [0, 0, 3]]).eigenvalues()`: Sage `[1, 2, 3]`,
  Sagebrush `[3, 2, 1]`. That is QQ's order: `matrix(QQ, ...)` gives `[3, 2, 1]` in Sage too.
- Line 23, `matrix(SR, [[a, 0], [0, b]]).eigenvalues()`: Sage `[b, a]`, Sagebrush `[a, b]`.
- Line 24, the cubic `t^3 - 2`: the two complex roots are in the other order. This is
  `solve(t^3 - 2 == 0, t)`'s own order, which differs from Sage's in the same way.

An equal set of values, in another form:

- Line 25, the rotation matrix: Sage `[cos(x) - I*sin(x), cos(x) + I*sin(x)]`, Sagebrush
  `[cos(x) - 1/2*sqrt(-4*sin(x)^2), cos(x) + 1/2*sqrt(-4*sin(x)^2)]`, `solve`'s radicals. For real
  `x`, `1/2*sqrt(-4*sin(x)^2) = I*abs(sin(x))`, so the two lists are the same set.

A missing feature, not a value:

- Line 26, `charpoly()` of a matrix over SR: `NotImplementedError` (polynomial rings over SR are
  not available in Sagebrush yet). Sage gives `x^2 - 4*x + 3`. This was already missing before this
  change; it is a follow-up.
