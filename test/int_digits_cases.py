# CPython's limit on an int's decimal conversions (sys.set_int_max_str_digits),
# as CPython 3.14 applies it (test/coverage-fixes.test.ts compares with python3).
import sys


def show(label, f):
    try:
        r = f()
        r = len(r) if isinstance(r, str) else r
    except Exception as e:
        r = "%s: %s" % (type(e).__name__, e)
    print(label, r)


print(sys.get_int_max_str_digits(), sys.flags.int_max_str_digits)
x = 10 ** 4300
show("str 4301 digits", lambda: str(x))
show("str 4300 digits", lambda: str(x - 1))
show("str negative 4300", lambda: str(1 - x))
show("repr", lambda: repr(-x))
show("f-string", lambda: f"{x}")
show("%d", lambda: "%d" % x)
show("%i", lambda: "%i" % x)
show("format ,", lambda: format(x, ","))
show("format d", lambda: format(x, "d"))
show("format x", lambda: format(x, "x"))
show("hex", lambda: hex(x))
show("oct", lambda: oct(x))
show("bin", lambda: bin(x))
show("print", lambda: print(x))
show("huge", lambda: str(7 ** 100000))
show("int 4301", lambda: int("1" * 4301))
show("int 4300", lambda: int("1" * 4300) > 0)
show("int -4301", lambda: int("-" + "1" * 4301))
show("int underscores", lambda: int("1_" * 4300 + "1"))
show("int zeros", lambda: int(" " + "0" * 4301 + " "))
show("int base 16", lambda: int("1" * 5000, 16) > 0)
show("int base 8", lambda: int("1" * 5000, 8) > 0)
show("int base 36", lambda: int("1" * 5000, 36))
show("int base 0", lambda: int("1" * 5000, 0))
show("int base 0 hex", lambda: int("0x" + "1" * 5000, 0) > 0)
show("int bytes", lambda: int(b"1" * 4301))
show("int invalid", lambda: int("1" * 5000 + "z"))
for n in (639, -1, 640, 0, 5000):
    show("set %d" % n, lambda: (sys.set_int_max_str_digits(n), sys.get_int_max_str_digits(), sys.flags.int_max_str_digits))
show("unlimited", lambda: str(x))
sys.set_int_max_str_digits(640)
show("640: 641 digits", lambda: str(10 ** 640))
show("640: parse 641", lambda: int("1" * 641))
