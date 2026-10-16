# matrix(F, m, n, f) over finite fields, number fields, QQbar, AA and RDF builds the entries f(i, j), as Sage
# (it was a TypeError, "Illegal initializer for algebraic number" or "unable to convert <function ...>")
def T(name, fun):
    try: print(name, '::', fun())
    except Exception as e: print(name, '::', type(e).__name__)
P.<t> = QQ[]
K.<a> = NumberField(t^2 - 2)
T('GF7', lambda: matrix(GF(7), 2, 3, lambda i, j: 3*i + j + 5))
T('GF9', lambda: matrix(GF(9, 'z'), 2, 2, lambda i, j: GF(9, 'z').gen()^(i + 2*j)).list())
T('AA', lambda: matrix(AA, 2, 2, lambda i, j: AA(i + j + 2).sqrt()))
T('QQbar', lambda: matrix(QQbar, 2, 2, lambda i, j: QQbar(-(i + 2)).sqrt() + j))
T('K', lambda: matrix(K, 2, 2, lambda i, j: a^i + j))
T('RDF', lambda: matrix(RDF, 2, 2, lambda i, j: 1/(i + j + 1)))
T('AA empty', lambda: matrix(AA, 0, 3, lambda i, j: 1).dimensions())
T('GF7 raises', lambda: matrix(GF(7), 2, 2, lambda i, j: 1/(i - j)))
T('AA parent', lambda: matrix(AA, 2, 2, lambda i, j: i + j).base_ring())
# a real converts to GF(p) or Z/nZ only when it is an integer (GF(7)(1.25) was 1, and matrix(GF(7), [[1.25]]) [1]: astra's CORR-A1D-1)
for nm, x in [('RR1.25', RR(1.25)), ('float1.25', 1.25r), ('RDF1.25', RDF(1.25)), ('RR2', RR(2)), ('float2', 2.0r), ('RR-3', RR(-3)), ('RR1e30', RR(1e30))]:
    for F in (GF(7), GF(2), Zmod(6)):
        T('%s %s' % (F, nm), lambda: F(x))
T('list 1.25', lambda: matrix(GF(7), [[1.25]]))
T('list RR2', lambda: matrix(GF(7), [[RR(2)]]))
calls = []
def g(i, j):
    calls.append((i, j))
    return RR(1.25)
T('fn 1.25', lambda: matrix(GF(7), 1, 2, g))
print('calls', calls)
