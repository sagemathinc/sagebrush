# sbx (lib/_sbx.py) on plain Python values: what it encodes, what it reads
# back, and what it refuses.  CPython is the oracle: test/sbx.test.ts runs
# this under CPython and under Sagebrush and compares the outputs.
import json
import math
from fractions import Fraction

try:
    import _sbx
except ImportError:
    # (under CPython: the module by its path, without lib/ on the path,
    # whose own modules would shadow CPython's)
    import importlib.util
    import os
    spec = importlib.util.spec_from_file_location("_sbx", os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "lib", "_sbx.py"))
    _sbx = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(_sbx)


def same(a, b):
    """the same value, NaN being NaN, and of the same types"""
    if type(a) is not type(b):
        return False
    if isinstance(a, float):
        return (math.isnan(a) and math.isnan(b)) or (a == b and math.copysign(1, a) == math.copysign(1, b))
    if isinstance(a, complex):
        return same(a.real, b.real) and same(a.imag, b.imag)
    if isinstance(a, list):
        return len(a) == len(b) and all(same(x, y) for x, y in zip(a, b))
    if isinstance(a, dict):
        return list(a) == list(b) and all(same(a[k], b[k]) for k in a)
    return a == b


VALUES = [
    0, 7, -12, 2 ** 100, -(3 ** 80),
    Fraction(-3, 4), Fraction(10 ** 30, 7), Fraction(5),
    1.5, -0.0, 1e308, 5e-324, 0.1, float("inf"), float("-inf"), float("nan"),
    complex(1, -2), complex(float("inf"), 0.5),
    True, False,
    "", "héllo, 世界 \n\t\"quoted\" \\ $x^2$",
    [], [1, [2.5, ["a", True]], Fraction(1, 3)],
    (1, 2),
    {}, {"a": 1, "b": [1.5, {"c": "d"}], "": 0},
]
for v in VALUES:
    e = _sbx.encode(v)
    text = _sbx.dumps(v)
    back = _sbx.loads(text)
    want = list(v) if isinstance(v, tuple) else v
    print("ok  " if same(back, want) else "FAIL", json.dumps(e, sort_keys=True))

# polynomials: the grammar, read without eval
for text, names, ring in [("x^2 - 3/4*y", ["x", "y"], "QQ"), ("-x + 1", ["x"], "ZZ"), ("2*x*y^3 + x*x - 5", ["x", "y"], "ZZ"), ("0", ["t"], "QQ"), ("  x ^ 2 +  -1  ", ["x"], "QQ")]:
    try:
        p = _sbx.decode({"t": "poly", "ring": ring, "vars": names, "v": text})
        print("ok  ", "poly", repr(text), "->", str(p), sorted((str(c), e) for c, e in p.terms()), "->", json.dumps(_sbx.encode(p), sort_keys=True))
    except _sbx.SbxError as err:
        print("ok  ", "poly", repr(text), "refused:", err)
for text in ["x^", "x**2", "__import__('os')", "x + + y", "3/0*x", "1/2*x", "x y", "z", "x^2000000", "2(x)", ""]:
    try:
        _sbx.decode({"t": "poly", "ring": "ZZ", "vars": ["x", "y"], "v": text})
        print("FAIL", "poly", repr(text), "was read")
    except _sbx.SbxError as err:
        print("ok  ", "poly", repr(text), "refused:", err)

# refused on the way out: each saying what to do
class Thing:
    pass
cyc = [1]
cyc.append(cyc)
deep = []
d = deep
for _ in range(40):
    d.append([])
    d = d[0]
for v in [None, Thing(), print, {1: "a"}, cyc, deep, "x" * (2 ** 20 + 1), {1.5, 2}]:
    try:
        _sbx.encode(v)
        print("FAIL", "encoded", type(v).__name__)
    except _sbx.SbxError as err:
        print("ok  ", "refused", type(v).__name__ + ":", err)

# not sbx, refused on the way in, before anything is made of it
for data in [
    {"t": "int", "v": 5}, {"t": "int", "v": "05"}, {"t": "int", "v": "1e5"}, {"t": "rat", "v": "2/4"}, {"t": "rat", "v": "1/0"},
    {"t": "float", "v": "1.5"}, {"t": "float", "v": True}, {"t": "bool", "v": 1}, {"t": "str", "v": 3},
    {"t": "list", "v": [{"t": "nope"}]}, {"t": "dict", "v": [["a", {"t": "bool", "v": True}], ["a", {"t": "bool", "v": False}]]},
    {"t": "array", "dtype": "float64", "shape": [2, 2], "v": [1.0, 2.0, 3.0]}, {"t": "array", "dtype": "float32", "shape": [1], "v": [1.0]},
    {"t": "array", "dtype": "int64", "shape": [1], "v": ["9223372036854775808"]}, {"t": "array", "dtype": "float64", "shape": [10 ** 4, 10 ** 4], "v": []},
    {"t": "matrix", "ring": "ZZ", "shape": [1, 1], "v": ["1/2"]}, {"t": "matrix", "ring": "RR", "shape": [1], "v": ["1"]}, {"t": "matrix", "ring": "QQ", "shape": [1, 1, 1], "v": ["1"]},
    {"t": "poly", "ring": "QQ", "vars": ["x", "x"], "v": "x"}, {"t": "poly", "ring": "QQ", "vars": ["1x"], "v": "1"},
    "just text", [1], {"v": 1},
]:
    try:
        _sbx.decode(data)
        print("FAIL", "read", json.dumps(data)[:60])
    except _sbx.SbxError as err:
        print("ok  ", "refused", json.dumps(data)[:60] + ":", err)
