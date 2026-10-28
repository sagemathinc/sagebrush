"""Stop during dense integer products through the public route (CPython),
within the 250 ms Stop bound (Unix; skipped on Windows).

  python engine/py/test_interrupt_matmul.py [--set big|small] [--quick]      real SIGINT
  python engine/py/test_interrupt_matmul.py --targeted [--set big|small]     a test-hooks wheel

Real SIGINT (any wheel): for each shape (1 x K x 1, 1 x K x M, square, wide,
output-heavy, BigInt 300-digit) a child first runs the product
uninterrupted and reports its time T; a second child gets SIGINT at T / 2.
Checked: KeyboardInterrupt within 250 ms of the signal (monotonic clocks,
every wait bounded, a timed-out child killed), the child's exit status 0,
and the same interpreter's next product exactly "11".  T / 2 is scheduling
evidence, not proof of the phase the Stop landed in.

Targeted (a wheel built with the test-hooks feature): for each shape and
each phase (parse, zmat-scan, the dot, reply), the call is traced, a Stop is
armed at that phase's median check, and the public catch's latency is read
on the hooks' clock: from the Stop's request to the KeyboardInterrupt in
Python.  Checked: it landed in that phase, latency under 250 ms, the next
product exactly "11", the ledger's outstanding bytes back to their value
before.  Also printed: the Python-side transport's own intervals (the
request's json.dumps, the native call, the reply's json.loads), which no
engine check encloses."""

import json
import queue
import signal
import subprocess
import sys
import threading
import time

COMMON = r'''
import json, sys, time
from sagebrush import _native
from sagebrush._engine import call
shape, n = sys.argv[1], int(sys.argv[2])
def text(r, c, f):
    return ";".join(",".join(str(f(i, j)) for j in range(c)) for i in range(r))
if shape == "1xKx1":
    a, b = text(1, n, lambda i, j: 10**8 + j), text(n, 1, lambda i, j: 10**8 - i)
elif shape == "1xKxM":
    a, b = text(1, n, lambda i, j: j % 1000 + 1), text(n, 64, lambda i, j: (i * 64 + j) % 997)
elif shape == "square":
    a = b = text(n, n, lambda i, j: (i * 7919 + j * 104729) % 10**9)
elif shape == "wide":  # n x 32 times 32 x n
    a, b = text(n, 32, lambda i, j: (i * 31 + j) % 10**9), text(32, n, lambda i, j: (i + j * 17) % 10**9)
elif shape == "output-heavy":  # n x 1 times 1 x n
    a, b = text(n, 1, lambda i, j: 10**8 + i), text(1, n, lambda i, j: 10**8 + 7 * j)
elif shape == "big":  # 1 x n x 1, 300-digit entries
    a, b = text(1, n, lambda i, j: 10**299 + 7 * j), text(n, 1, lambda i, j: 10**299 - 3 * i)
elif shape == "big-square":  # n x n, 300-digit entries
    a = b = text(n, n, lambda i, j: 10**299 + 7919 * i + 104729 * j)
elif shape == "big-1xKxM":  # 1 x n x 16, 300-digit entries
    a, b = text(1, n, lambda i, j: 10**299 + 7 * j), text(n, 16, lambda i, j: 10**299 - 3 * i - j)
else:  # huge: 1 x n x 1, 4000-digit entries (under the 4300-digit int-str limit)
    a, b = text(1, n, lambda i, j: 10**3999 + 7 * j), text(n, 1, lambda i, j: 10**3999 - 3 * i)
def nxt():
    return json.dumps(call("mat_mul", a="1,2", b="3;4", wire="csv"))
'''

SIGINT_CHILD = COMMON + r'''
print("ready", flush=True)
t = time.monotonic()
try:
    call("mat_mul", a=a, b=b, wire="csv")
    print("done %.3f" % (time.monotonic() - t), flush=True)
except KeyboardInterrupt:
    print("interrupted", flush=True)
print("then: " + nxt(), flush=True)
'''

