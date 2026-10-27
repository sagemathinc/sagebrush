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
# engine-only means EXACTLY the engine's domain (astra2's CORR-C2A-2): any
# other domain, wasm-instance and child included, makes a row joint, and so
# does a domain this module doesn't know (dropped from the list, flagged)
_real_capacity = C.capacity
def _classify(con):
    C._set_sources()
    C.capacity = lambda: {"basis": [{"source": "r", "limit": 4 * GiB, "used": 0, "remaining": 4 * GiB, "includes": con, "constrains": con}],
                          "unknown_parts": []}
    _sys2._sagebrush_heap_limit = 1
    try:
        return C.engine_uncertified()
    finally:
        del _sys2._sagebrush_heap_limit
        C.capacity = _real_capacity
for _con, _want in ((["wasm-engine"], False), (["wasm-engine", "js-heap"], True), (["wasm-engine", "wasm-instance"], True),
                    (["wasm-engine", "child"], True)):
    check("exact engine-only: %s" % "+".join(_con), _classify(_con), _want)
C._set_sources(root=root, rlimits=_NOLIM, runtime=lambda: [("p", 4 * GiB, 0, ["wasm-engine"], ["wasm-engine", "made-up-domain"])])
_sys2._sagebrush_heap_limit = 1
try:
    check("an unknown constrained domain makes the row joint", [r["joint"] for r in C.engine_rows()["rows"] if r["source"] == "p"], [True])
finally:
    del _sys2._sagebrush_heap_limit
check("engine_total's least-rows joint flag is unchanged", C.engine_total()["joint"], True)
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

# what the total source raises (CORR-C1-1): a KeyboardInterrupt, SystemExit or
# any other BaseException, from the call or from converting its answer,
# reaches the call that asked, as the same object, and no other call; an
# ordinary failure or a malformed answer is an unreadable total
import threading

_source = sagebrush._capacity_total
_good = _source()


def _stand_in(f):
    sagebrush._capacity_total = f
    _t2.sleep(0.15)  # (read again when 100 ms old)


def _raising(exc):
    def f():
        raise exc
    return f


class _BadInt:
    def __init__(self, exc):
        self.exc = exc

    def __index__(self):
        raise self.exc


def _snapshot():
    try:
        return ("returned", _native.ledger_snapshot())
    except BaseException as e:  # noqa: B902  (the point of the test)
        return ("raised", e)


def _raised(got, exc):
    return got[0] == "raised" and got[1] is exc


for _kind in (KeyboardInterrupt, SystemExit):
    _exc = _kind()
    _stand_in(_raising(_exc))
    check("a %s from the source reaches the asking call, the same object" % _kind.__name__, _raised(_snapshot(), _exc), True)
    _exc = _kind()
    _stand_in(lambda e=_exc: (_BadInt(e), _good[1], _good[2], _good[3]))
    check("a %s converting its answer reaches the asking call, the same object" % _kind.__name__, _raised(_snapshot(), _exc), True)
for _f, _label in ((_raising(OSError("unreadable")), "an ordinary failure of the source"),
                   (lambda: (_BadInt(ValueError("bad")), _good[1], _good[2], _good[3]), "an ordinary failure converting its answer"),
                   (lambda: ("x", 0, False, []), "a malformed answer")):
    _stand_in(_f)
    _got = _snapshot()
    check(_label + " is an unreadable total", (_got[0],) + ((_got[1]["status"], _got[1]["certified"]) if _got[0] == "returned" else ()), ("returned", "nominal", False))


def _two_callers(a_first, b_answers):
    """Thread A asks; its source raises a_first, then (on the same call's
    next read) waits while thread B asks with sources b_answers (one per
    read: an exception to raise, or None for the good answer).  Returns
    (A's result, B's result)."""
    a_waiting, go = threading.Event(), threading.Event()
    reads = {"A": 0, "B": 0}

    def source():
        who = threading.current_thread().name
        n = reads[who]
        reads[who] = n + 1
        if who == "A":
            if n == 0:
                raise a_first
            a_waiting.set()
            go.wait(10)
            return _good
        e = b_answers[min(n, len(b_answers) - 1)]
        if e is not None:
            raise e
        return _good

    out = {}

    def ask(who):
        out[who] = _snapshot()

    _stand_in(source)
    a = threading.Thread(target=ask, args=("A",), name="A")
    a.start()
    if a_waiting.wait(10):
        b = threading.Thread(target=ask, args=("B",), name="B")
        b.start()
        b.join(10)
    go.set()
    a.join(10)
    return out.get("A"), out.get("B")


