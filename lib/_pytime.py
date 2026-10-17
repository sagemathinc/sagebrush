"""time: CPython 3.14's time module, as glibc's Linux build behaves, over
the host's clocks and zone (the builtin _time).

(This file is the module's implementation; the builtin module time is made
from it, as CPython's time is a builtin module: a script named time.py does
not hide it.)

The host's zone: UTC unless the host gives one.
- Under Node the TZ variable, as given, decides. In a browser, which has
  none, the zone Intl reports is used, and "UTC" (or none) is the UTC host.
- On a UTC host (TZ UTC, Etc/UTC, Etc/UCT, Etc/Universal or Etc/Zulu, or a
  browser in UTC) and a GMT host (Etc/GMT, GMT0, Etc/GMT0, Etc/GMT+0,
  Etc/GMT-0 or Etc/Greenwich), everything is exact. tm_isdst is 0, and the
  abbreviation is "UTC" or "GMT", as glibc gives it.
- A zone named as glibc reads one (TZ a name, or :name, that the host's
  zoneinfo has a file for, which ICU's tzdata, under JavaScript's Date,
  holds too), or the host's own zone where TZ is not set: the UTC offsets
  are exact, from JavaScript's Date (ICU's
  tzdata), so localtime()'s fields, tm_gmtoff, timezone, altzone and
  daylight are exact. The rest is not known here yet (it needs tzdata's
  flags and abbreviations, a later change):
  - tm_isdst, in what localtime() returns, is a placeholder. Its repr is
    "<unknown: ZONE>", and any other use (int, bool, comparison, hashing,
    format, arithmetic, pickling, comparing or hashing the struct_time
    holding it) raises NotImplementedError naming the zone. Unpacking and
    indexing just pass it along.
  - tm_zone, tzname and strftime's %Z raise NotImplementedError naming the
    zone. tzname is not in the module's dict there, so dir(time) and
    `from time import *` lack it, unlike CPython, and hasattr(time,
    'tzname') raises NotImplementedError rather than returning False.
  - mktime() refuses an isdst of 0 or 1, and a local time the zone skips
    or repeats: glibc's answer for those depends on its own state, so it
    is not guessed.
  - strftime's %s, which is mktime's, refuses likewise.
- A TZDIR other than the system's /usr/share/zoneinfo (glibc reads zones
  from it, and its files may hold anything: Date does not read them):
  every local time is refused as below, naming TZDIR, whatever TZ is, UTC
  and GMT and unset too.
- Any other TZ (a POSIX rule such as "EST5EDT,M3.2.0,M11.1.0", a path to a
  zoneinfo file, a name with no file or one Date does not take as given):
  JavaScript's Date does not read it as glibc does, so localtime(), ctime(),
  mktime(), timezone, altzone, daylight and tzname, and everything local
  built on them, raise NotImplementedError naming TZ.
- tzset() is refused: the host's zone is read once, at import.
- strptime() is refused, naming what it lacks, until CPython's _strptime
  (which needs calendar, enum, locale and encodings) can run here.
"""
import _time
from _time import perf_counter, perf_counter_ns, monotonic, monotonic_ns, time, time_ns, process_time, process_time_ns
import math as _math
from operator import index as _index

# ------------------------------------------------------------------ the zone

_UTC_ZONES = {"UTC", "Etc/UTC", "Etc/UCT", "Etc/Universal", "Etc/Zulu"}
_GMT_ZONES = {"Etc/GMT", "GMT0", "Etc/GMT0", "Etc/GMT+0", "Etc/GMT-0", "Etc/Greenwich"}
_intl, _tzenv, _tzcanon, _tzfile, _tzhost, _tzdir = _time._zone()
_bad = None  # (a TZ whose local times are not known here: why)
if _tzenv is not None:
    _name = _tzenv[1:] if _tzenv.startswith(":") else _tzenv
    _abbr = "UTC" if _name in _UTC_ZONES else "GMT" if _name in _GMT_ZONES else None
    _host = None if _abbr is not None else (_name or "''")
    if _abbr is None:
        if _name.startswith("/") or _name.startswith("."):
            _bad = "a path to a zoneinfo file"
        elif _tzcanon is None and _tzfile is not True:
            _bad = "a POSIX TZ rule" if "," in _name or any("0" <= c <= "9" for c in _name) else "not a zone name known here"
        elif _tzcanon is None:
            _bad = "a zone ICU's tzdata does not hold"
        elif _tzfile is not True:
            _bad = "a name with no file in the host's zoneinfo"
        elif _tzcanon != _tzhost:
            _bad = "a zone JavaScript's Date does not take as given"
        if _bad is not None:
            _bad = ("time: the host's time zone TZ=%r (%s) is not available in Sagebrush yet: glibc reads it in a way "
                    "JavaScript's Date does not, so its local times are refused, not guessed" % (_tzenv, _bad))
