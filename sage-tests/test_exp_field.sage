# e^x for an element x of a real or complex field is x.exp() in x's own
# field, so a value past the doubles is an ordinary RR number; log(x, b) for
# a positive element x of a real field is x.log(b) in x's field; and n() of
# a constant expression whose double evaluation overflows inside
# (10^400*pi) is the 53-bit MP value, not NaN.
var('x')
def t(label, f):
    try:
        r = f()
        print(label, '::', r)
    except Exception as e:
        print(label, '::', type(e).__name__)

for v in [RR(2), RDF(2), 2.5, RealField(100)(2), CC(1, 2), CDF(1, 2), float(2), 727.951346801, -800.5, RR(0), 783964159852157952242.7155]:
    t('e^%r' % (v,), lambda: (e^v, (e^v).parent()))
for v in [RR(2), RDF(2), RealField(100)(2), RR(10)^400, 2.5, e^727.951346801]:
    for b in [10, 2, 3/2, RR(3), e]:
        t('log(%r, %r)' % (v, b), lambda: (log(v, b), log(v, b).parent()))
t('log of e^x', lambda: [N(log(e^727.951346801, 10)), log(e^727.951346801)])
t('back and forth', lambda: [(e^727.951346801).log(), (e^RR(-800)).log(), e^RR(1000) / e^RR(999)])
t('symbolic stays symbolic', lambda: [e^2, e^x, (e^2).parent(), log(8, 2), log(x, 10), log(2, 10)])
t('n past the doubles', lambda: [N(10^400*pi), N(-10^400*pi), N(10^-400*pi), N(sqrt(10^800)*e), N(exp(728)), N(pi^-700)])
t('n parent', lambda: [N(10^400*pi).parent(), N(10^400*pi) == RR(10)^400 * RR(pi)])
