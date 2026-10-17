# json.dumps and json.loads through the _json accelerator: compared with
# CPython 3.14 (whose json uses its C _json) by test/json-accel.test.ts
import json, collections, _json
from fractions import Fraction


def show(f):
    try:
        print(repr(f()))
    except Exception as e:
        print(type(e).__name__, e.args[0] if e.args else "", getattr(e, "pos", None), getattr(e, "__notes__", None))


# dumps: scalars, containers, separators, indent, sort_keys, ensure_ascii
x = [{"a": i, "b": [i, str(i), i / 2], "c": {"d": None, "e": True}} for i in range(3)]
show(lambda: json.dumps(x))
show(lambda: json.dumps(x, indent=2, sort_keys=True))
show(lambda: json.dumps(x, indent="\t", separators=(",", ": ")))
show(lambda: json.dumps(x, separators=(",", ":")))
show(lambda: json.dumps([1.5, -0.0, 2.0, 1e300, 1e16, 1e-7, 0.1, 12345678901234567890, -(2**70), True, False, None]))
show(lambda: json.dumps({"é": " \x00\x1f\x7f😀\ud800 \"\\/\b\f\n\r\t"}))
show(lambda: json.dumps({"é": " \x00\x1f\x7f😀\ud800 \"\\"}, ensure_ascii=False))
show(lambda: json.dumps({1: 1, 2.5: 2, None: 3, True: 4, False: 5, "s": 6}))
show(lambda: json.dumps({1: 1, "a": 2}, sort_keys=True))
show(lambda: json.dumps({(1, 2): 3, "a": 4}, skipkeys=True))
show(lambda: json.dumps({(1, 2): 3}))
show(lambda: json.dumps([[], {}, [[]], [{}]], indent=1))
show(lambda: json.dumps((1, (2, 3))))
show(lambda: json.dumps(float("nan")))
show(lambda: json.dumps([float("inf"), -float("inf")]))
show(lambda: json.dumps({"a": float("nan")}, allow_nan=False))
show(lambda: json.dumps({1: object()}))
show(lambda: json.dumps([[1, {"a": set()}]]))
show(lambda: json.dumps({1.5: [1, object()]}))
show(lambda: json.dumps(Fraction(1, 3), default=str))
show(lambda: json.dumps([Fraction(1, 3)], default=lambda o: [o.numerator, o.denominator]))
a = []
a.append(a)
show(lambda: json.dumps(a))
show(lambda: json.dumps(a, check_circular=False) if False else "skipped")
d = {}
d["d"] = d
show(lambda: json.dumps(d))


class I(int):
    def __repr__(self):
        return "I!"


class E:
    A = I(1)


class F(float):
    def __repr__(self):
        return "F!"


class S(str):
    def __str__(self):
        return "S!"


class D(dict):
    def items(self):
        return [("x", 1)]


class L(list):
    def __iter__(self):
        return iter([9])


show(lambda: json.dumps([E.A, F(2.5), S("s"), D(a=2), L([1, 2]), {E.A: 1, F(0.5): 2, S("k"): 3}]))
show(lambda: json.dumps(collections.OrderedDict([("b", 1), ("a", 2)])))
show(lambda: json.dumps("x" * 3, indent=0))
show(lambda: json.dumps({"a": [1, 2]}, indent=0))

# loads: values, whitespace, positions, hooks, errors
for s in ['{"a": [1, 2.5, -0.0, 1e400, true, false, null, "s"]}', ' [1] ', '"\\ud83d\\ude00x"', '"\\ud800"',
          '"\\u00e9\\n\\t\\"\\\\\\/"', '123456789012345678901234567890', '-0', '1E2', '0.5e-3', "NaN", "-Infinity", "[]",
          "{}", '{"a":1,"a":2}', '["😀", 1]', '"😀\\u0041"']:
    show(lambda: json.loads(s))
for s in ['"abc', '"a\x01b"', '"a\\qb"', '"\\u12"', '"\\u12zz"', '"\\ud800\\u12"', "[1,]", '{"a":1,}', '{"a" 1}', "{1:2}",
          "[1 2]", '{"a":1 "b":2}', "", "-", "nul", "[", "{", '{"a"', '{"a":', "[1,", "01", "1.", "[1] x", '"\t"',
          "[1,\n2,]", '{"😀":1,}', '["😀", 1 2]', "1" * 5000]:
    show(lambda: json.loads(s))
show(lambda: json.loads('"a\x01b"', strict=False))
show(lambda: json.loads('{"a": 1, "b": [2]}', object_hook=lambda d: sorted(d)))
show(lambda: json.loads('{"a": 1, "b": 2}', object_pairs_hook=lambda p: p))
show(lambda: json.loads("[1.5, 2, 1e2]", parse_float=Fraction, parse_int=lambda s: "i" + s))
show(lambda: json.loads("[NaN, Infinity]", parse_constant=lambda s: s.lower()))
show(lambda: json.JSONDecoder().raw_decode("  [1]", 2))
show(lambda: json.JSONDecoder().raw_decode("😀[1]", 1))
show(lambda: json.loads(json.dumps(x)) == x)
show(lambda: json.loads("[" * 3000 + "]" * 3000) is not None)
deep = []
for _ in range(3000):
    deep = [deep]
show(lambda: len(json.dumps(deep)))

