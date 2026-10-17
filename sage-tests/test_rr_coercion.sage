# RR, RDF, RealField(30), RealField(100) and RR past the doubles against
# each other and QQ, ZZ, int, float and bool, every operation both ways, as
# Sage coerces them: arithmetic in the coarser (a double counts as 53 bits:
# RealField(100) with a Python float is a float, with RDF RDF's, RealField(30)
# with either RealField(30)); a power between real fields in the base's field
def show(label, f):
    try:
        r = f()
        print(label, "->", repr(r), type(r).__name__ if isinstance(r, bool) or not hasattr(r, "parent") else r.parent())
    except Exception as e:
        print(label, "!!", type(e).__name__, e)
R30 = RealField(30); R100 = RealField(100)
reals = [("RR", RR(2.5)), ("RDF", RDF(2.5)), ("R30", R30(2.5)), ("R100", R100(2.5)), ("RRbig", RR(2)^1100)]
others = [("QQ", QQ(1/3)), ("ZZ", ZZ(3)), ("int", int(3)), ("float", float(0.5)), ("bool", True)]
ops = [("+", lambda a, b: a + b), ("-", lambda a, b: a - b), ("*", lambda a, b: a * b), ("/", lambda a, b: a / b), ("^", lambda a, b: a ^ b), ("==", lambda a, b: a == b), ("<", lambda a, b: a < b)]
for an, a in reals:
    for bn, b in reals + others:
        if an == bn: continue
        for on, op in ops:
            show("%s %s %s" % (an, on, bn), lambda: op(a, b))
            if bn not in [n for n, _ in reals]:
                show("%s %s %s" % (bn, on, an), lambda: op(b, a))

# operands are rounded into the coarser field before the arithmetic (a 53-bit
# midpoint of R30 rounds to even first); x^0, 1^y and an infinite base keep
# Sage's identities in the field the power is in
def show3(label, f, scale=0):
    try:
        r=f()
        print(label, '=>', r.exact_rational()/QQ(2)^scale if scale else repr(r), r.parent() if hasattr(r,'parent') else type(r).__name__)
    except Exception as e: print(label, '!!', type(e).__name__, e)
R=RealField(30)
a=R(2)^940
b=RR(1+QQ(1)/2^30)*RR(2)^1100
show3('small + midpoint',lambda:a+b,1100)
show3('midpoint + small',lambda:b+a,1100)
show3('explicitly coerced control',lambda:a+R(b),1100)
for p in [30,52]:
    R=RealField(p)
    for name, T in [('float',float), ('RDF',RDF)]:
        show3(str((p,name,'0^0')),lambda:R(0)^T(0))
        show3(str((p,name,'1^inf')),lambda:R(1)^T('inf'))
        show3(str((p,name,'1^nan')),lambda:R(1)^T('nan'))
    show3(str((p,'RDF(-inf)^2')),lambda:RDF('-inf')^R(2))
