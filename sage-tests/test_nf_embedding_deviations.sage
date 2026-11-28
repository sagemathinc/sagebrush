# Deliberate deviations from Sage (test_nf_embedding_deviations.deviations.md):
# the nearest root, decided exactly, and RealField(p) of an element under a
# complex or QQbar embedding, as ComplexField(p)(z).real().  The .out is
# Sagebrush's, pinned: it must not be regenerated from Sage.
def show(label, f):
    try:
        print(label, "|", f())
    except Exception as e:
        print(label, "|", type(e).__name__, e)
x = polygen(QQ, 'x')
f = (x - 1)^2 - QQ(2)/QQ(2)^200
K = NumberField(f, 'u', embedding=1 + QQ(2)^-90); u = K.gen()
show("(x-1)^2 - 2/2^200 at 1 + 2^-90: u > 1, (u - 1).sign()", lambda: (u > 1, (u - 1).sign()))
for n, e in [("ComplexField(100)(1.4)", ComplexField(100)(1.4)), ("QQbar(2).sqrt()", QQbar(2).sqrt())]:
    K = NumberField(x^2 - 2, 'a', embedding=e); a = K.gen()
    for p in [10, 20, 53]:
        show("x^2 - 2 at %s: RealField(%d)(a), ComplexField(%d)(a).real(), as rationals" % (n, p, p), lambda: (RealField(p)(a).exact_rational(), ComplexField(p)(a).real().exact_rational()))
