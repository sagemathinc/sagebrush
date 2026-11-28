# An ellipsis that expands to no axes still separates the advanced indices around it (a scalar boolean, an integer
# array), as NumPy's: the broadcast block goes first. Reads and shaped writes; adjacent controls keep the block in place.
import numpy as np
a = np.arange(3)
b = np.arange(6).reshape(2, 3)
def show(name, f):
    try:
        r = f()
        print(name, r.shape, r.tolist())
    except Exception as e:
        print(name, type(e).__name__)
for t in (True, np.True_, np.array(True), False, np.False_):
    show(f"read {t!r} gap", lambda: a[None, t, ..., [0, 1]])
    show(f"read {t!r} nogap", lambda: a[None, t, [0, 1]])
    show(f"read {t!r} gap after", lambda: a[None, [0, 1], ..., t])
    show(f"read2 {t!r} gap", lambda: b[None, t, 0, ..., [0, 1]])
for t in (True, np.True_, np.array(True)):
    def w(shape, key):
        c = np.arange(3)
        c[key] = np.arange(10, 10 + int(np.prod(shape))).reshape(shape)
        return c
    show(f"write (2,1) {t!r} gap", lambda: w((2, 1), (None, t, Ellipsis, [0, 1])))
    show(f"write (1,2) {t!r} gap", lambda: w((1, 2), (None, t, Ellipsis, [0, 1])))
    show(f"write (1,2) {t!r} nogap", lambda: w((1, 2), (None, t, [0, 1])))
show("int gap", lambda: b[None, [0], ..., [1]])
show("int nogap", lambda: b[None, [0], [1]])
show("ellipsis only", lambda: a[...])
show("ellipsis basic", lambda: b[None, 0, ..., 1])
show("ellipsis wide", lambda: b[..., [0, 1]])
