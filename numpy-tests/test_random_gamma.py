# RandomState.gamma and standard_gamma: NumPy's legacy draws for a seed, bit for bit (Marsaglia and Tsang's method
# from the legacy gauss for a shape of at least 1, the legacy rejection method below 1, the exponential at 1), the
# stream they leave (the next draws, a cached gauss), array parameters, sizes, the module functions and the errors.
import hashlib

import numpy as np


def h(a):
    a = np.asarray(a, dtype=float)
    return a.shape, hashlib.sha256(" ".join(x.hex() for x in a.ravel().tolist()).encode()).hexdigest()[:16], \
        [x.hex() for x in a.ravel()[:2].tolist()]


def show(name, f):
    try:
        print(name, f())
    except Exception as e:
        print(name, "!!", type(e).__name__, e)


for seed in (0, 1, 42, 12345):
    for shape in (0.05, 0.3, 0.5, 0.999, 1.0, 1.001, 1.5, 2.0, 7.25, 100.0, 1e6):
        r = np.random.RandomState(seed)
        show("gamma seed %d shape %r" % (seed, shape), lambda: (h(r.gamma(shape, 2.5, size=500)), r.random_sample().hex()))
for seed in (3, 7):
    r = np.random.RandomState(seed)
    show("scalar %d" % seed, lambda: [r.gamma(s).hex() for s in (0.4, 1.0, 3.0, 0.0)] + [type(r.gamma(2.0)).__name__])
    r = np.random.RandomState(seed)
    show("standard_gamma %d" % seed, lambda: (h(r.standard_gamma(0.7, size=(20, 3))), h(r.standard_gamma(4.0, size=7))))
    # (a gauss left cached by the odd count of gauss draws: randn after gamma continues NumPy's stream)
    r = np.random.RandomState(seed)
    show("after gauss %d" % seed, lambda: (h(r.randn(3)), h(r.gamma(5.0, size=3)), h(r.randn(4))))

# (shapes below 1 over many draws, hashed over the raw bytes: their pow is glibc's, correctly rounded, which a
# JavaScript Math.pow differs from for about one draw in a thousand at exponent 2, shape 0.5)
for shape in (0.5, 0.25):
    r = np.random.RandomState(99)
    show("many shape %r" % shape, lambda: hashlib.sha256(r.gamma(shape, size=20000).tobytes()).hexdigest()[:16])
# (a zero shape draws nothing: the stream after it is unchanged)
r = np.random.RandomState(8)
show("zero shape draws nothing", lambda: (r.gamma(0.0), r.standard_gamma(0.0), r.random_sample().hex()))

# (exact ties at the rejection tests' boundaries, reached through set_state: a state whose next draws make U equal
# 1 - shape, X equal V, or 1 + c*X equal 0 (from a cached gauss, an int); the value drawn, the next draw and the
# state's position, as NumPy's)
ties = [("accept X equals V", 0.5, [0, 0, 0, 0], 0, 0.0),
        ("U threshold 0.1", 0.1, [3365886098, 2966380640, 2027307812, 3412492598], 0, 0.0),
        ("U threshold 0.2", 0.2, [925764274, 1558554413, 2027307812, 3412492598], 0, 0.0),
        ("U threshold 0.3", 0.3, [886559510, 3412492598, 2027307812, 3412492598], 0, 0.0),
        ("U threshold 0.4", 0.4, [3412492598, 925764274, 2027307812, 3412492598], 0, 0.0),
        ("U threshold 0.8", 0.8, [3033002258, 3412492598, 2027307812, 3412492598], 0, 0.0),
        ("U threshold 0.9", 0.9, [1266066226, 925764274, 2027307812, 3412492598], 0, 0.0),
        ("V equals zero", 1.3333333333333333, [], 1, -3)]
for name, shape, prefix, has, gauss in ties:
    r = np.random.RandomState(123)
    key = r.get_state()[1].tolist()
    key[:len(prefix)] = prefix
    r.set_state(("MT19937", np.array(key, dtype=np.uint32), 0, has, gauss))
    show("tie " + name, lambda: (r.gamma(shape).hex(), r.random_sample().hex(), r.get_state()[2]))

r = np.random.RandomState(5)
show("array shape", lambda: h(r.gamma([0.5, 1.0, 2.0, 9.0], [1.0, 2.0, 0.5, 3.0])))
show("array broadcast", lambda: h(r.gamma([[0.3], [3.0]], size=(2, 4))))
show("array scale only", lambda: h(r.gamma(2.0, [1.0, 10.0, 100.0])))
show("size tuple", lambda: h(r.gamma(1.5, size=(3, 2))))
show("size 0", lambda: h(r.gamma(1.5, size=0)))
show("nan shape", lambda: r.gamma(float("nan")))
show("zero shape size", lambda: h(r.gamma(0.0, size=3)))
show("zero scale", lambda: h(r.gamma(3.0, 0.0, size=2)))
np.random.seed(11)
show("module gamma", lambda: h(np.random.gamma(2.0, 3.0, size=10)))
show("module standard_gamma", lambda: h(np.random.standard_gamma(0.25, size=10)))
show("negative shape", lambda: np.random.RandomState(0).gamma(-1.0))
show("negative scale", lambda: np.random.RandomState(0).gamma(1.0, -2.0))
show("negative in array", lambda: np.random.RandomState(0).gamma([1.0, -0.5]))
show("negative standard", lambda: np.random.RandomState(0).standard_gamma(-0.1))
