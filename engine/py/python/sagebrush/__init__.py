"""Sagebrush: fast, certified, parallel engines for research mathematics.

Engines are submodules:

    sagebrush.modsym    weight-2 modular symbols for Gamma0(N), sign +1
    sagebrush.ap        traces of Frobenius a_p of elliptic curves over Q
    sagebrush.mf        modular forms of weight k >= 2 with character: dimensions,
                        exact Hecke charpolys, newform orbits, trace forms
    sagebrush.nf        number fields (maximal orders, prime ideals, class
                        groups, units, regulators), integer factoring (ECM),
                        HNF, elementary divisors, LLL, complex roots
    sagebrush.poly      factoring in Z[x] and F_p[x]; products, gcds and exact
                        division in Z[x]
    sagebrush.linalg    exact matrices over ZZ and QQ: det, rank, rref, solve,
                        inverse, charpoly, kernel (multimodular, certified)
    sagebrush.sage      a Sage-compatible namespace over all of these:
                        from sagebrush.sage import *
    sagebrush.preparse  Sage syntax to Python (2^10, R.<x> = QQ[], 1/3 exact)
    sagebrush.session   a persistent, interruptible session in a subprocess
    sagebrush.mcp_server  the MCP server for AI agents (command sagebrush-mcp)

nf, poly and linalg are the same pure-Python files as in the browser runtime
(lib/sagebrush), over the shared JSON dispatcher.
"""

import importlib.util as _util
import os as _os
import sys as _sys

from . import _compat  # noqa: E402,F401  (first: Python 3.10/3.11 get what the Sage layer uses of 3.12's)

__all__ = ["ap", "capabilities", "limit", "linalg", "mf", "modsym", "nf", "poly", "progress_snapshot", "set_limits", "stop_points"]


def _limits_module():
    """The session's one limits state: _sagelib/_limits.py as the top-level
    module _limits, the name the Sage layer's modules import it by
    (sagebrush.sage's finder resolves that name to this same file)."""
    m = _sys.modules.get("_limits")
    if m is None:
        path = _os.path.join(_os.path.dirname(__file__), "_sagelib", "_limits.py")
        spec = _util.spec_from_file_location("_limits", path)
        m = _util.module_from_spec(spec)
        _sys.modules["_limits"] = m
        try:
            spec.loader.exec_module(m)
        except BaseException:
            del _sys.modules["_limits"]
            raise
    return m


def set_limits(limits):
    """Set this session's engine limits (a mapping such as {"ff.work": 10**8}),
    before the first use of the finite-field layer, which reads them once:
    after it, RuntimeError.  Invalid limits raise ValueError and leave the
    limits set before unchanged.  Every key is "unlimited" by default (no
    work or time limit on your own computation; interrupt it instead): a
    finite value opts in to a limit, and "unlimited" may be given too.  The
    keys and the ranges of finite values: _limits.TABLE (plan-ff-limits r3,
    plan-c0 r2).  Memory guards always apply."""
    L = _limits_module()
    # (once locked, that is the answer, whatever the argument: astra)
    if L.finalized():
        raise RuntimeError(L.LOCKED)
    L.propose(L.validate(limits))


def limit(name):
    """This session's value of the engine limit name, such as
    "pandas.decoded_bytes": an int, or float("inf") where it is unlimited,
    every limit's default (set_limits sets finite ones).  The limits are read
    once: the first read locks them, as the first use of a limited layer
    does (set_limits after it raises RuntimeError).  An unknown name raises
    ValueError, listing the limits of this engine."""
    L = _limits_module()
    if not isinstance(name, str):
        raise TypeError("limit() argument must be a str, not %s" % type(name).__name__)
    if name not in L.TABLE:
        raise ValueError("limits: %s is not a limit of this engine (its limits: %s)" % (L._key_shown(name), ", ".join(sorted(L.TABLE))))
    return L.finalize()[name]


def _capacity_module():
    """_sagelib/_capacity.py as the top-level module _capacity, the name the
    Sage layer's guards import it by (as _limits_module does for _limits)."""
    m = _sys.modules.get("_capacity")
    if m is None:
        path = _os.path.join(_os.path.dirname(__file__), "_sagelib", "_capacity.py")
        spec = _util.spec_from_file_location("_capacity", path)
        m = _util.module_from_spec(spec)
        _sys.modules["_capacity"] = m
        try:
            spec.loader.exec_module(m)
        except BaseException:
            del _sys.modules["_capacity"]
            raise
    return m


