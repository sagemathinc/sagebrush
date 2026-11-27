# RDF and CDF where Sage's GSL is less exact than IEEE arithmetic: sagebrush
# keeps the IEEE values here, on purpose (the ruling on #2242).
# The .out is HAND-WRITTEN, sagebrush's output, each value checked against
# the true one (mpmath, 200 bits); do NOT regenerate it from Sage.  Each row
# says the true value and what Sage gives.
def show(label, f):
    try:
        print(label, "|", f())
    except Exception as e:
        print(label, "|", type(e).__name__)

# exp below -708.4: subnormal doubles (Sage's GSL: 0.0, an underflow)
show("RDF exp(-709)", lambda: RDF(-709).exp())    # true 1.216780750623423e-308
show("RDF exp(-720)", lambda: RDF(-720).exp())    # true 2.0322308024e-313
show("RDF exp(-745)", lambda: RDF(-745).exp())    # true 5e-324 (rounded)
# sinh and cosh at 710 are doubles, 1.1169973830808555e+308 (Sage: +infinity)
show("RDF sinh(710) finite", lambda: (lambda v: not v.is_infinity() and v > 1.1e308)(RDF(710).sinh()))
show("RDF cosh(-710) finite", lambda: (lambda v: not v.is_infinity() and v > 1.1e308)(RDF(-710).cosh()))
# tanh past 710 is +-1 (Sage's GSL: NaN, its inf/inf)
show("RDF tanh(710)", lambda: RDF(710).tanh())
show("RDF tanh(-1000)", lambda: RDF(-1000).tanh())
show("SR tanh(RDF(10^6))", lambda: tanh(SR(RDF(10^6))))
# a real argument's imaginary part is 0, not NaN (Sage's GSL: inf * sin 0)
show("CDF exp(1000)", lambda: CDF(1000, 0).exp())          # Sage: +infinity + NaN*I
show("CDF sinh(1000)", lambda: CDF(1000, 0).sinh())        # Sage: +infinity + NaN*I
show("CDF cosh(-746)", lambda: CDF(-746, 0).cosh())        # Sage: +infinity + NaN*I
# e^(710 + 3i): the imaginary part e^710 sin 3 is a double (Sage's CDF:
# +infinity*I; Sage's SR agrees with sagebrush)
show("CDF exp(710+3i)", lambda: CDF(710, 3).exp())
show("SR exp(CDF(710+3i))", lambda: exp(SR(CDF(710, 3))))
# in SR, as plain CDF (Sage's SR, by GiNaC's formulas: NaN + NaN*I)
show("SR sinh(CDF(1000+i))", lambda: sinh(SR(CDF(1000, 1))))
show("SR cosh(CDF(-1000+i))", lambda: cosh(SR(CDF(-1000, 1))))
show("SR tanh(CDF(1000+i))", lambda: tanh(SR(CDF(1000, 1))))
# sinh and cosh past |x| = 709 with a part a double: e^710.5 cos(pi/3)/2 is
# 9.208086724008932e+307, the true value; the imaginary part is within one ulp
# of the true one, since sin(pi/3) is a rounded double first (Sage's CDF:
# +infinity + +infinity*I; its SR: NaN + NaN*I)
y = RDF(pi/3)
show("CDF sinh(710.5+i pi/3)", lambda: CDF(710.5, y).sinh())
show("SR sinh(CDF(710.5+i pi/3))", lambda: sinh(SR(CDF(710.5, y))))
show("SR sinh(CDF(-710.5+i pi/3))", lambda: sinh(SR(CDF(-710.5, y))))
show("CDF cosh(710.5+i pi/3)", lambda: CDF(710.5, y).cosh())
show("SR cosh(CDF(-710.5+i pi/3))", lambda: cosh(SR(CDF(-710.5, y))))
# a NaN or an infinity in a part, in SR: as plain CDF (Sage's SR gives 0,
# 0.0, OverflowError or ValueError here, by GiNaC's formulas)
i_, n_ = float('inf'), float('nan')
for z in [(1000, i_), (1000, n_), (n_, 1), (i_, 1), (710, i_)]:
    for name, f in [("exp", exp), ("sinh", sinh), ("cosh", cosh), ("tanh", tanh)]:
        show("SR %s %s" % (name, z), lambda: f(SR(CDF(*z))))
# an infinite argument: exp(+infinity) has imaginary part 0, tanh(+-infinity)
# is +-1 (Sage's GSL: +infinity + NaN*I, and NaN, its inf/inf)
show("CDF exp(+inf)", lambda: CDF(float('inf'), 0).exp())
show("RDF tanh(+inf)", lambda: RDF(float('inf')).tanh())
show("RDF tanh(-inf)", lambda: RDF(float('-inf')).tanh())
# sinh and cosh past |x| = 709 with the least subnormal sin y: the imaginary
# part e^1000 sin(y)/2 is +-4.866722286500082e+110, the 1/2 kept in the
# exponent rather than rounding sin(y)/2 to 0 first (Sage's CDF:
# +-infinity*I; its SR: NaN)
t = 5e-324
for z in [(1000, t), (1000, -t), (-1000, t)]:
    show("CDF sinh %s" % (z,), lambda: CDF(*z).sinh())
    show("CDF cosh %s" % (z,), lambda: CDF(*z).cosh())
    show("SR sinh %s" % (z,), lambda: sinh(SR(CDF(*z))))
    show("SR cosh %s" % (z,), lambda: cosh(SR(CDF(*z))))
# tanh with |y| > DBL_MAX/2, where 2y leaves the doubles: sin(2y)/2 as
# sin(y) cos(y).  True values: tanh(1000 + 1e308 i) = 1.0 - 0.0 i,
# tanh(-1000 - 1e308 i) = -1.0 + 0.0 i, tanh(0.5 + 1e308 i) =
# 0.5512345821481115 - 0.37910598694810577 i, tanh(2 - 1.7e308 i) =
# 0.98878040528907 + 0.03466066108563915 i; the imaginary part at 0.5 is
# within one ulp of the true one (Sage's CDF: a NaN imaginary part,
# sin(inf); its SR: NaN + NaN*I past |x| = 709)
for z in [(1000, 1e308), (-1000, -1e308), (0.5, 1e308), (2, -1.7e308)]:
    show("CDF tanh %s" % (z,), lambda: CDF(*z).tanh())
    show("CDF tanh %s imag" % (z,), lambda: CDF(*z).tanh().imag())
for z in [(1000, 1e308), (-1000, -1e308)]:
    show("SR tanh %s" % (z,), lambda: tanh(SR(CDF(*z))))
    show("SR tanh %s imag" % (z,), lambda: tanh(SR(CDF(*z))).imag())
