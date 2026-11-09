# Sage's cached_function and cached_method (lazy module _sage_cached): the cache key is the positional parameters
# with defaults filled in plus the sorted remaining keyword arguments; methods keep their results per instance.
# Addresses in reprs are masked. Not pinned: an undocumented function's __doc__ (Sage adds its source-file line);
# the Python runtime's own arity and missing-argument texts ("takes from 1 to 2 positional arguments", "C.g()
# missing ...").
import re as _re
def _mask(s):
    return _re.sub(r"0x[0-9a-f]+", "0x...", s)
def show(label, f):
    try:
        print(label, "->", _mask(repr(f())))
    except Exception as e:
        print(label, "->", "%s: %s" % (type(e).__name__, e))
calls = []
@cached_function
def f(n, k=1):
    calls.append((n, k)); return n^k
show("f(2)", lambda: f(2)); show("f(2) again", lambda: f(2)); show("calls", lambda: list(calls))
show("f(2, 1)", lambda: f(2, 1)); show("f(2, k=1)", lambda: f(2, k=1)); show("f(int(2))", lambda: f(int(2))); show("calls", lambda: list(calls))
show("f(3, k=2)", lambda: f(3, k=2)); show("calls", lambda: list(calls))
show("type(f)", lambda: type(f).__name__)
show("f.cache", lambda: sorted(f.cache.items()))
show("f.is_in_cache(2)", lambda: f.is_in_cache(2)); show("f.is_in_cache(5)", lambda: f.is_in_cache(5))
show("f.clear_cache()", lambda: f.clear_cache()); show("f.cache after", lambda: f.cache)
show("f.__name__", lambda: f.__name__)
show("f.precompute([4,5])", lambda: f.precompute([4, 5])); show("f.cache", lambda: sorted(f.cache.items()))
show("f([1,2]) unhashable", lambda: f([1, 2]))
show("repr(f)", lambda: repr(f)[:60])
@cached_function
def g():
    calls.append('g'); return 7
show("g(), g()", lambda: (g(), g(), calls.count('g')))
class A:
    def __init__(self, v): self.v = v; self.n = 0
    @cached_method
    def m(self):
        self.n += 1; return self.v * 2
    @cached_method
    def h(self, k):
        self.n += 1; return self.v + k
a = A(5); b = A(6)
show("a.m(), a.m(), a.n", lambda: (a.m(), a.m(), a.n))
show("b.m(), b.n", lambda: (b.m(), b.n))
show("a.h(1), a.h(1), a.h(2), a.n", lambda: (a.h(1), a.h(1), a.h(2), a.n))
show("a.m.clear_cache(); a.m(); a.n", lambda: (a.m.clear_cache(), a.m(), a.n))
show("a.h.cache", lambda: sorted(a.h.cache.items()))
show("a.h.is_in_cache(1)", lambda: a.h.is_in_cache(1))
show("type(a.m)", lambda: type(a.m).__name__)
show("A.m", lambda: type(A.m).__name__)
@cached_function(key=lambda n, k=1: n)
def kf(n, k=1):
    return n + k
show("cached_function(key=...)", lambda: (kf(1), kf(1, k=5)))

# (second section)
@cached_function
def f(n, k=1):
    """Doc of f."""
    return n^k
show("precompute tuples", lambda: (f.precompute([(4, 2), 5]), sorted(f.cache.items())))
f.clear_cache()
show("set_cache", lambda: (f.set_cache(99, 2), f(2), sorted(f.cache.items())))
show("f.get_key(2)", lambda: f.get_key(2))
show("f.get_key(2, k=3)", lambda: f.get_key(2, k=3))
@cached_function
def v(*args, **kw):
    return (args, sorted(kw.items()))
show("v(1,2,a=3)", lambda: v(1, 2, a=3)); show("v.cache", lambda: list(v.cache.keys()))
show("f(k=2) missing", lambda: f(k=2))
show("f.f", lambda: f.f.__name__)
show("str(f)", lambda: str(f)[:40])
show("f == f", lambda: f == f)
show("callable", lambda: callable(f))
class A:
    @cached_method
    def m(self):
        return 3
    @cached_method
    def h(self, k):
        return k
