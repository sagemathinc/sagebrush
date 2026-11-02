"""Runs for agents (H′1a; design-hprime-host-r5 §1.1, §2, §3.1, §3.3, §7):
the `sage` and `python` tools start a run in a session and wait for it
up to `wait` seconds; if it hasn't ended then, the call returns a ticket
(the run's handle) and the computation keeps running.  Nothing stops a run
but the caller: a `run_deadline` it gave, or a cancel.

The run's record (sagebrush.run/1) is kept in the store (sagebrush.runs).
Its state is the host's: what the session did, never a library outcome
made up for it.  A run always settles when its computation ends: a store
that can't be written (full, ENOSPC) is said in the record (`storage`),
never left as a run that looks busy forever.
"""

import hashlib
import json
import secrets
import sys
import threading
import time

from sagebrush import runs as R

ESCALATE_S = 10.0          # a hard request not answered by then restarts the session
WAIT_DEFAULT, WAIT_MAX = 60.0, 3600.0
RESULT_WAIT_DEFAULT, RESULT_WAIT_MAX = 30.0, 600.0
LABEL_MAX = 80
IDEMPOTENT_S = 24 * 3600
TERMINAL = ("finished", "killed", "lost", "gone")


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
        self.rid = None  # (its request's id in the session, once submitted: what its interrupts target)
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
        self.closing = False     # the server is exiting: a run ended by that is killed, server_exit
        cfg = self.store.cfg["SAGEBRUSH_RUNS_SESSIONS"]
        self.ceiling = min(cfg, R.session_ceiling())

    # ---- sessions and admission (§7)
    def _pick(self, name):
        """(name, Session or None if it has to be made) for a request's
        `session`: "main" by default, an existing named one, or "new"."""
        if name is None:
            name = "main"
        if not isinstance(name, str) or not name or len(name) > 40:
            raise Refused("invalid", "`session` must be a name (at most 40 characters) or \"new\"")
        if name == "new":
            name = "new-%d" % (self.fresh + 1)
        return name, self.sessions.get(name)

    def _slot(self, name):
        return "%s:%s" % (self.store.owner["nonce"], name)

    def _admit(self, name):
        """Under the store lock: room for one more run in session `name`.  Its
        session slot is taken, or confirmed still held (a reactivated
        session passes the same admission): the store's slots, of every
        server sharing it, idle sessions included, and the runs of other
        owners without one (liveness unknown) count against the ceiling, so
        sessions and the active index stay bounded by it.  And the store
        must have room for the run's records (R.RUN_META_BYTES).  True if the
        slot was taken now (to be rolled back if no session comes of it)."""
        try:
            self.store.admit(R.RUN_META_BYTES, "meta")
        except R.StorageError as e:
            raise Refused("storage", "no room for another run: %s" % e)
        try:
            return self.store.slot_take(self._slot(name), self.ceiling)
        except R.SlotRefused as e:
            raise Refused("capacity", "%d of the %d session slots this machine allows are held (by sessions of this and other servers%s)"
                          % (e.used, e.ceiling, ", and %d runs of other servers, liveness unknown" % len(e.unknown) if e.unknown else ""),
                          limit=self.ceiling, active=sorted(self.current.values()), unknown=e.unknown, slots=len(e.slots))
        except (OSError, R.StorageError) as e:
            raise Refused("storage", "no room for another run: %s" % e)

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
                name, sess = self._pick(session)
                if name in self.current:
                    raise Refused("busy", "the session %r is running %s" % (name, self.current[name]), running=self.current[name])
                if name in self.restarting:
                    raise Refused("busy", "the session %r is being restarted; try again in a few seconds" % name)
                # (admission, the record and its index entry in one step under
                # the store lock: another server's admission sees this run)
                with self.store.lock:
                    took = self._admit(name)
                    try:
                        handle = self.store.new_handle()
                    except OSError as e:
                        # (no run, no session: a slot taken for it goes back, daybreak2 PR120-FIX4-1)
                        if took and sess is None:
                            self.store.slot_release(self._slot(name))
                        raise Refused("storage", "the run couldn't be recorded: %s" % e)
                    self.seq[name] = self.seq.get(name, 0) + 1
                    rec = R.new_record(self.store, handle, "code", mode, {"id": name, "generation": None}, self.seq[name], started_by, label, now=self.clock())
                    rec["code_sha256"] = key[3]
                    try:
                        self.store.save(rec)
                        self.store.index_set(handle, {"started_at": rec["started_at"], "started_by": started_by, "owner": self.store.owner, "label": label})
                    except (OSError, R.StorageError) as e:
                        self.store.discard(handle)
                        if took and sess is None:
                            self.store.slot_release(self._slot(name))  # (no session came of it)
                        raise Refused("storage", "the run couldn't be recorded: %s" % e)
                run = _Run(rec, sess, name)
                self.runs[handle] = run
                self.current[name] = handle
                try:
                    if sess is None:
                        sess = self.sessions[name] = self.new_session()
                        if name.startswith("new-"):
                            self.fresh += 1
                        run.sess = sess
                    before = sess.generation
                    gen, q, rid = sess.submit(code, mode=mode)
                    run.rid = rid
                except Exception as e:
                    # (the session couldn't start: the run settles at once,
                    # and a slot taken for it goes back, daybreak2 PR120-FIX3-2)
                    q = None
                    if took and self.sessions.get(name) is None:
                        self.store.slot_release(self._slot(name))
                    self._settle(run, {"type": "session", "exception": type(e).__name__, "message": "the session couldn't start: %s" % e, "traceback": ""})
                if q is not None:
                    rec["session"]["generation"] = gen
                    if before and gen != before:
                        # (the session had ended since its last run: a new process, its variables gone)
                        rec["session_restarted"] = True
                    self._save(rec)
                    threading.Thread(target=self._finish, args=(run, q, gen, rid), daemon=True).start()
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
                    self._save(run.record)
        return run, finished

    # ---- persistence that never strands a run
    def _save(self, rec, durable=False):
        """The record to the store; a failure is kept in the record
        (`storage`), never raised into the run's bookkeeping."""
        try:
            self.store.save(rec, durable=durable)
            return True
        except (OSError, R.StorageError) as e:
            rec["storage"] = {"state": "unavailable", "reason": "the run's record couldn't be written: %s" % e}
            return False

    def _settle(self, run, error=None):
        """The end of a run's bookkeeping, whatever failed before it: the
        session is free, the index entry gone (or the failure said), the
        terminal record published as far as the store allows, and the
        waiters woken.  Called under self.lock."""
        rec = run.record
        if error is not None and rec.get("state") == "running":
            now = self.clock()
            rec.update(state="finished", ended_by="error", ended_at=now, elapsed_s=round(now - rec["started_at"], 3), last_seen_at=now, error=error)
        try:
            if self.current.get(run.session_name) == rec["handle"]:
                del self.current[run.session_name]
            if not self._save(rec, durable=True):
                pass
            try:
                self.store.index_set(rec["handle"], None)
            except (OSError, R.StorageError) as e:
                rec.setdefault("storage", {"state": "unavailable", "reason": "the active index couldn't be updated: %s" % e})
        finally:
            run.done.set()

    # ---- the end of a run (§2.2's mapping)
    def _finish(self, run, q, gen, rid):
        out = R.Output(self.store.cfg["SAGEBRUSH_RUNS_OUTPUT_BYTES"])
        r = None
        while True:
            m = q.get()
            if isinstance(m, dict) and m.get("id") != rid:
                # (another request's message, which only a bug could put here:
                # never taken for this run's, and said on stderr)
                self._stale(run, m)
                continue
            if isinstance(m, dict) and "out" in m:
                # (output as it is printed, bounded here: head, rolling tail, counters)
                out.add(m["out"], m.get("stream", "stdout"))
                continue
            r = m
            break
        with self.lock:
            if run.done.is_set():
                return  # (already settled: the server's close)
            try:
                self._end(run, r, out)
            except Exception as e:  # (a bug or a disk error: the run still settles)
                rec = run.record
                rec.setdefault("storage", {"state": "unavailable", "reason": "the run's end couldn't be recorded: %s: %s" % (type(e).__name__, e)})
                if rec.get("state") == "running":
                    rec.update(state="finished", ended_by="error", ended_at=self.clock(),
                               error={"type": "session", "exception": None, "message": "the run's end couldn't be recorded", "traceback": ""})
            finally:
                self._settle(run)
        try:
            gone = self.store.cleanup()
        except Exception:
            gone = []
        self.forget(gone)

    def _stale(self, run, m):
        try:
            sys.stderr.write("sagebrush: run %s dropped a session message for request %r\n" % (run.record.get("handle"), m.get("id")))
        except Exception:
            pass

    def _end(self, run, r, out):
        rec = run.record
        now = self.clock()
        rec["ended_at"] = now
        rec["elapsed_s"] = round(now - rec["started_at"], 3)
        rec["last_seen_at"] = now
        if r is None:
            restart = [x for x in rec["requests"] if x.get("result") == "restarted"]
            if self.closing:
                # (the session ended because the server is exiting: whichever
                # thread sees it first, the same answer, astra PR120-SEM-5)
                rec["state"], rec["ended_by"] = "killed", "server_exit"
            elif restart:
                rec["state"], rec["ended_by"] = "killed", "restart"
                rec["restart_cause"] = restart[-1]["kind"]
                rec["restarted"] = True
                for h in rec.get("retained", []):
                    h["state"] = "invalid"
            else:
                rec["state"], rec["ended_by"] = "finished", "error"
                rec["error"] = {"type": "session", "exception": None,
                                "message": "the session process ended during the computation (out of memory, or killed)", "traceback": ""}
            rec["output"] = self._output(rec, out)
            return
        run.reply = r
        info = r.get("error_info")
        rec["state"] = "finished"
        rec["output"] = self._output(rec, out)
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

    def _output(self, rec, out):
        """The output's record: counters and tail always; its file when the
        store admits it, else `unavailable` with the reason (the run is
        unaffected, design §5)."""
        if not out.total["stdout"]:
            return out.info(None)
        try:
            self.store.write_file(rec["handle"], "output.txt", out.bytes(), durable=True, kind="data")
            return out.info(rec["handle"] + "/output.txt")
        except (OSError, R.StorageError) as e:
            info = out.info(None)
            info["unavailable"] = str(e)
            return info

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
            run.sess.interrupt(run.rid)
            rec["requests"].append(entry)
            self._save(rec)
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
            self._save(rec)
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
            self._save(rec, durable=rec["state"] != "running")

    def cancel(self, handle, mode="soft", request_id=None):
        """§3.3: the answer always carries the request's id (the caller's, or
        one made here, to retry with); a run that has ended, or is gone,
        answers not_running whatever the mode."""
        if mode not in ("soft", "hard"):
            raise Refused("invalid", "`mode` must be \"soft\" or \"hard\"")
        key = ("cancel", handle, mode)
        with self.lock:
            earlier = self._idempotent(request_id, key)
            if earlier is not None:
                return earlier
            rid = request_id if request_id is not None else "cancel_" + secrets.token_hex(12)
            run = self._owned(handle)
            rec = run.record if run is not None else (self.store.load(handle) if isinstance(handle, str) else None)
            if rec is None:
                raise Refused("not_found", "no run %r" % (handle,))
            if rec.get("state") != "running":
                ans = {"result": "not_running", "state": rec.get("state")}
            elif run is None:
                ans = {"result": "not_owned", "state": "running", "liveness": "unknown"}
            elif mode == "soft":
                # (a soft stop needs the library's request_stop, PR 5a: not in this build)
                ans = {"result": "soft_unavailable", "state": "running",
                       "reason": "a soft stop with a partial result isn't available in this build; ask for mode \"hard\""}
            else:
                got = self._request(run, "cancel_hard", rec["session"]["generation"], rec["run_seq"], {"request_id": rid, "kind": "cancel_hard"})
                ans = {"result": got.get("result"), "state": run.record["state"]}
            ans = {"request_id": rid, **ans}
            self.requests[rid] = (key, ans, self.clock())
            return ans

    # ---- reading: a removed run's tombstone wins over what is cached
    def forget(self, handles):
        """Runs cleanup removed: dropped from this server's cache."""
        with self.lock:
            for h in handles or ():
                run = self.runs.get(h)
                if run is not None and run.done.is_set():
                    del self.runs[h]

    def _owned(self, handle):
        """This server's run, unless it has ended and the store no longer has
        it (removed by cleanup, here or by another server; its tombstone
        perhaps pruned since): then None, and its cache entry dropped.  The
        store is the authority for an ended run, astra PR120-SEM-2.  The one
        exception is a run whose own terminal record couldn't be written
        (`storage`): its directory is still there, and the cache keeps what
        the store couldn't."""
        run = self.runs.get(handle)
        if run is None or not run.done.is_set():
            return run
        stored = self.store.load(handle)
        if stored is None or stored.get("state") == "gone":
            if stored is None and run.record.get("storage") and self.store.exists(handle):
                return run
            del self.runs[handle]
            return None
        return run

    def record(self, handle):
        with self.lock:
            run = self._owned(handle)
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
        with self.lock:
            run = self._owned(handle)
        if run is not None:
            run.done.wait(wait)
        with self.lock:
            run = self._owned(handle)
        return self.record(handle), (run.reply if run is not None and run.done.is_set() else None)

    def keep(self, handle, keep):
        if not isinstance(keep, bool):
            raise Refused("invalid", "`keep` must be true or false")
        with self.lock:
            run = self._owned(handle)
            rec = run.record if run is not None else (self.store.load(handle) if isinstance(handle, str) else None)
            if rec is None:
                raise Refused("not_found", "no run %r" % (handle,))
            if rec.get("state") == "gone":
                raise Refused("not_found", "run %s was removed (%s, its tombstone says)" % (handle, rec.get("reason")), tombstone=rec)
            if run is None and rec.get("state") == "running":
                raise Refused("not_owned", "run %s belongs to another server" % handle)
            rec["keep"] = keep
            try:
                self.store.save(rec)
            except FileNotFoundError:
                raise Refused("not_found", "run %s was removed" % handle)
            except (OSError, R.StorageError) as e:
                raise Refused("storage", "keep couldn't be recorded: %s" % e)
            return {"handle": handle, "keep": keep}

    def summary(self):
        # (a run that ended here but whose index entry couldn't be removed
        # isn't counted as running)
        with self.lock:
            settled = {h for h, r in self.runs.items() if r.done.is_set()}
        return self.store.summary(self.clock(), exclude=settled)

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

    def close(self):
        """The server is exiting: its sessions are closed (their processes
        ended and waited for), and a run still running in one is settled as
        killed (ended_by "server_exit"), so that it isn't left holding a slot
        as an unknown run."""
        with self.lock:
            # (the intent first, under the lock, before any worker is ended)
            self.closing = True
            sessions = list(self.sessions.items())
        for name, s in sessions:
            try:
                s.close()
            except Exception:
                pass
            # (the slot goes back only once the worker's exit is confirmed: a
            # session that couldn't be closed keeps it, astra PR120-SEM-7)
            try:
                gone = not s.alive()
            except Exception:
                gone = False
            if gone:
                self.store.slot_release(self._slot(name))
        with self.lock:
            for run in list(self.runs.values()):
                if not run.done.is_set() and run.record.get("state") == "running":
                    sess = run.sess
                    if sess is not None and sess.alive():
                        continue  # (not confirmed ended: left as it is, unknown to the next server)
                    now = self.clock()
                    run.record.update(state="killed", ended_by="server_exit", ended_at=now, elapsed_s=round(now - run.record["started_at"], 3))
                    self._settle(run)
