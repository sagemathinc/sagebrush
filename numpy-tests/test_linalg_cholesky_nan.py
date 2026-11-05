# np.linalg.cholesky with NaN and Inf, as NumPy 2.5.1 (OpenBLAS potrf): a pivot is refused only when it is <= 0, so a
# NaN pivot passes and the rest of the factor fills with NaN (no error); an Inf pivot passes; a -Inf or negative
# pivot is refused. Both of sagebrush's paths: the loop below 48 rows, engine/nd from 48 (a NaN it refuses is
# factored by the loop with NumPy's rule). MATLAB mode keeps MATLAB's rule (matlab-tests/test_chol_nan.m).
import numpy as np

nan, inf = np.nan, np.inf


def show(tag, a, **kw):
    try:
        r = np.linalg.cholesky(np.array(a, float), **kw)
    except Exception as e:
        print(tag, "->", type(e).__name__, e)
        return
    print(tag, "->", np.isnan(r).astype(int).tolist(), np.where(np.isnan(r), 0, r).round(12).tolist())


for tag, a in [("[4 NaN; NaN 9]", [[4, nan], [nan, 9]]), ("[NaN 0; 0 1]", [[nan, 0], [0, 1]]), ("[1 0; 0 NaN]", [[1, 0], [0, nan]]),
               ("[Inf 0; 0 1]", [[inf, 0], [0, 1]]), ("[4 2; 2 NaN]", [[4, 2], [2, nan]]), ("[1 0; 0 Inf]", [[1, 0], [0, inf]]),
               ("[4 Inf; Inf 9]", [[4, inf], [inf, 9]]), ("[-1 0; 0 NaN]", [[-1, 0], [0, nan]]), ("[NaN 0; 0 -1]", [[nan, 0], [0, -1]]),
               ("[[nan]]", [[nan]]), ("[[inf]]", [[inf]]), ("[[-inf]]", [[-inf]])]:
    show(tag, a)
    show(tag + " upper", a, upper=True)


def big(n, seed, where):
    B = np.random.default_rng(seed).standard_normal((n, n))
    A = B @ B.T + n * np.eye(n)
    for i, j in where:
        A[i, j] = A[j, i] = nan
    return A


for n, where in [(8, [(5, 3)]), (8, [(4, 4)]), (47, [(40, 40)]), (64, [(40, 40)]), (64, [(50, 20)]), (64, [(63, 63)]), (100, [(0, 0)])]:
    r = np.linalg.cholesky(big(n, n, where))
    m = np.isnan(r)
    # (where the NaNs are, and the finite part: its first NaN row, their count, and the finite entries' sum to 9 digits)
    print("n=%d NaN at %r -> first NaN row %d, NaNs %d, finite sum %.9g" % (n, where, int(np.argmax(m.any(axis=1))), int(m.sum()), float(np.where(m, 0, r).sum())))
s = np.stack([np.array([[4.0, nan], [nan, 9.0]]), np.array([[4.0, 2.0], [2.0, 3.0]])])
show("stack (2,2,2)", s)
