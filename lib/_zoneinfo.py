# CPython 3.14's Modules/_zoneinfo.c, in Python (PSF License, clause 3; see
# cdn/LICENSE-CPython.txt): zoneinfo.ZoneInfo as users of CPython see it,
# which is this C module's, not Lib/zoneinfo/_zoneinfo.py's (the two differ:
# the TZ string's grammar and messages, fromutc's fold after the last
# transition, the zone before the first transition, pickling, the caches,
# the read-only key). Each function follows the C one of the same name, in
# its order of steps. Where the C code's behaviour is undefined (a non-
# datetime with a datetime's methods, integers past C's widths), this
# refuses, in words, instead.
"""C implementation of the zoneinfo module"""

import weakref as _weakref
from bisect import bisect_right as _bisect
from datetime import datetime as _datetime, timedelta as _timedelta, tzinfo as _tzinfo
from _operator import index as _index

# (as the C module's state takes them when it is imported: later changes to
# zoneinfo._tzpath.find_tzfile or to builtins.open do not reach it, while
# zoneinfo._common's functions are looked up at each call)
from zoneinfo._tzpath import find_tzfile as _find_tzfile
from zoneinfo import _common

_EPOCHORDINAL = 719163
_DAYS_IN_MONTH = (-1, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31)
_DAYS_BEFORE_MONTH = (-1, 0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334)

_SOURCE_NOCACHE = 0
_SOURCE_CACHE = 1
_SOURCE_FILE = 2

_STRONG_CACHE_MAX_SIZE = 8

_I64 = 1 << 63


def _refuse(what):
    raise NotImplementedError("zoneinfo: " + what + " is not supported in Sagebrush")


# ------------------------------------------------------------------ the C type's argument handling
#
# The messages of CPython's Argument Clinic (_PyArg_UnpackKeywords), of
# METH_O and METH_NOARGS methods, and of a C type's descriptors.

_MISSING = object()


def _unpack(fname, args, kwargs, names, posonly, minpos, maxpos):
    nargs, nkwargs = len(args), len(kwargs)
    maxargs = len(names)
    if nargs + nkwargs > maxargs:
        raise TypeError("%s() takes at most %d %sargument%s (%d given)"
                        % (fname, maxargs, "keyword " if nargs == 0 else "", "" if maxargs == 1 else "s", nargs + nkwargs))
    if nargs > maxpos:
        if maxpos == 0:
            raise TypeError("%s() takes no positional arguments" % fname)
        raise TypeError("%s() takes %s %d positional argument%s (%d given)"
                        % (fname, "at most" if minpos < maxpos else "exactly", maxpos, "" if maxpos == 1 else "s", nargs))
    if nargs < posonly:
        raise TypeError("%s() takes %s %d positional argument%s (%d given)"
                        % (fname, "at least" if posonly < maxpos else "exactly", posonly, "" if posonly == 1 else "s", nargs))
    out = list(args)
    left = dict(kwargs)
    for i in range(max(nargs, posonly), maxargs):
        if names[i] in left:
            out.append(left.pop(names[i]))
        elif i < minpos:
            raise TypeError("%s() missing required argument '%s' (pos %d)" % (fname, names[i], i + 1))
        else:
            out.append(_MISSING)
    if left:
        for i in range(posonly, nargs):
            if names[i] in left:
                raise TypeError("argument for %s() given by name ('%s') and position (%d)" % (fname, names[i], i + 1))
        raise TypeError("%s() got an unexpected keyword argument '%s'" % (fname, next(iter(left))))
    return out


def _bound(name, args):
    # (a method descriptor's check of what it is called on)
    if not args:
        raise TypeError("unbound method ZoneInfo.%s() needs an argument" % name)
    if not isinstance(args[0], ZoneInfo):
        raise TypeError("descriptor '%s' for 'zoneinfo.ZoneInfo' objects doesn't apply to a '%s' object"
                        % (name, type(args[0]).__name__))
    return args[0]


def _slot(name, args, kwargs):
    # (a slot wrapper's: __repr__, __str__)
    if not args:
        raise TypeError("descriptor '%s' of 'zoneinfo.ZoneInfo' object needs an argument" % name)
    if not isinstance(args[0], ZoneInfo):
        raise TypeError("descriptor '%s' requires a 'zoneinfo.ZoneInfo' object but received a '%s'"
                        % (name, type(args[0]).__name__))
    if kwargs:
        raise TypeError("wrapper %s() takes no keyword arguments" % name)
    if len(args) != 1:
        raise TypeError("expected 0 arguments, got %d" % (len(args) - 1))
    return args[0]


