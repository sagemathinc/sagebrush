"""Run mpmath's test modules under CPython and pyjs and compare.

    python3 bench/mpmath/compare.py [--only test_basic_ops] [--timeout 600]

Copies the installed mpmath (python3 -c 'import mpmath') to a scratch dir
next to this directory's pytest shim and runner, so both interpreters run
the same files.  Writes /tmp/mpmath-compare.json and prints a table.
"""
import argparse, concurrent.futures as cf, json, os, shutil, subprocess, sys, tempfile, time

HERE = os.path.dirname(os.path.abspath(__file__))
CLI = os.path.join(HERE, "..", "..", "dist", "src", "cli.js")
ap = argparse.ArgumentParser()
ap.add_argument("--only", action="append")
ap.add_argument("--timeout", type=int, default=900)
ap.add_argument("-j", type=int, default=max(1, (os.cpu_count() or 2) // 2))
args = ap.parse_args()

import mpmath
work = os.path.join(tempfile.gettempdir(), "mpmath-compare")
shutil.rmtree(work, ignore_errors=True)
shutil.copytree(os.path.dirname(mpmath.__file__), os.path.join(work, "mpmath"), ignore=shutil.ignore_patterns("__pycache__"))
for f in ("pytest.py", "run_tests.py"):
    shutil.copy(os.path.join(HERE, f), work)
mods = sorted(f[:-3] for f in os.listdir(os.path.join(work, "mpmath", "tests")) if f.startswith("test_") and f.endswith(".py"))
if args.only:
    mods = [m for m in mods if any(o in m for o in args.only)]


def run(cmd, mod):
    t = time.time()
    try:
        p = subprocess.run(cmd + ["run_tests.py", mod], cwd=work, capture_output=True, text=True, timeout=args.timeout, env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"})
        line = (p.stdout.strip().splitlines() or [""])[-1]
        try:
            r = json.loads(line)
        except ValueError:
            r = {"module": mod, "crash": (p.stderr or p.stdout)[-600:]}
    except subprocess.TimeoutExpired:
        r = {"module": mod, "timeout": args.timeout}
    r["wall_s"] = round(time.time() - t, 2)
    return r


def both(mod):
    return mod, run([sys.executable], mod), run(["node", "--stack-size=8000", CLI], mod)


results = {}
with cf.ThreadPoolExecutor(args.j) as ex:
    for mod, cp, pj in ex.map(both, mods):
        results[mod] = {"cpython": cp, "pyjs": pj}
json.dump(results, open("/tmp/mpmath-compare.json", "w"), indent=1)

def cell(r):
    if "import_error" in r: return "import error"
    if "crash" in r: return "crash"
    if "timeout" in r: return "timeout"
    return "%d/%d" % (r["passed"], r["passed"] + r["failed"])

print("%-24s %10s %10s %9s %9s %7s" % ("module", "cpython", "pyjs", "cpy s", "pyjs s", "ratio"))
tp = tc = tcp = tpj = 0
for mod in mods:
    cp, pj = results[mod]["cpython"], results[mod]["pyjs"]
    a, b = cp.get("test_s"), pj.get("test_s")
    ratio = "%.1fx" % (b / a) if a and b and a > 0.001 else ""
    print("%-24s %10s %10s %9s %9s %7s" % (mod, cell(cp), cell(pj), a if a is not None else "", b if b is not None else "", ratio))
    tc += cp.get("passed", 0); tp += pj.get("passed", 0)
    if a and b: tcp += a; tpj += b
print("passed: cpython %d, pyjs %d;  test time where both ran: cpython %.1fs, pyjs %.1fs (%.1fx)" % (tc, tp, tcp, tpj, tpj / tcp if tcp else 0))
