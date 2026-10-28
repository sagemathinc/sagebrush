"""Ctrl-C PR B (plan-ctrlc-fixes r2 §3a, r3-r5 notes): the worker's native
request loop, one terminal reply per admitted request, and targeted
interrupts that never reach a newer request.

    python3 engine/py/test_ctrlc_native.py

Each case counts admitted requests against terminal replies (the worker's
_native._serve_stats), checks the side effect of the user's code against the
phase the interrupt hit (a counter whose increment is the code's first
statement: 0 before it, <= 1 during, = 1 after), that the parent got its
answer promptly (no restart, the generation unchanged) and that the namespace
is kept.

- Every build: the lifecycle, targeted interrupts of a Python loop and of
  time.sleep within the Stop bound (250 ms from the notification to the
  reply), their stale-target variants, an external SIGINT busy and idle,
  injections through the worker's own module (setup, the fallback, encode),
  the parent's re-target, and real terminal Ctrl-C through a pty (POSIX).
- A test-hooks build (_native._serve_test): the admission injection and
  astra's gate tests (stale ids read before any arm; a late wake).
- Native engine calls (factor, a GF(p) echelon), targeted and stale: they
  need @sagebrush-sage2's guarded Stop window (_native._serve_native_stop()),
  and are skipped until it lands.

On Windows interrupts are Ctrl-Break, untargeted, as before: the stale-target
assertions are expected to fail there (CORR-CTRLC-3-Windows), recorded as
XFAIL; everything else must hold.
"""

import json
import os
import signal
import sys
import time

import sagebrush.session as S
from sagebrush import _native

WINDOWS = os.name == "nt"
HOOKS = hasattr(_native, "_serve_test")
NATIVE_STOP = getattr(_native, "_serve_native_stop", lambda: False)()
STOP_S = 0.25  # (the Stop bound: a targeted interrupt's reply within this of the notification)
failed = []


def check(cond, what, xfail_windows=False):
    if xfail_windows and WINDOWS:
        print(("XFAIL (CORR-CTRLC-3-Windows) " if not cond else "XPASS ") + what)
        return
    print(("ok   " if cond else "FAIL ") + what)
    if not cond:
        failed.append(what)


def stats(s):
    r = s.run("import sagebrush._native as _n; _n._serve_stats()", mode="python")
    return eval(r["result"]) if r["result"] else None


def counts_match(s, what):
    # (the stats request itself is admitted and running: replied lags it by one)
    st = stats(s)
    check(st is not None and st["admitted"] == st["replied"] + 1, "%s: admitted = replied (%r)" % (what, st))
    return st


def submit(s, code):
    rid = s._send(code, "python", False, False)
    return rid


def started(s, path, timeout=10):
    end = time.monotonic() + timeout
    while not os.path.exists(path):
        if time.monotonic() > end:
            return False
        time.sleep(0.005)
    return True


def tmpfile(name):
    import tempfile
    d = tempfile.mkdtemp(prefix="sb-ctrlc-b-")
    return os.path.join(d, name).replace("\\", "/")


def running(s, body, flag):
    """Submit `n += 1; open(flag); body`, wait until it has started: its id."""
    rid = submit(s, "n += 1\nopen(%r, 'w').close()\n%s" % (flag, body))
    assert started(s, flag), "the request never started"
    return rid


# ------------------------------------------------------------------ lifecycle

def test_lifecycle():
    s = S.Session()
    try:
        check(s.run("n = 0; n", mode="python")["result"] == "0", "lifecycle: a first request")
        r = s.run("print('hi'); n += 1; n", mode="python")
        check(r["result"] == "1" and r["stdout"] == "hi\n" and r["id"] == s.last_id, "lifecycle: result, output and id")
        r = s.run("1/0", mode="python")
        check(r["error_info"]["type"] == "exception" and r["id"] == s.last_id, "lifecycle: an error is its request's reply")
        r = s.run("{", mode="python")
        check(r["error_info"]["type"] == "syntax", "lifecycle: a syntax error")
        r = s.run("raise SystemExit(3)", mode="python")
        check(r["error_info"]["exception"] == "SystemExit" and s.alive(), "lifecycle: SystemExit leaves the session alive")
        r = s.run("import sys; sys.stdin.read()", mode="python")
        check(r["result"] == "''" and s.alive(), "lifecycle: the user's stdin is empty, never the protocol")
        s.run("only_here = 1", mode="python")
        r = s.run("only_here", mode="python", isolated=True)
        check((r["error_info"] or {}).get("exception") == "NameError", "lifecycle: isolated (%r)" % (r["error_info"],))
        counts_match(s, "lifecycle")
    finally:
        s.close()


