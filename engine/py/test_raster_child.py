"""The PNG engine's process in the Python package (PNG plan r8, step A2):
the raster child, its launcher, its limits, its protocol and the ledger.

    python engine/py/test_raster_child.py [-k NAME]

Each test runs in a fresh Python (the package's PNG calls keep one child
per process).
"""
import subprocess
import sys
import textwrap

PRE = '''
import os, sys, struct, time
import sagebrush
from sagebrush.sage import *
import _sbraster, _raster_child as rc, _memledger, _capacity
'''


def run(code, env=None, timeout=600):
    import os
    e = dict(os.environ)
    e.update(env or {})
    r = subprocess.run([sys.executable, "-c", PRE + textwrap.dedent(code)], capture_output=True, text=True, timeout=timeout, env=e)
    return r.returncode, r.stdout, r.stderr


def ok(code, env=None):
    rc, out, err = run(code, env)
    assert rc == 0, (rc, out[-3000:], err[-3000:])
    return out


SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="30"><rect x="5" y="5" width="20" height="10" fill="red"/></svg>'


def test_render_and_decode_through_the_child():
    out = ok('''
    png, missing = _sbraster.render(%r, 1.0, 40, 30, None, 72.0, [("Software", "sagebrush")])
    print(png[:8] == b"\\x89PNG\\r\\n\\x1a\\n", missing == "")
    w, h, ch, v = _sbraster.decode(png)
    print(w, h, ch, type(v).__name__, len(v), float(v[(7 * w + 7) * 4]))
    c = _sbraster._child
    print(c is not None, c.enforced, os.path.exists("/proc/%%d" %% c.pid))
    led = _memledger.ledger()
    print(led.standing is not None and led.standing.bytes == c.limit, c.limit == c.vmsize())
    ''' % SVG)
    lines = out.split("\n")
    assert lines[0] == "True True", out
    assert lines[1] == "40 30 4 ndarray 4800 1.0", out
    assert lines[2] == "True True True", out
    assert lines[3] == "True True", out


def test_the_child_runs_under_its_limit_and_isolated():
    # its limit from its first instruction: RLIMIT_AS as the parent set it;
    # isolated, without site, killed with its parent
    out = ok('''
    _sbraster.render(%r, 1.0, 40, 30, None, 72.0, [])
    c = _sbraster._child
    import resource
    soft, hard = resource.prlimit(c.pid, resource.RLIMIT_AS)
    print(soft == c.limit, soft == c.vmsize())
    with open("/proc/%%d/status" %% c.pid) as f:
        sig = [l for l in f if l.startswith("SigCgt") or l.startswith("PPid")]
    with open("/proc/%%d/cmdline" %% c.pid, "rb") as f:
        argv = f.read().split(b"\\0")
    print(argv[1:3] == [b"-I", b"-S"], argv[0] == sys.executable.encode())
    ''' % SVG)
    assert out.split("\n")[:2] == ["True True", "True True"], out


def test_a_grant_below_the_render_is_the_memory_error_and_the_parent_lives():
    # a 4000 x 4000 render (64 MB the picture) when D0 says 300 MB are free,
    # of which the reserve leaves about 14 MB: refused, as memory, by the
    # child's limit or before; the parent goes on, and a small render works
    out = ok('''
    def small():
        return {"bytes": 300 << 20, "basis": [], "unknown_parts": [], "observed_at": 0,
                "reserve_bytes": _capacity.reserve_bytes(300 << 20), "domains": list(_capacity.DOMAINS)}
    _memledger._ledger = _memledger.Ledger(capacity=small)
    big = '<svg xmlns="http://www.w3.org/2000/svg" width="4000" height="4000"><rect width="10" height="10"/></svg>'
    try:
        _sbraster.render(big, 1.0, 4000, 4000, None, 72.0, [])
        print("drawn")
    except MemoryError as e:
        print(type(e).__name__)
    _memledger._ledger = _memledger.Ledger()
    png, _ = _sbraster.render(%r, 1.0, 40, 30, None, 72.0, [])
    print(png[:4] == b"\\x89PNG")
    ''' % SVG)
    assert out.split("\n")[:2] == ["SagebrushMemoryError", "True"], out


