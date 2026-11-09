# Sagebrush's cached_method keeps a method's results in the instance's own __dict__ (astra's C1 on #912): nothing
# outside the instance holds it, so dropping the instance drops its cache; an instance with no __dict__ keeps nothing.
import _sage_cached
def show(label, f):
    try:
        print(label, "->", repr(f()))
    except Exception as e:
        print(label, "->", "%s: %s" % (type(e).__name__, e))
def containers():
    return sorted((k, len(v)) for k, v in vars(_sage_cached).items() if isinstance(v, (dict, list, set)) and not k.startswith("__"))
before = containers()
class A:
    def __init__(self, v): self.v = v; self.n = 0
    @cached_method
    def m(self):
        self.n += 1; return self.v * 2
    @cached_method
    def h(self, k):
        self.n += 1; return self.v + k
    @cached_method
    def me(self):
        return self
xs = [A(i) for i in range(200)]
for a in xs:
    a.m(); a.m(); a.h(1); a.h(1); a.h(2); a.me(); a.m.is_in_cache(); a.h.cache
show("module containers unchanged after 200 instances", lambda: containers() == before)
a = xs[7]
show("cache in the instance's __dict__", lambda: sorted(k for k in vars(a) if k.startswith("_cache__")))
show("live hits", lambda: (a.m(), a.h(1), a.n))
show("distinct instances", lambda: (xs[1].m(), xs[2].m(), xs[1].m() is not xs[2].m() or xs[1].m() == xs[2].m()))
show("self result", lambda: a.me() is a)
show("clear_cache", lambda: (a.h.clear_cache(), a.h.cache, a.h(1), a.n))
show("a.m.clear_cache", lambda: (a.m.clear_cache(), a.m.is_in_cache(), a.m(), a.n))
class S:
    __slots__ = ()
    @cached_method
    def m(self):
        return 1
show("slots class", lambda: (S().m(), S().m.cache, S().m.is_in_cache()))
for _ in range(50):
    S().m()
show("module containers unchanged after slots calls", lambda: containers() == before)
class C:
    @cached_method
    def f(self):
        return 1
    @cached_method
    def g(self, n):
        return n
show("C.f() through the class", lambda: C.f())
show("C.g(C(), 3) through the class", lambda: C.g(C(), 3))
