# Polynomial rings over inexact fields: the rows for the grader's r784 survivors (Q1 X1 X2 X3 C1 H1), as Sage 10.10.
# Q1 equality compares the whole polynomial; X1 another variable is Sage's TypeError, naming the first; X3 a
# negative shift drops the low terms; X2 a polynomial over QQ times the symbolic I (its value: its parent is the
# Symbolic Ring here and QQ[I] in Sage, the sage functionality todo's L21, so it is not printed); C1 a zero
# coefficient keeps its signs, and a CDF zero prints 0.0; H1 equal polynomials over CC and RR hash alike.
def show(label, f):
    try:
        print(label, "->", f())
    except Exception as e:
        print(label, "->", "%s: %s" % (type(e).__name__, e))
for K in [RR, CDF]:
    R.<t> = K[]
    show("%s R(1) == t + 1" % K, lambda: R(1) == t + 1)
    show("%s t + 1 == R(1)" % K, lambda: t + 1 == R(1))
x, y, z, t = SR.var('x y z t')
for K in [RR, CDF, RealField(80)]:
    R = K['t']
    for e in [x + y, y + x*t, z + y, t + y, x*y, sin(x)]:
        show("%s[t](%s)" % (K, e), lambda: R(e))
R.<t> = RR[]
show("RR (t^3 + 2*t + 1).shift(-1)", lambda: (t^3 + 2*t + 1).shift(-1))
show("RR (t^3 + 2*t + 1).shift(-1).parent()", lambda: (t^3 + 2*t + 1).shift(-1).parent())
S.<s> = QQ[]
show("QQ (s + 1) * I", lambda: (s + 1) * I)
show("QQ I * (s + 1)", lambda: I * (s + 1))
show("QQ (s^2 + 1)*I + s", lambda: (s^2 + 1)*I + s)
U.<u> = CDF[]
def parts(p):
    return [str(c.real()) + "/" + str(c.imag()) for c in p.list()]
for n, f in [("list -0-0i", lambda: U([1, CDF(-0.0, -0.0), 2])), ("list -0+0i", lambda: U([1, CDF(-0.0, 0), 2])), ("list 0-0i", lambda: U([1, CDF(0, -0.0), 2])),
             ("const -0", lambda: U([CDF(-0.0), 1])), ("times -0", lambda: (u^2 + 1) * CDF(-0.0)), ("sub", lambda: (u^2 + u + 1) - (u + 1)),
             ("neg", lambda: -(u^2 + 1)), ("prod", lambda: (u + 1) * (u - 1)), ("sq", lambda: (u - CDF(0, 1))^2), ("from RR", lambda: U(RR['t']([1, -0.0, 2])))]:
    p = f()
    print(n, "|", p, "|", p.list(), "|", parts(p))
for w in [CDF(-0.0, -0.0), CDF(-0.0, 0), CDF(0, -0.0), CDF(-0.0), CDF(1, -0.0), CDF(-0.0, 1), CDF(-0.0, -1), CDF(-1, -0.0), RDF(-0.0)]:
    print(repr(w), [w], w.real(), w.imag())
show("hash CC['t']([1, 2]) == hash RR['t']([1, 2])", lambda: hash(CC['t']([1, 2])) == hash(RR['t']([1, 2])))
show("CC['t']([1, 2]) == RR['t']([1, 2])", lambda: CC['t']([1, 2]) == RR['t']([1, 2]))
