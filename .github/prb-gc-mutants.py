"""PR B r3's GC-deadline mutants on Windows (daybreak2's r3 ruling (b), condition 4;
throwaway branch only).  Each edits the installed sage_plot3d.py's _gc_temps at one
site, runs test_ctrlc_cleanup.py's deterministic deadline tests (gc-deadline), which
must then fail, and restores the file (checked byte for byte).  The unmutated run
first, which must pass.  Exit 1 if the control fails, any mutant survives, or a
restore differs."""

import os
import subprocess
import sys

import sagebrush.session as S

F = os.path.join(os.path.dirname(S.__file__), "_sagelib", "sage_plot3d.py")
HERE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "engine", "py")
M = [
    ("deadline-ignored", "    clock = clock or time.monotonic\n", "    clock = clock or time.monotonic\n    budget_s = float(\"inf\")\n"),
    ("continued-fetch", "            if over or clock() - t0 > budget_s:\n", "            if over:\n"),
    ("seek-ignores-deadline", "            if seeking and not over:\n", "            if seeking:\n"),
    ("reset-after-seek", "                if e.name == cursor:\n                    seeking = False\n", "                if e.name == cursor:\n                    seeking = False\n                    t0 = clock()\n"),
]


def run():
    r = subprocess.run([sys.executable, "test_ctrlc_cleanup.py", "gc-deadline"], cwd=HERE, capture_output=True, text=True, timeout=600)
    return r.returncode, [l for l in (r.stdout + r.stderr).splitlines() if l.startswith(("FAIL", "AssertionError", "gc deadline"))]


orig = open(F, "rb").read()
NL = "\r\n" if b"\r\n" in orig else "\n"  # (a Windows checkout's wheel carries CRLF sources: the anchors follow the file)
print("sage_plot3d.py line endings: %s" % ("CRLF" if NL == "\r\n" else "LF"), flush=True)
bad = 0
code, lines = run()
print("control (unmutated): exit %d | %s" % (code, " | ".join(lines)[:400]), flush=True)
bad += code != 0
for name, a, b in M:
    text = orig.decode("utf-8")
    a, b = a.replace("\n", NL), b.replace("\n", NL)
    assert text.count(a) == 1, (name, text.count(a))
    open(F, "wb").write(text.replace(a, b, 1).encode("utf-8"))
    try:
        code, lines = run()
    finally:
        open(F, "wb").write(orig)
    same = open(F, "rb").read() == orig
    print("%s %s | %s%s" % (name, "CAUGHT" if code else "SURVIVED", " | ".join(lines)[:400], "" if same else " | RESTORE DIFFERS"), flush=True)
    bad += (code == 0) + (not same)
print("gc-deadline mutants: %s" % ("all caught" if not bad else "%d problem(s)" % bad))
sys.exit(1 if bad else 0)
