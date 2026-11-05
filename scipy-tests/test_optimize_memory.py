"""approx_derivative's working memory (astra's OPT671-WORK-1), bounded apart from
its formula: under CPython this repository's lib/scipy/optimize.py itself,
loaded by path with real NumPy, is traced with tracemalloc, and each call's
peak, everything it holds at once, must be at most the admission it charges.
Under Sagebrush the same calls run admitted.  Either way each line is the case
and "ok", so the two runs print the same."""
import os
import numpy as np
try:
    import tracemalloc
    import importlib.util
    spec = importlib.util.spec_from_file_location("sb_optimize", os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "lib", "scipy", "optimize.py"))
    opt = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(opt)
except ImportError:
    tracemalloc = None
    from scipy import optimize as opt

charged = [0]
admit = opt._admit


def spy(nbytes, what):
    charged[0] = max(charged[0], nbytes)
    admit(nbytes, what)


opt._admit = spy
CASES = [
    ("2-point 256 x 256", lambda x: x * x, np.ones(256), "2-point", None),
    ("3-point 4096 x 1", lambda x: x[:1] * x[0], np.ones(4096), "3-point", None),
    ("3-point one-sided 4096 x 1", lambda x: x[:1] * x[0], np.ones(4096), "3-point", (np.ones(4096), np.inf)),
    ("3-point 1 x 4096", lambda x: x[0] * np.arange(4096.0), np.ones(1), "3-point", None),
    ("cs 2048 x 1", lambda x: x[:1] * x[0], np.ones(2048), "cs", None),
    ("2-point 4096 x 1", lambda x: x[:1] * x[0], np.ones(4096), "2-point", None),
]
for name, f, x0, method, bounds in CASES:
    charged[0] = 0
    kw = {} if bounds is None else {"bounds": bounds}
    if tracemalloc is not None:
        tracemalloc.start()
        base = tracemalloc.get_traced_memory()[0]
    J = opt.approx_derivative(f, x0, method=method, **kw)
    if tracemalloc is not None:
        peak = tracemalloc.get_traced_memory()[1] - base
        tracemalloc.stop()
        assert charged[0] > 0 and peak <= charged[0], (name, peak, charged[0])
    print(name, "ok", J.shape)
