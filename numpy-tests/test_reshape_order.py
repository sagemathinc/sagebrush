# reshape's order: ndarray.reshape(..., order=) and np.reshape(a, shape, order=), 'C', 'F' and 'A', as NumPy's:
# the values, the result's strides and contiguity, which results are views of the input (a write through them),
# copy=True, and NumPy's errors for a bad order.
import numpy as np


def show(name, f):
    try:
        r = f()
        if isinstance(r, np.ndarray):
            print(name, "->", repr(r), r.strides, r.flags["C_CONTIGUOUS"], r.flags["F_CONTIGUOUS"])
        else:
            print(name, "->", repr(r))
    except Exception as e:
        print(name, "!!", type(e).__name__, e)


def writes_through(make, shape, order, at):
    # (whether a write into the result reaches the input: NumPy's view or copy)
    x = make()
    r = x.reshape(shape, order=order)
    r[at] = -1
    return x.tolist()


a = np.arange(6)
m = np.arange(12).reshape(3, 4)
fm = np.asfortranarray(np.arange(12).reshape(3, 4))
t3 = np.arange(24).reshape(2, 3, 4)
for name, f in [
    # Fortran order
    ("F-1d", lambda: a.reshape(2, 3, order="F")), ("F-tuple", lambda: a.reshape((2, 3), order="F")),
    ("F-list", lambda: a.reshape([3, 2], order="F")), ("F-minus1", lambda: a.reshape(-1, 2, order="F")),
    ("F-2d", lambda: m.reshape(4, 3, order="F")), ("F-ravel", lambda: m.reshape(-1, order="F")),
    ("F-2d-to-3d", lambda: m.reshape(2, 3, 2, order="F")), ("F-3d", lambda: t3.reshape(4, 6, order="F")),
    ("F-3d-to-1d", lambda: t3.reshape(24, order="F")), ("F-fortran-input", lambda: fm.reshape(2, 6, order="F")),
    ("F-transposed", lambda: m.T.reshape(2, 6, order="F")), ("F-strided", lambda: a[::2].reshape(3, 1, order="F")),
    ("F-same-shape", lambda: m.reshape(3, 4, order="F")), ("F-0d", lambda: np.array(5).reshape(1, 1, order="F")),
    ("F-to-0d", lambda: np.array([7]).reshape((), order="F")), ("F-empty", lambda: np.zeros((0, 3)).reshape(3, 0, order="F")),
    ("F-bool", lambda: (a > 2).reshape(3, 2, order="F")), ("F-float32", lambda: a.astype(np.float32).reshape(2, 3, order="F")),
    ("F-complex", lambda: (a + 1j * a).reshape(3, 2, order="F")), ("F-str", lambda: np.array(list("abcdef")).reshape(2, 3, order="F")),
    # C order, and the order spellings
    ("C", lambda: a.reshape(2, 3, order="C")), ("C-fortran-input", lambda: fm.reshape(2, 6, order="C")),
    ("lowercase-f", lambda: a.reshape(2, 3, order="f")), ("lowercase-c", lambda: a.reshape(2, 3, order="c")),
    ("bytes-F", lambda: a.reshape(2, 3, order=b"F")), ("None", lambda: a.reshape(2, 3, order=None)),
    # 'A': Fortran order only for a Fortran-contiguous array that isn't C-contiguous
    ("A-c-input", lambda: m.reshape(2, 6, order="A")), ("A-fortran-input", lambda: fm.reshape(2, 6, order="A")),
    ("A-transposed", lambda: m.T.reshape(2, 6, order="A")), ("A-1d", lambda: a.reshape(2, 3, order="A")),
    ("A-strided", lambda: m[:, ::2].reshape(3, 2, order="A")),
    # np.reshape
    ("np-F", lambda: np.reshape(m, (2, 6), order="F")), ("np-A", lambda: np.reshape(fm, (6, 2), order="A")),
    ("np-shape-kw", lambda: np.reshape(m, shape=(2, 6), order="F")), ("np-list-input", lambda: np.reshape([[1, 2], [3, 4]], 4, order="F")),
    ("np-str", lambda: np.reshape(np.array([["a", "b"], ["c", "d"]]), 4, order="F")),
    # copy=True: a copy in the order asked for
    ("copy-F", lambda: a.reshape(2, 3, order="F", copy=True)), ("copy-C", lambda: m.reshape(2, 6, order="C", copy=True)),
    ("np-copy-F", lambda: np.reshape(fm, (6, 2), order="F", copy=True)),
    # views and copies: a write through the result reaches the input only where NumPy's is a view
    ("view-1d-F", lambda: writes_through(lambda: np.arange(6), (2, 3), "F", (1, 0))),
    ("copy-c-input-F", lambda: writes_through(lambda: np.arange(12).reshape(3, 4), (4, 3), "F", (0, 1))),
    ("view-fortran-input-F", lambda: writes_through(lambda: np.asfortranarray(np.arange(12).reshape(3, 4)), (2, 6), "F", (1, 1))),
    ("view-fortran-input-A", lambda: writes_through(lambda: np.asfortranarray(np.arange(12).reshape(3, 4)), (6, 2), "A", (0, 1))),
    ("copy-fortran-input-C", lambda: writes_through(lambda: np.asfortranarray(np.arange(12).reshape(3, 4)), (2, 6), "C", (0, 1))),
    ("copy-flag-F", lambda: writes_through(lambda: np.arange(6), (2, 3), "F", (0, 0)) if False else (lambda x: (x.reshape(2, 3, order="F", copy=True).__setitem__((0, 0), -1), x.tolist())[1])(np.arange(6))),
    # errors
    ("bad-order", lambda: a.reshape(2, 3, order="X")), ("order-K", lambda: a.reshape(2, 3, order="K")),
    ("order-k", lambda: a.reshape(2, 3, order="k")), ("order-long", lambda: a.reshape(2, 3, order="Fortran")),
    ("order-empty", lambda: a.reshape(2, 3, order="")), ("order-bool", lambda: a.reshape(2, 3, order=True)),
    ("order-int", lambda: a.reshape(2, 3, order=1)), ("np-bad-order", lambda: np.reshape(a, (2, 3), order="Z")),
    ("np-order-K", lambda: np.reshape(a, (2, 3), order="K")), ("F-bad-size", lambda: a.reshape(4, 2, order="F")),
    ("F-two-minus1", lambda: a.reshape(-1, -1, order="F")),
]:
    show(name, f)

