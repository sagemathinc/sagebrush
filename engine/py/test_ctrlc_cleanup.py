"""Ctrl-C cleanup fixes, PR A (plan-ctrlc-fixes r2, census items 1, 2, 3b, 4):
what a Ctrl-C used to leave behind, now reset, written atomically, or
recognized by its id.  Nothing here relies on a finally or with-block running
on an interrupted main thread (CPython 3.9/3.14 can skip a with-block's exit;
3.13/3.14 a try around a loop, cpython#130279).

    python3 engine/py/test_ctrlc_cleanup.py
"""

import glob
import json
import os
import sys
import tempfile
import textwrap
import threading
import time

import sagebrush.session as S

SAGELIB = os.path.join(os.path.dirname(S.__file__), "_sagelib")
sys.path.insert(0, SAGELIB)  # (the Sage layer's modules by their top-level names, as the session's finder resolves them)
import _display_budget as DB  # noqa: E402
import sage_plot3d as P3  # noqa: E402


# ------------------------------------------------------------------ 1. the display budget, reset per request

def test_display_reset():
    """A display scope whose __exit__ a Ctrl-C skipped left _depth raised: no
    later display started a new count, so the session's displays shared one
    budget until every one raised MemoryError.  The worker now resets it
    before each request's code (session._reset_run_state)."""
    DB.reset()
    full = DB.LIMITS["steps"]
    DB.display().__enter__()  # (a scope entered, its exit skipped)
    with DB.display():
        DB._charge(full, 0)   # (this display uses the whole budget)
    # (without a reset the next display goes on counting from there)
    try:
        with DB.display():
            DB._charge(1, 0)
        raise AssertionError("expected the stale scope to keep counting")
    except MemoryError:
        pass
    sys.modules["_display_budget"] = DB
    S._reset_run_state()  # (a new request)
    with DB.display():
        DB._charge(full, 0)   # (a whole budget again)
    assert DB._depth[0] == 0
    print("display reset: ok")


# ------------------------------------------------------------------ 2. plot3d pages: atomic, O(1) in stale temps, GC

def _in(d):
    old = os.getcwd()
    os.chdir(d)
    return old


def _temps(d):
    return sorted(glob.glob(os.path.join(d, ".plot3d-tmp", "*", "*")))


def test_page_atomic_and_v2():
    d = tempfile.mkdtemp(prefix="sb-p3-")
    old = _in(d)
    try:
        big = "x" * (P3.JUPYTER_INLINE + 10)
        b = P3.jupyter_bundle(big, "<svg/>", "scene", lambda: "<html>whole</html>")
        names = os.listdir(".sagebrush")
        page = [n for n in names if n.endswith(".html")]
        assert len(page) == 1 and page[0].startswith("plot3d-v2-"), names
        assert open(os.path.join(".sagebrush", page[0])).read() == "<html>whole</html>"
        assert _temps(".sagebrush") == [], _temps(".sagebrush")  # (renamed: no temporary left)
        assert "plot3d-v2-" in b["text/plain"]
        # (an interruption between the write and the rename: its writer's own
        # temporary is left, the name never holds part of a page; the next page
        # of the same writer overwrites that temporary, so there is never a second)
        path = os.path.join(".sagebrush", "plot3d-v2-int.html")
        real = os.fsync

        def interrupted(fd):
            raise KeyboardInterrupt

        os.fsync = interrupted
        try:
            P3._write_page(path, "partial?")
        except KeyboardInterrupt:
            pass
        finally:
            os.fsync = real
        assert not os.path.exists(path)
        assert len(_temps(".sagebrush")) == 1
        P3._write_page(path, "whole")
        assert open(path).read() == "whole" and _temps(".sagebrush") == []
        # (a failure: the temporary removed, by name, and the error raised)
        def failing(fd):
            raise OSError(28, "No space left on device")

        os.fsync = failing
        try:
            P3._write_page(os.path.join(".sagebrush", "plot3d-v2-full.html"), "x")
            raise AssertionError("expected OSError")
        except OSError:
            pass
        finally:
            os.fsync = real
        assert not os.path.exists(os.path.join(".sagebrush", "plot3d-v2-full.html")) and _temps(".sagebrush") == []
    finally:
        os.chdir(old)
    print("page atomic, v2: ok")


