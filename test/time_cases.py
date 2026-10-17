# time (lib/_pytime.py over the _time builtin), compared with CPython 3.14 under
# TZ=UTC by test/stdlib-time-datetime.test.ts: mktime, gmtime and localtime
# at glibc's edges, strftime's %Z and %z with tuples and its unknown
# directives, sleep's checks, struct_time's constructor, attributes, pickling
# and __replace__, asctime and ctime. Nothing here reads the clock.
import time, sys
def show(label, f):
    try: print(label, "->", repr(f()))
    except BaseException as e: print(label, "raises", type(e).__name__, e)
print(time.tzname, time.timezone, time.altzone, time.daylight)
for isdst in (-1, 0, 1):
    show("mktime 2020-01-01 isdst=%d" % isdst, lambda: time.mktime((2020, 1, 1, 0, 0, 0, 0, 0, isdst)))
    show("mktime 2020-07-01 isdst=%d" % isdst, lambda: time.mktime((2020, 7, 1, 12, 0, 0, 0, 0, isdst)))
    show("mktime gap 2020-03-08 02:30 isdst=%d" % isdst, lambda: time.mktime((2020, 3, 8, 2, 30, 0, 0, 0, isdst)))
    show("mktime fold 2020-11-01 01:30 isdst=%d" % isdst, lambda: time.mktime((2020, 11, 1, 1, 30, 0, 0, 0, isdst)))
show("mktime normalize", lambda: time.mktime((2020, 13, 32, 25, 61, 61, 9, 400, 0)))
show("mktime negative", lambda: time.mktime((2020, 0, 0, -1, -1, -1, 0, 0, 0)))
show("mktime year 1", lambda: time.mktime((1, 1, 1, 0, 0, 0, 0, 0, 0)))
show("mktime year -5000", lambda: time.mktime((-5000, 1, 1, 0, 0, 0, 0, 0, 0)))
show("mktime year 3e9", lambda: time.mktime((3000000000, 1, 1, 0, 0, 0, 0, 0, 0)))
show("mktime 8", lambda: time.mktime((2020, 1, 1, 0, 0, 0, 0, 0)))
show("mktime str", lambda: time.mktime("abc"))
show("mktime float field", lambda: time.mktime((2020.0, 1, 1, 0, 0, 0, 0, 0, 0)))
for s in [0, -1, 1.5, -1.5, 2**62, 2**63, -2**63, 2**64, 1e20, float("nan"), float("inf"), "a", True, 67767976233532799, 67767976233532800, -67768040609740800, -67768040609740801]:
    show("gmtime %r" % (s,), lambda: tuple(time.gmtime(s)))
    show("localtime %r" % (s,), lambda: tuple(time.localtime(s)))
for t in [(2020,1,2,3,4,5,3,2,0), (2020,1,2,3,4,5,3,2,1), (2020,1,2,3,4,5,3,2,-1)]:
    show("strftime %%Z %%z tuple %r" % (t,), lambda: time.strftime("%Z|%z", t))
show("strftime %Z %z struct", lambda: time.strftime("%Z|%z", time.localtime(0)))
show("strftime gmtime %Z %z", lambda: time.strftime("%Z|%z", time.gmtime(0)))
for f in ["%Q", "%", "abc%", "%E", "%Ez", "%Oz", "%EY", "%OH", "%5", "%-", "%_", "%#", "%^", "%+", "%v", "%10Q", "%-10d", "%:z", "%::z", "%N", "%5%"]:
    show("strftime %r" % f, lambda: time.strftime(f, (2020,1,2,3,4,5,3,2,0)))
for s in ["a", -1, float("nan"), float("inf"), None, 1e-9, 0]:
    show("sleep %r" % (s,), lambda: time.sleep(s))
show("struct_time 3", lambda: time.struct_time((1,2,3)))
show("struct_time 12", lambda: time.struct_time(range(12)))
show("struct_time 11", lambda: (lambda t: (t, t.tm_zone, t.tm_gmtoff))(time.struct_time(range(11))))
show("struct_time dict", lambda: (lambda t: (t.tm_zone, t.tm_gmtoff))(time.struct_time(range(9), {"tm_zone": "Z", "tm_gmtoff": 5, "other": 1})))
show("struct_time bad dict", lambda: time.struct_time(range(9), 5))
show("struct_time int", lambda: time.struct_time(5))
show("struct_time kw", lambda: time.struct_time(sequence=range(9)))
show("struct_time attrs", lambda: (time.struct_time.n_fields, time.struct_time.n_sequence_fields, time.struct_time.n_unnamed_fields, time.struct_time.__match_args__))
show("struct_time reduce", lambda: time.gmtime(0).__reduce__())
show("struct_time setattr", lambda: setattr(time.gmtime(0), "tm_year", 5))
show("struct_time replace", lambda: time.gmtime(0).__replace__(tm_year=2000))
show("asctime", lambda: time.asctime((2020,1,2,3,4,5,3,2,0)))
show("asctime big year", lambda: time.asctime((12345,1,2,3,4,5,3,2,0)))
show("asctime month 0", lambda: time.asctime((2020,0,0,3,4,5,3,0,0)))
show("asctime month 13", lambda: time.asctime((2020,13,2,3,4,5,3,2,0)))
show("ctime 0", lambda: time.ctime(0))
show("subclass", lambda: type("X", (time.struct_time,), {}))
