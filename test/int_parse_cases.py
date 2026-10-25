# int() from text, as CPython 3.14's: the grammar, the bases, the inputs
# (str, bytes, bytearray, memoryview, array) and the invalid-literal error,
# whose operand is cut at 200 code points as CPython's %.200R.  Run by
# test/int-digit-oom.test.ts with python3 and with Sagebrush: both must
# print the same.
import sys
from array import array


def show(label, f):
    try:
        r = f()
        print(label, "->", repr(r))
    except Exception as e:
        msg = str(e)
        # (the operand's length in code points, after the ": " the message has)
        op = msg.split(": ", 1)[1] if ": " in msg else ""
        print(label, "->", type(e).__name__, repr(msg), len(op))


# the grammar (astra2's probes, plan r4)
for s, b in [
    ("0x_Ab", 0), ("0x__Ab", 0), ("0x_Ab", 16), ("0xAb", 16), ("0xAb", 10), ("0b10", 16), ("0o17", 8), ("0O17", 0),
    ("_1", 10), ("1_", 10), ("1__0", 10), ("1_0", 10), ("1_0_0", 0),
    (" -0B_10 ", 0), ("\t+0b_10\n", 2), ("- 1", 10), ("+-1", 10), ("--1", 10), ("+", 10), ("-", 10), ("", 10), ("   ", 10),
    ("00_1", 0), ("00_0", 0), ("00", 0), ("01", 0), ("0", 0), ("0_0", 0), ("007", 10), ("0x", 0), ("0x_", 0),
    ("\u0661\u0662\u0663", 10), ("\uff11\uff12", 10), ("1\u00a0", 10), ("\u00a01", 10), ("1\u001c", 10), ("1\ufeff", 10),
    ("1\u2003", 10), ("\u0661_\u0662", 10), ("1\u200b2", 10), ("\U0001d7ce", 10),
    ("@", 36), (":", 36), ("[", 36), ("`", 36), ("{", 36), ("1@", 10), ("12:", 10),
    ("zZ", 36), ("Zz", 36), ("10", 36), ("z", 35), ("y", 35), ("9", 9), ("8", 9),
    ("ff", 16), ("FF", 16), ("fF", 16), ("g", 16), ("1010", 2), ("102", 2), ("7", 8), ("8", 8),
    ("vv", 32), ("VV", 32), ("w", 32), ("33", 4), ("4", 4), ("0b1", 2), ("0o7", 8), ("0x1", 32),
]:
    show("int(%r, %d)" % (s, b), lambda s=s, b=b: int(s, b))
for b in range(2, 37):
    show("int('10', %d)" % b, lambda b=b: int("10", b))
    show("int(digits, %d)" % b, lambda b=b: int("0123456789abcdefghijklmnopqrstuvwxyz"[:b] * 3, b))
show("int('1', 1)", lambda: int("1", 1))
show("int('1', 37)", lambda: int("1", 37))

# the configured digit limit: an invalid literal before the limit, the limit before memory
sys.set_int_max_str_digits(640)
show("641 digits + x", lambda: int("1" * 641 + "x"))
show("641 digits", lambda: int("1" * 641))
show("640 digits % 7", lambda: int("1" * 640) % 7)
show("641 hex digits % 7", lambda: int("1" * 641, 16) % 7)
show("641 base-4 digits % 7", lambda: int("1" * 641, 4) % 7)
show("641 base-32 digits % 7", lambda: int("1" * 641, 32) % 7)
sys.set_int_max_str_digits(0)

# bases 4 and 32, long enough for the pieces
show("base 4", lambda: int("0123" * 2000, 4) % 1000003)
show("base 32", lambda: int("0123456789abcdefghijklmnopqrstuv" * 300, 32) % 1000003)
show("base 32 upper", lambda: int("0123456789ABCDEFGHIJKLMNOPQRSTUV" * 300, 32) % 1000003)
show("negative base 36", lambda: int("-" + "zyx" * 3000, 36) % 1000003)