def _c_long(v):
    # (PyLong_AsLong / PyLong_AsLongLong on LP64: __index__, then the range)
    v = _index(v)
    if not -_I64 <= v < _I64:
        raise OverflowError("Python int too large to convert to C long")
    return v


def _i64(v):
    # (an int64_t sum the C code makes: one past its range is undefined there)
    if not -_I64 <= v < _I64:
        _refuse("a time zone whose times overflow 64 bits")
    return v


class _ttinfo:
    __slots__ = ("utcoff", "dstoff", "tzname", "utcoff_seconds")

    def __init__(self, utcoff, dstoff, tzname, utcoff_seconds):
        self.utcoff = utcoff
        self.dstoff = dstoff
        self.tzname = tzname
        self.utcoff_seconds = utcoff_seconds


_NO_TTINFO = _ttinfo(None, None, None, 0)


class _tzrule:
    __slots__ = ("std", "dst", "dst_diff", "start", "end", "std_only")


# It is relatively expensive to construct new timedelta objects; the C
# module keeps every one it made, by its seconds. (Sagebrush: up to 4096 of
# them, so that crafted zone files cannot grow it without bound; past that
# a new one is made each time, equal but not the same object.)
_TIMEDELTA_CACHE = {}
_TIMEDELTA_CACHE_MAX = 4096


def _load_timedelta(seconds):
    rv = _TIMEDELTA_CACHE.get(seconds)
    if rv is None:
        rv = _timedelta(0, seconds)
        if len(_TIMEDELTA_CACHE) < _TIMEDELTA_CACHE_MAX:
            rv = _TIMEDELTA_CACHE.setdefault(seconds, rv)
    return rv


def _build_ttinfo(utcoffset, dstoffset, tzname):
    return _ttinfo(_load_timedelta(utcoffset), _load_timedelta(dstoffset), tzname, utcoffset)


def _ttinfo_eq(t0, t1):
    return bool(t0.utcoff == t1.utcoff) and bool(t0.dstoff == t1.dstoff) and bool(t0.tzname == t1.tzname)


# ------------------------------------------------------------------ the weak and strong caches

_WEAK_CACHE = _weakref.WeakValueDictionary()
# (the strong cache: an LRU list of [key, zone], most recent first, for
# ZoneInfo itself only, as the C module keeps it)
_STRONG_CACHE = []


def _get_weak_cache(cls):
    if cls is ZoneInfo:
        return _WEAK_CACHE
    return getattr(cls, "_weak_cache")


def _find_in_strong_cache(key):
    for i, node in enumerate(_STRONG_CACHE):
        # (PyObject_RichCompareBool: the same object is equal)
        if key is node[0] or bool(key == node[0]):
            return i
    return -1


def _zone_from_strong_cache(cls, key):
    if cls is not ZoneInfo:
        return None
    i = _find_in_strong_cache(key)
    if i < 0:
        return None
    node = _STRONG_CACHE.pop(i)
    _STRONG_CACHE.insert(0, node)
    return node[1]


def _update_strong_cache(cls, key, zone):
    if cls is not ZoneInfo:
        return
    _STRONG_CACHE.insert(0, [key, zone])
    del _STRONG_CACHE[_STRONG_CACHE_MAX_SIZE:]


def _eject_from_strong_cache(cls, key):
    if cls is not ZoneInfo:
        return
    i = _find_in_strong_cache(key)
    if i >= 0:
        del _STRONG_CACHE[i]


def _clear_strong_cache(cls):
    if cls is ZoneInfo:
        _STRONG_CACHE.clear()


# ------------------------------------------------------------------ ZoneInfo


class _ReadOnlyMember:
    # (the C type's key: a read-only member, an AttributeError where unset)
    __slots__ = ()

    def _check(self, obj):
        if not isinstance(obj, ZoneInfo):
            raise TypeError("descriptor 'key' for 'zoneinfo.ZoneInfo' objects doesn't apply to a '%s' object"
                            % type(obj).__name__)

    def __get__(self, obj, cls=None):
        if obj is None:
            return self
        self._check(obj)
        try:
            return obj._key
        except AttributeError:
            raise AttributeError("'zoneinfo.ZoneInfo' object has no attribute 'key'") from None

    def __set__(self, obj, value):
        self._check(obj)
        raise AttributeError("readonly attribute")

    def __delete__(self, obj):
        self._check(obj)
        raise AttributeError("readonly attribute")

    def __repr__(self):
        return "<member 'key' of 'zoneinfo.ZoneInfo' objects>"


