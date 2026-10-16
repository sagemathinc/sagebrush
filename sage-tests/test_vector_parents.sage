# Vectors with vectors, as Sage (astra's vector hunt on d26542a6): the dimensions and the rings are checked
# before any entry is computed (vector(GF(7), [1,2]).dot_product(vector(GF(7), [3])) was 3, unequal lengths
# zipped), sums, products and cross products lie over the ring where the two base rings meet (ZZ * GF(7) was an
# outer product over SR, AA + QQbar stayed over AA, QQ + QQ fell to ZZ), and norms are computed in their own
# field (norm(Infinity) was 1, GF(7) had a norm, RealField(100) and AA dropped to RR, RR overflowed at 1e200)
def T(name, fun):
    try:
        r = fun()
        try: p = r.parent()
        except Exception: p = ''
        print(name, '::', r, '@', p)
    except Exception as e:
        print(name, '::', type(e).__name__, ':', e)
Kp = QuadraticField(2, 'a')
rings = [ZZ, QQ, GF(7), GF(5), Zmod(6), GF(9, 'z'), AA, QQbar, RDF, RR, CDF, CC, RealField(100), ComplexField(100)]
for R in [GF(7), Zmod(6), AA, RDF, RR, CC, RealField(100), Kp]:
    for m, n in [(2, 1), (0, 1), (3, 3)]:
        a, b = vector(R, list(range(1, m + 1))), vector(R, list(range(2, n + 2)))
        T('%s dot %d %d' % (R, m, n), lambda: a.dot_product(b))
        T('%s mul %d %d' % (R, m, n), lambda: a * b)
        T('%s add %d %d' % (R, m, n), lambda: a + b)
for R in rings:
    for S in rings:
        a, b = vector(R, [1, 2]), vector(S, [3, 4])
        T('%s + %s' % (R, S), lambda: a + b)
        T('%s * %s' % (R, S), lambda: a * b)
for R, S in [(GF(7), GF(5)), (QQ, GF(7)), (AA, QQbar), (ZZ, GF(7)), (RDF, CC), (RR, CDF), (QQ, Kp), (ZZ, Kp)]:
    T('%s - %s empty' % (R, S), lambda: vector(R, []) - vector(S, []))
    T('%s cross %s' % (R, S), lambda: vector(R, [1, 2, 3]).cross_product(vector(S, [3, 2, 1])))
T('cross 7', lambda: vector(QQ, [0, -3, 1, 5, -5, -4, 3]).cross_product(vector(QQ, [-4, 0, 4, -5, 3, -2, 1])))
T('cross 7 ZZ GF7', lambda: vector(ZZ, [1, 2, 3, 4, 5, 6, 7]).cross_product(vector(GF(7), [7, 1, 6, 2, 5, 3, 4])))
T('cross 2', lambda: vector(QQ, [1, 2]).cross_product(vector(QQ, [1, 2])))
T('cross list', lambda: vector(GF(7), [1, 2, 3]).cross_product([1, 2, 3]))
T('dot list', lambda: vector(GF(7), [1, 2]).dot_product([3, 4]))
T('QQ neg', lambda: -vector(QQ, [1, 2]))
T('QQ 2*', lambda: 2 * vector(QQ, [1, 2]))
T('QQ cross', lambda: vector(QQ, [1, 2, 3]).cross_product(vector(ZZ, [1, 2, 4])))
T('mod 4 6', lambda: vector(Zmod(4), [1, 3]) + vector(Zmod(6), [1, 2]))
T('mod 14 GF7', lambda: vector(Zmod(14), [1, 2]) + vector(GF(7), [1, 2]))
T('mod GF3 GF9', lambda: vector(GF(3), [1, 2]) * vector(GF(9, 'z'), [1, 2]))
T('mod 6 GF9', lambda: vector(GF(9, 'z'), [1, 2]) + vector(Zmod(6), [1, 2]))
T('mod GF9 GF27', lambda: vector(GF(9, 'z'), [1, 2]) + vector(GF(27, 'w'), [1, 2]))
T('M*v', lambda: matrix(GF(7), 2, 2, [1, 2, 3, 4]) * vector(GF(7), [1]))
T('v*M', lambda: vector(GF(5), [1, 2]) * matrix(GF(7), 2, 2, [1, 2, 3, 4]))
T('M*v mod 14', lambda: matrix(GF(7), 2, 2, [1, 2, 3, 4]) * vector(Zmod(14), [1, 2]))
for R in [ZZ, QQ, GF(7), Zmod(6), AA, QQbar, RDF, RR, CDF, CC, RealField(100), ComplexField(100)]:
    for e in [[], [0, 0], [3, 4], [1, 1]]:
        for p in [2, 1, Infinity, -Infinity, 0, -1]:
            T('%s %s norm %s' % (R, e, p), lambda: vector(R, e).norm(p))
for R in [RR, CC, RealField(100), ComplexField(70), RDF, CDF]:
    for p in [3, 5, 7/2]:
        T('%s norm %s' % (R, p), lambda: vector(R, [R('1.1'), R('2.3'), R('13.25')]).norm(p))
for R in [RR, RealField(100)]:
    for x in ['1e200', '1e-200', '1e400', '1e-400']:
        T('%s range %s' % (R, x), lambda: vector(R, [R(x), R(x)]).norm())
        T('%s range %s p1' % (R, x), lambda: vector(R, [R(x), R(x)]).norm(1))
