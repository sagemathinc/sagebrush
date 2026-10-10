import json
set_random_seed(1)
out = open("heights.jsonl", "w")  # (merged into heights.jsonl, values cut to 120 digits)
n = 0
while n < 600:
    a1, a2, a3 = [ZZ.random_element(-1, 2) for _ in range(3)]
    B = 10 ** ZZ.random_element(1, 6)
    a4 = ZZ.random_element(-B, B)
    x0, y0 = ZZ.random_element(-30, 30), ZZ.random_element(-30, 30)
    a6 = y0^2 + a1*x0*y0 + a3*y0 - x0^3 - a2*x0^2 - a4*x0
    try:
        E0 = EllipticCurve([a1, a2, a3, a4, a6])
    except ArithmeticError:
        continue
    P0 = E0(x0, y0)
    if P0.order() != oo:
        continue
    E = E0.minimal_model()
    phi = E0.isomorphism_to(E)
    P = phi(P0)
    T = E.torsion_points()
    for Q in [P, 2*P, P + T[-1], 3*P] if n % 5 == 0 else [P]:
        h = Q.height(precision=400)
        out.write(json.dumps({"a": [int(c) for c in E.ainvs()], "x": str(Q[0]), "y": str(Q[1]),
                              "bad": [int(p) for p in ZZ(E.discriminant()).prime_factors()], "h": str(h),
                              "disc": int(E.discriminant())}) + "\n")
        n += 1
out.close()
print(n)
