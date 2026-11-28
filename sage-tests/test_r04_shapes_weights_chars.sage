# Finite-field matrix selectors keep their shape; list selectors; weights
# converted as Sage converts them; products of characters of one group only.
def show(label, f):
    try:
        r = f()
        print(label, "->", repr(r).replace(chr(10), " | "), flush=True)
    except Exception as e:
        print(label, "->", ("%s: %s" % (type(e).__name__, str(e).split(chr(10))[0])).rstrip(), flush=True)
A = matrix(GF(5), [[1, 2, 3], [3, 2, 1]])
B = matrix(GF(9, 'a'), [[1, 2, 3], [3, 2, 1]])
Z4 = matrix(Zmod(4), [[1, 2], [3, 0]])
for c in ['A[:0, :].dimensions()', 'A[:0, :].right_kernel().dimension()', 'A[:0, 1:3].dimensions()', 'A[1:1, 0].dimensions()',
          'B[:0, 1:3].right_kernel().dimension()', 'B[1:1, 0].dimensions()', 'Z4[:0, :].dimensions()',
          'A[[1, 0], :]', 'A[[1, 0]]', 'A[[], :].dimensions()', 'A[[1, 1], :]', 'A[:, [2, 0]]', 'A[[1], [0, 2]]',
          'A[1, [0, 2]]', 'A[[0, 1], 2]', 'A[[-1], :]', 'A[[2], :]', 'A[:, [3]]', 'A[[0.5], :]', 'A[1, :]', 'A[:, 1]',
          'A[-1, :]', 'A[5, :]', 'A[:, -4]', 'A[0:5:2, ::-1]', 'A[(1, 0), :]', 'A[[ZZ(1)], :]', 'A[[True], :]', 'A[1, 2]', 'A[1]',
          "A['a', :]", 'A[1.5, :]', 'A[None, :]', "A[:, 'a']", "A[['a'], :]", "A[:, ['a']]", 'A[range(1, 2), :]', 'A[:, range(1)]',
          'A[range(0), :].dimensions()', 'A[:, [1.5]]', "A[1, 'a']", "A['a', 1]", "A['a']", 'A[1.5]', 'A[(0, 1), (0,)]']:
    show(c, lambda: eval(c))
for c in ['ModularForms(11, QQ(5)/2)', 'CuspForms(11, QQ(5)/2)', 'ModularSymbols(11, QQ(5)/2)', 'ModularForms(11, 2.5)',
          'ModularSymbols(11, 2.5)', 'ModularForms(11, QQ(7)/3)', 'ModularForms(11, QQ(4)/2).dimension()',
          'ModularForms(11, 4.0).dimension()', 'ModularSymbols(11, 4.0).dimension()', 'ModularForms(11, int(4)).dimension()',
          'ModularSymbols(11, QQ(4)).dimension()', 'CuspForms(11, 2.5)', 'CuspForms(11, ZZ(4)).dimension()',
          'ModularForms(11, RR(2.5))', "ModularForms(11, float('nan'))", "ModularForms(11, float('inf'))", "ModularForms(11, RR('nan'))",
          'ModularSymbols(11, RR(2.5))', 'CuspForms(11, RR(4)).dimension()']:
    show(c, lambda: eval(c))
for c in ['DirichletGroup(3).gen() * DirichletGroup(5).gen()', 'DirichletGroup(5).gen() * DirichletGroup(3).gen()',
          'DirichletGroup(4).gen() * DirichletGroup(8).gen(0)', 'DirichletGroup(5).gen() * DirichletGroup(10).gen()',
          'DirichletGroup(8).gen(0) * DirichletGroup(12).gen(0)', 'DirichletGroup(5).gen() * DirichletGroup(5).gen()',
          'DirichletGroup(12).gen(0) * DirichletGroup(12).gen(1)']:
    show(c, lambda: eval(c))
# a character times an integer is a TypeError, on either side (the class)
chi = DirichletGroup(5).gen()
for c in ['chi * 2', '2 * chi']:
    try:
        eval(c)
        print(c, '-> no error')
    except TypeError:
        print(c, '-> TypeError')
