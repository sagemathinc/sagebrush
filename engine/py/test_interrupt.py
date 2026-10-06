"""Ctrl-C during engine calls raises KeyboardInterrupt and keeps the
interpreter usable: python engine/py/test_interrupt.py (Unix; skipped on
Windows, where a console Ctrl-C cannot be sent to a child process simply).
Each case runs in a child process that receives SIGINT mid-computation."""

import signal
import subprocess
import sys
import time

CHILD = r'''
import sys, time
from sagebrush import nf, modsym
x = [1, 2, 3]
print("ready", flush=True)
t = time.time()
try:
    if sys.argv[1] == "ecm":     # a 60-digit semiprime: far beyond 2 seconds
        nf.factor_integer(100000000000000000000000012349 * 300000000000000000000000000823)
    elif sys.argv[1] == "modsym":  # parallel (rayon)
        modsym.charpoly_exact(30011, 2)
    elif sys.argv[1] == "python":  # Python's own Ctrl-C, after an engine call
        nf.is_prime(97)
        time.sleep(60)
    print("not interrupted", flush=True)
except KeyboardInterrupt:
    print("interrupted after %.1f s" % (time.time() - t), flush=True)
print("then:", x, nf.factor_integer(2**64 + 1), flush=True)
'''

if sys.platform == "win32":
    print("skipped on Windows")
    sys.exit(0)
bad = 0
for case in ["ecm", "modsym", "python"]:
    c = subprocess.Popen([sys.executable, "-c", CHILD, case], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    assert c.stdout.readline().strip() == "ready"
    time.sleep(2)
    t = time.time()
    c.send_signal(signal.SIGINT)
    out, err = c.communicate(timeout=60)
    dt = time.time() - t
    ok = c.returncode == 0 and "interrupted after" in out and "then: [1, 2, 3] [(274177, 1), (67280421310721, 1)]" in out and dt < 5
    bad += not ok
    print("%-7s %s  (%.2f s after SIGINT) %s" % (case, "ok" if ok else "FAIL", dt, out.strip().replace("\n", " | ") + err.strip()[-300:]))
sys.exit(1 if bad else 0)
