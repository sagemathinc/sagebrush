# An ideal compared with an element, checked against Sage: I == f is
# I == R.ideal(f) for f in I's own ring R, or a scalar of R's base ring
# (associates by a unit: over a field a nonzero constant, over ZZ a sign);
# an element of another polynomial ring, a string, a list, None: unequal.
# Univariate (a principal ideal domain over a field; ZZ[t]) and
# multivariate (QQ[x,y], GF(7)[c,d]), both orders, == and !=.
# Expected output (test_ideal_element_eq.out): SageMath version 10.10, Release Date: 2026-09-28.
def row(label, f):
    try:
        print(label, f())
    except Exception as e:
        print(label, "ERR", type(e).__name__)

R.<t> = QQ[]
P.<u> = ZZ[]
F.<s> = GF(7)[]
S.<x,y> = QQ[]
G.<c,d> = GF(7)[]
Sx.<x1> = QQ[]
cases = [
    ("QQ[t] (2t) t", R.ideal(2*t), t), ("QQ[t] (2t) 2t", R.ideal(2*t), 2*t), ("QQ[t] (t^2) t", R.ideal(t^2), t),
    ("QQ[t] (t) 2", R.ideal(t), 2), ("QQ[t] (1) 3", R.ideal(1), 3), ("QQ[t] (1) int3", R.ideal(1), int(3)),
    ("QQ[t] (1) 1/2", R.ideal(1), QQ(1/2)), ("QQ[t] (t,t^2) t", R.ideal(t, t^2), t),
    ("QQ[t] (t^2-1,t-1) t-1", R.ideal(t^2 - 1, t - 1), t - 1), ("QQ[t] (0) 0", R.ideal(0), 0), ("QQ[t] (0) t", R.ideal(0), t),
    ("QQ[t] (t) 0", R.ideal(t), 0), ("QQ[t] (t) u", R.ideal(t), u), ("QQ[t] (1) P(1)", R.ideal(1), P(1)),
    ("QQ[t] (t) R(u)", R.ideal(t), R(u)), ("QQ[t] (1) GF5(1)", R.ideal(1), GF(5)(1)), ("QQ[t] (1) 2.0", R.ideal(1), 2.0),
    ("QQ[t] (t) 't'", R.ideal(t), 't'), ("QQ[t] (t) [t]", R.ideal(t), [t]), ("QQ[t] (t) None", R.ideal(t), None),
    ("QQ[t] (t) SR t", R.ideal(t), SR.var('t')),
    ("ZZ[t] (2u) u", P.ideal(2*u), u), ("ZZ[t] (-u) u", P.ideal(-u), u), ("ZZ[t] (u) u", P.ideal(u), u),
    ("ZZ[t] (2) 2", P.ideal(2), 2), ("ZZ[t] (2) -2", P.ideal(2), -2), ("ZZ[t] (2) 4", P.ideal(2), 4),
    ("ZZ[t] (2) QQ2", P.ideal(2), QQ(2)), ("ZZ[t] (2u+2) u+1", P.ideal(2*u + 2), u + 1), ("ZZ[t] (-2u) 2u", P.ideal(-2*u), 2*u),
    ("ZZ[t] (0) 0", P.ideal(0), 0), ("ZZ[t] (u) t", P.ideal(u), t),
    ("GF7[s] (3s) s", F.ideal(3*s), s), ("GF7[s] (3s) 2s", F.ideal(3*s), 2*s), ("GF7[s] (s) s+1", F.ideal(s), s + 1),
    ("QQ[x,y] (x) x", S.ideal(x), x), ("QQ[x,y] (2x) x", S.ideal(2*x), x), ("QQ[x,y] (x,y) x", S.ideal(x, y), x),
    ("QQ[x,y] (xy) x", S.ideal(x*y), x), ("QQ[x,y] (x,x^2) x", S.ideal(x, x^2), x), ("QQ[x,y] (1) 3", S.ideal(1), 3),
    ("QQ[x,y] (x+y,x-y) x", S.ideal(x + y, x - y), x), ("QQ[x,y] (x+y,x-y) 1", S.ideal(x + y, x - y), 1),
    ("QQ[x,y] (x) x1", S.ideal(x), x1), ("QQ[x,y] (x) t", S.ideal(x), t),
    ("GF7[c,d] (3c) c", G.ideal(3*c), c), ("GF7[c,d] (c,d) c", G.ideal(c, d), c),
]
for name, I, f in cases:
    row(name, lambda: "%d%d%d%d" % (I == f, f == I, I != f, f != I))
row("hash", lambda: hash(R.ideal(2*t)) == hash(R.ideal(t)))
row("ideal == ideal", lambda: (R.ideal(2*t) == R.ideal(t), R.ideal(0) == R.ideal(0), R.ideal(0) == R.ideal(t),
                               P.ideal(2*u) == P.ideal(u), P.ideal(-u) == P.ideal(u), P.ideal(2) == P.ideal(4)))
