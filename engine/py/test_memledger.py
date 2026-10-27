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


def native_like(lock, fn):
    # (a stand-in for _raster.locked_call where the native module has none:
    # its frames aren't _memledger's, so the opcode injector below never
    # raises inside it, as it can't inside the Rust frame)
    lock.acquire()
    try:
        return fn()
    finally:
        lock.release()


if _memledger._native_locked_call() is None:
    _memledger._native_locked_call = lambda: native_like


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
    led.release(u)
    u = led.resident(F + 1, "wasm-instance", owner=o)
    try:
        led.rebase()
        raise AssertionError("not refused")
    except MemoryError:
        assert led.overdrawn and led.f0 is None
    del o
    gc.collect()
    assert led.pending_releases() >= 1
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


# ---- #157 r2: the call's end as one step (astra2's CORR-157-2, daybreak2's LIMIT-PNG-A2-1/2)

def exact(free, domains=ALL):
    """A ledger whose F0 is exactly `free` (no reserve)."""
    def cap():
        return {"bytes": free, "basis": [], "unknown_parts": [], "observed_at": 0, "reserve_bytes": 0,
                "domains": [] if free is None else list(domains)}
    return _memledger.Ledger(capacity=cap, environ={})


def test_the_calls_end_replaces_the_grant_with_standing_in_one_step():
    # astra2's replay: F0 = 1000, host 100, engine 900; a new standing charge
    # of 200 installed while the grant and the host were still live gave held
    # = 1200 > F0.  end_call replaces the grant, carves out the outputs and
    # refunds the rest in one step: held never passes F0
    led = exact(1000)
    assert led.rebase() == 1000
    h = led.reserve("host", "cpython-heap", 100)
    e = led.grant("child")
    assert (h.bytes, e.bytes, led.held()) == (100, 900, 1000)
    out = led.end_call(h, e, 200, [(60, "cpython-heap", None)])
    assert led.held() == 260 <= led.f0 == 1000, led.records
    assert led.standing.bytes == 200 and [r.bytes for r in out] == [60]
    assert not any(r.kind in ("host", "engine") for r in led.records)
    # (a standing charge is never more than the standing it replaced plus the
    # grant: the contained mode's unenforced use isn't charged past what was
    # admitted)
    assert led.rebase() == 1000 - 200
    h = led.reserve("host", "cpython-heap", 0)
    e = led.grant("child")
    led.end_call(h, e, 1 << 40)
    assert led.standing.bytes == 200 + e.bytes == 1000 and led.held() == 1000


def test_outputs_past_the_host_reservation_leave_the_ledger_overdrawn_not_past_f0():
    led = exact(1000)
    led.rebase()
    h = led.reserve("host", "cpython-heap", 100)
    e = led.grant("child")
    # (the host formula short by a byte: a Sagebrush bug, never held > F0 published)
    led.end_call(h, e, None, [(1001, "cpython-heap", None)])
    assert led.f0 is None and led.overdrawn and led.room() == 0
    # (covered by the next observation: admitting again)
    assert led.rebase() == 1000


def test_the_invariant_is_checked_at_every_change():
    led = exact(1000)
    led.rebase()
    h = led.reserve("host", "cpython-heap", 400)
    # (a state past F0, a grant counted twice say, is caught at the next
    # change, as a Sagebrush bug)
    bad = _memledger.Record(999, "engine", "child", 700)
    led._inject_for_test(bad)
    try:
        led.reserve("host", "cpython-heap", 0)
        raise AssertionError("not checked")
    except RuntimeError as e:
        assert "more than F0" in str(e)
    led._remove_for_test(bad)
    led.end_call(h, None, None)
    assert led.held() == 0, led.records


def test_an_unobservable_outputs_charge_follows_its_buffer_through_aliases():
    # (CORR-157-6, as both reviewers settled it: with D0 blind and the
    # override, a decode's values stay charged while any view of their buffer
    # lives, the finalizer being on the buffer; then released, and the next
    # call admitted.  A render's bytes can't be followed: _sbraster refuses
    # them there, test_raster_child.py)
    import numpy as np

    class Buf(bytearray):
        __slots__ = ("__weakref__",)
    led = _memledger.Ledger(capacity=lambda: obs(None), environ={"SAGEBRUSH_MEMORY_BYTES": "1000"})
    assert led.rebase() == 1000
    h = led.reserve("host", "cpython-heap", 300)
    e = led.grant("child")
    buf = Buf(16 + 4 * 6)
    arr = np.frombuffer(buf, dtype=np.float32, offset=16)
    led.end_call(h, e, None, [(200, "cpython-heap", buf), (100, "cpython-heap", arr)])
    del buf
    view = arr.reshape((2, 3))
    del arr
    gc.collect()
    # (the name is gone, but the view holds the array and its buffer: both
    # charges stay)
    assert led.rebase() == 1000 - 300, led.records
    mv = memoryview(view)
    del view
    gc.collect()
    assert led.rebase() == 1000 - 300, "a memoryview of the view keeps them, and their charges"
    del mv
    gc.collect()
    assert led.rebase() == 1000 and led.held() == 0
    h = led.reserve("host", "cpython-heap", 1000)
    led.end_call(h, None, None)