class _UnpickleMethod:
    # (ZoneInfo._unpickle bound to a class, as the C method is a builtin one:
    # it pickles as getattr(cls, "_unpickle"), and reprs as one)
    __slots__ = ("_cls",)

    def __init__(self, cls):
        self._cls = cls

    def __call__(self, *args, **kwargs):
        return _unpickle(self._cls, args, kwargs)

    def __reduce__(self):
        return (getattr, (self._cls, "_unpickle"))

    def __repr__(self):
        return "<built-in method _unpickle of type object at %#x>" % id(self._cls)


def _open_zone_file(path):
    # (Sagebrush: zoneinfo._common reads the file at most its cap at a time,
    # never blocking; CPython's io.open(path, "rb"))
    return _common._open_tzfile(path)


class ZoneInfo(_tzinfo):
    __slots__ = ("_key", "_file_repr", "_num_transitions", "_trans_list_utc", "_trans_list_wall",
                 "_trans_ttinfos", "_ttinfo_before", "_tzrule_after", "_fixed_offset", "_source",
                 "__weakref__")
    __module__ = "zoneinfo"

    key = _ReadOnlyMember()

    def __new__(*args, **kwargs):
        if not args:
            raise TypeError("zoneinfo.ZoneInfo.__new__(): not enough arguments")
        cls = args[0]
        if not isinstance(cls, type):
            raise TypeError("zoneinfo.ZoneInfo.__new__(X): X is not a type object (%s)" % type(cls).__name__)
        if not issubclass(cls, ZoneInfo):
            raise TypeError("zoneinfo.ZoneInfo.__new__(%s): %s is not a subtype of zoneinfo.ZoneInfo"
                            % (cls.__name__, cls.__name__))
        (key,) = _unpack("ZoneInfo", args[1:], kwargs, ("key",), 0, 1, 1)
        return _zoneinfo_new(cls, key)

    @classmethod
    def from_file(cls, *args, **kwargs):
        file_obj, key = _unpack("from_file", args, kwargs, ("file_obj", "key"), 1, 1, 2)
        if key is _MISSING:
            key = None
        self = object.__new__(cls)
        file_repr = repr(file_obj)
        _load_data(self, file_obj)
        self._source = _SOURCE_FILE
        self._file_repr = file_repr
        self._key = key
        return self

    @classmethod
    def no_cache(cls, *args, **kwargs):
        (key,) = _unpack("no_cache", args, kwargs, ("key",), 0, 1, 1)
        out = _new_instance(cls, key)
        out._source = _SOURCE_NOCACHE
        return out

    @classmethod
    def clear_cache(cls, *args, **kwargs):
        (only_keys,) = _unpack("clear_cache", args, kwargs, ("only_keys",), 0, 0, 0)
        weak_cache = _get_weak_cache(cls)
        if only_keys is _MISSING or only_keys is None:
            try:
                weak_cache.clear()
            finally:
                _clear_strong_cache(cls)
        else:
            for item in only_keys:
                _eject_from_strong_cache(cls, item)
                weak_cache.pop(item, None)

    def utcoffset(*args, **kwargs):
        self = _bound("utcoffset", args)
        (dt,) = _unpack("utcoffset", args[1:], kwargs, ("dt",), 1, 1, 1)
        return _find_ttinfo(self, dt).utcoff

    def dst(*args, **kwargs):
        self = _bound("dst", args)
        (dt,) = _unpack("dst", args[1:], kwargs, ("dt",), 1, 1, 1)
        return _find_ttinfo(self, dt).dstoff

    def tzname(*args, **kwargs):
        self = _bound("tzname", args)
        (dt,) = _unpack("tzname", args[1:], kwargs, ("dt",), 1, 1, 1)
        return _find_ttinfo(self, dt).tzname

    def fromutc(*args, **kwargs):
        self = _bound("fromutc", args)
        if kwargs:
            raise TypeError("ZoneInfo.fromutc() takes no keyword arguments")
        if len(args) != 2:
            raise TypeError("ZoneInfo.fromutc() takes exactly one argument (%d given)" % (len(args) - 1))
        return _fromutc(self, args[1])

    def __repr__(*args, **kwargs):
        self = _slot("__repr__", args, kwargs)
        if self._key is not None:
            return "%s(key=%r)" % (_type_name(type(self)), self._key)
        return "%s.from_file(%s)" % (_type_name(type(self)), self._file_repr)

    def __str__(*args, **kwargs):
        self = _slot("__str__", args, kwargs)
        if self._key is not None:
            return self._key
        return ZoneInfo.__repr__(self)

    def __reduce__(*args, **kwargs):
        self = _bound("__reduce__", args)
        if kwargs:
            raise TypeError("ZoneInfo.__reduce__() takes no keyword arguments")
        if len(args) != 1:
            raise TypeError("ZoneInfo.__reduce__() takes no arguments (%d given)" % (len(args) - 1))
        if self._source == _SOURCE_FILE:
            import pickle
            raise pickle.PicklingError("Cannot pickle a ZoneInfo file from a file stream.")
        from_cache = 1 if self._source == _SOURCE_CACHE else 0
        constructor = getattr(self, "_unpickle")
        if getattr(constructor, "__func__", None) is _UNPICKLE_FUNC:
            constructor = _UnpickleMethod(constructor.__self__)
        return (constructor, (self._key, from_cache))

    @classmethod
    def _unpickle(cls, *args, **kwargs):
        return _unpickle(cls, args, kwargs)

    def __init_subclass__(cls, *args, **kwargs):
        if cls is ZoneInfo:
            raise TypeError("cannot set '_weak_cache' attribute of immutable type 'zoneinfo.ZoneInfo'")
        cls._weak_cache = _weakref.WeakValueDictionary()


