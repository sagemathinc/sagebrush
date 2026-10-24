"""Sagebrush's engines, in WebAssembly: the same API as the native CPython
package (engine/py; see engine/TRY.md), single-threaded here (`threads` is
accepted and ignored).

    from sagebrush import modsym, ap, mf
    modsym.charpoly_exact(37, 2)["charpoly"]     # [0, -6, -1, 1], proven
    ap.aplist([0, -1, 1, -10, -20], 30)          # 11a1: [(2, -2), (3, -1), ...]
    mf.dims(23, 2)                               # dimensions of S_2, E_2, ...
    mf.newforms(23, 2)["newforms"]               # LMFDB's 23.2.a.a, with trace form
    poly.factor([0, -6, -1, 1])                  # (1, [([-3, 1], 1), ([0, 1], 1), ([2, 1], 1)])
    nf.bnf([-11, 0, 0, 1])["cyc"]                # [2]: Q(11^(1/3)), GRH
    linalg.det([[1, 2], [3, 4]])                 # -2, exact (multimodular)
"""

from . import modsym, ap, mf, poly, nf, linalg

__all__ = ["modsym", "ap", "mf", "poly", "nf", "linalg", "capabilities", "stop_points", "progress_snapshot"]


# ---- the agent API (estimates plan r3 §1.1): what this build provides,
# live progress, and the entry points of the pieces still to come, which
# refuse before running.

def capabilities():
    """What this build of the agent API provides: {"progress": True,
    "estimate": False, ...} (sagebrush.records.capabilities)."""
    from . import records
    return records.capabilities()


def stop_points(op):
    """The clean stop points implemented for op ([] in this build)."""
    from . import records
    return records.stop_points(op)


def progress_snapshot():
    """Every call in progress now, as sagebrush.progress/1 records
    (sagebrush.progress.snapshot)."""
    from . import progress
    return progress.snapshot()


def _unavailable(name):
    from . import records
    return records.unavailable("sagebrush." + name)


# (their signatures are the designs': design-estimates-progress r4 §3,
# design-agent-api-library r3 §5 and §6)
def estimate(f, *args, **kwds):
    """The time and memory estimate of f(*args, **kwds): not available in
    this build (sagebrush.capabilities())."""
    raise _unavailable("estimate")


def run(f, *args, **kwds):
    """f(*args, **kwds) as an outcome/1 record: not available in this build
    (sagebrush.capabilities())."""
    raise _unavailable("run")


def resume(checkpoint, **kwds):
    """Resumes a checkpoint: not available in this build
    (sagebrush.capabilities())."""
    raise _unavailable("resume")