# ------------------------------------------------------------------ targeted interrupts, and their stale variants

WORKLOADS = [
    ("a Python loop", "while True:\n    pass"),
    ("time.sleep(60)", "import time\ntime.sleep(60)"),
]


def targeted(name, body, native=False):
    s = S.Session()
    try:
        s.run("n = 0; keep = 'kept'", mode="python")
        gen = s.generation
        flag = tmpfile("started")
        rid = running(s, body, flag)
        t0 = time.monotonic()
        s.interrupt(rid)
        r = s._get(rid, 30)
        dt = time.monotonic() - t0
        check(bool(r) and r["error_info"]["type"] == "interrupted" and r["id"] == rid, "%s, targeted: its interrupted reply" % name)
        check(dt <= STOP_S, "%s, targeted: within the Stop bound (%.0f ms)" % (name, dt * 1000))
        after = s.run("(n, keep)", mode="python")
        check(after["result"] == "(1, 'kept')" and s.generation == gen and not after["restarted"],
              "%s, targeted: once, the namespace kept, no restart (%s)" % (name, after["result"]))
        counts_match(s, name + ", targeted")
    finally:
        s.close()


def stale(name, body, native=False):
    """R committed; R+1 runs `body` for a while (until a file appears); an
    interrupt for R, twice, must not end R+1."""
    s = S.Session()
    try:
        s.run("n = 0", mode="python")
        old = s.last_id
        stop = tmpfile("stop")
        flag = tmpfile("started")
        # (the workload, bounded: it ends by itself once `stop` exists)
        bounded = {
            "a Python loop": "import os\nwhile not os.path.exists(%r):\n    pass" % stop,
            "time.sleep(60)": "import os, time\nwhile not os.path.exists(%r):\n    time.sleep(0.05)" % stop,
        }.get(name, body)
        rid = running(s, bounded, flag)
        s.interrupt(old)
        s.interrupt(old)
        time.sleep(0.5)
        open(stop, "w").close()
        r = s._get(rid, 30)
        check(bool(r) and r["error_info"] is None and r["id"] == rid, "%s, stale target: R+1 finishes normally" % name, xfail_windows=True)
        check(s.run("n", mode="python")["result"] == "1", "%s, stale target: once" % name)
        st = counts_match(s, name + ", stale target")
        if st is not None and not WINDOWS:
            check(st["stale"] >= 2 and st["woken"] == 0, "%s, stale target: both ids armed nothing, nothing woken (%r)" % (name, st))
    finally:
        s.close()


# ------------------------------------------------------------------ external SIGINT

def test_external_sigint():
    if WINDOWS:
        print("skip external SIGINT (POSIX: kill -INT)")
        return
    s = S.Session()
    try:
        s.run("n = 0", mode="python")
        os.kill(s.proc.pid, signal.SIGINT)  # (idle: for nothing)
        time.sleep(0.2)
        r = s.run("n", mode="python")
        check(r["result"] == "0" and s.alive(), "external SIGINT, idle: ignored, the next request its own")
        flag = tmpfile("started")
        rid = running(s, "while True:\n    pass", flag)
        os.kill(s.proc.pid, signal.SIGINT)
        r = s._get(rid, 10)
        check(bool(r) and r["error_info"]["type"] == "interrupted" and r["id"] == rid, "external SIGINT, busy: interrupts the running request")
        check(s.run("n", mode="python")["result"] == "1", "external SIGINT: once, kept")
        counts_match(s, "external SIGINT")
    finally:
        s.close()


