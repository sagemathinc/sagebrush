# A vector over GF(q) or RDF divided by a Python int, an Integer, a str or a list, as Sage (grader's #767 F3 and F5):
# v / c is v * (1/c) with 1/c in c's own ring, so an integer's inverse is in QQ (a product GF(7) refuses, rational
# division by zero for 0), and a divisor nothing can divide by is refused naming the vector's parent and its class.
def show(label, f):
    try:
        print(label, "->", f())
    except Exception as e:
        print(label, "->", "%s: %s" % (type(e).__name__, e))
v = vector(GF(7), [1, 2])
show("v / int(2)", lambda: v / int(2))
show("v / int(0)", lambda: v / int(0))
show("v / 2", lambda: v / 2)
show("v / 0", lambda: v / 0)
show("v / GF(7)(2)", lambda: v / GF(7)(2))
show("v / 'a'", lambda: v / "a")
show("v / [1]", lambda: v / [1])
u = vector(RDF, [1, 2])
show("RDF v / int(2)", lambda: u / int(2))
show("RDF v / int(0)", lambda: u / int(0))
show("RDF v / 'a'", lambda: u / "a")
show("RDF v / (1,)", lambda: u / (1,))
# A divisor whose class has its own __rtruediv__ (grader's r767f R1 and F5b): Sage refuses it too, naming the class,
# and never calls D.__rtruediv__
class D:
    def __rtruediv__(self, other):
        if isinstance(other, int):
            raise TypeError("D: no int")
        return "D.__rtruediv__"
for K in [GF(7), RDF, CDF]:
    show("vector(%s, [1, 2]) / D()" % K, lambda: vector(K, [1, 2]) / D())
show("int(1) / D()", lambda: int(1) / D())
# A zero of a field the vector's ring reaches is that field's own error, not the refusal (grader's r767g N3):
# only a TypeError from the inverse is "unsupported operand parent(s)"; RDF, RR and CDF divide by their zero.
for v, z in [(vector(GF(7), [1, 2]), GF(7)(0)), (vector(GF(7), [1, 2]), GF(49, 'a')(0)), (vector(GF(7), [1, 2]), ZZ(0)),
             (vector(RDF, [1, 2]), RDF(0)), (vector(RR, [1, 2]), RR(0)), (vector(CDF, [1, 2]), CDF(0))]:
    show("vector(%s, [1, 2]) / %s(0)" % (v.base_ring(), z.parent()), lambda: v / z)
