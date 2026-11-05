"""Dates and times for Sagebrush's pandas (design-pandas-xlsx-timeseries r1,
PR A): the datetime64[us] dtype, NaT, Timestamp and to_datetime, as pandas
3.1 has them for naive (timezone-free) times.

Sagebrush's numpy has no datetime64 yet, so this lives here, in pandas: a
datetime column is a numpy int64 array of microseconds since 1970-01-01, NaT
being int64's minimum, and its dtype is DatetimeDtype, which prints and
compares as pandas' `datetime64[us]`.  What would hand out numpy datetime64
values (a datetime column's `.values`, `.to_numpy()`) raises
NotImplementedError rather than give another type; a numpy with datetime64
can later replace these internals without changing anything else.  The
microsecond counts are exact (Sagebrush's int64 is exact to 2**53) for the
years 1685 to 2255; outside them a time raises NotImplementedError.

pandas 3.1 makes datetime64[us] from datetime objects, ISO strings and
numbers with a unit alike (measured on the oracle), and that is the only unit
here: a nanosecond time, or any timezone, is NotImplementedError.
"""

import re
from datetime import date, datetime, timedelta

import numpy as np

__all__ = ["DatetimeDtype", "DateParseError", "DT", "NaT", "NAT_INT", "Timestamp", "to_datetime", "as_us", "to_us", "from_us", "is_time", "fmt_times"]

NAT_INT = -(2 ** 63)
_EPOCH = datetime(1970, 1, 1)
# (the microseconds exact in Sagebrush's int64: |v| < 2**53)
_EXACT = 2 ** 53


def _subset(what):
    return NotImplementedError("pandas: %s is not in Sagebrush's pandas 0.x subset" % what)


class DatetimeDtype(object):
    """numpy's datetime64[us], as pandas shows it: str 'datetime64[us]',
    repr dtype('<M8[us]')."""

    __slots__ = ()
    name = "datetime64[us]"
    kind = "M"
    str = "<M8[us]"
    unit = "us"

    def __repr__(self):
        return "dtype('<M8[us]')"

    def __str__(self):
        return "datetime64[us]"

    def __eq__(self, other):
        return isinstance(other, DatetimeDtype) or (isinstance(other, type("")) and other in ("datetime64[us]", "M8[us]", "<M8[us]"))

    def __ne__(self, other):
        return not self == other

    def __hash__(self):
        return hash("datetime64[us]")


DT = DatetimeDtype()


class NaTType(object):
    """pandas' NaT: a missing time."""

    __slots__ = ()

    def __repr__(self):
        return "NaT"

    __str__ = __repr__

    def __eq__(self, other):
        return False

    def __ne__(self, other):
        return True

    def __lt__(self, other):
        return False

    __le__ = __gt__ = __ge__ = __lt__

    def __hash__(self):
        return hash("NaT")

    def __bool__(self):
        return True

    def isoformat(self):
        return "NaT"

    def strftime(self, fmt):
        raise ValueError("NaTType does not support strftime")


NaT = NaTType()


def as_us(v):
    """The microseconds since 1970 of a datetime (or Timestamp), checked
    exact."""
    if isinstance(v, Timestamp):
        v = v._pd_dt
    if v.tzinfo is not None:
        raise _subset("a time with a timezone")
    d = v - _EPOCH
    us = (d.days * 86400 + d.seconds) * 1000000 + d.microseconds
    if not -_EXACT < us < _EXACT:
        raise _subset("a time outside the years 1685 to 2255")
    return us


def to_us(v):
    """A column's int for a value it holds: a datetime, a Timestamp or a
    missing value (None, NaN, NaT)."""
    from ._pd_dtypes import is_missing
    if is_missing(v):
        return NAT_INT
    if is_time(v):
        return as_us(v)
    raise TypeError("<class '%s'> is not convertible to datetime" % type(v).__name__)


def from_us(us):
    """The Timestamp of a column's int, or NaT."""
    us = int(us)
    if us == NAT_INT:
        return NaT
    return Timestamp(_EPOCH + timedelta(microseconds=us))


