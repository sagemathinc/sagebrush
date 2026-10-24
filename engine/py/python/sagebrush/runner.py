"""Runs for agents (H′1a; design-hprime-host-r5 §1.1, §2, §3.1, §3.3, §7):
the `sage` and `python` tools start a run in a session and wait for it
up to `wait` seconds; if it hasn't ended then, the call returns a ticket
(the run's handle) and the computation keeps running.  Nothing stops a run
but the caller: a `run_deadline` it gave, or a cancel.

The run's record (sagebrush.run/1) is kept in the store (sagebrush.runs).
Its state is the host's: what the session did, never a library outcome
made up for it.
"""

import hashlib
import json
import threading
import time

from sagebrush import runs as R

ESCALATE_S = 10.0          # a hard request not answered by then restarts the session
WAIT_DEFAULT, WAIT_MAX = 60.0, 3600.0
RESULT_WAIT_DEFAULT, RESULT_WAIT_MAX = 30.0, 600.0
LABEL_MAX = 80
IDEMPOTENT_S = 24 * 3600


class Refused(Exception):
    """A start or request refused before anything ran: (type, message, extra)."""

    def __init__(self, kind, message, **extra):
        super().__init__(message)
        self.kind, self.extra = kind, extra


def seconds(v, name, default, high, allow_zero=True):
    """A wait or deadline argument: a finite number from 0 (or more) to high."""
    if v is None:
        return default
    if isinstance(v, bool) or not isinstance(v, (int, float)) or v != v or v in (float("inf"), float("-inf")):
        raise Refused("invalid", "`%s` must be a number of seconds" % name)
    if v < 0 or (v == 0 and not allow_zero) or v > high:
        raise Refused("invalid", "`%s` must be from %s to %g seconds" % (name, "0" if allow_zero else "more than 0", high))
    return float(v)


def clean_label(label):
    """The agent's label: at most 80 characters, control characters removed
    (it is public text: it may appear in notifications)."""
    if label is None:
        return None
    if not isinstance(label, str):
        raise Refused("invalid", "`label` must be a string")
    return "".join(c for c in label if c >= " " and c != "\x7f")[:LABEL_MAX] or None


class _Run:
    """A run of this server: its record, its session and the reply."""

    def __init__(self, record, sess, name):
        self.record = record
        self.sess = sess
        self.session_name = name
        self.done = threading.Event()
        self.reply = None
        self.lock = threading.Lock()


