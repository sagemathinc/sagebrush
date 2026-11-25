"""GF(p) matrix products on the binary route (nmod_mat_mul over SBW1) in the
CPython package: the cases of test/ffmat_mul_bin.py (shared with pyjs,
test/ffmat-mul-bin.test.ts), each in a fresh interpreter (the memory case
measures a process's peaks; the lazy case needs a fresh import).

    python engine/py/test_mul_bin.py
"""
import os
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
CASES = os.path.join(HERE, "..", "..", "test", "ffmat_mul_bin.py")

bad = 0
for case in ["lazy", "correct", "threshold", "frame", "preflight", "outcomes", "fields", "oracle", "mem"]:
    t = time.time()
    p = subprocess.run([sys.executable, CASES, case], capture_output=True, text=True, timeout=1800)
    good = p.returncode == 0 and ("\nok %s " % case) in "\n" + p.stdout
    bad += not good
    print("%-10s %s  (%.1f s)" % (case, "ok" if good else "FAIL", time.time() - t))
    if not good or case == "mem":
        print("    " + (p.stdout.strip() + ("\n" + p.stderr.strip()[-2000:] if not good else "")).replace("\n", "\n    "))
sys.exit(1 if bad else 0)