def test_malformed_input_is_a_value_error_and_the_child_stays():
    out = ok('''
    try:
        _sbraster.render("<svg", 1.0, 4, 4, None, 72.0, [])
    except ValueError as e:
        print("ValueError", "unterminated" in str(e))
    pid = _sbraster._child.pid
    _sbraster.render(%r, 1.0, 40, 30, None, 72.0, [])
    print(_sbraster._child.pid == pid)
    ''' % SVG)
    assert out.split("\n")[:2] == ["ValueError True", "True"], out


def test_a_child_killed_from_outside_is_an_engine_error_of_unknown_cause():
    out = ok('''
    import signal
    _sbraster.render(%r, 1.0, 40, 30, None, 72.0, [])
    os.kill(_sbraster._child.pid, signal.SIGKILL)
    time.sleep(0.2)
    try:
        _sbraster.render(%r, 1.0, 40, 30, None, 72.0, [])
        print("drawn")
    except rc.SagebrushEngineError as e:
        print("engine", "outside Sagebrush" in str(e) or "failed" in str(e))
    except MemoryError:
        print("memory")
    png, _ = _sbraster.render(%r, 1.0, 40, 30, None, 72.0, [])
    print(png[:4] == b"\\x89PNG")
    ''' % (SVG, SVG, SVG))
    assert out.split("\n")[1] == "True", out
    assert out.split("\n")[0] in ("engine True", "drawn"), out


def test_the_launcher_refuses_its_footprint_past_the_bound():
    # the launcher's own check: a bound one byte below what it measures
    out = ok('''
    import tempfile
    L = rc._launcher()
    r, w = os.pipe()
    argv = [L, str(512 << 20), str(os.getpid()), "1", "1", "/bin/true"]
    pid = os.posix_spawn(L, argv, {"LC_ALL": "C"}, file_actions=[(os.POSIX_SPAWN_DUP2, w, 1)])
    os.close(w)
    _, st = os.waitpid(pid, 0)
    data = os.read(r, 64)
    magic, kind, n, stage, errno, observed = struct.unpack("<IIQIIQ", data)
    print(os.waitstatus_to_exitcode(st), kind, stage, errno)
    bound = rc.footprint_bound(L, [L, str(512 << 20), str(os.getpid()), "1", "0", "/bin/true"], {"LC_ALL": "C"}, L)
    print(observed <= bound, observed, bound)
    ''')
    lines = out.split("\n")
    assert lines[0] == "103 7 3 0", out
    assert lines[1].startswith("True"), out


def test_a_kill_during_an_unrelated_cgroup_oom_is_not_called_memory():
    # the cgroup's oom_kill count rising while the child is killed from
    # outside is correlation, not evidence: the engine's error, its cause
    # unconfirmed, oom_suspected set; never the memory error
    out = ok('''
    import signal, threading
    _sbraster.render(%r, 1.0, 40, 30, None, 72.0, [])
    counts = iter([5, 6, 6, 6])
    rc._oom_kills = lambda: next(counts)
    big = '<svg xmlns="http://www.w3.org/2000/svg" width="3000" height="3000">' + "".join(
        '<circle cx="1500" cy="1500" r="%%d" fill="none" stroke="black" stroke-dasharray="0.3 0.3"/>' %% (100 + i) for i in range(400)) + '</svg>'
    pid = _sbraster._child.pid
    threading.Timer(0.3, lambda: os.kill(pid, signal.SIGKILL)).start()
    try:
        _sbraster.render(big, 1.0, 3000, 3000, None, 72.0, [])
        print("drawn")
    except MemoryError:
        print("memory")
    except rc.SagebrushEngineError as e:
        print("engine", e.oom_suspected, "unconfirmed" in str(e))
    ''' % SVG)
    assert out.split("\n")[0] == "engine True True", out


