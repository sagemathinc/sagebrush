# np.triu_indices, np.tril_indices and their _from forms, as NumPy 2.5.1's: the row and column indices of the
# upper or lower triangle (diagonal offset k, m columns), in row-major order; and indexing with them.
import numpy as np


def show(tag, f):
    try:
        r = f()
    except Exception as e:
        print(tag, "->", type(e).__name__, str(e)[:80])
        return
    if isinstance(r, tuple):
        print(tag, "->", len(r), [(x.dtype.name, x.shape, x.tolist()) for x in r])
    else:
        a = np.asarray(r)
        print(tag, "->", a.dtype, a.shape, a.tolist())


for f in ("triu_indices", "tril_indices"):
    g = getattr(np, f)
    for n, k, m in [(3, 0, None), (4, 1, None), (4, -1, None), (3, 0, 5), (5, 0, 3), (3, -2, 4), (3, 2, 4),
                    (3, 5, None), (3, -5, None), (1, 0, None), (0, 0, None), (0, 0, 3), (3, 0, 0)]:
        show("%s(%d, k=%d, m=%r)" % (f, n, k, m), lambda: g(n, k, m))
    show("%s(3, 1) positional k" % f, lambda: g(3, 1))
    show("%s(n=3, m=2)" % f, lambda: g(n=3, m=2))
    show("%s(np.int64(3))" % f, lambda: g(np.int64(3)))

a = np.arange(12).reshape(3, 4)
for f in ("triu_indices_from", "tril_indices_from"):
    g = getattr(np, f)
    show("%s 3x4" % f, lambda: g(a))
    show("%s 3x4 k=1" % f, lambda: g(a, 1))
    show("%s 3x4 k=-1" % f, lambda: g(a, k=-1))
    show("%s 4x3" % f, lambda: g(a.T))
    show("%s list" % f, lambda: g([[1, 2], [3, 4]]))
    show("%s 1-d" % f, lambda: g(np.arange(3)))
    show("%s 3-d" % f, lambda: g(np.zeros((2, 2, 2))))
    show("%s 0x0" % f, lambda: g(np.zeros((0, 0))))
# (indexing with them: the upper triangle's values, and assignment through them)
b = np.arange(16).reshape(4, 4)
show("b[triu_indices(4)]", lambda: b[np.triu_indices(4)])
show("b[tril_indices(4, -1)]", lambda: b[np.tril_indices(4, -1)])
show("b[triu_indices_from(b, 1)]", lambda: b[np.triu_indices_from(b, 1)])
c = np.zeros((3, 3))
c[np.triu_indices(3)] = 1.0
show("c after c[triu_indices(3)] = 1", lambda: c)
