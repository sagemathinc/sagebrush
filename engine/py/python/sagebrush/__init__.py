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

__all__ = ["ap", "linalg", "mf", "modsym", "nf", "poly", "set_limits"]


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


_register_capacity()
