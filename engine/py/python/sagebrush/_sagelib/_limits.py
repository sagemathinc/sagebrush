"""The engine's configurable limits (plan-ff-limits r3), one state per session.

A host hands the engine one JSON text of at most MAX_BYTES bytes (the CLI's
--limits FILE or SAGEBRUSH_LIMITS=FILE, the browser worker's init message),
or, in the CPython package, a mapping (sagebrush.set_limits).  This module
is the one validator for all of them, and the one state:

    validate(source, name=None)  pure: a new frozen Limits of every key's
                                 resolved value (defaults filled in), or
                                 ValueError("limits: ..."), the first failure
                                 in the plan's order
    propose(snapshot)            replaces the one pending snapshot; only
                                 before finalize
    finalize()                   locks the pending snapshot (or DEFAULTS) and
                                 returns it; later calls return the same
                                 object, and propose then raises RuntimeError

Importing this module has no side effect and locks nothing, unless the host
locked the defaults at startup (sys._sagebrush_limits_lock, below).  The
finite-field core (_sage_ffsub, _sage_ff) calls finalize() at its import and
reads its budgets from the snapshot; the engine hosts (CLI, browser worker)
finalize at runtime startup, before the first user statement (given no
limits, the Node hosts only set that lock, and this module finalizes at its
first import); the CPython package at the first layer use.
sys._sagebrush_limits is the finalized snapshot.

Every key defaults to unlimited (William, Oct 24: no default work, time or
input-size limit on a user's own computation; interrupting is the control).
A context that wants limits (grading, an instructor's notebook, shared
compute) sets finite values explicitly, and those refuse exactly as before;
"unlimited" may also be given explicitly.  An unlimited value resolves to
UNLIMITED (float infinity), which the consumers' budgets and bounds compare
and subtract like any number.  Memory guards are not limits of this module
and always apply.

These are fail-closed budgets in the user's own interpreter, not a security
boundary against code running in it: the hard walls are the host's (heap,
CPU, run timeouts), and every finite maximum below keeps the budgets under
them.

    sage: import _limits as L
    sage: s = L.validate('{"ff.work": 100000}')
    sage: s["ff.work"], s["ff.embed_max"] is L.UNLIMITED
    (100000, True)
    sage: L.validate('{"ff.work": "unlimited"}') == L.DEFAULTS
    True
    sage: L.validate('{"ff.wrok": 1}')
    Traceback (most recent call last):
    ...
    ValueError: limits: ff.wrok is not a limit of this engine (its limits: ff.conway_work, ff.embed_max, ff.root_bits, ff.work)
"""

import sys as _sys

# An unlimited limit: no refusal in advance (plan-c0 r2).  Infinity, so that
# a budget's charge (cops > budget) never refuses and stays unlimited, and a
# bound's comparison (q <= EMBED_MAX) always holds.
UNLIMITED = float("inf")
UNLIMITED_TEXT = "unlimited"

# key: (default, min, max).  Every default is unlimited (plan-c0 r2); the
# ranges are those of an explicit finite value, unchanged from
# plan-ff-limits r3 (a policy's opt-in limits refuse exactly as the old
# defaults did): ff.work at most 10^8, measured at most 0.51 s per 10^7 cops
# on the reference VM; the others no larger than the old defaults
# (embed_max past 2^20 changes the discrete-log accounting, which is why a
# finite ff.work caps the effective embed_max at 2^20: _sage_ffsub).
TABLE = {
    "ff.conway_work": (UNLIMITED, 10 ** 6, 653528895),
    "ff.embed_max": (UNLIMITED, 2 ** 8, 2 ** 20),
    "ff.root_bits": (UNLIMITED, 64, 1024),
    "ff.work": (UNLIMITED, 10 ** 5, 10 ** 8),
    # C0's per-area follow-up (engine/classgroup, engine/poly): opt-in
    # limits of the class-group searches, the unconditional certificate and
    # integer-polynomial factorization, sent to the engine only when finite
    # (sagebrush/_engine.py); the finite values are the former defaults
    "nf.certify_index_max": (UNLIMITED, 10 ** 3, 2 ** 62),
    "nf.certify_norm_max": (UNLIMITED, 10 ** 3, 2 ** 62),
    "nf.relation_rounds": (UNLIMITED, 1, 10 ** 4),
    "poly.work": (UNLIMITED, 2 ** 20, 2 ** 40),
    # the work of Kedlaya's Frobenius matrix (E.padic_lseries(p).frobenius),
    # in the units of _sage_padic_lseries._kd_cost, about 25 us each in the
    # CLI; 0 refuses every call (cliff audit rank 14, plan-kedlaya-optin r6)
    "padic.kedlaya_work": (UNLIMITED, 0, 2 ** 63 - 1),
    # the work of a MATLAB sparse solve (ordering, factorization, band and
    # triangular solves), in elementary steps (_matlab_sparse, plan-matlab-
    # nocliffs r6 section 2.3); the finite value is the former MAX_LU_WORK
    "matlab.lu_work": (UNLIMITED, 10 ** 5, 2 ** 62),
    # the bytes pandas' read_csv may decode (optional/pandas, plan-pandas
    # r7 section E): a budget charged before every allocation of the parse,
    # read through sagebrush.limit; a grading context sets it so that the
    # parse stays under the grader child's memory (r7 1b), and 1 MiB is the
    # least the parser's own buffers need
    "pandas.decoded_bytes": (UNLIMITED, 2 ** 20, 2 ** 40),
}
# the defaults before plan-c0 (a policy's finite values, and the tests')
FINITE = {"ff.conway_work": 653528895, "ff.embed_max": 2 ** 20, "ff.root_bits": 1024, "ff.work": 10 ** 7,
          "nf.certify_index_max": 10 ** 6, "nf.certify_norm_max": 10 ** 6, "nf.relation_rounds": 60, "padic.kedlaya_work": 2 ** 20, "poly.work": 2 ** 33,
          "matlab.lu_work": 2 ** 24}
