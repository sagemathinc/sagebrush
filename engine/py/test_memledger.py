"""The PNG engine's memory ledger (lib/_memledger.py; PNG plan r8 section
2.1), with D0's observations replaced by figures the tests choose:

    python engine/py/test_memledger.py

F0 is effective_guard_bytes(capacity()), never heap_figure(); the
re-base observes, then absorbs in the same step; the shrink transition
(admitting, reap and re-observe, overdrawn); each record accounted once by
its own state, whatever the re-bases since.
"""
import gc
import sys

import sagebrush  # noqa: F401  (the top-level modules _capacity, _memguard)
from sagebrush.sage import *  # noqa: F401,F403
import _capacity
import _memledger

ALL = list(_capacity.DOMAINS)


def obs(free, domains=ALL):
    """A D0 record: `free` bytes observed (None: unknown), its reserve D0's."""
    return {"bytes": free, "basis": [], "unknown_parts": [], "observed_at": 0,
            "reserve_bytes": _capacity.reserve_bytes(free), "domains": [] if free is None else list(domains)}


def eff(free):
    return _capacity.effective_guard_bytes(obs(free))


class Feed:
    """capacity() returning the figures set on it."""

    def __init__(self, free, domains=ALL):
        self.free, self.domains = free, domains

    def __call__(self):
        return obs(self.free, self.domains)


def ledger(free, domains=ALL, environ=None):
    feed = Feed(free, domains)
    return _memledger.Ledger(capacity=feed, environ=environ if environ is not None else {}), feed


def test_f0_is_d0s_effective_figure_and_never_heap_figure():
    led, feed = ledger(4 << 30)
    room = led.rebase()
    assert room == eff(4 << 30) < (4 << 30), room
    # host + engine reach the effective figure, never the raw headroom
    h = led.reserve("host", "cpython-heap", 1000)
    g = led.grant("child")
    assert h.bytes + g.bytes == eff(4 << 30)
    # (no ledger code names heap_figure; and replaced, it changes nothing)
    import ast
    tree = ast.parse(open(_memledger.__file__).read())
    names = {n.attr for n in ast.walk(tree) if isinstance(n, ast.Attribute)} | {n.id for n in ast.walk(tree) if isinstance(n, ast.Name)}
    assert "heap_figure" not in names
    orig = _capacity.heap_figure
    _capacity.heap_figure = lambda: 1 << 60
    try:
        led.release(h)
        led.release(g)
        assert led.rebase() == eff(4 << 30)
    finally:
        _capacity.heap_figure = orig


def test_unknown_memory_refuses_and_clears_nothing_and_the_override_is_used():
    led, feed = ledger(1 << 30)
    led.rebase()
    out = led.resident(1000, "cpython-heap")
    feed.free = None
    try:
        led.rebase()
        raise AssertionError("not refused")
    except MemoryError as e:
        assert "SAGEBRUSH_MEMORY_BYTES" in str(e)
    assert out.state == _memledger.LIVE and out in led.records
    led2, _ = ledger(None, environ={"SAGEBRUSH_MEMORY_BYTES": "5000000"})
    assert led2.rebase() == 5000000


def test_outputs_are_absorbed_by_the_next_observation_covering_them():
    led, feed = ledger(1 << 30)
    led.rebase()
    r = led.resident(10 << 20, "cpython-heap")
    assert led.held() == 10 << 20
    led.rebase()
    assert r.state == _memledger.ABSORBED and led.held() == 0
    # a domain the observation doesn't cover stays charged
    led, feed = ledger(1 << 30, domains=["cpython-heap"])
    led.rebase()
    u = led.resident(10 << 20, "js-arraybuffer")
    led.rebase()
    led.rebase()
    assert u.state == _memledger.LIVE and led.held() == 10 << 20