class Timestamp(object):
    """pandas' Timestamp for naive times, to the microsecond: a datetime."""

    __slots__ = ("_pd_dt",)

    def __new__(cls, ts_input=None, *args, **kwargs):
        if args or kwargs:
            if isinstance(ts_input, int) and not isinstance(ts_input, bool) and args and not kwargs:
                ts_input = datetime(ts_input, *args)
            else:
                raise _subset("Timestamp() with these arguments")
        if isinstance(ts_input, Timestamp):
            return ts_input
        if isinstance(ts_input, str):
            v = _parse(ts_input)
            if v is NaT:
                return NaT
        elif isinstance(ts_input, datetime):
            v = ts_input
        elif isinstance(ts_input, date):
            v = datetime(ts_input.year, ts_input.month, ts_input.day)
        else:
            raise _subset("Timestamp(%s)" % type(ts_input).__name__)
        if v.tzinfo is not None:
            raise _subset("a time with a timezone")
        self = object.__new__(cls)
        self._pd_dt = v
        as_us(v)
        return self

    year = property(lambda self: self._pd_dt.year)
    month = property(lambda self: self._pd_dt.month)
    day = property(lambda self: self._pd_dt.day)
    hour = property(lambda self: self._pd_dt.hour)
    minute = property(lambda self: self._pd_dt.minute)
    second = property(lambda self: self._pd_dt.second)
    microsecond = property(lambda self: self._pd_dt.microsecond)
    nanosecond = property(lambda self: 0)
    unit = property(lambda self: "us")

    def dayofweek(self):
        return self._pd_dt.weekday()

    def to_pydatetime(self):
        return self._pd_dt

    def date(self):
        return self._pd_dt.date()

    def strftime(self, fmt):
        return self._pd_dt.strftime(fmt)

    def isoformat(self, sep="T"):
        return self._pd_dt.isoformat(sep)

    def __str__(self):
        return self._pd_dt.isoformat(" ")

    def __repr__(self):
        return "Timestamp('%s')" % self._pd_dt.isoformat(" ")

    def _pd_other(self, other):
        if isinstance(other, Timestamp):
            return other._pd_dt
        if isinstance(other, datetime):
            return other
        return None

    def __eq__(self, other):
        o = self._pd_other(other)
        return o is not None and self._pd_dt == o

    def __ne__(self, other):
        return not self == other

    def __lt__(self, other):
        o = self._pd_other(other)
        if o is None:
            return NotImplemented
        return self._pd_dt < o

    def __le__(self, other):
        o = self._pd_other(other)
        if o is None:
            return NotImplemented
        return self._pd_dt <= o

    def __gt__(self, other):
        o = self._pd_other(other)
        if o is None:
            return NotImplemented
        return self._pd_dt > o

    def __ge__(self, other):
        o = self._pd_other(other)
        if o is None:
            return NotImplemented
        return self._pd_dt >= o

    def __hash__(self):
        return hash(self._pd_dt)

    def __sub__(self, other):
        raise _subset("Timedelta (a difference of times)")

    __rsub__ = __add__ = __radd__ = __sub__


# (the fields .dt and an index give, by name)
FIELDS = {
    "year": lambda t: t.year, "month": lambda t: t.month, "day": lambda t: t.day,
    "hour": lambda t: t.hour, "minute": lambda t: t.minute, "second": lambda t: t.second,
}


def is_time(v):
    """A value a datetime column holds: a datetime (not a bare date) or a
    Timestamp."""
    return isinstance(v, (datetime, Timestamp))


class DateParseError(ValueError):
    """pandas' DateParseError (pandas._libs.tslibs.parsing): a string that
    isn't a time, or names a month or day that doesn't exist."""


_TRY = (". You might want to try:\n"
        "    - passing `format` if your strings have a consistent format;\n"
        "    - passing `format='ISO8601'` if your strings are all ISO8601 but not necessarily in exactly the same format;\n"
        "    - passing `format='mixed'`, and the format will be inferred for each element individually. You might want to use `dayfirst` alongside this.")

