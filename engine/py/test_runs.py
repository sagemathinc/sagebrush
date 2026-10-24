"""Checks of the runs (H′1a: sagebrush.runs, the store; sagebrush.runner,
the runs of the sage and python tools), with a fake session the test
drives, so that every ending (a return, an error, an interrupt, a session
that doesn't stop, one that dies) happens exactly when the test says.  The
MCP tools around them are checked end to end in test_mcp.py.

    python engine/py/test_runs.py
"""
import json
import os
import queue
import stat
import sys
import tempfile
import threading
import time

from sagebrush import runner as RN
from sagebrush import runs as R


class FakeSession:
    """A session whose computations end when the test says: submit() leaves
    the code pending; finish() replies; interrupt() replies with an
    interrupt unless stubborn; restart() ends the process (None) and starts
    a new generation."""

    def __init__(self):
        self.generation = 1
        self.q = queue.Queue()
        self.pending = None
        self.interrupts = 0
        self.stubborn = False
        self.live = True
        self.restarts = 0
        self.closed = False
        self.gate = None  # (a restart waits for it when set)
        self.submit_gate = None  # (and a submit, once in_submit is set)
        self.in_submit = threading.Event()

    def alive(self):
        return self.live

    def submit(self, code, mode="sage", isolated=False, data=False):
        if self.submit_gate is not None:
            self.in_submit.set()
            self.submit_gate.wait(10)
        if not self.live:
            self.generation += 1
            self.q = queue.Queue()
            self.live = True
        self.pending = code
        if code.startswith("auto:"):
            self.finish(code[5:])
        return self.generation, self.q

    def finish(self, result=None, stdout="", error_info=None):
        # (output streams first, in chunks, as the real worker sends it)
        for i in range(0, len(stdout), 64 * 1024):
            self.q.put({"out": stdout[i:i + 64 * 1024]})
        r = {"stdout": stdout, "result": result, "error": None if error_info is None else error_info["message"],
             "error_info": error_info, "displays": [], "seconds": 0.01}
        self.pending = None
        self.q.put(r)

    def interrupt(self):
        self.interrupts += 1
        if not self.stubborn and self.pending is not None:
            self.finish(error_info={"type": "interrupted", "exception": "KeyboardInterrupt", "message": "the computation was interrupted",
                                    "traceback": "KeyboardInterrupt", "at": time.time()})

    def die(self):
        self.live = False
        self.pending = None
        self.q.put(None)

    def restart(self):
        # (as Session.restart: the old process is killed, so its run ends,
        # then a new one starts, which can take a while)
        self.pending = None
        self.q.put(None)
        if self.gate is not None:
            self.gate.wait(10)
        self.restarts += 1
        self.generation += 1
        self.q = queue.Queue()

    def close(self):
        self.closed = True


def fresh(env=None, owner=None, root=None):
    root = root or tempfile.mkdtemp(prefix="sb-runs-")
    e = {"SAGEBRUSH_RUNS_STORE_BYTES": str(64 * R.MiB)}
    e.update(env or {})
    return R.Store(root=os.path.join(root, "runs"), env=e, owner=owner)


def runner(store=None):
    made = []

    def factory():
        made.append(FakeSession())
        return made[-1]

    r = RN.Runner(store=store or fresh(), session_factory=factory)
    r.made = made
    return r


def until(cond, what, limit=5.0):
    t0 = time.time()
    while not cond():
        if time.time() - t0 > limit:
            raise AssertionError("timed out waiting for " + what)
        time.sleep(0.01)


def refused(kind, f, *a, **k):
    try:
        f(*a, **k)
    except RN.Refused as e:
        assert e.kind == kind, (kind, e.kind, str(e))
        return e
    raise AssertionError("not refused (%s)" % kind)


def test_settings():
    assert R.settings({})["SAGEBRUSH_RUNS_KEEP_DAYS"] == 7
    assert R.settings({"SAGEBRUSH_RUNS_KEEP_COUNT": "10"})["SAGEBRUSH_RUNS_KEEP_COUNT"] == 10
    for name, bad in [("SAGEBRUSH_RUNS_KEEP_DAYS", "0"), ("SAGEBRUSH_RUNS_KEEP_DAYS", "x"), ("SAGEBRUSH_RUNS_KEEP_COUNT", "9"),
                      ("SAGEBRUSH_RUNS_SESSIONS", "257"), ("SAGEBRUSH_RUNS_OUTPUT_BYTES", "1"), ("SAGEBRUSH_RUNS_STORE_BYTES", "1000")]:
        try:
            R.settings({name: bad})
        except ValueError as e:
            assert name in str(e), e
        else:
            raise AssertionError((name, bad))
    assert R.session_ceiling(cpus=8, total=None) == 1  # (T unknown: one session)
    assert R.session_ceiling(cpus=8, total=2 * R.GiB) == 4 and R.session_ceiling(cpus=1, total=64 * R.GiB) == 2
    assert R.session_ceiling(cpus=4, total=100 * R.MiB) == 1
    print("settings: ok")


