# Integer powers of elements of RR and CC in symbolic expressions with large
# exponents.  Sage computes a real one with mpfr_pow_si, correctly rounded
# however large the exponent (no exact power of millions of bits is
# needed), and a complex one with generic_power; past MPFR's exponents
# (2^(2^62) and so on) a real one is an infinity or a 0.  Values that are
# not doubles are refused (the engine's tests).  Each value is printed with
# its parts in hex.
def h(v):
    c = CC(v)
    return "%s  %s,%s" % (v, float(c.real()).hex(), float(c.imag()).hex())


def p(b, n):
    # (b^n when Sage's value is a double, then the same in the symbolic
    # ring; past the doubles here otherwise, where Sagebrush refuses, as
    # its CC, which holds doubles, refuses b^n itself)
    try:
        v = b ** n
    except NotImplementedError:
        return "past the doubles: %s ^ %s" % (b, n)
    w = [v] if v in RR else [v.real(), v.imag()]
    if any(RR(float(x)) != x for x in w):
        return "past the doubles: %s ^ %s" % (b, n)
    return "%s  %s" % (h(SR(b) ** n), h(SR(b) ** SR(n)))


# correctly rounded, where binary powering's doubles drift by an ulp or more
for b in [RR(1.0000001), RR(-1.0001), RR(0.9999999), RR(1.0001), RR(-0.99999), RR(pi), RR(1/3)]:
    for n in [3, 7, 101, 1001, 40000, 10^5 + 1, 10^7, -10^7, 10^9, -(10^9 + 1), 2^40 + 1]:
        print(p(b, n))

# past MPFR's exponents: Sage's infinity or 0, signed as the power
for b in [RR(2), RR(-2), RR(0.5), RR(-0.5), RR(1e300), RR(-1e-300), RR(1.0000001)]:
    for n in [9 * 10^18, 9 * 10^18 + 1, -9 * 10^18, -(9 * 10^18 + 1), 10^20, 10^20 + 1, -10^1000]:
        print(p(b, n))
    print(p(b, RR(1e20)), p(b, RR(-1e20)))

# 1 and -1 by the exponent's parity, however large
for n in [10^20, 10^20 + 1, -(10^20 + 1), 10^1000, 10^1000 + 1]:
    print(p(RR(-1), n), p(RR(1), n))

# CC: generic_power's own steps
for b in [CC(1, 1), CC(0.6, 0.8), CC(1.0000001, 1e-7), CC(0, 1.0001)]:
    for n in [101, 10^4 + 1, -(10^4 + 1), 10^6]:
        print(p(b, n))