def test_page_two_threads():
    """Two threads writing pages at once (each with its temporary open at the
    same moment): each writer's temporary is its own, so each page is whole."""
    d = tempfile.mkdtemp(prefix="sb-p3t-")
    old = _in(d)
    real = os.fsync
    both = threading.Barrier(2, timeout=10)

    def fsync(fd):
        both.wait()  # (both temporaries written and open)
        return real(fd)

    os.fsync = fsync
    try:
        os.makedirs(".sagebrush")
        ts = [threading.Thread(target=P3._write_page, args=(os.path.join(".sagebrush", "plot3d-v2-%s.html" % n), n * 1000)) for n in "ab"]
        for t in ts:
            t.start()
        for t in ts:
            t.join(20)
    finally:
        os.fsync = real
        os.chdir(old)
    for n in "ab":
        assert open(os.path.join(d, ".sagebrush", "plot3d-v2-%s.html" % n)).read() == n * 1000, n
    print("page, two threads at once: ok")


def test_page_nested_callback():
    """astra's CORR-CTRLC-2: a page() that shows another 3D scene (the same
    thread, so the same temporary name).  page() is computed before the
    temporary is opened, so the inner page is written and renamed whole
    before the outer one opens its temporary: each name holds its own page."""
    d = tempfile.mkdtemp(prefix="sb-p3n-")
    old = _in(d)
    try:
        outer_scene, inner_scene = "o" * (P3.JUPYTER_INLINE + 1), "i" * (P3.JUPYTER_INLINE + 2)

        def inner_page():
            return "<html>INNER</html>"

        def outer_page():
            P3.jupyter_bundle(inner_scene, "<svg/>", "inner", inner_page)
            return "<html>OUTER</html>"

        P3.jupyter_bundle(outer_scene, "<svg/>", "outer", outer_page)
        pages = {n: open(os.path.join(".sagebrush", n)).read() for n in os.listdir(".sagebrush") if n.endswith(".html")}
        import zlib
        name = lambda s: "plot3d-v2-%08x-%x.html" % (zlib.crc32(s.encode()), len(s))  # noqa: E731
        assert pages == {name(outer_scene): "<html>OUTER</html>", name(inner_scene): "<html>INNER</html>"}, pages
        assert _temps(".sagebrush") == []
    finally:
        os.chdir(old)
    print("page nested callback: ok")


def test_page_no_listing_with_stale_temps():
    """daybreak2's COST-1: the success path, and its error and rename-failure
    paths, never list a directory, however many stale temporaries there are."""
    d = tempfile.mkdtemp(prefix="sb-p3s-")
    host = os.path.join(d, ".sagebrush", ".plot3d-tmp", P3._host())
    os.makedirs(host)
    for i in range(10000):
        open(os.path.join(host, "%d-%d" % (900000 + i, 1)), "w").close()
    old = _in(d)
    saved = {k: getattr(os, k) for k in ("listdir", "scandir", "walk")}, glob.glob, glob.iglob

    def no(*a, **k):
        raise AssertionError("a directory listing on a page write's path")

    try:
        for k in saved[0]:
            setattr(os, k, no)
        glob.glob = glob.iglob = no
        P3._write_page(os.path.join(".sagebrush", "plot3d-v2-a.html"), "a")  # (success)
        real_replace = os.replace

        def bad_replace(a, b):
            raise OSError(1, "rename refused")

        os.replace = bad_replace
        try:
            P3._write_page(os.path.join(".sagebrush", "plot3d-v2-b.html"), "b")  # (the rename fails: cleanup by name)
        except OSError:
            pass
        finally:
            os.replace = real_replace
    finally:
        for k, v in saved[0].items():
            setattr(os, k, v)
        glob.glob, glob.iglob = saved[1], saved[2]
        os.chdir(old)
    assert open(os.path.join(d, ".sagebrush", "plot3d-v2-a.html")).read() == "a"
    assert len(os.listdir(host)) == 10000  # (none of the stale ones touched, and its own temporary gone)
    print("page write, 10000 stale temporaries, no listing: ok")


