# mpmath's backend as the overlay selects it (test/mpmath-overlay.test.ts): argv[1:] go first on sys.path (the
# stand-in core and its reference copy). It prints the backend, then results that reach every hook the 'sagebrush'
# branches take, as raw tuples, so a run selected 'python' and one selected 'sagebrush' over the stand-in must print the
# same lines but the first and the last (the hooks the stand-in saw called).
import pickle
import sys

sys.path[:0] = sys.argv[1:]
import mpmath
from mpmath import libmp, mp

print("backend", libmp.BACKEND, libmp.backend.MPZ is int, type(mpmath.mpf(3).man).__name__)
mp.prec = 113
x, y, z = mpmath.mpf(2) / 3, mpmath.mpf("1.5e-7"), mpmath.mpc(1, 2)
print("arith", (x + y)._mpf_, (x - y)._mpf_, (x * y)._mpf_, (x / y)._mpf_, mpmath.sqrt(x)._mpf_)
print("elem", mpmath.exp(x)._mpf_, mpmath.log(x)._mpf_, mpmath.cos(x)._mpf_, mpmath.sin(x)._mpf_, (x ** y)._mpf_)
print("mpc", mpmath.exp(z)._mpc_, mpmath.sqrt(z)._mpc_)
E, I, F = libmp.libelefun, libmp.libintmath, libmp.libmpf
print("fixed", E.exp_fixed(1 << 100, 100), E.cos_sin_fixed(1 << 99, 100), E.log_int_fixed(7, 100))
print("int", I.bitcount(10 ** 40), I.trailing(3 << 77), I.isqrt(10 ** 41), I.sqrtrem(10 ** 41), I.ifac(30))
print("norm", F.normalize(0, 12345 << 3, -3, 17, 10, "n"), F.normalize1(0, 12345, 0, 14, 10, "d"), F.from_man_exp(-96, 3))
print("pickle", pickle.loads(pickle.dumps(x)) == x, pickle.dumps(x, 2))
for name in ("gmpy2", "gmpy", "sage"):
    try:
        __import__(name)
        print("imported", name)
    except ImportError:
        print("ImportError", name)
core = sys.modules.get("_sagebrush_mpcore")
print("hooked", sorted(core.HOOKED) if core else None)
