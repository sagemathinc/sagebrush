# Sage mode under the shared Conway cap (_sage_ff.CONWAY_WORK, as Magma's
# GF): GF(q) and conway_polynomial refuse a cold search past it in words,
# before the field is made, keeping the polynomial cache as it was
# (transactional); a cache hit is free.  Run by test/conway-sage.test.ts;
# test/conway_sage_cases.out is its output.
import _sage_ff as sff
from sage_all import GF, conway_polynomial, PolynomialRing

print("cap", sff.CONWAY_WORK)
EXACT = 1770107  # GF(2^12)'s cold charge (test/conway_cold_oracle.json)
gf = sff.GF


def attempt(label, cap, f):
    sff._CONWAY.clear()
    before = list(sff._CONWAY.items())
    sff.CONWAY_WORK = cap
    try:
        r = f()
        print(label, "admitted", r, sorted(sff._CONWAY))
    except NotImplementedError as e:
        print(label, "refused", type(e).__name__, list(sff._CONWAY.items()) == before, str(e))


attempt("GF short", EXACT - 1, lambda: GF(2 ** 12))
attempt("GF prefix short", EXACT - 1, lambda: GF(2 ** 12, prefix="w"))
attempt("conway_polynomial short", EXACT - 1, lambda: conway_polynomial(2, 12))
attempt("GF exact", EXACT, lambda: GF(2 ** 12))
attempt("conway_polynomial exact", EXACT, lambda: conway_polynomial(2, 12))
# a cache hit is free: no budget at all is needed then
sff.CONWAY_WORK = 0
print("hit", conway_polynomial(2, 12) == sff.PolynomialRing_ff(GF(2), "x")(sff._CONWAY[(2, 12)]))
# a given modulus needs no Conway search
R = PolynomialRing(GF(2), "x")
x = R.gen()
print("modulus", GF(2 ** 3, "c", modulus=x ** 3 + x + 1))
sff.CONWAY_WORK = 653528895
