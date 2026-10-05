"""Sagebrush's engines, in WebAssembly: the same API as the native CPython
package (engine/py; see engine/TRY.md), single-threaded here (`threads` is
accepted and ignored).

    from sagebrush import modsym, ap, mf
    modsym.charpoly_exact(37, 2)["charpoly"]     # [0, -6, -1, 1], proven
    ap.aplist([0, -1, 1, -10, -20], 30)          # 11a1: [(2, -2), (3, -1), ...]
    mf.dims(23, 2)                               # dimensions of S_2, E_2, ...
    mf.newforms(23, 2)["newforms"]               # LMFDB's 23.2.a.a, with trace form
    poly.factor([0, -6, -1, 1])                  # (1, [([-3, 1], 1), ([0, 1], 1), ([2, 1], 1)])
"""

from . import modsym, ap, mf, poly

__all__ = ["modsym", "ap", "mf", "poly"]
