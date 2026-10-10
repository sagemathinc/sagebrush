import json
out = open("heights2.jsonl", "w")
curves = []
for N in [5, 6, 7, 13, 14, 15, 21, 23, 29, 31, 34, 37, 41, 157]:
    curves.append(EllipticCurve([0, 0, 0, -N^2, 0]))
for a in range(2, 400, 7):
    curves.append(EllipticCurve([0, -(2*a+1), 0, a*(a+1), 0]))   # x(x-a)(x-a-1): close roots
for a in range(3, 300, 11):
    curves.append(EllipticCurve([0, -2*a, 0, a*a+1, 0]))     # x(x^2-2ax+a^2+1): complex roots a +- i
for a in [10**6+3, 10**9+7, 10**12+39]:
    curves.append(EllipticCurve([0, 0, 0, -a, 1]))
n = 0
for E0 in curves:
    E = E0.minimal_model()
    G = []
    a1, a2, a3, a4, a6 = E.ainvs()
    for s in range(1, 13):
        for r in range(-3000, 3000):
            if gcd(r, s) != 1: continue
            x = QQ(r) / s^2
            # y^2 + (a1 x + a3) y = x^3 + ...: discriminant in y
            D = (a1*x + a3)^2 + 4*(x^3 + a2*x^2 + a4*x + a6)
            if D.is_square():
                Q = E.lift_x(x)
                if Q.order() == oo:
                    G.append(Q); break
        if G: break
    if not G: continue
    P = G[0]
    T = E.torsion_points()
    pts = [k*P for k in range(1, 13)] + [k*P + t for k in (1, 2, 3) for t in T if t != 0]
    for Q in pts:
        h = Q.height(precision=400)
        out.write(json.dumps({"a": [int(c) for c in E.ainvs()], "x": str(Q[0]), "y": str(Q[1]),
                              "bad": [int(p) for p in ZZ(E.discriminant()).prime_factors()], "h": str(h),
                              "disc": int(E.discriminant())}) + "\n")
        n += 1
out.close()
print(n)
