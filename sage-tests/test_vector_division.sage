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
