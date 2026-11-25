# The numpy calls a forest's and bagging's draws and outputs make, at their
# shapes: RandomState.choice with p (with and without replacement), bincount
# with minlength, and np.mean of a list of arrays along axis 0.
import hashlib

import numpy as np


def show(name, a):
    a = np.asarray(a)
    print(name, a.dtype, a.shape, hashlib.sha256(np.ascontiguousarray(a).tobytes()).hexdigest()[:16], a.ravel()[:6].tolist())


for seed in (0, 1, 42):
    rs = np.random.RandomState(seed)
    for n in (5, 178, 1000):
        w = rs.rand(n) * 3 + 0.01
        w[:: 7] = 0.0
        p = w / np.sum(w)
        r = np.random.RandomState(seed + n)
        show("choice-p-replace s%d n%d" % (seed, n), r.choice(n, n, replace=True, p=p))
        show("choice-p-replace-half s%d n%d" % (seed, n), r.choice(n, n // 2, replace=True, p=p))
        k = int(np.count_nonzero(p)) // 2
        show("choice-p-noreplace s%d n%d" % (seed, n), r.choice(n, k, replace=False, p=p))
        show("choice-noreplace s%d n%d" % (seed, n), r.choice(n, n // 3, replace=False))
        idx = r.randint(0, n, n)
        show("bincount s%d n%d" % (seed, n), np.bincount(idx, minlength=n))
        show("bincount-int32 s%d n%d" % (seed, n), np.bincount(idx.astype(np.int32), minlength=n + 3))
        show("bincount-weights s%d n%d" % (seed, n), np.bincount(idx, weights=w, minlength=n))
        show("choice-int64-size s%d n%d" % (seed, n), r.choice(n, int(np.int64(n // 4)), replace=True, p=p))
    rows = [rs.rand(57, 3) for _ in range(25)]
    show("mean-list-axis0 s%d" % seed, np.mean(rows, axis=0))
    imps = [rs.rand(13) for _ in range(100)]
    show("mean-importances s%d" % seed, np.mean(imps, axis=0))
    show("mean-big s%d" % seed, np.mean([rs.rand(4) * 10 ** e for e in range(-8, 9)], axis=0))
r = np.random.RandomState(7)
for name, f in [("few-nonzero", lambda: r.choice(4, 3, replace=False, p=[0.5, 0.5, 0, 0])), ("all", lambda: r.choice(4, 4, replace=False, p=[0.1, 0.2, 0.3, 0.4])),
                ("shape", lambda: r.choice(10, (2, 2), replace=False, p=np.arange(10) / 45)), ("scalar", lambda: r.choice(5, replace=False, p=[0.2] * 5)),
                ("too-many", lambda: r.choice(3, 4, replace=False, p=[0.2, 0.3, 0.5])), ("array-pop", lambda: r.choice(np.array([10, 20, 30, 40]), 2, replace=False, p=[0.4, 0.3, 0.2, 0.1]))]:
    try:
        show("edge " + name, f())
    except Exception as e:
        print("edge", name, "!!", type(e).__name__, e)
