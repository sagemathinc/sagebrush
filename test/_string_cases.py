# _string's parsers (lib/_string.py: CPython's C module ported to Python), as
# CPython 3.14's: every string of a small alphabet up to length 4, and 3,000
# longer ones (seeded), through formatter_parser and
# formatter_field_name_split, their results and their errors, as one CRC-32; a few
# cases printed whole (compared with CPython by
# test/stdlib-string-traceback.test.ts)
import itertools
import random
import _string
import zlib


def parse(s):
    out = []
    try:
        for x in _string.formatter_parser(s):
            out.append(x)
        return ("ok", out)
    except Exception as e:
        return (type(e).__name__, str(e), out)


def split(s):
    try:
        first, rest = _string.formatter_field_name_split(s)
    except Exception as e:
        return (type(e).__name__, str(e))
    r = [first, type(first).__name__]
    try:
        for x in rest:
            r.append(x)
    except Exception as e:
        r.append((type(e).__name__, str(e)))
    return r


A = "{}!:[].a0 r"
cases = ["".join(t) for k in range(5) for t in itertools.product(A, repeat=k)]
rnd = random.Random(7)
cases += ["".join(rnd.choice(A + "bxy12{}") for _ in range(rnd.randint(5, 12))) for _ in range(3000)]
cases += ["١٢", "a[٣]", "99999999999999999999", "a[99999999999999999999]", "{١}", "{0[x}"]
crc = 0
for s in cases:
    crc = zlib.crc32(repr((s, parse(s), split(s))).encode(), crc)
print(len(cases), "cases, crc32", crc)
for s in ["a{{b", "x}}y", "{}", "{0!r:>{w}}", "{a[0].b}", "{!}", "{:", "{a{", "a.b[0][x]", "a[0]x", "a..b", "a[]", "99999999999999999999"]:
    print(repr(s), parse(s), split(s))
for bad in [5, None]:
    for f in (_string.formatter_parser, _string.formatter_field_name_split):
        try:
            f(bad)
        except TypeError as e:
            print("TypeError", e)


# a str subclass's own __len__, __getitem__, __iter__ and __str__ are not
# read: the string's characters are (astra's CORR-484-1)
class Short(str):
    def __len__(self):
        return 0


class Indexed(str):
    def __getitem__(self, key):
        return "bad"

    def __iter__(self):
        return iter("bad")


class Stringy(str):
    def __str__(self):
        return "{other}"


for C in (Short, Indexed, Stringy):
    print(C.__name__, list(_string.formatter_parser(C("{x}"))))
    first, rest = _string.formatter_field_name_split(C("a[0].b"))
    print(C.__name__, first, type(first).__name__, list(rest))
# (positional only, as the C functions)
for f in (_string.formatter_parser, _string.formatter_field_name_split):
    try:
        f(format_string="{x}") if f is _string.formatter_parser else f(field_name="a")
    except TypeError as e:
        print("keyword refused:", type(e).__name__)
