# zoneinfo as CPython 3.14 gives it (its C _zoneinfo), compared line by line
# (test/stdlib-zoneinfo.test.ts): ZoneInfo's construction, caches, keys,
# pickling, copying, reprs and errors; datetime arithmetic through it; the
# module's functions; the pure-Python zoneinfo._zoneinfo.ZoneInfo too. The
# zones used are in every tzdata, the host's and the pinned one.
import copy
import io
import os
import pickle
import warnings
import zoneinfo
from datetime import date, datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo


def name(e):
    # (the module for zoneinfo's own classes only)
    t = type(e)
    return t.__module__ + "." + t.__qualname__ if t.__module__.startswith("zoneinfo") else t.__qualname__


def show(label, f):
    try:
        r = f()
    except BaseException as e:
        print(label, "!!", name(e), str(e)[:300], "| context:", name(e.__context__) if e.__context__ is not None else None)
    else:
        print(label, "->", repr(r)[:300])


def zinfo(z, *dts):
    return [(z.utcoffset(d), z.dst(d), z.tzname(d)) for d in dts]


SUMMER = datetime(2026, 7, 1, 12)
WINTER = datetime(2026, 1, 15, 3)

# ------------------------------------------------------------------ keys
for key in ["UTC", "America/New_York", "Europe/London", "Australia/Lord_Howe", "Etc/GMT+5", "Etc/GMT-14",
            "America/Argentina/Buenos_Aires", "Pacific/Chatham", "Africa/Casablanca", "Asia/Kolkata",
            "America/St_Johns", "Europe/Dublin", "Antarctica/Troll", "America/Sao_Paulo",
            "", ".", "..", "/UTC", "UTC/", "America/../UTC", "America//New_York", "./UTC", "America/./New_York",
            "Nonexistent/Zone", "America", "America/", "Amrica/New_York", "america/new_york",
            "UTC\ud800", "a\x00b", "../zoneinfo/UTC", "x/../../UTC", 5, b"UTC", None, 1.5,
            # (names a tzdata package's files and packages could take)
            "zone.tab", "tzdata.zi", "iso3166.tab", "leapseconds", "zones", "__init__.py", "America/__init__.py",
            "__init__/UTC", "America/__init__/New_York", "__init__", "__pycache__", "America.Argentina/Buenos_Aires",
            "Etc.x/UTC", "a..b/UTC", "America./New_York", ".America/New_York", "America/Argentina", "UTC/x",
            "America\x00/New_York", "posixrules", "localtime", "Factory", "right/UTC", "posix/UTC", "Etc/UTC\ud800/x"]:
    show("ZoneInfo(%r)" % (key,), lambda: (lambda z: (str(z), repr(z), zinfo(z, SUMMER, WINTER)))(ZoneInfo(key)))
    show("no_cache(%r)" % (key,), lambda: repr(ZoneInfo.no_cache(key)))
show("ZoneInfo(key=)", lambda: repr(ZoneInfo(key="UTC")))
show("ZoneInfo()", lambda: ZoneInfo())
show("ZoneInfo(2 args)", lambda: ZoneInfo("UTC", "x"))
show("no_cache(key=)", lambda: repr(ZoneInfo.no_cache(key="UTC")))

# ------------------------------------------------------------------ caches
ZoneInfo.clear_cache()
a = ZoneInfo("America/New_York")
print("same", a is ZoneInfo("America/New_York"), a is ZoneInfo.no_cache("America/New_York"),
      ZoneInfo.no_cache("America/New_York") is ZoneInfo.no_cache("America/New_York"))
print("eq", a == ZoneInfo.no_cache("America/New_York"), hash(a) == hash(a))
ZoneInfo.clear_cache(only_keys=["America/New_York"])
b = ZoneInfo("America/New_York")
print("after clear only_keys", a is b)
ZoneInfo.clear_cache()
print("after clear", b is ZoneInfo("America/New_York"))
keep = [ZoneInfo(k) for k in ["UTC", "Europe/London", "Asia/Tokyo", "Europe/Paris", "Asia/Kolkata",
                               "America/Chicago", "America/Denver", "Australia/Sydney", "Europe/Berlin"]]
