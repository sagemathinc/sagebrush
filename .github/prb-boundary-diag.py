"""PR B's Windows RC-1 boundary diagnostic (daybreak2's r1 review of the req_rc_m1 OVER, run 40643092091): causal-only,
NON-GATING, on run 40643092091's own frozen wheels.  It never amends that run's FAIL and selects no fix by itself.

    python prb-boundary-diag.py PY_A PY_B OUT.json [ROUNDS]

C = READ_CHUNK = 65536; the lengths are framed (the request line, newline included): m1 = C-1, rc = C, p1 = C+1.
Twelve conditions, each in its OWN fresh worker (Session), each with exactly ONE timed block (200 requests of one length):

- E1, the reader regime (H1's intervention), prelude P0 (the 500-request warm-up only), lengths m1/rc/p1 x regime K/Z.
  An UNTIMED prep request, written by the parent on a predeclared schedule, sets B's input buffer:
  - K: a request of framed length C, written as 16 fragments of 4096 bytes, flushed, with an untimed 50 ms wait after
    each (so each fragment is a separate read): the buffer doubles 4096 -> ... -> 65536 = C and is KEPT (<= C).  The m1
    and rc targets then fit it: no reader allocation at all.  p1 (C+1) can't fit: it is the in-condition control.
  - Z: a request of framed length 70000, written on the SAME schedule (16 writes: 15 fragments of 4096 bytes and the
    8560-byte rest, the same fifteen 50 ms waits; daybreak2's r2 item 2): the buffer ends > C, so Windows releases it at
    the next request (the stats request), and the targets start from that verified LOW-capacity start (the stats
    line's own small buffer).
  Verified on B with the existing _serve_stats counters, before and after the timed block (A has none: not checked):
  K needs input_capacity == C after the prep and, for m1/rc, input_releases unchanged and input_capacity == C after the
  block (so zero reader allocations); Z's start needs exactly one release at the request after the prep and
  input_capacity < 4096 then.  Z's TIMED regime (daybreak2's r2 item 1), per length, from the block's release delta in
  every B sample: RECURRING if it is 200 in every sample (every target released and regrew: the terminal stats request
  counts target 200), NONE if 0 in every sample, MIXED otherwise.  A failed E1 check, or a Z regime that isn't
  RECURRING for m1, leaves H1 UNRESOLVED (reported as such); E2 stays usable, and the run still completes.
- E2, the prelude (H2), regime natural (no prep), lengths m1/rc/p1 x prelude P0 / P1, P1 = the warm-up, then 3 x 32 MiB
  requests, `x = None` and an idle sleep(1.0) (ctrlc_perf.py's own sequence before its rc rows).

The observation (astra's r1 item 3): a stats request is itself a request, so what it reports is the state after its own
next(): input_capacity is the buffer's capacity once the stats line is read, and input_releases includes a release that its
own next() made (a consumed buffer > C, on Windows).  That is used deliberately, with exact accounting:
  - after the K prep, the buffer (exactly C) is not > C, so the stats request can't release it and reports C;
  - after the Z prep (> C), the stats request's own next() releases it: exactly +1, and then a small capacity;
  - around a timed block: "before" is a small stats line read just before target 1, so target 1 can't release anything;
    each target i > 1 releases iff target i-1 ended > C, and the "after" stats request releases iff target 200 did.  So
    after.releases - before.releases = the number of the 200 targets whose own buffer ended > C (the release-regrow
    cycles of that block, reported per condition as descriptive data; in K for m1/rc it must be 0).
H2, restated (astra's r1 item 4): B lets its ~32 MiB input buffer go at the start of the `x = None` request, before the
sleep and before the timed block, so no large free happens inside the timed m1 block.  H2 can only be a persistent
effect of that history (the process heap after the 32 MiB requests and their release), which E2 tests as prelude x length.
A sample runs all twelve conditions in a fixed list rotated by the round (the same rotation for A1, B and A2 of a round).
Only the 200 target requests are timed (the median per condition); the warm-up, the preludes, the prep, its waits and the
stats requests are not.  Each child runs in a fresh TemporaryDirectory with resolved interpreters and the cwd/executable
handshake (as ctrlc_perf.py r5f).

Per condition: B/A median over rounds of B / mean(A1, A2), and the bracket medians B/A1 and B/A2.  OVER: all three
> 1.01.  UNDER: all three <= 1.01.  Otherwise STRADDLE.  The decision table (frozen with this script):
  H1 (reader regime), only if every E1 check passed (else UNRESOLVED, E1 not established): REJECTED if E1 m1-K is OVER
     (the excess with verified zero reader allocations); SUPPORTED if E1 m1-K is UNDER, E1 m1-Z is OVER and m1's Z
     regime is RECURRING; otherwise UNRESOLVED.
  H2 (prelude/position): SUPPORTED if E2 m1-P1 is OVER and E2 m1-P0 is UNDER; REJECTED_PRELUDE if both are OVER (the
     excess doesn't depend on the 32 MiB prelude; its cause stays unresolved: daybreak2's r2 item 3); otherwise
     UNRESOLVED.
  H3 (not reproduced): if no m1 condition (E1 K, E1 Z, E2 P0, E2 P1) is OVER.
Every condition is reported (the full matrices, raw samples, the stats); nothing is dropped, retried or pooled.
Exit 0 once the run is complete (whatever the decision, E1's checks included); nonzero only if it couldn't complete.
"""
import ast
import json
import os
import shutil
import statistics
import subprocess
import sys
import tempfile

