# The sign of a zero in RealField(p), as Sage (MPFR's -0): R(-0.0) and
# R('-0') are -0, the sign of a product or quotient is the product of the
# signs, two zeros add to their common sign (else +0, -0 rounding down),
# -0 to an odd power keeps its sign (-0^-3 is -infinity), a zero remainder
# has the sign of x, an underflow keeps its sign, and -0 prints, converts
# (float, RR, other fields) and is the odd functions' value at -0.
def show(label, f):
    try:
        r = f()
        # (an integer's type is left out: a Python int is sagebrush's
        # Integer)
        intlike = isinstance(r, (bool, int)) or type(r).__name__ == "Integer"
        p = "" if intlike else r.parent() if hasattr(r, 'parent') else type(r).__name__
        print(label, "->", repr(r), p) if p != "" else print(label, "->", repr(r))
    except Exception as e:
        print(label, "!!", type(e).__name__, str(e)[:120])
for nm, R in [("RR", RR), ("R30", RealField(30)), ("R100", RealField(100))]:
    z, n, o = R(-0.0), R(0), R(1)
    inf = R('inf')
    rows = [
        ("R(-0.0)", lambda: R(-0.0)), ("R('-0')", lambda: R('-0')), ("-R(0)", lambda: -n), ("R(0)*-1", lambda: n * -1),
        ("R(-0)*5", lambda: z * R(5)), ("R(0)*-5", lambda: n * R(-5)), ("-0*-5", lambda: z * R(-5)), ("-0*0", lambda: z * n),
        ("-0+-0", lambda: z + z), ("-0+0", lambda: z + n), ("0+-0", lambda: n + z), ("-0-0", lambda: z - n), ("0-0", lambda: n - n),
        ("-0--0", lambda: z - z), ("x-x", lambda: R(3) - R(3)), ("-x+x", lambda: R(-3) + R(3)), ("-0+3", lambda: z + R(3)),
        ("0/-5", lambda: n / R(-5)), ("-0/5", lambda: z / R(5)), ("-0/-5", lambda: z / R(-5)), ("1/-0", lambda: o / z), ("-1/-0", lambda: -o / z),
        ("1/-inf", lambda: o / -inf), ("-5/inf", lambda: R(-5) / inf), ("1/R(-0)", lambda: 1 / z),
        ("-0^2", lambda: z ^ 2), ("-0^3", lambda: z ^ 3), ("-0^-2", lambda: z ^ -2), ("-0^-3", lambda: z ^ -3), ("-0^0", lambda: z ^ 0),
        ("-inf^-3", lambda: (-inf) ^ -3), ("-inf^-2", lambda: (-inf) ^ -2), ("-0^R(3)", lambda: z ^ R(3)), ("-0^R(2)", lambda: z ^ R(2)),
        ("-0^R(-3)", lambda: z ^ R(-3)), ("-0^R(0.5)", lambda: z ^ R(0.5)), ("-0^R(-0.5)", lambda: z ^ R(-0.5)), ("-inf^R(-3)", lambda: (-inf) ^ R(-3)),
        ("R(-2)^(-2^70)", lambda: R(-2) ^ (-2 ^ 70)), ("R(-2)^(-2^70-1)", lambda: R(-2) ^ (-2 ^ 70 - 1)),
        ("-0%3", lambda: z % R(3)), ("-3%3", lambda: R(-3) % R(3)), ("3%-3", lambda: R(3) % R(-3)), ("-6%4", lambda: R(-6) % R(4)),
        ("sqrt(-0)", lambda: z.sqrt()), ("abs(-0)", lambda: abs(z)), ("sin(-0)", lambda: z.sin()), ("tan(-0)", lambda: z.tan()),
        ("atan(-0)", lambda: z.arctan()), ("asin(-0)", lambda: z.arcsin()), ("sinh(-0)", lambda: z.sinh()), ("tanh(-0)", lambda: z.tanh()),
         ("exp(-0)", lambda: z.exp()), ("cos(-0)", lambda: z.cos()), ("log(-0)", lambda: z.log()),
        ("float(-0)", lambda: float(z)), ("str(-0)", lambda: str(z)), ("sign(-0)", lambda: z.sign()), ("is_zero", lambda: z.is_zero()),
        ("==0", lambda: z == 0), ("hash", lambda: hash(z) == hash(n)), ("sme", lambda: z.sign_mantissa_exponent()),
        ("RR(R(-0))", lambda: RR(z)), ("R100(R(-0))", lambda: RealField(100)(z)), ("R30(R(-0))", lambda: RealField(30)(z)),
        ("QQ(-0)", lambda: QQ(z)), ("ZZ(-0)", lambda: ZZ(z)), ("int(-0)", lambda: int(z)), ("-0<0", lambda: z < n), ("-0.floor", lambda: z.floor()),
        ("R(-0.5).round", lambda: R(-0.5).round()), ("R(-0.4).trunc", lambda: R(-0.4).trunc()), ("-0*inf", lambda: z * inf),
        ("-0+R(-1e-300)", lambda: z + R(-1e-300)), ("R(-1e-300)*1e-300", lambda: R(-1e-300) * R(1e-300)),
        ("-0.nan", lambda: z.is_NaN()), ("sqrt(-0)^2", lambda: z.sqrt() ^ 2), ("-(-0)", lambda: -z), ("-0*QQ(3)", lambda: z * QQ(3)),
        ("-0*2", lambda: z * 2), ("-0+QQ(0)", lambda: z + QQ(0)), ("-0-QQ(0)", lambda: z - QQ(0)), ("2*-0", lambda: 2 * z),
        ("-0/QQ(2)", lambda: z / QQ(2)), ("QQ(1)/-0", lambda: QQ(1) / z),
    ]
    for lab, f in rows:
        if nm == "RR" and lab in ("sme", "R(-0.4).trunc", "-0.nan"):
            continue
        show("%s %s" % (nm, lab), f)
