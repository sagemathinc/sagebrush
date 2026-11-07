# latex(Set(...)) is Sage's \left\{ ... \right\} with each element in its own LaTeX (it was the text of the repr),
# and Set(ZZ) is the set of the elements of ZZ (enumerating it never ended) (friction W39).  The cases keep to
# sets whose elements Sage iterates in increasing order (it iterates a Python frozenset)
def show(label, f):
    try:
        print(label, '|', f())
    except Exception as e:
        print(label, '| ERR', type(e).__name__, repr(str(e)[:120]))
print(latex(Set([2, 3, 5])))
for n, F in [('str(Set)', lambda: str(Set([2, 3, 5]))), ('Set big', lambda: Set([5, 3, 1, 4, 2, 10, 7])), ('latex Set big', lambda: latex(Set([5, 3, 1, 4, 2, 10, 7]))), ('list Set big', lambda: list(Set([5, 3, 1, 4, 2, 10, 7]))),
             ('Set sym', lambda: Set([pi, sqrt(2)])), ('latex Set sym', lambda: latex(Set([pi, sqrt(2)]))), ('Set ZZ', lambda: Set(ZZ)), ('latex Set ZZ', lambda: latex(Set(ZZ))), ('Set QQ ring', lambda: Set(QQ)),
             ('latex Set QQ ring', lambda: latex(Set(QQ))), ('3 in Set(ZZ)', lambda: 3 in Set(ZZ)), ('1/2 in Set(ZZ)', lambda: 1/2 in Set(ZZ)), ('Set GF5', lambda: Set(GF(5))), ('latex Set GF5', lambda: latex(Set(GF(5)))),
             ('latex Set empty', lambda: latex(Set([]))), ('latex Set of Sets', lambda: latex(Set([Set([1]), Set([2, 3])]))), ('latex Set range', lambda: latex(Set(range(4)))), ('latex Set one tuple', lambda: latex(Set([(1, 2)])))]:
    show(n, F)