def test_gc():
    d = tempfile.mkdtemp(prefix="sb-p3g-")
    root = os.path.join(d, ".sagebrush")
    host = os.path.join(root, ".plot3d-tmp", P3._host())
    other = os.path.join(root, ".plot3d-tmp", "another-host")
    os.makedirs(host)
    os.makedirs(other)
    live, dead = set(), set()
    for i in range(300):
        pid = 700000 + i
        (live if i % 3 == 0 else dead).add(pid)
        open(os.path.join(host, "%d-1" % pid), "w").close()
    open(os.path.join(host, "%d-1" % os.getpid()), "w").close()  # (this process's own: kept)
    open(os.path.join(other, "1-1"), "w").close()                  # (another host's: never read)
    # (a pass's clock advances one tick per check: a budget of 50 ticks
    # examines about 50 entries, then stops and leaves a cursor)
    ticks = [0]

    def clock():
        ticks[0] += 1
        return ticks[0]

    alive = lambda pid: pid in live  # noqa: E731  (this process reported dead too: only _gc_temps' own rule keeps its temporary)
    recs = []
    for _ in range(1000):
        # (a budget of 150 ticks, more than the 101 entries kept: the seek, charged, fits)
        recs.append(P3._gc_temps(root, budget_s=150, clock=clock, alive=alive))
        assert recs[-1]["removed"] + recs[-1]["kept"] >= 1 or not recs[-1]["stopped"], recs[-1]  # (a pass that stops examined an entry)
        if not recs[-1]["stopped"] and not recs[-1].get("cursor_lost"):
            break
    left = set(os.listdir(host))
    assert left == {"%d-1" % p for p in live} | {"%d-1" % os.getpid()}, len(left)
    assert os.listdir(other) == ["1-1"]
    assert recs[0]["stopped"] and not recs[-1]["stopped"] and len(recs) > 2, [r["stopped"] for r in recs]
    assert sum(r["removed"] for r in recs) == len(dead)
    log = open(os.path.join(root, ".plot3d-gc.log")).read().splitlines()
    assert len(log) == len(recs) and json.loads(log[0])["stopped"] is True
    # (the log rotates to one backup, never more)
    saved = P3._GC_LOG_BYTES
    P3._GC_LOG_BYTES = 1
    try:
        for _ in range(5):
            P3._gc_temps(root, alive=alive)
    finally:
        P3._GC_LOG_BYTES = saved
    logs = sorted(n for n in os.listdir(root) if n.startswith(".plot3d-gc.log"))
    assert logs == [".plot3d-gc.log", ".plot3d-gc.log.1"], logs
    # (a real dead pid is removed, a real live one kept)
    import subprocess
    p = subprocess.Popen([sys.executable, "-c", "pass"])
    p.wait()
    open(os.path.join(host, "%d-1" % p.pid), "w").close()
    open(os.path.join(host, "%d-1" % os.getppid()), "w").close()
    P3._gc_temps(root)
    assert not os.path.exists(os.path.join(host, "%d-1" % p.pid)) or P3._pid_alive(p.pid)  # (unless the pid was reused already)
    assert os.path.exists(os.path.join(host, "%d-1" % os.getppid()))
    print("gc: live, own and foreign kept; dead removed; the cursor progresses; one log backup: ok")


def test_gc_mixed_prefix():
    """daybreak2's gate: many kept (live) entries before the dead ones, in a
    directory order that stays the same from pass to pass.  With one deadline
    over seek and examination, a pass reads at most the budget's worth of
    entries: so later passes reach the dead ones when the kept prefix fits
    the budget, and when it doesn't (no random access into a directory: the
    kept entries before them must be read every pass), every pass is still
    bounded, progresses by its one entry, and its log line says it stopped."""
    real = os.scandir

    def run(live_n, budget, max_passes):
        d = tempfile.mkdtemp(prefix="sb-p3m-")
        root = os.path.join(d, ".sagebrush")
        host = os.path.join(root, ".plot3d-tmp", P3._host())
        os.makedirs(host)
        live = {800000 + i for i in range(live_n)}
        dead = {810000 + i for i in range(100)}
        for pid in live | dead:
            open(os.path.join(host, "%d-1" % pid), "w").close()

        class Ordered:
            def __init__(self, d):
                with real(d) as it:
                    self.es = sorted(it, key=lambda e: (int(e.name.split("-")[0]) not in live, e.name))

            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

            def __iter__(self):
                return iter(self.es)

        ticks = [0]

        def clock():
            ticks[0] += 1
            return ticks[0]

        os.scandir = Ordered
        recs = []
        try:
            for _ in range(max_passes):
                t = ticks[0]
                r = P3._gc_temps(root, budget_s=budget, clock=clock, alive=lambda pid: pid in live)
                recs.append(r)
                assert r["removed"] + r["kept"] >= 1 or not r["stopped"], r  # (a pass that stops examined an entry)
                # (and is bounded: the start's tick, the budget, the check crossing it, the allowed entry, the stop)
                assert ticks[0] - t <= budget + 4, ticks[0] - t
                if not r["stopped"] and not r.get("cursor_lost"):
                    break
        finally:
            os.scandir = real
        return host, live, recs

    host, live, recs = run(400, 450, 50)  # (the kept prefix fits the budget)
    assert set(os.listdir(host)) == {"%d-1" % p for p in live}, len(os.listdir(host))
    host, live, recs = run(400, 100, 30)  # (it doesn't: bounded, logged, never silent)
    assert all(r["stopped"] for r in recs) and len(os.listdir(host)) > len(live)
    print("gc mixed prefix: the dead entries behind 400 live ones are reached when they fit the budget; otherwise every pass is bounded and logs that it stopped: ok")