def test_store():
    s = fresh()
    if os.name == "posix":
        assert stat.S_IMODE(os.stat(s.root).st_mode) == 0o700
    h = s.new_handle()
    assert h.startswith("run_") and len(h) == 30 and set(h[4:]) <= set("abcdefghijklmnopqrstuvwxyz234567"), h
    for bad in ("run_../../etc", "../x", "run_" + "A" * 26, 7):
        try:
            s.run_dir(bad)
        except KeyError:
            pass
        else:
            raise AssertionError(bad)
    rec = R.new_record(s, h, "code", "sage", {"id": "main", "generation": 1}, 1, "test")
    s.save(rec)
    assert s.load(h)["handle"] == h and s.load("run_" + "a" * 26) is None
    if os.name == "posix":
        assert stat.S_IMODE(os.stat(os.path.join(s.root, h, "run.json")).st_mode) == 0o600
    # (the running total and the walk agree: the one formula)
    p, why = s.write_value(h, b"x" * 100000)
    assert p and why is None and s.used() == s.walk_total(), (s.used(), s.walk_total())
    # (a value that doesn't fit is refused, and nothing is written)
    p, why = s.write_value(h, b"x" * (65 * R.MiB))
    assert p is None and "full" in why and s.used() == s.walk_total(), why
    assert not os.listdir(os.path.join(s.root, "reservations"))
    # output rotation: head and tail, exact counters
    o = R.Output(R.HEAD_KEEP + 1000)
    o.add("a" * R.HEAD_KEEP)
    o.add("b" * 5000)
    i = o.info("x")
    assert i["stdout_bytes"] == R.HEAD_KEEP + 5000 and i["retained_bytes"] == R.HEAD_KEEP + 1000 and i["truncated_bytes"] == 4000, i
    assert i["tail"].endswith("b" * 1000) and b"4000 bytes dropped" in o.bytes()
    print("store: ok")


def test_other_owner_unknown():
    """Condition 1: a run whose owning server isn't this process is never
    plainly running: liveness unknown in the record, run_list and the
    summary (and the startup listing: test_mcp.py)."""
    root = tempfile.mkdtemp(prefix="sb-runs-")
    old = fresh(root=root, owner={"pid": 1, "nonce": "earlier"})
    h = old.new_handle()
    rec = R.new_record(old, h, "code", "sage", {"id": "main", "generation": 1}, 1, "someone")
    old.save(rec)
    old.index_set(h, {"started_at": rec["started_at"], "started_by": "someone", "owner": old.owner, "label": None})
    os.unlink(old._index_path())  # (and the index is rebuilt at open: crash repair)
    s = fresh(root=root)
    v = s.view(s.load(h))
    assert v["state"] == "running" and v["liveness"] == "unknown" and "isn't this server" in v["liveness_reason"], v
    e = s.listing()["runs"][0]
    assert e["handle"] == h and e["liveness"] == "unknown", e
    sm = s.summary()
    assert sm["running"] == 0 and sm["unknown"] == 1 and sm["handles"] == [h], sm
    r = runner(s)
    r.ceiling = 1
    # (and it keeps its slot: with a ceiling of 1, no session can start here, daybreak2 PR120-2)
    e = refused("capacity", r.start, "auto:1", "sage")
    assert e.extra["unknown"] == [h] and e.extra["limit"] == 1, e.extra
    r.ceiling = 2
    assert r.record(h)["liveness"] == "unknown"
    assert r.cancel(h, "hard")["result"] == "not_owned"
    refused("not_owned", r.keep, h, True)
    # (and a run of this server isn't unknown)
    run, done = r.start("auto:1", "sage")
    assert done and "liveness" not in r.record(run.record["handle"])
    # (cleanup never removes another owner's running run)
    assert h not in s.cleanup(now=time.time() + 400 * 86400)
    print("another owner's run: liveness unknown: ok")


def test_finish_and_ticket():
    r = runner()
    run, done = r.start("auto:'2'", "sage", wait=5, label="a\x07b" + "c" * 100, started_by="claude")
    rec = r.record(run.record["handle"])
    assert done and rec["state"] == "finished" and rec["ended_by"] == "return" and rec["value"] == {"text": "'2'"}, rec
    assert rec["covers"] == "worker" and R.DETACHED_NOTE in rec["notes"], rec  # (no more than H′1a observes)
    assert rec["label"] == "ab" + "c" * 78 and rec["started_by"] == "claude" and rec["ticketed"] is False, rec
    assert r.store.load(rec["handle"])["state"] == "finished" and r.summary()["running"] == 0
    # a ticket: the call returns, the run keeps going
    run, done = r.start("slow", "sage", wait=0)
    h = run.record["handle"]
    assert not done and r.record(h)["state"] == "running" and r.record(h)["ticketed"] is True
    assert r.summary()["running"] == 1 and r.summary()["handles"] == [h]
    rec, reply = r.result(h, wait=0.05)
    assert rec["state"] == "running" and reply is None
    r.made[0].finish("42", stdout="hi\n")
    rec, reply = r.result(h, wait=5)
    assert rec["state"] == "finished" and reply["result"] == "42" and rec["output"]["stdout_bytes"] == 3, rec
    assert open(os.path.join(r.store.root, h, "output.txt")).read() == "hi\n"
    assert r.summary()["running"] == 0
    # a large value is written to value.json, not inline
    run, done = r.start("auto:" + "9" * 70000, "python")
    v = r.record(run.record["handle"])["value"]
    assert "text" in v and v["path"].endswith("/value.json") and v["summary"] == "70000 characters", v
    # the legacy timeout is wait; both, different, is refused
    run, done = r.start("auto:1", "sage", timeout=3)
    assert done
    refused("invalid", r.start, "x", "sage", wait=1, timeout=2)
    for bad in (-1, float("nan"), True, "5", 3601):
        refused("invalid", r.start, "x", "sage", wait=bad)
    refused("invalid", r.start, "x", "sage", run_deadline=0)
    print("finish and ticket: ok")