ZoneInfo.utcoffset.__doc__ = "Retrieve a timedelta representing the UTC offset in a zone at the given datetime."
ZoneInfo.dst.__doc__ = "Retrieve a timedelta representing the amount of DST applied in a zone at the given datetime."
ZoneInfo.tzname.__doc__ = "Retrieve a string containing the abbreviation for the time zone that applies in a zone at a given datetime."
ZoneInfo.fromutc.__doc__ = "Given a datetime with local time in UTC, retrieve an adjusted datetime in local time."
ZoneInfo.__reduce__.__doc__ = "Function for serialization with the pickle protocol."
ZoneInfo.__init_subclass__.__func__.__doc__ = "Function to initialize subclasses."
_UNPICKLE_FUNC = ZoneInfo.__dict__["_unpickle"].__func__


def _zoneinfo_new(cls, key):
    instance = _zone_from_strong_cache(cls, key)
    if instance is not None:
        return instance

    weak_cache = _get_weak_cache(cls)
    instance = weak_cache.get(key, None)
    if instance is None:
        tmp = _new_instance(cls, key)
        tmp._source = _SOURCE_CACHE
        instance = weak_cache.setdefault(key, tmp)

    if not isinstance(instance, cls):
        raise RuntimeError("Unexpected instance of %s in %s weak cache for key %r"
                           % (_type_name(type(instance)), cls.__name__, key))

    _update_strong_cache(cls, key, instance)
    return instance


def _unpickle(cls, args, kwargs):
    key, from_cache = _unpack("_unpickle", args, kwargs, ("key", "from_cache"), 2, 2, 2)
    # (unsigned_char(bitwise=True): the low 8 bits of an integer)
    if _index(from_cache) & 0xFF:
        return _zoneinfo_new(cls, key)
    return _new_instance(cls, key)


def _fromutc(self, dt):
    if not isinstance(dt, _datetime):
        raise TypeError("fromutc: argument must be a datetime")
    if dt._tzinfo is not self:
        raise ValueError("fromutc: dt.tzinfo is not self")

    timestamp = _get_local_timestamp(dt)
    num_trans = self._num_transitions
    trans_utc = self._trans_list_utc
    fold = 0

    if num_trans >= 1 and timestamp < trans_utc[0]:
        tti = self._ttinfo_before
    elif num_trans == 0 or timestamp > trans_utc[num_trans - 1]:
        tti, fold = _find_tzrule_ttinfo_fromutc(self._tzrule_after, timestamp, dt._year)
        # Immediately after the last manual transition, the fold/gap is
        # between the transitions' last ttinfo and whatever applies after
        # it, not between the STD and DST rules of the TZ string.
        if num_trans:
            if num_trans == 1:
                tti_prev = self._ttinfo_before
            else:
                tti_prev = self._trans_ttinfos[num_trans - 2]
            diff = tti_prev.utcoff_seconds - tti.utcoff_seconds
            if diff > 0 and timestamp < _i64(trans_utc[num_trans - 1] + diff):
                fold = 1
    else:
        idx = _bisect(trans_utc, timestamp)
        if idx >= 2:
            tti_prev = self._trans_ttinfos[idx - 2]
            tti = self._trans_ttinfos[idx - 1]
        else:
            tti_prev = self._ttinfo_before
            tti = self._trans_ttinfos[0]
        # Detect fold
        shift = tti_prev.utcoff_seconds - tti.utcoff_seconds
        if shift > _i64(timestamp - trans_utc[idx - 1]):
            fold = 1

    tmp = dt + tti.utcoff
    if fold:
        if type(tmp) is _datetime:
            tmp._fold = 1
            return tmp
        return tmp.replace(fold=1)
    return tmp


