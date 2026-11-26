# Elements of RR and CC in symbolic expressions where the doubles' steps
# leave the normal ones: Sage's RR and CC are MPFR numbers, whose exponents
# reach far past a double's, so such a result is done again in the 53-bit MP
# field, Sage's steps (a quotient a times 1/b, an integer power of CC
# generic_power), and kept when it is a double; a result that is not one is
# refused (the doctests in lib/_sage_expr.py and the engine's tests).  Each
# value is printed with its parts in hex.
def h(v):
    c = CC(v)
    return "%s  %s,%s" % (v, float(c.real()).hex(), float(c.imag()).hex())


# products and quotients by a real, operands past 2^510 or below 2^-510
print(h(SR(RR(2^600)) * SR(RR(2^-600))))
print(h(SR(RR(2^-1020)) * SR(RR(2^1000))))
print(h(SR(RR(2^-600)) / SR(RR(2^-600))))
print(h(SR(CC(2^600, 1)) * SR(RR(2^-600))))
print(h(SR(CC(1e300, 1e300)) / SR(RR(1e300))))
print(h(SR(CC(1e-300, -1e-300)) / SR(RR(-1e-300))))
print(h(SR(CC(2^600, 1)) / SR(RR(0.1))))

# a quotient by an element of CC: a times 1/b, each step rounded
print(h(SR(RR(1.5)) / SR(CC(1, 1))))
print(h(SR(RR(1.5)) / SR(CC(1e300, 1e300))))
print(h(SR(RR(1.5)) / SR(CC(0, 2^700))))
print(h(SR(RR(1.5)) / SR(CC(700, 3))))
print(h(SR(RR(1.5)) / SR(CC(-800, 0.5))))
print(h(SR(RR(1.5)) / SR(CC(2^-1000, 2^-30))))
print(h(SR(RR(-2.25)) / SR(CC(1, 1))))
print(h(SR(RR(-2.25)) / SR(CC(1e300, 1e300))))
print(h(SR(RR(-2.25)) / SR(CC(0, 2^700))))
print(h(SR(RR(-2.25)) / SR(CC(700, 3))))
print(h(SR(RR(-2.25)) / SR(CC(-800, 0.5))))
print(h(SR(RR(-2.25)) / SR(CC(2^-1000, 2^-30))))
print(h(SR(RR(2^500)) / SR(CC(1, 1))))
print(h(SR(RR(2^500)) / SR(CC(2^600, 1))))
print(h(SR(RR(2^500)) / SR(CC(1e300, 1e300))))
print(h(SR(RR(2^500)) / SR(CC(0, 2^700))))
print(h(SR(RR(2^500)) / SR(CC(700, 3))))
print(h(SR(RR(2^500)) / SR(CC(-800, 0.5))))
print(h(SR(RR(2^500)) / SR(CC(2^-1000, 2^-30))))
print(h(SR(RR(-2^600)) / SR(CC(1, 1))))
print(h(SR(RR(-2^600)) / SR(CC(2^600, 1))))
print(h(SR(RR(-2^600)) / SR(CC(1e300, 1e300))))
print(h(SR(RR(-2^600)) / SR(CC(0, 2^700))))
print(h(SR(RR(-2^600)) / SR(CC(700, 3))))
print(h(SR(RR(-2^600)) / SR(CC(-800, 0.5))))
print(h(SR(RR(-2^600)) / SR(CC(2^-1000, 2^-30))))
print(h(SR(RR(1e300)) / SR(CC(1, 1))))
print(h(SR(RR(1e300)) / SR(CC(2^600, 1))))
print(h(SR(RR(1e300)) / SR(CC(1e300, 1e300))))
print(h(SR(RR(1e300)) / SR(CC(0, 2^700))))
print(h(SR(RR(1e300)) / SR(CC(700, 3))))
print(h(SR(RR(1e300)) / SR(CC(-800, 0.5))))
print(h(SR(CC(1, 1)) / SR(CC(2^600, 1))))
print(h(SR(CC(-2^-520, 2^520)) / SR(CC(1e300, 1e300))))

# a quotient whose inverse has a part past the doubles, though the operands
# and the quotient are in range (1/b's lost part changes the product)
for e in [400, 510]:
    a, b = CC(2^-e, -2^e), CC(2^e, -2^-e)
    print(h(SR(a) / SR(a)), h(SR(a) / SR(b)), h(SR(b) / SR(a)))
print(h(SR(CC(-2^-450, 2^450)) / SR(CC(2^450, 2^-450))), h(SR(CC(2^300, 2^-300)) / SR(CC(-2^-300, -2^300))))

# an integer power of an element of CC: Sage's generic_power
print(h(SR(CC(1, 1))^2))
print(h(SR(CC(1, 1))^3))
print(h(SR(CC(1, 1))^-1))
print(h(SR(CC(1, 1))^-2))
print(h(SR(CC(1, 1))^5))
print(h(SR(CC(-800, 0.5))^2))
print(h(SR(CC(-800, 0.5))^3))
print(h(SR(CC(-800, 0.5))^-1))
print(h(SR(CC(-800, 0.5))^-2))
print(h(SR(CC(-800, 0.5))^5))
print(h(SR(CC(2^-1000, 2^-30))^2))
print(h(SR(CC(2^-1000, 2^-30))^3))
print(h(SR(CC(2^-1000, 2^-30))^-1))
print(h(SR(CC(2^-1000, 2^-30))^-2))
print(h(SR(CC(1e-300, -1e-300))^-1))
print(h(SR(CC(700, 3))^2))
print(h(SR(CC(700, 3))^3))
print(h(SR(CC(700, 3))^-1))
print(h(SR(CC(700, 3))^-2))
print(h(SR(CC(700, 3))^5))

# |z| and log z where z's square leaves the doubles
print(h(abs(SR(CC(1e300, 1e300)))))
print(h(log(SR(CC(1e300, 1e300)))))
print(h(abs(SR(CC(0, 2^700)))))
print(h(log(SR(CC(0, 2^700)))))
print(h(abs(SR(CC(1e-300, -1e-300)))))
print(h(log(SR(CC(1e-300, -1e-300)))))
print(h(abs(SR(CC(-2^-520, 2^520)))))
print(h(log(SR(CC(-2^-520, 2^520)))))
print(h(abs(SR(RR(-1e-200)))))
print(h(log(SR(RR(-2^600)))))

# in range, as before
print(h(SR(RR(1.5)) * SR(RR(2.25))))
print(h(SR(CC(1, 2))^3))
print(h(exp(SR(RR(700)))))
print(h(SR(RR(oo)) * SR(RR(2))))
print(h(SR(RDF(1e300)) * SR(RDF(1e300))))
