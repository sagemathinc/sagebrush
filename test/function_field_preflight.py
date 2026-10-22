"""R0a live-preflight and cache-policy regression checks.

This imports the native Python adapter directly so spies can prove that a
one-byte live-budget refusal happens before the operation's allocator, while
the exact boundary reaches it.  It also inspects the private reviewed cache
ledgers; neither detail is exposed as a Magma intrinsic.
"""
import gc
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "engine/py/python"))
import sagebrush  # load the native package before lib/sagebrush shadows it
sys.path.insert(0, str(ROOT / "lib"))

import _magma as m


class Gate:
    def __init__(self, limit=None):
        self.limit = limit
        self.live = 0

    def charge(self, work=0, live=0, what="operation"):
        live = int(live)
        if live < 0 or (self.limit is not None and self.live + live > self.limit):
            raise m.MagmaError("test live gate", "'FunctionField'", True)
        self.live += live


def with_gate(limit, call):
    old = m._FunBudget
    made = []

    def factory():
        b = Gate(limit)
        made.append(b)
        return b

    m._FunBudget = factory
    try:
        out = call()
    finally:
        m._FunBudget = old
    assert len(made) == 1
    return made[0].live, out


def check_preflight(name, owner, attr, call):
    total, _ = with_gate(None, call)
    assert total > 0, name
    original = getattr(owner, attr)
    calls = []

    def spy(*args, **kwds):
        calls.append(1)
        return original(*args, **kwds)

    setattr(owner, attr, spy)
    try:
        cache_before = (list(m._FUN_LRU), list(m._FUN_CACHE),
                        list(m._FUN_POLY_LRU), list(m._FUN_POLY_BY_BASE))
        try:
            with_gate(total - 1, call)
        except m.MagmaError:
            pass
        else:
            raise AssertionError(name + " admitted one byte below its live envelope")
        assert not calls, name + " allocated before its refusal"
        cache_after = (list(m._FUN_LRU), list(m._FUN_CACHE),
                       list(m._FUN_POLY_LRU), list(m._FUN_POLY_BY_BASE))
        assert cache_after == cache_before, name + " changed a cache on refusal"
        at, _ = with_gate(total, call)
        assert at == total and calls, name + " did not admit its exact boundary"
    finally:
        setattr(owner, attr, original)


F = m.FunctionField(m._QQ)
x = F._magma_gen(1)
a = (x + 1) / (x + 2)
b = (x + 3) / (x + 4)
frac = type(a.v)

check_preflight("binary", frac, "__add__", lambda: a + b)
check_preflight("power", frac, "__pow__", lambda: a ** 2)
check_preflight("Evaluate", frac, "__call__", lambda: m.Evaluate(a, b))
check_preflight("Derivative", frac, "derivative", lambda: m.Derivative(a))
check_preflight("sequence coercion", type(F._backend_ring), "__call__",
                lambda: F._magma_coerce(m.MSeq([1, 2, 3])))
check_preflight("Numerator", type(F), "_parts", lambda: m.Numerator(a))
check_preflight("Denominator", type(F), "_parts", lambda: m.Denominator(a))


# Source-ring discovery is weak and at most the 64 strongly retained parents
# can keep a presentation ring alive after caller aliases are dropped.
m._FUN_CACHE.clear()
m._FUN_LRU.clear()
m._FUN_LIVE.clear()
m._FUN_POLY_BY_BASE.clear()
m._FUN_POLY_LRU.clear()
primes = [
    2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37, 41, 43, 47, 53,
    59, 61, 67, 71, 73, 79, 83, 89, 97, 101, 103, 107, 109, 113,
    127, 131, 137, 139, 149, 151, 157, 163, 167, 173, 179, 181, 191,
    193, 197, 199, 211, 223, 227, 229, 233, 239, 241, 251, 257, 263,
    269, 271, 277, 281, 283, 293, 307, 311, 313, 317, 331, 337, 347, 349,
]
for p in primes:
    K = m.GF(p)
    R = m.PolynomialRing(K)
    parent = m.FieldOfFractions(R)
del K, R, parent
gc.collect()
assert len(m._FUN_CACHE) <= m._FUN_CACHE_COUNT == 64
assert len(m._FUN_LRU) == len(m._FUN_CACHE)
assert len(m._FUN_POLY_BY_BASE) <= m._FUN_CACHE_COUNT
assert len(m._FUN_POLY_LRU) <= m._FUN_CACHE_COUNT

# Both refusals occur before changing the ordered caches or a live name.
before = (list(m._FUN_LRU), list(m._FUN_CACHE),
          list(m._FUN_POLY_LRU), list(m._FUN_POLY_BY_BASE))
try:
    m.FunctionField(m.GF(9))
except m.MagmaError:
    pass
else:
    raise AssertionError("extension constant field was admitted in R0a")
name = parent_name = next(iter(m._FUN_CACHE.values()))._name
try:
    next(iter(m._FUN_CACHE.values()))._magma_names(["a", "b"])
except m.MagmaError:
    pass
else:
    raise AssertionError("invalid name assignment was admitted")
after = (list(m._FUN_LRU), list(m._FUN_CACHE),
         list(m._FUN_POLY_LRU), list(m._FUN_POLY_BY_BASE))
assert after == before
assert next(iter(m._FUN_CACHE.values()))._name == parent_name == name

print("ok")
