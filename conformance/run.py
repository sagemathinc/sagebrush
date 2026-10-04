"""Run the conformance corpus (ported from sagejs) against the pyjs spike.

    python3 conformance/run.py                 # everything
    python3 conformance/run.py --suite micropython --show 40
    python3 conformance/run.py --only str_       # substring filter on case ids

Corpus (conformance/upstream, from sagejs, licenses and provenance kept):
  * micropython: 508 programs from MicroPython tests/basics whose stdout and
    exit status must equal CPython 3.14's ("cpython-output-baseline-v2");
  * rustpython, pypy, graalpy, ironpython, cpython: 28 self-checking programs
    that must exit 0 with empty stdout and stderr ("assertion-exit-empty-output").

Results go to /tmp/conformance-results.json; a summary line per suite is
printed, plus the first --show failures.
"""
import argparse, collections, concurrent.futures as cf, json, os, shutil, subprocess, sys, tempfile, time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
CLI = os.path.join(ROOT, "dist", "src", "cli.js")
UP = os.path.join(HERE, "upstream")

ap = argparse.ArgumentParser()
ap.add_argument("--suite", action="append")
ap.add_argument("--only", action="append")
ap.add_argument("--show", type=int, default=25)
ap.add_argument("--python", default="python3")
ap.add_argument("-j", type=int, default=os.cpu_count() or 4)
ap.add_argument("--json", default="/tmp/conformance-results.json")
ap.add_argument("--runtime", default="node", help="node (dist/), or node-bundle, deno, bun (the single-file bundle from scripts/build-cli.mjs)")
args = ap.parse_args()
BUNDLE = os.path.join(ROOT, "build", "cli", "pyjs.cjs")
PYJS = {"node": ["node", CLI], "node-bundle": ["node", BUNDLE], "deno": ["deno", "run", "-A", BUNDLE], "bun": ["bun", BUNDLE]}[args.runtime]

manifest = json.load(open(os.path.join(UP, "python-compat", "manifest.json")))
cases = manifest["cases"]
if args.suite:
    cases = [c for c in cases if c["suite"] in args.suite]
if args.only:
    cases = [c for c in cases if any(o in c["id"] for o in args.only)]
reviews = json.load(open(os.path.join(UP, "micropython", "INTENTIONAL-INCOMPATIBILITIES.json")))["tests"]


def run(cmd, cwd, timeout):
    try:
        p = subprocess.run(cmd, cwd=cwd, capture_output=True, timeout=timeout)
        return {"code": p.returncode, "out": p.stdout, "err": p.stderr}
    except subprocess.TimeoutExpired:
        return {"code": "timeout", "out": b"", "err": b""}


def one(c):
    timeout = c.get("timeoutMs", 5000) / 1000 * 2
    if c["suite"] == "micropython":
        d = os.path.join(UP, "micropython")
        cwd = os.path.join(d, os.path.dirname(c["path"]))
        f = os.path.basename(c["path"])
        ref = run([args.python, f], cwd, timeout)
        got = run(PYJS + [f], cwd, timeout * 3)
        ok = got["code"] == ref["code"] and got["out"] == ref["out"]
        status = "pass" if ok else ("reviewed" if os.path.basename(f) in reviews else "fail")
    else:
        d = os.path.join(UP, "python-compat", "suites", c["suite"])
        tmp = tempfile.mkdtemp(prefix="pycompat-")
        try:
            shutil.copy(os.path.join(d, c["path"]), os.path.join(tmp, "main.py"))
            for fx in c["fixtures"]:
                shutil.copy(os.path.join(d, fx["path"]), os.path.join(tmp, fx["destination"]))
            ref = run([args.python, "main.py"], tmp, timeout)
            got = run(PYJS + ["main.py"], tmp, timeout * 3)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)
        ok = got["code"] == 0 and got["out"] == b"" and got["err"] == b""
        status = "pass" if ok else "fail"
        if ref["code"] != 0:
            status = "oracle-failed"
    return {"id": c["id"], "suite": c["suite"], "status": status,
            "ref": {"code": ref["code"], "out": ref["out"].decode(errors="replace")[-400:]},
            "got": {"code": got["code"], "out": got["out"].decode(errors="replace")[-400:], "err": got["err"].decode(errors="replace")[-600:]}}


t0 = time.time()
with cf.ThreadPoolExecutor(args.j) as ex:
    results = list(ex.map(one, cases))
by = collections.defaultdict(collections.Counter)
for r in results:
    by[r["suite"]][r["status"]] += 1
total = collections.Counter(r["status"] for r in results)
for s in sorted(by):
    n = sum(by[s].values())
    print(f"{s:12} {by[s]['pass']:4}/{n:<4} {dict(by[s])}")
print(f"{'TOTAL':12} {total['pass']:4}/{len(results):<4} {dict(total)}  ({time.time() - t0:.0f} s, runtime={args.runtime})")
json.dump(results, open(args.json, "w"), indent=1)
shown = 0
for r in results:
    if r["status"] in ("fail",) and shown < args.show:
        shown += 1
        err = r["got"]["err"].strip().splitlines()
        print(f"-- {r['id']}: code {r['got']['code']} (cpython {r['ref']['code']}); {err[-1][:200] if err else 'stdout differs'}")
