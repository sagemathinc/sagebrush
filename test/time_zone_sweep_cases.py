# The host zone's transitions, found through time.localtime itself (a
# weekly scan from 1890 to 2045, then bisection), and at each: localtime one
# second before and at it; mktime of wall clocks from 2 h before to 2 h after,
# every 30 minutes, with isdst -1, 0 and 1 in a fixed shuffled order (glibc's
# mktime keeps state between calls); and after each call, strftime's %Z of a
# tuple with no zone (glibc's tzname, also state; not after a failed mktime,
# where Sagebrush refuses it: a localtime sets it again). Compared with CPython under
# several TZ values by test/stdlib-time-datetime.test.ts.
import time

WEEK = 7 * 86400
START = -2524521600  # 1890-01-01
END = 2398291200     # 2046-01-01


def key(t):
    s = time.localtime(t)
    return s.tm_gmtoff, s.tm_isdst, s.tm_zone


def zones():
    return time.strftime("%Z", (2020, 1, 1, 0, 0, 0, 0, 1, 0)), time.strftime("%Z", (2020, 1, 1, 0, 0, 0, 0, 1, 1))


trans = []
t, k = START, key(START)
while t < END:
    t2 = t + WEEK
    k2 = key(t2)
    if k2 != k:
        lo, hi = t, t2
        while hi - lo > 1:
            m = (lo + hi) // 2
            if key(m) == k:
                lo = m
            else:
                hi = m
        trans.append(hi)
        t, k = hi, key(hi)
        continue
    t, k = t2, k2
print("transitions", len(trans))
order = 0
for T in trans:
    a, b = time.localtime(T - 1), time.localtime(T)
    print(T, tuple(a), a.tm_zone, a.tm_gmtoff, tuple(b), b.tm_zone, b.tm_gmtoff, zones())
    base = time.localtime(T - 2 * 3600)
    for step in range(9):
        for j in range(3):
            order += 1
            dst = (-1, 0, 1)[(order * 7 + j) % 3]
            tup = (base.tm_year, base.tm_mon, base.tm_mday, base.tm_hour, base.tm_min + 30 * step, base.tm_sec, 0, 1, dst)
            try:
                r = time.mktime(tup)
            except OverflowError as e:
                # (glibc's tzname after a failed mktime is not matched in
                # Sagebrush: a localtime sets it again)
                print(" ", tup[4], dst, "OverflowError")
                time.localtime(T)
                continue
            print(" ", tup[4], dst, r, zones())
print("tzname", time.tzname, time.timezone, time.altzone, time.daylight)