# (the formats pandas 3.1 reads a string in without being given one: a scalar
# in whichever matches, a list in the one its first string matches)
_SHAPES = [
    (re.compile(r"(\d{4})-(\d{2})-(\d{2})"), "%Y-%m-%d"),
    (re.compile(r"(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})"), "%Y-%m-%d %H:%M"),
    (re.compile(r"(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})"), "%Y-%m-%d %H:%M:%S"),
    (re.compile(r"(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\.(\d{1,6})"), "%Y-%m-%d %H:%M:%S.%f"),
    (re.compile(r"(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})"), "%Y-%m-%dT%H:%M"),
    (re.compile(r"(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})"), "%Y-%m-%dT%H:%M:%S"),
    (re.compile(r"(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{1,6})"), "%Y-%m-%dT%H:%M:%S.%f"),
    (re.compile(r"(\d{1,2})/(\d{1,2})/(\d{4})"), "%m/%d/%Y"),
    (re.compile(r"(\d{4})(\d{2})(\d{2})"), "%Y%m%d"),
]
_NAT_TEXT = ("", "NaT", "nat", "NAT")


def _shape_of(t):
    for rx, fmt in _SHAPES:
        if rx.fullmatch(t):
            return rx, fmt
    return None


def _checked(t, y, mo, d, h=0, mi=0, sec=0, us=0):
    # (outside the years whose microseconds are exact here: refused before anything else, as Timestamp() and as_us do)
    if not 1685 <= y <= 2255:
        raise _subset("a time outside the years 1685 to 2255")
    if not 1 <= mo <= 12:
        raise DateParseError("month must be in 1..12, not %d: %s" % (mo, t))
    last = (date(y + (mo == 12), mo % 12 + 1, 1) - timedelta(days=1)).day
    if not 1 <= d <= last:
        raise DateParseError("day %d must be in range 1..%d for month %d in year %d: %s" % (d, last, mo, y, t))
    for name, v, top in (("hour", h, 23), ("minute", mi, 59), ("second", sec, 59)):
        if v > top:
            raise DateParseError("%s must be in 0..%d, not %d: %s" % (name, top, v, t))
    return datetime(y, mo, d, h, mi, sec, us)


def _build(t, rx, fmt):
    g = rx.fullmatch(t).groups()
    if fmt == "%m/%d/%Y":
        return _checked(t, int(g[2]), int(g[0]), int(g[1]))
    rest = [int(x) for x in g[3:6]] + ([int(g[6].ljust(6, "0"))] if len(g) > 6 else [])
    return _checked(t, int(g[0]), int(g[1]), int(g[2]), *rest)


def _unparsed(s):
    t = s.strip()
    # (no digit at all: pandas' DateParseError; else a form this subset doesn't read)
    if not re.search(r"\d", t):
        return DateParseError("Unknown datetime string format, unable to parse: %s" % s)
    return _subset("reading the time %r (only ISO dates and times, M/D/YYYY and YYYYMMDD are read)" % s[:60])


def _parse(s):
    """A string as pandas 3.1 reads it alone (a scalar): 'NaT' and '' are
    NaT."""
    t = s.strip()
    if t in _NAT_TEXT:
        return NaT
    sh = _shape_of(t)
    if sh is None:
        raise _unparsed(s)
    return _build(t, *sh)


def _parse_like(s, rx, fmt):
    """s in the format a list's first string gave, or pandas' ValueError."""
    t = s.strip()
    if t in _NAT_TEXT:
        return NaT
    if rx.fullmatch(t):
        return _build(t, rx, fmt)
    m = rx.match(t)
    if m:
        raise ValueError("unconverted data remains when parsing with format \"%s\": \"%s\"" % (fmt, t[m.end():]) + _TRY)
    raise ValueError("time data \"%s\" doesn't match format \"%s\"" % (s, fmt) + _TRY)