def _gc_time_cases(fake):
    """daybreak2's A-2-B1 and astra's A-2 (FU-GC-WALL): one deadline from the
    pass's start; each pass takes at most the budget and one entry; every pass
    progresses; repeated passes reach and remove the dead entries.  (1) A slow
    seek that runs out of budget before a present cursor.  (2) A missing
    cursor, then many slow stale entries.  (3) Cheap names, a slow liveness
    check: six live entries before four dead ones.

    fake=True: on an INJECTED clock (_gc_temps' clock=), in integer ticks:
    reading an entry and examining one advance it, and nothing else does, so
    the bound is exact and no scheduler can move it.  fake=False: the same in
    real time (sleeps), for the smoke check.  Returns each case's per-pass
    elapsed times and the costs (per entry read, budget, per examination)."""
    real = os.scandir
    PER, BUDGET, ALIVE = (30, 50, 20) if fake else (0.03, 0.05, 0.02)
    now = [0]
    clock = (lambda: now[0]) if fake else None  # (None: _gc_temps' own time.monotonic)

    def spend(dt):
        if fake:
            now[0] += dt
        else:
            time.sleep(dt)

    def stamp():
        return now[0] if fake else time.monotonic()

    class Slow:
        def __init__(self, d):
            with real(d) as it:
                self.es = sorted(it, key=lambda e: e.name)

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def __iter__(self):
            for e in self.es:
                spend(PER)
                yield e

    def setup(live, dead, cursor):
        d = tempfile.mkdtemp(prefix="sb-p3w-")
        root = os.path.join(d, ".sagebrush")
        host = os.path.join(root, ".plot3d-tmp", P3._host())
        os.makedirs(host)
        for p in live + dead:
            open(os.path.join(host, "%d-1" % p), "w").close()
        open(os.path.join(root, ".plot3d-gc.cursor"), "w").write(cursor)
        return root, host

    def passes(root, host, live, alive, limit):
        times, recs = [], []
        for _ in range(limit):
            t = stamp()
            r = P3._gc_temps(root, budget_s=BUDGET, clock=clock, alive=alive)
            times.append(stamp() - t)
            recs.append(r)
            assert r["removed"] + r["kept"] >= 1 or not r["stopped"], r  # (a pass that stops examined an entry)
            if not os.listdir(host) or set(os.listdir(host)) == {"%d-1" % p for p in live}:
                break
        return times, recs

    os.scandir = Slow
    try:
        # (1) the cursor (a live writer's) behind four dead entries, two more after
        # it: the seek to it alone takes 5 entries' reads, past the budget
        root, host = setup([400001], [100001, 100002, 100003, 100004, 500001, 500002], "400001-1")
        t1, r1 = passes(root, host, {400001}, lambda pid: pid in {400001}, 60)
        assert os.listdir(host) == ["400001-1"], os.listdir(host)
        # (2) a missing cursor, then eight slow stale entries
        root, host = setup([], list(range(300001, 300009)), "999999-1")
        t2, r2 = passes(root, host, set(), lambda pid: False, 60)
        assert os.listdir(host) == [], os.listdir(host)
    finally:
        os.scandir = real
    # (3) reading names is cheap, examining one is not (a slow liveness check):
    # six live entries before four dead ones.  A stopped pass's cursor is the
    # last entry it kept, so the next pass skips what it examined and goes on;
    # without it every pass would re-examine the same live ones and never
    # reach the dead.
    live3 = set(range(600001, 600007))
    root, host = setup(sorted(live3), [700001, 700002, 700003, 700004], "")

    def slow_alive(pid):
        spend(ALIVE)
        return pid in live3

    t3, _ = passes(root, host, live3, slow_alive, 20)
    assert set(os.listdir(host)) == {"%d-1" % p for p in live3}, os.listdir(host)
    return t1, t2, t3, (PER, BUDGET, ALIVE)


