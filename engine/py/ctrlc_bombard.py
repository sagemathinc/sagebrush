"""Ctrl-C PR B's bombardment (plan-ctrlc-fixes r2 §3a, r3 and r4 notes): the
native request loop under interrupts at random points.  VM only, not CI.

    python3 engine/py/ctrlc_bombard.py [N] [WALL_S]

Two phases on one Session, N requests each (default 2000), each request
appending its index to a log as its first statement, then sleeping 0-5 ms
in Python:

1. targeted only: the parent writes interrupt(id) at random points, for the
   running request or for one already answered (stale).  Strict: a request
   whose reply says interrupted had an interrupt for its own id sent; no
   stale one ever ends a newer request.
2. the storm: as 1, plus external SIGINTs to the worker every 50-500 us, and
   inside the worker a SIGALRM timer whose handler raises KeyboardInterrupt
   (board's storm: an interrupt at any bytecode, the loop's own callbacks
   included).

After each: admitted = replied (the worker's native counts), N replies, each
with its request's id, none twice, no restart, the worker alive, and the log
phase-correct: each index at most once (no replay), every request that
finished normally in it, with its own result.  One JSON line of results;
exit 1 on any failure.  WALL_S (default 900, the plan's 15 min per version)
bounds the whole run, half for each phase: a phase that runs over fails.
Against PR A's worker (the control) interrupts are untargeted SIGINTs and
there are no native counts; the same checks run on the replies and the log.
"""

import json
import os
import random
import signal
import sys
import threading
import time

import sagebrush.session as S

N = int(sys.argv[1]) if len(sys.argv) > 1 else 2000
WALL_S = float(sys.argv[2]) if len(sys.argv) > 2 else 900.0  # (the whole run's: each phase gets half)


def interrupt(s, rid):
    # (the control run, on PR A's worker: Session.interrupt() takes no id there, and signals whatever runs)
    try:
        s.interrupt(rid)
    except TypeError:
        s.interrupt()


def quiet_run(s, code, tries=50):
    # (in the storm any request can be interrupted, these too: retried)
    for _ in range(tries):
        r = s.run(code, mode="python", timeout=60)
        if r["error"] is None:
            return r
    raise RuntimeError("%r never ran uninterrupted" % code)


def stats(s):
    # (None on PR A's worker: no native loop, so no native counts)
    r = quiet_run(s, "import sagebrush._native as _n; getattr(_n, '_serve_stats', lambda: None)()")
    return eval(r["result"]) if r["result"] else None