def _capacity_share():
    """The memory of one default polynomial factorization (item D0), for the
    native engines, which ask once per factorization."""
    return _capacity_module().poly_share()


_TOTAL_STATUS = {"observed": 0, "zero": 1, "nominal": 2}


def _capacity_total():
    """The engine's memory total for its ledger (no-cliffs plan C r13, r17):
    (bytes, status code, joint, rows) from _capacity.engine_total and
    engine_rows, the rows being EVERY row that constrains the engine's
    domain as (kind, path, figure), the kind naming the row's own usage
    measure (a cgroup's usage file, RLIMIT_AS, RLIMIT_DATA, the physical
    row, Windows's rows); a row with no measure, or an incomplete
    classification, is an "unknown" row (the ledger is then not
    certified).  Asked when the engine's total is 100 ms old."""
    C = _capacity_module()
    t = C.engine_total()
    r = C.engine_rows()
    dirs = {name: (kind, d) for kind, name, d in (C._cgroup_dirs() or [])}
    rows = []
    for row in r["rows"]:
        src, figure = row["source"], int(row["figure"])
        if src in dirs:
            kind, d = dirs[src]
            rows.append(("cgroup", d + ("/memory.current" if kind == "v2" else "/memory.usage_in_bytes"), figure))
        elif src in _MEASURES:
            rows.append((_MEASURES[src], None, figure))
        else:
            rows.append(("unknown", None, figure))
    if not r["complete"]:
        rows.append(("unknown", None, 0))
    return int(t["bytes"]), _TOTAL_STATUS[t["status"]], bool(t["joint"]), rows


# (D0's row names -> the binding row's usage measure)
_MEASURES = {"RLIMIT_AS": "address_space", "RLIMIT_DATA": "data_segment", "MemAvailable": "physical",
             "windows job": "windows_job", "physical available": "windows_physical"}


def _limits_from_environment():
    """SAGEBRUSH_LIMITS=FILE: a JSON text of at most 4096 bytes, proposed
    (not locked) at import; an unreadable or invalid file is a ValueError
    from the import."""
    path = _os.environ.get("SAGEBRUSH_LIMITS")
    if not path:
        return
    L = _limits_module()
    try:
        with open(path, "rb") as f:
            data = f.read(L.MAX_BYTES + 1)
    except OSError as e:
        raise ValueError("limits: cannot read %s: %s" % (path, e.strerror or e))
    if len(data) > L.MAX_BYTES:
        raise ValueError("limits: %s is larger than %d bytes" % (path, L.MAX_BYTES))
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError as e:
        raise ValueError("limits: %s is not JSON: it is not UTF-8 (%s)" % (path, e.reason))
    L.propose(L.validate(text, path))


_limits_from_environment()

from . import ap, linalg, mf, modsym, nf, poly  # noqa: E402


def _register_capacity():
    try:
        from ._native import set_memory_share_source
    except ImportError:
        return  # (an older native build: its factorizations keep their default)
    set_memory_share_source(_capacity_share)
    try:
        from ._native import set_memory_total_source
    except ImportError:
        return  # (a native build without the ledger: nominal total)
    # (looked up at each read, so that a test can stand in a source)
    set_memory_total_source(lambda: _capacity_total())


_register_capacity()


# ---- the agent API (estimates plan r3 §1.1): what this build provides,
# live progress, and the entry points of the pieces still to come, which
# refuse before running.

def capabilities():
    """What this build of the agent API provides: {"progress": True,
    "estimate": True, "deadline": False, ...} (sagebrush.records.capabilities)."""
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
    """The time and memory estimate of f(*args, **kwds), a
    sagebrush.estimate/1 record; f is never called (sagebrush._estimates)."""
    from . import _estimates as _e
    return _e.estimate(f, *args, **kwds)


def run(f, *args, **kwds):
    """f(*args, **kwds) as an outcome/1 record: not available in this build
    (sagebrush.capabilities())."""
    raise _unavailable("run")


def resume(checkpoint, **kwds):
    """Resumes a checkpoint: not available in this build
    (sagebrush.capabilities())."""
    raise _unavailable("resume")
