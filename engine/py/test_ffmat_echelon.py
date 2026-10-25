"""GF(p) echelon admission by shape (plan F4 r4, d5c6c1cd) in the CPython
package: the cases of test/ffmat_echelon_admission.py (shared with pyjs,
test/ffmat-echelon-admission.test.ts), each in a fresh interpreter (the
memory cases measure a process's peaks), and Ctrl-C during an engine
elimination at 1024 x 1024 (Unix).

    python engine/py/test_ffmat_echelon.py
"""
import os
import signal
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
CASES = os.path.join(HERE, "..", "..", "test", "ffmat_echelon_admission.py")

bad = 0
for case in ["bridge", "correct", "route", "preflight", "integration", "mem-T", "mem-Tp", "mem-W", "negctl"]:
    t = time.time()
    p = subprocess.run([sys.executable, CASES, case], capture_output=True, text=True, timeout=1200)
    good = p.returncode == 0 and ("\nok %s " % case) in "\n" + p.stdout
    bad += not good
    print("%-12s %s  (%.1f s)" % (case, "ok" if good else "FAIL", time.time() - t))
    if not good or case.startswith("mem") or case == "negctl":
        print("    " + (p.stdout.strip() + ("\n" + p.stderr.strip()[-2000:] if not good else "")).replace("\n", "\n    "))

if sys.platform != "win32":
    c = subprocess.Popen([sys.executable, CASES, "interrupt"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    assert c.stdout.readline().strip() == "ready"  # (the request is built: the engine runs next)
    time.sleep(0.2)
    c.send_signal(signal.SIGINT)
    out, err = c.communicate(timeout=120)
    good = c.returncode == 0 and out.strip() == "interrupted [(1024, 1024)]"
    bad += not good
    print("%-12s %s  %s" % ("interrupt", "ok" if good else "FAIL", (out.strip() + " " + err.strip()[-1000:]).strip()))
else:
    print("interrupt    skipped on Windows")
sys.exit(1 if bad else 0)
