# Principal ideals of Zmod(n)[t], n composite, compared as ideals and with
# an element, both orders, checked against Sage: Zmod(n)'s polynomials have
# more units than its constants (1 + 2t over Zmod(4)) and zero divisors (2t
# over Zmod(4)).  astra's vectors (CORR-SAGE102-1) are the first three.
# (t) against (t + 2t^2) is left out: Sage says False there, although
# t + 2t^2 = t (1 + 2t) with 1 + 2t a unit; sagebrush answers True
# (DOCTESTS.md, test/ideal-element-eq.test.ts).
# Expected output (test_ideal_zmod_eq.out): SageMath version 10.10, Release Date: 2026-09-28.
def row(label, f):
    try:
        print(label, f())
    except Exception as e:
        print(label, "ERR", type(e).__name__)

for n in (4, 6, 8, 9):
    R = PolynomialRing(Zmod(n), 't'); t = R.gen()
    pairs = [("t", "t+1", t, t + 1), ("t", "2t", t, 2*t), ("1", "1+2t", R(1), 1 + 2*t), ("t", "3t", t, 3*t),
             ("t", "-t", t, -t), ("2t", "2t+2", 2*t, 2*t + 2), ("2", "2t+2", R(2), 2*t + 2), ("2", "2+2t", R(2), 2 + 2*t),
             ("2t", "4t", 2*t, 4*t), ("2", "3", R(2), R(3)), ("0", "t", R(0), t), ("0", "0", R(0), R(0)),
             ("t^2", "t", t^2, t), ("2t", "t", 2*t, t), ("3", "1", R(3), R(1)), ("1+3t", "1", 1 + 3*t, R(1)), ("2", "4", R(2), R(4))]
    for a, b, g, h in pairs:
        row("Z%d (%s) (%s)" % (n, a, b), lambda: "%d%d%d%d" % (R.ideal(g) == R.ideal(h), R.ideal(h) == R.ideal(g),
                                                              R.ideal(g) != R.ideal(h), R.ideal(h) != R.ideal(g)))
        row("Z%d (%s) %s" % (n, a, b), lambda: "%d%d%d%d" % (R.ideal(g) == h, h == R.ideal(g), R.ideal(g) != h, h != R.ideal(g)))