elif _intl is None or _intl in ("UTC", "Etc/UTC", "Etc/Unknown"):
    _abbr, _host = "UTC", None
else:
    _abbr, _host = None, _intl
if _tzdir and _tzdir.rstrip("/") != "/usr/share/zoneinfo":
    # (an empty TZDIR is glibc's default; any other directory's files are
    # not read here, so no zone, UTC's neither, is known exact)
    _abbr, _host = None, _host or "UTC"
    _bad = ("time: the host's zoneinfo directory TZDIR=%r is not available in Sagebrush yet: glibc reads the "
            "zone from its files, which JavaScript's Date does not, so local times are refused, not guessed" % _tzdir)
del _intl, _tzenv, _tzcanon, _tzfile, _tzhost, _tzdir


def _refuse(what):
    if _bad is not None:
        raise NotImplementedError(_bad)
    raise NotImplementedError("%s is not known for the host's time zone %s here: it needs tzdata's "
                              "daylight-saving flags and abbreviations, not yet in Sagebrush" % (what, _host))


class _UnknownDST:
    """localtime()'s tm_isdst on a host zone whose flags are not known here:
    shown by repr and str, refused on any other use."""
    __slots__ = ()

    def _no(self, *args, **kwargs):
        _refuse("tm_isdst")

    __int__ = __index__ = __float__ = __bool__ = __hash__ = __format__ = _no
    __eq__ = __ne__ = __lt__ = __le__ = __gt__ = __ge__ = _no
    __add__ = __radd__ = __sub__ = __rsub__ = __mul__ = __rmul__ = __truediv__ = __rtruediv__ = _no
    __floordiv__ = __rfloordiv__ = __mod__ = __rmod__ = __pow__ = __rpow__ = __divmod__ = __rdivmod__ = _no
    __neg__ = __pos__ = __abs__ = __invert__ = __round__ = __trunc__ = __floor__ = __ceil__ = _no
    __and__ = __rand__ = __or__ = __ror__ = __xor__ = __rxor__ = __lshift__ = __rlshift__ = __rshift__ = __rrshift__ = _no
    __reduce__ = __reduce_ex__ = __copy__ = __deepcopy__ = __getstate__ = _no

    def __repr__(self):
        return "<unknown: %s>" % _host

    __str__ = __repr__


_UNKNOWN_DST = _UnknownDST()
_UNKNOWN_ZONE = object()  # (a tm_zone that refuses when read)

# ------------------------------------------------------------------ struct_time

_FIELDS = ("tm_year", "tm_mon", "tm_mday", "tm_hour", "tm_min", "tm_sec", "tm_wday", "tm_yday", "tm_isdst")
_EXTRA = ("tm_zone", "tm_gmtoff")


class _Field:
    __slots__ = ("i",)

    def __init__(self, i):
        self.i = i

    def __get__(self, obj, cls=None):
        return self if obj is None else tuple.__getitem__(obj, self.i)

    def __set__(self, obj, value):
        raise AttributeError("readonly attribute")

    def __delete__(self, obj):
        raise AttributeError("readonly attribute")


class _Extra(_Field):
    def __get__(self, obj, cls=None):
        if obj is None:
            return self
        v = obj._extra[self.i]
        if v is _UNKNOWN_ZONE:
            _refuse("tm_zone")
        return v


