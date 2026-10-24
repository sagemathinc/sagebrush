# latex() of lists, tuples and dicts, checked against Sage: one of exactly
# that type is written as LaTeX ([...], (...), {... : ...}); a subclass
# (of the user's, a namedtuple, an OrderedDict) as its text,
# \text{\texttt{str(v)}}, also inside a plain one.  Plain ones unchanged;
# Sage results sagebrush keeps in list subclasses (a basis, a Groebner
# basis, solve's dicts) are written as Sage writes them.
# Expected output (test_latex_subclass.out): SageMath version 10.10, Release Date: 2026-09-28.
from collections import namedtuple, OrderedDict, defaultdict
def row(label, f):
    try:
        print(label, f())
    except Exception as e:
        print(label, "ERR", type(e).__name__)

class L(list): pass
class T(tuple): pass
class D(dict): pass
class LR(list):
    def __repr__(self):
        return "LR!"
class LS(list):
    def __str__(self):
        return "LS str"
class IterList(list):
    def __iter__(self):
        return iter([7, 8])
P = namedtuple('P', 'a b')
x = var('x')
row("list", lambda: latex([1/2, x, 'a b']))
row("tuple", lambda: latex((1/2, x)))
row("tuple1", lambda: latex((1/2,)))
row("dict", lambda: latex({1: 1/2}))
row("[]", lambda: latex([]))
row("()", lambda: latex(()))
row("L", lambda: latex(L([1, 2])))
row("T", lambda: latex(T((1, 2))))
row("T1", lambda: latex(T((1,))))
row("D", lambda: latex(D({1: 2})))
row("L empty", lambda: latex(L()))
row("T empty", lambda: latex(T()))
row("L of Sage values", lambda: latex(L([1/2, x])))
row("L of str", lambda: latex(L(['a b', "it's"])))
row("L multiline str", lambda: latex(L(["a\nb"])))
row("L nested", lambda: latex(L([L([1]), [2]])))
row("list of L", lambda: latex([L([1/2]), 3]))
row("tuple of T", lambda: latex((T((1,)), 2)))
row("dict of L", lambda: latex({1: L([2])}))
row("LR", lambda: latex(LR([1])))
row("LS", lambda: latex(LS([1])))
row("IterList", lambda: latex(IterList([1])))
row("namedtuple", lambda: latex(P(1, 2)))
row("OrderedDict", lambda: latex(OrderedDict([(1, 2)])))
row("defaultdict", lambda: latex(defaultdict(int, {1: 2})))
row("basis", lambda: latex((QQ^2).basis()))
row("kernel basis", lambda: latex(matrix(QQ, [[1, 1]]).right_kernel().basis()))
R.<s,t> = QQ[]
row("groebner basis", lambda: latex(R.ideal(s^2 - t, s*t - 1).groebner_basis()))
row("ideal gens", lambda: latex(R.ideal(s, t).gens()))
row("solve dicts", lambda: latex(solve(x^2 == 1, x, solution_dict=True)))
row("rows", lambda: latex(matrix(QQ, [[1, 2]]).rows()))
row("eigenvalues", lambda: latex(matrix(QQ, [[1, 0], [0, 2]]).eigenvalues()))
row("divisors", lambda: latex(divisors(6)))
