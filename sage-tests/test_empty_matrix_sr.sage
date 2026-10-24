# The empty matrix compared with a symbolic scalar, checked against Sage:
# Sage meets a ring of positive characteristic and the symbolic ring in SR,
# so the 0 x 0 matrix (no entries to compare) equals every element of SR;
# a matrix with entries, or another shape, does not.  Other scalars as
# before (a common parent, or none: unequal).
# Expected output (test_empty_matrix_sr.out): SageMath version 10.10, Release Date: 2026-09-28.
def row(label, f):
    try:
        print(label, f())
    except Exception as e:
        print(label, "ERR", type(e).__name__)

x = var('x')
mats = [("GF5 0x0", matrix(GF(5), 0, 0)), ("GF9 0x0", matrix(GF(9, 'a'), 0, 0)), ("Zmod6 0x0", matrix(Zmod(6), 0, 0)),
        ("QQ 0x0", matrix(QQ, 0, 0)), ("ZZ 0x0", matrix(ZZ, 0, 0))]
scalars = [("SR0", SR(0)), ("SR1", SR(1)), ("x", x), ("pi", pi), ("RR1.5", RR(1.5)), ("float", 1.5), ("QQbar2", QQbar(2)),
           ("GF7", GF(7)(1)), ("GF5", GF(5)(3)), ("1/2", 1/2), ("str", "a"), ("None", None), ("[]", [])]
for mn, M in mats:
    print(mn, " ".join("%s:%d%d%d%d" % (sn, M == s, s == M, M != s, s != M) for sn, s in scalars))
# (Mod(5, 6) apart: GF(9) with Zmod(6) is not modelled in sagebrush)
for mn, M in mats:
    if mn != "GF9 0x0":
        row(mn + " Mod6", lambda: "%d%d" % (M == Mod(5, 6), Mod(5, 6) == M))
row("GF5 1x1 0 == SR0", lambda: matrix(GF(5), 1, 1) == SR(0))
row("GF5 [[1]] == SR1", lambda: matrix(GF(5), [[1]]) == SR(1))
row("Zmod6 [[1]] == SR1", lambda: matrix(Zmod(6), [[1]]) == SR(1))
row("QQ [[1]] == SR1", lambda: matrix(QQ, [[1]]) == SR(1))
row("QQ [[1]] == x", lambda: matrix(QQ, [[1]]) == x)
row("GF5 0x2 == SR0", lambda: matrix(GF(5), 0, 2) == SR(0))
row("QQ 0x2 == SR0", lambda: matrix(QQ, 0, 2) == SR(0))
row("GF5 empty vector == SR0", lambda: vector(GF(5), []) == SR(0))