# ---- #157 simpler path r10: the ledger as one immutable image (T1, T2, U1,
# U2, W1, Y1; astra2's and daybreak2's reviews r6-r10)

def audit(led):
    """The image's own consistency: an AVL tree in key order whose heights
    and charge sums are right, the active count, the standing key."""
    st = led._state
    keys, act = [], [0]

    def walk(n):
        if n is None:
            return 0, 0
        hl, sl = walk(n.l)
        keys.append(n.k)
        hg, sg = walk(n.g)
        assert abs(hl - hg) <= 1, "unbalanced"
        assert n.h == max(hl, hg) + 1 and n.s == sl + sg + n.r.bytes, "stale node"
        assert n.k == n.r.key, "key"
        act[0] += n.r.kind in _memledger.ACTIVE
        return n.h, n.s
    h, s = walk(st.records)
    assert keys == sorted(keys) and len(set(keys)) == len(keys)
    assert s == led.held() and act[0] == st.active
    if st.standing is not None:
        assert _memledger._get(st.records, st.standing) is not None
    return h


def summary(led):
    st = led._state
    return (sorted((r.kind, r.domain, r.bytes) for r in led.records), st.f0, st.overdrawn, sorted(st.applied), st.obs is None)


class Injected(KeyboardInterrupt):
    pass


def opcodes(fn, at=None, sites=None):
    """fn() with a KeyboardInterrupt raised at the at-th opcode executed in
    _memledger's own frames (an opcode is a superset of the interpreter's
    eval-breaker points); returns the number of opcodes, or raises.  sites:
    a list filled with each opcode's (code, offset)."""
    count = [0]
    target = _memledger.__file__

    def tracer(frame, event, arg):
        if frame.f_code.co_filename != target:
            return None
        frame.f_trace_opcodes = True

        def local(frame, event, arg):
            if event == "opcode":
                if at is not None and count[0] == at:
                    count[0] += 1
                    raise Injected()
                if sites is not None:
                    sites.append((frame.f_code, frame.f_lasti))
                count[0] += 1
            return local
        return local
    sys.settrace(tracer)
    try:
        fn()
    finally:
        sys.settrace(None)
    return count[0]


def seams(setup, op, check=None):
    """op(led) interrupted at every instruction site it executes (each
    site's first and last execution), then retried: the image consistent
    after each interruption, and the retry's end the same as an
    uninterrupted run's."""
    led = setup()
    sites = []
    n = opcodes(lambda: op(led), sites=sites)
    want = summary(led)
    first, last = {}, {}
    for i, s in enumerate(sites):
        first.setdefault(s, i)
        last[s] = i
    for k in sorted(set(first.values()) | set(last.values())):
        led = setup()
        try:
            opcodes(lambda: op(led), at=k)
        except Injected:
            pass
        audit(led)
        if check:
            check(led)
        op(led)
        audit(led)
        assert summary(led) == want, (k, summary(led), want)
    return n


def test_r10_every_transaction_survives_a_ctrl_c_at_every_opcode():
    class Owner:
        pass
    keep = []

    def admitted():
        led = exact(1000)
        led.rebase()
        for i in range(5):
            led.resident(10, "cpython-heap")
        return led

    # admission: one commit (host and grant) or nothing
    def admit(led):
        led.admit(901, 902, 100, 903, "child")
    n = seams(admitted, admit, lambda led: (led._state.active in (0, 2)) or (_ for _ in ()).throw(AssertionError("half admitted")))
    assert n > 10

    def ended():
        led = admitted()
        led.admit(901, 902, 100, 903, "child")
        return led

    def end(led):
        st = led._state
        h = _memledger._get(st.records, ("host", "cpython-heap", 902))
        e = _memledger._get(st.records, ("engine", "child", 903))
        o = Owner()
        keep.append(o)
        led.end_call(h, e, 200, [(30, "cpython-heap", None), (20, "cpython-heap", o)], txn=904, out_ids=[905, 906])

    def no_double(led):
        rs = led.records
        assert sum(r.kind == "standing" for r in rs) <= 1, rs
        assert led.held() <= led.f0, rs
    seams(ended, end, no_double)

    def rollback(led):
        st = led._state
        h = _memledger._get(st.records, ("host", "cpython-heap", 902))
        e = _memledger._get(st.records, ("engine", "child", 903))
        led.rollback(907, h, e, True)
    seams(ended, rollback)

    # a re-base absorbing many residents in several chunks, with a standing charge
    def many():
        led = exact(10 ** 6)
        led.rebase()
        led.set_standing(500)
        for i in range(40):
            led.resident(7, "cpython-heap")
        led.resident(11, "js-arraybuffer")
        return led
    old = _memledger.CHUNK
    _memledger.CHUNK = 8
    try:
        seams(many, lambda led: led.rebase(child=lambda: (600, 100)))
    finally:
        _memledger.CHUNK = old

    def closing(led):
        led.close([901, 904])
    seams(ended, closing)