# bytes-like inputs, valid and not, with and without a base
for label, f in [
    ("b'12'", lambda: int(b"12")), ("bytearray(b'12')", lambda: int(bytearray(b"12"))),
    ("memoryview(b'12')", lambda: int(memoryview(b"12"))), ("array('B', b'12')", lambda: int(array("B", b"12"))),
    ("b' 0x_1f ', 0", lambda: int(b" 0x_1f ", 0)), ("bytearray(b'ff'), 16", lambda: int(bytearray(b"ff"), 16)),
    ("b'z'", lambda: int(b"z")), ("bytearray(b'z')", lambda: int(bytearray(b"z"))), ("bytearray(b'z'), 10", lambda: int(bytearray(b"z"), 10)),
    ("memoryview(b'z')", lambda: int(memoryview(b"z"))), ("memoryview(b'z'), 10", lambda: int(memoryview(b"z"), 10)),
    ("array('B', b'z')", lambda: int(array("B", b"z"))), ("b'\\xd9\\xa1'", lambda: int(b"\xd9\xa1")),
    ("b'1\\xa0'", lambda: int(b"1\xa0")), ("b\"'1\"", lambda: int(b"'1")), ("b'\"1'", lambda: int(b'"1')),
    ("b'\\'\"1'", lambda: int(b"'\"1")),
]:
    show("int(%s)" % label, f)

# the invalid-literal operand: 200 code points, as CPython's %.200R
E = "\U0001f600"
for label, s in [
    ("150 emoji + x", E * 150 + "x"), ("250 emoji + x", E * 250 + "x"), ("198 ascii + x", "1" * 198 + "x"),
    ("197 ascii + x", "1" * 197 + "x"), ("199 ascii + x", "1" * 199 + "x"), ("300 ascii + x", "1" * 300 + "x"),
    ("mixed", ("1" + E) * 120 + "x"), ("emoji at 199", "1" * 197 + E + "x" * 10), ("emoji at 200", "1" * 198 + E + "x" * 10),
    ("emoji at 201", "1" * 199 + E + "x" * 10), ("\\x1f at 197", "1" * 196 + "\x1f" + "x" * 10),
    ("\\u200b at 196", "1" * 195 + "\u200b" + "x" * 10), ("\\U000e0001 at 193", "1" * 192 + "\U000e0001" + "x" * 10),
    ("quote ' after 200", "x" * 250 + "'"), ("quotes after 200", "x" * 250 + "'\""), ("quote ' early", "'" + "x" * 300),
    ("backslash at 199", "1" * 198 + "\\" + "x" * 10), ("newline at 200", "1" * 199 + "\n" + "x"),
    ("lone surrogate", "1" * 10 + "\ud800" + "x"), ("astral non-printable", "\U000e0001" * 30 + "x"),
]:
    show("int(%s)" % label, lambda s=s: int(s))
    show("int(%s, 16)" % label, lambda s=s: int(s, 16))
for label, b in [("bytes 300", b"1" * 300 + b"x"), ("bytes \\xff at 197", b"1" * 196 + b"\xff" + b"x" * 10),
                 ("bytes quote ' after 200", b"x" * 250 + b"'"), ("bytes \\\\ at 199", b"1" * 198 + b"\\" + b"x")]:
    show("int(%s)" % label, lambda b=b: int(b))
    show("int(bytearray %s)" % label, lambda b=b: int(bytearray(b)))
    show("int(memoryview %s)" % label, lambda b=b: int(memoryview(b)))
# (bytes: CPython reprs the first 200 bytes, so a quote past them doesn't
# choose the outer quotes, as a str's does)
for n in (198, 199, 200, 201, 202):
    show("int(bytes ' at %d)" % n, lambda n=n: int(b"x" * (n - 1) + b"'"))
show("int(bytes ' at 199, \" at 200)", lambda: int(b"x" * 198 + b"'\""))
show("int(bytes ' at 200, \" at 201)", lambda: int(b"x" * 199 + b"'\""))
show("int(bytes 60 \\xff + x)", lambda: int(b"\xff" * 60 + b"x"))