# ------------------------------------------------------------------ injections, through the worker's own module

def inject(s, code):
    # (the worker runs as __main__: its module's globals are the loop's)
    r = s.run("import sys\n_W = sys.modules['__main__']\n" + code, mode="python")
    assert r["error"] is None, r


def test_injections():
    s = S.Session()
    try:
        s.run("n = 0", mode="python")
        gen = s.generation
        # setup: a KeyboardInterrupt before the user's code
        inject(s, "_real_reset = _W._reset_run_state\n"
                  "def _once():\n    _W._reset_run_state = _real_reset\n    raise KeyboardInterrupt\n"
                  "_W._reset_run_state = _once")
        r = s.run("n += 1; n", mode="python")
        check(r["error_info"]["type"] == "interrupted" and r["id"] == s.last_id, "injection in setup: its interrupted reply")
        check(s.run("n", mode="python")["result"] == "0", "injection in setup: no side effect")
        # a handler escape: the user's own except re-raising
        r = s.run("n += 1\ntry:\n    raise KeyboardInterrupt\nexcept KeyboardInterrupt:\n    raise", mode="python")
        check(r["error_info"]["type"] == "interrupted" and s.run("n", mode="python")["result"] == "1", "a handler escape: one reply, once")
        # past the user's code: the run's own KeyboardInterrupt, after it, out of run_request
        # (the injecting request's own reply calls text() first: skipped)
        inject(s, "_real_text = _W._Capture.text\n_calls = [0]\n"
                  "def _once(self):\n    _calls[0] += 1\n    if _calls[0] == 2:\n        _W._Capture.text = _real_text\n        raise KeyboardInterrupt\n    return _real_text(self)\n"
                  "_W._Capture.text = _once")
        r = s.run("n += 1; print('kept output'); n", mode="python")
        check(r["error_info"]["type"] == "interrupted" and s.run("n", mode="python")["result"] == "2",
              "an escape after the user's code: the fallback's reply, the code once")
        check("kept output" in r["stdout"], "an escape after the user's code: the fallback keeps the run's output (%r)" % r["stdout"][:80])
        # an interrupt as the run's end hold closes, its reply already recorded: the finished reply is kept
        r = s.run("import sys\nsys.modules['__main__']._HOLD.pending = True\nn += 1\nn", mode="python")
        check(r["result"] == "3" and r["error"] is None, "an interrupt after the reply is recorded: the finished reply, whole (%r, %r)" % (r["result"], r["error"]))
        s.run("n -= 1", mode="python")
        # the fallback itself interrupted, on its first call (run_request's
        # except calls _interrupted first, and its KeyboardInterrupt escapes
        # to the fallback, whose own first call raises too)
        inject(s, "_real_int = _W._interrupted\n_calls = [0]\n"
                  "def _twice(e):\n    _calls[0] += 1\n    if _calls[0] == 2:\n        _W._interrupted = _real_int\n    raise KeyboardInterrupt\n"
                  "_W._interrupted = _twice\n"
                  "_real_reset = _W._reset_run_state\n"
                  "def _kick():\n    _W._reset_run_state = _real_reset\n    raise KeyboardInterrupt\n"
                  "_W._reset_run_state = _kick")
        r = s.run("n += 1; n", mode="python")
        check(r["error_info"]["type"] == "interrupted" and s.run("n", mode="python")["result"] == "2", "the fallback interrupted: called again, one reply")
        # encode interrupted on its first call
        inject(s, "import json as _j\n_real_dumps = _j.dumps\n"
                  "def _once(o, *a, **k):\n"
                  "    if isinstance(o, dict) and o.get('result') == '3':\n"
                  "        _j.dumps = _real_dumps\n        raise KeyboardInterrupt\n"
                  "    return _real_dumps(o, *a, **k)\n"
                  "_j.dumps = _once")
        r = s.run("n += 1; n", mode="python")
        check(r["result"] == "3" and r["error"] is None, "encode interrupted: encoded again, the reply whole (%r)" % (r["result"],))
        check(s.generation == gen and s.alive(), "injections: no restart")
        counts_match(s, "injections")
    finally:
        s.close()