def test_a_launcher_not_the_one_built_is_never_run():
    # its sha256 against the package's table, once: a mismatch is the
    # contained mode with the warning (enforced: refused), never a run of it
    code = '''
    rc.LAUNCHER_SHA256 = {k: "0" * 64 for k in rc.LAUNCHER_SHA256}
    rc._checked.clear()
    try:
        png, _ = _sbraster.render(%r, 1.0, 40, 30, None, 72.0, [])
        print("drawn", _sbraster._child.enforced)
    except rc.SagebrushEngineError as e:
        print("refused", "enforced" in str(e))
    ''' % SVG
    rc_, out, err = run(code)
    assert rc_ == 0 and out.split("\n")[0] == "drawn False" and "not the one this package was built with" in err, (out, err)
    rc_, out, err = run(code, env={"SAGEBRUSH_RASTER_ISOLATION": "enforced"})
    assert rc_ == 0 and out.split("\n")[0] == "refused True", (out, err)


def test_the_in_process_opt_in_draws_and_reads_without_a_child():
    # SAGEBRUSH_RASTER_ISOLATION=in-process (William, Oct 25: "Yes: separate
    # process by default (in-process available as an opt-in)"): no child,
    # the warning once, render and decode inside Python
    code = '''
    png, missing = _sbraster.render(%r, 1.0, 40, 30, None, 72.0, [])
    w, h, ch, raw = _sbraster.decode(png)
    _sbraster.render(%r, 1.0, 40, 30, None, 72.0, [])
    print(png[:4] == b"\\x89PNG", (w, h, ch), len(raw), _sbraster._child is None)
    ''' % (SVG, SVG)
    rc_, out, err = run(code, env={"SAGEBRUSH_RASTER_ISOLATION": "in-process"})
    assert rc_ == 0 and out.split("\n")[0] == "True (40, 30, 4) 19200 True", (out, err)
    assert err.count("inside Python") == 1, err


def test_the_idle_loop_allocates_nothing():
    # at a limit of exactly its own VmSize, 10,000 pings are answered
    out = ok('''
    _sbraster.render(%r, 1.0, 40, 30, None, 72.0, [])
    c = _sbraster._child
    c.set_limit(c.vmsize())
    ping = struct.pack("<IIQ", rc.MAGIC, rc.PING, 0)
    for i in range(10000):
        rc.write_all(c, [ping])
        k, n = rc.read_frame(c, {rc.PONG: 0})
        assert k == rc.PONG
    print("pongs", c.vmsize() <= c.limit)
    ''' % SVG)
    assert out.split("\n")[0] == "pongs True", out


def test_the_prelude_refuses_without_its_flags():
    # (a negative control for argv[0]: started without -I, the prelude
    # writes its flags refusal and exits 105, never running the engine)
    out = ok('''
    r, w = os.pipe()
    err = open(os.devnull, "wb")
    argv = [sys.executable, "-S", "-c", rc.PRELUDE, rc._ext_path()]
    pid = os.posix_spawn(sys.executable, argv, {"LC_ALL": "C"}, file_actions=[(os.POSIX_SPAWN_DUP2, w, 1)])
    os.close(w)
    _, st = os.waitpid(pid, 0)
    data = os.read(r, 64)
    print(os.waitstatus_to_exitcode(st), struct.unpack("<IIQIIQ", data)[1:4])
    # and a decoy module in the cwd never loads in the real child
    d = __import__("tempfile").mkdtemp()
    open(os.path.join(d, "importlib.py"), "w").write("raise SystemExit(77)\\n")
    os.chdir(d)
    png, _ = _sbraster.render(%r, 1.0, 40, 30, None, 72.0, [])
    print(png[:4] == b"\\x89PNG")
    ''' % SVG)
    lines = out.split("\n")
    assert lines[0] == "105 (7, 16, 5)", out
    assert lines[1] == "True", out


