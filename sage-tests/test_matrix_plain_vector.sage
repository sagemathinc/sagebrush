# A matrix over a finite or other field times a plain ZZ or QQ vector, in either order, is the matrix-vector product
# over the common field, as Sage (astra's CORR-1A3-1: it was multiplied as a scalar into a vector of matrices, and
# A * vector(QQ, []) gave an empty QQ vector instead of Sage's TypeError)
def T(name, fun):
    try:
        r = fun()
        try: p = r.parent()
        except Exception: p = ''
        print(name, '::', r, '@', p)
    except Exception as e:
        print(name, '::', type(e).__name__, ':', e)
P.<t> = QQ[]
K.<a> = NumberField(t^2 - 2)
for F, m in [(K, [[a, 2], [1, a]]), (GF(7), [[1, 2], [3, 4]]), (Zmod(6), [[1, 2], [3, 5]]), (AA, [[AA(2).sqrt(), 1], [0, 1]]), (QQbar, [[QQbar(I), 1], [2, 0]]), (RDF, [[1.5, 2], [0, 1]]), (RR, [[1, 2], [3, 4]])]:
    A = matrix(F, m)
    for R in [ZZ, QQ]:
        for e in [[1, 2], [1/2, 3], [], [1, 2, 3]]:
            if R is ZZ and e == [1/2, 3]:
                continue
            T('%s * %s%s' % (F, R, e), lambda: A * vector(R, e))
            T('%s%s * %s' % (R, e, F), lambda: vector(R, e) * A)
A = matrix(K, [[a, 2]])
T('K row * QQ', lambda: A * vector(QQ, [1, 2]))
T('K row * QQ list', lambda: (A * vector(QQ, [1, 2])).list())
T('QQ * K col', lambda: vector(QQ, [1, 2]) * A.transpose())
T('K row * QQ empty', lambda: A * vector(QQ, []))
T('K 0x0 * QQ empty', lambda: matrix(K, 0, 0) * vector(QQ, []))
T('QQ empty * K 0x2', lambda: vector(QQ, []) * matrix(K, 0, 2))