TARGETED_CHILD = COMMON + r'''
dot = "zmat-big-dot" if shape.startswith(("big", "huge")) else "zmat-dot"
# (the phases with at least 2^16 units of work at these shapes: the
# output-heavy product's inputs are n entries each, below one poll interval)
phases = ([dot] if shape == "output-heavy" else ["parse", "zmat-scan", dot]) + (["reply"] if shape in ("square", "wide", "output-heavy", "big-square") else [])
base = _native.ledger_snapshot()["outstanding"]
req = json.dumps(dict(fn="mat_mul", a=a, b=b, wire="csv"))
t0 = time.monotonic(); req2 = json.dumps(dict(fn="mat_mul", a=a, b=b, wire="csv")); t1 = time.monotonic()
_native._test_trace(); rep = _native.call(req2); t2 = time.monotonic()
json.loads(rep); t3 = time.monotonic()
print(json.dumps(dict(transport=dict(request_mb=len(req) / 1e6, reply_mb=len(rep) / 1e6, dumps_ms=(t1 - t0) * 1e3, native_ms=(t2 - t1) * 1e3, loads_ms=(t3 - t2) * 1e3))), flush=True)
del rep, req2
for ph in phases:
    _native._test_trace()
    call("mat_mul", a=a, b=b, wire="csv")
    idx = _native._test_traced(ph)
    row = dict(phase=ph, checks=len(idx))
    if idx:
        _native._test_arm_at(idx[len(idx) // 2])
        try:
            call("mat_mul", a=a, b=b, wire="csv")
            row["outcome"] = "not interrupted"
        except KeyboardInterrupt:
            now = _native._test_now_ns()
            landed, at = _native._test_stopped()
            row.update(outcome="interrupted", landed=landed, latency_ms=(now - at) / 1e6)
        row["then"] = nxt()
        row["outstanding_back"] = _native.ledger_snapshot()["outstanding"] == base
    print(json.dumps(row), flush=True)
print("end", flush=True)
'''

# The shape sets (--set NAME, default big): (shape, size).
# - big: about 1-4 s natively on a VM, with requests or replies of 25-640 MB:
#   the FU-MM-T evidence (one call's serde/JSON/drop intervals grow with its bytes).
# - small: every request and reply under about 8 MB (T's future per-call budget),
#   for #241's own Stop-250 claim; real SIGINT at T/2 only where T >= 0.5 s.
SETS = {
    "big": [("1xKx1", 8_000_000), ("1xKxM", 600_000), ("square", 1400), ("wide", 9000), ("output-heavy", 3000), ("big", 400_000)],
    "small": [("1xKx1", 400_000), ("1xKxM", 20_000), ("square", 630), ("wide", 500), ("output-heavy", 500), ("big", 12_000), ("big-1xKxM", 800), ("big-square", 100), ("huge", 600)],
}
SET = sys.argv[sys.argv.index("--set") + 1] if "--set" in sys.argv else "big"
SHAPES = SETS[SET]
# The named temporary exception (never a silent pass): in the big set only, a
# row whose ONLY failure is latency past 250 ms is reported WAIVED, with its
# measurement.  William, Oct 27 ~5:45 PM PDT (card pr241-stop250-interim):
# "Yes, land #241 now with the named temporary exception": FU-MM-T, single
# ZZ mat_mul calls large enough that one uninterruptible serde parse /
# serialize, Python json dumps / loads or unwind drop exceeds 250 ms, until
# the tiling PR T lands, which must retire it.  The small set is strict.
WAIVER = "WAIVED FU-MM-T (William, Oct 27 2026: land #241 with the named temporary exception; retired by tiling PR T)"
WAIVABLE = SET == "big"
WAIT = 600.0  # the longest any child may take (a hang guard, not a limit of the computation)


