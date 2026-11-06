# Rational(x, base) as Sage: the second argument is a base, read for a string only (Rational(1, 3) is 1, not 1/3);
# a string is read as GMP reads a rational ('a' or 'a/b', spaces ignored, a '-' per part, 0x/0b/0 prefixes in base 0,
# bases 2 to 62); a numerator and a denominator are a tuple.  (Rational(2.5, 3), a real with a base, is left out:
# Sage gives a large fraction near 2.5 there.)
def T(*a):
    try:
        r = Rational(*a)
        print(repr(a), "->", repr(r), r.parent())
    except Exception as e:
        print(repr(a), "!!", type(e).__name__, e)
for a in [(1, 3), (-6, 3), ("12", 3), ("1/2", 10), ("ff", 16), ("1/ff", 16), ("FF/10", 16), ("0x1f",), ("1/2",),
          ("1/0",), (5, 1), ("12", 1), ("12", 37), ("12", 0), (1/2, 3), (2.5,), ("2.5",), ("1e3",), (" 1/2 ",),
          ("-3/6",), ("3/-6",), ("+3/6",), ("1/2", 2), (None,), (), (1/2,), (RR(0.1),), (float(0.5), 2), ("abc",),
          ("1/2/3",), ("1_0/3",), ("0x10/0x3",), ("10/3", 36), (True,), (complex(1, 0),), (3, 3), (int(7), int(2)),
          ((1, 3),), ([1, 3],), (2^70, 5), ("z/y", 36), ("Z", 36), ("0.5",)]:
    T(*a)
for a in [("010",), ("0o17",), ("0b101",), ("08",), ("010/3",), (" 1 / 2 ",), ("1/ 2",), ("1 /2",), ("Z", 62), ("z", 62),
          ("10", 62), ("10", 63), ("Zz", 37), ("zZ", 37), ("a", 11), ("A", 11), ("-0x1f",), ("0X1F",), ("-1/-2",), ("--1",),
          ("1/+2",), ("\t5\n",), ("5 ",), ("0/5",), ("00/1",), ("1/00",), ("0xff", 16), ("12", -1), ("12", 2.0),
          ("12", "3"), (3, 0), ("1/2", 37), ("",), ("/",), ("1/",), ("/2",), ("1/2", 62), ((1, 2, 3),), ((1, 0),),
          ((2, 4),), ((1/2, 3),), (Integer(5), 7), (QQ(7)/2, 2), ("0b1/0b11",), ("011/2",), (b"12",), ("٣",),
          ("1e2", 16)]:
    T(*a)
print(Rational("123456789012345678901234567890/7"), Rational(3) + Rational("1/2"), Rational((6, -4)))
# the base is a C unsigned int (OverflowError beyond it), only ASCII whitespace is ignored, and bytes that do not
# decode, or do not parse, are refused by their repr
for k in [31, 32, 33, 63, 64, 65, 70]:
    T("12", 2^k)
    T("12", 2^k - 1)
T("12", -2^70)
for s in ["1 2", "1 2", "1\t2", "1\n2", "1\r2", "1\x0b2", "1\x0c2", " 12", "1\x1c2", "1\x852", "1　2"]:
    T(s)
for b in [b"\xff", b"12\xff", "é".encode("latin-1"), "1 2".encode()]:
    T(b)