def _type_name(cls):
    # (%T: the type's tp_name, the module's too for the C type, a class's
    # name for one defined in Python)
    return "zoneinfo.ZoneInfo" if cls is ZoneInfo else cls.__name__


def _new_instance(cls, key):
    file_obj = None
    file_path = _find_tzfile(key)
    if file_path is None:
        file_obj = _common.load_tzdata(key)

    self = object.__new__(cls)
    try:
        if file_obj is None:
            file_obj = _open_zone_file(file_path)
        _load_data(self, file_obj)
        f, file_obj = file_obj, None
        f.close()
        self._key = key
    except BaseException:
        if file_obj is not None:
            # (an error closing it is raised, the first as its context)
            file_obj.close()
        raise
    return self


def _load_data(self, file_obj):
    data_tuple = _common.load_data(file_obj)
    if type(data_tuple) is not tuple:
        raise TypeError("Invalid data result type: %r" % (data_tuple,))

    trans_idx_list = data_tuple[0]
    trans_utc = data_tuple[1]
    utcoff_list = data_tuple[2]
    isdst_list = data_tuple[3]
    abbr = data_tuple[4]
    tz_str = data_tuple[5]
    for part in (trans_idx_list, trans_utc, utcoff_list, isdst_list, abbr):
        if not isinstance(part, tuple):
            _refuse("a zoneinfo._common.load_data that returns other than tuples")

    num_transitions = len(trans_utc)
    num_ttinfos = len(utcoff_list)

    trans_list_utc = []
    trans_idx = []
    for i in range(num_transitions):
        trans_list_utc.append(_c_long(trans_utc[i]))
        cur = _c_long(trans_idx_list[i])
        if cur < 0 or cur >= num_ttinfos:
            # (the C module reads it as a size_t: a negative one is too large)
            raise ValueError("Invalid transition index found while reading TZif: %d" % cur)
        trans_idx.append(cur)

    utcoff = []
    isdst = []
    for i in range(num_ttinfos):
        utcoff.append(_c_long(utcoff_list[i]))
        isdst.append(bool(isdst_list[i]))

    dstoff = _utcoff_to_dstoff(trans_idx, utcoff, isdst, num_transitions, num_ttinfos)
    trans_list_wall = _ts_to_local(trans_idx, trans_list_utc, utcoff, num_ttinfos, num_transitions)

    ttinfos = [_build_ttinfo(utcoff[i], dstoff[i], abbr[i]) for i in range(num_ttinfos)]
    trans_ttinfos = [ttinfos[i] for i in trans_idx]

    # The first non-DST ttinfo; failing that the first one; with none, None
    ttinfo_before = None
    for i in range(num_ttinfos):
        if not isdst[i]:
            ttinfo_before = ttinfos[i]
            break
    if ttinfo_before is None and num_ttinfos > 0:
        ttinfo_before = ttinfos[0]

    if tz_str:
        tzrule_after = _parse_tz_str(tz_str)
    else:
        if not num_ttinfos:
            raise ValueError("No time zone information found.")
        if not num_transitions:
            idx = num_ttinfos - 1
        else:
            idx = trans_idx[num_transitions - 1]
        tti = ttinfos[idx]
        tzrule_after = _build_tzrule(tti.tzname, None, tti.utcoff_seconds, 0, None, None)
        # (an STD-only rule mimicking that ttinfo, its DST offset too)
        if tti.dstoff:
            tzrule_after.std.dstoff = tti.dstoff

    # A "fixed offset" zone: one whose utcoffset, dst and tzname do not depend
    # on the datetime (assuming, as the C module does, no unused ttinfos and
    # a TZ string with both STD and DST has transitions that occur).
    if num_ttinfos > 1 or not tzrule_after.std_only:
        fixed_offset = False
    elif num_ttinfos == 0:
        fixed_offset = True
    else:
        fixed_offset = _ttinfo_eq(ttinfos[0], tzrule_after.std)

    self._num_transitions = num_transitions
    self._trans_list_utc = trans_list_utc
    self._trans_list_wall = trans_list_wall
    self._trans_ttinfos = trans_ttinfos
    self._ttinfo_before = ttinfo_before
    self._tzrule_after = tzrule_after
    self._fixed_offset = fixed_offset


