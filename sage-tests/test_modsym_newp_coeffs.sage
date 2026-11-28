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
# each index validated, on fresh forms (cold) and after a_1..a_4 are known (warm)
def fresh():
    return CuspForms(11, 2).gen(0) * 1
for warm in [None, [1, 2, 3, 4]]:
    for L in ['[2.0]', '[3, 2.5]', '[QQ(1)/2, 3]', '[QQ(1)/2]', '[2.0, 3]', '[-2]', '[-1]', '[-1.0]', '[-2.0]', '[0.0]', '[1.0]', '[-3, 2]', '[QQ(4)]', '[QQ(-2)]', '[-1, 2.0]', '[int(3), ZZ(2)]']:
        f = fresh()
        if warm:
            f.coefficients(warm)
        try:
            r = f.coefficients(eval(L))
        except Exception as e:
            r = "%s: %s" % (type(e).__name__, e)
        print('warm' if warm else 'cold', L, '->', r)
# an index below a form's valuation, alone and beside a larger one
for i, M in [(0, CuspForms(11, 2)), (1, CuspForms(37, 2))]:
    for L in ['[0.0, 3]', '[QQ(0), 3]', '[0.5, 3]', '[-0.5, 3]', '[QQ(1)/2, 3]', '[QQ(-1)/2, 3]', '[1.0, 3]', '[QQ(3)/2, 3]', '[0.0]', '[0.5]']:
        f = M.basis()[i] * 1
        try:
            r = f.coefficients(eval(L))
        except Exception as e:
            r = "%s: %s" % (type(e).__name__, e)
        print(i, L, '->', r)
# an error stores nothing: a float past the degree beside a bad index, then beside a good one
f = CuspForms(32, 2).gen(0) * 1
for L in ['[2.0, 0.5]', '[2.0, 5]', '[2.0, 0.5]', '[5, 2.0]']:
    try:
        r = f.coefficients(eval(L))
    except Exception as e:
        r = "%s: %s" % (type(e).__name__, e)
    print(L, '->', r)
