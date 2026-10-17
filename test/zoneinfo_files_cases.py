# zoneinfo over TZif files built here (ZoneInfo.from_file), as CPython 3.14
# reads them (its C _zoneinfo), compared line by line
# (test/stdlib-zoneinfo.test.ts): TZ strings of every shape the footer may
# hold, well formed or not; malformed headers and data; the DST offsets
# inferred from the transitions; the zone before the first transition and
# after the last. Sizes stay within Sagebrush's bounds (those are tested
# apart).
import io
import struct
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo


def name(e):
    t = type(e)
    return t.__qualname__ if t.__module__ == "builtins" else t.__module__ + "." + t.__qualname__


def tzif(times=(), idxs=(), types=((0, 0, 0),), abbrs=b"UTC\0", footer=b"UTC0", version=b"2",
         leaps=(), isstd=None, isut=None, v1=None, newline=b"\n", tail=b"\n", header=None):
    def block(size):
        fmt = ">%d%s" % (len(times), "l" if size == 4 else "q")
        t = [max(-(1 << 31), min((1 << 31) - 1, x)) for x in times] if size == 4 else list(times)
        out = struct.pack(fmt, *t) + bytes(idxs)
        for off, dst, ai in types:
            out += struct.pack(">lbB", off, dst, ai)
        out += abbrs
        for lt, corr in leaps:
            out += struct.pack(">ll" if size == 4 else ">ql", lt, corr)
        out += bytes(isstd if isstd is not None else [])
        out += bytes(isut if isut is not None else [])
        return out

    counts = (len(isut or []), len(isstd or []), len(leaps), len(times), len(types), len(abbrs))
    h = header if header is not None else counts
    head = b"TZif" + version + b"\0" * 15 + struct.pack(">6l", *h)
    if version == b"\0":
        return head + block(4)
    return head + (v1 if v1 is not None else block(4)) + head + block(8) + newline + footer + tail


SAMPLES = [datetime(1, 1, 1), datetime(1969, 12, 31, 23, 59, 59), datetime(1970, 1, 1), datetime(2026, 1, 1),
           datetime(2026, 3, 8, 2, 30), datetime(2026, 3, 29, 1, 30), datetime(2026, 6, 30, 12),
           datetime(2026, 10, 25, 1, 30), datetime(2026, 11, 1, 1, 30), datetime(2027, 2, 28, 23),
           datetime(2028, 2, 29, 12), datetime(2028, 3, 1, 1, 59), datetime(2028, 12, 31, 23, 59, 59),
           datetime(9999, 12, 31, 23, 59, 59)]


def probe(label, data, more=()):
    try:
        z = ZoneInfo.from_file(io.BytesIO(data), key=label)
    except BaseException as e:
        print(label, "!!", name(e), str(e)[:300])
        return
    out = []
    for d in list(SAMPLES) + list(more):
        for fold in (0, 1):
            x = d.replace(fold=fold)
            try:
                out.append((z.utcoffset(x), z.dst(x), z.tzname(x)))
            except BaseException as e:
                out.append((name(e), str(e)[:100]))
        try:
            u = z.fromutc(d.replace(tzinfo=z))
            out.append((repr(u.replace(tzinfo=None)), u.fold))
        except BaseException as e:
            out.append((name(e), str(e)[:100]))
    try:
        out.append(("None", z.utcoffset(None), z.dst(None), z.tzname(None)))
    except BaseException as e:
        out.append((name(e), str(e)[:100]))
    print(label, "->", out)


