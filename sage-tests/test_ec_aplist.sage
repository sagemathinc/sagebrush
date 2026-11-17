# aplist(n): a_p for every prime p <= n, a prime n included; anlist(n) uses it.
for lab in ["11a1", "37a1", "389a1", "27a1"]:
    E = EllipticCurve(lab)
    for n in [0, 1, 2, 3, 4, 5, 11, 12, 13, 37, 38]:
        print(lab, n, E.aplist(n))
    print(lab, "199", len(E.aplist(199)), E.aplist(199)[-3:], "200", len(E.aplist(200)))
    print(lab, "anlist", E.anlist(13))
# a model that is not minimal: the same list as its minimal model
E = EllipticCurve([0, 0, 0, -16, 0])
print(E.is_minimal(), E.aplist(13), E.minimal_model().aplist(13))
