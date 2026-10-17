# time and datetime on a host zone, compared with CPython 3.14 under the
# same TZ by test/stdlib-time-datetime.test.ts: what is exact everywhere
# (the offsets, so localtime()'s fields and tm_gmtoff; timezone, altzone and
# daylight; mktime with isdst -1 away from a transition; datetime's now,
# fromtimestamp and timestamp), printed the same on both sides. tm_isdst,
# tm_zone and tzname are left out: on a non-UTC host here they refuse
# (test/time_refusals_cases.py), on CPython they are glibc's.
import time
import datetime as D

instants = [0, -1, 1e9, 1584237600, 1604210400, 1604214000, 1616288400, 1636851600, -2208988800, -5e9,
            2**31, 4102444800, 7e9, 2e10, 1711846800, 1729990800]
for t in instants:
    lt = time.localtime(t)
    print("localtime", t, tuple(lt)[:8], lt.tm_gmtoff)
    print("ctime", t, time.ctime(t), time.strftime("%Y-%m-%d %H:%M:%S %z", time.localtime(t)))
    print("datetime.fromtimestamp", t, D.datetime.fromtimestamp(t))
    print("timestamp round trip", t, D.datetime.fromtimestamp(t).timestamp())

# (CPython's init_timezone: localtime at about now, rounded down to a
# 365.25-day "year", and half such a year later; the probe instants are
# printed so that a result is seen to depend on now)
YEAR = (365 * 24 + 6) * 3600
now = int(time.time())
probe = (now // YEAR) * YEAR
print("init_timezone probes", time.localtime(probe).tm_gmtoff, time.localtime(probe + YEAR // 2).tm_gmtoff)
print("timezone altzone daylight", time.timezone, time.altzone, time.daylight)

# mktime away from any transition, isdst -1
for fields in [(2020, 1, 15, 12, 0, 0), (2020, 7, 15, 12, 0, 0), (1990, 6, 1, 0, 30, 0), (1950, 12, 31, 23, 59, 59), (2040, 3, 3, 3, 3, 3)]:
    print("mktime", fields, time.mktime(fields + (0, 0, -1)))
print("naive timestamps", [D.datetime(*f).timestamp() for f in [(2020, 1, 15, 12), (2020, 7, 15, 12), (1900, 1, 1)]])
print("astimezone, aware to a zone", D.datetime(2020, 7, 1, 12, tzinfo=D.timezone.utc).astimezone(D.timezone(D.timedelta(hours=-3))))