def test_busy_and_capacity():
    r = runner()
    run, done = r.start("slow", "sage", wait=0)
    e = refused("busy", r.start, "auto:1", "sage")
    assert e.extra["running"] == run.record["handle"]
    refused("busy", r.reset, "main")
    r.ceiling = 1
    e = refused("capacity", r.start, "auto:1", "sage", session="new")
    assert e.extra["limit"] == 1 and e.extra["active"] == [run.record["handle"]], e.extra
    r.ceiling = 2
    run2, done = r.start("auto:2", "sage", session="new")
    assert done and run2.record["session"]["id"] == "new-1"
    refused("invalid", r.start, "x", "sage", session="")
    print("busy and capacity: ok")


def test_cancel_and_attribution():
    r = runner()
    run, _ = r.start("slow", "sage", wait=0)
    h = run.record["handle"]
    a = r.cancel(h, "soft")
    assert a["result"] == "soft_unavailable" and "hard" in a["reason"] and r.made[0].interrupts == 0, a
    a = r.cancel(h, "hard", request_id="c1")
    assert a["result"] == "delivered", a
    until(lambda: run.done.is_set(), "the cancel")
    rec = r.record(h)
    assert rec["state"] == "finished" and rec["ended_by"] == "cancel_hard" and rec["attribution"] == "correlated", rec
    assert rec["error"]["type"] == "interrupted"
    assert r.cancel(h, "hard", request_id="c1") == a  # (the same request: the same answer)
    assert r.cancel(h, "hard")["result"] == "not_running"
    refused("invalid", r.cancel, h, "violent")
    refused("not_found", r.cancel, "run_" + "a" * 26)
    # a deadline the caller gave
    run, _ = r.start("slow", "sage", wait=0, run_deadline=0.1)
    until(lambda: run.done.is_set(), "the deadline")
    rec = r.record(run.record["handle"])
    assert rec["ended_by"] == "run_deadline" and rec["attribution"] == "correlated", rec
    # an interrupt nobody here asked for: unattributed
    run, _ = r.start("slow", "sage", wait=0)
    r.made[0].finish(error_info={"type": "interrupted", "exception": "KeyboardInterrupt", "message": "the computation was interrupted",
                                 "traceback": "", "at": time.time()})
    until(lambda: run.done.is_set(), "the interrupt")
    rec = r.record(run.record["handle"])
    assert rec["ended_by"] == "interrupt" and rec["attribution"] == "none", rec
    print("cancel and attribution: ok")


def test_stale_request():
    """A request for a run that has ended, or for an earlier generation or
    run_seq of its session, is never delivered to whatever runs now."""
    r = runner()
    run1, _ = r.start("auto:1", "sage")
    run2, _ = r.start("slow", "sage", wait=0)
    s = r.made[0]
    g, q = run1.record["session"]["generation"], run1.record["run_seq"]
    assert r._request(run1, "run_deadline", g, q)["result"] == "not_running" and s.interrupts == 0
    assert r._request(run2, "run_deadline", g, run2.record["run_seq"] - 1)["result"] == "not_running" and s.interrupts == 0
    assert r._request(run2, "run_deadline", g + 1, run2.record["run_seq"])["result"] == "not_running" and s.interrupts == 0
    assert r.record(run2.record["handle"])["state"] == "running" and r.record(run2.record["handle"])["requests"] == []
    s.finish("ok")
    print("stale requests: ok")


def test_escalation():
    old = RN.ESCALATE_S
    RN.ESCALATE_S = 0.2
    try:
        r = runner()
        run, _ = r.start("slow", "sage", wait=0)
        s = r.made[0]
        s.stubborn = True
        assert r.cancel(run.record["handle"], "hard")["result"] == "delivered"
        until(lambda: run.done.is_set(), "the escalation")
        until(lambda: "replacement_generation" in run.record, "the replacement")
        rec = r.record(run.record["handle"])
        assert rec["state"] == "killed" and rec["ended_by"] == "restart" and rec["restart_cause"] == "cancel_hard" and rec["restarted"], rec
        assert rec["replacement_generation"] == 2 and s.restarts == 1, rec
        assert r.store.load(rec["handle"])["state"] == "killed"
        # (while an escalation restarts the session, no run starts in it)
        s.gate = threading.Event()
        run, _ = r.start("slow", "sage", wait=0)
        r.cancel(run.record["handle"], "hard")
        until(lambda: "main" in r.restarting and run.done.is_set(), "the restart")
        e = refused("busy", r.start, "auto:1", "sage")
        assert "being restarted" in str(e)
        r.reset("main")  # (a reset meanwhile is a no-op)
        s.gate.set()
        until(lambda: not r.restarting and "replacement_generation" in run.record, "the restart's end")
        assert s.restarts == 2 and r.start("auto:1", "sage")[1]
        s.gate = None
        # (an interrupt that does stop it in time: no restart)
        s.stubborn = False
        run, _ = r.start("slow", "sage", wait=0)
        r.cancel(run.record["handle"], "hard")
        until(lambda: run.done.is_set(), "the cancel")
        time.sleep(0.4)
        assert s.restarts == 2 and r.record(run.record["handle"])["state"] == "finished"
    finally:
        RN.ESCALATE_S = old
    print("escalation: ok")


