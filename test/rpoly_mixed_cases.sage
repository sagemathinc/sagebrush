# Sagebrush's own refusals for a polynomial over an inexact field with another ring (lib/_sage_rpoly.py
# _refuse_foreign; test/rpoly-mixed.test.ts; @sagebrush's #784 ruling): with a number field that has an
# embedding Sage computes (RR[t] + w*t is 2.41421356237310*t, L33), so sagebrush refuses rather than answer;
# Zmod(1)[u] is outside the class families probed in Sage.
def show(f):
    try:
        print(f())
    except Exception as e:
        print("%s: %s" % (type(e).__name__, e))
t = RR['t'].gen()
K.<w> = QuadraticField(2)
show(lambda: t + w * K['t'].gen())
show(lambda: K['t'].gen() + 1 == t + 1)
show(lambda: t(w))
show(lambda: (K['t'].gen() + 1)(t))
show(lambda: t / Zmod(1)['u'].gen())
