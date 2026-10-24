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

Importing this module has no side effect and locks nothing.  The finite-field
core (_sage_ffsub, _sage_ff) calls finalize() at its import and reads its
budgets from the snapshot; the engine hosts (CLI, browser worker) finalize at
runtime startup, before the first user statement; the CPython package at the
first layer use.  sys._sagebrush_limits is the finalized snapshot.

These are fail-closed budgets in the user's own interpreter, not a security
boundary against code running in it: the hard walls are the host's (heap,
CPU, run timeouts), and every maximum below keeps the budgets under them.

    sage: import _limits as L
    sage: s = L.validate('{"ff.work": 100000}')
    sage: s["ff.work"], s["ff.embed_max"]
    (100000, 1048576)
    sage: L.validate('{"ff.wrok": 1}')
    Traceback (most recent call last):
    ...
    ValueError: limits: ff.wrok is not a limit of this engine (its limits: ff.conway_work, ff.embed_max, ff.root_bits, ff.work)
"""

import sys as _sys

# key: (default, min, max).  The defaults are the finite-field core's
# constants before limits existed, so no limits (or {}) is today's behavior
# byte for byte.  Only ff.work may be raised: to 10^8, measured at most
# 0.51 s per 10^7 cops on the reference VM, so about 5 s there (the plan's
# section 6); the others may only be lowered until each has its own
# measurements (embed_max past 2^20 changes the discrete-log accounting).
TABLE = {
    "ff.conway_work": (653528895, 10 ** 6, 653528895),
    "ff.embed_max": (2 ** 20, 2 ** 8, 2 ** 20),
    "ff.root_bits": (1024, 64, 1024),
    "ff.work": (10 ** 7, 10 ** 5, 10 ** 8),
}
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
        return "Limits({%s})" % ", ".join("%r: %d" % kv for kv in self._items)


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
        if not isinstance(v, int) or isinstance(v, bool):
            raise _refuse("%s must be an integer, not %s" % (k, _shown(v)))
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
        if not isinstance(v, int) or isinstance(v, bool):
            raise _refuse("%s must be an integer, not %s" % (_key_shown(k), _shown(v)))
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
