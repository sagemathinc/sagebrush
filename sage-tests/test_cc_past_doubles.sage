# CC at the edges of the doubles: Sage's CC is MPFR at 53 bits, whose
# exponents reach far past a double's.  Each value below is a double, in
# range or exactly at its edges, though the double arithmetic leaves the
# doubles on the way (an overflow inside, an underflow to 0, a subnormal
# part); sagebrush refuses the values past them (doctests in
# lib/_sage_matrix.py), so only the values it keeps are here.
def show(label, f):
    try:
        v = f()
    except Exception as e:
        print(label, "|", type(e).__name__)
        return
    print(label, "|", v, "|", parent(v))

# the largest double, and 2^-1074, exactly; 2^-1024, a subnormal quotient
show("max", lambda: CC(2^1023, 0) + CC(2^1023 - 2^971, 0))
print((CC(2^1023, 0) + CC(2^1023 - 2^971, 0)).real() == 2^1024 - 2^971)
show("max-", lambda: CC(-2^1023, 1) - CC(2^1023 - 2^971, 0))
show("sub1074", lambda: CC(2^-1000, 1) / 2^74)
print((CC(2^-1000, 1) / 2^74).real() == 2^-1074)
show("tiny*", lambda: CC(2^-537, 2^-537) * CC(2^-537, 0))
show("invbig", lambda: ~CC(2^1023, 2^1023))
print((~CC(2^1023, 2^1023)).real() == 2^-1024)
show("sum", lambda: sum([CC(2^1022, 1)] * 3))

# operands past 2^510 or below 2^-510, results in range
show("mul", lambda: CC(2^1000, 3) * CC(2^-100, 1))
show("mulflt", lambda: CC(2^600, 1) * 2.0^423)
show("div", lambda: CC(2^1000, 2^1000) / CC(2^1000, 2^999))
show("div2", lambda: CC(1, 2^-600) / CC(2^-600, 1))
show("div3", lambda: CC(2^-700, 3) / CC(2^-700, 2^-650))

# powers: 2^1023, 2^-1074, and 2^x near the top
show("pow1023", lambda: CC(2, 0)^1023)
show("pow-1074", lambda: CC(2, 0)^-1074)
print((CC(2, 0)^-1074).real() == 2^-1074)
show("rpow", lambda: 2^CC(1023.5, 0))
show("rpow2", lambda: 2^CC(1024, 0))

# abs: Sage's sqrt(a^2 + b^2), whose squares leave the doubles
show("abs1", lambda: CC(2^-1074, 2^-1074).abs())
show("abs2", lambda: CC(2^1023, 2^1023).abs())
show("abs3", lambda: CC(2^1023*1.5, 2^1023*1.5).abs())

# functions whose double computation overflows inside
show("cosh", lambda: cosh(CC(710.3, 0.5)))
show("sinh", lambda: sinh(CC(710.3, 0.5)))
show("exp", lambda: exp(CC(709.7, 0.5)))
show("exp2", lambda: exp(CC(709.8, 0.5)))
show("exp3", lambda: exp(CC(-708, 1)))
show("sinh0", lambda: sinh(CC(0, 1)))

# infinities, NaN and exact cancellation: as before
show("inf*", lambda: CC(Infinity, 1) * 2)
show("inf+", lambda: CC(Infinity, 1) + CC(-Infinity, 1))
show("div0", lambda: CC(1, 1) / 0)
show("nan", lambda: CC(float("nan"), 1) * CC(2^600, 2^600))
show("cancel", lambda: CC(1, 1) * CC(1, -1))
show("cancel/", lambda: CC(1, 1) / CC(1, 1))

# zeros: kept where Sage's value has an exact 0 (a real argument of exp, the
# imaginary axis of sin and cos, a real argument in arccos's or sqrt's
# domain), and the powers as Sage's generic_power computes them, bit for bit
def bits(label, f):
    try:
        v = f()
    except Exception as e:
        print(label, "|", type(e).__name__)
        return
    print(label, "|", v, "|", float(v.real()).hex(), float(v.imag()).hex())

bits("sin0", lambda: sin(CC(0, 1)))
bits("sqrt4", lambda: sqrt(CC(4, 0)))
show("arccos2", lambda: CC(arccos(CC(2, 0))))
show("arctan-i", lambda: CC(arctan(CC(0, -0.5))))
bits("sq", lambda: CC(4, 0)^0.5)
bits("sqn", lambda: CC(-4, 0)^0.5)
bits("neg", lambda: CC(-2, 0)^-3)
bits("negi", lambda: CC(0, 2)^-3)
bits("p101", lambda: CC(1.0001, 0.0002)^101)
bits("p2046", lambda: CC(1, 1)^2046)
bits("pm7", lambda: CC(1.5, -0.25)^-7)
bits("pm1", lambda: CC(3, 7)^-1)
bits("z0inv", lambda: CC(0, 0)^-1)
bits("z0pow", lambda: CC(0, 0)^2.5)
bits("z0c", lambda: CC(0, 0)^CC(2, 1))
bits("p0", lambda: CC(float("nan"), 1)^0)
bits("hugeexp", lambda: CC(2, 0)^(10^30))