def test_post_commit_target():
    """An interrupt for a request just answered (the time limit's race)
    interrupts nothing: the next request is its own."""
    s = S.Session()
    try:
        s.run("n = 0", mode="python")
        s.interrupt(s.last_id)
        r = s.run("import time; time.sleep(0.3); n += 1; n", mode="python")
        check(r["result"] == "1" and r["error"] is None, "after the commit: the next request is not interrupted", xfail_windows=True)
    finally:
        s.close()


def test_retarget():
    """Session.run's own KeyboardInterrupt (its terminal's Ctrl-C) re-targets
    the request, so the worker ends it even if it lost the signal."""
    s = S.Session()
    try:
        s.run("n = 0", mode="python")
        real = s._get
        calls = []

        def interrupted_get(rid, timeout):
            calls.append(rid)
            if len(calls) == 1:
                started(s, flag)
                raise KeyboardInterrupt  # (the parent's Ctrl-C; the worker never saw one)
            return real(rid, timeout)

        flag = tmpfile("started")
        s._get = interrupted_get
        try:
            s.run("n += 1\nopen(%r, 'w').close()\nwhile True:\n    pass" % flag, mode="python")
            got = None
        except KeyboardInterrupt as e:
            got = e
        rid = calls[0]
        r = real(rid, 10)
        check(got is not None and bool(r) and r["error_info"]["type"] == "interrupted" and r["id"] == rid,
              "re-target: the parent's KeyboardInterrupt ends the worker's request")
        del s._get
        check(s.run("n", mode="python")["result"] == "1", "re-target: the next run is its own, the namespace kept")
    finally:
        s.close()


# ------------------------------------------------------------------ a real terminal Ctrl-C (pty)

PTY_CHILD = r'''
import json, os, sys, time
import sagebrush.session as S
flag, stale = sys.argv[1], sys.argv[2] == "stale"
s = S.Session()
s.run("n = 0; keep = 'kept'", mode="python")
gen = s.generation
if stale:
    # (run 1 interrupted by its own id, the notification left behind)
    s.interrupt(s.last_id)
out = {}
try:
    s.run("n += 1\nopen(%r, 'w').close()\nwhile True:\n    pass" % flag, mode="python", timeout=30)
    out["parent"] = "no interrupt"
except KeyboardInterrupt:
    out["parent"] = "KeyboardInterrupt"
rid = s.last_id
r = s._get(rid, 10)
out["reply"] = r and (r["id"] == rid and r["error_info"]["type"])
t0 = time.monotonic()
r2 = s.run("(n, keep)", mode="python")
out.update(next=r2["result"], restarted=r2["restarted"], gen=s.generation == gen, prompt=time.monotonic() - t0 < 5)
print("RESULT " + json.dumps(out), flush=True)
s.close()
'''


def pty_case(stale):  # noqa: F811 (the parameter shadows the stale() case)
    import pty
    flag = tmpfile("started")
    child = tmpfile("child.py")
    open(child, "w").write(PTY_CHILD)
    pid, fd = pty.fork()
    if pid == 0:
        os.execv(sys.executable, [sys.executable, child, flag, "stale" if stale else "fresh"])
    buf = b""
    try:
        assert started(None, flag, 60), "the child's run never started"
        time.sleep(0.1)
        os.write(fd, b"\x03")  # (the line discipline's SIGINT, to the foreground group: parent and worker)
        end = time.monotonic() + 60
        while b"RESULT " not in buf or not buf.rstrip().endswith(b"}"):
            if time.monotonic() > end:
                break
            try:
                chunk = os.read(fd, 4096)
            except OSError:
                break
            if not chunk:
                break
            buf += chunk
    finally:
        os.waitpid(pid, 0)
    # (the terminal echoes ^C with no newline: the line may start with it)
    line = [x[x.index("RESULT ") + 7:] for x in buf.decode("utf-8", "replace").splitlines() if "RESULT " in x]
    out = json.loads(line[0]) if line else {}
    if not out:
        print("    (the child's terminal, last 1500 bytes: %r)" % buf[-1500:])
    what = "pty Ctrl-C %s" % ("after a stale target" if stale else "before any target")
    check(out.get("parent") == "KeyboardInterrupt", "%s: the parent sees KeyboardInterrupt (%r)" % (what, out))
    check(out.get("reply") == "interrupted", "%s: one interrupted reply with its id" % what)
    check(out.get("next") == "(1, 'kept')" and out.get("restarted") is False and out.get("gen") and out.get("prompt"),
          "%s: the next run is its own, promptly, no restart, the namespace kept" % what)


