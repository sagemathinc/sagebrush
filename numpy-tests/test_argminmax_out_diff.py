# argmax/argmin write into out= and return it (its shape checked), and keepdims=True over the whole array keeps one of each
# axis; diff takes an explicit prepend=None or append=None as a value (an object element), refused as NumPy's object
# subtraction refuses it; object arrays diff element by element. (Codex R01b P2-2 and P3.)
import numpy as np
def show(tag, f):
    try:
        r = f(); print(tag, "|", repr(r))
    except Exception as e:
        print(tag, "| !!", type(e).__name__, e)
a = np.array([[3, 1], [2, 5]])
for name in ("argmax", "argmin"):
    f = getattr(np, name)
    show(f"{name} out", lambda: (lambda o: (f(a, axis=0, out=o), o.tolist()))(np.full(2, -9)))
    show(f"{name} out axis1", lambda: (lambda o: (f(a, axis=1, out=o) is o, o.tolist()))(np.full(2, -9)))
    show(f"{name} keepdims full", lambda: f(a, keepdims=True))
    show(f"{name} keepdims axis", lambda: f(a, axis=1, keepdims=True))
    show(f"{name} out wrong shape", lambda: f(a, axis=0, out=np.full(3, -9)))
    show(f"{name} out int32", lambda: f(a, axis=0, out=np.full(2, -9, np.int32)))
    show(f"{name} out 0-d", lambda: f(a, out=np.full((), -9)))
    show(f"{name} keepdims out", lambda: f(a, keepdims=True, out=np.full((1, 1), -9)))
    show(f"{name} 0-d keepdims", lambda: f(np.array(5), keepdims=True))
    show(f"{name} 3-d keepdims", lambda: f(np.arange(8).reshape(2, 2, 2), keepdims=True).shape)
show("method argmax out", lambda: (lambda o: (a.argmax(axis=0, out=o), o.tolist()))(np.full(2, -9)))
show("method argmin keepdims", lambda: a.argmin(keepdims=True))
show("diff prepend None", lambda: np.diff([1, 3, 6], prepend=None))
show("diff append None", lambda: np.diff([1, 3, 6], append=None))
show("diff", lambda: np.diff([1, 3, 6]))
show("diff prepend 0", lambda: np.diff([1, 3, 6], prepend=0))
show("diff append [7, 9]", lambda: np.diff([1, 3, 6], append=[7, 9]))
from fractions import Fraction
show("diff object", lambda: np.diff(np.array([Fraction(1, 2), Fraction(3, 2), 4], dtype=object)))
show("diff object 2d", lambda: np.diff(np.array([[1, 2, 4], [3, 3, 9]], dtype=object), axis=1))
show("diff object 2d axis0", lambda: np.diff(np.array([[1, 2, 4], [3, 3, 9]], dtype=object), axis=0))
show("diff float prepend None", lambda: np.diff([1.5, 3.0], prepend=None))
# an object diff whose differences are sequences: each stored as it is, never discovered as nested
class Seq:
    def __init__(self, r): self.r = r
    def __sub__(self, o): return self.r
show("diff object list", lambda: np.diff(np.array([Seq([5, 6]), Seq([5, 6])], dtype=object)).tolist())
show("diff object list shape", lambda: np.diff(np.array([Seq([5, 6]), Seq([5, 6]), Seq(0)], dtype=object)).shape)
show("diff object tuple", lambda: np.diff(np.array([Seq((1, 2)), Seq((1, 2))], dtype=object)).tolist())
show("diff object list n=2", lambda: np.diff(np.array([Seq([5, 6])] * 3, dtype=object), n=2))
show("diff object list 2-D", lambda: np.diff(np.array([[Seq([1]), Seq([2]), Seq([3])]] * 2, dtype=object), axis=1).tolist())
show("diff object list 2-D axis 0", lambda: np.diff(np.array([[Seq([1]), Seq([2])]] * 2, dtype=object), axis=0).tolist())
show("diff object single", lambda: np.diff(np.array([Seq([5, 6])], dtype=object)).shape)
lst = np.empty(2, dtype=object); lst[0] = [1]; lst[1] = [2]
show("diff object list elements", lambda: np.diff(lst))
