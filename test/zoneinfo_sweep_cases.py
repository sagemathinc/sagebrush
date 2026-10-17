# Every zone zoneinfo.available_timezones() lists, through ZoneInfo as
# CPython 3.14 gives it (its C _zoneinfo), compared line by line
# (test/stdlib-zoneinfo.test.ts) over the same zone files: fromutc a second
# before, at and after each transition; utcoffset, dst and tzname at the
# local times either side of it, fold 0 and 1; and the TZ string's years
# after the last transition. ZI_SHARD=i/n takes every n-th zone from the i-th.
import os
import zoneinfo
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo, _common, _tzpath

shard, of = (int(x) for x in os.environ.get("ZI_SHARD", "0/1").split("/"))
EPOCH = datetime(1970, 1, 1)
LO, HI = -62135596800 + 2 * 86400, 253402300799 - 2 * 86400


def fmt(t):
    return "%s/%s/%s" % (int(t[0].total_seconds()) if t[0] is not None else None,
                         int(t[1].total_seconds()) if t[1] is not None else None, t[2])


def at(z, d):
    out = []
    for fold in (0, 1):
        x = d.replace(fold=fold)
        out.append(fmt((z.utcoffset(x), z.dst(x), z.tzname(x))))
    return ",".join(out)


def utc(z, s):
    r = z.fromutc((EPOCH + timedelta(seconds=s)).replace(tzinfo=z))
    return "%s%s" % (r.replace(tzinfo=None).isoformat(), "*" if r.fold else "")


zones = sorted(zoneinfo.available_timezones())[shard::of]
for key in zones:
    path = _tzpath.find_tzfile(key)
    if path is not None:
        with open(path, "rb") as f:
            data = f.read()
    else:
        data = _common.load_tzdata(key).read()
    import io
    trans_idx, trans_utc, utcoff, isdst, abbr, tz_str = _common.load_data(io.BytesIO(data))
    z = ZoneInfo.no_cache(key)
    lines = []
    for i, t in enumerate(trans_utc):
        if not LO < t < HI:
            continue
        before = utcoff[trans_idx[i - 1]] if i else None
        after = utcoff[trans_idx[i]]
        row = [str(t), utc(z, t - 1), utc(z, t), utc(z, t + 1)]
        for off in sorted({before, after} - {None}):
            w = EPOCH + timedelta(seconds=t + off)
            row.append(at(z, w - timedelta(seconds=1)))
            row.append(at(z, w))
        lines.append(" ".join(row))
    last = trans_utc[-1] if trans_utc else 0
    y0 = max(1971, min(9998, (EPOCH + timedelta(seconds=min(max(last, LO), HI))).year + 1))
    for y in list(range(y0, min(y0 + 30, 9999))) + [2100, 2500, 5000, 9998]:
        row = ["y%d" % y]
        for m in (1, 3, 4, 6, 9, 10, 11, 12):
            d = datetime(y, m, 15, 12)
            row.append(at(z, d))
            row.append(utc(z, int((d - EPOCH).total_seconds())))
        lines.append(" ".join(row))
    print(key, len(lines), "|", fmt((z.utcoffset(None), z.dst(None), z.tzname(None))))
    for line in lines:
        print(" ", line)
