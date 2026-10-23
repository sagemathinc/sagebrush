# np.arange and np.linspace element for element as NumPy's: arange's length
# (NumPy's _calc_length) and its values (the first two set, the rest filled
# as start + i * delta in the dtype's arithmetic); linspace in float64,
# floored for an integer dtype (test/numpy-arange-linspace.test.ts).
import random
import numpy as np


def show(label, f):
    try:
        a = f()
    except Exception as e:
        print(label, "ERR", type(e).__name__, e)
        return
    if isinstance(a, tuple):
        a, step = a
        print(label, "step", float(step).hex())
    v = a.tolist()
    if a.dtype.kind == "f":
        v = [float(x).hex() for x in v]
    elif a.dtype.kind == "c":
        v = [(complex(x).real.hex(), complex(x).imag.hex()) for x in v]
    print(label, str(a.dtype), len(v), v)


ARANGE = [
    (-1, 1, 0.1), (0, 1, 0.1), (1, 0, -0.1), (0, -2, -0.3), (0.5, 3.7, 0.4), (10, 1, -1.5),
    (0, 5, 0.5, int), (0, 5, 0.5, np.int32), (0, -5, -0.7, int), (0.3, 4, 0.9, int),
    (0, 6, 1.5, np.uint8), (0, 300, 50, np.int8), (0, 70000, 9000, np.int16),
    (0, 1, 0.1, np.float32), (-1, 1, 0.1, np.float32), (0.25, 7, 0.3, np.float32),
    (2, 10, 3, float), (0, 10, 3), (10, 0, -3), (-7, 7, 2), (0, 2**40, 2**38),
    (1e16, 1e16 + 10, 2.0), (0, 1, 3), (0, 0, 1), (5, 1, 1), (0.1, 0.30000000000000004, 0.1),
    (0, 1e-300, 1e300), (0, -1e-300, 1e300), (1e-300, 0, 1e300),
    (0, 3, 1, complex), (0, 2, 0.5, np.complex64), (0, 1, 0.5, bool), (0, 2, 1, bool), (0, 3, 1, bool),
    (3,), (2.5,), (-3, 3), (0, float("nan")), (0, float("inf")), (0, 5, float("inf")),
]
for args in ARANGE:
    if len(args) == 4:
        show("arange%r" % (args,), lambda: np.arange(args[0], args[1], args[2], dtype=args[3]))
    else:
        show("arange%r" % (args,), lambda: np.arange(*args))

LINSPACE = [
    (0, 1, 5), (0, 1, 5, False), (-1, 0, 4, True, int), (-2.5, 2.5, 6, True, int), (0, 10, 4, False, int),
    (-7, 3, 9, True, np.int8), (0, 1, 1), (0, 1, 0), (0, 1, 1, False), (1, 0, 7), (0, 5e-324, 3),
    (0, 1e-320, 4), (0, 1.5e-323, 7), (2e-323, 0, 9, False), (0, float("inf"), 1), (0, float("inf"), 3), (0.1, 0.7, 7), (0, 1, 3, True, np.float32),
    (3, 3, 4), (1, 10, 10, True, np.int32), (-1, 1, 5, True, np.uint8), (0, 2, 3, True, complex),
]
for args in LINSPACE:
    kw = {}
    if len(args) > 3:
        kw["endpoint"] = args[3]
    if len(args) > 4:
        kw["dtype"] = args[4]
    show("linspace%r" % (args,), lambda: np.linspace(args[0], args[1], args[2], **kw))
# sizes NumPy refuses on any machine: past intp, its ValueError; 6.94 EiB, its MemoryError
show("arange 1e18", lambda: np.arange(0, 1e18))
show("arange 2e18", lambda: np.arange(0, 2e18))
show("arange int 2**61..", lambda: np.arange(0, 2**61, dtype=np.int64))
show("linspace 2**62", lambda: np.linspace(0, 1, 2**62))
show("linspace 2**60", lambda: np.linspace(0, 1, 2**60))
show("zeros 2**61 complex", lambda: np.zeros(2**61, complex))
show("linspace retstep", lambda: np.linspace(0, 1, 5, retstep=True))
show("linspace float num", lambda: np.linspace(0, 1, 2.5))
# num as a NumPy scalar: an integer one taken, the others refused by their NumPy names (astra's CORR-PR55-1)
for v in (np.float32(5), np.float64(5), np.complex64(5), np.complex128(5), np.bool_(True), np.int8(5), np.int64(5), np.uint16(5), True):
    show("linspace num %s" % type(v).__name__, lambda: np.linspace(0, 1, v))

# many float progressions, every element to the bit
rng = random.Random(20261023)
for k in range(300):
    start = rng.uniform(-100, 100)
    step = rng.choice([1, -1]) * rng.uniform(0.01, 10) * rng.choice([1, 1e-3, 1e3])
    stop = start + step * rng.uniform(0, 60)
    show("sweep%d" % k, lambda: np.arange(start, stop, step))
    show("sweep32_%d" % k, lambda: np.arange(start, stop, step, dtype=np.float32))
    show("sweeplin%d" % k, lambda: np.linspace(start, stop, rng.randrange(0, 40), endpoint=rng.random() < 0.5))
