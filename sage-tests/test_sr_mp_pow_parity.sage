# Integer powers in symbolic expressions whose exponent has more bits than
# the base's precision, or reaches MPFR's exponent range.  The parity and
# the sign come from the exact integer, never a rounded one; past MPFR's
# exponents (finite from 2^(-2^62) below 2^(2^62 - 1)) a real power is an
# infinity or a 0, signed as Sage's; a complex one is generic_power by the
# bits of the exponent (I^(2^100) is 1).  Values past Sagebrush's MP numbers
# (2^(+-4096)) are refused, so the test prints a power only where Sage's
# value is within them.
def p(b, n):
    # (Sagebrush's RR holds doubles: b^n itself is refused past them)
    try:
        v = b ** n
    except NotImplementedError:
        return "past the MP numbers: %s ^ %s" % (b, n)
    w = [v] if v in RR else [v.real(), v.imag()]
    # (a part finite and nonzero, past 2^(+-4090))
    if any(x - x == 0 and x != 0 and abs(x.log(2)) > 4090 for x in w):
        return "past the MP numbers: %s ^ %s" % (b, n)
    return "%s ^ %s = %s" % (b, n, SR(b) ** n)


big = [2^31 - 1, 2^31 + 1, 2^53 + 1, 2^62 - 1, 2^62 + 1, 2^63 - 1, -2^63, 2^64 + 1, -10^30 - 1, 2^100, 2^100 + 1]
for F in [RealField(24), RealField(100), RealField(200)]:
    for b in ["-1", "1", "-2", "0.5", "-0.5", "-1.5", "-0.999", "-1.0001"]:
        for n in big:
            print(F.prec(), p(F(b), n))

# MPFR's boundary, exactly, for powers of 2 (RR and RealField(p))
for F in [RR, RealField(24), RealField(100)]:
    for b, ns in [(2, [2^62 - 2, 2^62 - 1, 2^62]), (-2, [2^62 - 1, 2^62 + 1]), (0.5, [2^62, 2^62 + 1]),
                  (-0.5, [2^62 + 1, 2^62 + 3]), (4, [2^61 - 1, 2^61]), (0.25, [2^61, 2^61 + 1])]:
        for n in ns:
            print(F.prec(), p(F(b), n))

# complex: generic_power by the bits of the exponent
for C in [CC, ComplexField(30), ComplexField(100)]:
    for b in [C(0, 1), C(0, -1), C(-1, 0), C(1, 0)]:
        for n in [2^100, 2^100 + 1, 2^100 + 2, 2^100 + 3, -(2^100 + 1), 10^30 + 7]:
            print(C.prec(), p(b, n))

# near 1, exponents past i64 whose powers are within the MP numbers: the
# bracket by the bits of the exponent, correctly rounded
for F in [RealField(100), RealField(200), RealField(400)]:
    for b in [F(1) + F(2)^(-99), F(1) - F(2)^(-99), -(F(1) + F(2)^(-99)), F(1) + F(2)^(-150), -(F(1) - F(2)^(-190)), F(1) + F(2)^(-70)]:
        for n in [2^65, -(2^65 + 1), 2^65 + 1, -(2^64), 3^41, -(3^41), 2^100 + 1, 10^25]:
            print(F.prec(), p(b, n))

# within 2^-64 of 1: past MPFR's exponents still an infinity or a 0, signed
# by parity (the deviation from 1 read from the whole mantissa)
for F in [RealField(100), RealField(200)]:
    for d in [-70, -90]:
        for b in [F(1) + F(2)^d, F(1) - F(2)^d, -(F(1) + F(2)^d), -(F(1) - F(2)^d)]:
            for n in [2^140, 2^140 + 1, -(2^140 + 1), 2^160 + 3]:
                print(F.prec(), p(b, n))