# ------------------------------------------------------------------ test-hooks builds: admission, and astra's gates

def hook(s, name, value):
    inject(s, "import sagebrush._native as _n\n_n._serve_test(%r, %d)" % (name, value))


def test_hooks():
    if not HOOKS:
        print("skip the admission and gate tests: they need a test-hooks build")
        return
    s = S.Session()
    try:
        s.run("n = 0", mode="python")
        hook(s, "admit_interrupt", 1)
        r = s.run("n += 1; n", mode="python")
        check(r["error_info"]["type"] == "interrupted" and s.run("n", mode="python")["result"] == "0",
              "an interrupt at admission: its interrupted reply, no side effect")
        if WINDOWS:
            return
        # (gate 1: R committed, R+1 running; interrupt(R) twice, read before any arm)
        old = s.last_id
        before = stats(s)
        hook(s, "arm_delay_ms", 200)
        stop, flag = tmpfile("stop"), tmpfile("started")
        rid = running(s, "import os, time\nwhile not os.path.exists(%r):\n    time.sleep(0.01)" % stop, flag)
        s.interrupt(old)
        s.interrupt(old)
        time.sleep(0.8)
        open(stop, "w").close()
        r = s._get(rid, 30)
        hook(s, "arm_delay_ms", 0)
        st = stats(s)
        check(bool(r) and r["error_info"] is None and s.run("n", mode="python")["result"] == "1",
              "gate: stale ids read before any arm: R+1 finishes normally, once")
        check(st["stale"] - before["stale"] >= 2 and st["woken"] == before["woken"], "gate: both arms failed, nothing woken (%r)" % st)
        # (gate 2, the late wake: arm(R+1) succeeds, R+1 commits, R+2 is admitted, then the wake)
        before = stats(s)
        hook(s, "wake_delay_ms", 400)
        flag = tmpfile("started")
        rid = running(s, "import time\ntime.sleep(0.1)", flag)
        s.interrupt(rid)
        r1 = s._get(rid, 10)
        flag2 = tmpfile("started")
        rid2 = running(s, "import time\ntime.sleep(1.0)\n'R+2'", flag2)
        r2 = s._get(rid2, 10)
        hook(s, "wake_delay_ms", 0)
        st = stats(s)
        check(bool(r1) and r1["error_info"] is None, "late wake: R+1 finished before its wake")
        check(bool(r2) and r2["result"] == "'R+2'" and r2["error"] is None, "late wake: R+2 is not interrupted")
        check(st["woken"] - before["woken"] == 1 and st["late"] > before["late"], "late wake: woken once, taken as late (%r)" % st)
        counts_match(s, "hooks")
    finally:
        s.close()


# ------------------------------------------------------------------ native engine calls (after the guarded Stop window)

NATIVE = [
    # (test_interrupt.py's: a 60-digit semiprime, far beyond 2 s)
    ("factor", "n += 1\nfrom sagebrush import nf\nnf.factor_integer(100000000000000000000000012349 * 300000000000000000000000000823)"),
    ("a GF(p) echelon", "n += 1\nF = GF(next_prime(2^62)); A = random_matrix(F, 1024, 1024); A.echelon_form().rank()"),
]