print("strong cache, held", all(ZoneInfo(z.key) is z for z in keep))
show("clear_cache(only_keys=5)", lambda: ZoneInfo.clear_cache(only_keys=5))
show("clear_cache(['UTC'])", lambda: ZoneInfo.clear_cache(["UTC"]))
show("clear_cache(only_keys=('UTC', 'nope'))", lambda: ZoneInfo.clear_cache(only_keys=("UTC", "nope")))
show("clear_cache(only_keys=())", lambda: ZoneInfo.clear_cache(only_keys=()))


class Key(str):
    pass


ZoneInfo.clear_cache()
ZoneInfo("UTC")
z = ZoneInfo(Key("Europe/London"))
print("str subclass key", type(z.key).__name__, repr(z))


# ------------------------------------------------------------------ the object
z = ZoneInfo("America/New_York")
show("key", lambda: z.key)
show("set key", lambda: setattr(z, "key", "x"))
show("del key", lambda: delattr(z, "key"))
show("__module__", lambda: (ZoneInfo.__module__, ZoneInfo.__name__, ZoneInfo.__qualname__, [c.__name__ for c in ZoneInfo.__mro__]))
show("__doc__", lambda: ZoneInfo.__doc__)
for m in ["utcoffset", "dst", "tzname", "fromutc", "__reduce__", "from_file", "no_cache", "clear_cache", "_unpickle", "__init_subclass__"]:
    show("doc " + m, lambda: getattr(ZoneInfo, m).__doc__)
show("weakref", lambda: __import__("weakref").ref(z)() is z)
show("utcoffset(None)", lambda: [ZoneInfo(k).utcoffset(None) for k in ["UTC", "Etc/GMT+5", "America/New_York"]])
show("dst(None)", lambda: [ZoneInfo(k).dst(None) for k in ["UTC", "Etc/GMT+5", "America/New_York"]])
show("tzname(None)", lambda: [ZoneInfo(k).tzname(None) for k in ["UTC", "Etc/GMT+5", "America/New_York"]])
show("time tz", lambda: [time(12, tzinfo=ZoneInfo(k)).utcoffset() for k in ["UTC", "America/New_York"]])
show("utcoffset(5)", lambda: z.utcoffset(5))
show("utcoffset()", lambda: z.utcoffset())
show("utcoffset(dt=)", lambda: z.utcoffset(dt=SUMMER))
show("fromutc(5)", lambda: z.fromutc(5))
show("fromutc(naive)", lambda: z.fromutc(SUMMER))
show("fromutc(other)", lambda: z.fromutc(SUMMER.replace(tzinfo=timezone.utc)))
show("fromutc(self)", lambda: z.fromutc(SUMMER.replace(tzinfo=z)))
show("fromutc(object=)", lambda: z.fromutc(object=SUMMER.replace(tzinfo=z)))


class DT(datetime):
    pass


show("subclass dt", lambda: (z.utcoffset(DT(2026, 7, 1)), repr(z.fromutc(DT(2026, 11, 1, 5, 30, tzinfo=z))),
                             repr(z.fromutc(DT(2026, 11, 1, 6, 30, tzinfo=z)))))

# ------------------------------------------------------------------ pickling and copying
for proto in range(6):
    show("pickle %d" % proto, lambda: pickle.dumps(ZoneInfo("Europe/London"), proto))
    show("pickle no_cache %d" % proto, lambda: pickle.dumps(ZoneInfo.no_cache("Europe/London"), proto))