CHILD = r'''
import ast, json, os, sys, time
import sagebrush.session as S

C = 1 << 16
ROT = int(sys.argv[1])
LENGTHS = {"m1": C - 1, "rc": C, "p1": C + 1}
CONDS = [("E1", L, "K") for L in LENGTHS] + [("E1", L, "Z") for L in LENGTHS] + \
        [("E2", L, "P0") for L in LENGTHS] + [("E2", L, "P1") for L in LENGTHS]
out = {"cwd": os.getcwd(), "executable": sys.executable, "conds": {}}

def stats(s):
    r = s.run("import sagebrush._native as _n; getattr(_n, '_serve_stats', lambda: None)()", mode="python")
    assert r["error"] is None, r["error"]
    v = ast.literal_eval(r["result"]) if r["result"] is not None else None
    return None if v is None else {"capacity": v["input_capacity"], "releases": v["input_releases"]}

def code_for(rid, n):
    # (code whose request line, as Session._send frames it, newline included, is n bytes)
    req = lambda code: json.dumps({"id": rid, "code": code, "mode": "python", "isolated": False, "data": False}) + "\n"
    code = "x='" + "a" * (n - len(req("x=''"))) + "'"
    assert len(req(code).encode("utf-8")) == n, (len(req(code)), n)
    return code

def prep(s, n, sizes, wait):
    # (one untimed request of framed length n, written by the parent in fragments of the given sizes (the last
    # fragment takes the rest), each flushed, with an untimed wait after each but the last)
    def send(code, mode, isolated, data):
        s.last_id += 1
        rid = s.last_id
        b = (json.dumps({"id": rid, "code": code, "mode": mode, "isolated": isolated, "data": data}) + "\n").encode("utf-8")
        assert len(b) == n, (len(b), n)
        at = 0
        for k, size in enumerate(sizes):
            piece = b[at:] if k == len(sizes) - 1 else b[at:at + size]
            s.proc.stdin.write(piece)
            s.proc.stdin.flush()
            at += len(piece)
            if k < len(sizes) - 1:
                time.sleep(wait)
        assert at == n, (at, n)
        return rid
    s._send = send
    try:
        r = s.run(code_for(s.last_id + 1, n), mode="python")
    finally:
        del s._send
    assert r["error"] is None, r["error"]

big32 = "x = '" + "a" * (32 << 20) + "'\nlen(x)"
for i in range(len(CONDS)):
    exp, L, how = CONDS[(i + ROT) % len(CONDS)]
    n = LENGTHS[L]
    s = S.Session()
    s.run("1", mode="python")
    for _ in range(500):  # (the warm-up, as ctrlc_perf.py's)
        assert s.run("1", mode="python")["result"] == "1"
    rec = {}
    if how == "P1":
        for _ in range(3):
            r = s.run(big32, mode="python", timeout=120)
            assert r["result"] == str(32 << 20), r["result"]
        s.run("x = None", mode="python")
        time.sleep(1.0)
    rec["before_prep"] = stats(s)
    if how == "K":
        prep(s, C, [4096] * 16, 0.05)
    elif how == "Z":
        prep(s, 70000, [4096] * 15 + [8560], 0.05)
    rec["before"] = stats(s)
    t = []
    for _ in range(200):
        code = code_for(s.last_id + 1, n)
        a = time.perf_counter(); r = s.run(code, mode="python"); t.append(time.perf_counter() - a)
        assert r["error"] is None, r["error"]
    rec["after"] = stats(s)
    rec["median"] = sorted(t)[len(t) // 2]
    s.close()
    out["conds"]["%s-%s-%s" % (exp, L, how)] = rec
print(json.dumps(out))
'''