# exact cancellation and two zeros by rounding mode: -0 rounding down
for rnd in ["RNDN", "RNDZ", "RNDU", "RNDD"]:
    R = RealField(30, rnd=rnd)
    z, n = R(-0.0), R(0)
    for lab, f in [("3-3", lambda: R(3) - R(3)), ("-3+3", lambda: R(-3) + R(3)), ("-0+0", lambda: z + n), ("0+-0", lambda: n + z),
                   ("-0-(-0)", lambda: z - z), ("-0+-0", lambda: z + z), ("0-0", lambda: n - n), ("-0*1", lambda: z * R(1)),
                   ("R(-1e-300)/2^(2^62)", lambda: R(-1e-300) / R(2) ^ (2 ^ 62))]:
        show("%s %s" % (rnd, lab), f)
# shifts as Sage's: an integral count with |n| <= 2^63 - 1 (else
# OverflowError; a fractional count TypeError), a zero keeping its sign;
# frac() of an integer, a zero or an infinity a signed zero; "-0" in other
# bases (reciprocals show the zero's sign)
for nm, R in [("R30", RealField(30)), ("R100", RealField(100))]:
    for v in ["0", "-0", "3", "-3", "inf", "-inf", "nan"]:
        x = R(v)
        for n in [0, 1, 2, -2, 2^62, 2^63 - 1, 2^63, 2^64, -2^63, -2^63 - 1, -2^64, 1.5, RR(2), QQ(2), 1/2]:
            show("%s(%s)<<%s" % (nm, v, n), lambda: x << n)
            show("%s(%s)>>%s" % (nm, v, n), lambda: x >> n)
            if v in ("0", "-0") and n in (0, 2, -2):
                show("1/(%s(%s)<<%s)" % (nm, v, n), lambda: 1 / (x << n))
                show("1/(%s(%s)>>%s)" % (nm, v, n), lambda: 1 / (x >> n))
    for v in ["0", "-0", "-3", "3", "-0.5", "0.5", "-2.75", "inf", "-inf", "nan", "-1e-300"]:
        show("%s(%s).frac()" % (nm, v), lambda: R(v).frac())
        show("1/%s(%s).frac()" % (nm, v), lambda: 1 / R(v).frac())
    for b in [2, 3, 8, 16, 36]:
        for s in ["-0", "-0.00", "0", "+0", "-0.0", "-1", "-0.1"]:
            show("%s(%r,base=%d)" % (nm, s, b), lambda: R(s, base=b))
            show("1/%s(%r,base=%d)" % (nm, s, b), lambda: 1 / R(s, base=b))
