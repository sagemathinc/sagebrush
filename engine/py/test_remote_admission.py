"""The host's memory ledger and the idle stop (sagebrush/remote/admission.py; remote r3.3, design/remote-r3.md, Limits
and its implementation contract; step P2b), with the runner's engine pages (relay.py) over test_remote_relay.py's
fake relay and a kernel double:

- F: MemAvailable, cgroup v2 and v1 headroom along the path to the root (the smallest wins), "max" and v1's huge
  number as none, an unreadable figure refusing; macOS's vm_stat parse;
- admission: exact and one byte short; the reserve and the pending charges counted; the five entries sharing one
  ledger (a mixed engine/CPython burst over the same reading); an unknown or stale reading refused in words; no
  measured envelope refused;
- reconcile only against a reading taken after the tree started (a snapshot from before is refused as a basis);
- refunds only after the reap (an ended, unreaped start still holds its charge); buffers freed at once;
- at the runner: a refused start said to its page in words, the page ended and nothing else changed; a reattach
  charged nothing; idle stops only a quiescent kernel past --idle (attached or running cells never), attach and cell
  events resetting the clock; --idle's and --reserve's parsing.

    python engine/py/test_remote_admission.py
"""
import asyncio
import os
import sys
import tempfile

from sagebrush.remote import admission as A
from sagebrush.remote import relay as R

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from test_remote_pair import aio  # noqa: E402
from test_remote_engine_page import Kernel, msg, open_engine, settle  # noqa: E402
from test_remote_relay import FakeRelay, enrolled  # noqa: E402
from sagebrush.remote.gateway import drain_groups  # noqa: E402

G, M = A.GiB, A.MiB


class Clock:
    def __init__(self):
        self.t = 1000.0

    def __call__(self):
        return self.t


class Mem:
    """A memory reader double: free bytes now (None: unreadable), its reading's time (default: now)."""

    def __init__(self, clock, free):
        self.clock, self.free, self.at = clock, free, None
        self.reads = 0

    def __call__(self):
        self.reads += 1
        if self.free is None:
            return None
        return A.Reading(self.free, self.clock() if self.at is None else self.at, "test")


def write(root, rel, text):
    p = os.path.join(root, rel)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "w") as f:
        f.write(text)


