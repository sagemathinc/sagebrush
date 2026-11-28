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
