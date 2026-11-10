"""mpmath's backend 'sagebrush' under CPython: the hooks the overlay takes
from ``_sagebrush_mpcore`` (packages/pypi-mpmath/overlay.patch), each with the
reference's signature, running in the multiprecision core natively
(``sagebrush._native.mp``, engine/mp: the same Rust the browser runs as
WebAssembly).  ``Context`` is mpmath's own PythonMPContext here: the native
number type is the WebAssembly runtime's (src/runtime/mpcore.ts)."""

from ._native import mp as _mp

_run = _mp.run
reset = _mp.reset

# engine/mp's abi::op codes
_OP = dict(mpf_add=1, mpf_sub=2, mpf_mul=3, mpf_div=4, mpf_sqrt=5, mpf_exp=6,
           mpf_log=7, mpf_cos=8, mpf_sin=9, mpf_pow=10, _normalize=11,
           _normalize1=12, from_man_exp=13, mpc_exp=14, mpc_sqrt=15,
           exp_fixed=16, cos_sin_fixed=17, log_int_fixed=18, pi_fixed=19,
           ln2_fixed=20, e_fixed=21, bitcount=22, trailing=23, isqrt=24,
           sqrtrem=25, ifac=26, mpc_mul=27, mpc_div=28, mpc_abs=29,
           mpf_gamma=30, mat_lu=31, mat_inverse=32, mat_det=33, mat_lu_solve=34,
           mat_cholesky=35, mat_cholesky_solve=36)
_RND = {'n': 0, 'f': 1, 'c': 2, 'd': 3, 'u': 4}
_COMPLEX = {'mpf_sqrt': "square root of a negative number",
            'mpf_log': "logarithm of a negative number",
            'mpf_pow': "negative number raised to a fractional power"}


def _fail(name, code, detail):
    if code == -3:
        if name in ('mpf_div', 'mpf_pow', 'mpc_div'):
            raise ZeroDivisionError
        raise ZeroDivisionError("integer division or modulo by zero")
    if code == -4:
        from mpmath.libmp.libmpf import ComplexResult
        raise ComplexResult(_COMPLEX.get(name, "complex result"))
    if code == -5:
        raise KeyError(0)
    if code == -6:
        raise ZeroDivisionError('matrix is numerically singular')
    if code == -8:
        raise ValueError('matrix is not positive-definite')
    if code in (-1, -2):
        raise MemoryError("a multiprecision number of %d limbs" % int(detail[0]))
    raise SystemError("the multiprecision core failed: %s refused (%d)" % (name, code))


def _call(name, args, prec, rnd, one=True):
    n, r = _run(_OP[name], args, prec or 0, _RND[rnd])
    if n < 0:
        _fail(name, n, r)
    if n == 0:
        return None
    return r[0] if n == 1 and one else r


def mpf_add(s, t, prec=0, rnd='d', _sub=0):
    return _call('mpf_sub' if _sub else 'mpf_add', (s, t), prec, rnd)

def mpf_sub(s, t, prec=0, rnd='d'):
    return _call('mpf_sub', (s, t), prec, rnd)

def mpf_mul(s, t, prec=0, rnd='d'):
    return _call('mpf_mul', (s, t), prec, rnd)

def mpf_div(s, t, prec, rnd='d'):
    return _call('mpf_div', (s, t), prec, rnd)

def mpf_pow(s, t, prec, rnd='d'):
    return _call('mpf_pow', (s, t), prec, rnd)

def mpf_sqrt(s, prec, rnd='d'):
    return _call('mpf_sqrt', (s,), prec, rnd)

def mpf_exp(x, prec, rnd='d'):
    return _call('mpf_exp', (x,), prec, rnd)

def mpf_log(x, prec, rnd='d'):
    return _call('mpf_log', (x,), prec, rnd)

def mpf_cos(x, prec, rnd='d'):
    return _call('mpf_cos', (x,), prec, rnd)

def mpf_sin(x, prec, rnd='d'):
    return _call('mpf_sin', (x,), prec, rnd)