def test_gc_wall_time():
    """The pass bound, asserted exactly on an injected clock (FU-GC-WALL: the
    real-time bound flaked on a shared runner, max t2 0.1115 s against 0.11 s,
    master ci 40690519630): every pass of every case takes at most the budget
    plus ONE entry, where an entry costs its read (cases 1 and 2) or its
    examination (case 3), whatever the scheduler does; and the cases reach
    their end states (above)."""
    t1, t2, t3, (PER, BUDGET, ALIVE) = _gc_time_cases(True)
    assert all(isinstance(x, int) for x in t1 + t2 + t3), (t1, t2, t3)
    assert max(t1 + t2) <= BUDGET + PER, (max(t1), max(t2), BUDGET + PER)
    assert max(t3) <= BUDGET + ALIVE, (max(t3), BUDGET + ALIVE)
    assert all(t > 0 for t in t1 + t2 + t3), "every pass read or examined at least one entry"
    print("gc on an injected clock: passes of at most %d ticks (bound %d) and %d (bound %d) reach the dead entries, %d, %d and %d passes: ok"
          % (max(t1 + t2), BUDGET + PER, max(t3), BUDGET + ALIVE, len(t1), len(t2), len(t3)))


def test_gc_wall_time_smoke():
    """The same cases in real time, a smoke check only: the end states are
    asserted as above, and the pass times against a generous 4x bound (the
    budget, one entry and 0.03 s of the pass's own work, times four), so a
    shared runner's scheduling can't fail it; the exact bound is the injected
    clock's, above.  On Windows the real times are report-only (daybreak2's
    PR B r3 ruling: a shared runner's single passes there ranged from 0.064 s
    to 0.21 s for the same logic; the deadline is gated there by the
    injected-clock bound above and the fake-clock deadline tests below)."""
    t1, t2, t3, (PER, BUDGET, ALIVE) = _gc_time_cases(False)
    bound = 4 * (BUDGET + PER + 0.03)
    print("gc under real time, every pass (s): %s" % " ".join("%.3f" % t for t in t1 + t2 + t3))
    if os.name == "nt":
        print("gc under real time (Windows, report only): the longest pass %.3f s (case 3 %.3f s), %d, %d and %d passes"
              % (max(t1 + t2), max(t3), len(t1), len(t2), len(t3)))
        return
    assert max(t1 + t2 + t3) <= bound, (max(t1), max(t2), max(t3), bound)
    print("gc under real time (smoke): passes of at most %.3f s (4x bound %.3f; case 3 %.3f s), %d, %d and %d passes: ok"
          % (max(t1 + t2), bound, max(t3), len(t1), len(t2), len(t3)))


def test_gc_no_fetch_after_the_last_entry():
    """daybreak2's A-2-B1: once the deadline has passed at an examination, the
    pass stops there, without fetching another entry (the iterator here
    raises if it is asked for one then)."""
    d = tempfile.mkdtemp(prefix="sb-p3f-")
    root = os.path.join(d, ".sagebrush")
    host = os.path.join(root, ".plot3d-tmp", P3._host())
    os.makedirs(host)
    for i in range(5):
        open(os.path.join(host, "%d-1" % (910000 + i)), "w").close()
    now = [0.0]
    real = os.scandir

    class Guarded:
        def __init__(self, d):
            with real(d) as it:
                self.es = sorted(it, key=lambda e: e.name)

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def __iter__(self):
            for e in self.es:
                yield e
                if now[0] > 2.5:
                    raise AssertionError("an entry fetched after the budget was spent")

    def alive(pid):
        now[0] += 1.0  # (each examination takes one unit; the budget is 2.5)
        return False

    os.scandir = Guarded
    try:
        r = P3._gc_temps(root, budget_s=2.5, clock=lambda: now[0], alive=alive)
    finally:
        os.scandir = real
    assert r["removed"] == 3 and r["stopped"], r
    print("gc: no entry fetched after the one that spent the budget: ok")


