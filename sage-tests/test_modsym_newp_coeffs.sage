# p-new subspaces composed with the new subspace and other primes; ModularFormElement.coefficients of any iterable of indices, as Sage 10.10 gives them
for N in [33, 30, 45]:
    M = ModularSymbols(N); S = M.cuspidal_submodule()
    ps = [p for p, _ in factor(N)]
    print(N, M.new_submodule().dimension(), [M.new_submodule(p).dimension() for p in ps])
    for p in ps:
        print(' ', p, S.new_submodule(p).dimension(), S.new_submodule(p).new_submodule().dimension(),
              [S.new_submodule(p).new_submodule(q).dimension() for q in ps],
              M.new_submodule(p).new_submodule().dimension(), M.new_submodule(p).cuspidal_submodule().dimension(),
              S.new_submodule().new_submodule(p).dimension(), M.new_submodule(p).is_cuspidal())
f = CuspForms(11,2).gen(0)
for c in ['f.coefficients(range(1,4))', 'f.coefficients((n for n in [2, 3, 5]))', 'f.coefficients([1, 7])', 'f.coefficients(4)', 'f.coefficients(range(0,3))', 'f.coefficients(iter([4]))', 'f.coefficients(set([2]))', 'f.coefficients(2.5)', 'f.coefficients(-1)', 'f.coefficients(0)', 'f.coefficients(range(1,1))', 'f.coefficients("3")', 'f.coefficients([-1])', 'f.coefficients([-1, 3])', 'f.coefficients([2.0])', 'f.coefficients([ZZ(3), int(2)])', 'f.coefficients(True)', 'f.coefficients(ZZ(3))', 'f.coefficients((3, 1))', 'f.coefficients([])', 'f.coefficients([QQ(1)/2])', 'f.coefficients(None)', 'f.coefficients({2: 0, 4: 1})', 'f.coefficients(range(5, 2, -1))']:
    try: print(c, '->', eval(c))
    except Exception as e: print(c, '->', type(e).__name__, e)
g = CuspForms(37, 2).basis()[1]
print(g.coefficients([-2, 5]), g.coefficients([-2]))
