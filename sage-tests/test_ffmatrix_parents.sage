# Matrix arithmetic over two fields uses Sage's common field, or is Sage's TypeError, whatever the entries
# (a zero, non-overlapping or empty product/sum over QQ(sqrt2) and QQ(sqrt3) succeeded; AA + QQbar was over AA: astra's CORR-ABC-1/2)
# (only the exception's type is printed: the operand names in the messages differ)
def T(name, fun):
    try: print(name, '::', fun())
    except Exception as e: print(name, '::', type(e).__name__)
P.<t> = QQ[]
K.<a> = NumberField(t^2 - 2)
L.<b> = NumberField(t^2 - 3)
for nm, f in [('mul', lambda X, Y: X * Y), ('add', lambda X, Y: X + Y), ('sub', lambda X, Y: X - Y)]:
    T('K L zero ' + nm, lambda: f(matrix(K, [[0]]), matrix(L, [[1]])).list())
    T('K L disjoint ' + nm, lambda: f(matrix(K, [[1, 0], [0, 0]]), matrix(L, [[0, 0], [0, 1]])).list())
    T('K L nonzero ' + nm, lambda: f(matrix(K, [[1]]), matrix(L, [[1]])).list())
    T('K L empty ' + nm, lambda: f(matrix(K, 0, 0, []), matrix(L, 0, 0, [])).dimensions())
    T('K K ' + nm, lambda: (f(matrix(K, [[a]]), matrix(K, [[1]])).list(), f(matrix(K, [[a]]), matrix(K, [[1]])).base_ring() is K))
    T('GF7 GF5 zero ' + nm, lambda: f(matrix(GF(7), [[0]]), matrix(GF(5), [[0]])).list())
    T('GF7 GF7 ' + nm, lambda: f(matrix(GF(7), [[3]]), matrix(GF(7), [[5]])).list())
    A = matrix(AA, [[1, AA(2).sqrt()], [0, 1]]); B = matrix(QQbar, [[1, 0], [QQbar(I), 1]])
    T('AA QQbar ' + nm, lambda: (f(A, B).base_ring(), f(A, B).list()))
    T('QQbar AA ' + nm, lambda: (f(B, A).base_ring(), f(B, A).list()))
    T('AA QQbar real ' + nm, lambda: (f(matrix(AA, [[1]]), matrix(QQbar, [[1]])).base_ring(), f(matrix(AA, [[1]]), matrix(QQbar, [[1]])).list()))
    T('AA QQbar empty ' + nm, lambda: f(matrix(AA, 0, 0, []), matrix(QQbar, 0, 0, [])).base_ring())
T('AA mat QQbar vec', lambda: ((matrix(AA, [[1, 2]]) * vector(QQbar, [QQbar(I), 1])).base_ring(), list(matrix(AA, [[1, 2]]) * vector(QQbar, [QQbar(I), 1]))))
T('K mat L vec', lambda: list(matrix(K, [[0]]) * vector(L, [1])))