show("unpickle same", lambda: pickle.loads(pickle.dumps(ZoneInfo("Europe/London"))) is ZoneInfo("Europe/London"))
show("unpickle no_cache", lambda: (lambda u: (repr(u), u is ZoneInfo("Europe/London")))(pickle.loads(pickle.dumps(ZoneInfo.no_cache("Europe/London")))))
show("reduce", lambda: (lambda r: (repr(r[0]).startswith("<built-in method _unpickle of type object at 0x"), r[0]("UTC", 1) is ZoneInfo("UTC"), r[1]))(ZoneInfo("UTC").__reduce__()))
show("reduce no_cache", lambda: ZoneInfo.no_cache("UTC").__reduce__()[1])
show("_unpickle", lambda: [repr(ZoneInfo._unpickle("UTC", f)) for f in (0, 1, 256, 257, True)])
show("_unpickle bad", lambda: ZoneInfo._unpickle("UTC", "x"))
show("_unpickle kw", lambda: ZoneInfo._unpickle("UTC", from_cache=1))
show("copy", lambda: (copy.copy(z) is z, copy.deepcopy(z) is z))
with open(os.devnull, "rb") as _f:
    pass
data = None
for d in zoneinfo.TZPATH:
    try:
        with open(os.path.join(d, "Europe/London"), "rb") as f:
            data = f.read()
        break
    except OSError:
        pass
if data is None:
    # (where TZPATH is empty: the tzdata package's)
    data = zoneinfo._common.load_tzdata("Europe/London").read()
show("from_file", lambda: (lambda f: (repr(f).startswith("ZoneInfo.from_file(<_io.BytesIO object"), str(f).startswith("ZoneInfo.from_file("), f.key, zinfo(f, SUMMER, WINTER)))(ZoneInfo.from_file(io.BytesIO(data))) if data else "no data")
show("from_file key", lambda: (lambda f: (repr(f), str(f), f.key))(ZoneInfo.from_file(io.BytesIO(data), key="London")) if data else "no data")
show("from_file key=5 str", lambda: str(ZoneInfo.from_file(io.BytesIO(data), key=5)) if data else "no data")
show("from_file file_obj=", lambda: ZoneInfo.from_file(file_obj=io.BytesIO(data)) if data else "no data")
show("pickle from_file", lambda: pickle.dumps(ZoneInfo.from_file(io.BytesIO(data), key="x")) if data else "no data")
show("copy from_file", lambda: copy.copy(ZoneInfo.from_file(io.BytesIO(data))) if data else "no data")
show("from_file not cached", lambda: ZoneInfo.from_file(io.BytesIO(data), key="UTC") is ZoneInfo("UTC") if data else "no data")


class Repr:
    def __init__(self, b):
        self.b = io.BytesIO(b)

    def read(self, n=-1):
        return self.b.read(n)

    def seek(self, *a):
        return self.b.seek(*a)

    def readline(self, *a):
        return self.b.readline(*a)

    def __repr__(self):
        return "<Repr file>"


show("from_file custom", lambda: repr(ZoneInfo.from_file(Repr(data))) if data else "no data")
show("from_file read fails", lambda: ZoneInfo.from_file(5))


# (astra's CORR-1D0-1: a copy of a copy; _unpickle's uncached result reduces too)
c = copy.copy(ZoneInfo.no_cache("UTC"))
show("copy of no_cache", lambda: (repr(c), c.__reduce__()[1], repr(copy.copy(c)), copy.copy(c) is c))
show("copy of cached", lambda: copy.copy(copy.copy(ZoneInfo("UTC"))) is ZoneInfo("UTC"))
show("_unpickle uncached reduces", lambda: ZoneInfo._unpickle("UTC", 0).__reduce__()[1])
show("_unpickle cached reduces", lambda: ZoneInfo._unpickle("UTC", 1).__reduce__()[1])

# ------------------------------------------------------------------ subclasses
class Z2(ZoneInfo):
    pass


class Z3(ZoneInfo, extra=1):
    pass


