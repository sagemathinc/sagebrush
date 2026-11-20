"""mpmath 1.3.0's own test modules on one backend, in CI (design/mpmath-core.md 6.1, point 2).

    python3 bench/mpmath/suite.py --backend sagebrush --shard 1/2 [-j 4]

Runs the overlaid package's test modules (packages/pypi-mpmath) under pyjs,
with SAGEBRUSH_MPMATH_BACKEND set to the backend, one process per module
(run_tests.py), and fails if any test fails, any module crashes or doesn't
import, or one runs past its timeout.  The modules are split into shards by
their measured seconds (WEIGHT, Nov 10, both backends' larger; 1 for the
rest), the heaviest first to the lightest shard, so each shard's set is the
same on every run.
"""
import argparse, concurrent.futures as cf, json, os, shutil, subprocess, sys, tempfile, time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..", "..")
CLI = os.path.join(ROOT, "dist", "src", "cli.js")
WEIGHT = {"test_calculus": 150, "test_functions2": 100, "test_elliptic": 65, "test_quad": 20, "test_gammazeta": 12,
          "test_eigen_symmetric": 7, "test_levin": 6, "test_convert": 6, "test_compatibility": 5, "test_functions": 5}

ap = argparse.ArgumentParser()
ap.add_argument("--backend", choices=("sagebrush", "python"), required=True)
ap.add_argument("--shard", default="1/1")
ap.add_argument("-j", type=int, default=max(1, (os.cpu_count() or 2) // 2))
ap.add_argument("--timeout", type=int, default=480)
args = ap.parse_args()
k, n = map(int, args.shard.split("/"))

work = tempfile.mkdtemp(prefix="mpmath-suite-")
shutil.copytree(os.path.join(ROOT, "packages", "pypi-mpmath", "py", "mpmath"), os.path.join(work, "mpmath"), ignore=shutil.ignore_patterns("__pycache__"))
for f in ("pytest.py", "run_tests.py"):
    shutil.copy(os.path.join(HERE, f), work)
mods = sorted(f[:-3] for f in os.listdir(os.path.join(work, "mpmath", "tests")) if f.startswith("test_") and f.endswith(".py"))
load, shards = [0] * n, [[] for _ in range(n)]
for m in sorted(mods, key=lambda m: (-WEIGHT.get(m, 1), m)):
    i = load.index(min(load))
    load[i] += WEIGHT.get(m, 1)
    shards[i].append(m)
mine = sorted(shards[k - 1])


def run(mod):
    t = time.time()
    env = {**os.environ, "PYTHONDONTWRITEBYTECODE": "1", "SAGEBRUSH_MPMATH_BACKEND": args.backend}
    try:
        p = subprocess.run(["node", CLI, "run_tests.py", mod], cwd=work, capture_output=True, text=True, timeout=args.timeout, env=env)
        line = (p.stdout.strip().splitlines() or ["{}"])[-1]
        try:
            r = json.loads(line)
        except ValueError:
            r = {"crash": (p.stdout + p.stderr)[-1500:]}
    except subprocess.TimeoutExpired:
        r = {"timeout": args.timeout}
    r["wall"] = round(time.time() - t, 1)
    return mod, r


bad = 0
with cf.ThreadPoolExecutor(args.j) as ex:
    for mod, r in ex.map(run, mine):
        ok = r.get("failed", 1) == 0 and not ({"crash", "timeout", "import_error"} & set(r))
        bad += not ok
        print("%-6s %-26s %4s passed %5.1f s" % ("ok" if ok else "FAIL", mod, r.get("passed", "-"), r["wall"]), flush=True)
        if not ok:
            print(json.dumps({x: r[x] for x in ("failures", "crash", "timeout", "import_error") if x in r}, indent=1)[:4000])
shutil.rmtree(work, ignore_errors=True)
print("backend %s, shard %d/%d: %d modules, %d failed" % (args.backend, k, n, len(mine), bad))
sys.exit(1 if bad else 0)
