"""GF(p) echelon on the binary route (nmod_echelon over SBW1) in the
CPython package: the cases of test/ffmat_echelon_bin.py (shared
with pyjs, test/ffmat-echelon-bin.test.ts), each in a fresh interpreter
(the memory case measures a process's peaks), and Ctrl-C during a binary
elimination at 2048 x 2048 (Unix).

    python engine/py/test_ech_bin.py
"""
import os
import signal
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
CASES = os.path.join(HERE, "..", "..", "test", "ffmat_echelon_bin.py")

bad = 0
for case in ["route", "correct", "json", "probe", "preflight", "frame", "outcomes", "kernel", "mem"]:
    t = time.time()
    p = subprocess.run([sys.executable, CASES, case], capture_output=True, text=True, timeout=1800)
    good = p.returncode == 0 and ("\nok %s " % case) in "\n" + p.stdout
    bad += not good
    print("%-10s %s  (%.1f s)" % (case, "ok" if good else "FAIL", time.time() - t))
    if not good or case == "mem":
        print("    " + (p.stdout.strip() + ("\n" + p.stderr.strip()[-2000:] if not good else "")).replace("\n", "\n    "))

# the binding borrows a bytes request (no copy) and takes nothing else: a
# bytearray or memoryview is a TypeError, never a silent copy
import sagebrush._engine as EN
req = b"SBW1" + (12).to_bytes(4, "little") + b"nmod_poly_xx"
for arg in (bytearray(req), memoryview(req)):
    try:
        EN.call_bin(arg)
        good = False
    except TypeError:
        good = True
    bad += not good
    print("%-10s %s  call_bin(%s)" % ("binding", "ok" if good else "FAIL", type(arg).__name__))
assert EN.call_bin(req)[:6] == b"SBW1er"

if sys.platform != "win32":
    c = subprocess.Popen([sys.executable, CASES, "interrupt"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    assert c.stdout.readline().strip() == "ready"  # (the request is built: the engine runs next)
    time.sleep(0.3)
    c.send_signal(signal.SIGINT)
    out, err = c.communicate(timeout=300)
    good = c.returncode == 0 and out.strip() == "interrupted [(2048, 2048, True)]"
    bad += not good
    print("%-10s %s  %s" % ("interrupt", "ok" if good else "FAIL", (out.strip() + " " + err.strip()[-1000:]).strip()))
else:
    print("interrupt  skipped on Windows")
sys.exit(1 if bad else 0)
