"""The integrator's scorecard on Rubi's test suite.

    python3 bench/rubi/convert.py /tmp/rubi-tests > /tmp/rubi.jsonl
    python3 bench/rubi/score.py /tmp/rubi.jsonl [-j 14] [--timeout 2000]

Runs engine/sym's `rubi` example in parallel workers and prints, for each
section, how many problems get an antiderivative (verified by
differentiation inside integrate()), how many time out, and how many hit a
bug (a panic other than a symbolic error).  --out writes all results.
"""
import argparse, collections, concurrent.futures, json, os, subprocess, sys, threading, time

ap = argparse.ArgumentParser()
ap.add_argument("jsonl")
ap.add_argument("-j", type=int, default=max(1, (os.cpu_count() or 2) - 2))
ap.add_argument("--timeout", type=int, default=2000)
ap.add_argument("--out")
a = ap.parse_args()

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
subprocess.run(["cargo", "build", "--release", "-q", "-p", "sagebrush-sym", "--example", "rubi"], cwd=os.path.join(ROOT, "engine"), check=True)
exe = os.path.join(ROOT, "engine", "target", "release", "examples", "rubi")
problems = [json.loads(l) for l in open(a.jsonl)]
t0 = time.time()
results = {}
lock = threading.Lock()
chunks = [(s, min(s + 100, len(problems))) for s in range(0, len(problems), 100)]


def run(chunk):
    start, end = chunk
    while start < end:
        # 4 GB of memory per worker: a runaway computation dies alone
        p = subprocess.Popen(["sh", "-c", "ulimit -v 4000000; exec \"$0\" \"$@\"", exe, a.jsonl, str(start), str(end), str(a.timeout)],
                             stdout=subprocess.PIPE, text=True)
        last = start - 1
        for line in p.stdout:
            r = json.loads(line)
            with lock:
                results[r["i"]] = r
            last = r["i"]
        p.wait()
        if last + 1 < end and p.returncode != 0:
            with lock:
                results[last + 1] = {"i": last + 1, "status": "crash", "ms": 0, "detail": "exit %d" % p.returncode}
        start = last + 2 if p.returncode != 0 else end


with concurrent.futures.ThreadPoolExecutor(a.j) as pool:
    list(pool.map(run, chunks))
elapsed = time.time() - t0

by = collections.defaultdict(collections.Counter)
for i, pr in enumerate(problems):
    sec = pr["file"].split("/")[0]
    st = results.get(i, {"status": "crash"})["status"]
    by[sec][st] += 1
    by["total"][st] += 1
print("%-34s %7s %7s %6s %8s %5s" % ("section", "problems", "found", "%", "timeout", "bugs"))
for sec in sorted(k for k in by if k != "total") + ["total"]:
    c = by[sec]
    n = sum(c.values())
    print("%-34s %7d %7d %5.1f%% %8d %5d" % (sec, n, c["found"], 100.0 * c["found"] / n, c["timeout"], c["bug"] + c["crash"]))
print("%.0f s with %d workers" % (elapsed, a.j))
if a.out:
    with open(a.out, "w") as f:
        for i, pr in enumerate(problems):
            f.write(json.dumps(dict(pr, **results.get(i, {"status": "crash"}))) + "\n")
