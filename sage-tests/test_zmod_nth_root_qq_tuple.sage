# Zmod(n)'s k-th roots for negative and zero k, as Sage's (the sets: sorted;
# a single root's absence as its error), and QQ((numerator, denominator))
def show(label, f):
    try:
        print(label, "|", f())
    except Exception as e:
        print(label, "|", type(e).__name__)
for n in [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 15, 16, 21, 25, 27]:
    for a in range(n):
        for k in [-3, -2, -1, 0]:
            x = Zmod(n)(a)
            show("Zmod(%d)(%d).nth_root(%d, all=True)" % (n, a, k), lambda: sorted(int(t) for t in x.nth_root(k, all=True)))
            show("Zmod(%d)(%d).nth_root(%d) is a root" % (n, a, k), lambda: (lambda r: (r**k == x if k else r != 0))(x.nth_root(k)))
for e, f in [("QQ((1,2))", lambda: QQ((1,2))), ("QQ((6,-4))", lambda: QQ((6,-4))), ("QQ((-3,9))", lambda: QQ((-3,9))),
             ("QQ((int(3), int(4)))", lambda: QQ((int(3), int(4)))), ("QQ(('1','2'))", lambda: QQ(('1','2'))),
             ("QQ((1,2), 3)", lambda: QQ((1,2), 3)), ("QQ([1,2])", lambda: QQ([1,2])), ("QQ((1,0))", lambda: QQ((1,0))),
             ("QQ((1,2,3))", lambda: QQ((1,2,3))), ("QQ((1,))", lambda: QQ((1,))), ("QQ(())", lambda: QQ(()))]:
    show(e, lambda: (lambda v: (v, v.parent()))(f()))
# a prime modulus after is_field() (its field's root route): the same rules
for p in [5, 7, 11]:
    R = Zmod(p); R.is_field()
    for a in range(p):
        for k in [-3, -2, -1, 0]:
            x = R(a)
            show("is_field Zmod(%d)(%d).nth_root(%d, all=True)" % (p, a, k), lambda: sorted(int(t) for t in x.nth_root(k, all=True)))
# a single root for k < 0 is (x^-1).nth_root(-k), Sage's rule (the sets above
# are the claim; which single root k > 0 gives is issue #2414)
for n in [5, 8, 9, 15, 16]:
    for a in range(n):
        if gcd(a, n) == 1:
            for k in [-1, -2, -3]:
                x = Zmod(n)(a)
                show("Zmod(%d)(%d).nth_root(%d) == (x^-1).nth_root(%d)" % (n, a, k, -k), lambda: x.nth_root(k) == (x**-1).nth_root(-k))
# a non-integer exponent: TypeError
show("Zmod(9)(1).nth_root(1/2)", lambda: Zmod(9)(1).nth_root(1/2))
show("Zmod(9)(1).nth_root(1/2, all=True)", lambda: Zmod(9)(1).nth_root(1/2, all=True))
show("GF(5)(1).nth_root(1/2)", lambda: GF(5)(1).nth_root(1/2))
# the error messages, as Sage's: empty for k <= 0, "no nth root" for k > 0
for e, f in [("GF(13)(4).nth_root(0)", lambda: GF(13)(4).nth_root(0)), ("GF(13)(0).nth_root(-2)", lambda: GF(13)(0).nth_root(-2)),
             ("Zmod(4)(2).nth_root(-1)", lambda: Zmod(4)(2).nth_root(-1)), ("Zmod(4)(3).nth_root(0)", lambda: Zmod(4)(3).nth_root(0)),
             ("Zmod(4)(3).nth_root(2)", lambda: Zmod(4)(3).nth_root(2)), ("Zmod(8)(3).nth_root(2)", lambda: Zmod(8)(3).nth_root(2))]:
    try:
        print(e, "|", f())
    except ValueError as err:
        print(e, "| ValueError", repr(str(err)))
