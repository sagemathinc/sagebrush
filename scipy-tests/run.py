"""Check sagebrush's scipy against SciPy itself.

    python3 scipy-tests/run.py               # every scipy-tests/test_*.py
    python3 scipy-tests/run.py quad -v       # those whose name contains "quad", with diffs
    python3 scipy-tests/run.py --dir D       # the test_*.py programs of directory D instead

Each program runs under CPython with the real SciPy and NumPy and under
sagebrush.  Both must exit with status 0, and their stdout must be identical, except lines
from check() (scipy-tests/_check.py): those carry numbers and a tolerance,
for results that agree with SciPy's within a tolerance rather than to the
last bit (odeint is not LSODA).  Everything else, quad's values and error
estimates and solve_ivp's steps, is compared exactly.
"""
import difflib, json, os, subprocess, sys, concurrent.futures as cf

HERE = os.path.dirname(os.path.abspath(__file__))
CLI = os.path.join(os.path.dirname(HERE), "dist", "src", "cli.js")
argv = sys.argv[1:]
if "--dir" in argv:
    i = argv.index("--dir")
    HERE = os.path.abspath(argv[i + 1])
    del argv[i:i + 2]
args = [a for a in argv if not a.startswith("-")]
verbose = "-v" in sys.argv
files = sorted(f for f in os.listdir(HERE) if f.startswith("test_") and f.endswith(".py") and (not args or any(a in f for a in args)))
workers = min(8, max(1, int(os.environ.get("SAGEBRUSH_CPUS", "8"))))


def run(cmd):
    p = subprocess.run(cmd, cwd=HERE, capture_output=True, timeout=300)
    return p.returncode, p.stdout.decode(errors="replace"), p.stderr.decode(errors="replace")


def one(f):
    return f, run([sys.executable, f]), run(["node", CLI, f])


def close(ref, got):
    """Two check() lines agree: same name, length and tolerance, numbers within it."""
    a, b = json.loads(ref[6:]), json.loads(got[6:])
    if a["name"] != b["name"] or len(a["values"]) != len(b["values"]) or a["rtol"] != b["rtol"] or a["atol"] != b["atol"]:
        return "name, length or tolerance differ"
    for i, (x, y) in enumerate(zip(a["values"], b["values"])):
        if x is None or y is None:   # nan
            if x != y:
                return "value %d: %r vs %r" % (i, x, y)
        elif abs(x - y) > a["atol"] + a["rtol"] * abs(x):
            return "value %d: %r vs %r (difference %.3g)" % (i, x, y, abs(x - y))
    return None


def compare(ref, got):
    """[] if the outputs agree, else what differs."""
    r, g = ref.splitlines(), got.splitlines()
    if len(r) != len(g):
        return ["%d lines vs %d" % (len(r), len(g))] + [
            line[:300] for line in list(difflib.unified_diff(r, g, "scipy", "sagebrush", lineterm="", n=0))[:80]]
    notes = []
    for x, y in zip(r, g):
        if x.startswith("CHECK ") and y.startswith("CHECK "):
            why = close(x, y)
            if why:
                notes.append(json.loads(x[6:])["name"] + ": " + why)
        elif x != y:
            notes.append("- " + x[:300] + "\n+ " + y[:300])
    return notes


bad = 0
with cf.ThreadPoolExecutor(workers) as ex:
    for f, ref, got in ex.map(one, files):
        # (a program that fails on both sides, a missing fixture say, is a failure, not an agreement: both must exit 0)
        if ref[0] != 0 or got[0] != 0:
            notes = ["exit status: scipy %s, sagebrush %s (both must be 0)" % (ref[0], got[0]),
                     (got[2] if got[0] != 0 else ref[2]).strip()[-1500:]]
        else:
            notes = compare(ref[1], got[1])
        print("%-28s %s  (%d lines)" % (f, "DIFF" if notes else "ok", ref[1].count("\n")))
        if notes:
            bad += 1
            if verbose or len(files) == 1:
                for n in notes[:40]:
                    print("  " + n.replace("\n", "\n  "))
print("%d of %d differ" % (bad, len(files)) if bad else "all %d agree" % len(files))
sys.exit(1 if bad else 0)