class struct_time(tuple):
    """The time value as returned by gmtime(), localtime(), and strptime(), and
    accepted by asctime(), mktime() and strftime().  May be considered as a
    sequence of 9 integers.

    Note that several fields' values are not the same as those defined by
    the C language standard for struct tm.  For example, the value of the
    field tm_year is the actual year, not year - 1900.  See individual
    fields' descriptions for details."""

    __slots__ = ("_extra",)
    n_sequence_fields = 9
    n_fields = 11
    n_unnamed_fields = 0
    __match_args__ = _FIELDS

    def __new__(cls, sequence, dict=None):
        try:
            seq = list(sequence)
        except TypeError:
            raise TypeError("constructor requires a sequence") from None
        if dict is not None and type(dict) is not type({}) and not isinstance(dict, type({})):
            raise TypeError("time.struct_time() takes a dict as second arg, if any")
        n = len(seq)
        if n < 9:
            raise TypeError("time.struct_time() takes an at least 9-sequence (%d-sequence given)" % n)
        if n > 11:
            raise TypeError("time.struct_time() takes an at most 11-sequence (%d-sequence given)" % n)
        extra = list(seq[9:]) + [None] * (11 - n)
        if dict:
            names = _EXTRA[n - 9:]
            if any(k not in names for k in dict):
                raise TypeError("time.struct_time() got duplicate or unexpected field name(s)")
            for i, name in enumerate(_EXTRA):
                if name in dict:
                    extra[i] = dict[name]
        return cls._make(seq[:9], extra[0], extra[1])

    @classmethod
    def _make(cls, fields, zone, gmtoff):
        self = tuple.__new__(cls, fields)
        object.__setattr__(self, "_extra", (zone, gmtoff))
        return self

    def __init_subclass__(cls, **kwargs):
        raise TypeError("type 'time.struct_time' is not an acceptable base type")

    def __setattr__(self, name, value):
        if name in _FIELDS or name in _EXTRA:
            raise AttributeError("readonly attribute")
        raise AttributeError("'time.struct_time' object has no attribute '%s'" % name)

    def __repr__(self):
        return "time.struct_time(%s)" % ", ".join("%s=%r" % (k, v) for k, v in zip(_FIELDS, self))

    def _check(self):
        if tuple.__getitem__(self, 8) is _UNKNOWN_DST:
            _refuse("tm_isdst")

    def __eq__(self, other):
        self._check()
        return tuple.__eq__(self, other)

    def __ne__(self, other):
        self._check()
        return tuple.__ne__(self, other)

    def __lt__(self, other):
        self._check()
        return tuple.__lt__(self, other)

    def __le__(self, other):
        self._check()
        return tuple.__le__(self, other)

    def __gt__(self, other):
        self._check()
        return tuple.__gt__(self, other)

    def __ge__(self, other):
        self._check()
        return tuple.__ge__(self, other)

    def __hash__(self):
        self._check()
        return tuple.__hash__(self)

    def __reduce__(self):
        self._check()
        zone, gmtoff = self._extra
        if zone is _UNKNOWN_ZONE:
            _refuse("tm_zone")
        return (struct_time, (tuple(self), {"tm_zone": zone, "tm_gmtoff": gmtoff}))

    def __replace__(self, /, **kwargs):
        values = dict(zip(_FIELDS, self))
        zone, gmtoff = self._extra
        values["tm_zone"], values["tm_gmtoff"] = zone, gmtoff
        for k, v in kwargs.items():
            if k not in values:
                raise TypeError("time.struct_time.__replace__() got an unexpected keyword argument '%s'" % k)
            values[k] = v
        return struct_time._make([values[k] for k in _FIELDS], values["tm_zone"], values["tm_gmtoff"])


for _i, _k in enumerate(_FIELDS):
    setattr(struct_time, _k, _Field(_i))
for _i, _k in enumerate(_EXTRA):
    setattr(struct_time, _k, _Extra(_i))
struct_time.__module__ = "time"
del _i, _k

# ------------------------------------------------------------------ calendar arithmetic

_INT_MAX, _INT_MIN = 2**31 - 1, -2**31
_TIME_T_MAX, _TIME_T_MIN = 2**63 - 1, -2**63


# (CPython's C functions read a builtin's own value: a float, int, str or
# tuple subclass's methods are not called on these)
def _int_value(v):
    """v as C's integer conversions read it: an int's own value, or what
    __index__ gives for anything else."""
    n = v if issubclass(type(v), int) else _index(v)
    # (int.__pos__: an exact int of a subclass's value)
    return n if type(n) is int else int.__pos__(n)


def _cwrap(n):
    """n in a C int, as C (CPython builds with -fwrapv) wraps it."""
    return ((n - _INT_MIN) % 2**32) + _INT_MIN


def _days(y, m, d):
    """Days since 1970-01-01 of a proleptic Gregorian date (any integers)."""
    y -= m <= 2
    era = y // 400
    yoe = y - era * 400
    doy = (153 * (m + (-3 if m > 2 else 9)) + 2) // 5 + d - 1
    return era * 146097 + yoe * 365 + yoe // 4 - yoe // 100 + doy - 719468