MAX_BYTES = 4096   # the serialized text, in UTF-8 bytes
MAX_ENTRIES = 16
MAX_KEY = 64       # characters of a key (CPython mappings)

LOCKED = "sagebrush limits are read once, at the first use: set them before it"


class Limits(object):
    """A frozen mapping of every limit to its resolved value."""

    __slots__ = ("_items",)

    def __init__(self, items):
        object.__setattr__(self, "_items", tuple(sorted(items.items())))

    def __setattr__(self, name, value):
        raise AttributeError("the limits are read-only")

    def __delattr__(self, name):
        raise AttributeError("the limits are read-only")

    def __getitem__(self, key):
        for k, v in self._items:
            if k == key:
                return v
        raise KeyError(key)

    def get(self, key, default=None):
        try:
            return self[key]
        except KeyError:
            return default

    def __contains__(self, key):
        return any(k == key for k, _ in self._items)

    def __iter__(self):
        return iter([k for k, _ in self._items])

    def __len__(self):
        return len(self._items)

    def keys(self):
        return [k for k, _ in self._items]

    def items(self):
        return list(self._items)

    def __eq__(self, other):
        return isinstance(other, Limits) and self._items == other._items

    def __ne__(self, other):
        return not self == other

    def __hash__(self):
        return hash(self._items)

    def __repr__(self):
        return "Limits({%s})" % ", ".join("%r: %s" % (k, UNLIMITED_TEXT if v == UNLIMITED else "%d" % v) for k, v in self._items)


DEFAULTS = Limits({k: v[0] for k, v in TABLE.items()})


class _Object(list):
    """A JSON object's (key, value) pairs, in order (duplicates kept)."""


def _shown(v):
    """A refused value as the user wrote it, briefly: JSON's spelling for
    JSON's values (true, null, 1.5, "big"), else its kind."""
    if v is True:
        return "true"
    if v is False:
        return "false"
    if v is None:
        return "null"
    if isinstance(v, float):
        if v != v:
            return "NaN"
        if v in (float("inf"), float("-inf")):
            return "Infinity" if v > 0 else "-Infinity"
        return repr(v)
    if isinstance(v, str):
        s = v if len(v) <= 40 else v[:40] + "..."
        return '"%s"' % s.replace("\\", "\\\\").replace('"', '\\"')
    if isinstance(v, (_Object, dict)):
        return "an object"
    if isinstance(v, list):
        return "an array"
    return "a %s" % type(v).__name__


def _key_shown(k):
    """A key in a message: at most MAX_KEY characters, one line."""
    s = k if len(k) <= MAX_KEY else k[:MAX_KEY] + "..."
    return "".join(c if c.isprintable() else repr(c)[1:-1] for c in s)


def _fits64(v):
    return -(1 << 63) <= v < (1 << 63)


def _refuse(msg):
    return ValueError("limits: " + msg)


def _check_entries(pairs):
    """The semantic checks of (key, value) pairs whose keys are strings, in
    sorted key order: unknown key, given twice, not an integer, more than 64
    bits, out of range.  A new Limits, or ValueError."""
    out = dict(DEFAULTS.items())
    seen = set()
    for k, v in sorted(pairs, key=lambda kv: kv[0]):
        if k not in TABLE:
            raise _refuse("%s is not a limit of this engine (its limits: %s)" % (_key_shown(k), ", ".join(sorted(TABLE))))
        if k in seen:
            raise _refuse("%s is given more than once" % k)
        seen.add(k)
        if type(v) is str and v == UNLIMITED_TEXT:
            out[k] = UNLIMITED
            continue
        if not isinstance(v, int) or isinstance(v, bool):
            raise _refuse('%s must be an integer or "%s", not %s' % (k, UNLIMITED_TEXT, _shown(v)))
        lo, hi = TABLE[k][1], TABLE[k][2]
        if not _fits64(v):
            raise _refuse("%s is an integer of more than 64 bits" % k)
        if not lo <= v <= hi:
            raise _refuse("%s = %d is outside the range this engine allows, [%d, %d]" % (k, v, lo, hi))
        out[k] = int(v)
    return Limits(out)


