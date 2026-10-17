# time and datetime's local times on a host zone (lib/_pytime.py's
# docstring), run under UTC and zones with daylight saving by
# test/stdlib-time-datetime.test.ts and compared with CPython's output there:
# tm_isdst, tm_zone, tzname, %Z, mktime's skipped and repeated hours, pickling
# and comparing local struct_times. Only tzset and strptime refuse.
import copy
import datetime as D
import pickle
import time


def show(label, f):
    try:
        print(label, "->", f())
    except Exception as e:
        print(label, "raises", type(e).__name__, str(e)[:90])


lt = time.localtime(0)
show("repr", lambda: repr(lt))
show("fields", lambda: (tuple(lt)[:8], lt.tm_gmtoff))
show("unpacked, indexed", lambda: (lambda y, m, d, H, M, S, wd, yd, dst: (y, H, repr(dst)))(*lt))
show("str of isdst", lambda: str(lt.tm_isdst))
for name, f in [("isdst == 0", lambda: lt.tm_isdst == 0), ("bool", lambda: bool(lt.tm_isdst)), ("int", lambda: int(lt.tm_isdst)),
                ("hash", lambda: hash(lt.tm_isdst)), ("format", lambda: "%d" % lt.tm_isdst), ("f-string", lambda: f"{lt.tm_isdst}"),
                ("arithmetic", lambda: lt.tm_isdst + 1), ("struct == struct", lambda: lt == lt), ("struct hash", lambda: hash(lt) == hash(tuple(lt))),
                ("struct <", lambda: lt < lt), ("pickle", lambda: pickle.dumps(lt)), ("copy", lambda: copy.copy(lt)),
                ("tm_zone", lambda: lt.tm_zone), ("tzname", lambda: time.tzname), ("hasattr tzname", lambda: hasattr(time, "tzname")),
                ("strftime %Z", lambda: time.strftime("%Z", lt)), ("strftime %Z now", lambda: time.strftime("%Z")),
                ("strftime %Z tuple", lambda: time.strftime("%Z", (2020, 1, 1, 0, 0, 0, 0, 1, 0))), ("strftime %s", lambda: time.strftime("%s", lt)),
                ("mktime struct", lambda: time.mktime(lt)), ("mktime isdst 0", lambda: time.mktime((2020, 1, 1, 0, 0, 0, 0, 1, 0))),
                ("mktime isdst 1", lambda: time.mktime((2020, 7, 1, 0, 0, 0, 0, 1, 1))),
                ("mktime skipped", lambda: time.mktime((2020, 3, 29, 2, 30, 0, 0, 1, -1))),
                ("mktime repeated", lambda: time.mktime((2020, 10, 25, 2, 30, 0, 0, 1, -1))),
                ("mktime plain", lambda: time.mktime((2020, 1, 1, 12, 0, 0, 0, 1, -1))),
                ("strftime %Y %z", lambda: time.strftime("%Y %z", lt)), ("asctime", lambda: time.asctime(lt)),
                ("tzset", lambda: time.tzset()), ("strptime", lambda: time.strptime("2020", "%Y")),
                ("datetime strptime", lambda: D.datetime.strptime("2020", "%Y")),
                ("naive astimezone", lambda: D.datetime(2020, 7, 1, 12).astimezone(D.timezone.utc)),
                ("astimezone no argument", lambda: D.datetime(2020, 7, 1, 12, tzinfo=D.timezone.utc).astimezone()),
                ("far future", lambda: time.localtime(10**14)),
                ("datetime fromtimestamp", lambda: D.datetime.fromtimestamp(0)),
                ("timezone altzone daylight", lambda: (time.timezone, time.altzone, time.daylight))]:
    show(name, f)
ns = {}
exec("from time import *", ns)
print("import-star has tzname:", "tzname" in ns, "dir has tzname:", "tzname" in dir(time))
print("gmtime zone:", time.gmtime(0).tm_zone, time.gmtime(0).tm_isdst)

# (a skipped hour between times of the same isdst, asked for that isdst, in
# Lord_Howe 1981: glibc's mktime fails; %Z of a zone-less tuple then refuses
# in Sagebrush until a local time sets glibc's tzname again)
if time.tzname == ("+1030", "+11"):
    show("mktime of a same-isdst skipped hour", lambda: time.mktime((1981, 3, 1, 0, 15, 0, 0, 1, 0)))
    time.localtime(0)
    show("%Z after localtime", lambda: time.strftime("%Z", (2020, 1, 1, 0, 0, 0, 0, 1, 0)))