def test_a_startup_under_a_tiny_limit_claims_memory_only_with_evidence():
    # limits from below the interpreter's start to above the warm-up: each
    # outcome is the drawing, a memory error with its evidence, or the
    # engine's failure of unknown cause naming the limit, never anything else
    out = ok('''
    seen = set()
    for mb in (4, 8, 16, 24, 32, 48, 64, 96, 128, 192, 256):
        _sbraster._child = None
        _memledger._ledger = None
        try:
            c = _sbraster._start(mb << 20, "enforced")
            seen.add("started")
            c.kill()
        except MemoryError as e:
            seen.add("memory")
            assert "PNG engine" in str(e), str(e)
        except rc.SagebrushEngineError as e:
            seen.add("engine")
            assert "cause unknown" in str(e) or "failed to start" in str(e), str(e)
            assert "limit" in str(e) or "failed to start" in str(e), str(e)
    print(sorted(seen))
    ''')
    seen = eval(out.split("\n")[0])
    assert "started" in seen and "engine" in seen, out


def test_the_child_dies_with_its_parent():
    out = ok('''
    code = "\\n".join(["import sagebrush, sys", "from sagebrush.sage import *", "import _sbraster, os",
                      "_sbraster.render(os.environ['SVG'], 1.0, 40, 30, None, 72.0, [])", "print(_sbraster._child.pid, flush=True)", "os._exit(0)"])
    import subprocess
    p = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, env=dict(os.environ, SVG=%r))
    pid = int(p.stdout.split()[0])
    for _ in range(50):
        if not os.path.exists("/proc/%%d" %% pid):
            break
        time.sleep(0.1)
    st = open("/proc/%%d/stat" %% pid).read().split()[2] if os.path.exists("/proc/%%d" %% pid) else "gone"
    print(st in ("gone", "Z"))
    ''' % SVG)
    assert out.split("\n")[0] == "True", out


def test_a_launcher_that_cannot_run_is_the_contained_mode_or_refused():
    code = '''
    L = rc._launcher()
    import shutil, tempfile
    d = tempfile.mkdtemp()
    bad = os.path.join(d, "raster-launch")
    shutil.copy(L, bad)
    os.chmod(bad, 0o644)
    rc._launcher = lambda: bad
    try:
        png, _ = _sbraster.render(%r, 1.0, 40, 30, None, 72.0, [])
        print("drawn", _sbraster._child.enforced)
    except rc.SagebrushEngineError as e:
        print("refused", "enforced" in str(e))
    ''' % SVG
    rc_, out, err = run(code)
    assert rc_ == 0 and out.split("\n")[0] == "drawn False" and "cannot enforce a memory bound" in err, (out, err)
    rc_, out, err = run(code, env={"SAGEBRUSH_RASTER_ISOLATION": "enforced"})
    assert rc_ == 0 and out.split("\n")[0] == "refused True", (out, err)


def test_frames_past_their_bound_are_refused_before_anything_is_allocated():
    out = ok('''
    import tracemalloc
    r, w = os.pipe()
    c = rc.Child(0, -1, r, None, False)
    os.write(w, struct.pack("<IIQ", rc.MAGIC, rc.OK_RENDER, 1 << 40))
    tracemalloc.start()
    try:
        rc.read_frame(c, {rc.OK_RENDER: 1 << 20})
        print("read")
    except rc.ProtocolError:
        print("refused", tracemalloc.get_traced_memory()[1] < (1 << 20))
    os.write(w, struct.pack("<IIQ", 0xdeadbeef, rc.OK_RENDER, 0))
    try:
        rc.read_frame(c, {rc.OK_RENDER: 1 << 20})
    except rc.ProtocolError:
        print("bad magic")
    os.write(w, b"\\x01\\x02")
    os.close(w)
    try:
        rc.read_frame(c, {rc.OK_RENDER: 1 << 20})
    except rc._Exited:
        print("truncated")
    ''')
    assert out.split("\n")[:3] == ["refused True", "bad magic", "truncated"], out


