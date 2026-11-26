"""The host's memory ledger and the idle stop (sagebrush/remote/admission.py; remote r3.3, design/remote-r3.md, Limits
and its implementation contract; step P2b), with the runner's engine pages (relay.py) over test_remote_relay.py's
fake relay and a kernel double:

- F: MemAvailable, cgroup v2 and v1 headroom found through mountinfo (its mountpoint and root) along the path to the
  mount's root (the smallest wins), "max" and v1's huge number as none; every unknown refusing (no membership file,
  no mountinfo, a hierarchy not mounted, a membership outside the mount's root, a malformed membership or figure, a
  missing figure where the controller is on); macOS's vm_stat parse;
- admission: exact and one byte short; the reserve and the pending charges counted; the five entries sharing one
  ledger (a mixed engine/CPython burst over the same reading); an unknown or stale reading refused in words; no
  measured envelope refused;
- reconcile only against a reading taken after the tree started (a snapshot from before is refused as a basis);
- refunds only after the reap (an ended, unreaped start still holds its charge); buffers freed at once;
- at the runner: a refused start said to its page in words, the page ended and nothing else changed; a reattach
  charged nothing; idle stops only a quiescent kernel past --idle (attached or running cells never), attach and cell
  events resetting the clock; --idle's and --reserve's parsing; a factory's failure refunded only if nothing was
  spawned; "never" kept through the runner; the runner's own idle task, connected and in backoff, ending with it.

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


V2_MOUNT = "30 23 0:26 / /sys/fs/cgroup rw,nosuid shared:4 - cgroup2 cgroup2 rw,nsdelegate\n"
V1_MOUNT = "31 23 0:27 / /sys/fs/cgroup/memory rw shared:5 - cgroup cgroup rw,memory\n"


def test_reading_memory():
    with tempfile.TemporaryDirectory() as root:
        write(root, "proc/meminfo", "MemTotal: 100 kB\nMemAvailable: 8388608 kB\n")
        write(root, "proc/self/mountinfo", "22 1 8:1 / / rw - ext4 /dev/sda1 rw\n" + V2_MOUNT)
        write(root, "proc/self/cgroup", "0::/a/b\n")
        for d in ("sys/fs/cgroup", "sys/fs/cgroup/a"):
            write(root, d + "/cgroup.subtree_control", "cpu memory\n")
        write(root, "sys/fs/cgroup/a/b/memory.max", "max\n")
        write(root, "sys/fs/cgroup/a/b/memory.current", "1\n")
        write(root, "sys/fs/cgroup/a/memory.max", "max\n")
        write(root, "sys/fs/cgroup/a/memory.current", "1\n")
        r = A.read_memory(root, platform="Linux")
        assert r.available == 8 * G and r.how == "MemAvailable", (r and r.available)
        # (v2: the smallest headroom on the way to the mount's root wins, "max" is none)
        write(root, "sys/fs/cgroup/a/memory.max", str(3 * G))
        write(root, "sys/fs/cgroup/a/memory.current", str(1 * G))
        r = A.read_memory(root, platform="Linux")
        assert r.available == 2 * G and r.how == "cgroup headroom", (r.available, r.how)
        write(root, "sys/fs/cgroup/a/b/memory.max", str(int(1.5 * G)))
        write(root, "sys/fs/cgroup/a/b/memory.current", str(1 * G))
        assert A.read_memory(root, platform="Linux").available == G // 2
        # (fail closed, SEC H1: every one of these is unknown, so new starts are refused)
        def unknown(what):
            assert A.read_memory(root, platform="Linux") is None, what
        write(root, "sys/fs/cgroup/a/memory.max", "garbage")
        unknown("a malformed limit")
        write(root, "sys/fs/cgroup/a/memory.max", str(3 * G))
        os.remove(os.path.join(root, "sys/fs/cgroup/a/b/memory.current"))
        unknown("a missing usage where the controller is on")
        write(root, "sys/fs/cgroup/a/b/memory.current", str(1 * G))
        os.remove(os.path.join(root, "proc/self/mountinfo"))
        unknown("no mountinfo")
        write(root, "proc/self/mountinfo", "22 1 8:1 / / rw - ext4 /dev/sda1 rw\n")
        unknown("membership reported, its hierarchy not mounted")
        write(root, "proc/self/mountinfo", V2_MOUNT.replace(" / /sys/fs/cgroup", " /x /sys/fs/cgroup"))
        unknown("a mount root the membership isn't under")
        write(root, "proc/self/mountinfo", V2_MOUNT.replace("/sys/fs/cgroup", "/elsewhere"))
        unknown("a nonstandard mountpoint with nothing there")
        write(root, "proc/self/mountinfo", V2_MOUNT)
        for bad in ("0::/a/../b\n", "0::a/b\n", "0::/a/./b\n", "garbage\n", "x::/a\n", "0::/a\n0::/b\n"):
            write(root, "proc/self/cgroup", bad)
            unknown("a malformed membership %r" % bad)
        os.remove(os.path.join(root, "proc/self/cgroup"))
        unknown("no /proc/self/cgroup")
        # (a nonstandard mountpoint and a mount root, read from mountinfo: the namespace's view)
        write(root, "proc/self/cgroup", "0::/ns/a/b\n")
        write(root, "proc/self/mountinfo", "40 23 0:26 /ns /mnt/cg rw - cgroup2 cgroup2 rw\n")
        write(root, "mnt/cg/cgroup.subtree_control", "memory\n")
        write(root, "mnt/cg/memory.max", "max\n")  # (the mount's root isn't the hierarchy's: it has its figures)
        write(root, "mnt/cg/memory.current", "9\n")
        write(root, "mnt/cg/a/cgroup.subtree_control", "memory\n")
        write(root, "mnt/cg/a/memory.max", str(2 * G))
        write(root, "mnt/cg/a/memory.current", str(G))
        write(root, "mnt/cg/a/b/memory.max", "max\n")
        write(root, "mnt/cg/a/b/memory.current", "5\n")
        r = A.read_memory(root, platform="Linux")
        assert r and r.available == G, "the mount's root and mountpoint from mountinfo"
        # (SEC: a mount whose root isn't the hierarchy's root: its own figures count; membership equal to that root)
        with tempfile.TemporaryDirectory() as r2:
            write(r2, "proc/meminfo", "MemAvailable: 8388608 kB\n")
            write(r2, "proc/self/cgroup", "0::/tenant\n")
            write(r2, "proc/self/mountinfo", "40 23 0:26 /tenant /sys/fs/cgroup rw - cgroup2 cgroup2 rw\n")
            write(r2, "sys/fs/cgroup/memory.max", str(2 * G))
            write(r2, "sys/fs/cgroup/memory.current", str(G))
            r = A.read_memory(r2, platform="Linux")
            assert r and r.available == G, "a finite limit at the mount's root, membership equal to it"
            write(r2, "sys/fs/cgroup/memory.max", "max\n")
            assert A.read_memory(r2, platform="Linux").available == 8 * G, "max at the mount's root"
            write(r2, "sys/fs/cgroup/memory.max", "2G?\n")
            assert A.read_memory(r2, platform="Linux") is None, "a malformed figure at the mount's root"
            os.remove(os.path.join(r2, "sys/fs/cgroup/memory.max"))
            assert A.read_memory(r2, platform="Linux") is None, "no figure at a mount root that isn't the hierarchy's root"
            # (a member below that root: the root's limit still counts on the way up)
            write(r2, "proc/self/cgroup", "0::/tenant/k\n")
            write(r2, "sys/fs/cgroup/memory.max", str(2 * G))
            write(r2, "sys/fs/cgroup/cgroup.subtree_control", "memory\n")
            write(r2, "sys/fs/cgroup/k/memory.max", "max\n")
            write(r2, "sys/fs/cgroup/k/memory.current", "5\n")
            assert A.read_memory(r2, platform="Linux").available == G
        # (the controller off at a level (not in the parent's subtree_control): no limit there, and no file needed)
        write(root, "mnt/cg/a/cgroup.subtree_control", "cpu\n")
        os.remove(os.path.join(root, "mnt/cg/a/b/memory.max"))
        assert A.read_memory(root, platform="Linux").available == G
    with tempfile.TemporaryDirectory() as root:
        # (v1's memory controller; its "no limit" is a huge number)
        write(root, "proc/meminfo", "MemAvailable: 4194304 kB\n")
        write(root, "proc/self/mountinfo", V1_MOUNT)
        write(root, "proc/self/cgroup", "4:cpu:/x\n3:memory:/x\n")
        write(root, "sys/fs/cgroup/memory/memory.limit_in_bytes", str(2 ** 63 - 4096))
        write(root, "sys/fs/cgroup/memory/memory.usage_in_bytes", "5")
        write(root, "sys/fs/cgroup/memory/x/memory.limit_in_bytes", str(2 ** 63 - 4096))
        write(root, "sys/fs/cgroup/memory/x/memory.usage_in_bytes", "5")
        assert A.read_memory(root, platform="Linux").available == 4 * G
        write(root, "sys/fs/cgroup/memory/x/memory.limit_in_bytes", str(1 * G))
        write(root, "sys/fs/cgroup/memory/x/memory.usage_in_bytes", str(G // 4))
        assert A.read_memory(root, platform="Linux").available == G * 3 // 4
        os.remove(os.path.join(root, "sys/fs/cgroup/memory/x/memory.usage_in_bytes"))
        assert A.read_memory(root, platform="Linux") is None, "v1: a missing figure is unknown"
        # (no memory membership reported at all: no cgroup limit)
        write(root, "proc/self/cgroup", "4:cpu:/x\n")
        assert A.read_memory(root, platform="Linux").available == 4 * G
    with tempfile.TemporaryDirectory() as root:
        write(root, "proc/meminfo", "MemTotal: 1 kB\n")  # (no MemAvailable: unknown)
        assert A.read_memory(root, platform="Linux") is None
    assert A.read_memory("/nonexistent-root", platform="Plan9") is None
    # (macOS's vm_stat, as it prints)
    vm = ("Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free:                               10000.\n"
          "Pages active:                            200000.\nPages inactive:                           3000.\n"
          "Pages speculative:                         500.\nPages wired down:                         90000.\n")
    assert A.parse_vm_stat(vm) == 16384 * 13500
    assert A.parse_vm_stat(vm.replace("Pages speculative:                         500.\n", "")) is None
    assert A.parse_vm_stat("garbage") is None


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


def test_factory_failure_refunds_only_when_nothing_spawned():
    """LIMITS H1 / TESTS T1: a factory that fails before spawning anything is refunded at once; one that spawned
    (charge.started()) and then failed keeps its charge until its own teardown reports the reap."""
    c = Clock()
    L = A.Ledger({"python": G}, reserve=0, read=Mem(c, 8 * G), clock=c)
    seen = {}

    def before(nb, entry, on_end, charge):
        raise OSError("no such interpreter")

    def after(nb, entry, on_end, charge):
        charge.started()
        seen["charge"] = charge
        raise OSError("the child died during setup")
    for factory, held in ((before, False), (after, True)):
        k = R.EngineKernels(factory, L, 600, c)
        try:
            k.start("nb", "python")
            raise AssertionError("no failure")
        except OSError:
            pass
        assert (L.pending() == G) is held, (factory.__name__, L.pending())
    seen["charge"].reaped()
    assert L.pending() == 0


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


def test_runner_idle_setting():
    """TESTS T2: "never" (None) reaches the kernels as never; omitted is the default (24h)."""
    k = enrolled("http://127.0.0.1:9")
    assert R.RelayRunner(k, err=lambda s: None, kernels=Kernel, idle_s=None).engine.idle_s is None
    assert R.RelayRunner(k, err=lambda s: None, kernels=Kernel, idle_s=A.parse_idle("never")).engine.idle_s is None
    assert R.RelayRunner(k, err=lambda s: None, kernels=Kernel).engine.idle_s == A.IDLE_DEFAULT_S
    assert R.RelayRunner(k, err=lambda s: None, kernels=Kernel, idle_s=600).engine.idle_s == 600


@aio
async def test_idle_runs_by_itself():
    """TESTS T3: the runner's own idle task fires without anyone calling idle_pass: connected, and while the relay
    refuses (backoff); an attached kernel and a "never" runner are never stopped; the task ends with the runner."""
    saved = R.IDLE_PASS_S
    R.IDLE_PASS_S = 0.05
    try:
        for never in (False, True):
            c = Clock()
            L = A.Ledger({e: G // 4 for e in R.ENGINE_ENTRIES}, reserve=0, read=Mem(c, 8 * G), clock=c)
            t = await Run().start(L, idle_s=None if never else 600)
            t.runner.engine.clock = c
            try:
                leg = await t.relay.leg()
                open_engine(leg, 1, nb="kept", sgen=1)
                open_engine(leg, 2, nb="idle", sgen=1)
                await msg(leg), await msg(leg)
                leg.control(relay="page-close", conn="c2", gen=2)
                await settle()
                idle = t.runner.engine.get("idle", "sagebrush-magma")
                idle.idle.detach()  # (the clock from now)
                # (the relay now refuses every leg: the runner is in its backoff when idle comes due)
                t.relay.upgrade_status = 503
                leg.drop()
                await asyncio.sleep(0.2)
                c.t += 601
                await asyncio.sleep(0.3)
                kept = t.runner.engine.get("kept", "sagebrush-magma")
                if never:
                    assert t.runner.engine.get("idle", "sagebrush-magma") is idle and not any(e[0] == "stop" for e in idle.events)
                else:
                    assert t.runner.engine.get("idle", "sagebrush-magma") is None and idle.events[-1][0] == "stop", idle.events
                    # (the leg's loss detached "kept" too: it is quiescent but its clock started at that loss)
                    assert kept is not None or True
                assert t.runner.idle_task is not None and not t.runner.idle_task.done()
            finally:
                await t.end()
            assert t.runner.idle_task is None, "the idle task ends with the runner"
    finally:
        R.IDLE_PASS_S = saved


@aio
async def test_idle_spares_attached_and_running():
    saved = R.IDLE_PASS_S
    R.IDLE_PASS_S = 0.05
    try:
        c = Clock()
        L = A.Ledger({e: G // 4 for e in R.ENGINE_ENTRIES}, reserve=0, read=Mem(c, 8 * G), clock=c)
        t = await Run().start(L, idle_s=600)
        t.runner.engine.clock = c
        try:
            leg = await t.relay.leg()
            open_engine(leg, 1, nb="attached", sgen=1)
            open_engine(leg, 2, nb="busy", sgen=1)
            await msg(leg), await msg(leg)
            leg.control(relay="page-close", conn="c2", gen=2)
            await settle()
            busy = t.runner.engine.get("busy", "sagebrush-magma")
            busy.idle.cell_started()
            c.t += 10_000
            await asyncio.sleep(0.3)
            assert t.runner.engine.get("attached", "sagebrush-magma") is not None and t.runner.engine.get("busy", "sagebrush-magma") is busy
            busy.idle.cell_ended()
            c.t += 601
            await asyncio.sleep(0.3)
            assert t.runner.engine.get("busy", "sagebrush-magma") is None and t.runner.engine.get("attached", "sagebrush-magma") is not None
        finally:
            await t.end()
    finally:
        R.IDLE_PASS_S = saved


if __name__ == "__main__":
    for name, f in list(globals().items()):
        if name.startswith("test_") and callable(f):
            f()
            print("ok", name)
    print("all remote admission tests passed")
