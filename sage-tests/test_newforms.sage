for N in [11, 14, 15, 26, 37, 57, 58, 66, 99, 121, 128, 162, 210]:
    print(N, Newforms(N, names='a'))
f = Newforms(37, names='a')[0]
print(f.level(), f.weight(), f.coefficients(20), f[50], f.q_expansion(12))
print(CuspForms(Gamma0(44), 2).newforms('a')[0].coefficients(10))
for N in [102, 112, 120, 294]:
    print(N, [g.coefficients([2, 3, 5, 7, 11]) for g in CuspForms(N, 2).newforms('a')])
for N in [11, 30, 64, 150, 288]:
    print(N, len(Newforms(N)), sum(g[2]*g[3] for g in Newforms(N)))