def spawn(code, shape, n):
    """The child, with a reader thread queueing its stdout lines (so every
    wait below is bounded, whatever the pipe's buffering)."""
    c = subprocess.Popen([sys.executable, "-c", code, shape, str(n)], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    c.lines = queue.Queue()

    def pump():
        for line in c.stdout:
            c.lines.put(line)
        c.lines.put("")  # EOF

    threading.Thread(target=pump, daemon=True).start()
    return c


def readline(c, deadline):
    """One line of the child's stdout ("" at EOF), waiting at most until the
    deadline (monotonic); None on timeout."""
    try:
        return c.lines.get(timeout=max(0.0, deadline - time.monotonic()))
    except queue.Empty:
        return None


def finish(c, timeout=60.0):
    """The child's remaining stdout lines (joined), its stderr and its exit
    status; killed (and reaped) on timeout, status None."""
    try:
        rc = c.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        c.kill()
        c.wait()
        rc = None
    out = []
    while True:
        line = readline(c, time.monotonic() + 5)
        if not line:
            break
        out.append(line)
    err = c.stderr.read()
    return "".join(out), err + ("" if rc is not None else "\n(killed after %.0f s)" % timeout), rc


def sigint_case(shape, n):
    c = spawn(SIGINT_CHILD, shape, n)
    if readline(c, time.monotonic() + WAIT) != "ready\n":
        out, err, _ = finish(c, 5)
        return False, "no ready line: " + (out + err)[-300:]
    out, err, rc = finish(c, WAIT)
    if rc != 0 or not out.startswith("done "):
        return False, "calibration rc=%s: %s" % (rc, (out + err)[-300:])
    T = float(out.split()[1])
    c = spawn(SIGINT_CHILD, shape, n)
    if readline(c, time.monotonic() + WAIT) != "ready\n":
        out, err, _ = finish(c, 5)
        return False, "no ready line: " + (out + err)[-300:]
    time.sleep(T / 2)
    ts = time.monotonic()
    c.send_signal(signal.SIGINT)
    first = readline(c, ts + 60)
    dt = time.monotonic() - ts
    out, err, rc = finish(c, 60)
    lines = ((first or "") + out).splitlines()
    if T < 0.5:
        # (too short for a signal at T / 2 to be scheduling evidence: reported, not judged)
        return True, "T=%.2f s: too short for a T/2 SIGINT row (n/a); KeyboardInterrupt %.0f ms, rc=%s" % (T, dt * 1000, rc)
    correct = first == "interrupted\n" and rc == 0 and lines[-1:] == ['then: "11"']
    what = "T=%.2f s, KeyboardInterrupt %.0f ms after SIGINT, rc=%s, %s" % (T, dt * 1000, rc, " | ".join(lines)[:120] + err.strip()[-200:])
    if correct and dt >= 0.25 and WAIVABLE:
        return True, WAIVER + ": " + what
    return correct and dt < 0.25, what


def targeted_case(shape, n):
    c = spawn(TARGETED_CHILD, shape, n)
    rows, deadline = [], time.monotonic() + WAIT
    while True:
        line = readline(c, deadline)
        if line is None or line == "" or line == "end\n":
            break
        rows.append(json.loads(line))
    out, err, rc = finish(c, 30)
    bad = [] if rc == 0 and line == "end\n" else ["rc=%s, %s" % (rc, err.strip()[-300:])]
    for r in rows:
        if "transport" in r:
            continue
        correct = r.get("outcome") == "interrupted" and r.get("landed") == r["phase"] and r.get("then") == '"11"' and r.get("outstanding_back")
        if correct and r.get("latency_ms", 1e9) >= 250 and WAIVABLE:
            r["waiver"] = WAIVER
        elif not (correct and r.get("latency_ms", 1e9) < 250):
            bad.append(json.dumps(r))
    return not bad, rows, bad


if sys.platform == "win32":
    print("skipped on Windows")
    sys.exit(0)
quick = "--quick" in sys.argv
targeted = "--targeted" in sys.argv
if targeted:
    from sagebrush import _native

    if not hasattr(_native, "_test_arm_at"):
        print("--targeted needs a wheel built with the test-hooks feature")
        sys.exit(2)
fails = 0
for shape, n in SHAPES:
    if quick:
        n = n // 2 if shape in ("1xKx1", "1xKxM", "big", "big-1xKxM", "huge") else int(n / 1.26)
    if targeted:
        ok, rows, bad = targeted_case(shape, n)
        for r in rows:
            print("%-12s n=%-9d %s" % (shape, n, json.dumps(r)))
        for b in bad:
            print("%-12s FAIL %s" % (shape, b))
    else:
        ok, what = sigint_case(shape, n)
        print("%-12s n=%-9d %s  %s" % (shape, n, "ok" if ok else "FAIL", what))
    fails += not ok
sys.exit(1 if fails else 0)