def _from_text(text, name):
    what = name if name is not None else "the limits"
    if len(text.encode("utf-8", "surrogatepass")) > MAX_BYTES:
        raise _refuse("%s %s larger than %d bytes" % (what, "is" if name is not None else "are", MAX_BYTES))
    import json as _json
    try:
        root = _json.loads(text, object_pairs_hook=_Object)
    except ValueError as e:
        raise _refuse("%s %s not JSON: %s" % (what, "is" if name is not None else "are", e))
    except RecursionError:
        raise _refuse("%s %s not JSON: nested too deeply" % (what, "is" if name is not None else "are"))
    if not isinstance(root, _Object):
        kind = {list: "an array", type(None): "null", str: "a string", bool: "a boolean"}.get(type(root), "a number")
        raise _refuse("the limits must be a JSON object, not %s" % kind)
    if len(root) > MAX_ENTRIES:
        raise _refuse("more than %d entries" % MAX_ENTRIES)
    return _check_entries(list(root))


def _from_mapping(m):
    # (the structural preflight, on the caller's own mapping, before any
    # sorting, copying or encoding: astra CORR-FFLIMIT-3; its first failure,
    # in the mapping's own order, is the one reported)
    try:
        from collections.abc import Mapping as _Mapping
    except ImportError:  # pragma: no cover
        _Mapping = dict
    if not isinstance(m, (dict, _Mapping)):
        raise _refuse("the limits must be a mapping, not %s" % _shown(m))
    if len(m) > MAX_ENTRIES:
        raise _refuse("more than %d entries" % MAX_ENTRIES)
    pairs = []
    for k in m:
        if not isinstance(k, str):
            if isinstance(k, (int, float)) and not isinstance(k, bool):
                raise _refuse("the key %r is not a string" % k)
            raise _refuse("a key of type %s is not a string" % type(k).__name__)
        if len(k) > MAX_KEY:
            raise _refuse("a key of more than %d characters" % MAX_KEY)
        v = m[k]
        if isinstance(v, str) and str.__str__(v) == UNLIMITED_TEXT:
            # (a str subclass is read as its str value, never through its
            # own methods)
            pairs.append((str(k), UNLIMITED_TEXT))
        else:
            if not isinstance(v, int) or isinstance(v, bool):
                raise _refuse('%s must be an integer or "%s", not %s' % (_key_shown(k), UNLIMITED_TEXT, _shown(v)))
            if not _fits64(v):
                raise _refuse("%s is an integer of more than 64 bits" % _key_shown(k))
            pairs.append((str(k), int(v)))
        if len(pairs) > MAX_ENTRIES:  # (a mapping whose len() said less)
            raise _refuse("more than %d entries" % MAX_ENTRIES)
    return _check_entries(pairs)


def validate(source, name=None):
    """A new frozen Limits from a JSON text (name: the file it came from, for
    messages) or a mapping, or ValueError.  Touches no state."""
    if isinstance(source, str):
        return _from_text(source, name)
    if isinstance(source, (bytes, bytearray)):
        raise _refuse("the limits must be text, not bytes")
    return _from_mapping(source)


_pending = None
_final = None


def propose(snapshot):
    """Make snapshot (from validate) the pending one; RuntimeError once the
    limits are finalized."""
    global _pending
    if _final is not None:
        raise RuntimeError(LOCKED)
    if not isinstance(snapshot, Limits):
        raise TypeError("propose() takes the Limits validate() returns")
    _pending = snapshot


def finalize():
    """Lock the pending snapshot (DEFAULTS if none) and return it; the same
    object every later time."""
    global _final
    if _final is None:
        _final = _pending if _pending is not None else DEFAULTS
        try:
            _sys._sagebrush_limits = _final
        except Exception:  # pragma: no cover (a sys without attributes)
            pass
    return _final


def finalized():
    """Whether the limits are locked."""
    return _final is not None


# A host that was given no limits locks the defaults at startup without
# importing this module (src/limits.ts lockDefaults): they lock here, at its
# first import, before anything can propose.  sys._sagebrush_limits is the
# host's already (an accessor for this snapshot, or whatever the program
# has made of it since, as after a finalize at startup), so it's left alone.
if getattr(_sys, "_sagebrush_limits_lock", False):
    _final = DEFAULTS
