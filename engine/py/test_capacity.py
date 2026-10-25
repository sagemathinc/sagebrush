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
# (a readable cgroup file with no memory controller: no cgroup row, and
# no unknown cgroup part either)
os.makedirs(root + "/proc/self")
with open(root + "/proc/self/cgroup", "w") as f:
    f.write("0::/\n")
C._set_sources(root=root, rlimits={}, runtime=lambda: [])
check("16 GiB", C.heap_figure(), 16 * GiB)
check("admitted under 16 GiB", M._admit_size(F, 1450, 1450), (1450, 1450))

# a zero resource limit is a limit (CORR-PR122-1): the guards' total is 0,
# a matrix of one entry refused and an empty one admitted; a real limit of
# exactly the cap's total admits, one byte less refuses
for name in ("RLIMIT_AS", "RLIMIT_DATA"):
    for lim, label, want in ((0, "zero", None), (4 * need, "at the cap", (10, 10)), (4 * need - 1, "one under", ("refused", need, need - 1))):
        rl = {"RLIMIT_AS": (-1, -1), "RLIMIT_DATA": (-1, -1)}
        rl[name] = (lim, -1)
        C._set_sources(root=root, rlimits=rl, runtime=lambda: [])
        check(name + " total " + label, C.heap_figure(), lim)
        if want is None:
            check(name + " zero: one entry", with_total(C.heap_figure(), lambda: M._admit_size(F, 1, 1))[:3], ("refused", M._entry_cost(F), 0))
            check(name + " zero: empty", M._admit_size(F, 0, 0), (0, 0))
        else:
            got = M._admit_size(F, 10, 10) if want == (10, 10) else with_total(C.heap_figure(), lambda: M._admit_size(F, 10, 10))[:3]
            check(name + " " + label, got, want)

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

# capacity()["domains"] on this machine's real basis, with the package's own
# _capacity (plan-d0-domains-r2 §2.1): the checker shared with the pyjs
# test, test/capacity_domains_real.py
import importlib.util
_spec = importlib.util.spec_from_file_location("capacity_domains_real", os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "test", "capacity_domains_real.py"))
_real = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_real)
_rec, _problems = _real.check(C)
check("domains on the real basis", _problems, [])
check("the package's DOMAINS", C.DOMAINS, ("child", "cpython-heap", "js-arraybuffer", "js-heap", "wasm-engine", "wasm-instance"))

# the engine's constrained total (no-cliffs plan C r10 section 1): the
# least limit among the rows that constrain the engine's domain (natively,
# this process's heap), with its status; joint when such a row also bounds a
# host domain (natively the same heap, so always)
C._set_sources(root="/nonexistent", rlimits={}, runtime=lambda: [])
check("engine total, nothing readable", C.engine_total(), {"bytes": 1 << 30, "status": "nominal", "basis": ["nominal"], "joint": False})
C._set_sources(root="/nonexistent", rlimits={}, runtime=lambda: [("a", 700 * MiB, 10 * MiB, ["cpython-heap"], ["cpython-heap"]), ("b", 300 * MiB, None, ["cpython-heap"], ["cpython-heap"])])
check("engine total, the least limit (an unread usage still bounds)", C.engine_total(), {"bytes": 300 * MiB, "status": "observed", "basis": ["b"], "joint": True})
C._set_sources(root="/nonexistent", rlimits={}, runtime=lambda: [("w", 4 * GiB, 0, ["wasm-engine"], ["wasm-engine"])])
check("engine total, another domain's row does not count", C.engine_total()["status"], "nominal")
C._set_sources(root="/nonexistent", rlimits={}, runtime=lambda: [("z", 0, 0, ["cpython-heap"], ["cpython-heap"]), ("a", 9 * MiB, 0, ["cpython-heap"], ["cpython-heap"])])
check("engine total, an observed zero stays zero", C.engine_total(), {"bytes": 0, "status": "zero", "basis": ["z"], "joint": True})
C._set_sources(root=root, rlimits={}, runtime=lambda: [])
_t = C.engine_total()
check("engine total, MemTotal from /proc", (_t["status"], _t["basis"], _t["joint"]), ("observed", ["MemAvailable"], True))
C._set_sources()