def test_native():
    if not NATIVE_STOP:
        print("skip the native Stop tests (factor, GF(p) echelon): they need @sagebrush-sage2's guarded Stop window")
        return
    for name, code in NATIVE:
        s = S.Session()
        try:
            s.run("n = 0", mode="python")
            rid = s._send(code, "sage", False, False)
            time.sleep(0.5)  # (inside the engine call)
            t0 = time.monotonic()
            s.interrupt(rid)
            r = s._get(rid, 30)
            dt = time.monotonic() - t0
            check(bool(r) and r["error_info"]["type"] == "interrupted", "%s, targeted: interrupted" % name)
            check(dt <= STOP_S, "%s, targeted: within the Stop bound (%.0f ms)" % (name, dt * 1000))
            check(s.run("n", mode="python")["result"] == "1", "%s: once, kept" % name)
            # (stale: an earlier id's interrupt during the call ends nothing)
            old = s.last_id
            rid = s._send(code, "sage", False, False)
            time.sleep(0.5)
            s.interrupt(old)
            r = s._get(rid, 600)
            check(bool(r) and r["error"] is None, "%s, stale target: finishes normally" % name, xfail_windows=True)
        finally:
            s.close()


SVG = "class _Svg:\n    def _repr_svg_(self):\n        return '<svg>b1-marker</svg>'\n_Svg()"


def test_displays_own():
    """astra's CORR-CTRLC-B-1: a request stopped before its own state exists
    (at admission, or in its JSON decoding) has no displays, never the
    previous request's."""
    s = S.Session()
    try:
        s.run("n = 0", mode="python")
        # (the JSON decoding interrupted once, for the request carrying B1JSON)
        inject(s, "import json as _j\n_real_loads = _j.loads\n"
                  "def _once(t, *a, **k):\n"
                  "    if 'B1JSON' in t:\n"
                  "        _j.loads = _real_loads\n        raise KeyboardInterrupt\n"
                  "    return _real_loads(t, *a, **k)\n"
                  "_j.loads = _once")
        r0 = s.run(SVG, mode="python")
        check(any("b1-marker" in d[1] for d in r0["displays"]), "B-1: the display is its own request's (%r)" % (r0["displays"],))
        r1 = s.run("n += 1  # B1JSON", mode="python")
        check(r1["error_info"]["type"] == "interrupted" and r1["displays"] == [] and r1["id"] == s.last_id,
              "B-1: interrupted in its JSON decoding: no displays, not the previous request's (%r)" % (r1["displays"],))
        if HOOKS:
            r0 = s.run("import sagebrush._native as _n\n_n._serve_test('admit_interrupt', 1)\n" + SVG, mode="python")
            check(any("b1-marker" in d[1] for d in r0["displays"]), "B-1: the hook's request has its display")
            rid = submit(s, "n += 1")
            r1 = s._get(rid, 10)
            check(bool(r1) and r1["id"] == rid and r1["error_info"]["type"] == "interrupted" and r1["displays"] == [],
                  "B-1: interrupted at admission: its own id, no displays (%r)" % ((r1 or {}).get("displays"),))
            time.sleep(0.2)
            check(s.replies.empty(), "B-1: exactly one terminal reply")
        check(s.run("n", mode="python")["result"] == "0", "B-1: no side effect, the namespace kept")
        counts_match(s, "B-1")
    finally:
        s.close()


def test_write_faults():
    """astra's CORR-CTRLC-B-2 (a test-hooks build): a terminal reply that
    can't be written whole is not committed, and no next request is read:
    the worker ends, the parent sees its end, not a reply."""
    if not HOOKS:
        print("skip the write-fault controls: they need a test-hooks build")
        return
    for fault, what in ((1, "the reader gone before any byte"), (2, "part written, then an error")):
        s = S.Session()
        try:
            rid = submit(s, "import sagebrush._native as _n\n_n._serve_test('write_fault', %d)\n7" % fault)
            r = s._get(rid, 15)
            check(r is None, "B-2, %s: no complete reply, the worker's end (%r)" % (what, r))
            later = submit_safe(s, "1")
            check(later is None or s._get(later, 3) in (None, False), "B-2, %s: no next request admitted" % what)
            code = s.proc.wait(10)
            check(code is not None, "B-2, %s: the worker ended (exit %r)" % (what, code))
        finally:
            s.close()


def submit_safe(s, code):
    try:
        return submit(s, code)
    except OSError:
        return None