_FMT = {"%Y": r"(?P<Y>\d{4})", "%m": r"(?P<m>\d{1,2})", "%d": r"(?P<d>\d{1,2})", "%H": r"(?P<H>\d{1,2})", "%M": r"(?P<M>\d{1,2})", "%S": r"(?P<S>\d{1,2})", "%y": r"(?P<y>\d{2})", "%f": r"(?P<f>\d{1,6})", "%j": r"(?P<j>\d{1,3})", "%%": "%"}


def _parse_format(s, fmt):
    # (a format of %Y %m %d %H %M %S %y %f and literal text: the directives the corpus uses)
    pat = []
    i = 0
    while i < len(fmt):
        if fmt[i] == "%":
            d = fmt[i:i + 2]
            if d not in _FMT:
                raise _subset("to_datetime's format directive %r" % d)
            pat.append(_FMT[d])
            i += 2
        else:
            pat.append(re.escape(fmt[i]))
            i += 1
    t = s.strip()
    if t in _NAT_TEXT:
        return NaT
    rx = re.compile("".join(pat))
    m = rx.fullmatch(t)
    if not m:
        pm = rx.match(t)
        if pm:
            raise ValueError("unconverted data remains when parsing with format \"%s\": \"%s\"" % (fmt, t[pm.end():]) + _TRY)
        raise ValueError("time data \"%s\" doesn't match format \"%s\"" % (s, fmt) + _TRY)
    g = m.groupdict()
    y = int(g["Y"]) if g.get("Y") else (2000 + int(g["y"]) if int(g["y"]) < 69 else 1900 + int(g["y"])) if g.get("y") else 1900
    if g.get("j"):
        # (a day of the year: counted from 1 January, into the next year past its end, as pandas' strptime)
        if int(g["j"]) < 1:
            raise ValueError("time data \"%s\" doesn't match format \"%s\"" % (s, fmt) + _TRY)
        d0 = _checked(t, y, 1, 1, int(g.get("H") or 0), int(g.get("M") or 0), int(g.get("S") or 0), int((g.get("f") or "0").ljust(6, "0")))
        return d0 + timedelta(days=int(g["j"]) - 1)
    return _checked(t, y, int(g.get("m") or 1), int(g.get("d") or 1), int(g.get("H") or 0), int(g.get("M") or 0), int(g.get("S") or 0), int((g.get("f") or "0").ljust(6, "0")))


_UNITS = {"D": 86400 * 10 ** 6, "s": 10 ** 6, "ms": 10 ** 3, "us": 1}


def _number_us(v, unit, origin_us, scalar):
    if unit is None:
        raise _subset("to_datetime of a number without a unit (pandas reads it as nanoseconds)")
    if isinstance(v, (float, np.floating)):
        # (pandas 3.1 makes a list with a fractional number datetime64[ns]: not here; a scalar is a Timestamp)
        if not scalar and not float(v).is_integer():
            raise _subset("to_datetime of a list with a fractional number (a datetime64[ns] result)")
        exact = float(v) * _UNITS[unit]
        # (a fraction of a microsecond is a nanosecond Timestamp in pandas: not here)
        if exact != int(exact):
            raise _subset("to_datetime of a number below a microsecond (a nanosecond result)")
        us = origin_us + int(exact)
    else:
        us = origin_us + int(v) * _UNITS[unit]
    if not -_EXACT < us < _EXACT:
        raise _subset("a time outside the years 1685 to 2255")
    return us