show("repr(A().m)", lambda: repr(A().m)[:70])
show("repr(A().h)", lambda: repr(A().h)[:70])
show("type(A().h)", lambda: type(A().h).__name__)
show("type(A.h)", lambda: type(A.h).__name__)
a = A()
show("a.m.cache", lambda: (a.m(), a.m.cache))
show("a.m.is_in_cache()", lambda: a.m.is_in_cache())
show("a.h.precompute([1,2]); cache", lambda: (a.h.precompute([1, 2]), sorted(a.h.cache.items())))
show("a.m.__name__", lambda: a.m.__name__)
# (third section) a cached method called through its class, as Sage: with no arguments the class is the
# instance; with arguments it is the plain function (board's B1 on #912)
class C:
    @cached_method
    def f(self):
        return 1
    @cached_method
    def g(self, n):
        return n
show("C.f()", lambda: C.f())
show("C.g(C(), 3)", lambda: C.g(C(), 3))
show("C().g(3)", lambda: C().g(3))
# (fourth section) an instance with no __dict__ keeps nothing, as Sage: each call computes (daybreak3's E3 on
# #912); cached_method(key=...) gets the instance first (E1); keyword-only parameters in the key (E2)
cnt = []
class S:
    __slots__ = ()
    @cached_method
    def m(self):
        cnt.append(1); return 1
    @cached_method
    def h(self, k):
        cnt.append(2); return k
s = S()
show("slots m twice, calls", lambda: (s.m(), s.m(), len(cnt)))
show("slots m.cache", lambda: s.m.cache)
show("slots m.is_in_cache()", lambda: s.m.is_in_cache())
show("slots h twice", lambda: (s.h(1), s.h(1), len(cnt)))
show("slots h.cache", lambda: s.h.cache)
show("slots h.is_in_cache(1)", lambda: s.h.is_in_cache(1))
show("slots h.clear_cache()", lambda: s.h.clear_cache())
show("slots m.clear_cache()", lambda: s.m.clear_cache())
seen = []
class K:
    def __init__(self, v): self.v = v
    @cached_method(key=lambda self, n, extra=0: n)
    def f(self, n, extra=0):
        seen.append((n, extra)); return n + extra
k = K(1)
show("key method", lambda: (k.f(1), k.f(1, extra=5), k.f(2), list(seen)))
show("key method cache", lambda: sorted(k.f.cache.items()))
show("key method is_in_cache(1, extra=9)", lambda: k.f.is_in_cache(1, extra=9))
args = []
class K2:
    @cached_method(key=lambda *a, **kw: (args.append((len(a), sorted(kw))), a[1])[1])
    def g(self, n):
        return n
show("key receives self", lambda: (K2().g(3), args[0]))
@cached_function
def q(a, *, b=3):
    return a + b
show("kwonly", lambda: (q(1), q(1, b=3), sorted(q.cache.items())))
show("kwonly get_key", lambda: (q.get_key(1), q.get_key(1, b=4)))
@cached_function
def r(a, *rest, c, **kw):
    return a
show("mixed", lambda: (r(1, 2, c=3, z=4), list(r.cache.keys())))

# (fifth section) the key with keyword-only parameters and *args, as Sage
@cached_function
def q2(a, *, b):
    return a
show("q2(1,b=2)", lambda: q2.get_key(1, b=2))
show("q2(1) missing kwonly", lambda: q2.get_key(1))
@cached_function
def q3(a, *, c=1, b=2):
    return a
show("q3 b only", lambda: q3.get_key(1, b=5))
show("q3 c only", lambda: q3.get_key(1, c=5))
show("q3 both b,c", lambda: q3.get_key(1, b=5, c=6))
show("q3 both c,b", lambda: q3.get_key(1, c=6, b=5))
@cached_function
def q4(a, k=0, *, b=2, **kw):
    return a
show("q4 b and z", lambda: q4.get_key(1, b=5, z=7))
show("q4 k by name", lambda: q4.get_key(1, k=3, b=5))
show("q4 only z", lambda: q4.get_key(1, z=7))
@cached_function
def q5(*, b=2):
    return b
show("q5()", lambda: q5.get_key())
show("q5(b=4)", lambda: q5.get_key(b=4))
@cached_function
def r2(a, *rest, c=9):
    return a
show("r2 (1,2)", lambda: r2.get_key(1, 2))
show("r2 (1,2,c=3)", lambda: r2.get_key(1, 2, c=3))
show("r2 (1,c=3)", lambda: r2.get_key(1, c=3))