C = 1 << 16
NAMES = ["E1-%s-%s" % (L, h) for h in ("K", "Z") for L in ("m1", "rc", "p1")] + \
        ["E2-%s-%s" % (L, h) for h in ("P0", "P1") for L in ("m1", "rc", "p1")]


def resolve(py):
    found = shutil.which(py)
    if found is None:
        raise SystemExit("not an interpreter: %r" % py)
    return os.path.abspath(found)


def sample(py, rot):
    with tempfile.TemporaryDirectory(prefix="prb-boundary-diag-", ignore_cleanup_errors=True) as d:
        r = subprocess.run([py, "-c", CHILD, str(rot)], capture_output=True, text=True, timeout=3600, cwd=d)
        if r.returncode != 0:
            raise RuntimeError("%s: exit %d: %s" % (py, r.returncode, r.stderr[-1500:]))
        v = json.loads(r.stdout.strip().splitlines()[-1])
        if not (os.path.isdir(v["cwd"]) and os.path.samefile(v["cwd"], d)):
            raise RuntimeError("%s: the child ran in %r, not %r" % (py, v["cwd"], d))
        if not (v["executable"] and os.path.exists(v["executable"]) and os.path.samefile(v["executable"], py)):
            raise RuntimeError("%s: the child ran as %r" % (py, v["executable"]))
    return v["conds"]


def verify(b):
    """The regime checks on one B sample: a list of failures (empty: valid)."""
    bad = []
    for L in ("m1", "rc", "p1"):
        k = b["E1-%s-K" % L]
        if k["before"] is None or k["before"]["capacity"] != C:
            bad.append("K %s: capacity after the prep %r, not %d" % (L, k["before"], C))
        if L != "p1" and (k["after"] is None or k["after"]["capacity"] != C or k["after"]["releases"] != k["before"]["releases"]):
            bad.append("K %s: the kept buffer didn't hold through the block: %r -> %r" % (L, k["before"], k["after"]))
        z = b["E1-%s-Z" % L]
        if z["before"] is None or z["before_prep"] is None or z["before"]["releases"] != z["before_prep"]["releases"] + 1 \
                or z["before"]["capacity"] >= 4096:
            bad.append("Z %s: no single release after the prep: %r -> %r" % (L, z["before_prep"], z["before"]))
    return bad


def classify(row):
    m, b1, b2 = row["median"], row["median_b_a1"], row["median_b_a2"]
    if m > 1.01 and b1 > 1.01 and b2 > 1.01:
        return "OVER"
    if m <= 1.01 and b1 <= 1.01 and b2 <= 1.01:
        return "UNDER"
    return "STRADDLE"


