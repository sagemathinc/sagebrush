# datetime (lib/datetime.py and lib/_pydatetime.py, CPython 3.14's,
# unchanged), compared with CPython 3.14 under TZ=UTC by
# test/stdlib-time-datetime.test.ts. Nothing here reads the clock.
import datetime as D
import zlib


def show(label, f):
    try:
        print(label, "->", repr(f()))
    except Exception as e:
        print(label, "raises", type(e).__name__, e)


td = D.timedelta
show("timedelta", lambda: (td(1, 2, 3, 4, 5, 6, 7), td(days=-1, seconds=1), td(microseconds=-1), td(weeks=1.5), td(hours=0.000001)))
show("timedelta math", lambda: (td(1) * 2.5, td(1) / 3, td(1) // td(hours=5), td(1) % td(hours=5), divmod(td(1), td(hours=7)), -td(3), abs(td(-3)), td(1).total_seconds()))
show("timedelta str", lambda: [str(x) for x in (td(0), td(-1, 1), td(1, 3600, 5), td(microseconds=-1), td(999999999))])
show("timedelta limits", lambda: (td.min, td.max, td.resolution))
show("timedelta overflow", lambda: td(1000000000))
show("timedelta bad", lambda: td("1"))
show("timedelta round half even", lambda: [td(microseconds=x) for x in (0.5, 1.5, 2.5, -0.5, -1.5)])

dt = D.datetime(2020, 2, 29, 13, 45, 30, 123456)
show("datetime basics", lambda: (dt, str(dt), dt.isoformat(), dt.isoformat(" ", "minutes"), dt.date(), dt.time(), dt.weekday(),
                                  dt.isoweekday(), dt.isocalendar(), dt.toordinal(), dt.timetuple(), dt.utctimetuple(), dt.ctime()))
for spec in ["%Y-%m-%d %H:%M:%S.%f", "%a %A %b %B %c %d %j %U %W %w %x %X %y %G %V %u", "%z|%Z|%:z", "%%f %f %%", "%Y", "%4Y %-d %_H",
             "%e %k %l %p %P %s", "%"]:
    show("strftime %r" % spec, lambda: dt.strftime(spec))
for y in (1, 99, 999, 1000, 9999):
    show("strftime %%Y year %d" % y, lambda: D.date(y, 1, 1).strftime("%Y|%G|%C|%y"))
utc, plus = D.timezone.utc, D.timezone(D.timedelta(hours=5, minutes=30), "IST")
aware = D.datetime(2021, 3, 4, 5, 6, 7, 8, tzinfo=plus)
show("aware", lambda: (aware, aware.isoformat(), aware.utcoffset(), aware.tzname(), aware.dst(), aware.strftime("%z %Z %:z"), aware.timestamp(),
                       aware.astimezone(utc), aware.astimezone(D.timezone(-D.timedelta(hours=8))), aware.utctimetuple()))
show("timezone", lambda: (utc, plus, D.timezone(D.timedelta(0)), D.timezone.min, D.timezone.max, str(plus), repr(D.timezone(-D.timedelta(seconds=1)))))
show("timezone bad", lambda: D.timezone(D.timedelta(hours=24)))
show("fromtimestamp utc", lambda: [D.datetime.fromtimestamp(t, utc) for t in (0, 1e9, -1.5, 1234567890.1234567, 2**40)])
show("utcfromtimestamp-like", lambda: [D.datetime.fromtimestamp(t, utc).replace(tzinfo=None) for t in (0, 86399.9999995)])
show("fromtimestamp naive (local, UTC host)", lambda: [D.datetime.fromtimestamp(t) for t in (0, 1e9, -86400 * 365 * 50)])
show("timestamp naive (local, UTC host)", lambda: [D.datetime(2000, 1, 1).timestamp(), D.datetime(1950, 6, 1, 12).timestamp()])
show("date.fromtimestamp", lambda: D.date.fromtimestamp(1e9))
show("fromtimestamp out of range", lambda: D.datetime.fromtimestamp(1e20, utc))
show("fromtimestamp nan", lambda: D.datetime.fromtimestamp(float("nan")))
for s in ["2020-02-29", "2020-02-29T13:45:30.123456+05:30", "2020-W09-6", "2020-060", "20200229T134530Z", "2020-02-30", "2020-13-01", "1", "2020-02-29T24:00:00"]:
    show("fromisoformat %r" % s, lambda: D.datetime.fromisoformat(s))
show("time.fromisoformat", lambda: [D.time.fromisoformat(s) for s in ("13:45", "13:45:30.5", "T13:45:30+01:00", "134530")])
show("date math", lambda: (D.date(2020, 3, 1) - D.date(2020, 2, 1), D.date(2020, 1, 31) + td(days=30), D.date.fromordinal(737850),
                           D.date.fromisocalendar(2020, 53, 5), D.date(2020, 1, 1).replace(month=2), D.date.min, D.date.max))
show("date bad", lambda: D.date(2020, 2, 30))
show("date overflow", lambda: D.date.max + td(1))
show("combine/replace", lambda: (D.datetime.combine(D.date(2000, 1, 1), D.time(1, 2, tzinfo=utc)), dt.replace(year=2021, day=28, fold=1).fold))
show("comparisons", lambda: (dt < dt + td(1), dt == dt.replace(), aware == aware.astimezone(utc), D.date(2020, 1, 1) < D.date(2020, 1, 2)))
show("naive vs aware", lambda: dt < aware)
show("hash equal across zones", lambda: hash(aware) == hash(aware.astimezone(utc)))
show("time", lambda: (D.time(23, 59, 59, 999999), D.time(1, 2, 3, 4, tzinfo=plus).isoformat(), D.time(fold=1).fold, str(D.time(12))))
show("min/max", lambda: (D.datetime.min, D.datetime.max, D.MINYEAR, D.MAXYEAR, D.UTC is D.timezone.utc))
acc = 0
for i in range(-400, 400):
    d = D.date(2000, 1, 1) + td(days=i * 37)
    acc = zlib.crc32(("%s %s %s %s" % (d, d.isocalendar(), d.strftime("%a %j %U %W %G %V"), d.toordinal())).encode(), acc)
print("calendar digest", acc)
