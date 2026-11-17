# Generate tests/lfun_reference.txt: L(E, s) by PARI/GP's lfun at 38 digits, run (not read) through Sage.
#
#     sage engine/lfun/gen/lfun_reference.sage > engine/lfun/tests/lfun_reference.txt
#
# For each curve: its minimal model, conductor, root number and a_p at the bad primes (what
# sagebrush-lfun is given), then L(E, s) at points s across the critical strip and outside it.
pari.set_real_precision(38)
R = RealField(128)

CURVES = [
    # (name, a-invariants): ranks 0 to 3 at small conductor, CM curves, larger conductors
    ("11a1", [0, -1, 1, -10, -20]),
    ("37a1", [0, 0, 1, -1, 0]),
    ("389a1", [0, 1, 1, -2, 0]),
    ("5077a1", [0, 0, 1, -7, 6]),
    ("27a1", [0, 0, 1, 0, -7]),
    ("32a1", [0, 0, 0, 4, 0]),
    ("36a1", [0, 0, 0, 0, 1]),
    ("49a1", [1, -1, 0, -2, -1]),
    ("121b1", None),
    ("N9995", [0, -1, 1, 5, 1]),
    ("N99974", [1, 0, 1, 11, -2]),
    ("N1057403", [0, 1, 1, 20, -30]),
    ("N22329098", [1, -1, 1, -100, 333]),
    ("rank5", [0, 0, 1, -79, 342]),
]
SMALL = [1, 2, 3, 1 + 2*I, 1 + 10*I, 0.5 + 3*I, 1 - 7*I, -1 + 2*I, 1.5 + 0.25*I, 4 - 3*I]
HIGH = [1 + 30*I, 0.75 + 50*I, 1 + 100*I]
HIGHER = [1 + 300*I, 1.25 - 1000*I]

print("# curve name a1 a2 a3 a4 a6 conductor root_number p:a_p at each bad prime")
print("# then: s_re s_im L_re L_im (PARI lfun at 38 digits)")
for name, a in CURVES:
    E = EllipticCurve(name) if a is None else EllipticCurve(a)
    E = E.minimal_model()
    N = E.conductor()
    bad = " ".join("%d:%d" % (p, E.ap(p)) for p in N.prime_factors())
    print("curve %s %s %d %d %s" % (name, " ".join(str(x) for x in E.a_invariants()), N, E.root_number(), bad))
    pe = pari(E)
    pts = SMALL + (HIGH if N < 10**5 else [1 + 30*I]) + (HIGHER if N < 1000 else [])
    for s in pts:
        s = CC(s)
        v = pari("lfun")(pe, pari(s))
        print("%r %r %s %s" % (float(s.real()), float(s.imag()), R(pari("real")(v)), R(pari("imag")(v))))
