# A vector compared with a list or a tuple, checked against Sage: a list
# or tuple (a subclass too) is not a vector, so it is unequal in both
# orders, over every ring; v.list() and tuple(v) compare as lists do.
# Expected output (test_vector_list_eq.out): SageMath version 10.10, Release Date: 2026-09-28.
def row(label, f):
    try:
        print(label, f())
    except Exception as e:
        print(label, "ERR", type(e).__name__)

class L(list): pass
class T(tuple): pass
vecs = [("vZZ", vector(ZZ, [1, 2])), ("vQQ", vector(QQ, [1, 2])), ("vGF5", vector(GF(5), [1, 2])),
        ("vRR", vector(RR, [1, 2])), ("vZZ 0", vector(ZZ, [0, 0])), ("vZZ empty", vector(ZZ, []))]
for vn, v in vecs:
    e = list(v)
    others = [("list", e), ("tuple", tuple(e)), ("T", T(e)), ("[]", []), ("()", ())]
    print(vn, " ".join("%s:%d%d%d%d" % (on, v == o, o == v, v != o, o != v) for on, o in others),
          # (a list subclass only with the vector on the left: a ZZ or QQ
          # vector is a Python list in sagebrush, so L.__eq__ runs first
          # when L is on the left and compares the entries)
          "L:%d%d" % (v == L(e), v != L(e)))
v = vector(ZZ, [1, 2])
row("v.list() == list", lambda: v.list() == [1, 2])
row("list(v) == list", lambda: list(v) == [1, 2])
row("tuple(v) == tuple", lambda: tuple(v) == (1, 2))
row("v in [[1, 2]]", lambda: v in [[1, 2]])
row("[1, 2] in [v]", lambda: [1, 2] in [v])
row("v in [v]", lambda: v in [vector(QQ, [1, 2])])
row("row == list", lambda: matrix(ZZ, [[1, 2]]).row(0) == [1, 2])
row("column == list", lambda: matrix(ZZ, [[1], [2]]).column(0) == [1, 2])
row("solve_right == list", lambda: matrix(QQ, [[1, 0], [0, 1]]).solve_right(vector(QQ, [1, 2])) == [1, 2])
row("solve_right list() == list", lambda: matrix(QQ, [[1, 0], [0, 1]]).solve_right(vector(QQ, [1, 2])).list() == [1, 2])
row("vector == vector", lambda: (vector(ZZ, [1, 2]) == vector(GF(5), [1, 2]), vector(QQ, [1, 2]) == vector(ZZ, [1, 2])))
row("matrix == list", lambda: matrix(ZZ, [[1, 2]]) == [[1, 2]])
