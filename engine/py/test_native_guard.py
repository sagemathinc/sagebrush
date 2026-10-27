"""The native frames #157 relies on under an asynchronous KeyboardInterrupt
(engine/py/src/guard.rs): locked_call and the ledger's ReleaseLog.

    python engine/py/test_native_guard.py [-k NAME]

The bombardment tests send real signals (POSIX): SIGALRM every 50 us, each
raising one KeyboardInterrupt, while the code under test runs; zero leaked
locks is evidence for the ordering the review inspects, not a proof.
"""
import gc
import sys
import time

import sagebrush  # noqa: F401
from sagebrush.sage import *  # noqa: F401,F403  (the top-level modules _memledger, _capacity)
from sagebrush._native import raster
import _thread

BOMB_S = 6.0  # (seconds of bombardment per case)


def bombard(body, seconds=BOMB_S):
    """body() run in a loop under SIGALRM every 50 us, each alarm raising one
    KeyboardInterrupt (re-armed after each catch); returns (interrupts,
    the results of check() after each)."""
    import signal
    armed = [False]

    def h(*a):
        if armed[0]:
            armed[0] = False
            raise KeyboardInterrupt
    prev = signal.signal(signal.SIGALRM, h)
    signal.setitimer(signal.ITIMER_REAL, 0.00005, 0.00005)
    hits = 0
    t0 = time.monotonic()
    try:
        while time.monotonic() - t0 < seconds:
            try:
                armed[0] = True
                while time.monotonic() - t0 < seconds:
                    body()
                    # (a KeyboardInterrupt swallowed where Python ignores
                    # exceptions, a weakref callback's say: armed again)
                    armed[0] = True
            except KeyboardInterrupt:
                armed[0] = False
                hits += 1
                yield hits
    finally:
        armed[0] = False
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, prev)


def test_locked_call_returns_raises_and_releases():
    L = _thread.allocate_lock()
    assert raster.locked_call(L, lambda: 7) == 7 and not L.locked()

    class Boom(Exception):
        pass
    e = Boom("x")

    def raise_it():
        raise e
    try:
        raster.locked_call(L, raise_it)
        raise AssertionError("not raised")
    except Boom as got:
        assert got is e and not L.locked()
    # (only a _thread lock: an object with a Python acquire could run code
    # between the acquire and the guard)
    for bad in (_thread.RLock(), object()):
        try:
            raster.locked_call(bad, lambda: 1)
            raise AssertionError("accepted %r" % bad)
        except TypeError:
            pass


def test_a_nested_call_on_the_owning_thread_is_refused_at_once():
    L = _thread.allocate_lock()
    seen = []

    def outer():
        try:
            raster.locked_call(L, lambda: 1)
        except RuntimeError as e:
            seen.append(str(e))
        return 2
    assert raster.locked_call(L, outer) == 2 and not L.locked()
    assert seen and "can't nest" in seen[0]
    # (another lock nests fine)
    M = _thread.allocate_lock()
    assert raster.locked_call(L, lambda: raster.locked_call(M, lambda: 3)) == 3 and not L.locked() and not M.locked()


def test_a_stop_while_waiting_holds_nothing():
    # another thread holds the lock; the caller waits in slices and is
    # interrupted: it raises, holding nothing, and the holder's lock is
    # untouched
    import threading
    L = _thread.allocate_lock()
    held, done = threading.Event(), threading.Event()

    def holder():
        L.acquire()
        held.set()
        done.wait(10)
        L.release()
    t = threading.Thread(target=holder)
    t.start()
    held.wait(5)
    threading.Timer(0.1, _thread.interrupt_main).start()
    a0, r0 = raster.locked_call_counts()
    t0 = time.monotonic()
    try:
        raster.locked_call(L, lambda: 1, 0.025)
        raise AssertionError("not interrupted")
    except KeyboardInterrupt:
        pass
    assert time.monotonic() - t0 < 1.0 and L.locked() and raster.locked_call_counts() == (a0, r0)
    done.set()
    t.join(5)
    assert not L.locked()


def test_bombardment_never_leaves_the_lock_held():
    # T9's real-signal variant (astra2/daybreak2): a KeyboardInterrupt landing
    # anywhere around locked_call never leaves the lock held
    if sys.platform == "win32":
        print("  bombardment: n/a (no SIGALRM)")
        return
    L = _thread.allocate_lock()
    sink = []

    def body():
        raster.locked_call(L, lambda: sink.append(1) or sink.clear())
    leaks = 0
    n = 0
    for n in bombard(body):
        if L.locked():
            leaks += 1
            L.release()
    a, r = raster.locked_call_counts()
    print("  bombardment: python %s, %d interrupts, %d leaked locks" % (sys.version.split()[0], n, leaks))
    assert n > 1000 and leaks == 0


def test_bombardment_of_the_ledger_keeps_its_image_and_lock():
    # the ledger's transactions under the same bombardment: its lock is never
    # left held and its image stays consistent (audit), the native guard
    # being the one the ledger uses (lib/_memledger.py _native_locked_call)
    if sys.platform == "win32":
        print("  ledger bombardment: n/a (no SIGALRM)")
        return
    import _memledger
    import test_memledger as T
    assert _memledger._native_locked_call() is raster.locked_call
    led = T.exact(10 ** 9)
    led.rebase()

    class Owner:
        pass
    keep = []

    def body():
        o = Owner()
        keep.append(o)
        led.resident(5, "cpython-heap", owner=o)
        if len(keep) > 50:
            del keep[:25]
            gc.collect()
        led.sweep()
    n = 0
    for n in bombard(body):
        assert not led._lock.locked(), "the ledger's lock left held"
        T.audit(led)
    keep.clear()
    gc.collect()
    led.sweep()
    T.audit(led)
    print("  ledger bombardment: %d interrupts, held %d" % (n, led.held()))
    assert n > 100 and led.held() == 0, led.held()


def test_the_release_log_credits_each_owner_once_and_keeps_none_alive():
    class Owner:
        pass
    log = raster.ReleaseLog()
    owners = [Owner() for _ in range(10)]
    for i, o in enumerate(owners):
        log.track(o, ("resident", "cpython-heap", i))
    log.track(owners[0], ("resident", "cpython-heap", 0))  # (still tracked: a no-op)
    assert log.tracked() == 10 and log.pending() == 0
    import weakref
    w = weakref.ref(owners[3])
    del owners[3]
    gc.collect()
    assert w() is None and log.pending() == 1
    del owners[:3]
    gc.collect()
    got = log.peek(0, 100)
    # (in the order the owners went: 3 first; a deleted slice's order is
    # CPython's)
    assert got[0][1][2] == 3 and sorted(k[2] for _, k in got) == [0, 1, 2, 3] and [s for s, _ in got] == [0, 1, 2, 3], got
    assert log.peek(2, 1) == [got[2]]
    log.ack(2)
    assert log.pending() == 2 and log.peek(0, 9) == got[2:]
    log.ack(2)
    log.ack(1)
    assert log.pending() == 2
    log.ack(4)
    assert log.pending() == 0 and log.tracked() == 6


if __name__ == "__main__":
    names = [n for n in list(globals()) if n.startswith("test_")]
    if "-k" in sys.argv:
        names = [n for n in names if sys.argv[sys.argv.index("-k") + 1] in n]
    for n in names:
        globals()[n]()
        print("ok", n, flush=True)
