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
    test_server()
    print("runs: all ok")
