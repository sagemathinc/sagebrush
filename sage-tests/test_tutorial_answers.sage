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

# review of the above (CORR-0FE-1..6)
# conversion by position is explicit only, never arithmetic's coercion
P = ZZ['x', 'y']; px, py = P.gens()
Rz = QQ['z', 'x']; rz, rx = Rz.gens()
Tz = QQ['z', 't']; tz, tt = Tz.gens()
for a, b, lab in [(px, rz, 'x, z'), (rz, px, 'z, x'), (px, tz, 'x, t.z'), (tz, px, 't.z, x')]:
    t('mixed %s' % lab, lambda: [a + b, a - b, a * b, a == b])
t('mixed /', lambda: [rz / px, rz / QQ['x', 'z'].gen(0)])
t('mixed conversion', lambda: [Rz(px), Tz(px), Rz.ideal(px), px in Rz.ideal(rz)])
t('monomial of another parent', lambda: (rz + 2*rx).monomial_coefficient(px))
# Rational mod, round, sqrt
q = 3/4
t('mod', lambda: [q.mod(0), q.mod(7), q.mod(1/3), (2/1).mod(0)])
t('mod refused', lambda: q.mod('not rational'))
qs = [1/2, 5/2, 9/2, -1/2, -5/2, 3/2, -3/2, 7/3, -7/3, 0/1]
for m in [None, 'toward', 'away', 'up', 'down', 'even', 'odd']:
    t('round %s' % m, lambda: [r.round() if m is None else r.round(m) for r in qs])
t('round refused', lambda: q.round('bogus'))
t('sqrt', lambda: [(k/1).sqrt() for k in [0, 4, 9/4, 1, 10^40, 2, -4, -9/4, 3/4]])
t('sqrt parents', lambda: [parent((k/1).sqrt()) for k in [0, 4, 9/4, 1, 2]] + [parent(sqrt(4/1))])
t('sqrt quo_rem', lambda: (4/1).sqrt().quo_rem(3))
t('sqrt options', lambda: [(2/1).sqrt(prec=30), (4/1).sqrt(all=True), (0/1).sqrt(all=True), (2/1).sqrt(all=True, extend=False), (-4/1).sqrt(prec=30)])
t('sqrt not rational', lambda: (2/1).sqrt(extend=False))
t('sqrt negative', lambda: (-4/1).sqrt(extend=False))
# latex of LaTeX, and the _latex_ protocol of a str subclass
class TexString(str):
    def _latex_(self):
        return r'\mathcal{CUSTOM}'
t('latex', lambda: [latex(latex(1/2)), latex(TexString('a_b')), latex([latex(x^2), 'a_b'])])
# coercion into polynomial rings
K = QuadraticField(2, 'a'); RK = K['x', 'y']
t('coercion maps', lambda: [QQ['x', 'y'].has_coerce_map_from(int), RK.has_coerce_map_from(QQ), RK.has_coerce_map_from(QQ['x', 'y']), RK.has_coerce_map_from(ZZ['y']), Zmod(4)['x', 'y'].has_coerce_map_from(Zmod(12)['x', 'y']), Zmod(12)['x', 'y'].has_coerce_map_from(Zmod(4)), GF(9, 'b')['x', 'y'].has_coerce_map_from(GF(3)), GF(9, 'b')['x', 'y'].has_coerce_map_from(Zmod(12)['x']), GF(5)['x', 'y'].has_coerce_map_from(QQ), QQ['x', 'y'].has_coerce_map_from(float), QQ['x', 'y'].has_coerce_map_from(K), GF(3)['x', 'y'].has_coerce_map_from(GF(9, 'b'))])
t('coerce', lambda: [RK.coerce(1/2), RK.coerce(QQ['x', 'y'].gen(1))])
