# Wrong answers the Sage Tutorial coverage corpus found (/scratch/coverage/sage),
# each next to its neighbours, compared with Sage itself.
def t(label, f):
    try:
        print(label, '::', f())
    except Exception as e:
        print(label, '::', type(e).__name__)

# 4/2 is a Rational, as every quotient of integers
t('quotients', lambda: [parent(4/2), parent(2/3), 4/2, parent(6/3 + 1/3), (4/2) in ZZ, parent(ZZ(4/2)), 2^-1, parent(-8/2)])
for q in [10/2, 3/4, -8/2, 9/4, 0/5]:
    t('rational %s' % q, lambda: [q.abs(), q.is_integral(), q.is_one(), q.is_prime(), q.is_square(), q.is_unit(), q.is_zero(), q.lcm(6), q.gcd(6), q.mod(7), q.parent(), q.quo_rem(3), q.round(), q.sqrt(), q.squarefree_part() if q else 0, q.str(), q.xgcd(6), q.factor() if q else 0])
t('nth_root', lambda: [(9/4).nth_root(2), (-8/27).nth_root(3), Integer(-8).nth_root(3), Integer(16).nth_root(4), Integer(10^30).nth_root(3), Integer(30).nth_root(3, truncate_mode=True)])
for a, n in [(-4, 2), (8, 2), (28, 23), (8, 21), (8, 12)]:
    t('nth_root %d %d' % (a, n), lambda: Integer(a).nth_root(n))

# iterating ZZ and QQ (it built polynomial rings ZZ[0], ZZ[1], ...)
W = iter(ZZ)
t('ZZ', lambda: [next(W) for _ in range(9)])
Q = iter(QQ)
t('QQ', lambda: [next(Q) for _ in range(40)])
W = ((x, y) for x in ZZ for y in ZZ)
t('pairs', lambda: [next(W) for _ in range(4)])

# callable functions, defined with a comment after them
f(x) = x        # instead of 'f = x'
g = f.derivative()
t('callable', lambda: (g, g.variables(), g.arguments(), type(g) == type(f)))
f(x, y) = x + 1
t('variables', lambda: (f.variables(), f.arguments()))

# LaTeX
t('latex rings', lambda: [latex(QQ), latex(ZZ), latex(RR), latex(CC), latex(ZZ['x'])])
for s in ['a string', 'x^2', 'a_b', '$5', '50%', '{x}', 'back\\slash', 'tilde~', 'hash#', 'amp&', 'two  spaces', '', 'a\nb', "q'uote"]:
    t('latex %r' % s, lambda: latex(s))
A = matrix(ZZ, 2, 2, range(4))
t('latex matrix', lambda: [latex(A), latex(matrix(QQ, [[1/2, 1]])), latex(matrix(ZZ, 1, 1, [5])), latex(vector([1, 2])), latex(vector(QQ, [1/2, 3])), latex(matrix(GF(5), [[1, 2], [3, 4]]))])
t('delimiters', lambda: latex.matrix_delimiters())
latex.matrix_delimiters(left='[', right=']')
t('latex [', lambda: latex(A))
latex.matrix_delimiters(left='\\{', right='\\}')
t('latex {', lambda: latex(A))
latex.matrix_delimiters('(', ')')
latex.vector_delimiters('[', ']')
t('vector [', lambda: latex(vector([1, 2])))
latex.vector_delimiters('(', ')')
latex.add_macro(r"\newcommand{\foo}{bar}")
t('macros', lambda: (latex.extra_macros(), latex.blackboard_bold(), latex.engine()))
latex.extra_macros('')
latex.add_to_preamble('\\usepackage{geometry}')
t('preamble', lambda: latex.extra_preamble())
latex.extra_preamble('')

# infinity
t('oo*0', lambda: oo * 0)
t('0*oo', lambda: 0 * oo)
t('oo-oo', lambda: oo - oo)
t('oo/oo', lambda: oo / oo)
t('oo+1', lambda: oo + 1)
for a in ([0, infinity], [1, infinity], [infinity, 0], [0, 0, 0, 0, infinity]):
    t('EllipticCurve %s' % a, lambda: EllipticCurve(a))

# conversion and coercion between polynomial rings and residue rings
R1.<x, y> = ZZ[]
R2 = ZZ['y', 'x']
R3 = ZZ['z', 'x']
t('conversion', lambda: [R2(x), R2(y), R3(x), R3(y), R3(x^2*y + 3), ZZ['a', 'b', 'c'](x), ZZ['p', 'q'](x + 2*y), ZZ['y', 'x', 'w'](x*y), ZZ['x'](x^2 + 3)])
t('ZZ[x](y)', lambda: ZZ['x'](y))
t('coercion', lambda: [R2.has_coerce_map_from(R1), R3.has_coerce_map_from(R1), R1.has_coerce_map_from(ZZ), R1.has_coerce_map_from(QQ), QQ['x', 'y'].has_coerce_map_from(R1), R1.has_coerce_map_from(ZZ['x']), R2.coerce(y), R1.coerce(3)])
t('coerce refused', lambda: R3.coerce(y))
t('coerce 1/2', lambda: R1.coerce(1/2))
t('equality', lambda: [R1.1 == R3.1, R1.1 != R3.1, R3(R1.1) == R3.1])
t('residues', lambda: [GF(5)(GF(2)(1)), GF(2)(GF(5)(1)), GF(7)(GF(5)(3)), Integers(12)(Mod(5, 7)), Integers(4)(Mod(3, 6)), GF(5)(GF(2)(1)) + GF(5)(1)])
t('residues +', lambda: GF(5)(1) + GF(2)(1))

# a basis is immutable
B = (QQ^3).basis()
def setb():
    B[0] = B[1]
t('basis', setb)
t('basis copy', lambda: list(B))
