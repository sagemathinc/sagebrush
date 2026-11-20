"""Ctrl-C during a call into the multiprecision core (sagebrush._native.mp)
raises KeyboardInterrupt, and the session goes on exact: the same values,
bit for bit, as a process that was never interrupted.  Run:
python engine/py/test_mp_interrupt.py (Unix; skipped on Windows, as
test_interrupt.py is).  Each case runs in a child process that receives
SIGINT mid-computation."""

import signal
import subprocess
import sys
import time

CHILD = r'''
import hashlib, sys, time
from sagebrush import _mpcore as C
def after():
    # (exact values the session must still give: a constant, an elementary function, a gamma)
    x = (0, 6004799503160661, -54, 53)
    return [C.pi_fixed(300), C.mpf_exp(x, 200, 'n'), C.mpf_log(x, 2000, 'f'), C.mpf_gamma(x, 700, 'n', 0)]
print("ready", flush=True)
t = time.time()
if sys.argv[1] != "none":
    try:
        if sys.argv[1] == "pi":       # pi to 40 million bits: far beyond 2 seconds
            C.pi_fixed(40000000)
        elif sys.argv[1] == "gamma":  # gamma's Taylor coefficients at 4,900 bits, from cold, many times
            for p in range(4800, 4900, 2):
                C.reset()
                C.mpf_gamma((0, 1, -2, 1), p, 'n', 0)
        print("not interrupted", flush=True)
    except KeyboardInterrupt:
        print("interrupted after %.1f s" % (time.time() - t), flush=True)
print("then:", hashlib.sha256(repr(after()).encode()).hexdigest()[:16], flush=True)
'''

if sys.platform == "win32":
    print("skipped on Windows")
    sys.exit(0)
ref = subprocess.run([sys.executable, "-c", CHILD, "none"], capture_output=True, text=True, timeout=120)
want = [l for l in ref.stdout.splitlines() if l.startswith("then:")]
assert ref.returncode == 0 and want, ref.stderr[-500:]
bad = 0
for case in ["pi", "gamma"]:
    c = subprocess.Popen([sys.executable, "-c", CHILD, case], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    assert c.stdout.readline().strip() == "ready"
    time.sleep(2)
    t = time.time()
    c.send_signal(signal.SIGINT)
    out, err = c.communicate(timeout=120)
    dt = time.time() - t
    ok = c.returncode == 0 and "interrupted after" in out and want[0] in out and dt < 5
    bad += not ok
    print("%-6s %s  (%.2f s after SIGINT) %s" % (case, "ok" if ok else "FAIL", dt, out.strip().replace("\n", " | ") + err.strip()[-300:]))
sys.exit(1 if bad else 0)
