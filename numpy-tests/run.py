"""Check sagebrush's numpy against NumPy itself.

    python3 numpy-tests/run.py            # every numpy-tests/test_*.py
    python3 numpy-tests/run.py linalg -v  # those whose name contains "linalg", with diffs

Each program runs under CPython with the real NumPy and under sagebrush; their
stdout (and exit status) must be identical.  Programs print results rather
than assert, so a difference shows exactly what differs.
"""
import difflib, os, subprocess, sys, concurrent.futures as cf

HERE = os.path.dirname(os.path.abspath(__file__))
CLI = os.path.join(os.path.dirname(HERE), "dist", "src", "cli.js")
args = [a for a in sys.argv[1:] if not a.startswith("-")]
verbose = "-v" in sys.argv
files = sorted(f for f in os.listdir(HERE) if f.startswith("test_") and f.endswith(".py") and (not args or any(a in f for a in args)))


def run(cmd):
    p = subprocess.run(cmd, cwd=HERE, capture_output=True, timeout=120)
    return p.returncode, p.stdout.decode(errors="replace"), p.stderr.decode(errors="replace")


def one(f):
    return f, run([sys.executable, f]), run(["node", CLI, f])


bad = 0
with cf.ThreadPoolExecutor(8) as ex:
    for f, ref, got in ex.map(one, files):
        ok = ref[0] == got[0] and ref[1] == got[1]
        print("%-28s %s  (%d lines)" % (f, "ok" if ok else "DIFF", ref[1].count("\n")))
        if not ok:
            bad += 1
            if verbose or len(files) == 1:
                if ref[0] != got[0]:
                    print("  exit status: numpy %s, sagebrush %s" % (ref[0], got[0]))
                    print("  " + (got[2] or ref[2]).strip().replace("\n", "\n  ")[-1500:])
                for line in list(difflib.unified_diff(ref[1].splitlines(), got[1].splitlines(), "numpy", "sagebrush", lineterm="", n=0))[:80]:
                    print("  " + line[:300])
print("%d/%d identical" % (len(files) - bad, len(files)))
sys.exit(1 if bad else 0)
