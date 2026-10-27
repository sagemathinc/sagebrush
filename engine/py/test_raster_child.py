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
    # (its standing charge: its limit less what the call's re-base saw resident)
    print(led.standing is not None and led.standing.bytes == c.limit - led.child_rss, c.limit == c.vmsize())
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
    print(png[:4] == b"\\x89PNG", (w, h, ch), type(raw).__name__, len(raw), _sbraster._child is None)
    ''' % (SVG, SVG)
    rc_, out, err = run(code, env={"SAGEBRUSH_RASTER_ISOLATION": "in-process"})
    assert rc_ == 0 and out.split("\n")[0] == "True (40, 30, 4) ndarray 4800 True", (out, err)
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
            c = _sbraster._start(mb << 20, "enforced", rc.launch_plan("enforced"))
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



# ---- #157 r2: the reviews' findings, each a regression test (daybreak2's
# LIMIT-PNG-A2-1..3, astra2's CORR-157-1..6).  EXACT(F) is a ledger whose F0
# is exactly F (no reserve); FAKE an in-process engine that records its calls.
R2 = textwrap.indent(r"""
import gc, threading, tracemalloc, _thread, signal
# (Stop as Ctrl-C: interrupt_main does nothing where SIGINT is ignored, as a
# background job's is; Python's own handler, as in an ordinary session)
signal.signal(signal.SIGINT, signal.default_int_handler)
ALLD = list(_capacity.DOMAINS)
def EXACT(free, domains=ALLD, environ=None):
    def cap():
        return {"bytes": free, "basis": [], "unknown_parts": [], "observed_at": 0, "reserve_bytes": 0,
                "domains": [] if free is None else list(domains)}
    cap.calls = 0
    def counted():
        cap.calls += 1
        return cap()
    led = _memledger.Ledger(capacity=counted, environ=environ if environ is not None else {})
    _memledger._ledger = led
    return led, cap
class FAKE:
    calls = []
    gate = None
    def raster_render(self, svg, scale, w, h, bg, dpi, text):
        FAKE.calls.append("render")
        if FAKE.gate is not None:
            FAKE.gate.wait()
        return b"\x89PNG\r\n\x1a\n" + bytes(100), ""
    def raster_decode(self, png):
        FAKE.calls.append("decode")
        return 2, 3, 1, bytes(4 * 6)
def fake_in_process():
    os.environ["SAGEBRUSH_RASTER_ISOLATION"] = "in-process"
    _sbraster._in_process = lambda: FAKE()
def render_need(svg, w, h, text=()):
    b, t = _sbraster._utf8_len(svg), _sbraster._text_len(list(text))
    return _sbraster.render_host(b, t, 0, _sbraster.png_bound(w, h, t, len(text))), 4 * w * h
def fds():
    return len(os.listdir("/proc/self/fd"))
""", "    ")

def test_r2_LIMIT_A2_1_the_lock_and_reservation_hold_through_the_outputs():
    # daybreak2: the reply available, nothing built from it yet (a pause
    # there): the call still holds the lock, its host and engine records;
    # a second caller waits on the lock without re-basing; both then finish,
    # nothing active left.  An exception at that point strands nothing.
    out = ok(R2 + """
    led, cap = EXACT(1 << 30)
    _sbraster.render(%r, 1.0, 40, 30, None, 72.0, [])
    entered, gate, res = threading.Event(), threading.Event(), []
    def pause():
        entered.set()
        gate.wait()
    for what in ("render", "decode"):
        png = res[-1][0] if res else _sbraster.render(%r, 1.0, 40, 30, None, 72.0, [])[0]
        entered.clear(); gate.clear()
        _sbraster._after_reply = pause
        f = (lambda: res.append(_sbraster.render(%r, 1.0, 40, 30, None, 72.0, []))) if what == "render" else (lambda: res.append(_sbraster.decode(png)))
        a = threading.Thread(target=f)
        a.start()
        entered.wait()
        _sbraster._after_reply = None
        active = sorted(r.kind for r in led.records if r.kind in ("host", "engine"))
        n0 = cap.calls
        b = threading.Thread(target=f)
        b.start()
        time.sleep(0.4)
        print(what, active == ["engine", "host"], cap.calls == n0, led.call_lock.locked())
        gate.set()
        a.join(); b.join()
        print(what, not led.call_lock.locked(), not any(r.kind in ("host", "engine") for r in led.records), led.held() <= led.f0)
    def boom():
        raise RuntimeError("boom")
    for what in ("render", "decode"):
        _sbraster._after_reply = boom
        try:
            _sbraster.render(%r, 1.0, 40, 30, None, 72.0, []) if what == "render" else _sbraster.decode(png)
        except RuntimeError:
            pass
        _sbraster._after_reply = None
        print(what, "error", not led.call_lock.locked(), not any(r.kind in ("host", "engine") for r in led.records))
    """ % (SVG, SVG, SVG, SVG))
    assert out.split("\n")[:6] == ["render True True True", "render True True True", "decode True True True",
                                   "decode True True True", "render error True True", "decode error True True"], out


def test_r2_LIMIT_A2_2_outputs_are_charged_at_their_live_sizes():
    # daybreak2: the PNG and the missing characters' str (render), the
    # values' buffer and the array's header (decode), each at its actual
    # size, as resident records
    out = ok(R2 + """
    led, cap = EXACT(1 << 30)
    svg = '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="30"><text x="2" y="20">\\u6f22</text></svg>'
    png, missing = _sbraster.render(svg, 1.0, 40, 30, None, 72.0, [])
    rs = sorted(r.bytes for r in led.records if r.kind == "resident")
    print(missing == "\\u6f22", rs == sorted([sys.getsizeof(png), sys.getsizeof(missing)]), type(png) is bytes)
    w, h, ch, arr = _sbraster.decode(png)
    rs2 = sorted(r.bytes for r in led.records if r.kind == "resident" and r.state == "live")
    buf = getattr(arr.base, "obj", arr.base)
    print(sys.getsizeof(buf) in rs2 and sys.getsizeof(arr) in rs2, type(buf).__name__)
    """)
    assert out.split("\n")[:2] == ["True True True", "True _Buf"], out


def test_r2_LIMIT_A2_2_and_3_in_process_is_admitted_exactly():
    # daybreak2: in-process runs the same admission: one byte below the
    # call's need, refused before the engine runs; at it, admitted, and the
    # outputs resident (no extension needed: the engine is a fake)
    out = ok(R2 + """
    fake_in_process()
    host, need = render_need(%r, 40, 30)
    led, cap = EXACT(host + need - 1)
    try:
        _sbraster.render(%r, 1.0, 40, 30, None, 72.0, [])
        print("drawn")
    except MemoryError:
        print("refused", FAKE.calls == [])
    led, cap = EXACT(host + need)
    png, missing = _sbraster.render(%r, 1.0, 40, 30, None, 72.0, [])
    print(FAKE.calls == ["render"], led.held() == sys.getsizeof(png) + sys.getsizeof(missing), led.held() <= led.f0)
    w, h, ch, arr = _sbraster.decode(png)
    print((w, h, ch), arr.shape, type(getattr(arr.base, "obj", arr.base)).__name__)
    """ % (SVG, SVG, SVG), env={"SAGEBRUSH_RASTER_ISOLATION": "in-process"})
    assert out.split("\n")[:3] == ["refused True", "True True True", "(2, 3, 1) (6,) _Buf"], out


def test_r2_CORR_157_1_nothing_request_sized_is_made_before_admission():
    # astra2: a large SVG under a zero allowance: refused with no allocation
    # of its size first; and two callers waiting on the lock hold nothing of
    # theirs (no extension needed: in-process, its engine a fake that waits)
    out = ok(R2 + """
    fake_in_process()
    big = '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="30"><text>' + "\\u00e9" * 1000000 + '</text></svg>'
    value = "\\u00e9" * 500000
    led, cap = EXACT(0)
    tracemalloc.start()
    def refused_small(mode):
        os.environ["SAGEBRUSH_RASTER_ISOLATION"] = mode
        base = tracemalloc.get_traced_memory()[0]
        tracemalloc.reset_peak()
        refused = False
        try:
            _sbraster.render(big, 1.0, 40, 30, None, 72.0, [("k", value)])
        except MemoryError:
            refused = True
        return refused, tracemalloc.get_traced_memory()[1] - base < (256 << 10)
    r, small = refused_small("in-process")
    print("refused", r, FAKE.calls == [], small)
    # (the child's path: its start a fake that must not be reached)
    if hasattr(rc, "Plan"):
        rc.launch_plan = lambda want: rc.Plan(None, 0, [], {})
    spawned = []
    def no_spawn(*a):
        spawned.append(1)
        raise RuntimeError("spawned")
    rc.spawn = no_spawn
    _sbraster._start = no_spawn
    r, small = refused_small("contained")
    print("child", r, spawned == [], small)
    os.environ["SAGEBRUSH_RASTER_ISOLATION"] = "in-process"
    led, cap = EXACT(1 << 30)
    FAKE.gate = threading.Event()
    first = threading.Thread(target=lambda: _sbraster.render(%r, 1.0, 40, 30, None, 72.0, []))
    first.start()
    while not FAKE.calls:
        time.sleep(0.01)
    base = tracemalloc.get_traced_memory()[0]
    tracemalloc.reset_peak()
    ws = [threading.Thread(target=lambda: _sbraster.render(big, 1.0, 40, 30, None, 72.0, [])) for _ in range(2)]
    [t.start() for t in ws]
    time.sleep(0.5)
    print("waiting", tracemalloc.get_traced_memory()[1] - base < (256 << 10))
    FAKE.gate.set()
    first.join(); [t.join() for t in ws]
    """ % SVG, env={"SAGEBRUSH_RASTER_ISOLATION": "in-process"})
    assert out.split("\n")[:3] == ["refused True True True", "child True True True", "waiting True"], out


def test_r2_CORR_157_3_a_footprint_refusal_starts_a_contained_child_whose_ready_is_read():
    # astra2: the launcher refusing its footprint (its bound forced to a
    # byte): the replacement child's READY read like any start's; renders work
    code = R2 + """
    led, cap = EXACT(1 << 30)
    rc.footprint_bound = lambda *a: 1
    png, _ = _sbraster.render(%r, 1.0, 40, 30, None, 72.0, [])
    png2, _ = _sbraster.render(%r, 1.0, 40, 30, None, 72.0, [])
    print(png[:4] == b"\\x89PNG", png2 == png, _sbraster._child.enforced)
    """ % (SVG, SVG)
    rc_, out, err = run(code)
    assert rc_ == 0 and out.split("\n")[0] == "True True False" and "footprint" in err, (out, err)


def test_r2_CORR_157_3_stop_before_during_and_after_a_spawn_leaves_no_child():
    # astra2: Ctrl-C (interrupt_main) while the spawner is busy (f never
    # runs), during f (the spawner undoes its child), and after f before the
    # handoff (undone here): exactly one cleanup each, no pid left, and the
    # next spawn works (no extension needed: /bin/sleep children)
    out = ok(R2 + """
    def sleeper():
        return os.posix_spawn("/bin/sleep", ["sleep", "30"], {})
    log = []
    def undo(pid):
        log.append(("undo", pid))
        os.kill(pid, 9); os.waitpid(pid, 0)
    def discard():
        log.append(("discard",))
    def alive(pid):
        try:
            os.kill(pid, 0)
            return True
        except OSError:
            return False
    def stop_after(t):
        threading.Timer(t, _thread.interrupt_main).start()
    # (before: the spawner busy with another start)
    busy = threading.Event()
    blocker = threading.Thread(target=lambda: rc._from_spawner(lambda: busy.wait() and 0, lambda v: None, lambda: None))
    blocker.start()
    time.sleep(0.1)
    ran = []
    stop_after(0.2)
    try:
        rc._from_spawner(lambda: ran.append(1) or sleeper(), undo, discard)
    except KeyboardInterrupt:
        pass
    busy.set(); blocker.join(); time.sleep(0.3)
    print("before", ran == [], log == [("discard",)])
    # (during: f is running when Stop comes)
    log.clear()
    started, go = threading.Event(), threading.Event()
    def slow():
        started.set(); go.wait()
        return sleeper()
    threading.Thread(target=lambda: (started.wait(), time.sleep(0.1), _thread.interrupt_main())).start()
    try:
        rc._from_spawner(slow, undo, discard)
    except KeyboardInterrupt:
        pass
    go.set(); time.sleep(0.5)
    print("during", len(log) == 1 and log[0][0] == "undo" and not alive(log[0][1]))
    # (after: f done, Stop before the handoff)
    log.clear()
    def then_stop():
        pid = sleeper()
        _thread.interrupt_main()
        time.sleep(0.2)
        return pid
    try:
        pid = rc._from_spawner(then_stop, undo, discard)
        log.append(("taken", pid)); undo(pid)
    except KeyboardInterrupt:
        pass
    time.sleep(0.3)
    print("after", len(log) in (1, 2) and [x[0] for x in log].count("undo") == 1 and not alive(log[-1][1]))
    pid = rc._from_spawner(sleeper, undo, discard)
    print("next", alive(pid))
    os.kill(pid, 9); os.waitpid(pid, 0)
    """)
    assert out.split("\n")[:4] == ["before True True", "during True", "after True", "next True"], out


def test_r2_CORR_157_3_refusals_and_failed_starts_leak_no_descriptor():
    # astra2: an enforced refusal (no launcher), and a start that fails
    # (posix_spawn of a missing program), 50 times each: the same
    # descriptors open after as before (no extension needed)
    out = ok(R2 + """
    led, cap = EXACT(1 << 30)
    rc._launcher = lambda: None
    os.environ["SAGEBRUSH_RASTER_ISOLATION"] = "enforced"
    n0 = fds()
    for _ in range(50):
        try:
            _sbraster.render(%r, 1.0, 40, 30, None, 72.0, [])
        except rc.SagebrushEngineError:
            pass
    print("enforced", fds() == n0)
    os.environ["SAGEBRUSH_RASTER_ISOLATION"] = "contained"
    bad = rc.Plan(None, 0, ["/nonexistent/python"], {})
    real = sys.executable
    sys.executable = "/nonexistent/python"
    for _ in range(50):
        try:
            rc.spawn(1 << 30, bad)
        except rc.SagebrushEngineError:
            pass
    sys.executable = real
    print("failed", fds() == n0)
    """ % SVG)
    assert out.split("\n")[:2] == ["enforced True", "failed True"], out


DIAG_CODE = """
import subprocess
rc._FORCE_THREADS = True
still = [sys.executable, "-c", "import time; time.sleep(30)"]
def echo(n):
    return [sys.executable, "-c", "import os, sys\\nn = int(sys.argv[1])\\nb = bytearray()\\nwhile len(b) < n:\\n d = os.read(0, n - len(b))\\n if not d: break\\n b += d\\nos.write(1, b)", str(n)]
def retry():
    c = rc.spawn(1 << 30, rc.Plan(None, 0, echo(5), dict(os.environ)))
    try:
        rc.write_all(c, [b"again"])
        back = bytearray(5)
        rc.read_into(c, back)
        return bytes(back) == b"again"
    finally:
        c.kill()
"""


def diag(body):
    # (R2's prelude, indented as R2 is, then the shared helpers and the body)
    return R2 + textwrap.indent(DIAG_CODE + textwrap.dedent(body), "    ")


def test_r2_CORR_157_4_sigalrm_diagnostic_portable():
    # daybreak2 (#157 r3's review): a real SIGALRM on the same blocked
    # 16 MiB write over the thread transport, in a run of its own, its
    # parts apart: scheduled deadline -> handler entry (the system's
    # delivery, and Python's running of the handler) and handler entry ->
    # the KeyboardInterrupt here.  Reported, not bounded: it must be
    # caught, and the cleanup and a retry work after it.  POSIX only.
    if sys.platform == "win32":
        print("  sigalrm: n/a (no SIGALRM on Windows)")
        return
    out = ok(diag("""
    t = {}
    def handler(*a):
        t["handler"] = time.monotonic()
        raise KeyboardInterrupt()
    c = rc.spawn(1 << 30, rc.Plan(None, 0, still, dict(os.environ)))
    prev = signal.signal(signal.SIGALRM, handler)
    try:
        t["due"] = time.monotonic() + 0.3
        signal.setitimer(signal.ITIMER_REAL, 0.3)
        try:
            rc.write_all(c, [bytes(16 << 20)])
            print("caught False (written)")
        except KeyboardInterrupt:
            t["catch"] = time.monotonic()
            print("caught True")
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, prev)
        c.kill()
    print("retry", retry())
    print("scheduled->handler %.4f handler->catch %.4f" % (t["handler"] - t["due"], t["catch"] - t["handler"]))
    """))
    lines = out.split("\n")
    assert lines[:2] == ["caught True", "retry True"], out
    print("  sigalrm: " + lines[2])


SIGINT_TRIALS = 5  # (the sample, declared before any run: every outcome is logged)


def test_r2_CORR_157_4_real_sigint_diagnostic_portable():
    # astra2 (#157 r3's review): a real SIGINT from an independent process,
    # SIGINT_TRIALS times, each on a fresh child blocked in the same 16 MiB
    # write: the sender takes its monotonic time just before os.kill (the
    # same system-wide clock), this process its own at the catch.  Every
    # trial's outcome and send->catch printed; reported, not bounded: each
    # must be caught, and the cleanup and a retry work after them.  POSIX
    # only (a console's Ctrl-C on Windows is not a signal another process
    # can send this way).
    if sys.platform == "win32":
        print("  sigint: n/a (no SIGINT from another process on Windows)")
        return
    out = ok(diag("""
    SEND = "import os, signal, sys, time\\ntime.sleep(0.3)\\nt = time.monotonic()\\nos.kill(int(sys.argv[1]), signal.SIGINT)\\nprint(repr(t), flush=True)"
    caught = 0
    for i in range(%d):
        c = rc.spawn(1 << 30, rc.Plan(None, 0, still, dict(os.environ)))
        sender = subprocess.Popen([sys.executable, "-I", "-c", SEND, str(os.getpid())], stdout=subprocess.PIPE, text=True)
        at = None
        try:
            try:
                rc.write_all(c, [bytes(16 << 20)])
                outcome = "written"
            except KeyboardInterrupt:
                at = time.monotonic()
                outcome = "caught"
        finally:
            c.kill()
        sent = float(sender.communicate()[0].strip())
        caught += outcome == "caught"
        print("trial %%d %%s send->catch %%s" %% (i + 1, outcome, "%%.4f" %% (at - sent) if at is not None else "-"))
    print("caught %%d of %%d" %% (caught, %d))
    print("retry", retry())
    """ % (SIGINT_TRIALS, SIGINT_TRIALS)))
    lines = out.split("\n")
    trials = [l for l in lines if l.startswith("trial ")]
    assert len(trials) == SIGINT_TRIALS and "caught %d of %d" % (SIGINT_TRIALS, SIGINT_TRIALS) in lines and "retry True" in lines, out
    for l in trials:
        print("  sigint: " + l)


WAIT_TRIALS = 3  # (the sample, declared before any run)


def test_r2_CORR_157_4_wait_timeline_diagnostic_portable():
    # DIAGNOSTICS ONLY (#157, the macOS 0.100 s gate failures, pypi
    # 40503768272): no behaviour change, nothing bounded; it only records,
    # in a run of its own, on every system:
    # - the timed waits themselves: 40 each of Event.wait, Lock.acquire,
    #   time.sleep and select at _WAKE (wall time: min, median, p90, max);
    # - the gated case's timeline, WAIT_TRIALS times: the Timer callback's
    #   moment just before and just after interrupt_main; every slice of
    #   _blocking's main-thread wait (Thread.join, wrapped here, so the
    #   module itself is unchanged): its start, end, length, and whether
    #   the helper was still alive; the slices after the request; the first
    #   return to Python after it; and the KeyboardInterrupt's catch.
    # Asserted only: each trial caught, and a retry works after them.
    out = ok(diag("""
    import select, statistics
    W = rc._WAKE
    def stats(name, f):
        d = []
        for _ in range(40):
            a = time.monotonic(); f(); d.append(time.monotonic() - a)
        d.sort()
        print("wait %%-8s x40 at %%.3f: min %%.4f median %%.4f p90 %%.4f max %%.4f" %% (name, W, d[0], statistics.median(d), d[35], d[-1]))
    ev, lk = threading.Event(), threading.Lock()
    lk.acquire()
    stats("event", lambda: ev.wait(W))
    stats("lock", lambda: lk.acquire(True, W))
    stats("sleep", lambda: time.sleep(W))
    if sys.platform != "win32":
        stats("select", lambda: select.select([], [], [], W))
    log = []
    join = threading.Thread.join
    def traced(self, timeout=None):
        a = time.monotonic()
        try:
            return join(self, timeout)
        finally:
            log.append((a, time.monotonic(), self.is_alive()))
    threading.Thread.join = traced
    caught = 0
    for i in range(%d):
        del log[:]
        fired = {}
        def fire():
            fired["before"] = time.monotonic()
            _thread.interrupt_main()
            fired["after"] = time.monotonic()
        c = rc.spawn(1 << 30, rc.Plan(None, 0, still, dict(os.environ)))
        threading.Timer(0.3, fire).start()
        at = None
        try:
            try:
                rc.write_all(c, [bytes(16 << 20)])
            except KeyboardInterrupt:
                at = time.monotonic()
        finally:
            c.kill()
        caught += at is not None
        b = fired.get("before")
        after = [s for s in log if b is not None and s[1] >= b]
        first = after[0][1] if after else None
        print("trial %%d caught %%s" %% (i + 1, at is not None))
        if b is not None and at is not None:
            print("  before->after interrupt_main %%.4f; before->first return to Python %%s; first return->catch %%s; before->catch %%.4f" %% (
                fired["after"] - b, "%%.4f" %% (first - b) if first else "-", "%%.4f" %% (at - first) if first else "-", at - b))
        print("  slices %%d, %%d ending after the request; lengths (ms): %%s" %% (len(log), len(after), " ".join("%%.1f%%s" %% ((e - a) * 1000, "" if alive else "(done)") for a, e, alive in log[-12:])))
        if after:
            print("  slices ending after the request (ms from 'before'): %%s" %% " ".join("[%%.1f..%%.1f]" %% ((a - b) * 1000, (e - b) * 1000) for a, e, alive in after))
    threading.Thread.join = join
    print("caught %%d of %%d" %% (caught, %d))
    print("retry", retry())
    """ % (WAIT_TRIALS, WAIT_TRIALS)))
    lines = out.split("\n")
    assert "caught %d of %d" % (WAIT_TRIALS, WAIT_TRIALS) in lines and "retry True" in lines, out
    for l in lines:
        if l.startswith(("wait ", "trial ", "  ")):
            print("  timeline: " + l)


# (after the diagnostics above, so that a failure here leaves their numbers in the log)
def test_r2_CORR_157_4_the_thread_transport_portable():
    # astra2: Windows's pipes driven by blocking calls on helper threads
    # (select takes sockets only there; no readv): forced here, the same
    # code: a round trip, back-pressure with Ctrl-C at once, and a retry
    # (portable: also run on Windows and macOS)
    # The echo child reads all it's sent before it answers, as the engine's
    # child does (raster_child.rs reads a whole request first): one that
    # wrote back as it read deadlocked on Windows's 4 KiB pipes, the parent
    # not reading until it had written everything (#157's train-10 run);
    # on Linux the pipes are made that small too, so it would here.
    out = ok(R2 + """
    import signal
    rc._FORCE_THREADS = True
    def echo(n):
        return [sys.executable, "-c", "import os, sys\\nn = int(sys.argv[1])\\nb = bytearray()\\nwhile len(b) < n:\\n d = os.read(0, n - len(b))\\n if not d: break\\n b += d\\nos.write(1, b)", str(n)]
    def small_pipes(c):
        if sys.platform.startswith("linux"):
            import fcntl
            for fd in (c.wfd, c.rfd):
                fcntl.fcntl(fd, 1031, 4096)  # (F_SETPIPE_SZ: Windows's size)
    data = bytes(range(256)) * 64
    c = rc.spawn(1 << 30, rc.Plan(None, 0, echo(len(data)), dict(os.environ)))
    small_pipes(c)
    rc.write_all(c, [data[:8000], data[8000:]])
    back = bytearray(len(data))
    rc.read_into(c, back)
    print("echo", bytes(back) == data)
    c.kill()
    still = [sys.executable, "-c", "import time; time.sleep(30)"]
    c = rc.spawn(1 << 30, rc.Plan(None, 0, still, dict(os.environ)))
    # (Ctrl-C's latency: from the interrupt to its KeyboardInterrupt here,
    # at most 100 ms: the wait wakes every 25 ms, William's Oct 25 bound.
    # The interrupt is interrupt_main from a Timer on every system, its
    # moment taken just before it.  r2 measured a SIGALRM from its scheduled
    # time instead, and macOS arm64 failed at 0.1011 s (pypi 40501974415):
    # an unseparated scheduled-deadline/delivery/handling delay, cause
    # unresolved; the two real-signal diagnostics below report the parts)
    fired = []
    def fire():
        fired.append(time.monotonic())
        _thread.interrupt_main()
    threading.Timer(0.3, fire).start()
    try:
        rc.write_all(c, [bytes(16 << 20)])
        print("written")
    except KeyboardInterrupt:
        latency = time.monotonic() - fired[0]
        print("interrupted", latency <= 0.100)
    c.kill()
    c = rc.spawn(1 << 30, rc.Plan(None, 0, echo(5), dict(os.environ)))
    rc.write_all(c, [b"again"])
    back = bytearray(5)
    rc.read_into(c, back)
    print("retry", bytes(back) == b"again")
    c.kill()
    print("latency timer %.4f (checked: <= 0.100)" % latency)
    """)
    assert out.split("\n")[:3] == ["echo True", "interrupted True", "retry True"], out
    # (in every run's log, on every system)
    print("  " + out.split("\n")[3])


def test_r2_CORR_157_4_render_and_decode_over_the_thread_transport_portable():
    # (the engine itself through the thread transport: Windows's default)
    out = ok(R2 + """
    rc._FORCE_THREADS = True
    led, cap = EXACT(1 << 30)
    png, missing = _sbraster.render(%r, 1.0, 40, 30, None, 72.0, [])
    w, h, ch, v = _sbraster.decode(png)
    print(png[:4] == b"\\x89PNG", (w, h, ch), not any(r.kind in ("host", "engine") for r in led.records))
    """ % SVG)
    assert out.split("\n")[0] == "True (40, 30, 4) True", out


def test_r2_CORR_157_5_the_launchers_footprint_is_in_the_minimum_need():
    # astra2: with no child, the call needs the pre-limit footprint bound
    # too: one byte short, refused before anything is launched; at it, the
    # child's grant covers it (no extension needed: the plan and the spawn
    # are fakes)
    out = ok(R2 + """
    PRE_B = 123456
    rc.launch_plan = lambda want: rc.Plan("/launcher", PRE_B, [], {})
    spawned = []
    class Stop(Exception):
        pass
    def spawn(limit, plan):
        spawned.append(limit)
        raise Stop()
    rc.spawn = spawn
    os.environ["SAGEBRUSH_RASTER_ISOLATION"] = "contained"
    host, need = render_need(%r, 40, 30)
    led, cap = EXACT(host + need + PRE_B - 1)
    try:
        _sbraster.render(%r, 1.0, 40, 30, None, 72.0, [])
    except MemoryError:
        print("refused", spawned == [])
    led, cap = EXACT(host + need + PRE_B)
    try:
        _sbraster.render(%r, 1.0, 40, 30, None, 72.0, [])
    except Stop:
        print("launched", spawned == [need + PRE_B], led.held() == 0)
    """ % (SVG, SVG, SVG))
    assert out.split("\n")[:2] == ["refused True", "launched True True"], out


def test_r2_CORR_157_6_render_refuses_untrackable_outputs_decode_follows_its_buffer():
    # astra2 and daybreak2 (option a): D0 blind, the override supplying F0:
    # render refuses, typed and not a memory error, before anything of the
    # request is computed or a child started; decode works, its charge
    # following the buffer through a reshape; released when the last owner
    # goes, and the next call admitted (no extension needed: in-process fake)
    out = ok(R2 + """
    fake_in_process()
    led, cap = EXACT(None, environ={"SAGEBRUSH_MEMORY_BYTES": str(1 << 20)})
    counted = []
    real_len = _sbraster._utf8_len
    _sbraster._utf8_len = lambda s: counted.append(1) or real_len(s)
    try:
        _sbraster.render(%r, 1.0, 40, 30, None, 72.0, [])
        print("drawn")
    except _sbraster.UntrackedOutput as e:
        print("refused", not isinstance(e, MemoryError), counted == [], FAKE.calls == [], "SAGEBRUSH_MEMORY_BYTES" in str(e))
    _sbraster._utf8_len = real_len
    png = b"\\x89PNG\\r\\n\\x1a\\n" + b"\\0\\0\\0\\rIHDR" + struct.pack(">II", 3, 2) + bytes([8, 0, 0, 0, 0]) + bytes(4)
    w, h, ch, arr = _sbraster.decode(png)
    held = led.held()
    view = arr.reshape((h, w))
    del arr
    gc.collect()
    led.rebase()
    print("kept", held > 0 and led.held() == held)
    del view
    gc.collect()
    led.rebase()
    print("released", led.held() == 0)
    w, h, ch, arr = _sbraster.decode(png)
    print("again", arr.shape == (6,))
    """ % SVG, env={"SAGEBRUSH_RASTER_ISOLATION": "in-process"})
    assert out.split("\n")[:4] == ["refused True True True True", "kept True", "released True", "again True"], out


def test_r2_observable_sessions_still_return_plain_bytes():
    # (the refusal is only for the unobservable case)
    out = ok(R2 + """
    led, cap = EXACT(1 << 30)
    png, missing = _sbraster.render(%r, 1.0, 40, 30, None, 72.0, [])
    print(type(png) is bytes, isinstance(missing, str))
    """ % SVG)
    assert out.split("\n")[0] == "True True", out


def test_r2_the_host_reservation_covers_what_the_parent_allocates():
    # (r8 section 2.5, measured: the parent's traced peak during a render
    # and a decode within the host reservation the call made)
    out = ok(R2 + """
    led, cap = EXACT(1 << 30)
    svg = '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300">' + '<rect x="1" y="1" width="9" height="9"/>' * 2000 + '</svg>'
    # (warmed: the child started, NumPy imported; neither is a call's)
    _sbraster.decode(_sbraster.render(svg, 1.0, 400, 300, None, 72.0, [("Software", "sagebrush")])[0])
    seen = []
    def look():
        seen.append(sum(r.bytes for r in led.records if r.kind == "host"))
    _sbraster._after_reply = look
    tracemalloc.start()
    base = tracemalloc.get_traced_memory()[0]
    tracemalloc.reset_peak()
    png, _ = _sbraster.render(svg, 1.0, 400, 300, None, 72.0, [("Software", "sagebrush")])
    peak = tracemalloc.get_traced_memory()[1] - base
    print("render", peak <= seen[-1], peak, seen[-1])
    base = tracemalloc.get_traced_memory()[0]
    tracemalloc.reset_peak()
    w, h, ch, arr = _sbraster.decode(png)
    peak = tracemalloc.get_traced_memory()[1] - base
    print("decode", peak <= seen[-1], peak, seen[-1])
    """)
    lines = out.split("\n")
    assert lines[0].startswith("render True") and lines[1].startswith("decode True"), out

if __name__ == "__main__":
    names = [n for n in list(globals()) if n.startswith("test_")]
    if sys.platform != "linux":
        # (macOS and Windows: the contained mode's tests (the launcher, /proc
        # and prlimit are Linux's))
        names = [n for n in names if n.endswith("_portable")]
    if "-k" in sys.argv:
        names = [n for n in names if sys.argv[sys.argv.index("-k") + 1] in n]
    for n in names:
        globals()[n]()
        print("ok", n)