def test_session_death():
    r = runner()
    run, _ = r.start("slow", "sage", wait=0)
    r.made[0].die()
    until(lambda: run.done.is_set(), "the death")
    rec = r.record(run.record["handle"])
    assert rec["state"] == "finished" and rec["error"]["type"] == "session" and not rec.get("restarted"), rec
    run, done = r.start("auto:1", "sage")
    assert done and r.record(run.record["handle"])["session_restarted"] is True
    run, done = r.start("auto:1", "sage")
    assert "session_restarted" not in r.record(run.record["handle"])
    print("session death: ok")


def test_memory_error():
    r = runner()
    run, _ = r.start("slow", "sage", wait=0)
    mem = {"what": "factor", "need_bytes": 10 ** 12, "limit_bytes": 10 ** 9, "record": None, "partial": None, "checkpoint": None, "capacity": None}
    r.made[0].finish(error_info={"type": "memory", "exception": "MemoryError", "message": "needs 1 TB", "traceback": "", "memory": mem})
    until(lambda: run.done.is_set(), "the error")
    rec = r.record(run.record["handle"])
    assert rec["error"]["type"] == "memory" and rec["memory"] == mem and rec["ended_by"] == "error", rec
    print("memory error: ok")


def test_idempotency_and_keep():
    r = runner()
    run, _ = r.start("auto:1", "sage", request_id="k")
    again, done = r.start("auto:1", "sage", request_id="k")
    assert again is run and done
    refused("invalid", r.start, "auto:2", "sage", request_id="k")
    h = run.record["handle"]
    assert r.keep(h, True) == {"handle": h, "keep": True} and r.store.load(h)["keep"] is True
    refused("invalid", r.keep, h, "yes")
    refused("not_found", r.keep, "run_" + "a" * 26, True)
    print("idempotency and keep: ok")


def test_cleanup():
    s = fresh({"SAGEBRUSH_RUNS_KEEP_COUNT": "10", "SAGEBRUSH_RUNS_KEEP_DAYS": "1"})
    now = time.time()
    hs = []
    for i in range(14):
        h = s.new_handle()
        rec = R.new_record(s, h, "code", "sage", {"id": "main", "generation": 1}, i, "t", now=now - 1000 + i)
        rec.update(state="finished", ended_at=now - 1000 + i, keep=(i == 0))
        s.save(rec)
        hs.append(h)
    gone = s.cleanup(now=now)
    # (the oldest unkept beyond the count; the kept one stays)
    assert gone == sorted(hs[1:4]) and s.load(hs[0])["keep"], gone
    t = s.load(hs[1])
    assert t["state"] == "gone" and t["reason"] == "count", t
    refused("not_found", runner(s).keep, hs[1], True)  # (a removed run: its tombstone isn't kept)
    gone = s.cleanup(now=now + 2 * 86400)
    assert sorted(gone) == sorted(hs[4:]) and s.load(hs[0])["state"] == "finished", gone
    assert s.used() == s.walk_total()
    print("cleanup: ok")


def _settled(r, run):
    """A run that ended has settled: its waiter woken, its session free, not
    counted as running, and the next run starts."""
    assert run.done.is_set() and run.session_name not in r.current, (run.done.is_set(), r.current)
    assert r.summary()["running"] == 0, r.summary()
    nxt, done = r.start("auto:1", "sage", session=run.session_name)
    assert done and r.record(nxt.record["handle"])["state"] == "finished"