class _Timed:
    """A fake scandir over a directory's entries (by name) on a fake clock:
    each fetch costs `fetch`, and asking for an entry once the clock is past
    the pass's deadline (its start, given, plus the budget) raises: a pass
    may finish the entry it fetched, never ask for another."""

    def __init__(self, now, fetch, deadline):
        self.now, self.fetch, self.deadline, self.asked = now, fetch, deadline, 0

    def __call__(self, d):
        real = _Timed.real
        with real(d) as it:
            self.es = sorted(it, key=lambda e: e.name)
        return self

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def __iter__(self):
        for e in self.es:
            if self.now[0] > self.deadline[0]:
                raise AssertionError("an entry asked for at %.2f, past the deadline %.2f" % (self.now[0], self.deadline[0]))
            self.asked += 1
            self.now[0] += self.fetch
            yield e


_Timed.real = os.scandir


def _gc_fake(names, cursor):
    """A root whose host directory holds these (empty) entries, and this cursor."""
    d = tempfile.mkdtemp(prefix="sb-p3d-")
    root = os.path.join(d, ".sagebrush")
    host = os.path.join(root, ".plot3d-tmp", P3._host())
    os.makedirs(host)
    for n in names:
        open(os.path.join(host, n), "w").close()
    open(os.path.join(root, ".plot3d-gc.cursor"), "w").write(cursor)
    return root, host


def _gc_pass(root, fetch, exam, budget, live=()):
    """One fake-clock pass (the clock at 100 when it starts; entries dead
    unless their pid is in live; each examination costs `exam`): its record,
    and how many entries it asked for."""
    now, deadline = [100.0], [100.0 + budget]
    fake = _Timed(now, fetch, deadline)

    def alive(pid):
        now[0] += exam
        return pid in live

    os.scandir = fake
    try:
        r = P3._gc_temps(root, budget_s=budget, clock=lambda: now[0], alive=alive)
    finally:
        os.scandir = _Timed.real
    return r, fake.asked


def test_gc_deadline_traversal():
    """daybreak2's PR B r3 (b), on a fake clock: one deadline from the pass's
    start; once an examination ends past it, no entry is asked for (fetches
    0.5, examinations 0.4, budget 2.5: the third examination ends at 2.7)."""
    names = ["%d-1" % (930000 + i) for i in range(8)]
    root, host = _gc_fake(names, "")
    r, asked = _gc_pass(root, 0.5, 0.4, 2.5)
    assert r["removed"] == 3 and r["kept"] == 0 and r["stopped"] and asked == 3, (r, asked)
    assert len(os.listdir(host)) == 5, os.listdir(host)
    print("gc deadline, traversal: three entries, stopped, none asked for after the deadline: ok")


def test_gc_deadline_after_seek():
    """The seek doesn't reset the deadline: the cursor (a live writer's) is
    found at 1.0, then two examinations end at 2.8, past the pass's 2.5; a
    deadline taken again after the seek would ask for a fourth entry."""
    names = ["%d-1" % (940000 + i) for i in range(6)]
    root, host = _gc_fake(names, names[1])
    r, asked = _gc_pass(root, 0.5, 0.4, 2.5, live={940001})
    assert r["removed"] == 2 and r["kept"] == 0 and r["stopped"] and r["resumed_after"] == names[1] and asked == 4, (r, asked)
    assert open(os.path.join(root, ".plot3d-gc.cursor")).read() == names[1]
    print("gc deadline, after a seek: one deadline, from the pass's start: ok")


def test_gc_deadline_in_seek():
    """The budget spent while seeking a present cursor (fetches 1.0, budget
    2.5, the cursor fifth): the entry fetched past the deadline is the pass's
    one examination, and nothing more is asked for.  Repeated passes, each
    asked the same, still reach every dead entry; every pass logs whether it
    stopped, and the cursor is a kept entry or none."""
    names = ["%d-1" % (950000 + i) for i in range(6)]
    root, host = _gc_fake(names, names[4])
    r, asked = _gc_pass(root, 1.0, 0.0, 2.5, live={950004})
    assert r["removed"] == 1 and r["kept"] == 0 and r["stopped"] and asked == 3, (r, asked)
    assert names[2] not in os.listdir(host) and open(os.path.join(root, ".plot3d-gc.cursor")).read() == names[4]
    n = 1
    while set(os.listdir(host)) != {names[4]}:
        n += 1
        assert n <= 12, os.listdir(host)
        r, asked = _gc_pass(root, 1.0, 0.0, 2.5, live={950004})
        assert r["removed"] + r["kept"] >= 1 or not r["stopped"], r  # (a pass that stops examined an entry)
        cur = open(os.path.join(root, ".plot3d-gc.cursor")).read()
        assert cur in ("", names[4]), cur
    log = [json.loads(l) for l in open(os.path.join(root, ".plot3d-gc.log"))]
    assert len(log) == n and all("stopped" in x for x in log), log
    print("gc deadline, in a seek: the entry reached is the one examined, nothing more asked for; %d passes reach the dead: ok" % n)