# ------------------------------------------------------------------ TZ strings in the footer
FOOTERS = [
    b"UTC0", b"EST5", b"EST+5", b"EST-5", b"EST5:30", b"EST5:30:15", b"EST24", b"EST-24", b"EST25", b"EST-25",
    b"EST024", b"EST0024", b"EST5:3", b"EST5:60", b"EST5:99:99", b"EST5:", b"EST5::", b"EST",
    b"E5", b"ES5", b"<E>5", b"<>5", b"<+03>-3", b"<-03>3", b"<+0330>-3:30", b"<A1B2>4", b"<A_B>4", b"<A B>4",
    b"<ABC", b"<ABC>", b"ABC\x80" + b"5", b"\xc3\xa9AB5", b"5", b"",
    b"EST5EDT", b"EST5EDT,M3.2.0,M11.1.0", b"EST5EDT4,M3.2.0,M11.1.0", b"EST5EDT6,M3.2.0,M11.1.0",
    b"EST5EDT,M3.2.0/2,M11.1.0/2", b"EST5EDT,M3.2.0/2:30:15,M11.1.0/-1", b"EST5EDT,M3.2.0/167,M11.1.0/-167",
    b"EST5EDT,M3.2.0/168,M11.1.0", b"EST5EDT,M3.2.0/-168,M11.1.0", b"EST5EDT,M3.2.0/+2,M11.1.0",
    b"EST5EDT,M3.2.0,M11.1.0,", b"EST5EDT,M3.2.0,M11.1.0x", b"EST5EDT,M3.2.0", b"EST5EDT,", b"EST5EDT,,",
    b"EST5EDT,M13.2.0,M11.1.0", b"EST5EDT,M0.2.0,M11.1.0", b"EST5EDT,M3.6.0,M11.1.0", b"EST5EDT,M3.0.0,M11.1.0",
    b"EST5EDT,M3.2.7,M11.1.0", b"EST5EDT,M03.2.0,M11.1.0", b"EST5EDT,M123.2.0,M11.1.0", b"EST5EDT,M3.22.0,M11.1.0",
    b"EST5EDT,M3.2,M11.1.0", b"EST5EDT,M3,M11.1.0", b"EST5EDT,M.2.0,M11.1.0",
    b"EST5EDT,J60,J300", b"EST5EDT,J0,J300", b"EST5EDT,J1,J365", b"EST5EDT,J366,J1", b"EST5EDT,0,365", b"EST5EDT,59,60",
    b"EST5EDT,366,1", b"EST5EDT,1000,1", b"EST5EDT,J60/25,J300/-1", b"EST5EDT,J60/1:2,J300", b"EST5EDT,J60/1:02:3,J300",
    b"AAA0BBB,0/0,J365/25", b"AAA3BBB,J1/0,J365/24", b"IST-1GMT0,M10.5.0,M3.5.0/1", b"<+1030>-10:30<+11>-11,M10.1.0,M4.1.0",
    b"<+13>-13<+14>,M9.5.0/3,M4.1.0/4", b"NZST-12NZDT,M9.5.0,M4.1.0/3", b"WART4WARST,J1/0,J365/25",
    b"AAA-1BBB-2,M3.5.0,M10.5.0", b"AAA1BBB2,M3.5.0,M10.5.0", b"AAA1BBB0,M3.5.0,M10.5.0",
    b"EST5EDT\0junk", b"EST5\0EDT", b"EST5EDT,M3.2.0,M11.1.0\0x", b" EST5", b"EST 5", b"EST5 ",
]
for i, footer in enumerate(FOOTERS):
    probe("footer %r" % footer, tzif(footer=footer))
    # (with transitions before the footer's rules take over)
    probe("footer+trans %r" % footer, tzif(times=(-1000000000, 0), idxs=(1, 0), types=((-18000, 0, 0), (-14400, 1, 4)),
                                            abbrs=b"EST\0EDT\0", footer=footer))

