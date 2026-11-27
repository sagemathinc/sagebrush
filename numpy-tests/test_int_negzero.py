# Negating, and the unary ufuncs after it, on integer arrays at 0: an
# integer has no -0, so the result reads back as 0.0 and 1 / x is inf
# (numpy-tests/run.py compares this with NumPy).
import warnings
import numpy as np

warnings.simplefilter("ignore")  # (NumPy warns of the divide-by-zero values)


def show(name, x):
    x = np.asarray(x)
    f = x.astype(np.float64)
    print(name, x.dtype, [repr(float(v)) for v in f.ravel()], [repr(float(v)) for v in (1 / f).ravel()],
          np.signbit(f).ravel().tolist())


z = np.array([0, 1, -2, 0])
for dt in (np.int64, np.int32, np.int16, np.int8, np.uint8, np.uint16, np.uint32):
    a = z.astype(dt)
    show("neg " + np.dtype(dt).name, -a)
    show("negative " + np.dtype(dt).name, np.negative(a))
    show("abs neg " + np.dtype(dt).name, np.abs(-a))
    show("absolute neg " + np.dtype(dt).name, np.absolute(-a))
    show("pos neg " + np.dtype(dt).name, +(-a))
    show("trunc neg " + np.dtype(dt).name, np.trunc(-a))
    if np.dtype(dt).itemsize > 1:  # (rint of an 8-bit integer is float16, not supported yet)
        show("rint neg " + np.dtype(dt).name, np.rint(-a))
    show("sign neg " + np.dtype(dt).name, np.sign(-a))
show("uint64 neg", -np.array([0], dtype=np.uint64))
show("issue example 1/x", 1 / -np.array([0, 1]))
show("issue example astype", (-np.array([0, 1])).astype(float))
show("issue example negative", np.negative(np.array([0])).astype(float))
show("neg 2d", -np.zeros((2, 3), dtype=np.int64))
show("neg strided", -np.array([[0, 1], [0, 2]])[:, 0])
show("neg fortran", -np.asfortranarray(np.zeros((2, 3), dtype=np.int64)))
show("neg 0d", -np.array(0))
show("neg scalar", -np.int64(0))
show("neg element", (-np.array([0]))[0])
show("negative list", np.negative([0, 0]))
show("negative out", np.negative(np.array([0, 1]), out=np.empty(2, dtype=np.int64)))
show("negative where", np.negative(np.zeros(3, dtype=np.int64), where=np.array([True, False, True]),
                                   out=np.ones(3, dtype=np.int64)))
show("copysign", np.copysign(1.0, -np.array([0])))
show("tolist", np.array((-np.array([0, 0])).tolist(), dtype=float))
show("item", float((-np.array([0])).item()))
# (already +0: the binary operations, reductions, and float negation, which keeps -0.0)
show("mul -1", np.array([0]) * -1)
show("sub", np.array([3]) - 3)
show("floor_divide", np.array([0]) // np.array([-7]))
show("prod", np.prod(np.array([0, -1])))
show("cumsum neg", np.cumsum(-np.array([0, 0])))
show("astype int from -0.0", np.array([-0.0, -0.4]).astype(np.int64))
show("neg float", -np.array([0.0, -0.0]))
show("neg float32", -np.array([0.0, -0.0], dtype=np.float32))