def test_get_deadline_nonempty():
    """astra's CORR-CTRLC-A-1: the deadline holds while the queue stays
    nonempty (stale replies, or a flood of output chunks): a clock that
    advances as messages are processed passes it, and _get returns False;
    the process's end (None) is still returned as death."""
    import queue
    s = S.Session.__new__(S.Session)
    s.stale = 0
    real = S.time.monotonic
    t = [0.0]

    def clock():
        t[0] += 1.0  # (one tick per look at the clock)
        return t[0]

    try:
        S.time.monotonic = clock
        for msgs in ([{"id": 9, "result": "stale"}] * 4 + [{"id": 1, "result": "late"}],
                     [{"id": 1, "out": "x", "stream": "stdout"}] * 4 + [{"id": 1, "result": "late"}]):
            s.replies = queue.Queue()
            for m in msgs:
                s.replies.put(m)
            assert s._get(1, 1.5) is False, msgs[0]
        s.replies = queue.Queue()
        s.replies.put(None)
        assert s._get(1, 1.5) is None
        s.replies = queue.Queue()
        s.replies.put({"id": 1, "result": "mine"})
        assert s._get(1, 1.5)["result"] == "mine"
    finally:
        S.time.monotonic = real
    print("_get: the deadline holds over a nonempty queue; EOF kept: ok")


# ------------------------------------------------------------------ 3b and 4: Session's ids and the timeout race

STANDIN = textwrap.dedent(r'''
    import json, os, signal, sys, threading, time
    hit = [False]
    def on_int(*a):
        hit[0] = True
    signal.signal(signal.SIGINT, on_int)
    if hasattr(signal, "SIGBREAK"):  # (Windows: Session.interrupt's Ctrl-Break, as the real worker takes it)
        signal.signal(signal.SIGBREAK, on_int)
    ctl = os.environ.get("SAGEBRUSH_CONTROL_FD")  # (POSIX: Session.interrupt's ids, as the real worker reads them)
    def control(fd):
        for line in os.fdopen(fd, "rb"):
            on_int()
    if ctl:
        threading.Thread(target=control, args=(int(ctl),), daemon=True).start()
    print(json.dumps({"ready": True}), flush=True)
    for line in sys.stdin:
        req = json.loads(line)
        code, rid = req["code"], req.get("id")
        def reply(**r):
            r.setdefault("stdout", ""); r.setdefault("result", None); r.setdefault("error", None)
            r.setdefault("error_info", None); r.setdefault("data", None); r.setdefault("displays", []); r.setdefault("seconds", 0.0)
            print(json.dumps(dict(r, id=rid)), flush=True)
        hit[0] = False
        if code == "finishes-late":       # (finishes just after the time limit's interrupt, whatever it said)
            while not hit[0]:
                time.sleep(0.01)
            time.sleep(0.2)
            reply(result="42", data={"x": 1})
        elif code == "interruptible":     # (stops when interrupted)
            while not hit[0]:
                time.sleep(0.01)
            reply(error="KeyboardInterrupt", error_info={"type": "interrupted", "exception": "KeyboardInterrupt", "message": "the computation was interrupted", "traceback": ""})
        elif code == "stale-first":       # (an earlier request's reply, and output, arrive first)
            print(json.dumps({"out": "old", "stream": "stdout", "id": rid - 1}), flush=True)
            print(json.dumps({"id": rid - 1, "result": "OLD"}), flush=True)
            print(json.dumps({"result": "NO-ID"}), flush=True)
            reply(result="mine")
        elif code == "slow-ok":
            time.sleep(0.5)
            reply(result=code)
        elif code == "die":
            sys.exit(3)
        else:
            reply(result=code)
''')


def _session():
    f = os.path.join(tempfile.mkdtemp(prefix="sb-standin-"), "w.py")
    open(f, "w").write(STANDIN)

    class T(S.Session):
        WORKER_ARGV = [sys.executable, f]

    return T()


