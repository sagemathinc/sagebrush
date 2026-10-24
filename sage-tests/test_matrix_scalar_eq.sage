# A matrix or a vector compared with a scalar, checked against Sage
# (William's report: matrix(QQ, 1, [1]) == 1 was False).  A square matrix
# is compared with c times the identity where the rings meet (0 x 0 too);
# a non-square matrix or a vector only with an integral zero.  Both
# orders, == and !=, and the hash of an immutable c times the identity.
# Expected output (test_matrix_scalar_eq.out): SageMath version 10.10, Release Date: 2026-09-28.
def row(label, f):
    try:
        print(label, f())
    except Exception as e:
        print(label, "ERR", type(e).__name__)

scalars = [("0", 0), ("1", 1), ("2", 2), ("1/2", 1/2), ("GF3(2)", GF(3)(2)), ("1.0", 1.0), ("RR2", RR(2)),
           ("int1", int(1)), ("float1", float(1)), ("float1.5", float(1.5)), ("Mod(5,6)", Mod(5,6)), ("QQbar1", QQbar(1)),
           ("GF5(2)", GF(5)(2)), ("-1", -1), ("True", True), ("None", None), ("str", "1"), ("list", [[1, 0], [0, 1]])]
mats = [("ZZ I", matrix(ZZ, [[1,0],[0,1]])), ("ZZ 2I", matrix(ZZ, [[2,0],[0,2]])), ("QQ [1]", matrix(QQ,1,[1])),
        ("QQ I/2", matrix(QQ, [[1/2,0],[0,1/2]])), ("GF3 2I", matrix(GF(3), [[2,0],[0,2]])), ("GF3 I", matrix(GF(3), [[1,0],[0,1]])),
        ("RR I", matrix(RR, [[1,0],[0,1]])), ("RDF I", matrix(RDF, [[1,0],[0,1]])), ("ZZ 0", matrix(ZZ, 2, 2, 0)), ("ZZ 3I", matrix(ZZ, [[3,0],[0,3]])),
        ("ZZ 1 1;0 1", matrix(ZZ, [[1,1],[0,1]])), ("ZZ 2x3 I", matrix(ZZ, [[1,0,0],[0,1,0]])), ("ZZ 2x3 0", matrix(ZZ, 2, 3)),
        ("GF3 2x3 0", matrix(GF(3), 2, 3)), ("RR 2x3 0", matrix(RR, 2, 3)), ("ZZ 0x0", matrix(ZZ, 0, 0)), ("QQ 0x0", matrix(QQ, 0, 0)),
        ("ZZ 0x2", matrix(ZZ, 0, 2))]
for mn, M in mats:
    print(mn, " ".join("%s:%d%d%d%d" % (sn, M == s, s == M, M != s, s != M) for sn, s in scalars))
zeros = [("Integer0", Integer(0)), ("int0", int(0)), ("QQ0", QQ(0)), ("float0", float(0)), ("RR0", RR(0)), ("GF3_0", GF(3)(0)),
         ("Integer3", Integer(3)), ("False", False), ("Mod0_4", Mod(0,4)), ("RDF0", RDF(0)), ("1", 1)]
vecs = [("vZZ 0", vector(ZZ, [0,0])), ("vZZ 3,0", vector(ZZ, [3,0])), ("vQQ 0", vector(QQ, [0,0])), ("vQQ 1/2,0", vector(QQ, [1/2,0])),
        ("vGF3 0", vector(GF(3), [0,0])), ("vGF3 1,0", vector(GF(3), [1,0])), ("vRR 0", vector(RR, [0,0])), ("vZZ empty", vector(ZZ, []))]
for vn, v in vecs:
    print(vn, " ".join("%s:%d%d%d" % (zn, v == z, z == v, v != z) for zn, z in zeros))
for mn, M in [("ZZ I", matrix(ZZ, [[1,0],[0,1]])), ("ZZ 0", matrix(ZZ, 2, 2, 0)), ("QQ I/2", matrix(QQ, [[1/2,0],[0,1/2]])),
              ("GF3 2I", matrix(GF(3), [[2,0],[0,2]])), ("ZZ 1 1;0 1", matrix(ZZ, [[1,1],[0,1]]))]:
    if hasattr(M, "set_immutable"):  # (sagebrush's GF(p) matrices have no set_immutable yet; they hash anyway)
        M.set_immutable()
    row(mn + " hash", lambda: hash(M) == hash(M[0, 0]))
MS = MatrixSpace(ZZ, 2)
row("MS", lambda: (MS == 0, MS.one() == 1, MS.zero() == 0, MS(3) == 3))
row("inverse", lambda: (lambda A: A * A.inverse() == 1)(matrix(QQ, [[1, 2], [3, 4]])))
# matrices and vectors of other rings: compared in the common parent
row("ZZ[[4]] vs GF3[[1]]", lambda: (matrix(ZZ,[[4]]) == matrix(GF(3),[[1]]), matrix(GF(3),[[1]]) == matrix(ZZ,[[4]])))
row("ZZ[[4]] vs GF3[[2]]", lambda: (matrix(ZZ,[[4]]) == matrix(GF(3),[[2]]),))
row("ZZ vs QQ", lambda: (matrix(ZZ,[[1,2]]) == matrix(QQ,[[1,2]]),))
row("QQ[[1/2]] vs GF3[[2]]", lambda: (matrix(QQ,[[1/2]]) == matrix(GF(3),[[2]]),))
row("ZZ vs RR", lambda: (matrix(ZZ,[[1,2]]) == matrix(RR,[[1,2]]), matrix(QQ,[[1/3]]) == matrix(RR,[[1/3]])))
row("GF3 vs GF5", lambda: (matrix(GF(3),[[1]]) == matrix(GF(5),[[1]]),))
row("dimensions", lambda: (matrix(ZZ,[[0,0]]) == matrix(ZZ,[[0],[0]]), matrix(ZZ,[[1,2]]) == vector(ZZ,[1,2])))
row("vectors", lambda: (vector(ZZ,[4,0]) == vector(GF(3),[1,0]), vector(ZZ,[1,2]) == vector(QQ,[1,2]), vector(ZZ,[0]) == vector(ZZ,[0,0]), vector(QQ,[1]) == vector(GF(3),[1])))