def test_settles_on_storage_failure():
    """astra PR120-SEM-1, daybreak2 PR120-3: a failed output, value, record or
    index write never strands a run: it settles, says what couldn't be
    written, and the session takes the next run."""
    import errno

    def enospc(*a, **k):
        raise OSError(errno.ENOSPC, "No space left on device")

    # the output file
    r = runner()
    real = r.store.write_file
    r.store.write_file = lambda h, name, *a, **k: enospc() if name == "output.txt" else real(h, name, *a, **k)
    run, _ = r.start("slow", "sage", wait=0)
    r.made[0].finish("7", stdout="x" * 1000)
    until(run.done.is_set, "the run's end")
    rec = r.record(run.record["handle"])
    assert rec["state"] == "finished" and rec["ended_by"] == "return" and rec["value"] == {"text": "7"}, rec
    assert rec["output"]["stdout_bytes"] == 1000 and rec["output"]["path"] is None and "No space" in rec["output"]["unavailable"], rec["output"]
    assert r.store.load(rec["handle"])["state"] == "finished"
    r.store.write_file = real
    _settled(r, run)
    # a large value
    r = runner()
    r.store.reserve = enospc
    run, done = r.start("auto:" + "9" * 70000, "sage")
    v = r.record(run.record["handle"])["value"]
    assert done and "No space" in v["unavailable"] and "path" not in v, v
    _settled(r, run)
    # the terminal record, and the index
    for what in ("save", "index_set"):
        r = runner()
        run, _ = r.start("slow", "sage", wait=0)
        real = getattr(r.store, what)
        if what == "save":
            setattr(r.store, what, lambda rec, durable=False: enospc() if durable else real(rec, durable))
        else:
            setattr(r.store, what, lambda h, e: enospc() if e is None else real(h, e))
        r.made[0].finish("8")
        until(run.done.is_set, "the run's end")
        rec = r.record(run.record["handle"])
        assert rec["state"] == "finished" and rec["storage"]["state"] == "unavailable" and "No space" in rec["storage"]["reason"], rec
        assert r.result(run.record["handle"], wait=0)[1]["result"] == "8"
        setattr(r.store, what, real)
        _settled(r, run)
    # a bug in the end's bookkeeping: still settled
    r = runner()
    run, _ = r.start("slow", "sage", wait=0)
    r._end = lambda *a: 1 / 0
    r.made[0].finish("9")
    until(run.done.is_set, "the run's end")
    rec = r.record(run.record["handle"])
    assert rec["state"] == "finished" and "ZeroDivisionError" in rec["storage"]["reason"], rec
    del r._end
    _settled(r, run)
    print("storage failures settle the run: ok")


def test_output_bounded_streaming():
    """daybreak2 PR120-3: output is taken as it streams, in chunks, into the
    bounded head and tail with exact counters; the store keeps at most
    SAGEBRUSH_RUNS_OUTPUT_BYTES of it; and output that the store can't admit
    stays counters and tail."""
    r = runner(fresh({"SAGEBRUSH_RUNS_OUTPUT_BYTES": str(2 * R.MiB)}))
    run, _ = r.start("slow", "sage", wait=0)
    s = r.made[0]
    chunk = "y" * 65536
    for _ in range(1600):  # (100 MiB, in the worker's chunks)
        s.q.put({"out": chunk})
    s.finish("1")
    until(run.done.is_set, "the run's end", 60)
    o = r.record(run.record["handle"])["output"]
    assert o["stdout_bytes"] == 1600 * 65536 and o["retained_bytes"] == 2 * R.MiB and o["truncated_bytes"] == 1600 * 65536 - 2 * R.MiB, o
    size = os.path.getsize(os.path.join(r.store.root, run.record["handle"], "output.txt"))
    assert size <= 2 * R.MiB + 100, size
    # (a store too full for the output file: counters and tail, the run unaffected)
    r = runner()
    r.store.admit = lambda n, kind: (_ for _ in ()).throw(R.StorageError("the run store is full")) if kind == "data" else None
    run, _ = r.start("slow", "sage", wait=0)
    r.made[0].finish("2", stdout="z" * 5000)
    until(run.done.is_set, "the run's end")
    o = r.record(run.record["handle"])["output"]
    assert o["stdout_bytes"] == 5000 and o["tail"].endswith("z" * 100) and "full" in o["unavailable"] and o["path"] is None, o
    print("output bounded as it streams: ok")