def _utcoff_to_dstoff(trans_idx, utcoffs, isdsts, num_transitions, num_ttinfos):
    # The DST offsets dst() returns, inferred from the transitions: each DST
    # type's offset less that of the standard type before it (or failing
    # that, after it); one hour where none can be found, so that bool(dst())
    # always matches isdst. (The C module's count of DST types to find is
    # the count of all types, so it never stops early.)
    dstoffs = [0] * num_ttinfos
    dst_count = num_ttinfos
    dst_found = 0
    for i in range(1, num_transitions):
        if dst_count == dst_found:
            break
        idx = trans_idx[i]
        comp_idx = trans_idx[i - 1]
        if not isdsts[idx] or dstoffs[idx] != 0:
            continue
        dstoff = 0
        utcoff = utcoffs[idx]
        if not isdsts[comp_idx]:
            dstoff = utcoff - utcoffs[comp_idx]
        if not dstoff and idx < num_ttinfos - 1 and i + 1 < num_transitions:
            comp_idx = trans_idx[i + 1]
            if isdsts[comp_idx]:
                continue
            dstoff = utcoff - utcoffs[comp_idx]
        if dstoff:
            dst_found += 1
            dstoffs[idx] = dstoff
    if dst_found < dst_count:
        for idx in range(num_ttinfos):
            if isdsts[idx] and not dstoffs[idx]:
                dstoffs[idx] = 3600
    return dstoffs


def _ts_to_local(trans_idx, trans_utc, utcoff, num_ttinfos, num_transitions):
    # The transitions in local wall time, for fold=0 (the larger offset) and
    # fold=1 (the smaller)
    if num_transitions == 0:
        return [[], []]
    wall0 = list(trans_utc)
    wall1 = list(trans_utc)
    if num_ttinfos > 1:
        offset_0 = utcoff[0]
        offset_1 = utcoff[trans_idx[0]]
        if offset_1 > offset_0:
            offset_0, offset_1 = offset_1, offset_0
    else:
        offset_0 = offset_1 = utcoff[0]
    wall0[0] = _i64(wall0[0] + offset_0)
    wall1[0] = _i64(wall1[0] + offset_1)
    for i in range(1, num_transitions):
        offset_0 = utcoff[trans_idx[i - 1]]
        offset_1 = utcoff[trans_idx[i]]
        if offset_1 > offset_0:
            offset_1, offset_0 = offset_0, offset_1
        wall0[i] = _i64(wall0[i] + offset_0)
        wall1[i] = _i64(wall1[i] + offset_1)
    return [wall0, wall1]


def _find_ttinfo(self, dt):
    # (datetime.time's tzinfo calls pass None: meaningful only for a fixed offset)
    if dt is None:
        if self._fixed_offset:
            return self._tzrule_after.std
        return _NO_TTINFO

    ts = _get_local_timestamp(dt)
    if not isinstance(dt, _datetime):
        # (the C module reads a datetime's fold field from whatever it is given)
        _refuse("a time zone offset of a %s, which is not a datetime" % type(dt).__name__)
    fold = dt._fold
    local_transitions = self._trans_list_wall[fold]
    num_trans = self._num_transitions

    if num_trans and ts < local_transitions[0]:
        return self._ttinfo_before
    elif not num_trans or ts > local_transitions[num_trans - 1]:
        return _find_tzrule_ttinfo(self._tzrule_after, ts, fold, dt._year)
    else:
        idx = _bisect(local_transitions, ts) - 1
        return self._trans_ttinfos[idx]


def _is_leap_year(year):
    return year % 4 == 0 and (year % 100 != 0 or year % 400 == 0)


def _ymd_to_ord(y, m, d):
    y -= 1
    days_before_year = y * 365 + y // 4 - y // 100 + y // 400
    yearday = _DAYS_BEFORE_MONTH[m]
    if m > 2 and _is_leap_year(y + 1):
        yearday += 1
    return days_before_year + yearday + d


def _c_int(v, what):
    # (a value the C module keeps in an int; past one, its result is undefined)
    v = _c_long(v)
    if not -(1 << 31) <= v < (1 << 31):
        _refuse("a datetime whose %s is past a C int" % what)
    return v


def _get_local_timestamp(dt):
    # The seconds since 1970-01-01 in local wall time, in the units of the
    # transitions' wall times
    if type(dt) is _datetime:
        ord = _ymd_to_ord(dt._year, dt._month, dt._day)
        hour, minute, second = dt._hour, dt._minute, dt._second
    else:
        ord = _c_int(dt.toordinal(), "ordinal")
        hour = _c_int(dt.hour, "hour")
        minute = _c_int(dt.minute, "minute")
        second = _c_int(dt.second, "second")
    return _i64((ord - _EPOCHORDINAL) * 86400 + hour * 3600 + minute * 60 + second)


# ------------------------------------------------------------------ transition rules