# ------------------------------------------------------------------ malformed files
probe("empty", b"")
probe("magic", b"TZiX" + tzif()[4:])
probe("version 1", tzif(version=b"\0", footer=b""))
probe("version 1 with transitions", tzif(version=b"\0", times=(0, 100000), idxs=(1, 0), types=((0, 0, 0), (3600, 1, 4)), abbrs=b"AAA\0BBB\0"))
probe("version 3", tzif(version=b"3"))
probe("version 4", tzif(version=b"4"))
probe("version 9", tzif(version=b"9"))
probe("version x", tzif(version=b"x"))
probe("version space", tzif(version=b" "))
probe("truncated header", tzif()[:30])
probe("truncated data", tzif(times=(0, 1, 2), idxs=(0, 0, 0))[:60])
probe("no first newline", tzif(newline=b"x"))
probe("no last newline", tzif(tail=b""))
probe("footer then more", tzif(tail=b"\nmore"))
probe("index out of range", tzif(times=(0,), idxs=(1,)))
probe("index far out", tzif(times=(0, 5), idxs=(0, 200)))
probe("no types, footer", tzif(types=(), abbrs=b"", footer=b"EST5"))
probe("no types, no footer", tzif(types=(), abbrs=b"", footer=b""))
probe("no types, version 1", tzif(types=(), abbrs=b"", version=b"\0"))
probe("abbr without NUL", tzif(abbrs=b"UTC"))
probe("abbr index past end", tzif(types=((0, 0, 9),), abbrs=b"UTC\0"))
probe("abbr not UTF-8", tzif(abbrs=b"\xff\xfe\0"))
probe("abbr UTF-8", tzif(abbrs="Ω\0".encode()))
probe("abbr empty", tzif(abbrs=b"\0"))
probe("leap seconds", tzif(leaps=((78796800, 1), (94694401, 2))))
probe("isstd/isut", tzif(isstd=[1], isut=[1]))
probe("isdst 2", tzif(times=(0, 100000), idxs=(1, 0), types=((0, 0, 0), (3600, 2, 4)), abbrs=b"AAA\0BBB\0", footer=b""))
probe("isdst -1", tzif(times=(0, 100000), idxs=(1, 0), types=((0, 0, 0), (3600, -1, 4)), abbrs=b"AAA\0BBB\0", footer=b""))
probe("big offset", tzif(types=((86399 * 2, 0, 0),), footer=b""))
probe("negative offset", tzif(types=((-(1 << 31), 0, 0),), footer=b""))
probe("counts negative", tzif(header=(0, 0, 0, -1, 1, 4)))
probe("typecnt negative", tzif(header=(0, 0, 0, 0, -1, 4)))
probe("charcnt negative", tzif(header=(0, 0, 0, 0, 1, -4)))
probe("unsorted transitions", tzif(times=(100000, 0, 50000), idxs=(1, 0, 1), types=((0, 0, 0), (3600, 1, 4)), abbrs=b"AAA\0BBB\0", footer=b""))
probe("equal transitions", tzif(times=(0, 0), idxs=(1, 0), types=((0, 0, 0), (3600, 1, 4)), abbrs=b"AAA\0BBB\0", footer=b""))
probe("far transitions", tzif(times=(-(1 << 59), 1 << 40), idxs=(1, 0), types=((0, 0, 0), (3600, 1, 4)), abbrs=b"AAA\0BBB\0", footer=b""))
probe("v1 block wrong size", tzif(v1=b"\0" * 3))

# ------------------------------------------------------------------ the DST offsets inferred
H = 3600
DST_CASES = {
    "std dst std": ((0, H, 2 * H), (0, 1, 0), ((0, 0, 0), (H, 1, 4))),
    "dst first": ((0, H, 2 * H), (1, 0, 1), ((0, 0, 0), (H, 1, 4))),
    "two dsts": ((0, H, 2 * H, 3 * H), (1, 2, 0, 2), ((0, 0, 0), (H, 1, 4), (2 * H, 1, 8))),
    "dst to dst": ((0, H, 2 * H), (1, 2, 0), ((0, 0, 0), (H, 1, 4), (2 * H, 1, 8))),
    "only dst": ((0, H), (0, 1), ((H, 1, 0), (2 * H, 1, 4))),
    "same offset dst": ((0, H), (1, 0), ((0, 0, 0), (0, 1, 4))),
    "negative dst": ((0, H, 2 * H), (1, 0, 1), ((H, 0, 0), (0, 1, 4))),
    "dst after last": ((0, H), (0, 1), ((0, 0, 0), (H, 1, 4))),
}
for label, (times, idxs, types) in DST_CASES.items():
    probe("dst " + label, tzif(times=times, idxs=idxs, types=types, abbrs=b"AAA\0BBB\0CCC\0", footer=b""),
          more=[datetime(1970, 1, 1, 0, 30), datetime(1970, 1, 1, 1, 30), datetime(1970, 1, 1, 2, 30), datetime(1970, 1, 1, 3, 30)])
    probe("dst footer " + label, tzif(times=times, idxs=idxs, types=types, abbrs=b"AAA\0BBB\0CCC\0", footer=b"AAA0"),
          more=[datetime(1970, 1, 1, 0, 30), datetime(1970, 1, 1, 3, 30)])

# ------------------------------------------------------------------ fromutc around the last transition
for footer in (b"EST5EDT,M3.2.0,M11.1.0", b"EST5", b"EDT4", b"AAA6", b""):
    data = tzif(times=(0, 31536000), idxs=(1, 0), types=((-18000, 0, 0), (-14400, 1, 4)), abbrs=b"EST\0EDT\0", footer=footer)
    try:
        z = ZoneInfo.from_file(io.BytesIO(data))
        out = []
        for s in range(31536000 - 7200, 31536000 + 7201, 900):
            u = (datetime(1970, 1, 1) + timedelta(seconds=s)).replace(tzinfo=z)
            r = z.fromutc(u)
            out.append((r.replace(tzinfo=None).isoformat(), r.fold))
        print("last transition %r ->" % footer, out)
    except BaseException as e:
        print("last transition %r !!" % footer, name(e), str(e)[:200])