def test_r10_absorption_removes_only_covered_residents_of_its_snapshot():
    # (W1) a snapshot with covered residents, uncovered residents and a
    # standing record: after the absorption only the covered residents are gone
    led = _memledger.Ledger(capacity=lambda: {"bytes": 10 ** 9, "basis": [], "unknown_parts": [], "observed_at": 0,
                                              "reserve_bytes": 0, "domains": ["cpython-heap"]}, environ={})
    led.rebase()
    led.set_standing(1000)
    cov = [led.resident(10, "cpython-heap") for _ in range(30)]
    unc = [led.resident(20, "js-heap") for _ in range(30)]
    st0 = led.standing
    old = _memledger.CHUNK
    _memledger.CHUNK = 7
    try:
        led.rebase()
    finally:
        _memledger.CHUNK = old
    left = led.records
    assert not any(r in left for r in cov) and all(r in left for r in unc), left
    assert led.standing.bytes == st0.bytes and led.held() == 1000 + 600
    # (an active record during a re-base is the invariant's error)
    led._inject_for_test(_memledger.Record(99999, "host", "cpython-heap", 1))
    try:
        led.rebase()
        raise AssertionError("not refused")
    except RuntimeError as e:
        assert "call active" in str(e)


def test_r10_a_resident_published_between_chunks_is_never_absorbed_by_that_observation():
    # (U1, astra2's counterexample) the observation's eligible set is its
    # snapshot: a resident published after it, between two chunks (or with an
    # id planned before it), stays charged
    led = exact(10 ** 6)
    led.rebase()
    early = [led.resident(10, "cpython-heap") for _ in range(20)]
    planned = led.new_id()
    late = []
    commit = led._commit
    seen = [0]

    def between(build):
        out = commit(build)
        if led._state.obs is not None and led._state.obs.remaining is not None:
            seen[0] += 1
            if seen[0] == 2:
                late.append(led.resident(30, "cpython-heap"))
                r = _memledger.Record(planned, "resident", "cpython-heap", 40)
                led._commit(lambda st: (_memledger._overdraw(_memledger._add(st, r)), None))
                late.append(r)
        return out
    led._commit = between
    old = _memledger.CHUNK
    _memledger.CHUNK = 3
    try:
        led.rebase()
    finally:
        _memledger.CHUNK = old
        del led._commit
    assert seen[0] >= 2 and late
    assert not any(r in led.records for r in early)
    assert all(r in led.records for r in late) and led.held() == 70
    # (the next observation covers them)
    led.rebase()
    assert led.held() == 0


def test_r10_an_interrupted_absorption_is_finished_before_a_new_observation():
    # (Y1) no supersede: the next re-base finishes the old observation's
    # remaining snapshot first, then observes afresh
    led = exact(10 ** 6)
    led.rebase()
    for _ in range(50):
        led.resident(10, "cpython-heap")
    old = _memledger.CHUNK
    _memledger.CHUNK = 5
    try:
        commit = led._commit
        n = [0]

        def cut(build):
            out = commit(build)
            o = led._state.obs
            if o is not None and o.remaining is not None:
                n[0] += 1
                if n[0] == 3:
                    raise Injected()
            return out
        led._commit = cut
        try:
            led.rebase()
            raise AssertionError("not interrupted")
        except Injected:
            pass
        del led._commit
        assert led._state.obs is not None and led.f0 is None and 0 < led.held() < 500
        late = led.resident(5, "cpython-heap")
        assert led.rebase() == 10 ** 6 - 0 and late not in led.records
    finally:
        _memledger.CHUNK = old
    audit(led)


