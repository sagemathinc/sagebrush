# test_matrix_sr_eigen: known divergences from Sage 10.10, NOT in the test

test_matrix_sr_eigen.out is Sage 10.10's output, verbatim (`/scratch/sage-oracle/sage/sage`; the
bare `sage`, 10.9, has no working Maxima for these). The cases below diverge from it, so they are
left out of the pin (ruling by @sagebrush-sage2 and @sagebrush-daybreak3 on #781 98448386). They are
recorded here as follow-ups. None of them is a wrong value.

**Order.** Sage lists the eigenvalues of a matrix over SR in Maxima's order. No simple rule
reproduces it. In Sage 10.10:

| matrix over SR | Sage | QQ's factor order | Sagebrush |
|---|---|---|---|
| `[[2, 1], [1, 2]]` | `[3, 1]` | `[3, 1]` | `[3, 1]` |
| `[[4, 1], [2, 3]]` | `[5, 2]` | `[5, 2]` | `[5, 2]` |
| `[[1, 1], [0, 2]]`, `[[1, 0], [0, 2]]`, `[[2, 0], [0, 1]]` | `[1, 2]` | `[2, 1]` | `[2, 1]` |
| `[[1, 1, 0], [0, 2, 0], [0, 0, 3]]`, `diag(3, 1, 2)` | `[1, 2, 3]` | `[3, 2, 1]` | `[3, 2, 1]` |

Maxima's `solve` itself gives `t^2 - 4*t + 3`: `[3, 1]`, `t^3 - 6*t^2 + 11*t - 6`: `[1, 2, 3]`. So two
quadratics with rational roots come out in opposite orders. Sagebrush's `solve` gives `[1, 3]`, so
dropping the QQ order for SR would trade these rows for the first two.

Symbolic entries follow Sagebrush's `solve`, whose order also depends on the variables' names:

| matrix over SR | Sage | Sagebrush |
|---|---|---|
| `[[a, 0], [0, b]]` | `[b, a]` | `[a, b]` |
| `[[u, 0], [0, a]]` | `[u, a]` | `[a, u]` |
| `[[2*s, 0], [0, 2]]` (`s` = `sbEigenT` or `u`) | `[2*s, 2]` | `[2, 2*s]` |
| `[[u, 1], [1, u]]` | `[u - 1, u + 1]` | `[u + 1, u - 1]` (with `sbEigenT` instead of `u`: Sage's order, pinned) |
| the companion matrix of `t^3 - 2` | `solve(t^3 - 2 == 0, t)`'s order | the two complex roots swapped, as Sagebrush's `solve` swaps them |

**Form.** For `[[cos(x), -sin(x)], [sin(x), cos(x)]]`:
- Sage gives `[cos(x) - I*sin(x), cos(x) + I*sin(x)]`, simplified past `solve`'s
  `cos(x) -/+ sqrt(cos(x)^2 - 1)`.
- Sagebrush gives `[cos(x) - 1/2*sqrt(-4*sin(x)^2), cos(x) + 1/2*sqrt(-4*sin(x)^2)]`.

The two are the same set for every `x`.

**Missing.** `charpoly()` of a matrix over SR raises `NotImplementedError` (polynomial rings over SR
are not available yet). Sage gives `x^2 - 4*x + 3` for `[[2, 1], [1, 2]]`.

Evidence: `/scratch/matlab-tmp/pr781-r2-evidence` (order2, collide, and Sage's and Sagebrush's
outputs).
