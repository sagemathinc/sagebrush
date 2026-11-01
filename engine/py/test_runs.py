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
        self.targets = []  # (each interrupt's target id)
        self.stubborn = False
        self.live = True
        self.restarts = 0
        self.closed = False
        self.gate = None  # (a restart waits for it when set)
        self.submit_gate = None  # (and a submit, once in_submit is set)
        self.in_submit = threading.Event()
        self.rid = 0  # (the request in flight's id, as Session mints them)

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
        self.rid += 1
        if code.startswith("auto:"):
            self.finish(code[5:])
        return self.generation, self.q, self.rid

    def finish(self, result=None, stdout="", error_info=None):
        # (output streams first, in chunks, as the real worker sends it)
        for i in range(0, len(stdout), 64 * 1024):
            self.q.put({"out": stdout[i:i + 64 * 1024], "id": self.rid})
        r = {"id": self.rid, "stdout": stdout, "result": result, "error": None if error_info is None else error_info["message"],
             "error_info": error_info, "displays": [], "seconds": 0.01}
        self.pending = None
        self.q.put(r)

    def interrupt(self, rid=None):
        self.interrupts += 1
        self.targets.append(rid)
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
        # (as Session.close: the worker ended)
        self.closed = True
        self.live = False


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
    # (T from D0's heap_figure: made up here, as the runner's own memory
    # would make the figure the machine's; unknown, nothing readable, is the
    # nominal total, and then one session)
    from sagebrush import _capacity_module
    C = _capacity_module()
    d = tempfile.mkdtemp(prefix="sb-runs-")
    try:
        C._set_sources(root=d + "/nonexistent", rlimits={}, runtime=lambda: [])
        assert R.session_ceiling(cpus=8, total=None) == 1  # (T unknown: one session)
        os.makedirs(d + "/proc")
        with open(d + "/proc/meminfo", "w") as f:
            f.write("MemTotal:       %d kB\nMemAvailable:   %d kB\n" % (2 * R.GiB // 1024, R.GiB // 1024))
        C._set_sources(root=d, rlimits={}, runtime=lambda: [])
        assert R.session_ceiling(cpus=8, total=None) == 4  # (T = 2 GiB, D0's figure: 4 sessions)
    finally:
        C._set_sources()
        import shutil
        shutil.rmtree(d, ignore_errors=True)
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
        s.q.put({"out": chunk, "id": s.rid})
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
    rec_size = s.physical(len(json.dumps({"bytes": 0, "target": "x" * 300, "temp": "x" * 320, "owner": dict(s.owner, host="x" * 255)})))
    # exactly at the data limit: admitted; one byte more: refused
    s.admit(limit - used, "data")
    try:
        s.admit(limit - used + 1, "data")
        raise AssertionError("over the limit admitted")
    except R.StorageError:
        pass
    # a reservation charges its record too: nbytes alone fitting isn't enough
    target = os.path.join(s.run_dir(h), "value.json")
    temp = target + ".0123456789ab.tmp"
    try:
        s.reserve(h, target, limit - used, temp)
        raise AssertionError("the reservation record's charge was not admitted")
    except R.StorageError:
        pass
    assert s.used() == s.walk_total() and not os.listdir(os.path.join(s.root, "reservations"))
    p = s.reserve(h, target, limit - used - 2 * rec_size, temp)
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
    # the active index too: its rewrite, whatever it adds or removes, needs room for its temporary file
    for entry in ({"started_at": 1, "owner": s.owner, "label": "x" * 5000}, None):
        try:
            s.index_set(h, entry)
            raise AssertionError("the index rewritten into the free-space floor")
        except R.StorageError:
            pass
    assert h not in s.index()
    # an atomic replacement needs room for the whole new file, not its net
    # growth (daybreak2 PR120-FIX-1): a same-size rewrite at the floor is refused ...
    free_total[0] = 10 ** 15
    s.write_file(h, "run.json", b"r" * 3000)
    free_total[0] = R.GiB + 4095
    try:
        s.write_file(h, "run.json", b"q" * 3000)
        raise AssertionError("a same-size rewrite admitted into the floor")
    except R.StorageError:
        pass
    assert open(os.path.join(s.run_dir(h), "run.json"), "rb").read() == b"r" * 3000
    # ... and a growing one whose old file masks most of it, too
    free_total[0] = R.GiB + 8191
    try:
        s.write_file(h, "run.json", b"q" * 7000)
        raise AssertionError("a growing rewrite admitted for its growth only")
    except R.StorageError:
        pass
    # failed writes, fsyncs and replaces leave no temporary, and the total stays the walk's
    free_total[0] = 10 ** 15
    real_write, real_fsync, real_replace = os.write, os.fsync, os.replace
    for what in ("write", "fsync", "replace"):
        def boom(*a, **k):
            raise OSError(28, "No space left on device")
        if what == "write":
            os.write = lambda fd, b: real_write(fd, b[:100]) if len(b) > 100 else boom()
        elif what == "fsync":
            os.fsync = boom
        else:
            os.replace = boom
        try:
            s.write_file(h, "output.txt", b"o" * 5000, durable=True, kind="data")
            raise AssertionError("no failure")
        except OSError:
            pass
        finally:
            os.write, os.fsync, os.replace = real_write, real_fsync, real_replace
        assert not [n for n in os.listdir(s.run_dir(h)) if n.endswith(".tmp")], (what, os.listdir(s.run_dir(h)))
        assert s.used() == s.walk_total(), what
    # (and a temporary a crash left in a run's directory is removed by cleanup)
    open(os.path.join(s.run_dir(h), "run.json.0123456789ab.tmp"), "wb").write(b"x")
    s.cleanup()
    assert not [n for n in os.listdir(s.run_dir(h)) if n.endswith(".tmp")]
    free_total[0] = R.GiB
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
            # (the crashed owners' sessions hold their slots: their runs are in the index)
            assert e.kind == "capacity" and e.extra["slots"] + len(e.extra["unknown"]) == 2, e.extra
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


def test_idle_slots_shared():
    """daybreak2 PR120-FIX-2: every live session of every server sharing the
    store holds a slot, idle or not.  Two owners with a ceiling of 2: A's
    two idle named sessions leave B none; B gets one when A closes; an idle
    slot of an owner that has certainly exited is reclaimed, one whose run is
    still in the index is not."""
    import subprocess

    root = tempfile.mkdtemp(prefix="sb-runs-")
    a = runner(fresh(root=root))
    b = runner(fresh(root=root, owner={"pid": os.getpid(), "nonce": "b"}))
    for r in (a, b):
        r.ceiling = 2
    assert a.start("auto:1", "sage", session="a1")[1] and a.start("auto:1", "sage", session="a2")[1]
    assert a.store.index() == {} and len(a.store.slots()) == 2  # (idle, and holding their slots)
    e = refused("capacity", b.start, "auto:1", "sage", session="b1")
    assert e.extra["slots"] == 2, e.extra
    # (A reactivating its own sessions needs no new slot)
    assert a.start("auto:2", "sage", session="a1")[1]
    a.close()
    assert len(b.store.slots()) == 0
    assert b.start("auto:1", "sage", session="b1")[1] and b.start("auto:1", "sage", session="b2")[1]
    refused("capacity", b.start, "auto:1", "sage", session="b3")
    b.close()
    # a dead owner's idle slot is reclaimed; a dead owner's busy one isn't
    p = subprocess.Popen([sys.executable, "-c", "pass"])
    p.wait()
    dead = {"pid": p.pid, "nonce": "dead"}
    d = runner(fresh(root=root, owner=dead))
    d.ceiling = 2
    assert d.start("auto:1", "sage", session="idle")[1]
    run, _ = d.start("slow", "sage", session="busy", wait=0)
    with d.store.lock:
        slots = d.store.slots()
        for k in slots:
            slots[k]["owner"]["host"] = R._HOST
        R._write_atomic(d.store._slots_path(), json.dumps(slots).encode())
    c = runner(fresh(root=root, owner={"pid": os.getpid(), "nonce": "c"}))
    c.ceiling = 2
    # (the dead owner's two slots: "idle" is reclaimed only because its owner has no run in the index; here it has one)
    refused("capacity", c.start, "auto:1", "sage", session="c1")
    d.made[1].finish("9")
    until(run.done.is_set, "the run's end")
    assert c.start("auto:1", "sage", session="c1")[1]
    assert sorted(k.split(":")[0] for k in c.store.slots()) == ["c"], c.store.slots()
    c.close()
    print("idle sessions hold shared slots: ok")


def test_slot_lifecycle():
    """astra PR120-SEM-7, daybreak2 PR120-FIX3-1/2: a slot taken for a start
    that fails goes back; a pre-existing session's slot stays; a session
    whose close fails, its worker still alive, keeps its slot (another owner
    stays refused); and slots.json is in the running total."""
    import errno

    root = tempfile.mkdtemp(prefix="sb-runs-")
    other = runner(fresh(root=root, owner={"pid": os.getpid(), "nonce": "other"}))
    other.ceiling = 1

    def fails_at(what):
        r = runner(fresh(root=root))
        r.ceiling = 1
        if what == "record":
            real = r.store.save
            r.store.save = lambda rec, durable=False: (_ for _ in ()).throw(OSError(errno.ENOSPC, "No space left on device"))
        elif what == "index":
            real = r.store.index_set
            r.store.index_set = lambda h, e: (_ for _ in ()).throw(OSError(errno.ENOSPC, "No space left on device")) if e is not None else real(h, e)
        else:
            r.new_session = lambda: (_ for _ in ()).throw(RuntimeError("the session did not start"))
        return r

    for what in ("record", "index", "session"):
        r = fails_at(what)
        try:
            run, done = r.start("auto:1", "sage", session="s")
            assert what == "session" and done and r.record(run.record["handle"])["error"]["type"] == "session", (what, run.record)
        except RN.Refused as e:
            assert what != "session" and e.kind == "storage", (what, e.kind)
        assert r.store.slots() == {}, (what, r.store.slots())
        assert r.store.used() == r.store.walk_total(), what
        assert other.start("auto:1", "sage", session="o")[1], what  # (the ceiling is free again)
        other.close()
    # a pre-existing session's slot isn't released by a failed start in it
    r = runner(fresh(root=root))
    r.ceiling = 1
    assert r.start("auto:1", "sage", session="s")[1]
    real = r.store.save
    r.store.save = lambda rec, durable=False: (_ for _ in ()).throw(OSError(errno.ENOSPC, "No space left on device"))
    refused("storage", r.start, "auto:1", "sage", session="s")
    r.store.save = real
    assert list(r.store.slots()) == [r._slot("s")]
    # a close that fails with the worker alive keeps the slot: idle, then busy
    for busy in (False, True):
        if busy:
            run, _ = r.start("slow", "sage", session="s", wait=0)
        s = r.made[-1]
        s.close = lambda: (_ for _ in ()).throw(OSError("couldn't stop it"))
        r.close()
        assert s.alive() and list(r.store.slots()) == [r._slot("s")], (busy, r.store.slots())
        e = refused("capacity", other.start, "auto:1", "sage", session="o")
        assert e.extra["slots"] == 1, e.extra
        if busy:
            assert r.store.load(run.record["handle"])["state"] == "running"
        r.closing = False
    # (slots.json's rewrites are charged: create, grow, release, no cleanup between)
    s = fresh()
    for i in range(40):
        assert s.slot_take("n%d:%s" % (i, "x" * 200), 100) is True
        assert s.used() == s.walk_total(), i
    assert s.slot_take("n0:" + "x" * 200, 100) is False
    for i in range(40):
        s.slot_release("n%d:%s" % (i, "x" * 200))
        assert s.used() == s.walk_total(), i
    print("slot lifecycle: ok")


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


def test_pruned_tombstone():
    """astra PR120-SEM-2: another owner removes a finished run, then its
    tombstone is pruned, all before this server reads it again: the run is
    not revived from the cache (not_found for status and result; keep and
    cancel write nothing)."""
    root = tempfile.mkdtemp(prefix="sb-runs-")
    r = runner(fresh(root=root, env={"SAGEBRUSH_RUNS_KEEP_DAYS": "7"}))
    run, done = r.start("auto:1", "sage")
    h = run.record["handle"]
    other = fresh(root=root, env={"SAGEBRUSH_RUNS_KEEP_DAYS": "7"}, owner={"pid": 2, "nonce": "other"})
    now = time.time()
    assert h in other.cleanup(now=now + 8 * 86400)
    other.cleanup(now=now + 39 * 86400)  # (the tombstone, 31 days old, pruned)
    assert other.load(h) is None
    refused("not_found", r.record, h)
    refused("not_found", r.result, h, 0)
    refused("not_found", r.keep, h, True)
    refused("not_found", r.cancel, h, "hard")
    assert h not in r.runs and not os.path.exists(os.path.join(root, "runs", h))
    # (and a run whose terminal record couldn't be written, its directory there, is still this server's)
    r = runner()
    run, _ = r.start("slow", "sage", wait=0)
    h = run.record["handle"]
    os.unlink(os.path.join(r.store.root, h, "run.json"))
    real = r.store.save
    r.store.save = lambda rec, durable=False: (_ for _ in ()).throw(OSError(28, "No space left on device")) if durable else real(rec, durable)
    r.made[0].finish("5")
    until(run.done.is_set, "the run's end")
    r.store.save = real
    rec = r.record(h)
    assert rec["state"] == "finished" and rec["storage"]["state"] == "unavailable", rec
    print("a pruned tombstone doesn't revive the cache: ok")


def test_close_attribution():
    """astra PR120-SEM-5: a server's close ends its sessions; a run they were
    computing is killed, server_exit, whether the worker's EOF is seen
    before close returns or after; a run that returned before stays a
    return."""
    # the EOF first: the session's close makes the reader see the end
    r = runner()
    run, _ = r.start("slow", "sage", wait=0)
    s = r.made[0]
    s.close = lambda: (s.die(), until(run.done.is_set, "the reader"))
    r.close()
    rec = r.store.load(run.record["handle"])
    assert rec["state"] == "killed" and rec["ended_by"] == "server_exit", rec
    # close first, the reader after
    r = runner()
    run, _ = r.start("slow", "sage", wait=0)
    s = r.made[0]
    s.close = lambda: setattr(s, "live", False)
    r.close()
    s.die()  # (the EOF, late)
    time.sleep(0.2)
    rec = r.store.load(run.record["handle"])
    assert rec["state"] == "killed" and rec["ended_by"] == "server_exit", rec
    # a run that returned before the close
    r = runner()
    run, done = r.start("auto:3", "sage")
    r.made[0].close = lambda: r.made[0].die()
    r.close()
    rec = r.store.load(run.record["handle"])
    assert done and rec["state"] == "finished" and rec["ended_by"] == "return", rec
    print("close attribution: ok")


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
        assert r.made[0].targets == [r.made[0].rid] == [run.rid], "the hard cancel targets the run's own request id"
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
        # (under the store lock, as cleanup removes a run: the run's own
        # post-settle cleanup may be sweeping temporaries at this moment,
        # plan-runs-tmp-sweep r4)
        with r.store.lock:
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


class _Proto:
    """A protocol stream for _Sender: the lines written, whole."""

    def __init__(self):
        self.lines, self.part = [], ""

    def write(self, s):
        self.part += s
        while "\n" in self.part:
            line, self.part = self.part.split("\n", 1)
            self.lines.append(json.loads(line))

    def flush(self):
        pass


def test_capture():
    """The session worker's capture (session._Capture, _Sender): everything
    printed goes out in order, per stream, each message's line at most
    WIRE_MAX bytes; the reply keeps a bounded head and tail; exact counts in
    characters and UTF-8 bytes, stdout and stderr apart."""
    from sagebrush import session as S

    proto = _Proto()
    c = S._Capture(S._Sender(proto))
    out, err = c.stream("stdout"), c.stream("stderr")
    for i in range(100000):
        out.write("line %d \u00e9\u4e2d\U0001f600\n" % i)
        if i % 1000 == 0:
            err.write("warn %d\n" % i)
    c.flush()
    whole_out = "".join("line %d \u00e9\u4e2d\U0001f600\n" % i for i in range(100000))
    whole_err = "".join("warn %d\n" % i for i in range(0, 100000, 1000))
    got = {"stdout": "", "stderr": ""}
    for m in proto.lines:
        got[m["stream"]] += m["out"]
        assert len(json.dumps(m)) + 1 <= S.WIRE_MAX, len(json.dumps(m))
    assert got == {"stdout": whole_out, "stderr": whole_err}
    assert c.chars == {"stdout": len(whole_out), "stderr": len(whole_err)}
    assert c.bytes == {"stdout": len(whole_out.encode()), "stderr": len(whole_err.encode())}, c.bytes
    t = c.text()
    assert "not shown" in t and len(t) < S.REPLY_HEAD + S.REPLY_TAIL + 200
    # (the Runner's Output counts the same bytes from the chunks)
    o = R.Output(64 * R.MiB)
    for m in proto.lines:
        o.add(m["out"], m["stream"])
    assert o.total == c.bytes, (o.total, c.bytes)
    # (one long run of escaped, non-ASCII output: split by the wire limit, not by characters)
    proto = _Proto()
    c = S._Capture(S._Sender(proto))
    long = "\u00e9\u4e2d\U0001f600\x01" * 40000
    c.write(long)
    c.flush()
    assert "".join(m["out"] for m in proto.lines) == long and len(proto.lines) > 1
    assert max(len(json.dumps(m)) + 1 for m in proto.lines) <= S.WIRE_MAX
    c = S._Capture(S._Sender(_Proto()))
    c.write("hi\n")
    assert c.text() == "hi\n"
    print("capture: ok")


def test_capture_signal_boundaries():
    """astra PR120-SEM-4, daybreak2 PR120-FIX-3, with real signals: a SIGINT
    sent to this process just after a message is written (as interrupts
    resume), while it is written, and while it is framed, loses no output,
    repeats none, and is raised once, after the message."""
    import signal as SG

    from sagebrush import session as S

    if not hasattr(SG, "SIGINT") or os.name == "nt":
        print("capture signal boundaries: skipped (POSIX signals)")
        return

    def kill_self(*a):
        os.kill(os.getpid(), SG.SIGINT)
        time.sleep(0.01)  # (delivered while held)

    S._HOLD.install()  # (as the worker does, in its main thread)
    text = "".join("%06d\n" % i for i in range(60000))  # (420,000 characters: several messages)
    for where in ("after", "write", "frame"):
        proto = _Proto()
        sender = S._Sender(proto)
        hits = [0]
        old_hook, old_write, old_dumps = S._commit_hook, proto.write, sender.dumps

        def once(f):
            def g(*a, **k):
                hits[0] += 1
                if hits[0] == 2:  # (the second message: mid-stream)
                    kill_self()
                return f(*a, **k)
            return g

        if where == "after":
            S._commit_hook = once(lambda msg: None)
        elif where == "write":
            def halves(line, f=old_write):
                # (the signal arrives with half the line written)
                hits[0] += 1
                f(line[:len(line) // 2])
                if hits[0] == 2:
                    kill_self()
                f(line[len(line) // 2:])
            proto.write = halves
        else:
            sender.dumps = once(old_dumps)
        c = S._Capture(sender)
        raised = 0
        try:
            c.write(text)
            c.flush()
        except KeyboardInterrupt:
            raised += 1
        finally:
            S._commit_hook = old_hook
        # (as the worker does: the rest after the interrupt, once)
        while True:
            try:
                c.flush()
                break
            except KeyboardInterrupt:
                raised += 1
        sent = "".join(m["out"] for m in proto.lines)
        assert sent == text, (where, len(sent), len(text))
        assert raised == 1, (where, raised)
    # an interrupt raised as a send begins (at its hold, inside the flush's):
    # the chunk wasn't written, so it stays, and goes in the next flush
    proto = _Proto()
    c = S._Capture(S._Sender(proto))
    c.write("y" * 1000)
    real_enter = S._Hold.__enter__
    calls = [0]

    def enter(self):
        calls[0] += 1
        if calls[0] == 2:  # (1: the flush's hold; 2: its send's)
            raise KeyboardInterrupt
        return real_enter(self)

    S._Hold.__enter__ = enter
    try:
        try:
            c.flush()
            raise AssertionError("no interrupt")
        except KeyboardInterrupt:
            pass
    finally:
        S._Hold.__enter__ = real_enter
    c.flush()
    assert "".join(m["out"] for m in proto.lines) == "y" * 1000, len(proto.lines)
    # the reply: written exactly once, even when the interrupt comes as it is written
    proto = _Proto()
    sender = S._Sender(proto)
    S._commit_hook = lambda msg: kill_self() if "result" in msg else None
    try:
        S._send_until_committed(sender, {"result": "1"})
    finally:
        S._commit_hook = None
    assert proto.lines == [{"result": "1"}], proto.lines
    SG.signal(SG.SIGINT, SG.default_int_handler)
    print("capture signal boundaries: ok")


def test_worker_real_signal():
    """The real worker loop (session._worker; the Sage namespace and the
    preparser stubbed, no engine needed), with a real SIGINT at the commit
    of its Nth message: each request gets exactly one reply, the next
    request its own, and the output arrives whole (astra's reproduction of
    PR120-SEM-4)."""
    import subprocess

    if os.name == "nt":
        print("worker real signal: skipped (POSIX signals)")
        return
    pkg = os.path.dirname(RN.__file__)
    harness = (
        "import os, sys, types, signal, time\n"
        "m = types.ModuleType('sagebrush'); m.__path__ = [%r]; sys.modules['sagebrush'] = m\n"
        "sage = types.ModuleType('sagebrush.sage'); sage.__all__ = []; sys.modules['sagebrush.sage'] = sage\n"
        "prep = types.ModuleType('sagebrush.preparse'); prep.preparse = lambda s: s; sys.modules['sagebrush.preparse'] = prep\n"
        "from sagebrush import session as S\n"
        "N = int(sys.argv[1]); n = [0]\n"
        "def hook(msg):\n"
        "    n[0] += 1\n"
        "    if n[0] == N:\n"
        "        os.kill(os.getpid(), signal.SIGINT); time.sleep(0.01)\n"
        "S._commit_hook = hook\n"
        "S._worker()\n" % pkg)
    reqs = "".join(json.dumps({"code": c, "mode": "python"}) + "\n" for c in ("1", "print('x' * 200000)", "2", "import sys\nsys.stderr.write('\u00e9' * 10)\n3"))
    for nth in range(2, 8):
        r = subprocess.run([sys.executable, "-c", harness, str(nth)], input=reqs, capture_output=True, text=True, timeout=60)
        msgs = [json.loads(l) for l in r.stdout.splitlines()]
        replies = [m for m in msgs if "result" in m]
        outs = "".join(m["out"] for m in msgs if "out" in m and m.get("stream") == "stdout")
        assert msgs[0] == {"ready": True} and len(replies) == 4, (nth, [m.get("result", "out" if "out" in m else m) for m in msgs])
        errs = [m for m in msgs if m.get("stream") == "stderr"]
        if replies[3]["error_info"] is None:
            # (stderr is its own stream, counted in bytes: 10 two-byte characters)
            assert "".join(m["out"] for m in errs) == "\u00e9" * 10 and replies[3]["output_bytes"] == {"stdout": 0, "stderr": 20}, (nth, errs, replies[3])
        msgs = [m for m in msgs if m.get("stream") != "stderr"]
        assert replies[0]["result"] == "1" and replies[2]["result"] == "2", (nth, replies)
        # (an interrupt during the print may stop it before its newline: what
        # was printed, all of it, matches the reply's exact counts)
        assert ("x" * 200000 + "\n").startswith(outs) and len(outs) >= 200000, (nth, len(outs))
        assert replies[1]["stdout_chars"] == len(outs) and replies[1]["output_bytes"]["stdout"] == len(outs), (nth, replies[1]["stdout_chars"], len(outs))
        interrupted = replies[1]["error_info"] is not None
        assert interrupted == (len(outs) == 200000), (nth, replies[1]["error_info"], len(outs))
    print("worker real signal: ok")


def test_print_gate():
    """gh-130163: which interpreters get the worker's owning print()."""
    from sagebrush import session as S

    yes = [(3, 10, 0), (3, 10, 20), (3, 11, 15), (3, 12, 0), (3, 12, 3), (3, 12, 9), (3, 13, 0), (3, 13, 2)]
    no = [(3, 12, 10), (3, 12, 15), (3, 13, 3), (3, 13, 14), (3, 14, 0), (3, 15, 0)]
    for v in yes:
        assert S._print_borrows_stdout(v, "cpython"), v
        assert not S._print_borrows_stdout(v, "pypy"), v
    for v in no:
        assert not S._print_borrows_stdout(v, "cpython"), v
    print("print gate: ok")


def test_strong_print():
    """The owning print() behaves as print(): its arguments, file=None, a
    sys.stdout of None (nothing printed), flush."""
    import builtins
    import io
    from sagebrush import session as S

    real = builtins.print
    try:
        S._strong_print()
        assert builtins.print is not real and builtins.print.__wrapped__ is real
        buf = io.StringIO()
        saved = sys.stdout
        try:
            sys.stdout = buf
            print(1, "a", sep="-", end="!")
            print()
            print(2, file=None, flush=True)
            print("x", sep=None, end=None)
            sys.stdout = None
            print("nothing")
        finally:
            sys.stdout = saved
        assert buf.getvalue() == "1-a!\n2\nx\n", repr(buf.getvalue())
        other = io.StringIO()
        print("to", "file", file=other)
        assert other.getvalue() == "to file\n"
    finally:
        builtins.print = real
    print("owning print: ok")


def print_across_runs(control=False):
    """FU-WORKERTHREADS-312 (astra's CORR-WT312-KA-1), on the real worker
    loop: a thread still inside print() (its second argument's __str__
    sleeping, after the first was written) when its run ends, across the
    next request, which collects garbage while it waits: the worker lives
    and every reply comes; the late output is the old run's, dropped.
    control: the worker's owning print() turned off (the fail-first)."""
    import subprocess

    pkg = os.path.dirname(RN.__file__)
    harness = (
        "import os, sys, types\n"
        "m = types.ModuleType('sagebrush'); m.__path__ = [%r]; sys.modules['sagebrush'] = m\n"
        "sage = types.ModuleType('sagebrush.sage'); sage.__all__ = []; sys.modules['sagebrush.sage'] = sage\n"
        "prep = types.ModuleType('sagebrush.preparse'); prep.preparse = lambda s: s; sys.modules['sagebrush.preparse'] = prep\n"
        "from sagebrush import session as S\n"
        "if %r: S._print_borrows_stdout = lambda: False\n"
        "S._worker()\n" % (pkg, control))
    first = (
        "import threading, time\n"
        "class Slow:\n"
        "    def __str__(self):\n"
        "        time.sleep(0.6)\n"
        "        return 'LATE' * 1000\n"
        "threading.Thread(target=lambda: print('early', Slow())).start()\n"
        "time.sleep(0.1)\n"
        "1\n")
    second = "import gc, time\nfor _ in range(20):\n    gc.collect()\n    x = [object() for _ in range(2000)]\n    time.sleep(0.05)\n2\n"
    reqs = "".join(json.dumps({"code": c, "mode": "python"}) + "\n" for c in (first, second, "3"))
    r = subprocess.run([sys.executable, "-X", "faulthandler", "-c", harness], input=reqs, capture_output=True, text=True, timeout=60)
    msgs = []
    for line in r.stdout.splitlines():
        try:
            msgs.append(json.loads(line))
        except ValueError:
            pass
    replies = [m for m in msgs if "result" in m]
    late = "".join(m.get("out", "") for m in msgs if "out" in m)
    return r.returncode, [x["result"] for x in replies], "LATE" in late


def test_print_across_runs():
    code, results, late = print_across_runs()
    assert code == 0 and results == ["1", "2", "3"], (code, results)
    assert not late, "the old run's late output reached a later run"
    print("a print() across the next run: ok (the owning print %s here)" % ("in use" if __import__("sagebrush.session").session._print_borrows_stdout() else "not needed"))


def test_worker_threads():
    """astra PR120-SEM-6, on the real worker loop: output from a thread, a
    thread pool and the main thread at once, large enough to fill chunks,
    with and without a real Ctrl-C during it: no exception in the threads,
    every line valid JSON, and per-stream totals that match the reply."""
    import subprocess

    if os.name == "nt":
        print("worker threads: skipped (POSIX signals)")
        return
    pkg = os.path.dirname(RN.__file__)
    harness = (
        "import os, sys, types, signal, time\n"
        "m = types.ModuleType('sagebrush'); m.__path__ = [%r]; sys.modules['sagebrush'] = m\n"
        "sage = types.ModuleType('sagebrush.sage'); sage.__all__ = []; sys.modules['sagebrush.sage'] = sage\n"
        "prep = types.ModuleType('sagebrush.preparse'); prep.preparse = lambda s: s; sys.modules['sagebrush.preparse'] = prep\n"
        "from sagebrush import session as S\n"
        "N = int(sys.argv[1]); n = [0]\n"
        "def hook(msg):\n"
        "    n[0] += 1\n"
        "    if n[0] == N:\n"
        "        os.kill(os.getpid(), signal.SIGINT)\n"
        "S._commit_hook = hook\n"
        "S._worker()\n" % pkg)
    code = (
        "import sys, threading\n"
        "from concurrent.futures import ThreadPoolExecutor\n"
        "errors = []\n"
        "def big(i):\n"
        "    try:\n"
        "        print('t%d' % i + 'x' * 70000)\n"
        "        sys.stderr.write('e%d' % i + '\u00e9' * 30000 + '\\n')\n"
        "    except BaseException as e:\n"
        "        errors.append(repr(e))\n"
        "t = threading.Thread(target=big, args=(0,)); t.start()\n"
        "with ThreadPoolExecutor(4) as ex:\n"
        "    list(ex.map(big, range(1, 5)))\n"
        "for j in range(200):\n"
        "    print('m' * 500)\n"
        "t.join()\n"
        "errors\n")
    reqs = json.dumps({"code": code, "mode": "python"}) + "\n" + json.dumps({"code": "7", "mode": "python"}) + "\n"
    for nth in (0, 3, 9):
        r = subprocess.run([sys.executable, "-c", harness, str(nth)], input=reqs, capture_output=True, text=True, timeout=120)
        msgs = [json.loads(l) for l in r.stdout.splitlines()]  # (every line valid JSON)
        replies = [m for m in msgs if "result" in m]
        assert len(replies) == 2 and replies[1]["result"] == "7", (nth, [x.get("result") for x in replies], r.stderr[-500:])
        rep = replies[0]
        got = {"stdout": 0, "stderr": 0}
        for m in msgs:
            if "out" in m:
                got[m["stream"]] += len(m["out"].encode("utf-8", "surrogatepass"))
                assert len(json.dumps(m)) + 1 <= 64 * 1024
        assert got == rep["output_bytes"], (nth, got, rep["output_bytes"])
        if rep["error_info"] is None:
            assert rep["result"] == "[]", (nth, rep["result"])  # (no thread failed: no ValueError)
            assert got == {"stdout": 5 * 70003 + 200 * 501, "stderr": 5 * (2 + 60000 + 1)}, (nth, got)
        else:
            assert nth and rep["error_info"]["type"] == "interrupted", (nth, rep["error_info"])
    print("worker threads: ok")


def test_late_output_sealed():
    """astra PR120-SEM-8, on the real worker loop: a run's capture is sealed
    at its end, with its drain and its reply.  A thread that keeps the run's
    stream and writes later (after the reply, or racing the end) has that
    output dropped: the next run never streams or counts it, and each run's
    streamed bytes equal its reply's counts."""
    import subprocess

    pkg = os.path.dirname(RN.__file__)
    harness = (
        "import os, sys, types\n"
        "m = types.ModuleType('sagebrush'); m.__path__ = [%r]; sys.modules['sagebrush'] = m\n"
        "sage = types.ModuleType('sagebrush.sage'); sage.__all__ = []; sys.modules['sagebrush.sage'] = sage\n"
        "prep = types.ModuleType('sagebrush.preparse'); prep.preparse = lambda s: s; sys.modules['sagebrush.preparse'] = prep\n"
        "from sagebrush import session as S\n"
        "S._worker()\n" % pkg)
    A = ("import threading, sys, time\n"
         "ev = threading.Event(); out, err = sys.stdout, sys.stderr\n"
         "def late():\n    ev.wait(); out.write('OLD' * 24000); err.write('ERR' * 1000)\n"
         "ths = [threading.Thread(target=late, daemon=True) for i in range(3)]\n"
         "[t.start() for t in ths]\n'A'")
    B = "ev.set(); [t.join() for t in ths]; print('new')\n'B'"
    C = ("stop = threading.Event(); o2, e2 = sys.stdout, sys.stderr\n"
         "def spin(f):\n    while not stop.is_set(): f.write('z' * 100)\n"
         "sp = [threading.Thread(target=spin, args=(f,), daemon=True) for f in (o2, e2, o2)]\n"
         "[t.start() for t in sp]\ntime.sleep(0.3)\n'C'")
    D = "stop.set(); [t.join() for t in sp]; print('d')\n'D'"
    reqs = "".join(json.dumps({"code": c, "mode": "python"}) + "\n" for c in (A, B, C, D))
    r = subprocess.run([sys.executable, "-c", harness], input=reqs, capture_output=True, text=True, timeout=120)
    runs, cur = [], {"stdout": 0, "stderr": 0}
    for line in r.stdout.splitlines()[1:]:
        m = json.loads(line)
        if "out" in m:
            cur[m["stream"]] += len(m["out"].encode())
        else:
            runs.append((m, cur))
            cur = {"stdout": 0, "stderr": 0}
    assert [m["result"] for m, _ in runs] == ["'A'", "'B'", "'C'", "'D'"], ([m.get("result") for m, _ in runs], r.stderr[-500:])
    assert cur == {"stdout": 0, "stderr": 0}, cur  # (nothing after the last reply)
    for m, streamed in runs:
        assert streamed == m["output_bytes"], (m["result"], streamed, m["output_bytes"])
    assert runs[0][1] == {"stdout": 0, "stderr": 0}
    assert runs[1][1] == {"stdout": 4, "stderr": 0}, runs[1][1]  # (B: only its own 'new\n')
    assert runs[2][1]["stdout"] > 0 and runs[2][1]["stderr"] > 0  # (C's writers, up to its seal)
    assert runs[3][1] == {"stdout": 2, "stderr": 0}, runs[3][1]
    print("late output sealed: ok")


def test_session_start_failure():
    """daybreak2 PR120-FIX4-1: a start that fails before its session exists
    (its handle; the session's own start, whose child is already running)
    gives back the slot it took, and only once no worker of it is alive."""
    import errno
    from sagebrush import session as S

    root = tempfile.mkdtemp(prefix="sb-runs-")
    other = runner(fresh(root=root, owner={"pid": os.getpid(), "nonce": "other2"}))
    other.ceiling = 1
    # the handle
    r = runner(fresh(root=root))
    r.ceiling = 1
    r.store.new_handle = lambda: (_ for _ in ()).throw(OSError(errno.ENOSPC, "No space left on device"))
    refused("storage", r.start, "auto:1", "sage", session="s")
    assert r.store.slots() == {} and other.start("auto:1", "sage", session="o")[1]
    other.close()
    # the real Session, whose child never says ready
    procs = []

    class Stuck(S.Session):
        WORKER_ARGV = [sys.executable, "-c", "import time; time.sleep(60)"]
        READY_S = 0.5

        def _start(self):
            try:
                super()._start()
            finally:
                procs.append(self.proc)

    r = RN.Runner(store=fresh(root=root), session_factory=Stuck)
    r.ceiling = 1
    run, done = r.start("1", "python", session="s")
    rec = r.record(run.record["handle"])
    assert done and rec["error"]["type"] == "session" and "did not start" in rec["error"]["message"], rec
    assert procs and procs[0].poll() is not None, "the stuck child is still alive"
    assert r.store.slots() == {} and other.start("auto:1", "sage", session="o")[1]
    other.close()
    print("session start failure: ok")


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
    test_idle_slots_shared()
    test_slot_lifecycle()
    test_tombstones_win()
    test_pruned_tombstone()
    test_close_attribution()
    test_cancel_contract()
    test_close_settles()
    test_capture()
    test_capture_signal_boundaries()
    test_worker_real_signal()
    test_print_gate()
    test_strong_print()
    test_print_across_runs()
    test_worker_threads()
    test_late_output_sealed()
    test_session_start_failure()
    test_real_session_output()
    test_server()
    print("runs: all ok")