def test_r10_released_owners_are_credited_exactly_once_whatever_the_interruption():
    # (U2, W4: H-5/H-6) the release log is read from the image's cursor,
    # committed, then acknowledged; a Ctrl-C anywhere loses nothing and
    # credits nothing twice; appends meanwhile are kept
    class Owner:
        pass

    def setup():
        led = exact(10 ** 6)
        led.rebase()
        led.keep = [Owner() for _ in range(25)]
        led.recs = [led.resident(3, "cpython-heap", owner=o) for o in led.keep]
        led.keep[:20] = []
        gc.collect()
        assert led.pending_releases() == 20
        return led
    old = _memledger.CHUNK
    _memledger.CHUNK = 6
    try:
        def op(led):
            led.sweep()
            assert led.held() == 15
            # (more released after: the cursor moves on, nothing lost)
        n = seams(setup, op, lambda led: led.held() in range(15, 76, 3))
        assert n > 0
        led = setup()
        led.sweep()
        assert led.held() == 15 and led.pending_releases() == 0 and led._state.rel == 20
        del led.keep[:2]
        gc.collect()
        led.sweep()
        assert led.held() == 9 and led.pending_releases() == 0
        # (an empty retry after a commit still acknowledges: H-6)
        led._log.ack(0)
        led.sweep()
        assert led.pending_releases() == 0
    finally:
        _memledger.CHUNK = old


def test_r10_another_writer_between_a_commit_and_its_retry_keeps_the_checkpoint():
    # (T2, astra2's interleaving) commit A, Ctrl-C before the caller records
    # it, another writer commits B, retry A: A's id is still in the image
    led = exact(10 ** 6)
    led.rebase()
    h, e = led.admit(11, 12, 100, 13, "child")
    led.end_call(h, e, 50, [(10, "cpython-heap", None)], txn=14, out_ids=[15])
    held = led.held()
    led.resident(7, "js-heap")
    led.set_standing(60)
    recs = led.end_call(h, e, 50, [(10, "cpython-heap", None)], txn=14, out_ids=[15])
    assert led.held() == held + 7 + 10 and [r.id for r in recs] == [15]
    assert led.applied(11) and led.applied(14)
    led.close([11, 14])
    assert not led.applied(11) and not led.applied(14)
    # (distinct ids per stage: an admission's id never counts as the success)
    led2 = exact(1000)
    led2.rebase()
    h, e = led2.admit(21, 22, 100, 23, "child")
    led2.end_call(h, e, 50, [], txn=24)
    assert led2.standing.bytes == 50


def test_r10_a_commit_frees_only_its_changed_paths():
    # (Y1, astra2: destruction counted across both trees and the temporary
    # paths, rotations included, against AVL's proved height bound
    # h <= 1.4405 log2(n + 2) - 0.3277)
    import math
    freed = [0]

    class Counting(_memledger._Node):
        __slots__ = ()

        def __del__(self):
            freed[0] += 1
    orig = _memledger._Node
    _memledger._Node = Counting
    try:
        for n in (10 ** 3, 10 ** 4):
            led = exact(10 ** 9)
            led.rebase()
            for _ in range(n):
                led.resident(1, "cpython-heap")
            hmax = math.floor(1.4405 * math.log2(n + 2) - 0.3277) + 1
            assert audit(led) <= hmax
            old = _memledger.CHUNK
            _memledger.CHUNK = 16
            commit = led._commit
            worst = [0]

            def counted(build):
                freed[0] = 0
                out = commit(build)
                gc.collect()
                worst[0] = max(worst[0], freed[0])
                return out
            led._commit = counted
            try:
                led.rebase()
            finally:
                del led._commit
                _memledger.CHUNK = old
            # (per commit: two trees (records, remaining), each deletion's
            # path and its rotations' new nodes: at most 3 nodes per level)
            bound = 2 * 16 * 3 * (hmax + 1) + 64
            assert 0 < worst[0] <= bound, (n, worst[0], bound)
    finally:
        _memledger._Node = orig


def test_r10_the_tree_matches_a_dict_under_random_inserts_and_deletes():
    import random
    rnd = random.Random(157)
    t, ref = None, {}
    for i in range(4000):
        k = ("resident", "cpython-heap", rnd.randrange(500))
        if rnd.random() < 0.55:
            r = _memledger.Record(k[2], *k[:2], rnd.randrange(100))
            t = _memledger._ins(t, k, r)
            ref[k] = r
        else:
            t = _memledger._del(t, k)
            ref.pop(k, None)
        if i % 97 == 0:
            got = _memledger._first(t, 10 ** 6)
            assert [k for k, _ in got] == sorted(ref) and all(ref[k] is r for k, r in got)
            assert _memledger._s(t) == sum(r.bytes for r in ref.values())
            lo, hi = ("resident", "cpython-heap", 100), ("resident", "cpython-heap", 300)
            assert _memledger._range_sum(t, lo, hi) == sum(r.bytes for k, r in ref.items() if lo <= k < hi)


if __name__ == "__main__":
    for n in [n for n in list(globals()) if n.startswith("test_")]:
        globals()[n]()
        print("ok", n)