def test_ctrl_c_ends_a_wait_under_back_pressure_at_once():
    # a child that reads nothing: the request blocks on the full pipe, and
    # Ctrl-C (here a timer's KeyboardInterrupt) ends the wait within a wake
    out = ok('''
    import signal, subprocess
    p = subprocess.Popen(["sleep", "30"], stdin=subprocess.PIPE, stdout=subprocess.PIPE)
    c = rc.Child(p.pid, p.stdin.fileno(), p.stdout.fileno(), None, False, p)
    os.set_blocking(c.wfd, False)
    def stop(*a):
        raise KeyboardInterrupt
    signal.signal(signal.SIGALRM, stop)
    signal.setitimer(signal.ITIMER_REAL, 0.3)
    t = time.monotonic()
    try:
        rc.write_all(c, [bytes(16 << 20)])
    except KeyboardInterrupt:
        print("interrupted", round(time.monotonic() - t, 1) <= 0.5)
    p.kill()
    ''')
    assert out.split("\n")[0] == "interrupted True", out


def test_ctrl_c_during_a_render_kills_the_child_and_the_next_call_works():
    out = ok('''
    import signal
    big = '<svg xmlns="http://www.w3.org/2000/svg" width="4000" height="4000">' + "".join(
        '<circle cx="%%d" cy="%%d" r="900" fill="none" stroke="black" stroke-dasharray="0.3 0.3"/>' %% (i * 7 %% 4000, i * 13 %% 4000) for i in range(400)) + '</svg>'
    _sbraster.render(%r, 1.0, 40, 30, None, 72.0, [])
    pid = _sbraster._child.pid
    def stop(*a):
        raise KeyboardInterrupt
    signal.signal(signal.SIGALRM, stop)
    signal.setitimer(signal.ITIMER_REAL, 0.5)
    t = time.monotonic()
    try:
        _sbraster.render(big, 1.0, 4000, 4000, None, 72.0, [])
        print("drawn")
    except KeyboardInterrupt:
        print("interrupted", round(time.monotonic() - t - 0.5, 1) <= 0.2)
    print(_sbraster._child is None, not os.path.exists("/proc/%%d" %% pid) or open("/proc/%%d/stat" %% pid).read().split()[2] == "Z")
    print(_memledger.ledger().held() == 0 or [r for r in _memledger.ledger().records])
    png, _ = _sbraster.render(%r, 1.0, 40, 30, None, 72.0, [])
    print(png[:4] == b"\\x89PNG", _sbraster._child.pid != pid)
    ''' % (SVG, SVG))
    lines = out.split("\n")
    assert lines[0] == "interrupted True", out
    assert lines[1] == "True True", out
    assert lines[3] == "True True", out


def test_two_threads_are_served_one_at_a_time():
    out = ok('''
    import threading
    results = []
    def work():
        for _ in range(5):
            png, _ = _sbraster.render(%r, 1.0, 40, 30, None, 72.0, [])
            results.append(png[:4] == b"\\x89PNG")
    ts = [threading.Thread(target=work) for _ in range(2)]
    [t.start() for t in ts]
    [t.join() for t in ts]
    print(len(results), all(results))
    # the child outlives the thread that started it (the parent-death
    # signal follows the starting thread: they are started on one that lives
    # as long as the process)
    _sbraster._reap()
    t = threading.Thread(target=lambda: _sbraster.render(%r, 1.0, 40, 30, None, 72.0, []))
    t.start()
    t.join()
    pid = _sbraster._child.pid
    time.sleep(0.3)
    _sbraster.render(%r, 1.0, 40, 30, None, 72.0, [])
    print(_sbraster._child.pid == pid)
    ''' % (SVG, SVG, SVG))
    assert out.split("\n")[:2] == ["10 True", "True"], out


if __name__ == "__main__":
    names = [n for n in list(globals()) if n.startswith("test_")]
    if "-k" in sys.argv:
        names = [n for n in names if sys.argv[sys.argv.index("-k") + 1] in n]
    for n in names:
        globals()[n]()
        print("ok", n)
