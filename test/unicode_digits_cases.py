# int(), float() and complex() of a str with Unicode decimal digits and
# whitespace, as CPython reads it (_PyUnicode_TransformDecimalAndSpaceToASCII):
# compared with CPython 3.14 by test/unicode-digits.test.ts


def t(f):
    try:
        return repr(f())
    except Exception as e:
        return type(e).__name__ + ": " + str(e)


cases = ["١٢", "１", " ١ ", " ١ ", "　２　", "\x1c1", "1\x1f", "\x851", "﻿1",
         "1​", "١_٢", "١__٢", "_١", "٠x1f", "0x١f", "-١", "+१२", "१२٣", "𝟙𝟚", "1²", "½", " 7",
         "7 ", "\t7\n", "\x0b7\x0c", "٫", "1٫5", "", " ", "　", "٠٠", "٠٧", "0b١٠", "٠o٧", "zz",
         "١" * 30, " 1 ", " 1 ", " 1 ", "Ⅻ", "๑๒", "߁", "᠑"]
for s in cases:
    print(repr(s), t(lambda: int(s)), t(lambda: int(s, 16)), t(lambda: int(s, 0)), t(lambda: int(s, 36)),
          t(lambda: float(s)), t(lambda: complex(s)))
for s in ["١.٥", "١e٣", "१.५e-१", "inf　", "　nan", "-　inf", "1_٠", "١._٥", "٠.٥j", "١+٢j", "(١+٢j)",
          " (1+2j) ", "　1+2j", "1　+2j", "(　1+2j　)", "٢j", "-٢.٥e١j", " ( 3j) "]:
    print(repr(s), t(lambda: float(s)), t(lambda: complex(s)))
# bytes are not transformed, only stripped of ASCII whitespace
for b in [b"\xd9\xa1", b"12", b" 12 ", b"\xa012", b"\x1c12", bytearray(b"7")]:
    print(repr(b), t(lambda: int(b)), t(lambda: int(b, 10)))
# every Unicode decimal digit: its value, through int and float
bad, total, count = [], 0, 0
for c in range(0x110000):
    ch = chr(c)
    if ch.isdecimal() and c > 127:
        count += 1
        try:
            v = int(ch)
            total += v * (c % 977)
            if float(ch) != v or int(ch * 3) != v * 111:
                bad.append(hex(c))
        except ValueError:
            bad.append(hex(c))
print(count, total, bad[:20])
# underscores: after a base prefix, between digits; not leading, doubled or
# trailing, in int, float and complex
for s in ["_1", "1_", "1__0", "0x_1f", "0_x1f", "_0x1f", "0b_1", "1_0", "1_0.5", "1._5", "1_e5", "1e_5", "1_j", "1+_2j", "(1_0+2j)"]:
    print(repr(s), t(lambda: int(s)), t(lambda: int(s, 0)), t(lambda: int(s, 16)), t(lambda: float(s)), t(lambda: complex(s)))
# str.isdecimal and str.isspace: CPython's characters
print([hex(c) for c in range(0x110000) if chr(c).isspace()])
print("﻿".isspace(), "\x1c".isspace(), "ᇞ0".isdecimal(), "\U00011de0".isdecimal(), "١٢".isdecimal())
# a leading zero in base 0, and complex()'s underscore errors before and
# after a non-ASCII character
for s in ["0_0", "00", "0_0_0", "0__0", "00_1", "0_1", "٠_٠", "-0_0", " 0_0 ", "0_", "_0"]:
    print(repr(s), t(lambda: int(s, 0)), t(lambda: int(s)))
for s in ["é_1", "é1", "1_é", "_1", "1__2j", "é", "1é", "?_1", "x_1", "1_x", "é1_2", "1_2é", "1é_2", "1_é2", "é_", "_é", "1_　", "　_1", "٠_x", "x_٠"]:
    print(repr(s), t(lambda: complex(s)))