def test_held_parse():
    """daybreak2's PR B r1 #1 (a test-hooks build): a request is admitted
    as soon as its line is complete, so a targeted interrupt that arrives
    while the rest is still to be handled (the line held there) reaches it."""
    if not HOOKS or WINDOWS:
        print("skip the held-parse control: it needs a test-hooks build (POSIX)")
        return
    s = S.Session()
    try:
        s.run("n = 0", mode="python")
        hook(s, "hold_ms", 600)
        t0 = time.monotonic()
        rid = submit(s, "n += 1\nimport time\ntime.sleep(10)")
        time.sleep(0.15)  # (inside the hold: admitted, not yet run)
        s.interrupt(rid)
        r = s._get(rid, 15)
        dt = time.monotonic() - t0
        check(bool(r) and r["error_info"]["type"] == "interrupted" and dt < 3, "held parse: the targeted interrupt reaches the admitted request (%.1f s)" % dt)
        check(s.run("n", mode="python")["result"] == "0", "held parse: stopped before its code")
    finally:
        s.close()


def test_short_writes():
    """daybreak2's PR B r4 #2 (a test-hooks build): a reply is written from
    the encoded str's own UTF-8, the GIL released; the str is kept alive and
    its view stays valid across a write in many short parts while another
    thread runs and allocates.  A 1 MB result in 4 KiB parts, 0.2 ms apart."""
    if not HOOKS:
        print("skip the short-write control: it needs a test-hooks build")
        return
    s = S.Session()
    try:
        s.run("import threading\n_stop = [False]\n"
              "def _churn():\n    while not _stop[0]:\n        _junk = [str(i) * 40 for i in range(2000)]\n"
              "threading.Thread(target=_churn, daemon=True).start()", mode="python")
        hook(s, "short_write", 4096)
        t0 = time.monotonic()
        r = s.run("'ab' * 500000", mode="python")
        dt = time.monotonic() - t0
        hook(s, "short_write", 0)
        check(r["result"] == repr("ab" * 500000) and r["error"] is None,
              "short writes: the 1 MB reply exact across its parts (%.2f s, %s chars)" % (dt, len(r["result"] or "")))
        check(dt > 0.04, "short writes: the reply was written in parts (%.2f s)" % dt)
        s.run("_stop[0] = True", mode="python")
        counts_match(s, "short writes")
    finally:
        s.close()


def test_input_release():
    """daybreak2's PR B r5 semantic memory gate, with the request reader's
    arena (the Windows arena design r2), F2 (PR B fix design r2c) and F3 (PR B
    F3 design r1): no consumed long-line allocation straddles run_request.
    Every long request, 1, 2, 8 and 32 MiB, and each of a burst of 20 1 MiB
    requests back to back, reads the reader's stats from inside its own run
    and finds exactly the arena, one more early release each, on every
    platform.  An idle half second more than the 250 ms limit then finds
    nothing left to let go.  Counters are deltas from the session's
    baseline."""
    s = S.Session()
    try:
        st0 = stats(s)
        check(st0["input_arena"] >= 2 * st0["read_chunk"], "input release: the request reader's arena (%r)" % (st0,))
        early = [st0["input_early_releases"]]

        def inside(size, what):
            code = "x = '" + "a" * size + "'\nimport sagebrush._native as _n\n_st = _n._serve_stats()\n(len(x), _st['input_capacity'], _st['input_arena'], _st['input_early_releases'])"
            r = s.run(code, mode="python")
            check(r["error"] is None, "input release: the %s request ran (%r)" % (what, r["error"]))
            n, cap, arena, e = eval(r["result"])
            check(n == size, "input release: the %s request is exact (%r)" % (what, n))
            check(cap == arena and e == early[0] + 1,
                  "input release: the %s request's buffer let go before it ran (capacity %r, arena %r, early %r, before %r)" % (what, cap, arena, e, early[0]))
            early[0] = e

        for mib in (1, 2, 8, 32):
            inside(mib << 20, "%d MiB" % mib)
        for k in range(20):
            inside(1 << 20, "burst 1 MiB #%d" % (k + 1))
        time.sleep(0.6)
        st2 = stats(s)
        check(st2["input_capacity"] == st2["input_arena"] and st2["input_releases"] == st0["input_releases"],
              "input release: after the idle limit, nothing left to let go, the arena alone (%r)" % (st2,))
        check(st2["input_early_releases"] == st0["input_early_releases"] + 24, "input release: one early release per long request (%r)" % (st2,))
        counts_match(s, "input release")
    finally:
        s.close()


