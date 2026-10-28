"""Ctrl-C PR B's release A/B/A cost rows (daybreak2's PR B r1 #5), VM only:
the session's request path on PR A's worker (A) and PR B's (B), each in its
own venv with its release wheel.

    python ctrlc_perf.py PY_A PY_B OUT.json [ROUNDS]

ROUNDS (default 5) rounds, each A, B, A in turn on a fresh Session; per row,
each round's B over the mean of its two A's.  Rows (time unless said):
  noop        500 sequential tiny requests ("1"): per-request latency p50
  noop_tput   the same 500: requests per second (as time per request)
  req_1mib    a 1 MiB request (a string literal of 1 MiB), 20 times: median
  req_32mib   a 32 MiB request, 3 times: median
  reply_10mb  a 10 MB result (repr of a 10 MB string) encoded and written, 5 times: median
  req_rc_m1, req_rc, req_rc_p1
              requests whose framed line (newline included) is READ_CHUNK - 1,
              READ_CHUNK and READ_CHUNK + 1 bytes (64 KiB: serve.rs's read
              quantum and retained capacity), 200 times each: median
  rss_after_32mib
              the worker's VmRSS after the 32 MiB requests, one small request
              and an idle second (bytes): what a large request leaves retained
  rss_peak    the worker's VmHWM after the rows above (bytes; report-only:
              its history is the mixed sequence's)
  peak_cold_32mib, peak_burst_32mib
              a fresh worker's VmHWM (bytes) after the warm-up and one 32 MiB
              request, or three back to back (daybreak2's PR B r5 ruling: the
              gated peak rows, each in its own worker)
  rss_idle    the worker's VmRSS after them and an idle second (bytes;
              report-only, as rss_after_32mib: allocator history can reverse
              their sign, PR B r4b diag2; the gate is the semantic one in
              test_ctrlc_native's test_input_release)
  threads     the worker's thread count, idle
  fds         the worker's open file descriptors, idle
Each sample first runs one untimed batch of 500 no-ops (a cold worker's
first batch is not a timed one: daybreak2's PR B r3 gate 3).  The gate: each
row's B/A median <= 1.01, B against the mean of its round's two A's, with
every round's ratio and the spread listed (no pooling across rows).  Each
gated row also gets median(B/A1) and median(B/A2): if they fall on opposite
sides of 1.01, the row is INVALID (rerun), whatever its main ratio says.

    python ctrlc_perf.py --sensitivity PY_B PY_M OUT.json [ROUNDS]

runs the same rows with B in A's place and a control M in B's (B1, M, B2):
the control is caught when, on reply_10mb, its median over the mean of B1
and B2 is > 1.01, with M/B1 and M/B2 on the same side (daybreak2's PR B r5
copy-only reply control, judged against B, not A).  threads and fds are reported (B
has its control thread and pipe by design).  One JSON document out.
"""

import json
import os
import statistics
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))

CHILD = r'''
import json, os, sys, time
import sagebrush.session as S

def proc(pid, key):
    for line in open("/proc/%d/status" % pid):
        if line.startswith(key + ":"):
            return int(line.split()[1]) * (1024 if line.rstrip().endswith("kB") else 1)

s = S.Session()
pid = s.proc.pid
out = {}
RC = 1 << 16  # (serve.rs's READ_CHUNK)
s.run("1", mode="python")
for _ in range(500):  # (the untimed warm-up batch)
    assert s.run("1", mode="python")["result"] == "1"
t = []
t0 = time.perf_counter()
for _ in range(500):
    a = time.perf_counter()
    r = s.run("1", mode="python")
    t.append(time.perf_counter() - a)
    assert r["result"] == "1", r
out["noop"] = sorted(t)[len(t) // 2]
out["noop_tput"] = (time.perf_counter() - t0) / 500
big1 = "x = '" + "a" * (1 << 20) + "'\nlen(x)"
t = []
for _ in range(20):
    a = time.perf_counter(); r = s.run(big1, mode="python"); t.append(time.perf_counter() - a)
    assert r["result"] == str(1 << 20), r["result"]
out["req_1mib"] = sorted(t)[len(t) // 2]
big32 = "x = '" + "a" * (32 << 20) + "'\nlen(x)"
t = []
for _ in range(3):
    a = time.perf_counter(); r = s.run(big32, mode="python", timeout=120); t.append(time.perf_counter() - a)
    assert r["result"] == str(32 << 20), r["result"]
out["req_32mib"] = sorted(t)[len(t) // 2]
s.run("x = None", mode="python")
time.sleep(1.0)
out["rss_after_32mib"] = proc(pid, "VmRSS")

def framed(rid, n):
    # (code whose request line, as Session._send frames it, newline included, is n bytes)
    req = lambda code: json.dumps({"id": rid, "code": code, "mode": "python", "isolated": False, "data": False}) + "\n"
    code = "x='" + "a" * (n - len(req("x=''"))) + "'"
    assert len(req(code).encode("utf-8")) == n, (len(req(code)), n)
    return code

for name, n in (("req_rc_m1", RC - 1), ("req_rc", RC), ("req_rc_p1", RC + 1)):
    t = []
    for _ in range(200):
        code = framed(s.last_id + 1, n)
        a = time.perf_counter(); r = s.run(code, mode="python"); t.append(time.perf_counter() - a)
        assert r["error"] is None, r["error"]
    out[name] = sorted(t)[len(t) // 2]
t = []
for _ in range(5):
    a = time.perf_counter(); r = s.run("'b' * 10000000", mode="python", timeout=120); t.append(time.perf_counter() - a)
    assert len(r["result"]) == 10000002, len(r["result"])
out["reply_10mb"] = sorted(t)[len(t) // 2]
s.run("x = None", mode="python")
time.sleep(1.0)
out["rss_peak"] = proc(pid, "VmHWM")
out["rss_idle"] = proc(pid, "VmRSS")
out["threads"] = proc(pid, "Threads")
out["fds"] = len(os.listdir("/proc/%d/fd" % pid))
s.close()

def peak(n):
    # (a fresh worker: the same warm-up, then n 32 MiB requests back to back; its VmHWM)
    w = S.Session()
    w.run("1", mode="python")
    for _ in range(500):
        w.run("1", mode="python")
    for _ in range(n):
        r = w.run(big32, mode="python", timeout=120)
        assert r["result"] == str(32 << 20), r["result"]
    v = proc(w.proc.pid, "VmHWM")
    w.close()
    return v

out["peak_cold_32mib"] = peak(1)
out["peak_burst_32mib"] = peak(3)
print(json.dumps(out))
'''

