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
# 9.208086724008932e+307 (Sage's CDF: +infinity + +infinity*I; its SR: NaN + NaN*I)
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