def test_a_thousand_calls_with_a_warm_child_accumulate_nothing():
    led, feed = ledger(1 << 30)
    led.rebase()
    led.set_standing(50 << 20)
    for i in range(1000):
        room = led.rebase(child=lambda: (50 << 20, 30 << 20))
        assert led.held() == (50 << 20) - (30 << 20), (i, led.held())
        h = led.reserve("host", "cpython-heap", 4096)
        g = led.grant("child")
        led.release(g)
        led.release(h)
        led.resident(4096, "cpython-heap")
    led.rebase(child=lambda: (50 << 20, 30 << 20))
    assert led.held() == 20 << 20


def test_the_shrink_transition_at_equality_and_one_byte_less():
    F = eff(1 << 30)
    # a warm child: survivors == F0' admits with nothing left; F0' - 1 asks
    # for the reap (nothing published)
    led, feed = ledger(1 << 30)
    led.rebase()
    led.set_standing(F + (10 << 20))
    assert led.rebase(child=lambda: (F + (10 << 20), 10 << 20)) == 0
    assert led.f0 == F
    try:
        led.rebase(child=lambda: (F + (10 << 20) + 1, 10 << 20))
        raise AssertionError("not refused")
    except _memledger.NeedReap:
        assert led.f0 is None and not led.overdrawn
    led.set_standing(None)
    assert led.rebase() == F
    # unreclaimed unobservable memory: == admits, - 1 is overdrawn, and the
    # finalizer's flag lets the next call admit
    led, feed = ledger(1 << 30, domains=["cpython-heap"])
    led.rebase()

    class Owner:
        pass
    o = Owner()
    u = led.resident(F, "wasm-instance", owner=o)
    assert led.rebase() == 0
    u.bytes = F + 1
    try:
        led.rebase()
        raise AssertionError("not refused")
    except MemoryError:
        assert led.overdrawn and led.f0 is None
    del o
    gc.collect()
    assert u.finalized
    assert led.rebase() == F and not led.overdrawn and u.state == _memledger.RELEASED


def test_each_record_is_accounted_once_by_its_own_state():
    class Owner:
        pass
    # A, unobservable, carried through two re-bases, then finalized: released
    # once; later calls recover
    led, feed = ledger(1 << 30, domains=["cpython-heap"])
    led.rebase()
    a_owner = Owner()
    a = led.resident(1 << 20, "js-arraybuffer", owner=a_owner)
    led.rebase()
    led.rebase()
    assert a.state == _memledger.LIVE and led.held() == 1 << 20
    del a_owner
    gc.collect()
    led.rebase()
    assert a.state == _memledger.RELEASED and led.held() == 0
    # A absorbed (observable), its callback later, with B live: B unchanged,
    # nothing refunded twice
    led, feed = ledger(1 << 30)
    led.rebase()
    a_owner = Owner()
    a = led.resident(1 << 20, "cpython-heap", owner=a_owner)
    led.rebase()
    assert a.state == _memledger.ABSORBED
    b = led.resident(2 << 20, "cpython-heap")
    del a_owner
    gc.collect()
    led._sweep()
    assert a.state == _memledger.ABSORBED and b.state == _memledger.LIVE and led.held() == 2 << 20
    # (no record keeps what it tracks alive)
    o = Owner()
    r = led.resident(1, "cpython-heap", owner=o)
    assert not any(isinstance(x, Owner) for x in gc.get_referents(r))


def test_reservations_past_the_room_are_refused():
    led, feed = ledger(1 << 30)
    room = led.rebase()
    try:
        led.reserve("host", "cpython-heap", room + 1)
        raise AssertionError("not refused")
    except MemoryError as e:
        assert e.need_bytes == room + 1 and e.limit_bytes == room
    h = led.reserve("host", "cpython-heap", room)
    assert led.grant("child").bytes == 0


if __name__ == "__main__":
    for n in [n for n in list(globals()) if n.startswith("test_")]:
        globals()[n]()
        print("ok", n)