class _CalendarRule:
    __slots__ = ("month", "week", "day", "hour", "minute", "second")

    def year_to_timestamp(self, year):
        # Week 1 is the first week in which day `day` (0 = Sunday) appears;
        # week 5 the last.
        first_day = (_ymd_to_ord(year, self.month, 1) + 6) % 7
        days_in_month = _DAYS_IN_MONTH[self.month]
        if self.month == 2 and _is_leap_year(year):
            days_in_month += 1
        month_day = (self.day - (first_day + 1)) % 7 + 1
        month_day += (self.week - 1) * 7
        if month_day > days_in_month:
            month_day -= 7
        ordinal = _ymd_to_ord(year, self.month, month_day) - _EPOCHORDINAL
        return ordinal * 86400 + self.hour * 3600 + self.minute * 60 + self.second


class _DayRule:
    __slots__ = ("julian", "day", "hour", "minute", "second")

    def year_to_timestamp(self, year):
        days_before_year = _ymd_to_ord(year, 1, 1) - _EPOCHORDINAL - 1
        # (a Julian day skips February 29th: J60 is March 1st in every year)
        day = self.day
        if self.julian and day >= 59 and _is_leap_year(year):
            day += 1
        return (days_before_year + day) * 86400 + self.hour * 3600 + self.minute * 60 + self.second


def _calendarrule_new(month, week, day, hour, minute, second):
    if not 1 <= month <= 12 or not 1 <= week <= 5 or not 0 <= day <= 6 or not -167 <= hour <= 167:
        return None
    r = _CalendarRule()
    r.month, r.week, r.day, r.hour, r.minute, r.second = month, week, day, hour, minute, second
    return r


def _dayrule_new(julian, day, hour, minute, second):
    if not julian <= day <= 365 or not -167 <= hour <= 167:
        return None
    r = _DayRule()
    r.julian, r.day, r.hour, r.minute, r.second = julian, day, hour, minute, second
    return r


def _find_tzrule_ttinfo(rule, ts, fold, year):
    if rule.std_only:
        return rule.std
    start = rule.start.year_to_timestamp(year)
    end = rule.end.year_to_timestamp(year)
    # With fold = 0, the period (in local time) with the smaller offset
    # starts at the end of the gap and ends at the end of the fold; with
    # fold = 1, it runs from the start of the gap to the start of the fold:
    # fold XOR (DST is positive).
    if fold == (rule.dst_diff >= 0):
        end -= rule.dst_diff
    else:
        start += rule.dst_diff
    if start < end:
        isdst = start <= ts < end
    else:
        isdst = ts < end or ts >= start
    return rule.dst if isdst else rule.std


def _find_tzrule_ttinfo_fromutc(rule, ts, year):
    if rule.std_only:
        return rule.std, 0
    start = rule.start.year_to_timestamp(year) - rule.std.utcoff_seconds
    end = rule.end.year_to_timestamp(year) - rule.dst.utcoff_seconds
    if start < end:
        isdst = start <= ts < end
    else:
        isdst = ts < end or ts >= start
    # The ambiguous period: one dst_diff after the end of positive DST, one
    # before the start of negative DST
    if rule.dst_diff > 0:
        ambig_start, ambig_end = end, end + rule.dst_diff
    else:
        ambig_start, ambig_end = start, start - rule.dst_diff
    fold = 1 if ambig_start <= ts < ambig_end else 0
    return (rule.dst if isdst else rule.std), fold


def _build_tzrule(std_abbr, dst_abbr, std_offset, dst_offset, start, end):
    rv = _tzrule()
    rv.start = start
    rv.end = end
    rv.std = _build_ttinfo(std_offset, 0, std_abbr)
    if dst_abbr is not None:
        rv.dst_diff = dst_offset - std_offset
        rv.dst = _build_ttinfo(dst_offset, rv.dst_diff, dst_abbr)
        rv.std_only = False
    else:
        rv.dst = None
        rv.dst_diff = 0
        rv.std_only = True
    return rv


# ------------------------------------------------------------------ the TZ string
#
# std offset[dst[offset],start[/time],end[/time]], as POSIX.1-2018 §8.3 and
# RFC 8536 §3.3.1 have it, read byte by byte from the TZif footer as the C
# module reads it (a C string: it ends at the first NUL). Every failure is
# one of the messages below, with the footer's bytes as their repr.


def _isalpha(c):
    return 65 <= c <= 90 or 97 <= c <= 122


def _isdigit(c):
    return 48 <= c <= 57


class _Reader:
    __slots__ = ("s", "p")

    def __init__(self, s):
        self.s = s
        self.p = 0

    def peek(self):
        return self.s[self.p] if self.p < len(self.s) else 0