# every row that constrains the engine's domain, not only the least ones
# (no-cliffs plan C r17 section 1): astra2's probe, in pyjs's domains (the
# engine's own WebAssembly memory), through the real helpers
import sys as _sys2
_NOLIM = {"RLIMIT_AS": (-1, -1), "RLIMIT_DATA": (-1, -1)}  # (readable: no limit set)
_probe = lambda: [("engine-local", 4 * GiB, 768 * MiB, ["wasm-engine"], ["wasm-engine"]),
                  ("process-joint", 8 * GiB, 2304 * MiB, ["wasm-engine", "js-heap"], ["wasm-engine", "js-heap"])]
C._set_sources(root=root, rlimits=_NOLIM, runtime=_probe)
_sys2._sagebrush_heap_limit = 1  # (pyjs: the engine's domain is wasm-engine)
try:
    _et, _er = C.engine_total(), C.engine_rows()
finally:
    del _sys2._sagebrush_heap_limit
check("probe: engine_total keeps its least-rows contract", (_et["bytes"], _et["basis"], _et["joint"]), (4 * GiB, ["engine-local"], False))
check("probe: engine_rows lists the larger joint row too (and the machine's)",
      [(r["source"], r["figure"], r["joint"]) for r in _er["rows"]],
      [("MemAvailable", 16 * GiB, True), ("engine-local", 4 * GiB, False), ("process-joint", 8 * GiB, True)])
check("probe: the classification is complete", _er["complete"], True)
# (the host's bit for the WebAssembly ledger: some applicable row joint or
# unknown -> not certified; src/runtime/engine.ts computes the same)
_sys2._sagebrush_heap_limit = 1
try:
    check("probe: uncertified in WebAssembly (engine.ts reads this)", C.engine_uncertified(), True)
    C._set_sources(root=root, rlimits=_NOLIM, runtime=lambda: [("engine-local", 4 * GiB, 768 * MiB, ["wasm-engine"], ["wasm-engine"])])
    # (MemAvailable bounds every domain: joint for the engine too, so even an
    # engine-local row alongside it stays uncertified in WebAssembly)
    check("a machine row is joint for the WebAssembly engine", C.engine_uncertified(), True)
finally:
    del _sys2._sagebrush_heap_limit
C._set_sources(root=root, rlimits=_NOLIM, runtime=lambda: [("old", 2 * GiB, 0)])
check("a part whose domains are unknown makes the classification incomplete", C.engine_rows()["complete"], False)
C._set_sources(root="/nonexistent", rlimits={}, runtime=lambda: [])
check("an unreadable constraint makes it incomplete", C.engine_rows()["complete"], False)
C._set_sources(root=root, rlimits={}, runtime=lambda: [])
check("an unreadable RLIMIT makes it incomplete", C.engine_rows()["complete"], False)
# natively every applicable row reaches the ledger with its own measure; a
# row with no native measure is an "unknown" row (fail-closed)
import sagebrush as _sb
C._set_sources(root=root, rlimits={"RLIMIT_AS": (64 * GiB, -1), "RLIMIT_DATA": (-1, -1)}, runtime=lambda: [])
_ct = _sb._capacity_total()
check("native rows: every applicable row, with its own figure", sorted((k, f) for k, _p, f in _ct[3]), [("address_space", 64 * GiB), ("physical", 16 * GiB)])
C._set_sources(root=root, rlimits=_NOLIM, runtime=lambda: [("made-up", 2 * GiB, 0, ["cpython-heap"], ["cpython-heap"])])
check("native rows: a row with no measure is unknown", ("unknown", None, 2 * GiB) in _sb._capacity_total()[3], True)
C._set_sources()

# the engine's ledger takes its total from engine_total (no-cliffs C-1):
# the registered source answers, and the counting allocator sees the
# module's own allocations
from sagebrush import _native
C._set_sources(root=root, rlimits=_NOLIM, runtime=lambda: [])
import time as _t2
_t2.sleep(0.15)  # (the engine's figure is read again when 100 ms old)
_snap = _native.ledger_snapshot()
check("the ledger's total is engine_total's", (_snap["total"], _snap["status"], _snap["joint"]), (16 * GiB, "observed", True))
check("the ledger's allowance is a quarter", _snap["allowance"], 4 * GiB)
check("the process's own measure is read (physical row)", _snap["live"] > 0 and _snap["certified"], True)
check("nothing outstanding between calls", _snap["outstanding"], 0)
C._set_sources()

os.remove(root + "/proc/meminfo")
os.remove(root + "/proc/self/cgroup")
os.rmdir(root + "/proc/self")
os.rmdir(root + "/proc")
os.rmdir(root)
print("test_capacity:", "FAILED %d" % failures if failures else "ok")
sys.exit(1 if failures else 0)
