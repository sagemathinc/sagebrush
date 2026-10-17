# zoneinfo's bounds in Sagebrush (test/stdlib-zoneinfo.test.ts), which CPython
# does not have: a TZif header's counts past _tzrules' bounds are refused
# before what they count is read, a file on TZPATH past _tzrules.MAX_FILE is
# refused, a FIFO on TZPATH is not a zone and is never opened, and the
# timedelta cache stays bounded. ZI_DIR is a directory the test made: a
# file past the bound ("big"), a FIFO ("fifo") and a zone ("Zone").
import io
import os
import struct
import _tzrules
import zoneinfo
from zoneinfo import ZoneInfo


def tzif(ntimes=0, ntypes=1, nchars=4, footer=b"UTC0"):
    head = b"TZif2" + b"\0" * 15 + struct.pack(">6l", 0, 0, 0, ntimes, ntypes, nchars)
    v1 = struct.pack(">%dl" % ntimes, *range(ntimes)) + bytes(ntimes) + b"\0\0\0\0\0\0" * ntypes + b"UTC\0" + b"\0" * (nchars - 4)
    v2 = struct.pack(">%dq" % ntimes, *range(ntimes)) + bytes(ntimes) + b"\0\0\0\0\0\0" * ntypes + b"UTC\0" + b"\0" * (nchars - 4)
    return head + v1 + head + v2 + b"\n" + footer + b"\n"


def show(label, f):
    try:
        r = f()
    except BaseException as e:
        print(label, "!!", type(e).__name__, str(e))
    else:
        print(label, "->", r)


print("bounds", _tzrules.MAX_TIMES, _tzrules.MAX_TYPES, _tzrules.MAX_CHARS, _tzrules.MAX_FILE)
show("transitions at the bound", lambda: str(ZoneInfo.from_file(io.BytesIO(tzif(ntimes=_tzrules.MAX_TIMES)))).startswith("zoneinfo.ZoneInfo.from_file("))
show("transitions past the bound", lambda: ZoneInfo.from_file(io.BytesIO(tzif(ntimes=_tzrules.MAX_TIMES + 1))))
show("types at the bound", lambda: str(ZoneInfo.from_file(io.BytesIO(tzif(ntypes=_tzrules.MAX_TYPES)))).startswith("zoneinfo.ZoneInfo.from_file("))
show("types past the bound", lambda: ZoneInfo.from_file(io.BytesIO(tzif(ntypes=_tzrules.MAX_TYPES + 1))))
show("abbreviations past the bound", lambda: ZoneInfo.from_file(io.BytesIO(tzif(nchars=_tzrules.MAX_CHARS + 1))))
# (a header claiming more than the file has: its bound first, before reading)
show("a version 1 header's huge count", lambda: ZoneInfo.from_file(io.BytesIO(b"TZif\0" + b"\0" * 15 + struct.pack(">6l", 0, 0, 0, 1 << 30, 1, 4))))
show("a version 2 header's huge count", lambda: ZoneInfo.from_file(io.BytesIO(tzif()[:44] + tzif()[44:].replace(b"TZif2" + b"\0" * 15 + struct.pack(">6l", 0, 0, 0, 0, 1, 4), b"TZif2" + b"\0" * 15 + struct.pack(">6l", 0, 0, 0, 1 << 30, 1, 4)))))

d = os.environ.get("ZI_DIR")
if d:
    zoneinfo.reset_tzpath([d])
    show("a zone file", lambda: ZoneInfo.no_cache("Zone").utcoffset(None))
    show("a file past MAX_FILE", lambda: ZoneInfo.no_cache("big"))
    show("a FIFO", lambda: ZoneInfo.no_cache("fifo"))
    show("available_timezones", lambda: sorted(zoneinfo.available_timezones()))

from _zoneinfo import _TIMEDELTA_CACHE, _TIMEDELTA_CACHE_MAX

for i in range(_TIMEDELTA_CACHE_MAX + 100):
    data = tzif(footer=b"<A%d>%d:%02d:%02d" % (i, (i // 3600) % 24, (i // 60) % 60, i % 60))
    ZoneInfo.from_file(io.BytesIO(data))
print("timedelta cache", len(_TIMEDELTA_CACHE) <= _TIMEDELTA_CACHE_MAX, _TIMEDELTA_CACHE_MAX)
