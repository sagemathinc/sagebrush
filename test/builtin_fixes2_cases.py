# Builtins as CPython 3.14's, found by @sagebrush-sage2's time/datetime
# cases: the Unicode errors' attributes and messages, int's conversions of
# a subclass, int's and float's rounding dunders, and a getset descriptor's
# __get__ without its owner. Compared with CPython by
# test/unicode-errors.test.ts


def t(label, f):
    try:
        print(label, repr(f()))
    except Exception as e:
        print(label, type(e).__name__, e)


# (the Unicode errors: CPython's arguments, attributes and __str__)
E = UnicodeEncodeError("utf-8", "a\ud800", 1, 2, "surrogates not allowed")
t("encode str", lambda: str(E))
t("encode attrs", lambda: (E.encoding, E.object, E.start, E.end, E.reason, E.args))
t("encode range", lambda: str(UnicodeEncodeError("ascii", "aé€x", 1, 3, "ordinal not in range(128)")))
t("encode astral", lambda: str(UnicodeEncodeError("ascii", "\U0001f600", 0, 1, "nope")))
t("encode latin", lambda: str(UnicodeEncodeError("ascii", "é", 0, 1, "nope")))
t("encode clamp", lambda: str(UnicodeEncodeError("ascii", "abc", 5, 9, "r")))
D = UnicodeDecodeError("utf-8", b"a\xff", 1, 2, "invalid start byte")
t("decode str", lambda: str(D))
t("decode attrs", lambda: (D.encoding, D.object, D.start, D.end, D.reason))
t("decode range", lambda: str(UnicodeDecodeError("utf-8", b"\xe2\x82x", 0, 2, "invalid continuation byte")))
t("decode bytearray", lambda: type(UnicodeDecodeError("utf-8", bytearray(b"\xff"), 0, 1, "r").object))
R = UnicodeTranslateError("a\ud800", 1, 2, "no")
t("translate str", lambda: str(R))
t("translate attrs", lambda: (R.object, R.start, R.end, R.reason))
t("translate range", lambda: str(UnicodeTranslateError("abcd", 1, 3, "no")))
t("encode no args", lambda: UnicodeEncodeError())
t("encode 4 args", lambda: UnicodeEncodeError("a", "b", 1, 2))
t("encode bad type", lambda: UnicodeEncodeError(1, "b", 1, 2, "r"))
t("decode bad object", lambda: UnicodeDecodeError("a", "str", 1, 2, "r"))
t("subclass", lambda: (issubclass(UnicodeEncodeError, UnicodeError), issubclass(UnicodeTranslateError, ValueError)))
for b, enc in ((b"\xff", "utf-8"), (b"\xe2\x82", "utf-8"), (b"a\xe2\x82x", "utf-8"), (b"\x80", "ascii"), (b"\x00", "utf-16"), (b"\x00\xd8", "utf-16-le"), (b"\x00\x00\x11\x00", "utf-32-le")):
    def f(b=b, enc=enc):
        try:
            b.decode(enc)
        except UnicodeDecodeError as e:
            return (str(e), e.encoding, e.object, e.start, e.end, e.reason)
    t("real decode %r %s" % (b, enc), f)
for s, enc in (("a\ud800", "utf-8"), ("x\udc80\udc81y", "utf-8"), ("é", "ascii"), ("€", "latin-1")):
    def g(s=s, enc=enc):
        try:
            s.encode(enc)
        except UnicodeEncodeError as e:
            return (str(e), e.encoding, e.object, e.start, e.end, e.reason)
    t("real encode %r %s" % (s, enc), g)
t("unknown handler", lambda: "\ud800".encode("utf-8", "nope"))
t("unknown handler unused", lambda: "abc".encode("utf-8", "nope"))
t("unknown encoding", lambda: "abc".encode("no-such"))
t("encoding type", lambda: "abc".encode(1))
t("errors type", lambda: "abc".encode("utf-8", 1))
t("utf-8-sig", lambda: ("é".encode("utf-8-sig"), b"\xef\xbb\xbf\xc3\xa9".decode("utf-8-sig"), b"\xc3\xa9".decode("utf-8-sig")))
t("utf-16 bom", lambda: (b"\xfe\xff\x00a".decode("utf-16"), b"\xff\xfea\x00".decode("utf-16"), b"a\x00".decode("utf-16")))
t("cp1252", lambda: ("€‚ƒ".encode("cp1252"), bytes(range(0x80, 0xa0)).decode("cp1252", "replace")))


# (int's conversions of a subclass: an exact int)
class I(int):
    pass


