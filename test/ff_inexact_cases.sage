# Sagebrush's own refusals for an inexact number with Zmod(n), finite fields and number fields (lib/_sage_ff.py
# refuse_inexact; test/ff-inexact.test.ts; L34): with a number field that has an embedding Sage computes
# (QuadraticField(2)(1) + RR(2) is 3.00000000000000, == compares values: L33), so sagebrush refuses rather than
# answer; Zmod(1) is outside the class families probed in Sage.
def show(f):
    try:
        print(f())
    except Exception as e:
        print("%s: %s" % (type(e).__name__, e))
K.<w> = QuadraticField(2)
show(lambda: w + RR(2))
show(lambda: RR(2) * K['t'].gen())
show(lambda: K(2) == RDF(2))
show(lambda: (K['t'].gen() + 1)(2.5r))
show(lambda: CyclotomicField(3).gen() * CC(1, 1))
show(lambda: Zmod(1)(0) + 2.0r)
show(lambda: Zmod(1)['u'].gen() * 2.0r)