def _parse_digits(r, lo, hi):
    value = 0
    for i in range(hi):
        c = r.peek()
        if not _isdigit(c):
            return None if i < lo else value
        value = value * 10 + c - 48
        r.p += 1
    return value


def _parse_abbr(r):
    if r.peek() == 60:  # <
        r.p += 1
        start = r.p
        while r.peek() != 62:  # >
            c = r.peek()
            if not (_isalpha(c) or _isdigit(c) or c == 43 or c == 45):
                return None
            r.p += 1
        end = r.p
        if end == start:
            return None
        r.p += 1
    else:
        start = r.p
        while _isalpha(r.peek()):
            r.p += 1
        end = r.p
        if end == start:
            return None
    return r.s[start:end].decode("ascii")


def _parse_transition_time(r):
    sign = 1
    c = r.peek()
    if c == 45 or c == 43:
        if c == 45:
            sign = -1
        r.p += 1
    hour = _parse_digits(r, 1, 3)
    if hour is None:
        return None
    minute = second = 0
    if r.peek() == 58:  # :
        r.p += 1
        minute = _parse_digits(r, 2, 2)
        if minute is None:
            return None
        if r.peek() == 58:
            r.p += 1
            second = _parse_digits(r, 2, 2)
            if second is None:
                return None
    return hour * sign, minute * sign, second * sign


def _parse_tz_delta(r):
    t = _parse_transition_time(r)
    if t is None:
        return None
    hours, minutes, seconds = t
    if hours > 24 or hours < -24:
        return None
    # (a negative offset is east of Greenwich: a positive UTC offset)
    return -(hours * 3600 + minutes * 60 + seconds)


def _parse_transition_rule(r):
    hour, minute, second = 2, 0, 0
    if r.peek() == 77:  # M
        r.p += 1
        month = _parse_digits(r, 1, 2)
        if month is None:
            return None
        if r.peek() != 46:
            return None
        r.p += 1
        week = _parse_digits(r, 1, 1)
        if week is None:
            return None
        if r.peek() != 46:
            return None
        r.p += 1
        day = _parse_digits(r, 1, 1)
        if day is None:
            return None
        if r.peek() == 47:  # /
            r.p += 1
            t = _parse_transition_time(r)
            if t is None:
                return None
            hour, minute, second = t
        return _calendarrule_new(month, week, day, hour, minute, second)
    julian = 0
    if r.peek() == 74:  # J
        julian = 1
        r.p += 1
    day = _parse_digits(r, 1, 3)
    if day is None:
        return None
    if r.peek() == 47:
        r.p += 1
        t = _parse_transition_time(r)
        if t is None:
            return None
        hour, minute, second = t
    return _dayrule_new(julian, day, hour, minute, second)


def _parse_tz_str(tz_str_obj):
    if not isinstance(tz_str_obj, bytes):
        _refuse("a zoneinfo._common.load_data whose TZ string is not bytes")
    s = tz_str_obj
    nul = s.find(b"\0")
    if nul >= 0:
        s = s[:nul]
    r = _Reader(s)

    std_abbr = _parse_abbr(r)
    if std_abbr is None:
        raise ValueError("Invalid STD format in %r" % (tz_str_obj,))
    std_offset = _parse_tz_delta(r)
    if std_offset is None:
        raise ValueError("Invalid STD offset in %r" % (tz_str_obj,))
    if r.peek() == 0:
        return _build_tzrule(std_abbr, None, std_offset, 0, None, None)

    dst_abbr = _parse_abbr(r)
    if dst_abbr is None:
        raise ValueError("Invalid DST format in %r" % (tz_str_obj,))
    if r.peek() == 44:  # ,
        # (no DST offset: one hour ahead of standard time)
        dst_offset = std_offset + 3600
    else:
        dst_offset = _parse_tz_delta(r)
        if dst_offset is None:
            raise ValueError("Invalid DST offset in %r" % (tz_str_obj,))

    rules = []
    for _ in range(2):
        if r.peek() != 44:
            raise ValueError("Missing transition rules in TZ string: %r" % (tz_str_obj,))
        r.p += 1
        rule = _parse_transition_rule(r)
        if rule is None:
            raise ValueError("Malformed transition rule in TZ string: %r" % (tz_str_obj,))
        rules.append(rule)

    if r.p < len(s):
        raise ValueError("Extraneous characters at end of TZ string: %r" % (tz_str_obj,))
    return _build_tzrule(std_abbr, dst_abbr, std_offset, dst_offset, rules[0], rules[1])