def _from_days(z):
    z += 719468
    era = z // 146097
    doe = z - era * 146097
    yoe = (doe - doe // 1460 + doe // 36524 - doe // 146096) // 365
    doy = doe - (365 * yoe + yoe // 4 - yoe // 100)
    mp = (5 * doy + 2) // 153
    d = doy - (153 * mp + 2) // 5 + 1
    m = mp + 3 if mp < 10 else mp - 9
    return yoe + era * 400 + (m <= 2), m, d


def _time_t(secs):
    """A timestamp as _PyTime_ObjectToTime_t takes it, rounding down."""
    if issubclass(type(secs), float):
        secs = float.__float__(secs)
        if secs != secs:
            raise ValueError("Invalid value NaN (not a number)")
        if not (-9.223372036854775808e18 <= secs < 9.223372036854775808e18):
            raise OverflowError("timestamp out of range for platform time_t")
        return int(_math.floor(secs))
    n = _int_value(secs)
    if not _TIME_T_MIN <= n <= _TIME_T_MAX:
        raise OverflowError("timestamp out of range for platform time_t")
    return n


def _overflow():
    raise OSError(75, "Value too large for defined data type")


def _year_out(tm_year):
    # (tm_year + 1900 as CPython computes it, in a C int: past INT_MAX it wraps)
    return _cwrap(tm_year + 1900)


def _broken(n, offset):
    """(tm_year, mon 1-12, mday, hour, min, sec, wday Monday=0, yday 1-366)
    of UTC second n shifted by offset, glibc's tm_year range enforced."""
    days, rem = divmod(n + offset, 86400)
    y, m, d = _from_days(days)
    if not _INT_MIN <= y - 1900 <= _INT_MAX:
        _overflow()
    hh, rem = divmod(rem, 3600)
    mi, ss = divmod(rem, 60)
    return y - 1900, m, d, hh, mi, ss, (days + 3) % 7, days - _days(y, 1, 1) + 1


def _struct(b, isdst, zone, gmtoff):
    tm_year, m, d, hh, mi, ss, wday, yday = b
    return struct_time._make((_year_out(tm_year), m, d, hh, mi, ss, wday, yday, isdst), zone, gmtoff)


def gmtime(seconds=None, /):
    """gmtime([seconds]) -> (tm_year, tm_mon, tm_mday, tm_hour, tm_min,
                           tm_sec, tm_wday, tm_yday, tm_isdst)

Convert seconds since the Epoch to a time tuple expressing UTC (a.k.a.
GMT).  When 'seconds' is not passed in, convert the current time instead.

If the platform supports the tm_gmtoff and tm_zone, they are available as
attributes only."""
    n = _time_t(time() if seconds is None else seconds)
    return _struct(_broken(n, 0), 0, "GMT", 0)


def _offset(n):
    """The host zone's UTC offset at UTC second n, refused outside the
    instants JavaScript's Date holds."""
    if _abbr is not None:
        return 0
    if _bad is not None:
        raise NotImplementedError(_bad)
    f = _time._local(n)
    if f is None:
        raise NotImplementedError("time: the host's time zone %s is known here only within JavaScript's dates "
                                  "(about 271821 BC to AD 275760)" % _host)
    return f[6]


def localtime(seconds=None, /):
    """localtime([seconds]) -> (tm_year,tm_mon,tm_mday,tm_hour,tm_min,
                          tm_sec,tm_wday,tm_yday,tm_isdst)

Convert seconds since the Epoch to a time tuple expressing local time.
When 'seconds' is not passed in, convert the current time instead."""
    n = _time_t(time() if seconds is None else seconds)
    if _abbr is not None:
        return _struct(_broken(n, 0), 0, _abbr, 0)
    _broken(n, 0)  # (glibc's range first)
    off = _offset(n)
    return _struct(_broken(n, off), _UNKNOWN_DST, _UNKNOWN_ZONE, off)


# ------------------------------------------------------------------ tuples in

def _cint(v):
    """A field as PyArg_ParseTuple's 'i' takes it."""
    n = _int_value(v)
    if n > _INT_MAX:
        raise OverflowError("signed integer is greater than maximum")
    if n < _INT_MIN:
        raise OverflowError("signed integer is less than minimum")
    return n


def _cmod7(v):
    q = abs(v) % 7
    return q if v >= 0 else -q


def _tmarg(t, fn):
    """CPython's gettmarg: a struct tm (C's fields: tm_year - 1900, tm_mon
    0-11, tm_wday Sunday=0, tm_yday 0-365) from a 9-tuple or struct_time,
    its stored items read (a tuple subclass's methods unused), then a
    struct_time's tm_zone (a str) and tm_gmtoff (a C long)."""
    if not issubclass(type(t), tuple):
        raise TypeError("Tuple or struct_time argument required")
    if tuple.__len__(t) != 9:
        raise TypeError("%s(): illegal time tuple argument" % fn)
    v = []
    for i in range(9):
        x = tuple.__getitem__(t, i)
        v.append(x if i == 8 and x is _UNKNOWN_DST else _cint(x))
    if v[0] < _INT_MIN + 1900:
        raise OverflowError("year out of range")
    tm = {"year": v[0] - 1900, "mon": v[1] - 1, "mday": v[2], "hour": v[3], "min": v[4], "sec": v[5],
          "wday": _cmod7(_cwrap(v[6] + 1)), "yday": v[7] - 1, "isdst": v[8], "zone": None, "gmtoff": 0}
    if type(t) is struct_time:
        zone, gmtoff = t._extra
        if zone is not None and zone is not _UNKNOWN_ZONE:
            # (PyUnicode_AsUTF8: a str, without lone surrogates)
            if not issubclass(type(zone), str):
                raise TypeError("bad argument type for built-in operation")
            zone = str.__str__(zone)
            for i, c in enumerate(zone):
                if "\ud800" <= c <= "\udfff":
                    raise UnicodeEncodeError("utf-8", zone, i, i + 1, "surrogates not allowed")
        tm["zone"] = zone
        if gmtoff is not None:
            # (PyLong_AsLong)
            g = _int_value(gmtoff)
            if not _TIME_T_MIN <= g <= _TIME_T_MAX:
                raise OverflowError("Python int too large to convert to C long")
            tm["gmtoff"] = g
    return tm


def _checktm(tm):
    """CPython's checks before strftime and asctime index their tables."""
    if tm["mon"] == -1:
        tm["mon"] = 0
    elif not 0 <= tm["mon"] <= 11:
        raise ValueError("month out of range")
    if tm["mday"] == 0:
        tm["mday"] = 1
    elif not 0 <= tm["mday"] <= 31:
        raise ValueError("day of month out of range")
    if not 0 <= tm["hour"] <= 23:
        raise ValueError("hour out of range")
    if not 0 <= tm["min"] <= 59:
        raise ValueError("minute out of range")
    if not 0 <= tm["sec"] <= 61:
        raise ValueError("seconds out of range")
    if tm["wday"] < 0:
        raise ValueError("day of week out of range")
    if tm["yday"] == -1:
        tm["yday"] = 0
    elif not 0 <= tm["yday"] <= 365:
        raise ValueError("day of year out of range")


def _local_tm(seconds):
    t = localtime(seconds)
    tm = _tmarg(t, "")
    return tm


_WDAY = ("Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat")
_MON = ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")
_WEEKDAY = ("Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday")
_MONTH = ("January", "February", "March", "April", "May", "June", "July", "August", "September", "October",
          "November", "December")


def _asctime(tm):
    return "%s %s%3d %.2d:%.2d:%.2d %d" % (_WDAY[tm["wday"]], _MON[tm["mon"]], tm["mday"], tm["hour"], tm["min"],
                                           tm["sec"], 1900 + tm["year"])


def asctime(time_tuple=None, /):
    """asctime([tuple]) -> string

Convert a time tuple to a string, e.g. 'Sat Jun 06 16:26:11 1998'.
When the time tuple is not present, current time as returned by localtime()
is used."""
    if time_tuple is None:
        tm = _local_tm(None)
    else:
        tm = _tmarg(time_tuple, "asctime")
        _checktm(tm)
    return _asctime(tm)


def ctime(seconds=None, /):
    """ctime(seconds) -> string

Convert a time in seconds since the Epoch to a string in local time.
This is equivalent to asctime(localtime(seconds)). When the time tuple is
not present, current time as returned by localtime() is used."""
    return _asctime(_local_tm(seconds))


# ------------------------------------------------------------------ mktime

def _wall(tm):
    """The seconds of tm's wall clock, as if UTC, normalized as glibc's
    mktime does (month past 11, day past the month's end, and so on)."""
    year = tm["year"] + 1900 + tm["mon"] // 12
    mon = tm["mon"] % 12
    if not _INT_MIN <= year - 1900 <= _INT_MAX:
        raise OverflowError("mktime argument out of range")
    s = (_days(year, mon + 1, 1) + tm["mday"] - 1) * 86400 + tm["hour"] * 3600 + tm["min"] * 60 + tm["sec"]
    days = s // 86400
    if not _INT_MIN <= _from_days(days)[0] - 1900 <= _INT_MAX:
        raise OverflowError("mktime argument out of range")
    return s


def _mktime(tm):
    w = _wall(tm)
    isdst = tm["isdst"]
    if _bad is not None:
        raise NotImplementedError(_bad)
    if _abbr is not None:
        # (a zone with no daylight saving: glibc moves a requested
        # daylight-saving time back an hour)
        return w - 3600 if isdst > 0 else w
    if isdst is _UNKNOWN_DST:
        _refuse("tm_isdst")
    if isdst >= 0:
        _refuse("mktime() with tm_isdst %d" % isdst)
    found = set()
    for probe in (w - 86400, w, w + 86400):
        t = w - _offset(probe)
        if t + _offset(t) == w:
            found.add(t)
    if len(found) != 1:
        raise NotImplementedError("time.mktime(): %s is %s in the host's time zone %s; glibc's answer for it "
                                  "depends on its own state, so it is not guessed here"
                                  % (_asctime_wall(w), "repeated" if found else "skipped", _host))
    t = found.pop()
    if not _TIME_T_MIN <= t <= _TIME_T_MAX:
        raise OverflowError("mktime argument out of range")
    return t


def _asctime_wall(w):
    days, rem = divmod(w, 86400)
    y, m, d = _from_days(days)
    return "%04d-%02d-%02d %02d:%02d:%02d" % (y, m, d, rem // 3600, rem // 60 % 60, rem % 60)


def mktime(time_tuple, /):
    """mktime(tuple) -> floating-point number

Convert a time tuple in local time to seconds since the Epoch.
Note that mktime(gmtime(0)) will not generally return zero for most
time zones; instead the returned value will either be equal to that
of the timezone or altzone attributes on the time module."""
    return float(_mktime(_tmarg(time_tuple, "mktime")))


# ------------------------------------------------------------------ strftime

def _iso(tm):
    """(ISO year, ISO week) of tm, as glibc's %G and %V compute them."""
    year = tm["year"] + 1900
    yday, wday = tm["yday"], tm["wday"]

    def week_days(yday, wday):
        # (the yday of the Monday of the ISO week holding yday 0's year's day 4)
        big = 366
        return yday - (yday - wday + 4 + big * 7) % 7 + 3

    days = week_days(yday, wday)
    if days < 0:
        year -= 1
        days = week_days(yday + (366 if _leap(year) else 365), wday)
    else:
        d = week_days(yday - (366 if _leap(year) else 365), wday)
        if d >= 0:
            year += 1
            days = d
    return year, days // 7 + 1


def _leap(y):
    return y % 4 == 0 and (y % 100 != 0 or y % 400 == 0)


# (which conversions take the E and O modifiers, as glibc 2.39 does in the
# C locale, where they change nothing; any other is copied as written)
_E_OK = set("CcPpRrsTtuXxYyZzn%")
_O_OK = set("BCGHIMPRSTUVWZbdeghjklmnprstuwyz%")
_SPACE_NUMBERS = set("ekls")  # (padded with spaces unless a flag says otherwise)


def _strftime(fmt, tm):
    """glibc's strftime in the C locale: flags _ - 0 ^ # (and +, taken as
    0), a width, the E and O modifiers, and its conversions, each padded and
    cased as glibc pads and cases it (checked against CPython 3.14 on glibc
    2.39, every flag, width and modifier with every letter); a directive it
    does not know is copied, padded to its width."""
    out = []
    i, n = 0, len(fmt)
    while i < n:
        c = fmt[i]
        if c != "%":
            out.append(c)
            i += 1
            continue
        start = i
        i += 1
        pad, upcase, swapcase = None, False, False
        while i < n and fmt[i] in "_-0^#+":
            f = fmt[i]
            if f == "^":
                upcase = True
            elif f == "#":
                swapcase = True
            else:
                pad = f
            i += 1
        width = 0
        while i < n and "0" <= fmt[i] <= "9":
            width = min(width * 10 + ord(fmt[i]) - 48, 2**31)
            i += 1
        mod = None
        if i < n and fmt[i] in "EO":
            mod = fmt[i]
            i += 1
        if i >= n:
            out.append(_copied(fmt[start:i], width, pad, upcase))
            break
        conv = fmt[i]
        if ord(conv) >= 128:
            # (a non-ASCII character there: the directive so far copied, and
            # the character left to be written as itself)
            out.append(_copied(fmt[start:i], width, pad, upcase))
            continue
        i += 1
        r = None
        if mod is None or conv in (_E_OK if mod == "E" else _O_OK):
            r = _conversion(conv, tm, pad, width, upcase, swapcase)
        if r is None:
            # (glibc cases %b and %h for # before it refuses the modifier)
            r = _copied(fmt[start:i], width, pad, upcase or (swapcase and conv in "bh"))
        out.append(r)
    return "".join(out)


def _fill(s, width, ch):
    return ch * (width - len(s)) + s if width > len(s) else s


def _copied(s, width, pad, upcase):
    # (a directive copied, as glibc's bad_format: upper-cased by ^, padded
    # to its width with zeros for 0, else spaces, "-" too)
    return _fill(s.upper() if upcase else s, width, "0" if pad in ("0", "+") else " ")


def _number(value, digits, pad, width, space=False):
    """A number as glibc writes one: zero-padded to digits (and to the
    width, after the sign); with "_", or by default for %e %k %l %s, padded
    with spaces, before the sign; with "-", no digit padding, but still
    spaces to the width."""
    neg = value < 0
    body = str(-value if neg else value)
    sign = "-" if neg else ""
    style = pad if pad in ("_", "-", "0", "+") else ("_" if space else "0")
    if style in ("0", "+"):
        return sign + body.zfill(max(digits, width) - len(sign))
    if style == "-":
        return _fill(sign + body, width, " ")
    return _fill(sign + body, max(digits, width), " ")


def _text(s, width, pad, upcase=False, swapcase=False, swap=None, zone=False):
    """Text as glibc writes it: ^ upper-cases, # does what swap says (upper
    for the names, lower for %p, nothing for the rest), padded to the width
    with zeros for 0, spaces otherwise ("-" too), but %Z not at all for "-"."""
    if swapcase and swap is not None:
        s = s.upper() if swap == "upper" else s.lower()
    elif upcase:
        s = s.upper()
    if pad == "-" and zone:
        return s
    return _fill(s, width, "0" if pad in ("0", "+") else " ")


def _conversion(c, tm, pad, width, upcase, swapcase):
    year = tm["year"] + 1900
    hour12 = tm["hour"] % 12 or 12
    if c == "%":
        return _fill("%", width, "0" if pad in ("0", "+") else " ")
    if c == "a":
        return _text(_WDAY[tm["wday"]], width, pad, upcase, swapcase, "upper")
    if c == "A":
        return _text(_WEEKDAY[tm["wday"]], width, pad, upcase, swapcase, "upper")
    if c in "bh":
        return _text(_MON[tm["mon"]], width, pad, upcase, swapcase, "upper")
    if c == "B":
        return _text(_MONTH[tm["mon"]], width, pad, upcase, swapcase, "upper")
    if c == "p":
        return _text("AM" if tm["hour"] < 12 else "PM", width, pad, upcase, swapcase, "lower")
    if c == "P":
        return _text("am" if tm["hour"] < 12 else "pm", width, pad)
    if c in "cDFrRTxX":
        sub = {"c": "%a %b %e %H:%M:%S %Y", "D": "%m/%d/%y", "F": "%Y-%m-%d", "r": "%I:%M:%S %p", "R": "%H:%M",
               "T": "%H:%M:%S", "x": "%m/%d/%y", "X": "%H:%M:%S"}[c]
        return _text(_strftime(sub, tm), width, pad, upcase)
    if c == "n":
        return _text("\n", width, pad)
    if c == "t":
        return _text("\t", width, pad)
    if c == "Z":
        zone = tm["zone"]
        if zone is _UNKNOWN_ZONE:
            _refuse("%Z")
        if zone is None:
            isdst = tm["isdst"]
            if isdst is _UNKNOWN_DST or (isdst >= 0 and _abbr is None):
                _refuse("%Z")
            zone = "" if isdst < 0 else _abbr
        return _text(zone, width, pad, upcase, zone=True)
    if c == "z":
        if tm["isdst"] is not _UNKNOWN_DST and tm["isdst"] < 0:
            return ""  # (nothing at all, whatever the width)
        diff = tm["gmtoff"]
        sign = "-" if diff < 0 else "+"
        diff = abs(diff) // 60
        hhmm = str(diff // 60 * 100 + diff % 60)
        # (glibc 2.39's: hhmm padded to the larger of 4 and the width, the
        # sign before it, then width - 1 more of the fill before that)
        if pad == "_":
            hhmm = _fill(hhmm, max(4, width), " ")
        elif pad == "-":
            hhmm = _fill(hhmm, width, " ")
        elif pad != "-":
            hhmm = hhmm.zfill(max(4, width))
        return ("0" if pad == "0" else " ") * max(0, width - 1) + sign + hhmm
    numbers = {
        "C": lambda: (year // 100, 1), "d": lambda: (tm["mday"], 2), "e": lambda: (tm["mday"], 2),
        "H": lambda: (tm["hour"], 2), "I": lambda: (hour12, 2), "k": lambda: (tm["hour"], 2), "l": lambda: (hour12, 2),
        "j": lambda: (tm["yday"] + 1, 3), "M": lambda: (tm["min"], 2), "m": lambda: (tm["mon"] + 1, 2),
        "S": lambda: (tm["sec"], 2), "s": lambda: (_mktime(dict(tm)), 1), "u": lambda: ((tm["wday"] - 1) % 7 + 1, 1),
        "U": lambda: ((tm["yday"] - tm["wday"] + 7) // 7, 2), "W": lambda: ((tm["yday"] - (tm["wday"] - 1 + 7) % 7 + 7) // 7, 2),
        "w": lambda: (tm["wday"], 1), "y": lambda: (year % 100, 2), "Y": lambda: (year, 1),
        "G": lambda: (_iso(tm)[0], 1), "g": lambda: (_iso(tm)[0] % 100, 2), "V": lambda: (_iso(tm)[1], 2),
    }
    f = numbers.get(c)
    if f is None:
        return None
    value, digits = f()
    return _number(value, digits, pad, width, space=c in _SPACE_NUMBERS)


def strftime(format, time_tuple=None, /):
    """strftime(format[, tuple]) -> string

Convert a time tuple to a string according to a format specification.
See the library reference manual for formatting codes. When the time tuple
is not present, current time as returned by localtime() is used.

Commonly used format codes:

%Y  Year with century as a decimal number.
%m  Month as a decimal number [01,12].
%d  Day of the month as a decimal number [01,31].
%H  Hour (24-hour clock) as a decimal number [00,23].
%M  Minute as a decimal number [00,59].
%S  Second as a decimal number [00,61].
%z  Time zone offset from UTC.
%a  Locale's abbreviated weekday name.
%A  Locale's full weekday name.
%b  Locale's abbreviated month name.
%B  Locale's full month name.
%c  Locale's appropriate date and time representation.
%I  Hour (12-hour clock) as a decimal number [01,12].
%p  Locale's equivalent of either AM or PM.

Other codes may be available on your platform.  See documentation for
the C library strftime function.
"""
    if not issubclass(type(format), str):
        raise TypeError("strftime() argument 1 must be str, not %s" % ("None" if format is None else type(format).__name__))
    format = str.__str__(format)
    if time_tuple is None:
        tm = _local_tm(None)
    else:
        tm = _tmarg(time_tuple, "strftime")
        _checktm(tm)
    if tm["isdst"] is not _UNKNOWN_DST:
        tm["isdst"] = max(-1, min(1, tm["isdst"]))
    return _strftime(format, tm)


# ------------------------------------------------------------------ the rest

def sleep(seconds, /):
    """sleep(seconds)

Delay execution for a given number of seconds.  The argument may be
a floating-point number for subsecond precision."""
    # (as CPython 3.14.8's _PyTime_FromSecondsObject: the seconds as int64
    # nanoseconds, checked before anything waits, then the sign: daybreak2's
    # HARD-DCB-1, a huge request never reaches the host's wait)
    if issubclass(type(seconds), float):
        seconds = float.__float__(seconds)
        if seconds != seconds:
            raise ValueError("Invalid value NaN (not a number)")
        if not (-9.223372036854775808e18 <= seconds * 1e9 <= 9.223372036854775807e18):
            raise OverflowError("timestamp out of range for C PyTime_t")
    else:
        try:
            seconds = _int_value(seconds)
        except TypeError:
            t = type(seconds)
            name = t.__qualname__ if t.__module__ == "builtins" else "%s.%s" % (t.__module__, t.__qualname__)
            raise TypeError("'%s' object cannot be interpreted as an integer or float" % name) from None
        if not -2**63 <= seconds * 10**9 <= 2**63 - 1:
            raise OverflowError("timestamp out of range for C PyTime_t")
    if seconds < 0:
        raise ValueError("sleep length must be non-negative")
    _time.sleep(seconds)


def tzset():
    """tzset()

Initialize, or reinitialize, the local timezone to the value stored in
os.environ['TZ']: not supported here, where the host's zone is read once."""
    raise NotImplementedError("time.tzset(): the host's time zone is read once, at import, here")


def strptime(string, format="%a %b %d %H:%M:%S %Y", /):
    """strptime(string, format) -> struct_time

Parse a string to a time tuple according to a format specification.
See the library reference manual for formatting codes (same as
strftime()).

Commonly used format codes:

%Y  Year with century as a decimal number.
%m  Month as a decimal number [01,12].
%d  Day of the month as a decimal number [01,31].
%H  Hour (24-hour clock) as a decimal number [00,23].
%M  Minute as a decimal number [00,59].
%S  Second as a decimal number [00,61].
%z  Time zone offset from UTC.
%a  Locale's abbreviated weekday name.
%A  Locale's full weekday name.
%b  Locale's abbreviated month name.
%B  Locale's full month name.
%c  Locale's appropriate date and time representation.
%I  Hour (12-hour clock) as a decimal number [01,12].
%p  Locale's equivalent of either AM or PM.

Other codes may be available on your platform.  See documentation for
the C library strftime function.
"""
    import _strptime
    return _strptime._strptime_time(string, format)


# (timezone, altzone and daylight as CPython's init_timezone computes them:
# localtime() of about now rounded down to a 365.25-day "year", and of half
# a year later, their offsets swapped for the southern hemisphere)
def _init_timezone(now):
    YEAR = (365 * 24 + 6) * 3600
    t = (now // YEAR) * YEAR
    jan = -_offset(t)
    jul = -_offset(t + YEAR // 2)
    if jan < jul:
        return jul, jan, int(jan != jul), (t + YEAR // 2, t)
    return jan, jul, int(jan != jul), (t, t + YEAR // 2)


if _bad is None:
    timezone, altzone, daylight, _probes = _init_timezone(int(time()))
if _abbr is not None:
    tzname = (_abbr, _abbr)


def __getattr__(name):
    # (tzname where it is not known; timezone, altzone and daylight too
    # where TZ is not available here: not in the module's dict, as tzname)
    if name == "tzname" or (_bad is not None and name in ("timezone", "altzone", "daylight")):
        _refuse(name)
    raise AttributeError("module 'time' has no attribute '%s'" % name)


# (the builtin module time is made from this one's public names: they say
# they are time's, as CPython's do)
for _v in list(globals().values()):
    if (callable(_v) or isinstance(_v, type)) and getattr(_v, "__module__", None) == __name__:
        try:
            _v.__module__ = "time"
        except (AttributeError, TypeError):
            pass
del _v