# the module's functions themselves
from json import decoder, encoder
show(lambda: decoder.scanstring('abc"x', 0))
show(lambda: decoder.scanstring('"😀b"', 1))
show(lambda: decoder.scanstring('a\x01b"', 0, False))
show(lambda: decoder.scanstring('a\x01b"', 0, True))
show(lambda: encoder.encode_basestring_ascii("é😀\""))
show(lambda: encoder.encode_basestring("é😀\"\n"))
# a dict or list changed by default() while it is encoded: as CPython, live
d2 = {"a": 1, "b": object(), "c": 3}
def grow(o):
    d2["z"] = 9
    return "X"
show(lambda: json.dumps(d2, default=grow))
d3 = {"a": 1, "b": object(), "c": 3}
def shrink(o):
    del d3["c"]
    return "X"
show(lambda: json.dumps(d3, default=shrink))
l2 = [1, object(), 3]
def longer(o):
    l2.append(4)
    return "X"
show(lambda: json.dumps(l2, default=longer))
# nesting: 40000 levels pass both ways, as in CPython; far deeper is a
# RecursionError (CPython's message there names its C stack, so only the
# type is compared)
show(lambda: len(json.loads("[" * 40000 + "]" * 40000)) == 1)
deep = []
for _ in range(39999):
    deep = [deep]
show(lambda: len(json.dumps(deep)))
show(lambda: len(json.loads('{"a":' * 39999 + "{}" + "}" * 39999)))
deep = {}
for _ in range(39999):
    deep = {"a": deep}
show(lambda: len(json.dumps(deep)))
for s in ["[" * 100000 + "]" * 100000, '{"a":' * 100000 + "1" + "}" * 100000]:
    try:
        json.loads(s)
        print("no error")
    except RecursionError:
        print("RecursionError")
deep = []
for _ in range(100000):
    deep = [deep]
try:
    json.dumps(deep)
    print("no error")
except RecursionError as e:
    print("RecursionError", e.__notes__[0])
# CORR-C0E-1: a float subclass's stored value, not its __float__
class F(float):
    def __float__(self): return float("inf")
    def __repr__(self): return "F!"
class G(float):
    def __float__(self): return 0.0
class H(float):
    def __float__(self): raise RuntimeError("no")
show(lambda: json.dumps(F(1.5)))
show(lambda: json.dumps(G(float("inf")), allow_nan=False))
show(lambda: json.dumps(F(float("nan")), allow_nan=False))
show(lambda: json.dumps([H(2.0), G(-float("inf"))]))
show(lambda: json.dumps({F(1.5): 1, G(float("inf")): 2, H(2.0): 3}))
show(lambda: json.dumps({G(float("nan")): 1}, allow_nan=False))
# CORR-C0E-2: separators must be str (subclasses by contents)
class SS(str):
    def __str__(self): return "?"
show(lambda: json.dumps({"a": [1, 2]}, separators=(1, ":")))
show(lambda: json.dumps({"a": [1, 2]}, separators=(",", None)))
show(lambda: json.dumps({"a": [1, 2]}, separators=(SS(";"), SS("="))))
show(lambda: json.dumps({"a": [1, 2]}, indent=SS("--")))
mk = json.encoder.c_make_encoder
show(lambda: mk(None, None, json.encoder.encode_basestring, 2, ":", ",", False, False, True)([1, [2]], 0))
show(lambda: mk(None, None, json.encoder.encode_basestring, 2, ":", ",", False, False, True)([], 0))
# CORR-C0E-3: offsets by the index protocol; past the end, not clamped
class I:
    def __index__(self): return 1
dec = json.JSONDecoder()
for at in [1.5, "1", None, 10**30, -10**30, I(), True]:
    show(lambda: dec.raw_decode(" 1", at))
    show(lambda: _json.scanstring('"x"', at))
show(lambda: mk(None, None, json.encoder.encode_basestring, None, ":", ",", False, False, True)(1, 1.5))
show(lambda: mk(None, None, json.encoder.encode_basestring, None, ":", ",", False, False, True)(1, I()))
for at in [2, 3, 8, 10**18]:
    show(lambda: dec.raw_decode("\U0001F6001", at))
    show(lambda: dec.scan_once("\U0001F6001", at))
show(lambda: dec.raw_decode("\U0001F600 1", 1))
# CORR-C0E-4: the scanner reads a str subclass by its contents
show(lambda: dec.raw_decode(SS('"abc"')))
show(lambda: dec.raw_decode(SS('\U0001F600 [1, "x"]'), 1))
show(lambda: dec.scan_once(SS('{"a": 1}'), 0))
show(lambda: dec.raw_decode(b'"abc"'))
# CORR-C0E-5: an empty dict subclass is {} without items(); a nonempty one uses it
class D(dict):
    def items(self): return [("x", 1)]
show(lambda: json.dumps(D()))
show(lambda: json.dumps(D(a=2)))
show(lambda: json.dumps([D(), D(a=2)], indent=2))
show(lambda: json.dumps(D(), sort_keys=True))
show(lambda: json.dumps(D(a=2), sort_keys=True))
# CORR-C0E-6: int digits within sys's int_max_str_digits, values and keys
import sys
class BI(int): pass
for lim in [4300, 640, 0]:
    sys.set_int_max_str_digits(lim)
    for e in [639, 640, 4299, 4300, 5000]:
        for v in [10**e, -10**e, BI(10**e)]:
            show(lambda: len(json.dumps(v)))
            show(lambda: len(json.dumps({v: 1})))
sys.set_int_max_str_digits(4300)
