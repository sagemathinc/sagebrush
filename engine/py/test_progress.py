"""Live progress and the agent API's capabilities in the CPython package
(design-estimates-progress r4 §6 and §8; estimates plan r3, PR 1):

- a routine's counts, nested calls with their parents, and release when a
  with-block ends normally, by an error and by KeyboardInterrupt;
- 32 live calls, then a 33rd top-level and a 33rd nested call, each
  untracked under its own call_id and tracked after a slot is freed, with
  early_part_untracked;
- 4 threads, each with its own slot and its own parent chain, while a
  reader thread takes snapshots (without the GIL) at full rate; every
  thread's exception is re-raised, and an injected reader or worker
  failure makes the run exit nonzero (the mutation check);
- a call begun on one thread and ended on another leaves the first
  thread's next call top-level;
- every record a valid sagebrush.progress/1 record;
- capabilities(): progress and estimates (PR 2a); run and resume (request_stop comes with PR 5a),
  and factor's deadline= work= resume= checkpoint_every= checkpoint_path=,
  refused before running ("not available in this build").

    python engine/py/test_progress.py
"""
import os
import subprocess
import sys
import threading

import sagebrush
from sagebrush import progress, records

# a failure to inject (the mutation check of test_thread_failures_fail_the_run):
# "reader" or "worker" makes that thread raise
INJECT = os.environ.get("SAGEBRUSH_TEST_PROGRESS_INJECT", "")


def run_threads(targets):
    """Runs each (function, args) on its own thread and re-raises the first
    exception any of them raised (Thread.join alone would swallow it)."""
    errors = []

    def wrap(f, args):
        try:
            f(*args)
        except BaseException as e:  # (an AssertionError, or anything)
            errors.append(e)

    ts = [threading.Thread(target=wrap, args=(f, args)) for f, args in targets]
    for t in ts:
        t.start()
    return ts, errors


def check(cond, what):
    if not cond:
        raise AssertionError(what)


def mine(ids):
    return [r for r in progress.snapshot() if r["call_id"] in ids]


def test_counts_nesting_and_release():
    with progress.call("outer") as o:
        o.update(stage="steps", done=5, total=10, unit="steps")
        o.flush()
        with progress.call("inner") as i:
            s = {r["call_id"]: r for r in progress.snapshot()}
            check(s[o.id]["count"] == {"done": 5, "total": 10, "unit": "steps", "label": "counted"}, s)
            check(s[i.id]["parent_id"] == o.id and s[o.id]["parent_id"] == 0, s)
            for r in s.values():
                records.validate(r)
    check(progress.snapshot() == [], "released")
    for exc in (ValueError, KeyboardInterrupt):
        try:
            with progress.call("failing"):
                raise exc()
        except exc:
            pass
        check(progress.snapshot() == [], "released after %s" % exc.__name__)
    print("ok test_counts_nesting_and_release")


def test_33rd_call():
    live = [progress.call("live") for _ in range(32)]
    top = progress.call("top")
    un = [r for r in progress.snapshot() if r.get("status") == "untracked"]
    check([r["call_id"] for r in un] == [top.id], un)
    check(un[0]["reason"] == records.UNTRACKED_REASON and "count" not in un[0], un)
    records.validate(un[0])
    live.pop(5).end()
    top.update(done=1)
    top.flush()
    r = mine([top.id])[0]
    check(r["status"] == "running" and r.get("early_part_untracked") is True, r)
    records.validate(r)
    top.end()
    for c in live:
        c.end()
    check(progress.snapshot() == [], "all released")
    print("ok test_33rd_call")