show("subclass", lambda: (repr(Z2("UTC")), Z2("UTC") is Z2("UTC"), Z2("UTC") is ZoneInfo("UTC"), type(Z2._weak_cache).__name__,
                          type(Z2.no_cache("UTC")).__name__, repr(Z3("UTC"))))
show("subclass pickle", lambda: pickle.loads(pickle.dumps(Z2("UTC"))) is Z2("UTC"))
show("subclass from_file", lambda: repr(Z2.from_file(io.BytesIO(data), key="k")) if data else "no data")
Z2.clear_cache()
show("subclass after clear", lambda: Z2("UTC") is Z2("UTC"))


# (astra's CORR-1D0-2: a subclass's own weak cache, asked with get(key))
class OneArgCache(dict):
    calls = []

    def get(self, key):
        OneArgCache.calls.append(("get", key))
        return dict.get(self, key)

    def setdefault(self, key, value):
        OneArgCache.calls.append(("setdefault", key))
        return dict.setdefault(self, key, value)


class Z5(ZoneInfo):
    pass


Z5._weak_cache = OneArgCache()
show("subclass one-argument cache", lambda: (repr(Z5("UTC")), Z5("UTC") is Z5("UTC"), OneArgCache.calls))


class WrongCache(dict):
    def get(self, key):
        return ZoneInfo("UTC")


class Z6(ZoneInfo):
    pass


Z6._weak_cache = WrongCache()
show("subclass cache with another class's zone", lambda: Z6("UTC"))


class Z4(ZoneInfo):
    def __new__(cls, key):
        return super().__new__(cls, key)


show("subclass __new__", lambda: repr(Z4("Europe/London")))

# ------------------------------------------------------------------ datetimes through it
ny = ZoneInfo("America/New_York")
lh = ZoneInfo("Australia/Lord_Howe")
for d in [datetime(2026, 3, 8, 1, 59, 59), datetime(2026, 3, 8, 2, 0), datetime(2026, 3, 8, 2, 30), datetime(2026, 3, 8, 3, 0),
          datetime(2026, 11, 1, 0, 59, 59), datetime(2026, 11, 1, 1, 0), datetime(2026, 11, 1, 1, 30), datetime(2026, 11, 1, 2, 0),
          datetime(1883, 11, 18, 12, 3, 57), datetime(1, 1, 1), datetime(9999, 12, 31, 23, 59, 59), datetime(2100, 7, 1),
          datetime(1970, 1, 1)]:
    for fold in (0, 1):
        x = d.replace(tzinfo=ny, fold=fold)
        show("NY %s fold=%d" % (d, fold), lambda: (x.utcoffset(), x.dst(), x.tzname(), x.timetuple().tm_isdst))
for ts in [1772953199, 1772953200, 1793512799, 1793512800, 1793516399, 1793516400, -2717650800, -2717650801, 0, 253402300799, -62135596800]:
    show("NY fromtimestamp %d" % ts, lambda: repr(datetime.fromtimestamp(ts, ny)))
    show("LH fromtimestamp %d" % ts, lambda: repr(datetime.fromtimestamp(ts, lh)))
for d in [datetime(2026, 4, 5, 1, 30), datetime(2026, 4, 5, 1, 45), datetime(2026, 10, 4, 2, 15), datetime(2026, 10, 4, 1, 59)]:
    for fold in (0, 1):
        x = d.replace(tzinfo=lh, fold=fold)
        show("LH %s fold=%d" % (d, fold), lambda: (x.utcoffset(), x.dst(), x.tzname()))
show("astimezone", lambda: [repr(datetime(2026, 11, 1, 5, 30, tzinfo=timezone.utc).astimezone(ny)), repr(datetime(2026, 11, 1, 6, 30, tzinfo=timezone.utc).astimezone(ny))])
show("arith", lambda: repr(datetime(2026, 3, 7, 12, tzinfo=ny) + timedelta(days=1)))
show("compare", lambda: datetime(2026, 11, 1, 1, 30, tzinfo=ny) == datetime(2026, 11, 1, 1, 30, fold=1, tzinfo=ny))

