"""Ctrl-C during dense integer products, within the 250 ms Stop bound:
python engine/py/test_interrupt_matmul.py [--quick] (Unix; skipped on
Windows).  For each shape (1 x K x 1, 1 x K x M, square, wide) a child
first runs the product uninterrupted and reports its time T (at least about
a second, so the Stop lands inside the engine call: the parse, the product
or the reply); a second child receives SIGINT at T / 2.  Checked:
KeyboardInterrupt within 250 ms of the signal, and the same interpreter then
multiplies correctly.  The request texts are built before the timed call,
so the window holds only the engine call."""

import signal
import subprocess
import sys
import time

CHILD = r'''
import sys, time
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
else:  # wide: n x 32 times 32 x n
    a, b = text(n, 32, lambda i, j: (i * 31 + j) % 10**9), text(32, n, lambda i, j: (i + j * 17) % 10**9)
print("ready", flush=True)
t = time.time()
try:
    call("mat_mul", a=a, b=b, wire="csv")
    print("done %.3f" % (time.time() - t), flush=True)
except KeyboardInterrupt:
    print("interrupted", flush=True)
r = call("mat_mul", a="1,2", b="3;4", wire="csv")
print("then:", r, flush=True)
'''

# (shape, size): sizes for about 1-4 s natively on a VM; --quick halves the work
SHAPES = [("1xKx1", 8_000_000), ("1xKxM", 600_000), ("square", 1400), ("wide", 9000)]


def run(shape, n, at=None):
    c = subprocess.Popen([sys.executable, "-c", CHILD, shape, str(n)], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    assert c.stdout.readline().strip() == "ready", c.stderr.read()[-500:]
    t0 = time.time()
    if at is None:
        out, err = c.communicate(timeout=600)
        return out, err, None
    time.sleep(at)
    ts = time.time()
    c.send_signal(signal.SIGINT)
    first = c.stdout.readline()
    dt = time.time() - ts
    out, err = c.communicate(timeout=120)
    return first + out, err, dt


if sys.platform == "win32":
    print("skipped on Windows")
    sys.exit(0)
quick = "--quick" in sys.argv
bad = 0
for shape, n in SHAPES:
    if quick:
        n = n // 2 if shape in ("1xKx1", "1xKxM") else int(n / 1.26)
    out, err, _ = run(shape, n)
    if not out.startswith("done "):
        print("%-7s n=%d FAIL (calibration) %s" % (shape, n, (out + err)[-300:]))
        bad += 1
        continue
    T = float(out.split()[1])
    out, err, dt = run(shape, n, at=T / 2)
    then = [l for l in out.splitlines() if l.startswith("then:")]
    ok = out.startswith("interrupted") and len(then) == 1 and "11" in then[0] and dt < 0.25 and T >= 0.5
    bad += not ok
    print("%-7s n=%-9d T=%.2f s  KeyboardInterrupt %.0f ms after SIGINT  %s  %s" % (shape, n, T, dt * 1000, "ok" if ok else "FAIL", out.strip().replace("\n", " | ")[:160] + err.strip()[-200:]))
sys.exit(1 if bad else 0)
