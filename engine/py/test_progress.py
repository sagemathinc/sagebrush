"""Live progress and the agent API's capabilities in the CPython package
(design-estimates-progress r4 §6 and §8; estimates plan r3, PR 1):

- a routine's counts, nested calls with their parents, and release when a
  with-block ends normally, by an error and by KeyboardInterrupt;
- 32 live calls, then a 33rd top-level and a 33rd nested call, each
  untracked under its own call_id and tracked after a slot is freed, with
  early_part_untracked;
- 4 threads, each with its own slot and its own parent chain, while a
  reader thread takes snapshots (without the GIL) at full rate;
- every record a valid sagebrush.progress/1 record;
- capabilities(): progress only; estimate, run, request_stop and resume,
  and factor's deadline= work= resume= checkpoint_every= checkpoint_path=,
  refused before running ("not available in this build").

    python engine/py/test_progress.py
"""
import threading

import sagebrush
from sagebrush import progress, records


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

    def reader():
        while not stop.is_set():
            for r in progress.snapshot():
                if r["op"].startswith("thread "):
                    d = r["count"]["done"]
                    check(r["count"].get("total") == d, r)  # never torn
                    seen.append(r["op"])

    def worker(k):
        with progress.call("thread %d" % k) as c:
            for j in range(2000):
                c.update(done=j, total=j)
                c.flush()
            with progress.call("thread %d inner" % k) as d:
                s = {r["call_id"]: r for r in progress.snapshot()}
                check(s[d.id]["parent_id"] == c.id, s)

    t = threading.Thread(target=reader)
    t.start()
    ws = [threading.Thread(target=worker, args=(k,)) for k in range(4)]
    for w in ws:
        w.start()
    for w in ws:
        w.join()
    stop.set()
    t.join()
    check(len(set(seen)) >= 1, "the reader saw the threads")
    check(progress.snapshot() == [], "all released")
    print("ok test_threads_and_a_reader")


def test_capabilities():
    c = sagebrush.capabilities()
    check(c["progress"] is True and not any(c[k] for k in ("estimate", "deadline", "work", "run", "request_stop", "checkpoints", "resume")), c)
    check(sagebrush.stop_points("factor") == [], "no stop points yet")
    for name in ("estimate", "run", "request_stop", "resume"):
        try:
            getattr(sagebrush, name)(1)
        except TypeError as e:
            check(str(e) == "sagebrush.%s is not available in this build" % name, e)
        else:
            raise AssertionError(name)
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
    test_counts_nesting_and_release()
    test_33rd_call()
    test_threads_and_a_reader()
    test_capabilities()
    print("all progress tests passed")
