# A test-only stand-in for the mpmath core (test/mpmath-overlay.test.ts): every hook the overlay takes from
# _sagebrush_mpcore is a function of this module that calls the python backend's own, from a second copy of mpmath's
# libmp, the package _mpref_libmp (the test copies it onto sys.path), imported under SAGEBRUSH_MPMATH_BACKEND=python.
# So mpmath selected as 'sagebrush' must give exactly the python backend's results: this proves the wiring, and
# nothing about the core. HOOKED records each name called.
import os
import sys

HOOKED = set()

_saved = os.environ.get("SAGEBRUSH_MPMATH_BACKEND")
os.environ["SAGEBRUSH_MPMATH_BACKEND"] = "python"
try:
    import _mpref_libmp
    from _mpref_libmp import backend as _ref_backend
finally:
    os.environ["SAGEBRUSH_MPMATH_BACKEND"] = _saved
assert _ref_backend.BACKEND == "python"


def _hook(module, name):
    target = getattr(sys.modules["_mpref_libmp." + module], name)

    def f(*args, **kw):
        HOOKED.add(name)
        return target(*args, **kw)

    f.__name__ = f.__qualname__ = name
    return f


for _m, _n in _ref_backend.SAGEBRUSH_HOOKS:
    if _n not in globals():
        globals()[_n] = _hook(_m, _n)
del _m, _n


def __getattr__(name):
    # (the context: mpmath's own PythonMPContext, of the copy being tested)
    if name == "Context":
        from mpmath.ctx_mp_python import PythonMPContext
        globals()["Context"] = PythonMPContext
        return PythonMPContext
    raise AttributeError(name)
