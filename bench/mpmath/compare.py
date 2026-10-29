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
# (a control of the harness: not named test_*, so it isn't in mods)
shutil.copy(os.path.join(HERE, "harness_control.py"), os.path.join(work, "mpmath", "tests", "harness_control.py"))
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
            # (a negative return code is a signal: -9 is a kill, as an OOM)
            r = {"module": mod, "crash": (p.stderr or p.stdout)[-600:], "returncode": p.returncode}
    except subprocess.TimeoutExpired as e:
        out = e.stderr or e.stdout or ""
        r = {"module": mod, "timeout": args.timeout, "tail": (out.decode(errors="replace") if isinstance(out, bytes) else out)[-600:]}
    r["wall_s"] = round(time.time() - t, 2)
    return r


def both(mod):
    return mod, run([sys.executable], mod), run(["node", "--stack-size=8000", CLI], mod)


def control_problems(cp, pj):
    """The harness control's expected outcome on both sides, or what differs."""
    bad = []
    seeded = {}
    for side, r in (("cpython", cp), ("pyjs", pj)):
        if "passed" not in r:
            bad.append("%s: no result (%s)" % (side, (r.get("crash") or r.get("tail") or r.get("import_error") or "")[-300:]))
            continue
        fails = {f["test"]: f for f in r.get("failures", [])}
        if r["passed"] != 1 or r["failed"] != 2 or sorted(fails) != ["test_fails", "test_seeded"]:
            bad.append("%s: passed %s, failed %s, failures %s" % (side, r["passed"], r["failed"], sorted(fails)))
            continue
        f = fails["test_fails"]
        if "an injected failing assert" not in f["error"] or not f["where"].strip() or "seed" not in f:
            bad.append("%s: the injected failure's text, location or seed is missing: %r" % (side, f))
        seeded[side] = fails["test_seeded"]["error"]
    if len(seeded) == 2 and seeded["cpython"] != seeded["pyjs"]:
        bad.append("the seeded draws differ: %r vs %r" % (seeded["cpython"], seeded["pyjs"]))
    return bad


_, ccp, cpj = both("harness_control")
cbad = control_problems(ccp, cpj)
print("harness control: " + ("ok (a pass and two reported failures on both interpreters; the same seeded draw)" if not cbad else "FAILED: " + "; ".join(cbad)))
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
# The stored tail of every crash and timeout, so that the CI log says what
# happened (/tmp/mpmath-compare.json stays on the runner).
for mod in mods:
    for side in ("cpython", "pyjs"):
        r = results[mod][side]
        if "crash" in r:
            print("\n%s, %s: crash (return code %s, %.1f s); the output's last 600 characters:\n%s"
                  % (mod, side, r.get("returncode"), r["wall_s"], r["crash"]))
        elif "timeout" in r:
            print("\n%s, %s: timeout after %d s; the output's last 600 characters:\n%s"
                  % (mod, side, r["timeout"], r.get("tail", "")))
# Fail (for CI) if the harness control failed, or pyjs passes fewer tests than CPython.
sys.exit(1 if cbad or tp < tc else 0)