# NumPy's reshape without a copy where the strides allow it, in either order (and so a write through the result
# reaches the input), its unknown dimensions, and copy=False
s2 = np.arange(12).reshape(3, 4)[:, ::2]
for name, f in [
    ("C-strided-1d", lambda: np.arange(6)[::2].reshape(3, 1)), ("C-strided-2d", lambda: s2.reshape(3, 2, 1)),
    ("C-strided-split", lambda: np.arange(24).reshape(4, 6)[:, ::3].reshape(2, 2, 2)), ("C-transposed", lambda: np.arange(6).reshape(2, 3).T.reshape(3, 2)),
    ("C-transposed-flat", lambda: np.arange(6).reshape(2, 3).T.reshape(6)), ("C-column", lambda: np.arange(6).reshape(2, 3)[:, 1:2].reshape(2)),
    ("F-column", lambda: np.arange(6).reshape(2, 3)[:, 1:2].reshape(1, 2, order="F")), ("C-one-element", lambda: np.arange(6)[2:3].reshape(1, 1)),
    ("F-strided-split", lambda: np.asfortranarray(np.arange(24).reshape(4, 6))[::2].reshape(2, 6, order="F")),
    ("C-empty-strided", lambda: np.zeros((4, 0))[::2].reshape(0, 2)), ("str-strided-F", lambda: np.array(list("abcdef"))[::2].reshape(3, 1, order="F")),
    ("writes-C-strided", lambda: (lambda x: (x[:, ::2].reshape(3, 2, 1).__setitem__((1, 1, 0), -1), x.tolist())[1])(np.arange(12).reshape(3, 4))),
    ("writes-C-transposed", lambda: (lambda x: (x.T.reshape(3, 2).__setitem__((0, 0), -1), x.tolist())[1])(np.arange(6).reshape(2, 3))),
    ("writes-C-transposed-flat", lambda: (lambda x: (x.T.reshape(6).__setitem__(1, -1), x.tolist())[1])(np.arange(6).reshape(2, 3))),
    ("unknown-negative-2", lambda: np.arange(6).reshape(-2, 3)), ("unknown-F", lambda: np.arange(6).reshape(-2, 3, order="F")),
    ("two-unknown", lambda: np.arange(6).reshape(-1, -1)), ("bad-unknown", lambda: np.arange(6).reshape(4, -1)),
    ("bad-size-1d", lambda: np.arange(6).reshape(4)), ("zero-unknown", lambda: np.zeros((0, 3)).reshape(-1, 0)),
    ("zero-unknown-2", lambda: np.zeros((0, 3)).reshape(0, -1)), ("same-shape-strided", lambda: np.arange(6)[::2].reshape(3)),
    ("copy-False-view", lambda: np.arange(12).reshape(3, 4).reshape(2, 6, copy=False)), ("copy-False-needs-copy", lambda: np.arange(12).reshape(3, 4).T.reshape(12, copy=False)),
    ("copy-False-F", lambda: np.arange(12).reshape(3, 4).reshape(2, 6, order="F", copy=False)), ("np-copy-False", lambda: np.reshape(np.arange(12).reshape(3, 4).T, 12, copy=False)),
    ("copy-False-fortran-F", lambda: np.asfortranarray(np.arange(12).reshape(3, 4)).reshape(2, 6, order="F", copy=False)),
]:
    show(name, f)