def _one(v, fmt, like, unit, origin_us, scalar, errors):
    """The microseconds of one value (NAT_INT for a missing one); `like`, a
    list's inferred format for its strings."""
    from ._pd_dtypes import is_missing
    try:
        if v is None or v is NaT or is_missing(v):
            return NAT_INT
        if isinstance(v, (Timestamp, datetime)):
            return as_us(v)
        if isinstance(v, date):
            return as_us(datetime(v.year, v.month, v.day))
        if isinstance(v, str):
            if fmt is not None:
                d = _parse_format(v, fmt)
            elif like is not None:
                d = _parse_like(v, *like)
            else:
                d = _parse(v)
            return NAT_INT if d is NaT else as_us(d)
        if isinstance(v, (int, float, np.integer, np.floating)) and not isinstance(v, (bool, np.bool_)):
            return _number_us(v, unit, origin_us, scalar)
        raise TypeError("<class '%s'> is not convertible to datetime" % type(v).__name__)
    except (ValueError, TypeError):
        if errors == "coerce":
            return NAT_INT
        raise


def _many(vals, fmt, unit, origin_us, errors):
    import numpy as np
    like = None
    if fmt is None:
        first = next((v for v in vals if isinstance(v, str) and v.strip() not in _NAT_TEXT), None)
        if first is not None:
            like = _shape_of(first.strip())
            if like is None:
                if errors != "coerce":
                    raise _unparsed(first)
        elif vals and all(isinstance(v, str) for v in vals):
            raise _subset("to_datetime of strings that are all NaT (pandas makes datetime64[s] of them)")
    return np.array([_one(v, fmt, like, unit, origin_us, False, errors) for v in vals], dtype=np.int64)


def to_datetime(arg, errors="raise", dayfirst=False, yearfirst=False, utc=False, format=None, exact=True, unit=None, origin="unix", cache=True):
    """pandas' to_datetime for naive times: a string, datetime or number
    gives a Timestamp (or NaT), a list, tuple or array a DatetimeIndex, a
    Series a Series of datetime64[us]."""
    if errors not in ("raise", "coerce"):
        raise ValueError("errors must be one of 'raise', or 'coerce'.")
    if dayfirst or yearfirst or utc:
        raise _subset("to_datetime's dayfirst, yearfirst and utc")
    if unit is not None and unit not in _UNITS:
        raise _subset("to_datetime's unit=%r" % (unit,))
    if format is not None and (not isinstance(format, str) or format in ("ISO8601", "mixed")):
        raise _subset("to_datetime's format=%r" % (format,))
    if exact is not True and format is not None:
        # (without a format exact changes nothing in pandas 3.1; with one, a match anywhere in the string, and datetime64[ns])
        raise _subset("to_datetime's exact=False with a format")
    has_origin = origin != "unix"
    if not has_origin:
        origin_us = 0
    elif unit is not None:
        origin_us = as_us(Timestamp(origin))
    else:
        # (pandas then reads numbers as nanoseconds after the origin: not here)
        raise _subset("to_datetime's origin= without a unit (nanoseconds)")
    from ._pd_series import Series
    from ._pd_index import Index
    from ._pd_column import Column
    if isinstance(arg, Series):
        col = Column(DT, _many(arg._pd_col.tolist(), format, unit, origin_us, errors))
        return Series._pd_new(col, arg.index.copy(), arg.name)
    if isinstance(arg, (list, tuple, np.ndarray, Index)):
        vals = arg.tolist() if isinstance(arg, (np.ndarray, Index)) else list(arg)
        return Index(Column(DT, _many(vals, format, unit, origin_us, errors)))
    if arg is None:
        return NaT
    return from_us(_one(arg, format, None, unit, origin_us, True, errors))


def fmt_times(values):
    """The texts pandas shows a datetime column's values (ints) with: dates
    alone when every time is midnight, else 'YYYY-MM-DD HH:MM:SS', with the
    microseconds when any has them; 'NaT' for a missing one."""
    ts = [from_us(v) for v in values]
    real = [t for t in ts if t is not NaT]
    if all(t.hour == 0 and t.minute == 0 and t.second == 0 and t.microsecond == 0 for t in real):
        return ["NaT" if t is NaT else t.strftime("%Y-%m-%d") for t in ts]
    frac = any(t.microsecond for t in real)
    return ["NaT" if t is NaT else t.strftime("%Y-%m-%d %H:%M:%S.%f" if frac else "%Y-%m-%d %H:%M:%S") for t in ts]