def test_reading_memory():
    with tempfile.TemporaryDirectory() as root:
        write(root, "proc/meminfo", "MemTotal: 100 kB\nMemAvailable: 8388608 kB\n")
        write(root, "proc/self/cgroup", "0::/a/b\n")
        assert A.read_memory(root, platform="Linux").available == 8 * G and A.read_memory(root, platform="Linux").how == "MemAvailable"
        # (v2: the smallest headroom on the way to the root wins, "max" is none)
        write(root, "sys/fs/cgroup/a/b/memory.max", "max\n")
        write(root, "sys/fs/cgroup/a/b/memory.current", "1\n")
        write(root, "sys/fs/cgroup/a/memory.max", str(3 * G))
        write(root, "sys/fs/cgroup/a/memory.current", str(1 * G))
        r = A.read_memory(root, platform="Linux")
        assert r.available == 2 * G and r.how == "cgroup headroom", (r.available, r.how)
        write(root, "sys/fs/cgroup/a/b/memory.max", str(int(1.5 * G)))
        write(root, "sys/fs/cgroup/a/b/memory.current", str(1 * G))
        assert A.read_memory(root, platform="Linux").available == G // 2
        # (an unreadable limit: no reading at all, so new starts are refused)
        write(root, "sys/fs/cgroup/a/memory.max", "garbage")
        assert A.read_memory(root, platform="Linux") is None
    with tempfile.TemporaryDirectory() as root:
        # (v1's memory controller; its "no limit" is a huge number)
        write(root, "proc/meminfo", "MemAvailable: 4194304 kB\n")
        write(root, "proc/self/cgroup", "4:cpu:/x\n3:memory:/x\n")
        write(root, "sys/fs/cgroup/memory/x/memory.limit_in_bytes", str(2 ** 63 - 4096))
        write(root, "sys/fs/cgroup/memory/x/memory.usage_in_bytes", "5")
        assert A.read_memory(root, platform="Linux").available == 4 * G
        write(root, "sys/fs/cgroup/memory/x/memory.limit_in_bytes", str(1 * G))
        write(root, "sys/fs/cgroup/memory/x/memory.usage_in_bytes", str(G // 4))
        assert A.read_memory(root, platform="Linux").available == G * 3 // 4
    with tempfile.TemporaryDirectory() as root:
        write(root, "proc/meminfo", "MemTotal: 1 kB\n")  # (no MemAvailable: unknown)
        assert A.read_memory(root, platform="Linux") is None
    assert A.read_memory("/nonexistent-root", platform="Plan9") is None


def test_admission():
    c = Clock()
    mem = Mem(c, 3 * G)
    L = A.Ledger({"python": G // 2, "sagebrush-magma": G // 2}, reserve=2 * G, read=mem, clock=c)
    # (LIMITS' example: F 3 GiB, R 2 GiB, K 0.5 GiB: two starts, the third refused)
    a, b = L.admit("python"), L.admit("sagebrush-magma")
    try:
        L.admit("python")
        raise AssertionError("a third start admitted")
    except A.Refused as e:
        assert "needs 512 MiB" in str(e) and "3.0 GiB is free" in str(e) and "2.0 GiB is kept" in str(e) and "1.0 GiB is held" in str(e), str(e)
    assert L.pending() == G
    # (exact, and one byte short)
    c2 = Clock()
    m2 = Mem(c2, 2 * G + 100)
    L2 = A.Ledger({"python": 100}, reserve=2 * G, read=m2, clock=c2)
    L2.admit("python")
    try:
        L2.admit("python")
        raise AssertionError("admitted one byte short")
    except A.Refused:
        pass
    m3 = Mem(c2, 2 * G + 99)
    try:
        A.Ledger({"python": 100}, reserve=2 * G, read=m3, clock=c2).admit("python")
        raise AssertionError("admitted one byte short")
    except A.Refused:
        pass
    # (unknown, stale, no envelope)
    for free, at, what in ((None, None, "can't be read"), (8 * G, c() - 2, "stale")):
        m = Mem(c, free)
        m.at = at
        try:
            A.Ledger({"python": 1}, reserve=0, read=m, clock=c).admit("python")
            raise AssertionError(what)
        except A.Refused as e:
            assert what in str(e), str(e)
    try:
        L.admit("sagebrush-gap")
        raise AssertionError("no envelope admitted")
    except A.Refused as e:
        assert "no measured startup envelope" in str(e)
    # (buffers share the ledger; freed at once)
    buf = L.admit("output buffer", need=0)
    buf.free()
    assert L.pending() == G and a.pending and b.pending


@aio
async def test_mixed_burst_one_ledger():
    """Five entries' starts at once (one burst on the event loop, the same reading): the sum of what is admitted never
    passes F - R, whichever order they come in."""
    c = Clock()
    mem = Mem(c, 4 * G)
    K = {"sagebrush-python": G // 4, "sagebrush-sage": 3 * G // 4, "sagebrush-magma": G // 2, "sagebrush-matlab": G // 4, "python": 3 * G // 4}
    L = A.Ledger(K, reserve=2 * G, read=mem, clock=c)
    got = []

    async def one(e):
        await asyncio.sleep(0)
        try:
            got.append(L.admit(e))
        except A.Refused:
            pass
    await asyncio.gather(*(one(e) for e in list(K) * 2))
    assert sum(x.need for x in got) <= 2 * G and L.pending() == sum(x.need for x in got), [(x.what, x.need) for x in got]
    assert 2 * G - L.pending() < min(K.values()), "nothing that would fit was refused"


def test_reconcile_and_refund():
    c = Clock()
    mem = Mem(c, 8 * G)
    L = A.Ledger({"python": G}, reserve=G, read=mem, clock=c)
    ch = L.admit("python")
    assert not L.reconcile(ch), "not started: no reconciling"
    ch.started()
    # (a reading from before the tree started (a pre-ready snapshot): refused as a basis, the charge stays)
    mem.at = c() - 0.5
    assert not L.reconcile(ch) and ch.pending == G
    c.t += 0.25
    mem.at = None  # (a fresh reading now: after the start)
    assert L.reconcile(ch) and ch.pending == 0 and L.pending() == 0
    # (an ended start: nothing refunded until its tree is reaped)
    ch2 = L.admit("python")
    ch2.started()
    ch2.ended_unreaped()
    c.t += 0.5
    assert not L.reconcile(ch2) and L.pending() == G, "an ended start isn't reconciled away"
    ch2.reaped()
    assert L.pending() == 0 and ch2 not in L.charges
    # (a start that failed before its tree existed: refunded when reaped, and only then)
    ch3 = L.admit("python")
    ch3.ended_unreaped()
    assert L.pending() == G
    ch3.reaped()
    assert L.pending() == 0


def test_idle_clock_and_parsing():
    c = Clock()
    i = A.IdleClock(600, c)
    c.t += 599
    assert not i.due()
    c.t += 1
    assert i.due(), "quiescent for its limit"
    i.attach()
    c.t += 10_000
    assert not i.due(), "attached: never"
    i.detach()
    i.cell_started()
    c.t += 10_000
    assert not i.due(), "a cell running: never"
    i.cell_ended()
    c.t += 599
    assert not i.due(), "the cell's end reset the clock"
    c.t += 1
    assert i.due()
    i.touch()
    assert not i.due()
    assert not A.IdleClock(None, c).due(), "never"
    assert A.parse_idle("10m") == 600 and A.parse_idle("24h") == 86400 and A.parse_idle("30d") == 30 * 86400 and A.parse_idle("never") is None
    for bad in ("9m", "31d", "0h", "1.5h", "10", "1w", "-1h", "", "Never", "10 m", None):
        try:
            A.parse_idle(bad)
            raise AssertionError("accepted %r" % (bad,))
        except ValueError:
            pass
    assert A.parse_size("512M") == 512 * M and A.parse_size("2G") == 2 * G
    for bad in ("0G", "1T", "1.5G", "", "G"):
        try:
            A.parse_size(bad)
            raise AssertionError(bad)
        except ValueError:
            pass


class Run:
    async def start(self, ledger, idle_s=None):
        Kernel.made = []
        self.relay = await FakeRelay(None).start()
        self.key = enrolled(self.relay.origin)
        self.relay.key = self.key
        self.runner = R.RelayRunner(self.key, err=lambda s: None, rnd=lambda: 0.5, kernels=Kernel, ledger=ledger, idle_s=idle_s)
        self.stop = asyncio.Event()
        self.task = asyncio.ensure_future(self.runner.run(self.stop))
        return self

    async def end(self):
        self.stop.set()
        try:
            await asyncio.wait_for(self.task, 10)
        except Exception:
            pass
        self.runner.gateway.shutdown()
        self.runner.engine.stop_all("the runner stopped")
        await drain_groups(3.0)
        self.relay.stop()


@aio
async def test_runner_admission_and_idle():
    c = Clock()
    mem = Mem(c, 3 * G)
    L = A.Ledger({e: G // 2 for e in R.ENGINE_ENTRIES}, reserve=2 * G, read=mem, clock=c)
    t = await Run().start(L, idle_s=600)
    t.runner.engine.clock = c
    try:
        leg = await t.relay.leg()
        open_engine(leg, 1, nb="n1", sgen=1)
        open_engine(leg, 2, nb="n2", sgen=1)
        await msg(leg), await msg(leg)
        assert len(Kernel.made) == 2 and all(k.charge is not None for k in Kernel.made) and L.pending() == G
        # (a third notebook: refused in words, that page only)
        open_engine(leg, 3, nb="n3", sgen=1)
        kind, gen, m = await msg(leg)
        assert gen == 3 and m.get("engine") == "refused" and "Not enough free memory" in m["why"], m
        await settle()
        assert {"relay": "close", "gen": 3} in leg.controls and len(Kernel.made) == 2 and not t.runner.leg.closed
        # (a reattach is never charged again)
        reads = mem.reads
        leg.control(relay="page-close", conn="c1", gen=1)
        await settle()
        open_engine(leg, 4, nb="n1", sgen=2)
        assert (await msg(leg))[2]["fresh"] is False and mem.reads == reads and L.pending() == G
        # (idle: n1 attached, n2 attached: none due however long)
        c.t += 10_000
        assert t.runner.idle_pass() == []
        # (n2 detached and quiescent: due at its limit; a running cell keeps it)
        leg.control(relay="page-close", conn="c2", gen=2)
        await settle()
        k2 = t.runner.engine.get("n2", "sagebrush-magma")
        k2.idle.cell_started()
        c.t += 10_000
        assert t.runner.idle_pass() == []
        k2.idle.cell_ended()
        c.t += 599
        assert t.runner.idle_pass() == []
        c.t += 1
        due = t.runner.idle_pass()
        assert [key for key, _ in due] == [("n2", "sagebrush-magma")] and k2.events[-1][0] == "stop" and "idle for 10m" in k2.events[-1][1]
        assert t.runner.engine.get("n2", "sagebrush-magma") is None
        # (its charge is refunded only by its reap, the kernel's own: still held here)
        assert L.pending() == G
        k2.charge.reaped()
        assert L.pending() == G // 2
    finally:
        await t.end()


if __name__ == "__main__":
    for name, f in list(globals().items()):
        if name.startswith("test_") and callable(f):
            f()
            print("ok", name)
    print("all remote admission tests passed")