def phase(s, name, storm):
    rng = random.Random(name)
    quiet_run(s, "log = []")
    base = stats(s)
    gen = s.generation
    t_end = time.monotonic() + WALL_S / 2
    stop = threading.Event()
    sent = {}  # id -> interrupts targeted at it
    replies = {}
    problems = []
    sigints = [0]
    if storm:
        quiet_run(s, "import signal\n"
                     "def _alarm(*a):\n    raise KeyboardInterrupt\n"
                     "signal.signal(signal.SIGALRM, _alarm)\n"
                     "signal.setitimer(signal.ITIMER_REAL, 0.003, 0.003)")

        def storm_sigints(r=random.Random(name + "-sigint")):
            while not stop.is_set():
                try:
                    os.kill(s.proc.pid, signal.SIGINT)
                except OSError:
                    return
                sigints[0] += 1
                time.sleep(r.uniform(50e-6, 500e-6))
        threading.Thread(target=storm_sigints, daemon=True).start()
    done_ids = []
    for i in range(N):
        if time.monotonic() > t_end:
            problems.append("over the wall budget at request %d" % i)
            break
        code = "log.append(%d)\nimport time\ntime.sleep(%r)\n%d" % (i, rng.uniform(0, 0.005), i)
        rid = s._send(code, "python", False, False)
        # (targeted interrupts: for this request at a random point, or a stale one)
        k = rng.random()
        if k < 0.3:
            time.sleep(rng.uniform(0, 0.006))
            interrupt(s, rid)
            sent[rid] = sent.get(rid, 0) + 1
        elif k < 0.5 and done_ids:
            old = rng.choice(done_ids[-5:])
            interrupt(s, old)
            sent[old] = sent.get(old, 0) + 1
        r = s._get(rid, 60)
        if not r:
            problems.append("request %d (id %d): %s" % (i, rid, "the worker died" if r is None else "no reply in 60 s"))
            break
        if r.get("id") != rid or rid in replies:
            problems.append("request %d: reply id %r for %d" % (i, r.get("id"), rid))
        replies[rid] = (i, r)
        done_ids.append(rid)
    stop.set()
    if storm:
        time.sleep(0.05)
        quiet_run(s, "import signal; signal.setitimer(signal.ITIMER_REAL, 0); signal.signal(signal.SIGALRM, signal.SIG_DFL)")
        time.sleep(0.2)
    log = eval(quiet_run(s, "log")["result"])
    st = stats(s)
    native = st is not None and base is not None
    admitted = st["admitted"] - base["admitted"] if native else None
    replied = st["replied"] - base["replied"] if native else None
    interrupted = [rid for rid, (i, r) in replies.items() if (r.get("error_info") or {}).get("type") == "interrupted"]
    finished = [i for rid, (i, r) in replies.items() if r.get("error") is None]
    if len(log) != len(set(log)):
        problems.append("replayed: %d duplicate log entries" % (len(log) - len(set(log))))
    missing = [i for i in finished if i not in set(log)]
    if missing:
        problems.append("finished but not in the log: %r" % missing[:10])
    wrong = [i for rid, (i, r) in replies.items() if r.get("error") is None and r.get("result") != str(i)]
    if wrong:
        problems.append("results not their own: %r" % wrong[:10])
    others = [i for rid, (i, r) in replies.items() if r.get("error") is not None and (r.get("error_info") or {}).get("type") != "interrupted"]
    if others:
        problems.append("errors other than interrupted: %r" % [replies_err(replies, i) for i in others[:5]])
    if not storm:
        unearned = [rid for rid in interrupted if not sent.get(rid)]
        if unearned:
            problems.append("interrupted with no interrupt for their id (a stale one ended them): %r" % unearned[:10])
    # (the quiet_run requests in between are admitted and replied too: the stats request itself is the one not yet replied)
    if native and admitted != replied:
        problems.append("admitted %d != replied %d" % (admitted, replied))
    if len(replies) != N:
        problems.append("%d replies for %d requests" % (len(replies), N))
    if s.generation != gen or not s.alive():
        problems.append("restarted or dead")
    return {"phase": name, "n": N, "replies": len(replies), "interrupted": len(interrupted), "targeted_sent": sum(sent.values()),
            "sigints": sigints[0], "log": len(log), "admitted": admitted, "replied": replied, "native": native,
            "stale": st["stale"] - base["stale"] if native else None, "woken": st["woken"] - base["woken"] if native else None,
            "late": st["late"] - base["late"] if native else None, "problems": problems}


def replies_err(replies, i):
    for rid, (j, r) in replies.items():
        if j == i:
            return (i, (r.get("error") or "")[:120])


def main():
    s = S.Session()
    t0 = time.monotonic()
    out = {"python": sys.version.split()[0], "results": []}
    try:
        for name, storm in (("targeted", False), ("storm", True)):
            t = time.monotonic()
            try:
                r = phase(s, name, storm)
            except Exception as e:
                r = {"phase": name, "problems": ["raised %s: %s" % (type(e).__name__, e)]}
            r["seconds"] = round(time.monotonic() - t, 1)
            out["results"].append(r)
    finally:
        s.close()
    out["seconds"] = round(time.monotonic() - t0, 1)
    out["ok"] = all(not r["problems"] for r in out["results"])
    print(json.dumps(out))
    sys.exit(0 if out["ok"] else 1)


if __name__ == "__main__":
    main()