i = I(7)
t("int.__int__", lambda: (type(int.__int__(i)), type(int.__index__(i)), type(int.__pos__(i)), type(i.__int__()), type(i.__index__())))
t("int.__trunc__", lambda: (type(int.__trunc__(i)), int.__trunc__(i), int.__floor__(i), int.__ceil__(i), type(int.__floor__(i)), type(int.__ceil__(i))))
t("int.__round__", lambda: (int.__round__(i), type(int.__round__(i)), int.__round__(1234, -2), type(int.__round__(i, 1))))
t("bool dunders", lambda: (True.__trunc__(), type(True.__floor__()), type(True.__int__()), type(True.__index__())))
t("float dunders", lambda: (float.__trunc__(2.7), float.__floor__(-2.5), float.__ceil__(-2.5), float.__round__(2.5), float.__round__(2.675, 2), type(float.__floor__(2.0))))
t("float dunder inf", lambda: float.__floor__(float("inf")))
t("float dunder nan", lambda: float.__ceil__(float("nan")))
import math
t("math via dunders", lambda: (math.trunc(I(5)), math.floor(I(5)), math.ceil(I(5)), type(math.floor(I(5)))))
t("dir has", lambda: [n for n in ("__trunc__", "__floor__", "__ceil__", "__round__") if hasattr(int, n) and hasattr(float, n)])


# (a getset descriptor's __get__ with the owner omitted)
t("real.__get__ one arg", lambda: int.real.__get__(5))
t("imag.__get__ one arg", lambda: (int.imag.__get__(5), complex.real.__get__(1 + 2j)))
t("real.__get__ None", lambda: int.real.__get__(None, int) is int.real)
t("real.__get__ wrong", lambda: int.real.__get__("x"))
t("real.__get__ none at all", lambda: int.real.__get__())
t("doc getset", lambda: type.__dict__["__name__"].__get__(int))


# (@sagebrush-astra's review of 1f3f19fc: CORR-1F3-1..4)
t("constructor codec", lambda: "abc".encode("constructor"))
t("constructor decode", lambda: b"abc".decode("constructor"))
t("toString codec", lambda: b"abc".decode("toString"))
def sig(b, err="strict"):
    try:
        return b.decode("utf-8-sig", err)
    except UnicodeDecodeError as e:
        return (e.encoding, e.object, e.start, e.end, e.reason)
t("utf-8-sig error", lambda: (sig(b"\xef\xbb\xbfA\xffB"), sig(b"A\xffB"), sig(b"\xef\xbbA"), sig(b"\xef\xbb\xbf\xed\xa0\x80", "surrogatepass")))
def sige(s):
    try:
        return s.encode("utf-8-sig")
    except UnicodeEncodeError as e:
        return (e.encoding, e.object, e.start, e.end)
t("utf-8-sig encode error", lambda: (sige("x\ud800y"), sige("ok")))
t("surrogateescape partial", lambda: (b"\xd8\x00A".decode("utf-16-be", "surrogateescape"), b"\x80\x00\x00\x11\x00".decode("utf-32-be", "surrogateescape")))
t("surrogateescape partial 2", lambda: (b"\xd8\x00\x00".decode("utf-16-be", "surrogateescape"), b"\xff\xfe\x00\xd8".decode("utf-16", "surrogateescape")))
t("surrogateescape utf8 run", lambda: b"a\xe2\x82b\xf0\x9f\x98".decode("utf-8", "surrogateescape"))
for args in (("ascii", "a", 2**63, 1, "why"), ("ascii", "a", 0, -2**63 - 1, "why")):
    t("ctor bounds %r" % (args[2:4],), lambda args=args: UnicodeEncodeError(*args))
class Ix:
    def __index__(self):
        return 0
t("ctor index", lambda: UnicodeEncodeError("a", "abc", Ix(), 1, "r").start)
e = UnicodeEncodeError("ascii", "a", 0, 1, "why")
for attr, v in (("start", "x"), ("start", 2**63), ("start", True), ("end", 1.5), ("start", Ix()), ("encoding", 1), ("reason", 5)):
    def setit(attr=attr, v=v):
        f = UnicodeEncodeError("ascii", "a", 0, 1, "why")
        setattr(f, attr, v)
        return (getattr(f, attr), str(f))
    t("set %s %r" % (attr, v if not isinstance(v, Ix) else "Ix"), setit)
def objnone():
    f = UnicodeEncodeError("ascii", "a", 0, 1, "why")
    f.object = None
    return str(f)
t("object None", objnone)
def dobj():
    d = UnicodeDecodeError("a", b"x", 0, 1, "r")
    d.object = "str"
    return str(d)
t("decode object str", dobj)
t("big positions", lambda: (str(UnicodeEncodeError("a", "abc", 2**63 - 1, 2**63 - 1, "r")), str(UnicodeEncodeError("a", "abc", -2**63, -2**63, "r"))))
t("start past end", lambda: (lambda f: (setattr(f, "start", 5), str(f))[1])(UnicodeEncodeError("ascii", "a", 0, 1, "why")))
class S(str):
    pass
enc, obj, why = S("ascii"), S("abc"), S("why")
E2 = UnicodeEncodeError(enc, obj, 0, 1, why)
t("identity", lambda: (E2.encoding is enc, E2.object is obj, E2.reason is why, str(E2)))
class R(str):
    def __str__(self):
        return "custom"
t("reason __str__", lambda: str(UnicodeEncodeError("ascii", "a", 0, 1, R("why"))))
B = bytearray(b"ab")
t("decode object bytes", lambda: (type(UnicodeDecodeError("a", B, 0, 1, "r").object), UnicodeDecodeError("a", b"ab", 0, 1, "r").object))
