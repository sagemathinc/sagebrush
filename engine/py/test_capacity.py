"""The memory figures in the CPython package (item D0, plan-d0-capacity-r2):

- the guards' total is the machine's (no sys._sagebrush_heap_limit here),
  and a guard follows it: a 300 MiB matrix refused under the nominal 1 GiB
  is admitted under an injected 16 GiB;
- each guard's predicate at need = cap and cap + 1;
- where the cap and the observed headroom cross, the refusal is the cap's,
  with the headroom only recorded;
- the native engines ask the package for their share: a pushed-in small
  share refuses a factorization with the share's reason, none gives the
  default, and x^2 - 1 factors under a small real headroom.

    python engine/py/test_capacity.py
"""
import math
import sys

import sagebrush
import sagebrush.sage  # noqa: F401  (the Sage layer's names: _capacity, _sage_ffmat)
import sagebrush.poly as P
import _capacity as C
import _sage_ffmat as M
import sage_all as S

MiB, GiB = 1 << 20, 1 << 30
failures = 0


def check(label, got, want):
    global failures
    if got != want:
        failures += 1
        print("FAIL", label, "got", repr(got), "want", repr(want))


check("the package's own _capacity", sys.modules["_capacity"] is sagebrush._capacity_module(), True)
check("no pyjs figure here", hasattr(sys, "_sagebrush_heap_limit"), False)
check("the total is the machine's", C.heap_figure(), C._machine_total()[0])

real = C.heap_figure


def with_total(t, f):
    C.heap_figure = lambda: t
    try:
        return f()
    except (NotImplementedError, MemoryError) as e:
        return ("refused", e.need_bytes, e.limit_bytes, e.capacity["bytes"])
    finally:
        C.heap_figure = real


F = S.GF(7)
need = 10 * 10 * M._entry_cost(F)
check("matrix at the cap", with_total(4 * need, lambda: M._admit_size(F, 10, 10)), (10, 10))
check("matrix one over", with_total(4 * need - 1, lambda: M._admit_size(F, 10, 10))[:3], ("refused", need, need - 1))
sneed = 1000 + math.isqrt(999)
check("sieve at the cap", with_total(16 * sneed, lambda: S._admit_prime_sieve(0, 1000, "primes")), None)
check("sieve one over", with_total(16 * sneed - 1, lambda: S._admit_prime_sieve(0, 1000, "primes"))[:3], ("refused", sneed, sneed - 1))

# the guard follows the machine: nothing readable is the nominal 1 GiB (a
# 303 MiB matrix refused at 256 MiB); 16 GiB of memory admits it
C._set_sources(root="/nonexistent", rlimits={}, runtime=lambda: [])
check("nominal", (C.heap_figure(), M._admit_size(F, 10, 10)), (GiB, (10, 10)))
check("nominal refuses", with_total(C.heap_figure(), lambda: M._admit_size(F, 1450, 1450))[:3], ("refused", 317477500, 256 * MiB))
import os
import tempfile
root = tempfile.mkdtemp(prefix="sb-capacity-")
os.makedirs(root + "/proc")
with open(root + "/proc/meminfo", "w") as f:
    f.write("MemTotal:       %d kB\nMemAvailable:   %d kB\n" % (16 * GiB // 1024, 12 * GiB // 1024))
C._set_sources(root=root, rlimits={}, runtime=lambda: [])
check("16 GiB", C.heap_figure(), 16 * GiB)
check("admitted under 16 GiB", M._admit_size(F, 1450, 1450), (1450, 1450))

# cap and headroom crossing (the headroom from a made-up runtime part)
C._set_sources(root="/nonexistent", rlimits={}, runtime=lambda: [("made-up", 700 * MiB, 0)])
check("cap below headroom", with_total(GiB, lambda: M._admit_size(F, 1450, 1450)), ("refused", 317477500, 256 * MiB, 700 * MiB))
C._set_sources(root="/nonexistent", rlimits={}, runtime=lambda: [("made-up", 200 * MiB, 0)])
check("headroom below cap", (with_total(4 * GiB, lambda: M._admit_size(F, 1450, 1450)), C.capacity()["bytes"]), ((1450, 1450), 200 * MiB))
C._set_sources()

# the native engines' share
c = (1 << 2000) + 7
big = [-c * c, 0, 1]
check("default", len(P.factor(big)[1]), 2)
real_share = C.poly_share
C.poly_share = lambda: 1024
try:
    P.factor(big)
    check("a small share refuses", "factored", "refused")
except ValueError as e:
    check("a small share refuses", "the limit, 1024 bytes, is this factorization's share" in str(e), True)
C.poly_share = lambda: None
check("none is the default", len(P.factor(big)[1]), 2)
C.poly_share = lambda: -3
check("a negative share is none", len(P.factor(big)[1]), 2)
C.poly_share = real_share
C._set_sources(root="/nonexistent", rlimits={}, runtime=lambda: [("made-up", 400000, 0)])
check("small headroom", C.poly_share(), 100000)
check("x^2 - 1 under it", P.factor([-1, 0, 1]), (1, [([-1, 1], 1), ([1, 1], 1)]))
C._set_sources()

os.remove(root + "/proc/meminfo")
os.rmdir(root + "/proc")
os.rmdir(root)
print("test_capacity:", "FAILED %d" % failures if failures else "ok")
sys.exit(1 if failures else 0)
