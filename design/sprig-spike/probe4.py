import sys
sys.path.insert(0, "/scratch/matlab-tmp/wtmx/lib")
import _sprig as W
import sage_all as S
M = W.to_matrix(W.parse("{{2, 1}, {1, 2}}")[0])
for v, vecs, mult in M.eigenvectors_right():
    print(type(v), v, [type(a) for a in vecs[0]], mult)
x = S.SR(2).n(digits=30)
print(type(x), x)
try:
    print(S.SR(x))
except Exception as e:
    print("SR fails", e)
print(S.latex(S.var("x") ** 2 / S.sqrt(S.var("y"))))
print(type(M.right_kernel().basis()[0]))