# ------------------------------------------------------------------ the module
show("__all__", lambda: zoneinfo.__all__)
show("dir", lambda: [n for n in dir(zoneinfo) if not n.startswith("__")])
show("TZPATH type", lambda: type(zoneinfo.TZPATH).__name__)
show("nope", lambda: zoneinfo.nope)
show("ZoneInfoNotFoundError", lambda: (zoneinfo.ZoneInfoNotFoundError.__module__, [c.__name__ for c in zoneinfo.ZoneInfoNotFoundError.__mro__], zoneinfo.ZoneInfoNotFoundError.__doc__))
show("InvalidTZPathWarning", lambda: (zoneinfo.InvalidTZPathWarning.__module__, [c.__name__ for c in zoneinfo.InvalidTZPathWarning.__mro__]))
show("not found str", lambda: str(zoneinfo.ZoneInfoNotFoundError("No time zone found with key x")))
old = zoneinfo.TZPATH
for arg in ["x", b"x", ["rel"], ["/abs", "rel", "also"], [1], [b"/x"], [], ("/a", "/b"), None]:
    show("reset_tzpath(%r)" % (arg,), lambda: (zoneinfo.reset_tzpath(arg) if arg is not None else zoneinfo.reset_tzpath(), zoneinfo.TZPATH))
zoneinfo.reset_tzpath(old)
for env in ["rel:/abs", "/a:/b", "", ":"]:
    os.environ["PYTHONTZPATH"] = env
    with warnings.catch_warnings(record=True) as w:
        warnings.simplefilter("always")
        zoneinfo.reset_tzpath()
    print("PYTHONTZPATH=%r" % env, zoneinfo.TZPATH, [(c.category.__name__, str(c.message)) for c in w])
del os.environ["PYTHONTZPATH"]
zoneinfo.reset_tzpath(old)
zoneinfo.reset_tzpath(["/nonexistent"])
show("empty TZPATH zone", lambda: repr(ZoneInfo.no_cache("Europe/London")))
zoneinfo.reset_tzpath(old)
show("available_timezones", lambda: (lambda s: (type(s).__name__, "UTC" in s, "America/New_York" in s, "posixrules" in s, "right/UTC" in s, "zone.tab" in s, "Etc/UTC" in s))(zoneinfo.available_timezones()))

# ------------------------------------------------------------------ the pure-Python one
from zoneinfo._zoneinfo import ZoneInfo as PZ

p = PZ("America/New_York")
show("pure", lambda: (repr(p), PZ.__module__, p is PZ("America/New_York"), p is ZoneInfo("America/New_York"), zinfo(p, SUMMER, WINTER)))
show("pure fromutc fold", lambda: [repr(p.fromutc(datetime(2026, 11, 1, h, 30, tzinfo=p))) for h in (4, 5, 6, 7)])
show("pure reduce from_file", lambda: PZ.from_file(io.BytesIO(data)).__reduce__() if data else "no data")

