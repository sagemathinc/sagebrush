# Integer() and ZZ() convert as Sage does: a rational must be a whole number (Integer(1/2) was silently 0), a real
# must be integral, a string may carry a sign, a 0x/0o/0b prefix and underscores or be read in a base, None is 0;
# what can't be converted is a TypeError with Sage's message.
def T(*a):
    try:
        print(repr(a), "->", repr(Integer(*a)))
    except Exception as e:
        print(repr(a), "!!", type(e).__name__, e)
def Z(*a):
    try:
        print("ZZ", repr(a), "->", repr(ZZ(*a)))
    except Exception as e:
        print("ZZ", repr(a), "!!", type(e).__name__, e)
for v in [1/2, 7/3, -1/2, 4/2, QQ(6)/3, QQ(-6)/3, 2.5, 2.0, RR(3.7), 1.5e20, float(2.5), float("nan"),
          float("inf"), int(5), True, False, GF(7)(3), Mod(3, 7), 3 + 0*I, complex(2, 0), CC(2), CC(2.5), None]:
    T(v)
    Z(v)
for s in ["12", "0x1f", "1/2", "abc", "010", "0b101", "0o17", "-0x1f", " 12 ", "1_000", "+5", "", "12.0", "1e3",
          "0X1F", "0B11", "08", "00", "-0", "٣"]:
    T(s)
    Z(s)
for a in [("ff", 16), ("FF", 16), ("0xff", 16), ("0o17", 8), ("0b11", 2), ("0b11", 16), ("12", 0), ("12", 1),
          ("12", 37), (5, 16), ("z", 36), ("-101", 2), ("12", 2)]:
    T(*a)
    Z(*a)
T()
print(Integer(2^100 + 1), ZZ("123456789012345678901234567890"), Integer(-3) + 1/2)
# underscores are removed before parsing (then spaces anywhere are ignored), a base must be an integer, bytes are read
# like strings, and what int() would take but Sage refuses (bytearray, memoryview, containers) is a TypeError
for a in [("0x_ff",), ("1__0",), ("_10",), ("10_",), ("+_10",), ("_",), ("__",), ("0_x1f",), ("-_1",), (" 1_0 ",),
          ("1_ 0",), ("1 0",), ("f_f", 16), ("0x_ff", 16), ("_0x1f",), ("0b_1",), ("0_10",), ("_-1",), (" ",),
          ("\t-12\n",), ("10", "2"), ("10", 2.0), ("10", True), (5, "2"), ("10", None), ("10", -1), ("10", 2^70),
          ("10", QQ(2)), (b"12",), (b"0x1f",), (b"12", 16), (bytearray(b"12"),), ([1],), ((1, 2),), ({},), (set(),)]:
    T(*a)
    Z(*a)
