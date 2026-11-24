# ravel and flatten in each order, as NumPy's: the elements in C, Fortran ('F'), the array's own ('A': 'F'
# for a Fortran-ordered array) or memory ('K') order; ravel a view where the array is contiguous in that
# order and a copy otherwise, flatten always a copy. Each row: the values, the shape, the strides (of a
# result with elements), whether the result is a view (has a base), and its flags; then a write through
# the result, which reaches the source exactly when it is a view.
import numpy as np


def show(name, f, src):
    try:
        r = f()
        print(name, r.tolist(), r.shape, r.strides if r.size else "", r.base is not None, r.flags.c_contiguous, r.flags.writeable)
    except Exception as e:
        print(name, "!!", type(e).__name__, e)


m = np.arange(6).reshape(2, 3)
srcs = {
    "C": m, "F": np.asfortranarray(m), "T": m.T, "strided": np.arange(12).reshape(3, 4)[:, ::2], "rev": m[::-1],
    "revcol": m[:, ::-1], "both-rev": m[::-1, ::-1], "T-rev": m.T[::-1], "3dT": np.arange(24).reshape(2, 3, 4).transpose(2, 0, 1),
    "3d-mixed": np.arange(24).reshape(2, 3, 4).transpose(1, 2, 0)[:, ::-1], "3dF-step": np.asfortranarray(np.arange(60).reshape(3, 4, 5))[:, ::2],
    "bcast": np.broadcast_to(np.arange(3), (2, 3)), "bcast-col": np.broadcast_to(np.arange(3)[:, None], (3, 4)),
    "bcast-3dT": np.broadcast_to(np.arange(6).reshape(2, 1, 3), (2, 4, 3)).transpose(2, 1, 0),
    "1d-rev": np.arange(5)[::-1], "1d-step": np.arange(10)[::3], "empty": np.zeros((0, 3)), "emptyF": np.zeros((3, 0), order="F"),
    "0d": np.array(7), "unit": np.arange(6).reshape(2, 1, 3)[:, :, ::2], "unitT": np.arange(6).reshape(2, 1, 3).transpose(2, 1, 0),
    "Fslice": np.asfortranarray(np.arange(12).reshape(3, 4))[:, 1:3], "Fcol": np.asfortranarray(np.arange(12).reshape(3, 4))[:, 1:2],
    "row": np.arange(12).reshape(3, 4)[1:2], "c128F": np.asfortranarray((np.arange(6) + 1j).reshape(2, 3)),
    "boolT": (np.arange(6).reshape(2, 3) % 2 == 0).T,
}
for sname, s in srcs.items():
    for order in ("C", "F", "A", "K"):
        show("np.ravel %s %s" % (sname, order), lambda: np.ravel(s, order=order), s)
        show("ravel %s %s" % (sname, order), lambda: s.ravel(order=order), s)
        show("ravel positional %s %s" % (sname, order), lambda: s.ravel(order), s)
        show("flatten %s %s" % (sname, order), lambda: s.flatten(order=order), s)
show("np.ravel list F", lambda: np.ravel([[1, 2], [3, 4]], "F"), m)
show("np.ravel default", lambda: np.ravel(m.T), m)
show("ravel default", lambda: m.T.ravel(), m)
show("flatten default", lambda: m.T.flatten(), m)

# the order argument: either case, bytes, None as 'C'; anything else refused as NumPy refuses it
for bad in ("X", "k", "f", "a", None, b"F", b"K", 1, "", "CF", 1.5, [1], m):
    show("np.ravel order %r" % (bad,), lambda: np.ravel(m.T, order=bad), m)
    show("ravel order %r" % (bad,), lambda: m.T.ravel(order=bad), m)
    show("flatten order %r" % (bad,), lambda: m.T.flatten(order=bad), m)

# a write through the result reaches the source exactly when ravel gave a view
for sname in ("C", "F", "T", "3dT", "Fslice", "rev", "strided", "unitT"):
    for order in ("C", "F", "A", "K"):
        s = {"T": lambda: np.arange(6).reshape(2, 3).T, "3dT": lambda: np.arange(24).reshape(2, 3, 4).transpose(2, 0, 1),
             "Fslice": lambda: np.asfortranarray(np.arange(12).reshape(3, 4))[:, 1:3], "rev": lambda: np.arange(6).reshape(2, 3)[::-1],
             "strided": lambda: np.arange(12).reshape(3, 4)[:, ::2], "unitT": lambda: np.arange(6).reshape(2, 1, 3).transpose(2, 1, 0),
             "F": lambda: np.asfortranarray(np.arange(6).reshape(2, 3)), "C": lambda: np.arange(6).reshape(2, 3)}[sname]()
        r = s.ravel(order)
        r[0] = 100
        f = s.flatten(order)
        f[-1] = -1
        print("write", sname, order, s.tolist(), r.tolist())

# np.reshape takes shape, not NumPy 1's newshape=
show("np.reshape newshape=", lambda: np.reshape(m, newshape=(3, 2)), m)
show("np.reshape shape=", lambda: np.reshape(m, shape=(3, 2)), m)