def _normalize(sign, man, exp, bc, prec, rnd):
    return _call('_normalize', ((sign, man, exp, bc),), prec, rnd)

def _normalize1(sign, man, exp, bc, prec, rnd):
    return _call('_normalize1', ((sign, man, exp, bc),), prec, rnd)

def from_man_exp(man, exp, prec=None, rnd='d'):
    return _call('from_man_exp', (man, exp), prec, rnd)

def mpc_exp(z, prec, rnd='d'):
    return _call('mpc_exp', tuple(z), prec, rnd, False)

def mpc_sqrt(z, prec, rnd='d'):
    return _call('mpc_sqrt', tuple(z), prec, rnd, False)

def mpc_mul(z, w, prec, rnd='d'):
    return _call('mpc_mul', (z[0], z[1], w[0], w[1]), prec, rnd, False)

def mpc_div(z, w, prec, rnd='d'):
    return _call('mpc_div', (z[0], z[1], w[0], w[1]), prec, rnd, False)

def mpc_abs(z, prec, rnd='d'):
    return _call('mpc_abs', tuple(z), prec, rnd)

def exp_fixed(x, prec, ln2=None):
    return _call('exp_fixed', (x, ln2), prec, 'n')

def cos_sin_fixed(x, prec, pi2=None):
    return _call('cos_sin_fixed', (x, pi2), prec, 'n', False)

def log_int_fixed(n, prec, ln2=None):
    return _call('log_int_fixed', (n, ln2), prec, 'n')

def pi_fixed(prec, **kwargs):
    return _call('pi_fixed', (), prec, 'n')

def ln2_fixed(prec, **kwargs):
    return _call('ln2_fixed', (), prec, 'n')

def e_fixed(prec, **kwargs):
    return _call('e_fixed', (), prec, 'n')

def bitcount(n):
    return _call('bitcount', (n,), 0, 'n')

def trailing(n):
    return _call('trailing', (n,), 0, 'n')

def isqrt(x):
    if x < 0:
        int(complex(0))
    return _call('isqrt', (x,), 0, 'n')

def sqrtrem(x):
    if x < 0:
        int(complex(0))
    return _call('sqrtrem', (x,), 0, 'n', False)

def ifac(n, memo={0: 1, 1: 1}):
    # (the reference's own steps on its memo: under CPython these are cheap)
    f = memo.get(n)
    if f:
        return f
    k = len(memo)
    p = memo[k - 1]
    while k <= n:
        p *= k
        if k <= 1000:
            memo[k] = p
        k += 1
    return p

def mpf_gamma(x, prec, rnd='d', type=0):
    return _call('mpf_gamma', (x, type), prec, rnd)


# Dense linear algebra on real matrices, a whole operation a call: the
# entries a list of raw mpfs, row-major, and n (engine/mp's linalg.rs).
def mat_lu(a, n, prec, rnd='n'):
    return _call('mat_lu', (list(a), n), prec, rnd, False)

def mat_inverse(a, n, prec, rnd='n'):
    return _call('mat_inverse', (list(a), n), prec, rnd)

def mat_det(a, n, prec, rnd='n'):
    d = _call('mat_det', (list(a), n), prec, rnd)
    return 0 if d is None else d

def mat_lu_solve(a, b, n, prec, rnd='n'):
    # (n: A's column count; more rows than columns is an overdetermined system)
    return _call('mat_lu_solve', (list(a), list(b), n), prec, rnd)

def mat_cholesky(a, n, prec, rnd='n'):
    return _call('mat_cholesky', (list(a), n), prec, rnd)

def mat_cholesky_solve(a, b, n, prec, rnd='n'):
    return _call('mat_cholesky_solve', (list(a), list(b), n), prec, rnd)


def __getattr__(name):
    if name == 'Context':
        from mpmath.ctx_mp_python import PythonMPContext
        return PythonMPContext
    raise AttributeError("module '_sagebrush_mpcore' has no attribute '%s'" % name)
