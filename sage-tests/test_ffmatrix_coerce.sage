# Scalars meet matrices over GF(q), number fields, QQbar and AA by Sage's coercion, not the base ring's constructor
# (identity_matrix(GF(7), 2) == 1.5 was True and + 1.5 gave 2*I; a == A was False over QQ(sqrt2); QQbar's I == 1.0 was False)
# (only the exception's type is printed: the operand names in the messages differ)
def T(name, fun):
    try: print(name, '::', fun())
    except Exception as e: print(name, '::', type(e).__name__)
P.<t> = QQ[]
K.<a> = NumberField(t^2 - 2)
L.<b> = NumberField(t^2 - 3)
bases = [('GF7', GF(7)), ('GF9', GF(9, 'z')), ('K', K), ('QQbar', QQbar), ('AA', AA)]
scalars = [('int2', 2), ('ZZ2', ZZ(2)), ('half', QQ(1)/2), ('float1', float(1)), ('float1.5', float(1.5)), ('RR1', RR(1)), ('RR1.5', RR(1.5)),
           ('CC_i', CC(0, 1)), ('GF5_1', GF(5)(1)), ('GF7_3', GF(7)(3)), ('K_a', a), ('L_b', b), ('QQbar_sqrt2', QQbar(2).sqrt()), ('AA_1', AA(1)), ('QQbar_I', QQbar(I))]
for bn, R in bases:
    I2 = identity_matrix(R, 2)
    for sn, s in scalars:
        T('%s %s ==' % (bn, sn), lambda: (I2 == s, s == I2, I2 != s, s != I2))
        T('%s %s +' % (bn, sn), lambda: ((I2 + s).list(), (s + I2).list(), (I2 - s).list(), (s - I2).list(), (I2 + s).base_ring()))
    N = matrix(R, 2, 3, [1, 0, 0, 0, 1, 0])
    T('%s rect 0' % bn, lambda: ((N + 0).list(), (0 + N).list(), (N - 0).list(), (0 - N).list(), N == 0, 0 == N, matrix(R, 2, 3, 0) == 0, 0 == matrix(R, 2, 3, 0)))
    T('%s rect 1' % bn, lambda: N + 1)
A = diagonal_matrix(K, [a, a])
T('K diag a', lambda: (A == a, a == A, A != a, a != A))
T('K diag a +', lambda: ((A + a).list(), (a + A).list(), (A - a).list(), (a - A).list()))
T('GF7 diag', lambda: (diagonal_matrix(GF(7), [1, 9]).list(), diagonal_matrix(GF(7), [1, 9]).base_ring()))
T('QQbar diag', lambda: (diagonal_matrix(QQbar, [I, 2]).list(), diagonal_matrix(QQbar, [I, 2]).base_ring()))
# numeric complex scalars on the left defer to the matrix (CDF(1) == I2 was False over QQbar and AA); None is no scalar (A == None raised)
for bn, R in bases + [('Zmod6', Zmod(6))]:
    I2 = identity_matrix(R, 2)
    for C in (CDF, ComplexField(200), RealField(200)):
        c = C(1)
        T('%s %s ==' % (bn, C), lambda: (I2 == c, c == I2, I2 != c, c != I2))
        T('%s %s / *' % (bn, C), lambda: ((I2 / c).list(), (I2 * c).list(), (c * I2).list()))
    T('%s None' % bn, lambda: (I2 == None, None == I2, I2 != None, None != I2))