def test_released():
    """daybreak2's PR B r1 #2: an answered request's state is let go: no
    earlier _Run stays, and the capture kept for its streams holds no text."""
    s = S.Session()
    try:
        s.run("print('x' * 2000000)", mode="python")
        r = s.run("import gc\n_runs = [o for o in gc.get_objects() if type(o).__name__ == '_Run']\n"
                  "_caps = [o for o in gc.get_objects() if type(o).__name__ == '_Capture' and o.sealed]\n"
                  "(len(_runs), max((len(c.head) + c.tail_n for c in _caps), default=0))", mode="python")
        check(r["result"] == "(1, 0)", "released: one _Run (this request's), the kept capture empty (%s)" % r["result"])
        # (a stream kept past its run, as a thread that outlives it would keep
        # it: its capture stays alive, so only its release lets the text go)
        s.run("import sys\n_kept = sys.stdout\nprint('y' * 2000000)", mode="python")
        r = s.run("import gc\n_caps = [o for o in gc.get_objects() if type(o).__name__ == '_Capture' and o.sealed]\n"
                  "(any(c is _kept.capture for c in _caps), max((len(c.head) + c.tail_n for c in _caps), default=0))", mode="python")
        check(r["result"] == "(True, 0)", "released: a kept stream's capture holds no text (%s)" % r["result"])
    finally:
        s.close()


def test_stale_state():
    """The fallback's serial check (a test-hooks build): a reply that couldn't
    be encoded leaves its request's state recorded; the next request,
    interrupted at admission, gets its own interrupted reply, never that
    earlier request's."""
    if not HOOKS:
        print("skip the stale-state control: it needs a test-hooks build")
        return
    s = S.Session()
    try:
        s.run("n = 0", mode="python")
        r0 = s.run("class _Bad:\n    def _repr_svg_(self):\n        return {1}\n"
                   "import sagebrush._native as _n\n_n._serve_test('admit_interrupt', 1)\n_Bad()", mode="python")
        check(r0["error_info"]["type"] == "session", "stale state: the unencodable reply is the session's (%r)" % (r0["error"],))
        rid = submit(s, "n += 1")
        r1 = s._get(rid, 10)
        check(bool(r1) and r1["id"] == rid and r1["error_info"]["type"] == "interrupted" and r1["displays"] == [],
              "stale state: interrupted at admission, its own reply, not the earlier request's (%r)" % ((r1 or {}).get("error"),))
        check(s.run("n", mode="python")["result"] == "0", "stale state: no side effect")
        counts_match(s, "stale state")
    finally:
        s.close()


def case(f, *a):
    # (a case that raises is a failure, and the rest still run: the fail-first control runs this file on PR A's worker)
    try:
        f(*a)
    except Exception as e:
        check(False, "%s%r raised %s: %s" % (f.__name__, a, type(e).__name__, e))


if __name__ == "__main__":
    case(test_lifecycle)
    for name, body in WORKLOADS:
        case(targeted, name, body)
        case(stale, name, body)
    case(test_external_sigint)
    case(test_injections)
    case(test_post_commit_target)
    case(test_retarget)
    if not WINDOWS:
        case(pty_case, False)
        case(pty_case, True)
    case(test_hooks)
    case(test_displays_own)
    case(test_write_faults)
    case(test_held_parse)
    case(test_released)
    case(test_stale_state)
    case(test_short_writes)
    case(test_input_release)
    case(test_native)
    if failed:
        print("ctrlc native: %d FAILED" % len(failed))
        sys.exit(1)
    print("ctrlc native: all ok")