class Runner:
    def __init__(self, store=None, session_factory=None, clock=time.time):
        from sagebrush.session import Session

        self.store = store or R.Store()
        self.new_session = session_factory or Session
        self.clock = clock
        self.lock = threading.RLock()
        self.sessions = {}      # name -> Session
        self.current = {}       # session name -> handle of its running run
        self.seq = {}           # session name -> runs started
        self.runs = {}          # handle -> _Run (this server's)
        self.requests = {}      # request_id -> (key, answer, at)
        self.fresh = 0
        self.restarting = set()  # sessions an escalation is restarting
        cfg = self.store.cfg["SAGEBRUSH_RUNS_SESSIONS"]
        self.ceiling = min(cfg, R.session_ceiling())

    # ---- sessions and admission (§7)
    def _session(self, name):
        """(name, Session) for a request's `session`: "main" by default, an
        existing named one, or "new"; admitted against the ceiling."""
        if name is None:
            name = "main"
        if not isinstance(name, str) or not name or len(name) > 40:
            raise Refused("invalid", "`session` must be a name (at most 40 characters) or \"new\"")
        fresh = name == "new"
        if fresh:
            name = "new-%d" % (self.fresh + 1)
        s = self.sessions.get(name)
        if s is None:
            live = sum(1 for x in self.sessions.values() if x.alive())
            if live >= self.ceiling:
                raise Refused("capacity", "%d sessions are running, the most this machine allows (%d)" % (live, self.ceiling),
                              limit=self.ceiling, active=sorted(self.current.values()))
            s = self.sessions[name] = self.new_session()
            if fresh:
                self.fresh += 1
        return name, s

    def _idempotent(self, request_id, key):
        """The earlier answer to request_id if it was for key; a Refused if
        it was for something else; None if new."""
        if request_id is None:
            return None
        if not isinstance(request_id, str) or not request_id or len(request_id) > 200:
            raise Refused("invalid", "`request_id` must be a string (at most 200 characters)")
        now = self.clock()
        for k in [k for k, v in self.requests.items() if now - v[2] > IDEMPOTENT_S]:
            del self.requests[k]
        old = self.requests.get(request_id)
        if old is None:
            return None
        if old[0] != key:
            raise Refused("invalid", "`request_id` %r was already used for a different request" % request_id)
        return old[1]

    # ---- starting a run
    def start(self, code, mode, wait=None, run_deadline=None, label=None, request_id=None, session=None, started_by="unknown", timeout=None, on_start=None):
        """Start a code run and wait up to `wait`: (run, finished?).
        on_start(handle) is called once the run exists, before the wait."""
        if timeout is not None and wait is not None and timeout != wait:
            raise Refused("invalid", "`timeout` is the old name of `wait`: give one, or equal values")
        wait = seconds(wait if wait is not None else timeout, "wait", WAIT_DEFAULT, WAIT_MAX)
        deadline = None if run_deadline is None else seconds(run_deadline, "run_deadline", None, 10 ** 9, allow_zero=False)
        label = clean_label(label)
        key = ("start", mode, session, hashlib.sha256(code.encode("utf-8", "surrogatepass")).hexdigest(), label, deadline)
        with self.lock:
            earlier = self._idempotent(request_id, key)
            if earlier is not None:
                run = self.runs.get(earlier)
                if run is None:
                    raise Refused("invalid", "`request_id` %r named a run of an earlier server" % request_id)
            else:
                name, sess = self._session(session)
                if name in self.current:
                    raise Refused("busy", "the session %r is running %s" % (name, self.current[name]), running=self.current[name])
                if name in self.restarting:
                    raise Refused("busy", "the session %r is being restarted; try again in a few seconds" % name)
                handle = self.store.new_handle()
                self.seq[name] = self.seq.get(name, 0) + 1
                before = sess.generation
                gen, q = sess.submit(code, mode=mode)
                rec = R.new_record(self.store, handle, "code", mode, {"id": name, "generation": gen}, self.seq[name], started_by, label, now=self.clock())
                rec["code_sha256"] = key[3]
                if before and gen != before:
                    # (the session had ended since its last run: a new process, its variables gone)
                    rec["session_restarted"] = True
                run = _Run(rec, sess, name)
                self.runs[handle] = run
                self.current[name] = handle
                self.store.save(rec)
                self.store.index_set(handle, {"started_at": rec["started_at"], "started_by": started_by, "owner": self.store.owner, "label": label})
                threading.Thread(target=self._finish, args=(run, q, gen), daemon=True).start()
                if deadline is not None:
                    t = threading.Timer(deadline, self._request, args=(run, "run_deadline", gen, rec["run_seq"]))
                    t.daemon = True
                    t.start()
                if request_id is not None:
                    self.requests[request_id] = (key, handle, self.clock())
        if on_start is not None:
            on_start(run.record["handle"])
        finished = run.done.wait(wait)
        with self.lock:
            if not finished and not run.record.get("ticketed"):
                # (the decision to return a ticket, and ticketed, in one step:
                # a run ending now is seen by _finish under the same lock)
                if run.done.is_set():
                    finished = True
                else:
                    run.record["ticketed"] = True
                    self.store.save(run.record)
        return run, finished

    # ---- the end of a run (§2.2's mapping)
    def _finish(self, run, q, gen):
        r = q.get()
        now = self.clock()
        with self.lock:
            rec = run.record
            rec["ended_at"] = now
            rec["elapsed_s"] = round(now - rec["started_at"], 3)
            rec["last_seen_at"] = now
            if r is None:
                restart = [x for x in rec["requests"] if x.get("result") == "restarted"]
                if restart:
                    rec["state"], rec["ended_by"] = "killed", "restart"
                    rec["restart_cause"] = restart[-1]["kind"]
                    rec["restarted"] = True
                    for h in rec.get("retained", []):
                        h["state"] = "invalid"
                else:
                    rec["state"], rec["ended_by"] = "finished", "error"
                    rec["error"] = {"type": "session", "exception": None,
                                    "message": "the session process ended during the computation (out of memory, or killed)", "traceback": ""}
            else:
                run.reply = r
                info = r.get("error_info")
                rec["state"] = "finished"
                out = R.Output(self.store.cfg["SAGEBRUSH_RUNS_OUTPUT_BYTES"])
                if r.get("stdout"):
                    out.add(r["stdout"])
                if out.total["stdout"]:
                    self.store.write_file(rec["handle"], "output.txt", out.bytes(), durable=True)
                rec["output"] = out.info(rec["handle"] + "/output.txt" if out.total["stdout"] else None)
                if info is None:
                    rec["ended_by"] = "return"
                    v = r.get("result")
                    if v is not None:
                        data = v.encode("utf-8", "replace")
                        if len(data) <= R.INLINE_VALUE:
                            rec["value"] = {"text": v}
                        else:
                            path, why = self.store.write_value(rec["handle"], json.dumps({"text": v}).encode())
                            rec["value"] = {"summary": "%d characters" % len(v), "text": v[:1000] + " ...", **({"path": rec["handle"] + "/value.json"} if path else {"unavailable": why})}
                    if r.get("displays"):
                        rec["displays"] = len(r["displays"])
                else:
                    self._attribute(rec, info)
            self.current.pop(run.session_name, None)
            self.store.save(rec, durable=True)
            self.store.index_set(rec["handle"], None)
            run.done.set()
        try:
            self.store.cleanup()
        except Exception:
            pass

    def _attribute(self, rec, info):
        """ended_by for an error: an interrupt is attributed to the latest host
        request delivered before it (correlation, never proof); with none,
        it is unattributed."""
        kind = info.get("type")
        err = {k: info.get(k) for k in ("type", "exception", "message", "traceback")}
        if info.get("memory"):
            rec["memory"] = info["memory"]
        if kind == "interrupted":
            at = info.get("at") or rec.get("ended_at")
            order = {"cancel_hard": 0, "run_deadline": 1, "idle_stop": 2}
            prior = [x for x in rec["requests"] if x.get("delivered_at") is not None and x["delivered_at"] <= at and x["kind"] in order]
            if prior:
                last = max(prior, key=lambda x: (x["delivered_at"], -order[x["kind"]]))
                rec["ended_by"], rec["attribution"] = last["kind"], "correlated"
            else:
                rec["ended_by"], rec["attribution"] = "interrupt", "none"
        else:
            rec["ended_by"] = "error"
        rec["error"] = err

    # ---- requests: cancel, deadline (§3.3)
    def _request(self, run, kind, gen, seq, request=None):
        """Deliver a hard interrupt for run, only if it is still its session's
        current run (generation and run_seq: one step under the lock), and
        arm the escalation."""
        with self.lock:
            rec = run.record
            current = self.current.get(run.session_name) == rec["handle"] and run.sess.generation == gen and rec["run_seq"] == seq and rec["state"] == "running"
            entry = request or {"request_id": None, "kind": kind}
            entry.update(at=self.clock())
            if not current:
                entry["result"] = "not_running"
                return entry
            # (stamped before the signal: the interrupt it causes can't be
            # timed before its request)
            entry["delivered_at"], entry["result"] = self.clock(), "delivered"
            run.sess.interrupt()
            rec["requests"].append(entry)
            self.store.save(rec)
            t = threading.Timer(ESCALATE_S, self._escalate, args=(run, gen, seq, entry))
            t.daemon = True
            t.start()
            return dict(entry)

    def _escalate(self, run, gen, seq, entry):
        """10 s after a hard request: still the same run, still running, so the
        session is restarted (the request's kind is the restart's cause)."""
        with self.lock:
            rec = run.record
            if not (self.current.get(run.session_name) == rec["handle"] and run.sess.generation == gen and rec["run_seq"] == seq and rec["state"] == "running"):
                return
            entry["result"] = "restarted"
            self.store.save(rec)
            self.restarting.add(run.session_name)
        # (outside the lock: a restart can take a while; no run starts in
        # the session meanwhile)
        try:
            run.sess.restart()
        finally:
            with self.lock:
                self.restarting.discard(run.session_name)
        with self.lock:
            rec["replacement_generation"] = run.sess.generation
            self.store.save(rec, durable=rec["state"] != "running")

    def cancel(self, handle, mode="soft", request_id=None):
        if mode not in ("soft", "hard"):
            raise Refused("invalid", "`mode` must be \"soft\" or \"hard\"")
        key = ("cancel", handle, mode)
        with self.lock:
            earlier = self._idempotent(request_id, key)
            if earlier is not None:
                return earlier
            run = self.runs.get(handle)
            if run is None:
                rec = self.store.load(handle) if isinstance(handle, str) else None
                if rec is None:
                    raise Refused("not_found", "no run %r" % (handle,))
                ans = {"result": "not_running" if rec.get("state") != "running" else "not_owned", "state": rec.get("state")}
            elif mode == "soft":
                # (a soft stop needs the library's request_stop, PR 5a: not in this build)
                ans = {"result": "soft_unavailable", "state": run.record["state"],
                       "reason": "a soft stop with a partial result isn't available in this build; ask for mode \"hard\""}
            else:
                rec = run.record
                ans = self._request(run, "cancel_hard", rec["session"]["generation"], rec["run_seq"], {"request_id": request_id, "kind": "cancel_hard"})
                ans = {"result": ans.get("result"), "state": rec["state"]}
            if request_id is not None:
                self.requests[request_id] = (key, ans, self.clock())
            return ans

    # ---- reading
    def record(self, handle):
        with self.lock:
            run = self.runs.get(handle)
            if run is not None:
                rec = dict(run.record)
                if rec["state"] == "running":
                    rec["elapsed_s"] = round(self.clock() - rec["started_at"], 1)
                return rec
        rec = self.store.load(handle) if isinstance(handle, str) else None
        if rec is None:
            raise Refused("not_found", "no run %r" % (handle,))
        return self.store.view(rec)

    def result(self, handle, wait=None):
        wait = seconds(wait, "wait", RESULT_WAIT_DEFAULT, RESULT_WAIT_MAX)
        run = self.runs.get(handle)
        if run is not None:
            run.done.wait(wait)
        return self.record(handle), (run.reply if run is not None and run.done.is_set() else None)

    def keep(self, handle, keep):
        if not isinstance(keep, bool):
            raise Refused("invalid", "`keep` must be true or false")
        with self.lock:
            run = self.runs.get(handle)
            rec = run.record if run is not None else self.store.load(handle)
            if rec is None or rec.get("state") == "gone":
                raise Refused("not_found", "no run %r" % (handle,))
            if run is None and rec.get("state") == "running":
                raise Refused("not_owned", "run %s belongs to another server" % handle)
            rec["keep"] = keep
            self.store.save(rec)
            return {"handle": handle, "keep": keep}

    def reset(self, name="main"):
        """The reset tool: restart a session that isn't running a run."""
        with self.lock:
            if name in self.current:
                raise Refused("busy", "the session %r is running %s: cancel it first" % (name, self.current[name]), running=self.current[name])
            if name in self.restarting:
                return
            s = self.sessions.get(name)
            if s is not None:
                self.restarting.add(name)
        try:
            if s is not None:
                s.restart()
        finally:
            with self.lock:
                self.restarting.discard(name)

    def summary(self):
        return self.store.summary(self.clock())

    def close(self):
        for s in self.sessions.values():
            s.close()