def main():
    args = sys.argv[1:]
    py_a, py_b = resolve(args[0]), resolve(args[1])
    out_path = args[2]
    rounds = int(args[3]) if len(args) > 3 else 5
    raw, e1_failures = [], []
    for k in range(rounds):
        a1 = sample(py_a, k)
        b = sample(py_b, k)
        a2 = sample(py_a, k)
        raw.append({"a1": a1, "b": b, "a2": a2})
        e1_failures += ["round %d: %s" % (k, e) for e in verify(b)]
        print("round %d: %s" % (k, json.dumps({c: round(b[c]["median"] / ((a1[c]["median"] + a2[c]["median"]) / 2), 4) for c in NAMES})), flush=True)
    rows = {}
    for c in NAMES:
        ratios = [r["b"][c]["median"] / ((r["a1"][c]["median"] + r["a2"][c]["median"]) / 2) for r in raw]
        rows[c] = {"median": statistics.median(ratios), "ratios": ratios,
                   "median_b_a1": statistics.median([r["b"][c]["median"] / r["a1"][c]["median"] for r in raw]),
                   "median_b_a2": statistics.median([r["b"][c]["median"] / r["a2"][c]["median"] for r in raw]),
                   "a_median": statistics.median([v for r in raw for v in (r["a1"][c]["median"], r["a2"][c]["median"])]),
                   "b_median": statistics.median([r["b"][c]["median"] for r in raw]),
                   "b_releases_in_block": [r["b"][c]["after"]["releases"] - r["b"][c]["before"]["releases"]
                                           if r["b"][c]["after"] and r["b"][c]["before"] else None for r in raw]}
        rows[c]["class"] = classify(rows[c])
    cl = {c: rows[c]["class"] for c in NAMES}
    z_regime = {}
    for L in ("m1", "rc", "p1"):
        d = rows["E1-%s-Z" % L]["b_releases_in_block"]
        z_regime[L] = "RECURRING" if all(x == 200 for x in d) else "NONE" if all(x == 0 for x in d) else "MIXED"
    if e1_failures:
        h1 = "UNRESOLVED (E1 not established)"
    elif cl["E1-m1-K"] == "OVER":
        h1 = "REJECTED"
    elif cl["E1-m1-K"] == "UNDER" and cl["E1-m1-Z"] == "OVER" and z_regime["m1"] == "RECURRING":
        h1 = "SUPPORTED"
    else:
        h1 = "UNRESOLVED"
    if cl["E2-m1-P1"] == "OVER" and cl["E2-m1-P0"] == "UNDER":
        h2 = "SUPPORTED"
    elif cl["E2-m1-P1"] == "OVER" and cl["E2-m1-P0"] == "OVER":
        h2 = "REJECTED_PRELUDE (cause unresolved)"
    else:
        h2 = "UNRESOLVED"
    h3 = not any(cl[c] == "OVER" for c in ("E1-m1-K", "E1-m1-Z", "E2-m1-P0", "E2-m1-P1"))
    doc = {"py_a": py_a, "py_b": py_b, "rounds": rounds, "rows": rows, "raw": raw, "e1_failures": e1_failures,
           "z_regime": z_regime, "decision": {"H1": h1, "H2": h2, "H3_not_reproduced": h3}, "gating": False}
    with open(out_path, "w") as f:
        json.dump(doc, f, indent=1)
    for c in NAMES:
        r = rows[c]
        print("%-10s B/A median %.4f [%.4f, %.4f]  B/A1 %.4f  B/A2 %.4f  A %.6f  B %.6f  B releases/block %s  %s" % (
            c, r["median"], min(r["ratios"]), max(r["ratios"]), r["median_b_a1"], r["median_b_a2"], r["a_median"],
            r["b_median"], r["b_releases_in_block"], r["class"]))
    for e in e1_failures:
        print("E1 NOT ESTABLISHED: " + e)
    print("Z regime (B release delta per block, every sample): %s" % json.dumps(z_regime))
    print("DECISION (diagnostic, non-gating): H1 %s  H2 %s  H3 not reproduced: %s" % (h1, h2, h3))


if __name__ == "__main__":
    main()