ROWS = ["noop", "noop_tput", "req_1mib", "req_32mib", "req_rc_m1", "req_rc", "req_rc_p1", "reply_10mb",
        "peak_cold_32mib", "peak_burst_32mib", "rss_after_32mib", "rss_peak", "rss_idle", "threads", "fds"]
GATED = ["noop", "noop_tput", "req_1mib", "req_32mib", "req_rc_m1", "req_rc", "req_rc_p1", "reply_10mb",
         "peak_cold_32mib", "peak_burst_32mib"]


def sample(py):
    r = subprocess.run([py, "-c", CHILD], capture_output=True, text=True, timeout=1800, cwd="/tmp")
    if r.returncode != 0:
        raise RuntimeError("%s: exit %d: %s" % (py, r.returncode, r.stderr[-800:]))
    return json.loads(r.stdout.strip().splitlines()[-1])


def main():
    args = sys.argv[1:]
    sensitivity = args[:1] == ["--sensitivity"]
    if sensitivity:
        args = args[1:]
    py_a, py_b, out_path = args[:3]
    rounds = int(args[3]) if len(args) > 3 else 5
    raw = []
    for k in range(rounds):
        a1 = sample(py_a)
        b = sample(py_b)
        a2 = sample(py_a)
        raw.append({"a1": a1, "b": b, "a2": a2})
        print("round %d: %s" % (k, json.dumps({row: round(b[row] / ((a1[row] + a2[row]) / 2), 4) for row in ROWS})), flush=True)
    rows = {}
    for row in ROWS:
        ratios = [r["b"][row] / ((r["a1"][row] + r["a2"][row]) / 2) for r in raw]
        m1 = statistics.median([r["b"][row] / r["a1"][row] for r in raw])
        m2 = statistics.median([r["b"][row] / r["a2"][row] for r in raw])
        invalid = row in GATED and (m1 <= 1.01) != (m2 <= 1.01)
        rows[row] = {"median": statistics.median(ratios), "min": min(ratios), "max": max(ratios), "ratios": ratios,
                     "median_b_a1": m1, "median_b_a2": m2, "invalid": invalid,
                     "drift_a2_a1": statistics.median([r["a2"][row] / r["a1"][row] for r in raw]),
                     "a_median": statistics.median([v for r in raw for v in (r["a1"][row], r["a2"][row])]),
                     "b_median": statistics.median([r["b"][row] for r in raw]), "gated": row in GATED,
                     "pass": (not invalid and statistics.median(ratios) <= 1.01) if row in GATED else None}
    if sensitivity:
        r = rows["reply_10mb"]
        caught = r["median"] > 1.01 and (r["median_b_a1"] > 1.01) == (r["median_b_a2"] > 1.01)
        doc = {"mode": "sensitivity", "py_b": py_a, "py_control": py_b, "rounds": rounds, "rows": rows, "raw": raw, "caught": caught}
        with open(out_path, "w") as f:
            json.dump(doc, f, indent=1)
        print("reply_10mb  control/B median %.4f [%.4f, %.4f]  control/B1 %.4f  control/B2 %.4f  B2/B1 %.4f" % (
            r["median"], r["min"], r["max"], r["median_b_a1"], r["median_b_a2"], r["drift_a2_a1"]))
        print("the control is " + ("CAUGHT (> 1.01, both sides agreeing)" if caught else "NOT caught"))
        return
    doc = {"py_a": py_a, "py_b": py_b, "rounds": rounds, "rows": rows, "raw": raw,
           "ok": all(r["pass"] for r in rows.values() if r["gated"])}
    with open(out_path, "w") as f:
        json.dump(doc, f, indent=1)
    for row in ROWS:
        r = rows[row]
        print("%-15s B/A median %.4f [%.4f, %.4f]  B/A1 %.4f  B/A2 %.4f  A2/A1 %.4f  A %s  B %s  %s" % (
            row, r["median"], r["min"], r["max"], r["median_b_a1"], r["median_b_a2"], r["drift_a2_a1"], r["a_median"], r["b_median"],
            "" if r["pass"] is None else ("INVALID (B/A1 and B/A2 on opposite sides of 1.01: rerun)" if r["invalid"] else "ok" if r["pass"] else "OVER 1.01")))
    print("ok" if doc["ok"] else "over the gate")


if __name__ == "__main__":
    main()
