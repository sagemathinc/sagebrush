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
