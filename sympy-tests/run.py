"""Check sagebrush's sympy against SymPy itself.

    python3 sympy-tests/run.py               # every sympy-tests/test_*.py
    python3 sympy-tests/run.py matrix -v     # those whose name contains "matrix", with diffs

Each program runs under CPython with the real SymPy (and NumPy) and under
sagebrush.  Their stdout and exit status must be identical: sagebrush's sympy
is a subset of SymPy's interface, and within it the printed and LaTeX forms
are SymPy's, character for character.
"""
import difflib, os, subprocess, sys, concurrent.futures as cf

HERE = os.path.dirname(os.path.abspath(__file__))
CLI = os.path.join(os.path.dirname(HERE), "dist", "src", "cli.js")
args = [a for a in sys.argv[1:] if not a.startswith("-")]
verbose = "-v" in sys.argv
files = sorted(f for f in os.listdir(HERE) if f.startswith("test_") and f.endswith(".py") and (not args or any(a in f for a in args)))
workers = min(8, max(1, int(os.environ.get("SAGEBRUSH_CPUS", "8"))))


def run(cmd):
    p = subprocess.run(cmd, cwd=HERE, capture_output=True, timeout=300)
    return p.returncode, p.stdout.decode(errors="replace"), p.stderr.decode(errors="replace")


def one(f):
    return f, run([sys.executable, f]), run(["node", CLI, f])


bad = 0
with cf.ThreadPoolExecutor(workers) as ex:
    for f, ref, got in ex.map(one, files):
        if ref[0] != got[0]:
            notes = ["exit status: sympy %s, sagebrush %s" % (ref[0], got[0]), (got[2] or ref[2]).strip()[-1500:]]
        elif ref[1] != got[1]:
            notes = [line[:300] for line in difflib.unified_diff(ref[1].splitlines(), got[1].splitlines(), "sympy", "sagebrush", lineterm="", n=0)][:80]
        else:
            notes = []
        print("%-28s %s  (%d lines)" % (f, "DIFF" if notes else "ok", ref[1].count("\n")))
        if notes:
            bad += 1
            if verbose or len(files) == 1:
                for n in notes[:40]:
                    print("  " + n)
print("%d of %d differ" % (bad, len(files)) if bad else "all %d agree" % len(files))
sys.exit(1 if bad else 0)
