# Local times in far years, where a TZ rule (or a zone file's footer) gives
# daylight saving: glibc's yearly changes as the rules give them from year
# -5,000,000 to 5,000,000 (compared to 5,880,000, where glibc's day count
# overflows); past that Sagebrush refuses ("beyond" lines), as
# test/stdlib-time-datetime.test.ts checks (astra's CORR-09B-3).
import time


def days(y, m, d):
    y -= m <= 2
    era = y // 400
    yoe = y - era * 400
    doy = (153 * (m + (-3 if m > 2 else 9)) + 2) // 5 + d - 1
    return era * 146097 + yoe * 365 + yoe // 4 - yoe // 100 + doy - 719468


def show(label, y):
    for m in (1, 7):
        t = days(y, m, 15) * 86400 + 43200
        try:
            s = time.localtime(t)
            print(label, y, m, tuple(s)[:8], s.tm_gmtoff, s.tm_zone)
        except Exception as e:
            print(label, y, m, "raises", type(e).__name__, e)


for y in (-5000000, -1000000, -10000, 1, 1969, 2400, 10000, 100000, 1000000, 4999999, 5000000):
    show("year", y)
show("beyond", 10000000)
show("beyond", -6000000)
