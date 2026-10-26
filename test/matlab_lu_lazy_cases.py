# MATLAB mode's sparse LU, its own chunk in the browser (matlab-lu,
# web/lib-chunks.mts): _matlab_sparse checks the capacity record before it
# imports _matlab_lu, so a solve that keeps master's LU (the interim, ruling
# (d)) imports neither _matlab_lu nor _matlab_colamd, and so the browser
# fetches no matlab-lu; a measured solve imports both and gets the same
# answer.  Its own process: nothing may have imported _matlab_lu before.
# Run by test/matlab-lu.test.ts; each check prints one "ok ..." line.
import sys
import numpy as np
import _matlab_sparse as sp

assert "_matlab_lu" not in sys.modules and "_matlab_colamd" not in sys.modules, "imported before the test"
print("ok importing _matlab_sparse imports neither _matlab_lu nor _matlab_colamd")


class FakeCap:
    def __init__(self, nbytes, domains):
        self.rec = {"bytes": nbytes, "domains": domains, "basis": [], "unknown_parts": []}

    def capacity(self):
        return dict(self.rec)


n = 40
rows, cols, vals = [], [], []
for j in range(n):
    for i, v in ((j, 4.0), ((j + 1) % n, -1.0), ((j * 7 + 3) % n, 0.5)):
        rows.append(i)
        cols.append(j)
        vals.append(v)
S = sp.make(n, n, np.array(rows, dtype=np.int64), np.array(cols, dtype=np.int64), np.array(vals))
B = np.array([[float((3 * i) % 5) - 2.0] for i in range(n)])
real = sp._capacity
try:
    sp._capacity = FakeCap(4 << 30, ["wasm-engine"])
    F0 = sp._sparse_lu(S)
    X0 = F0.solve(B)
    assert isinstance(F0, sp._LU), type(F0)
    assert "_matlab_lu" not in sys.modules and "_matlab_colamd" not in sys.modules, "the interim imported the new LU"
finally:
    sp._capacity = real
print("ok the interim (a record without the JS domains) keeps master's LU and imports neither _matlab_lu nor _matlab_colamd")
assert sp.unmeasured_reason() is None, "this host's record must be measured for the rest: " + str(sp.unmeasured_reason())
F1 = sp._sparse_lu(S)
X1 = F1.solve(B)
import _matlab_lu

assert isinstance(F1, _matlab_lu.LU) and "_matlab_colamd" in sys.modules
assert float(np.max(np.abs(X1 - X0))) <= 1e-12 * float(np.max(np.abs(X0))), "the two LUs disagree"
print("ok a measured solve imports _matlab_lu and _matlab_colamd (the ordering), with master's LU's answer")