def test_timeout_race_keeps_a_finished_reply():
    s = _session()
    try:
        r = s.run("finishes-late", timeout=0.2)
        assert r["result"] == "42" and r["data"] == {"x": 1} and r["error"] is None, r
        assert r["timed_out"] is True and "finished as the time limit" in r["timeout_note"] and r["restarted"] is False, r
        r = s.run("interruptible", timeout=0.2)
        assert r["error"].startswith("Interrupted: the time limit") and r["error_info"]["type"] == "timeout" and r["data"] is None, r
        assert "timed_out" not in r and r["restarted"] is False, r
    finally:
        s.close()
    print("3b: a finished reply keeps its result; an interrupted one is relabelled: ok")


def test_ids():
    s = _session()
    try:
        r = s.run("stale-first", timeout=5)
        assert r["result"] == "mine" and s.stale == 3, (r, s.stale)
        # (an interrupt in the parent while it waits: the next run gets its own reply)
        real = s.replies.get
        calls = [0]

        def get(timeout=None):
            calls[0] += 1
            if calls[0] == 1:
                raise KeyboardInterrupt
            return real(timeout=timeout)

        s.replies.get = get
        try:
            s.run("slow-ok", timeout=5)
            raise AssertionError("expected KeyboardInterrupt")
        except KeyboardInterrupt:
            pass
        s.replies.get = real
        r = s.run("second", timeout=5)
        assert r["result"] == "second", r  # (not "slow-ok", which arrives first and is dropped)
        assert s.stale >= 4, s.stale
        gen, q, rid = s.submit("third")
        assert rid == s.last_id and gen == s.generation
        # (the process's end is never taken for a stale message)
        assert s._get(rid, 5)["result"] == "third"
        r = s.run("die", timeout=5)
        assert r["error_info"]["type"] == "session" and r["restarted"] is True, r
    finally:
        s.close()
    print("4: ids, stale messages dropped on one deadline, the process's end kept: ok")


def test_runner_drops_stale():
    """The MCP runner's _finish takes only its request's messages: one with
    another id (only a bug could put it there) is dropped and said on stderr,
    never recorded as this run's output or result."""
    import test_runs as TR
    r = TR.runner()
    run, _ = r.start("slow", "sage", wait=0)
    s = r.made[0]
    s.q.put({"out": "NOT MINE", "stream": "stdout", "id": s.rid + 100})
    s.q.put({"id": s.rid + 100, "result": "NOT MINE", "stdout": "", "error": None, "error_info": None, "displays": [], "seconds": 0.0})
    s.finish("mine", stdout="mine\n")
    TR.until(run.done.is_set, "the run's end", 10)
    rec = r.record(run.record["handle"])
    text = json.dumps(rec)
    assert "mine" in text and "NOT MINE" not in text, text[:400]
    print("runner drops another request's messages: ok")

def case(f):
    # (a case that fails is reported, and the rest still run; the exit is non-zero if any failed)
    try:
        f()
    except Exception:
        import traceback
        traceback.print_exc()
        print("FAIL %s" % f.__name__, flush=True)
        failed.append(f.__name__)


failed = []

GC_DEADLINE = [test_gc_no_fetch_after_the_last_entry, test_gc_deadline_traversal, test_gc_deadline_after_seek, test_gc_deadline_in_seek]

if __name__ == "__main__" and sys.argv[1:] == ["gc-deadline"]:
    # (the deterministic deadline tests alone: the Windows mutant runs use them)
    for f in GC_DEADLINE:
        case(f)
    print("gc deadline: %s" % ("%d FAILED (%s)" % (len(failed), ", ".join(failed)) if failed else "all ok"))
    sys.exit(1 if failed else 0)

if __name__ == "__main__":
    case(test_display_reset)
    case(test_page_atomic_and_v2)
    case(test_page_two_threads)
    case(test_page_nested_callback)
    case(test_page_no_listing_with_stale_temps)
    case(test_gc)
    case(test_gc_mixed_prefix)
    case(test_gc_wall_time)
    case(test_gc_wall_time_smoke)
    case(test_gc_no_fetch_after_the_last_entry)
    case(test_gc_deadline_traversal)
    case(test_gc_deadline_after_seek)
    case(test_gc_deadline_in_seek)
    case(test_timeout_race_keeps_a_finished_reply)
    case(test_ids)
    case(test_get_deadline_nonempty)
    case(test_runner_drops_stale)
    if failed:
        print("ctrlc cleanup: %d FAILED (%s)" % (len(failed), ", ".join(failed)))
        sys.exit(1)
    print("ctrlc cleanup: all ok")
