"""A small part of SciPy for Sagebrush in the browser: scipy.io's MATLAB
files (loadmat, savemat) and scipy.integrate (odeint, solve_ivp, quad,
simpson, ...) and scipy.special.  (Under CPython, use SciPy itself.)"""
__version__ = "0.0.sagebrush"

_SUBMODULES = ("integrate", "io", "special")


def __getattr__(name):
    # as SciPy: `import scipy` then scipy.integrate loads the submodule
    if name in _SUBMODULES:
        __import__("scipy." + name)
        return globals()[name]
    raise AttributeError("module 'scipy' has no attribute %r" % name)


def __dir__():
    return sorted(list(globals()) + list(_SUBMODULES))