T('AA exact', lambda: vector(AA, [AA(2).sqrt(), 1]).norm())
T('AA exact 3', lambda: vector(AA, [3, -4]).norm(3))
T('QQbar exact', lambda: vector(QQbar, [QQbar(I), 1]).norm())
T('QQbar exact inf', lambda: vector(QQbar, [QQbar(I), 1/2]).norm(Infinity))
T('QQ norm', lambda: vector(QQ, [1/2, 1/3]).norm())
T('QQ norm 3', lambda: vector(QQ, [8, 0]).norm(3))
T('QQ norm inf', lambda: vector(QQ, [1/2, -1/3]).norm(Infinity))
T('GF9 norm empty', lambda: vector(GF(9, 'z'), []).norm())
T('RDF norm -2', lambda: vector(RDF, [3, 4]).norm(-2))
T('RDF norm fro', lambda: vector(RDF, [3, 4]).norm('fro'))
print('Zmod6 parent ::', vector(Zmod(6), [1, 2]).parent())
for D in [-1, -4, -9, -2, 3]:
    print('QuadraticField(%d) ::' % D, QuadraticField(D, 'b'))
# astra's CORR-923-1: CDF with a real field below 53 bits meets in ComplexField of that precision, in both orders
for bits in [24, 52, 53, 54]:
    F = RealField(bits)
    a, b = vector(F, [F('1.0000001'), 2, 3]), vector(CDF, [CDF('1.0000002'), 3, 4])
    T('RF%d + CDF' % bits, lambda: a + b)
    T('CDF + RF%d' % bits, lambda: b + a)
    T('RF%d * CDF' % bits, lambda: a * b)
    T('CDF cross RF%d' % bits, lambda: b.cross_product(a))
    T('RF%d - CDF empty' % bits, lambda: vector(F, []) - vector(CDF, []))
# CORR-923-2: the dot product keeps a QQ operand's ring, on either side
for u, w in [([1, 2], [1, 2]), ([], []), ([0], [0])]:
    T('ZZ.dot(QQ) %s' % u, lambda: vector(ZZ, u).dot_product(vector(QQ, w)))
    T('QQ.dot(ZZ) %s' % u, lambda: vector(QQ, u).dot_product(vector(ZZ, w)))
# CORR-923-3: a real exponent keeps the vector's precision; an empty vector's norm is 0 in the exponent's ring
for p in [RealField(24)(3), RR(3), RR(2), RealField(200)(3), 3, 7/2]:
    for V in [vector(RealField(100), [1, 2]), vector(RR, [1, 2]), vector(ComplexField(100), [1, 2]), vector(RR, []), vector(RealField(100), [])]:
        T('%s norm %s %s' % (V.base_ring(), p, V), lambda: V.norm(p))
# CORR-923-4: NaN in double norms
nan = float('nan')
for R in [RDF, CDF]:
    for e, p in [([1, 0], nan), ([], nan), ([1, nan], Infinity), ([nan, 1], Infinity), ([1, nan], -Infinity), ([nan, 1], -Infinity), ([1, nan], 2), ([nan], -1)]:
        T('%s %s norm %s' % (R, e, p), lambda: vector(R, e).norm(p))
# vectors over SR keep SR; Z/1Z meets Z/nZ
for w in [vector(SR, [1, 2]), vector(ZZ, [1, 2]), vector(QQ, [1, 2]), vector(RR, [1, 2])]:
    T('SR + %s' % w.base_ring(), lambda: vector(SR, [3, 4]) + w)
    T('%s * SR' % w.base_ring(), lambda: w * vector(SR, [3, 4]))
T('SR + RDF', lambda: vector(SR, [3, 4]) + vector(RDF, [1, 2]))
T('SR norm', lambda: vector(SR, [3, 4]).norm())
T('SR norm sqrt', lambda: vector(SR, [1, 2]).norm())
T('Zmod1 + Zmod6', lambda: vector(Zmod(1), [1, 2]) + vector(Zmod(6), [1, 2]))
T('Zmod4 + Zmod1', lambda: vector(Zmod(4), [1, 2]) + vector(Zmod(1), [1, 2]))
T('Zmod1 + GF3', lambda: vector(Zmod(1), [1, 2]) + vector(GF(3), [1, 2]))
T('GF2 + Zmod1', lambda: vector(GF(2), [1, 2]) + vector(Zmod(1), [1, 2]))
T('Zmod4 + Zmod9', lambda: vector(Zmod(4), [1, 2]) + vector(Zmod(9), [1, 2]))
# astra's CORR-910-1: CC strings with digit separators are rejected; CORR-910-2: an empty symbolic vector's norm is 0 in QQ
for s in ['1_0e-400j', '1e-4_00j', '1e4_00j', '1_0e400j', '1_0', '2_5j']:
    T('CC(%s)' % s, lambda: CC(s))
for p in [2, 1, Infinity, 3]:
    T('SR empty norm %s' % p, lambda: vector(SR, []).norm(p))
# number fields without an embedding meet only ZZ, QQ and themselves (Sage's TypeError otherwise)
P.<t> = QQ[]
K1.<c> = NumberField(t^2 - 2)
L1.<d> = NumberField(t^2 - 3)
for w in [vector(L1, [1, 2]), vector(AA, [1, 2]), vector(QQbar, [1, 2]), vector(RDF, [1, 2]), vector(RR, [1, 2]), vector(GF(7), [1, 2]), vector(QQ, [1, 2]), vector(K1, [1, 2])]:
    T('K1 + %s' % w.base_ring(), lambda: vector(K1, [c, 1]) + w)
    T('%s * K1' % w.base_ring(), lambda: w * vector(K1, [c, 1]))
T('K1 mat L1 vec', lambda: matrix(K1, [[1, 0], [0, 1]]) * vector(L1, [1, 2]))
T('L1 vec K1 mat', lambda: vector(L1, [1, 2]) * matrix(K1, [[1, 0], [0, 1]]))