def test_threads_and_a_reader():
    stop = threading.Event()
    seen = []
    # (each worker keeps its call open until the reader has seen it: under
    # load the reader could otherwise be scheduled only after every worker
    # had finished, and see none; the dispatch at e4e09807 did)
    saw = [threading.Event() for _ in range(4)]
    readers = []

    def reader():
        if INJECT == "reader":
            raise AssertionError("injected reader failure")
        while not stop.is_set():
            for r in progress.snapshot():
                if r["op"].startswith("thread ") and not r["op"].endswith(" inner"):
                    n = r["count"]
                    # a call's first record has no total yet (unknown) and done 0;
                    # after that, total == done always (never torn)
                    if "total" in n:
                        check(n["total"] == n["done"], r)
                    else:
                        check(n["done"] == 0, r)
                    seen.append(r["op"])
                    saw[int(r["op"].split()[1])].set()

    def worker(k):
        if INJECT == "worker" and k == 2:
            raise AssertionError("injected worker failure")
        with progress.call("thread %d" % k) as c:
            for j in range(2000):
                c.update(done=j, total=j)
                c.flush()
            # (while the reader runs: a failed reader ends the wait, and
            # its error is the run's)
            while not saw[k].wait(0.05) and readers[0].is_alive():
                pass
            with progress.call("thread %d inner" % k) as d:
                s = {r["call_id"]: r for r in progress.snapshot()}
                check(s[d.id]["parent_id"] == c.id, s)

    (rt,), rerr = run_threads([(reader, ())])
    readers.append(rt)
    ws, werr = run_threads([(worker, (k,)) for k in range(4)])
    for w in ws:
        w.join()
    stop.set()
    rt.join()
    for e in rerr + werr:
        raise e
    check(sorted(set(seen)) == ["thread %d" % k for k in range(4)], "the reader saw the threads: %r" % sorted(set(seen)))
    check(progress.snapshot() == [], "all released")
    print("ok test_threads_and_a_reader")


def test_thread_failures_fail_the_run():
    # the mutation check: an injected reader or worker failure makes this
    # file's run exit nonzero (a thread's exception is never swallowed)
    for what in ("reader", "worker"):
        env = dict(os.environ, SAGEBRUSH_TEST_PROGRESS_INJECT=what)
        r = subprocess.run([sys.executable, __file__, "--threads-only"], env=env, capture_output=True, text=True)
        check(r.returncode != 0, "an injected %s failure exits %d" % (what, r.returncode))
        check("injected %s failure" % what in r.stderr, r.stderr[-500:])
    print("ok test_thread_failures_fail_the_run")


def test_call_ended_on_another_thread():
    # a call begun on thread A and ended on thread B: A's next call is
    # top-level, not a child of the ended one (CORR-PR124-3)
    box, go, out = [], threading.Event(), []

    def a():
        box.append(progress.call("begun on A"))
        go.wait()
        with progress.call("A's next") as n:
            out.append([r for r in progress.snapshot() if r["call_id"] == n.id][0]["parent_id"])

    (t,), errs = run_threads([(a, ())])
    while not box:
        pass
    box[0].end()  # here, on another thread
    go.set()
    t.join()
    for e in errs:
        raise e
    check(out == [0], "A's next call's parent: %r" % out)
    check(progress.snapshot() == [], "all released")
    print("ok test_call_ended_on_another_thread")


def test_capabilities():
    c = sagebrush.capabilities()
    check(c["progress"] is True and c["estimate"] is True
          and not any(c[k] for k in ("deadline", "work", "run", "request_stop", "checkpoints", "resume")), c)
    check(sagebrush.stop_points("factor") == [], "no stop points yet")
    from sagebrush.sage import factor as sage_factor
    e = sagebrush.estimate(sage_factor, 2 ** 300 + 1)
    records.validate(dict(e))
    check(e["op"] == "factor" and e["total_time"] is None and e["stages"], e)
    check(all(s["success"]["p_typical"] == s["success"]["p_high"] for s in e["stages"] if s["success"]), e)
    for name in ("run", "resume"):
        try:
            getattr(sagebrush, name)(1)
        except TypeError as e:
            check(str(e) == "sagebrush.%s is not available in this build" % name, e)
        else:
            raise AssertionError(name)
    check(not hasattr(sagebrush, "request_stop"), "request_stop comes with PR 5a")
    from sagebrush.sage import factor
    for opt in records.LATER_OPTIONS:
        try:
            factor(2 ** 64 + 1, **{opt: 1})
        except TypeError as e:
            check(str(e) == "factor(): %s= is not available in this build" % opt, e)
        else:
            raise AssertionError(opt)
    print("ok test_capabilities")


if __name__ == "__main__":
    if sys.argv[1:] == ["--threads-only"]:
        test_threads_and_a_reader()
        sys.exit(0)
    test_counts_nesting_and_release()
    test_33rd_call()
    test_threads_and_a_reader()
    test_thread_failures_fail_the_run()
    test_call_ended_on_another_thread()
    test_capabilities()
    print("all progress tests passed")