_exc_a = SystemExit()
_a, _b = _two_callers(_exc_a, [None])
check("another call's successful read does not take A's exception", (_b[0] if _b else None, _b[1]["status"] if _b and _b[0] == "returned" else None), ("returned", "observed"))
check("A raises its own exception, the same object", _raised(_a or ("missing",), _exc_a), True)
_exc_a, _exc_b = KeyboardInterrupt(), KeyboardInterrupt()
_a, _b = _two_callers(_exc_a, [_exc_b, None])
check("two failing calls: B raises its own", _raised(_b or ("missing",), _exc_b), True)
check("two failing calls: A raises its own", _raised(_a or ("missing",), _exc_a), True)

# every native computation is an asking call (no-cliffs C-2c scope r2
# section 2): guarded/run enter it on the calling thread before the handoff
# and finish it there; a stale total is refreshed on that thread first, the
# source never runs on a worker, and what it raises reaches that call
_EC = [[0, 0, 1, -1, 0]]  # (an elliptic curve: aplist_many runs on a pool)


def _native_calls():
    return {
        "call (guarded)": lambda: _native.call('{"fn": "progress_tables"}'),
        "aplist_many (run, a pool)": lambda: _native.ap.aplist_many(_EC, 200, 4),
    }


def _outcome(f):
    try:
        return ("returned", f())
    except BaseException as e:  # noqa: B902  (the point of the test)
        return ("raised", e)


for _name, _f in _native_calls().items():
    _ran_on = []

    def _recording(ran_on=_ran_on):
        ran_on.append(threading.get_ident())
        return _good
    _stand_in(_recording)
    _got = _outcome(_f)
    check("%s: the source ran on the calling thread only" % _name, (_got[0], set(_ran_on)), ("returned", {threading.get_ident()}))
    for _kind in (KeyboardInterrupt, SystemExit):
        _exc = _kind()
        _stand_in(_raising(_exc))
        check("%s: a %s from the source reaches that call, the same object" % (_name, _kind.__name__), _raised(_outcome(_f), _exc), True)
    # an ordinary failure leaves the total unreadable, so stale on every
    # read: a worker's read would run the source if it could ask (it can't)
    _failed_on = []

    def _failing(failed_on=_failed_on):
        failed_on.append(threading.get_ident())
        raise OSError("unreadable")
    _stand_in(_failing)
    _got = _outcome(_f)
    check("%s: an ordinary failure of the source is an unreadable total, not an error, and no worker asked" % _name, (_got[0], set(_failed_on)), ("returned", {threading.get_ident()}))


def _two_native_callers(f):
    """Two threads run the same native call at once, each with its own
    control exception from the source: each raises its own."""
    excs = {"A": KeyboardInterrupt(), "B": SystemExit()}
    both_in = threading.Barrier(2)

    def source():
        who = threading.current_thread().name
        try:
            both_in.wait(5)
        except threading.BrokenBarrierError:
            pass
        raise excs[who]

    _stand_in(source)
    out = {}
    ts = [threading.Thread(target=lambda w=w: out.__setitem__(w, _outcome(f)), name=w) for w in ("A", "B")]
    for t in ts:
        t.start()
    for t in ts:
        t.join(20)
    return all(_raised(out.get(w, ("missing",)), excs[w]) for w in ("A", "B"))


for _name, _f in _native_calls().items():
    check("%s: two simultaneous callers each get their own exception" % _name, _two_native_callers(_f), True)

_stand_in(_source)
_snap = _native.ledger_snapshot()
check("the next read answers again", (_snap["total"], _snap["status"], _snap["certified"]), (16 * GiB, "observed", True))
check("a native call still runs", P.factor([-1, 0, 1]), (1, [([-1, 1], 1), ([1, 1], 1)]))
C._set_sources()

os.remove(root + "/proc/meminfo")
os.remove(root + "/proc/self/cgroup")
os.rmdir(root + "/proc/self")
os.rmdir(root + "/proc")
os.rmdir(root)
print("test_capacity:", "FAILED %d" % failures if failures else "ok")
sys.exit(1 if failures else 0)
