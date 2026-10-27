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
            P3.write_page(path, "partial?")
        except KeyboardInterrupt:
            pass
        finally:
            os.fsync = real
        assert not os.path.exists(path)
        assert len(_temps(".sagebrush")) == 1
        P3.write_page(path, "whole")
        assert open(path).read() == "whole" and _temps(".sagebrush") == []
        # (a failure: the temporary removed, by name, and the error raised)
        def failing(fd):
            raise OSError(28, "No space left on device")

        os.fsync = failing
        try:
            P3.write_page(os.path.join(".sagebrush", "plot3d-v2-full.html"), "x")
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
        ts = [threading.Thread(target=P3.write_page, args=(os.path.join(".sagebrush", "plot3d-v2-%s.html" % n), n * 1000)) for n in "ab"]
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
        P3.write_page(os.path.join(".sagebrush", "plot3d-v2-a.html"), "a")  # (success)
        real_replace = os.replace

        def bad_replace(a, b):
            raise OSError(1, "rename refused")

        os.replace = bad_replace
        try:
            P3.write_page(os.path.join(".sagebrush", "plot3d-v2-b.html"), "b")  # (the rename fails: cleanup by name)
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

    alive = lambda pid: pid in live  # noqa: E731  (this process reported dead too: only gc_temps' own rule keeps its temporary)
    recs = []
    for _ in range(50):
        recs.append(P3.gc_temps(root, budget_s=50, clock=clock, alive=alive))
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
    saved = P3.GC_LOG_BYTES
    P3.GC_LOG_BYTES = 1
    try:
        for _ in range(5):
            P3.gc_temps(root, alive=alive)
    finally:
        P3.GC_LOG_BYTES = saved
    logs = sorted(n for n in os.listdir(root) if n.startswith(".plot3d-gc.log"))
    assert logs == [".plot3d-gc.log", ".plot3d-gc.log.1"], logs
    # (a real dead pid is removed, a real live one kept)
    import subprocess
    p = subprocess.Popen([sys.executable, "-c", "pass"])
    p.wait()
    open(os.path.join(host, "%d-1" % p.pid), "w").close()
    open(os.path.join(host, "%d-1" % os.getppid()), "w").close()
    P3.gc_temps(root)
    assert not os.path.exists(os.path.join(host, "%d-1" % p.pid)) or P3._pid_alive(p.pid)  # (unless the pid was reused already)
    assert os.path.exists(os.path.join(host, "%d-1" % os.getppid()))
    print("gc: live, own and foreign kept; dead removed; the cursor progresses; one log backup: ok")


def test_gc_mixed_prefix():
    """daybreak2's gate: many kept (live) entries before the dead ones, in a
    directory order that stays the same from pass to pass: each pass
    examines past its cursor, so later passes reach the dead ones."""
    d = tempfile.mkdtemp(prefix="sb-p3m-")
    root = os.path.join(d, ".sagebrush")
    host = os.path.join(root, ".plot3d-tmp", P3._host())
    os.makedirs(host)
    live = {800000 + i for i in range(400)}
    dead = {810000 + i for i in range(100)}
    for pid in live | dead:
        open(os.path.join(host, "%d-1" % pid), "w").close()
    real = os.scandir

    class Ordered:
        # (the real entries, every live one first)
        def __init__(self, d):
            with real(d) as it:
                self.es = sorted(it, key=lambda e: (int(e.name.split("-")[0]) not in live, e.name))

        def __enter__(self):
            return self

        def __iter__(self):
            return iter(self.es)

        def __exit__(self, *a):
            return False

    ticks = [0]

    def clock():
        ticks[0] += 1
        return ticks[0]

    os.scandir = Ordered
    try:
        passes = 0
        while passes < 100:
            passes += 1
            r = P3.gc_temps(root, budget_s=50, clock=clock, alive=lambda pid: pid in live)
            if not r["stopped"] and not r.get("cursor_lost"):
                break
    finally:
        os.scandir = real
    assert set(os.listdir(host)) == {"%d-1" % p for p in live}, len(os.listdir(host))
    assert 8 <= passes <= 12, passes  # (400 kept, about 50 examined a pass, then the dead ones)
    print("gc mixed prefix: %d passes reach the dead entries behind 400 live ones: ok" % passes)


# ------------------------------------------------------------------ 3b and 4: Session's ids and the timeout race

STANDIN = textwrap.dedent(r'''
    import json, signal, sys, time
    hit = [False]
    def on_int(*a):
        hit[0] = True
    signal.signal(signal.SIGINT, on_int)
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
        assert r["timed_out"] is True and "finished as the time limit" in r["timeout_note"], r
        r = s.run("interruptible", timeout=0.2)
        assert r["error"].startswith("Interrupted: the time limit") and r["error_info"]["type"] == "timeout" and r["data"] is None, r
        assert "timed_out" not in r
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


if __name__ == "__main__":
    test_display_reset()
    test_page_atomic_and_v2()
    test_page_two_threads()
    test_page_nested_callback()
    test_page_no_listing_with_stale_temps()
    test_gc()
    test_gc_mixed_prefix()
    test_timeout_race_keeps_a_finished_reply()
    test_ids()
    test_runner_drops_stale()
    print("ctrlc cleanup: all ok")
