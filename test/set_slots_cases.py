# Binary, reflected and in-place set operators for every pair of set, frozenset
# and their subclasses (plain, and overriding), against CPython: astra's probe
# for CORR-A2B-1 and -2 (test/stdlib-small.test.ts).
from types import MappingProxyType
class S(set): pass
class F(frozenset): pass
class N(set):
    def __or__(self,o): return NotImplemented
    def __and__(self,o): return NotImplemented
    def __sub__(self,o): return NotImplemented
    def __xor__(self,o): return NotImplemented
class R(set):
    def __ror__(self,o): return 'reverse-or'
    def __rand__(self,o): return 'reverse-and'
    def __rsub__(self,o): return 'reverse-sub'
    def __rxor__(self,o): return 'reverse-xor'
class NI(set):
    def __ior__(self,o): return NotImplemented
    def __iand__(self,o): return NotImplemented
    def __isub__(self,o): return NotImplemented
    def __ixor__(self,o): return NotImplemented

def norm(x):
    if isinstance(x, (set,frozenset)):
        return (type(x).__name__, sorted(x))
    return (type(x).__name__, x)
def operation(a,b,op):
    if op=='|': return a|b
    if op=='&': return a&b
    if op=='-': return a-b
    if op=='^': return a^b
    if op=='|=': a|=b
    if op=='&=': a&=b
    if op=='-=': a-=b
    if op=='^=': a^=b
    return a
for A in (set,frozenset,S,F,N,NI):
    for B in (set,frozenset,S,F,R):
        for op in ('|','&','-','^','|=','&=','-=','^='):
            a,b=A([1,2]),B([2,3])
            try:
                result=operation(a,b,op)
                print(repr((A.__name__,B.__name__,op,norm(result),norm(a),result is a)))
            except Exception as e:
                print(repr((A.__name__,B.__name__,op,type(e).__name__,str(e))))
