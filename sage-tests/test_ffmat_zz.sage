# A matrix over GF(p) or Z/n with one over ZZ: in GF(p) (Z/n), as Sage coerces
# ZZ into every ring, for *, + and - in both orders; with one over QQ, Sage's
# TypeError; operands of the wrong shapes, Sage's TypeError naming them.
def show(label, f):
    try:
        r = f()
        print(label)
        print(r.parent())
        print(r)
    except TypeError as e:
        print(label, "TypeError:", e)

for F in [GF(101), GF(2), Zmod(12), GF(9223372036854775783)]:
    B = matrix(F, 2, 2, [1, 2, 3, 4])
    Z = matrix(ZZ, 2, 2, [5, -6, 7, 8])
    Q = matrix(QQ, 2, 2, [1/2, 1, 2, 3])
    for name, M in [("ZZ", Z), ("QQ", Q)]:
        show("B * %s" % name, lambda: B * M)
        show("%s * B" % name, lambda: M * B)
        show("B + %s" % name, lambda: B + M)
        show("%s + B" % name, lambda: M + B)
        show("B - %s" % name, lambda: B - M)
        show("%s - B" % name, lambda: M - B)

F = GF(101)
B = matrix(F, 2, 2, [1, 2, 3, 4])
Z23 = matrix(ZZ, 2, 3, [1, 2, 3, 4, 5, 6])
Z33 = matrix(ZZ, 3, 3, list(range(9)))
Z32 = matrix(ZZ, 3, 2, [1, -2, 3, -4, 5, -6])
show("B * Z23", lambda: B * Z23)
show("Z32 * B", lambda: Z32 * B)
show("Z23 * B", lambda: Z23 * B)
show("B * Z33", lambda: B * Z33)
show("B + Z33", lambda: B + Z33)
show("Z33 - B", lambda: Z33 - B)
# (empty shapes: their parents)
print("0x2 ZZ * B", (matrix(ZZ, 0, 2, []) * B).parent())
print("B * 2x0 ZZ", (B * matrix(ZZ, 2, 0, [])).parent())
# a larger product, by its entries' sum and a few entries
A = matrix(F, 20, 30, [(i * 7 + 3) % 101 for i in range(600)])
W = matrix(ZZ, 30, 25, [(-1) ** i * (i % 97) for i in range(750)])
P = A * W
print(P.parent(), sum(int(x) for x in P.list()), P[0, 0], P[19, 24])
P = W.transpose() * A.transpose()
print(P.parent(), sum(int(x) for x in P.list()), P[0, 0], P[24, 19])