def test_admission_boundaries():
    """daybreak2 PR120-1: one formula at the boundary, the reservation record
    included; records and output admitted before they are written; the
    free-space floor kept."""
    s = fresh()
    budget = s.cfg["SAGEBRUSH_RUNS_STORE_BYTES"]
    limit = budget - min(R.DATA_HEADROOM_MAX, budget // 8)
    free_total = [10 ** 15, 10 ** 15]
    s._free = lambda: tuple(free_total)
    s.reserve_floor = lambda: R.GiB
    h = s.new_handle()
    used = s.used()
    rec_size = s.physical(len(json.dumps({"bytes": 0, "target": "x" * 300, "owner": s.owner})))
    # exactly at the data limit: admitted; one byte more: refused
    s.admit(limit - used, "data")
    try:
        s.admit(limit - used + 1, "data")
        raise AssertionError("over the limit admitted")
    except R.StorageError:
        pass
    # a reservation charges its record too: nbytes alone fitting isn't enough
    target = os.path.join(s.run_dir(h), "value.json")
    try:
        s.reserve(h, target, limit - used)
        raise AssertionError("the reservation record's charge was not admitted")
    except R.StorageError:
        pass
    assert s.used() == s.walk_total() and not os.listdir(os.path.join(s.root, "reservations"))
    p = s.reserve(h, target, limit - used - 2 * rec_size)
    assert s.used() <= limit and s.used() == s.walk_total(), (s.used(), limit)
    s.release(p)
    # records may use the whole budget, data may not
    s.admit(budget - s.used(), "meta")
    try:
        s.admit(limit - s.used() + 1, "data")
        raise AssertionError("data admitted into the records' headroom")
    except R.StorageError:
        pass
    # the free-space floor, at the boundary
    free_total[0] = R.GiB + 4096
    s.admit(4096, "meta")
    try:
        s.admit(4097, "meta")
        raise AssertionError("the free-space floor was crossed")
    except R.StorageError:
        pass
    # a write into a full store is refused before it replaces anything
    free_total[0] = R.GiB
    try:
        s.write_file(h, "output.txt", b"o" * 10000, kind="data")
        raise AssertionError("output written into a full store")
    except R.StorageError:
        pass
    assert not os.path.exists(os.path.join(s.run_dir(h), "output.txt"))
    # the active index too: an entry isn't added into a full store, and one is always removed
    s.index_set(h, None)
    try:
        s.index_set(h, {"started_at": 1, "owner": s.owner, "label": "x" * 5000})
        raise AssertionError("an index entry written into a full store")
    except R.StorageError:
        pass
    assert h not in s.index()
    # and a run doesn't start without room for its records
    r = runner(s)
    e = refused("storage", r.start, "auto:1", "sage")
    assert "no room" in str(e)
    assert [n for n in os.listdir(s.root) if n.startswith("run_")] == [h], "a refused run left its directory"
    print("admission at the boundaries: ok")


def test_unknown_runs_bounded():
    """daybreak2 PR120-2: runs left running by earlier owners hold their
    slots, so repeated owner restarts can't grow the active index past the
    ceiling; cleanup repairs the index on both sides of the crash window."""
    root = tempfile.mkdtemp(prefix="sb-runs-")
    for i in range(5):
        r = runner(fresh(root=root, owner={"pid": 10 + i, "nonce": "owner%d" % i}))
        r.ceiling = 2
        try:
            r.start("slow", "sage", wait=0)  # (and the server "crashes": never closed)
        except RN.Refused as e:
            assert e.kind == "capacity" and len(e.extra["unknown"]) == 2, e.extra
        assert len(r.store.index()) <= 2, r.store.index()
    assert len(r.store.index()) == 2
    # cleanup repairs: a terminal record whose index entry was left behind ...
    s = fresh()
    h = s.new_handle()
    rec = R.new_record(s, h, "code", "sage", {"id": "main", "generation": 1}, 1, "t")
    rec.update(state="finished", ended_at=time.time())
    s.save(rec)
    s.index_set(h, {"started_at": rec["started_at"], "owner": s.owner})
    s.cleanup()
    assert h not in s.index()
    # ... and a running record whose entry was never written
    h2 = s.new_handle()
    rec = R.new_record(s, h2, "code", "sage", {"id": "main", "generation": 1}, 1, "t")
    s.save(rec)
    s.cleanup()
    assert h2 in s.index()
    print("unknown runs bounded, the index repaired: ok")


def test_tombstones_win():
    """astra PR120-SEM-2: a run removed by cleanup (here, or by another
    server) is gone for status, result and keep, whatever this server has
    cached."""
    for other in (False, True):
        root = tempfile.mkdtemp(prefix="sb-runs-")
        r = runner(fresh(root=root, env={"SAGEBRUSH_RUNS_KEEP_DAYS": "1"}))
        run, done = r.start("auto:1", "sage")
        h = run.record["handle"]
        cleaner = fresh(root=root, env={"SAGEBRUSH_RUNS_KEEP_DAYS": "1"}, owner={"pid": 2, "nonce": "other"}) if other else r.store
        assert h in cleaner.cleanup(now=time.time() + 3 * 86400)
        rec = r.record(h)
        assert rec["state"] == "gone" and rec["reason"] == "age", rec
        assert r.result(h, wait=0) == (rec, None)
        e = refused("not_found", r.keep, h, True)
        assert "removed" in str(e) and e.extra["tombstone"]["state"] == "gone"
        assert r.cancel(h, "hard")["result"] == "not_running"
        assert h not in r.runs
    print("tombstones win over the cache: ok")


def test_cancel_contract():
    """astra PR120-SEM-3: a cancel's answer carries its request id (made here
    when none was given), retrying it gives the same answer, reusing it for
    another target or mode is refused, and a run that has ended or is gone
    answers not_running in either mode."""
    old = RN.ESCALATE_S
    RN.ESCALATE_S = 0.2
    try:
        r = runner()
        run, _ = r.start("slow", "sage", wait=0)
        h = run.record["handle"]
        a = r.cancel(h, "soft")
        assert a["result"] == "soft_unavailable" and a["request_id"].startswith("cancel_"), a
        b = r.cancel(h, "hard")
        rid = b["request_id"]
        assert b["result"] == "delivered" and rid.startswith("cancel_") and rid != a["request_id"], b
        assert [x["request_id"] for x in r.record(h)["requests"]] == [rid]
        assert r.cancel(h, "hard", request_id=rid) == b and r.made[0].interrupts == 1  # (a retry: no second interrupt)
        refused("invalid", r.cancel, h, "soft", request_id=rid)
        until(run.done.is_set, "the cancel")
        for mode in ("soft", "hard"):
            c = r.cancel(h, mode)
            assert c["result"] == "not_running" and c["state"] == "finished" and "reason" not in c, c
        mine = r.cancel(h, "soft", request_id="mine")
        assert mine["request_id"] == "mine" and mine["result"] == "not_running"
        # killed
        run, _ = r.start("slow", "sage", wait=0)
        r.made[0].stubborn = True
        r.cancel(run.record["handle"], "hard")
        until(lambda: run.done.is_set() and "replacement_generation" in run.record, "the restart")
        for mode in ("soft", "hard"):
            c = r.cancel(run.record["handle"], mode)
            assert c["result"] == "not_running" and c["state"] == "killed", c
        # gone
        r.made[0].stubborn = False
        g, _ = r.start("auto:1", "sage")
        r.store._remove(r.store.load(g.record["handle"]), "count", time.time())
        for mode in ("soft", "hard"):
            c = r.cancel(g.record["handle"], mode)
            assert c["result"] == "not_running" and c["state"] == "gone", c
    finally:
        RN.ESCALATE_S = old
    print("the cancel contract: ok")


def test_close_settles():
    """A server that exits closes its sessions, and a run they were
    computing is settled as killed (server_exit), not left holding a slot."""
    r = runner()
    run, _ = r.start("slow", "sage", wait=0)
    s = r.made[0]
    s.close = lambda: (setattr(s, "live", False), setattr(s, "closed", True))
    r.close()
    rec = r.store.load(run.record["handle"])
    assert rec["state"] == "killed" and rec["ended_by"] == "server_exit" and run.done.is_set(), rec
    assert run.record["handle"] not in r.store.index()
    print("close settles: ok")


def test_capture():
    """The session worker's capture (session._Capture): everything printed
    goes out in chunks of at most CHUNK, in order; the reply keeps a bounded
    head and tail with the exact count."""
    from sagebrush import session as S

    sent = []
    c = S._Capture(sent.append)
    for i in range(200000):
        c.write("line %d\n" % i)
    c.flush()
    whole = "".join("line %d\n" % i for i in range(200000))
    assert "".join(m["out"] for m in sent) == whole and all(len(m["out"]) <= S.CHUNK for m in sent)
    t = c.text()
    assert c.total == len(whole) and t.startswith(whole[:S.REPLY_HEAD]) and t.endswith(whole[-S.REPLY_TAIL:]) and "not shown" in t
    assert len(t) < S.REPLY_HEAD + S.REPLY_TAIL + 200
    c = S._Capture(sent.append)
    c.write("hi\n")
    assert c.text() == "hi\n"
    x = "a" * (S.REPLY_HEAD + 10)
    c = S._Capture(lambda m: None)
    c.write(x)
    assert c.text() == x
    print("capture: ok")


def test_real_session_output():
    """The real session, when the package's engine is built (CI's
    engine-cpython, a VM): a 100 MiB printer streams through Session and
    Runner bounded, with exact counters, and the computation is unaffected."""
    try:
        import sagebrush._native  # noqa: F401
    except ImportError:
        print("real session output: skipped (no built engine)")
        return
    import resource

    r = RN.Runner(store=fresh({"SAGEBRUSH_RUNS_OUTPUT_BYTES": str(4 * R.MiB)}))
    try:
        before = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        run, done = r.start("for i in range(1600):\n    print('p' * 65535)\n6 * 7", "python", wait=300)
        rec = r.record(run.record["handle"])
        grew = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss - before
        assert done and rec["state"] == "finished" and rec["value"] == {"text": "42"}, rec
        assert rec["output"]["stdout_bytes"] == 1600 * 65536 and rec["output"]["retained_bytes"] == 4 * R.MiB, rec["output"]
        assert len(run.reply["stdout"]) <= 1100 * 1024 and run.reply["stdout_chars"] == 1600 * 65536, len(run.reply["stdout"])
        assert grew < 64 * 1024, "the parent's peak RSS grew by %d KiB" % grew  # (KiB on Linux)
    finally:
        r.close()
    print("real session output: ok")


def test_server():
    """The MCP server around the runner (with fake sessions): the ticket,
    the run tools, `runs` in every result, the startup listing, and
    notifications/cancelled reaching a waiting call's run."""
    import io

    from sagebrush import mcp_server as M

    root = tempfile.mkdtemp(prefix="sb-runs-")
    old = fresh(root=root, owner={"pid": 1, "nonce": "earlier"})
    h0 = old.new_handle()
    rec = R.new_record(old, h0, "code", "sage", {"id": "main", "generation": 1}, 1, "earlier-agent", label="the long one", now=time.time() - 630)
    old.save(rec)
    old.index_set(h0, {"started_at": rec["started_at"], "started_by": "earlier-agent", "owner": old.owner, "label": "the long one"})

    out = io.StringIO()
    srv = M.Server(out)
    srv._runner = runner(fresh(root=root))
    srv._runner.ceiling = 3  # (the earlier server's unknown run holds one slot)
    srv.client = {"name": "claude-code"}
    intro = srv.startup_runs()
    assert h0 in intro and "liveness unknown" in intro and "the long one" in intro and "10 min ago" in intro, intro
    schemas = M.OUTPUT_SCHEMAS
    tools = {t["name"] for t in M.TOOLS}
    assert {"run_status", "run_result", "run_cancel", "run_list", "run_keep"} <= tools

    def call(name, args, rid=None):
        out.truncate(0)
        out.seek(0)
        srv.running[rid or name] = True
        srv._tool_call(rid or name, {"name": name, "arguments": args})
        msg = json.loads(out.getvalue().strip().splitlines()[-1])
        r = msg["result"]
        assert set(r["structuredContent"]) <= set(schemas[name]["properties"]), (name, set(r["structuredContent"]) - set(schemas[name]["properties"]))
        return r, r["structuredContent"]

    srv.protocol = M.STRUCTURED_SINCE
    r, sc = call("sage", {"code": "auto:'4'"})
    assert not r["isError"] and sc["result"] == "'4'" and sc["run"]["state"] == "finished", sc
    assert sc["runs"] == {"running": 0, "unknown": 1, "oldest_age_s": sc["runs"]["oldest_age_s"], "handles": [h0]}, sc["runs"]
    assert "liveness unknown" in r["content"][-1]["text"] and "running" not in r["content"][-1]["text"].split(",")[1], r["content"]
    # a ticket
    r, sc = call("sage", {"code": "slow", "wait": 0, "label": "big"})
    h = sc["run"]["handle"]
    assert not r["isError"] and sc["run"]["state"] == "running" and h in r["content"][0]["text"] and "run_result" in r["content"][0]["text"], r
    assert sc["runs"]["running"] == 1 and "1 running here" in r["content"][-1]["text"]
    r, sc = call("sage", {"code": "auto:1"})
    assert r["isError"] and sc["error"]["type"] == "busy" and sc["run"]["handle"] == h, sc
    r, sc = call("run_status", {"handle": h})
    assert sc["result"]["state"] == "running" and "liveness" not in sc["result"]
    r, sc = call("run_status", {"handle": h0})
    assert sc["result"]["liveness"] == "unknown" and "liveness unknown" in r["content"][0]["text"], sc
    r, sc = call("run_list", {})
    states = {e["handle"]: (e["state"], e["liveness"]) for e in sc["result"]["runs"]}
    assert states[h] == ("running", None) and states[h0] == ("running", "unknown"), states
    r, sc = call("run_result", {"handle": h, "wait": 0})
    assert sc["result"]["state"] == "running" and "still running" in r["content"][0]["text"]
    srv._runner.made[0].finish("99", stdout="out\n")
    r, sc = call("run_result", {"handle": h, "wait": 5})
    assert sc["content_of_result"] and sc["result"]["state"] == "finished" and r["content"][0]["text"] == "out\n99", (r, sc)
    r, sc = call("run_cancel", {"handle": h, "mode": "hard"})
    assert sc["result"]["result"] == "not_running"
    r, sc = call("run_cancel", {"handle": h0})
    assert sc["result"]["result"] == "not_owned"
    r, sc = call("run_keep", {"handle": h, "keep": True})
    assert sc["result"] == {"handle": h, "keep": True}
    r, sc = call("run_status", {"handle": "run_" + "a" * 26})
    assert r["isError"] and sc["error"]["type"] == "not_found"
    r, sc = call("run_status", {})
    assert r["isError"] and sc["error"]["type"] == "invalid_arguments"
    r, sc = call("sage", {"code": "x", "wait": -1})
    assert r["isError"] and sc["error"]["type"] == "invalid_arguments", sc
    # notifications/cancelled for a call that is waiting: its run is cancelled (hard)
    t = threading.Thread(target=call, args=("sage", {"code": "slow", "wait": 30}, 77))
    t.start()
    until(lambda: 77 in srv.waiting, "the waiting call")
    srv.handle({"jsonrpc": "2.0", "method": "notifications/cancelled", "params": {"requestId": 77}})
    t.join(10)
    assert not t.is_alive()
    last = max(srv._runner.runs.values(), key=lambda x: x.record["started_at"])
    assert last.record["ended_by"] == "cancel_hard" and 77 not in srv.waiting, last.record
    # a cancellation that comes after the call's admission, before its run exists: the run is cancelled once it does
    s = srv._runner.made[0]
    s.submit_gate = threading.Event()
    t = threading.Thread(target=call, args=("sage", {"code": "slow", "wait": 30}, 78))
    t.start()
    assert s.in_submit.wait(5) and 78 not in srv.waiting
    srv.handle({"jsonrpc": "2.0", "method": "notifications/cancelled", "params": {"requestId": 78}})
    s.submit_gate.set()
    t.join(10)
    assert not t.is_alive()
    last = max(srv._runner.runs.values(), key=lambda x: x.record["started_at"])
    assert last.record["ended_by"] == "cancel_hard", last.record
    s.submit_gate = None
    # reset: refused while a run is running, then restarts the session
    r, sc = call("sage", {"code": "slow", "wait": 0})
    r, sc2 = call("reset", {})
    assert r["isError"] and sc2["error"]["type"] == "busy", sc2
    srv._runner.made[0].finish("1")
    until(lambda: not srv._runner.current, "the run's end")
    r, sc = call("reset", {})
    assert not r["isError"] and srv._runner.made[0].restarts == 1
    print("server: ok")


if __name__ == "__main__":
    test_settings()
    test_store()
    test_other_owner_unknown()
    test_finish_and_ticket()
    test_busy_and_capacity()
    test_cancel_and_attribution()
    test_stale_request()
    test_escalation()
    test_session_death()
    test_memory_error()
    test_idempotency_and_keep()
    test_cleanup()
    test_settles_on_storage_failure()
    test_output_bounded_streaming()
    test_admission_boundaries()
    test_unknown_runs_bounded()
    test_tombstones_win()
    test_cancel_contract()
    test_close_settles()
    test_capture()
    test_real_session_output()
    test_server()
    print("runs: all ok")
