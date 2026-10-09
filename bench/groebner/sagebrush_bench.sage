# The cases of magma_online.m in Sagebrush, printed the same way.
#   SAGEBRUSH_THREADS=1 python -m sagebrush bench/groebner/sagebrush_bench.sage [noproof]
import sys, time
noproof = "noproof" in sys.argv
if noproof:
    proof.polynomial(False)
CASES = [("Cyclic", 7, "32003", "degrevlex"), ("Katsura", 9, "32003", "degrevlex"), ("Katsura", 10, "32003", "degrevlex"),
         ("Cyclic", 8, "32003", "degrevlex"), ("Katsura", 8, "QQ", "degrevlex"), ("Cyclic", 7, "QQ", "degrevlex"),
         ("Katsura", 9, "QQ", "degrevlex"), ("Katsura", 8, "32003", "lex"), ("Katsura", 9, "32003", "lex"),
         ("Cyclic", 7, "32003", "lex"), ("Katsura", 6, "QQ", "lex"), ("Katsura", 7, "QQ", "lex")]
print("Sagebrush, proof.polynomial() = %s" % proof.polynomial())
for fam, n, field, order in CASES:
    nv = n + 1 if fam == "Katsura" else n
    K = QQ if field == "QQ" else GF(int(field))
    R = PolynomialRing(K, 'x', nv, order=order)
    I = getattr(sage.rings.ideal, fam)(R)
    t0 = time.time(); G = I.groebner_basis(); dt = time.time() - t0
    name = "%s-%d %s %s" % (fam.lower(), n, "QQ" if field == "QQ" else "GF(" + field + ")", "grevlex" if order == "degrevlex" else order)
    print("%s: %d elements, wall %.3f s" % (name, len(G), dt))