# ------------------------------------------------------------------ the C type's argument errors
d = datetime(2020, 1, 1)
u = ZoneInfo("UTC")
ARGS = {
    "new()": lambda: ZoneInfo(), "new(a,b)": lambda: ZoneInfo("UTC", "x"), "new(x=)": lambda: ZoneInfo(x=1),
    "new(key,key=)": lambda: ZoneInfo("UTC", key="UTC"), "new(key=,x=)": lambda: ZoneInfo(key="UTC", x=1),
    "no_cache()": lambda: ZoneInfo.no_cache(), "no_cache(a,b)": lambda: ZoneInfo.no_cache("a", "b"),
    "no_cache(x=)": lambda: ZoneInfo.no_cache(x=1), "no_cache(k,key=)": lambda: ZoneInfo.no_cache("UTC", key="UTC"),
    "clear(a)": lambda: ZoneInfo.clear_cache(1), "clear(a,b)": lambda: ZoneInfo.clear_cache(1, 2),
    "clear(x=)": lambda: ZoneInfo.clear_cache(x=1), "clear(only_keys=None)": lambda: ZoneInfo.clear_cache(only_keys=None),
    "utcoffset()": lambda: u.utcoffset(), "utcoffset(a,b)": lambda: u.utcoffset(d, d), "utcoffset(dt=)": lambda: u.utcoffset(dt=d),
    "utcoffset(d,x=)": lambda: u.utcoffset(d, x=1), "dst()": lambda: u.dst(), "tzname(a,b)": lambda: u.tzname(1, 2),
    "unbound utcoffset()": lambda: ZoneInfo.utcoffset(), "unbound utcoffset(5, d)": lambda: ZoneInfo.utcoffset(5, d),
    "unbound dst(5, d)": lambda: ZoneInfo.dst(5, d), "unbound tzname()": lambda: ZoneInfo.tzname(),
    "fromutc()": lambda: u.fromutc(), "fromutc(a,b)": lambda: u.fromutc(1, 2), "fromutc(x=)": lambda: u.fromutc(x=1),
    "unbound fromutc(5,d)": lambda: ZoneInfo.fromutc(5, d), "unbound fromutc()": lambda: ZoneInfo.fromutc(),
    "unpickle()": lambda: ZoneInfo._unpickle(), "unpickle(a)": lambda: ZoneInfo._unpickle("UTC"),
    "unpickle(a,b,c)": lambda: ZoneInfo._unpickle(1, 2, 3), "unpickle(a,x=)": lambda: ZoneInfo._unpickle("UTC", x=1),
    "unpickle(a,-1)": lambda: repr(ZoneInfo._unpickle("UTC", -1)), "unpickle(a,1.5)": lambda: ZoneInfo._unpickle("UTC", 1.5),
    "unpickle(a,2**70)": lambda: repr(ZoneInfo._unpickle("UTC", 2 ** 70)), "unpickle(a,256)": lambda: ZoneInfo._unpickle("UTC", 256) is ZoneInfo("UTC"),
    "from_file()": lambda: ZoneInfo.from_file(), "from_file(a,b,c)": lambda: ZoneInfo.from_file(1, 2, 3),
    "from_file(x=)": lambda: ZoneInfo.from_file(x=1), "from_file(a,key=,x=)": lambda: ZoneInfo.from_file(1, key=1, x=1),
    "from_file(a,b,key=)": lambda: ZoneInfo.from_file(1, 2, key=3), "from_file(a,x=)": lambda: ZoneInfo.from_file(1, x=1),
    "from_file(a,file_obj=)": lambda: ZoneInfo.from_file(1, file_obj=1),
    "reduce(1)": lambda: u.__reduce__(1), "reduce(x=)": lambda: u.__reduce__(x=1),
    "unbound reduce()": lambda: ZoneInfo.__reduce__(), "unbound reduce(5)": lambda: ZoneInfo.__reduce__(5),
    "init_subclass on ZoneInfo": lambda: ZoneInfo.__init_subclass__(1, y=2),
    "repr unbound": lambda: ZoneInfo.__repr__(5), "str unbound": lambda: ZoneInfo.__str__(5),
    "repr()": lambda: ZoneInfo.__repr__(), "repr(z, 1)": lambda: ZoneInfo.__repr__(u, 1),
    "key unbound": lambda: ZoneInfo.key.__get__(5), "key repr": lambda: repr(ZoneInfo.key),
    "key set unbound": lambda: ZoneInfo.key.__set__(5, 1),
    "tp new int": lambda: ZoneInfo.__new__(int, "UTC"), "tp new ()": lambda: ZoneInfo.__new__(),
    "tp new 5": lambda: ZoneInfo.__new__(5, "UTC"), "tp new subclass": lambda: repr(ZoneInfo.__new__(Z2, "UTC")),
}
for label, f in ARGS.items():
    show(label, f)