for text in ['{"sbx": 2, "value": {"t": "int", "v": "1"}}', "not json", '{"value": {"t": "int", "v": "1"}}']:
    try:
        _sbx.loads(text)
        print("FAIL", "loaded", text)
    except _sbx.SbxError as err:
        print("ok  ", "refused", text + ":", err)

# exact values asked for as doubles: rounded only then
for data in [{"t": "int", "v": str(2 ** 60 + 1)}, {"t": "rat", "v": "1/3"}, {"t": "matrix", "ring": "QQ", "shape": [2], "v": ["1/2", "3"]}, {"t": "list", "v": [{"t": "rat", "v": "-5/2"}]}]:
    v = _sbx.decode(data, as_="double")
    print("ok  ", "as double", json.dumps(data), "->", repr(v))
try:
    _sbx.decode({"t": "int", "v": "1" + "0" * 400}, as_="double")
    print("FAIL", "10^400 as a double")
except _sbx.SbxError as err:
    print("ok  ", "refused 10^400 as a double:", err)
# decimal digits bounded before anything converts them, and refused as sbx
# refuses, never the interpreter's own error (daybreak2's HARD-695-1)
D = _sbx.LIMITS.get("digits", 4300)
big, ok = "1" + "0" * D, "9" * D
for label, data, as_ in [
    ("an int", {"t": "int", "v": big}, None),
    ("a negative int", {"t": "int", "v": "-" + big}, None),
    ("a rat's numerator", {"t": "rat", "v": big + "/3"}, None),
    ("a rat's denominator", {"t": "rat", "v": "1/" + big}, None),
    ("a ZZ matrix entry", {"t": "matrix", "ring": "ZZ", "shape": [2], "v": ["1", big]}, None),
    ("a QQ matrix entry", {"t": "matrix", "ring": "QQ", "shape": [1, 1], "v": ["1/" + big]}, None),
    ("an int as a double", {"t": "int", "v": big}, "double"),
    ("a QQ matrix entry as a double", {"t": "matrix", "ring": "QQ", "shape": [1], "v": [big + "/7"]}, "double"),
    ("a poly's coefficient", {"t": "poly", "ring": "QQ", "vars": ["x"], "v": big + "*x + 1"}, None),
    ("a poly's denominator", {"t": "poly", "ring": "QQ", "vars": ["x"], "v": "1/" + big + "*x"}, None),
    ("a poly's exponent of many digits", {"t": "poly", "ring": "QQ", "vars": ["x"], "v": "x^" + big}, None),
    ("an int64 entry of many digits", {"t": "array", "dtype": "int64", "shape": [1], "v": [big]}, None),
]:
    try:
        _sbx.decode(data, as_=as_)
        print("FAIL", "digits: read", label)
    except _sbx.SbxError as err:
        print("ok  ", "digits: refused", label + ":", str(err)[:120])
    except Exception as err:
        print("FAIL", "digits:", label, "escaped as", type(err).__name__)
# (exactly the bound: read, and as a double too)
for data in [{"t": "int", "v": ok}, {"t": "rat", "v": ok + "/" + ok[:-1] + "8"}, {"t": "matrix", "ring": "QQ", "shape": [1], "v": ["-" + ok + "/7"]}]:
    v = _sbx.decode(data)
    print("ok  " if json.dumps(_sbx.encode(v)) == json.dumps(_sbx.encode(_sbx.decode(_sbx.encode(v)))) else "FAIL", "digits: exactly", D, "read and sent back", data["t"])
for v in [10 ** D, -(10 ** D), Fraction(1, 10 ** D), [10 ** (D + 50)]]:
    try:
        _sbx.encode(v)
        print("FAIL", "digits: encoded", type(v).__name__)
    except _sbx.SbxError as err:
        print("ok  ", "digits: not encoded", type(v).__name__ + ":", str(err)[:80])
print("ok  " if _sbx.encode(10 ** D - 1)["v"] == ok else "FAIL", "digits: 10^%d - 1 encoded" % D)

# loads bounded in UTF-8 bytes, as dumps is: 6 Mi characters of 3 bytes each refused before parsing (HARD-695-2)
wide = '{"sbx": 1, "value": {"t": "str", "v": "' + "€" * (6 * 2 ** 20) + '"}}'
try:
    _sbx.loads(wide)
    print("FAIL", "loads: 18 MiB of UTF-8 read")
except _sbx.SbxError as err:
    print("ok  ", "loads: %d characters, %d UTF-8 bytes, refused:" % (len(wide), len(wide.encode("utf-8"))), err)
narrow = '{"sbx": 1, "value": {"t": "str", "v": "' + "€" * 1000 + '"}}'
print("ok  " if _sbx.loads(narrow) == "€" * 1000 else "FAIL", "loads: non-ASCII within the bound read")
print("done")
