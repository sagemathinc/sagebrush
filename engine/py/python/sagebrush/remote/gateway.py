"""The remote runner's gateway lane: the compute gateway's RPCs, as frames on
one paired socket, run on one binding in the box's own CPython (design
remote-v1 §2 and §4).  A port of src/local-gateway.ts (local kernel phase 3a,
the frozen cases v3), whose page side (web/notebook/remote-client.js,
remote-kernel.js) is unchanged; the differences are the kernel (a native
child process, sagebrush.remote.child, instead of a pyjs Worker) and v1's
modes (python and sage; MATLAB and Magma are 400 mode-unsupported, §4 E4).

Frames (plan delta r3 D2/D3, r3.1):
  page -> here   {id: "t<n>", rpc, ref, auth, dpop, accept, body?}   a request; and {cancel: "t<n>"}
  here -> page   {id, status, headers, body}                         an answer
                 {id, chunk} ... then {id, end: true}                 a run's events (g.events), after a 200 head
                 {id, streamError: "slow"}                            a stream ended for want of room
                 {id, retired: true}                                  the last frame for a cancelled id

Bounds, all finite: 8 open ids per socket; one run (or wave) and one
completion admitted at a time, their payloads charged as logical bytes; 10,000
records per binding (tombstones counted); events per run 10,000 or 4 MiB,
64 MiB per binding; 4096 jtis per socket for 120 s; answers at most
RESPONSE_MAX; output through the socket's gate (conn.fits / conn.send_text).

The fence: after every await in a request's path, before any effect, the
request's conn must still be open and the binding generation it saw at decode
unchanged (a restart, a takeover, the 2 s fallback and the idle stop advance
it); otherwise it has no effect (409 stale if its conn is open; nothing sent
if not).

Admission (astra, #761 SEC): per connection, in frame order and one at a time.
A frame is decoded synchronously when it arrives (its payload slot reserved),
then its task authenticates it with the live nonce (rotated at that moment),
fences it and dispatches it with no await in between (auth_hold, the cases'
hold point, is a test hook and None in production), so no two requests'
check-and-effect interleave; an effect happens only after a successful
authentication and fence.  Tasks run in the order their frames arrived.

Interfaces (the socket side is a3's pair server; tests pass fakes):
  conn:   .closed, .token, .jkt, .send_text(text, kind) -> None, .fits(nbytes, kind) -> bool, .close(code, reason)
  server: .paired_conn, .timers (.now() ms, .set_timeout(fn, ms) -> handle, .clear_timeout(handle))
  port:   .start(on_message, on_exit) -> handle with .post(msg), .interrupt(up_to), .terminate(), .kill_descendants()
"""

import asyncio
import hashlib
import json
import os
import re
import secrets
import signal
import sys

from sagebrush.remote import dpop
from sagebrush.remote.wave_policy import (WaveState, wave_decide, wave_envelope_invalid, wave_record, wave_run_result,
                                          wave_stop)

MiB = 1024 * 1024
BODY_MAX = {"run": int(2.25 * MiB), "other": 64 * 1024}  # (web/notebook/remote-client.js BODY_MAX, by rpc)
RESPONSE_MAX = MiB
GATEWAY_LIMITS = {
    "openIds": 8,          # requests not yet answered plus subscriptions not ended, per socket
    "frameIdDigits": 15,
    "runs": 10_000,        # admission records per binding, tombstones included
    "recordBytes": 512,    # one record, encoded
    "summary": 256,        # a record's terminal summary, encoded
    "eventsPerRun": 10_000,
    "runEventBytes": 4 * MiB,
    "bindingEventBytes": 64 * MiB,
    "cellCode": MiB,       # one cell's code in a wave (the client's per-cell limit)
    "fallbackMs": 2_000,   # a Stop the kernel doesn't honour: then its process group is killed and it restarts
    "idleMs": 10 * 60_000, # the kernel with no paired page and no run going
}
MODES = ("python", "sage")  # (v1; MATLAB and Magma: 400 mode-unsupported, design §4 E4)
SYNTHETIC_BASE = "https://local.sagebrush.invalid/api/compute/v1"
_ID = re.compile(r"^[A-Za-z0-9._~-]{1,64}$")
_FRAME_KEYS = {"id", "rpc", "ref", "auth", "dpop", "accept", "body"}
TABLE = {
    "g.bind": ("POST", (), lambda r: "/bindings"),
    "g.run": ("POST", ("b",), lambda r: "/bindings/%s/runs" % r["b"]),
    "g.record": ("GET", ("b", "r"), lambda r: "/bindings/%s/runs/%s" % (r["b"], r["r"])),
    "g.events": ("GET", ("b", "r", "after"), lambda r: "/bindings/%s/runs/%s/events" % (r["b"], r["r"])),
    "g.interrupt": ("POST", ("b",), lambda r: "/bindings/%s/interrupt" % r["b"]),
    "g.restart": ("POST", ("b",), lambda r: "/bindings/%s/restart" % r["b"]),
    "g.takeover": ("POST", ("b",), lambda r: "/bindings/%s/takeover" % r["b"]),
    "g.complete": ("POST", ("b",), lambda r: "/bindings/%s/complete" % r["b"]),
}


def enc(v):
    """A value's encoded size: the UTF-8 bytes of its compact JSON."""
    return len(json.dumps(v, separators=(",", ":"), ensure_ascii=False).encode("utf-8", "surrogatepass"))


def frame_text(obj):
    return json.dumps(obj, separators=(",", ":"), ensure_ascii=False)


def _number_problem(v):
    """An integer JSON number in [0, 2^53 - 1]: four checks, each its own (cases v3 §1)."""
    if not isinstance(v, (int, float)) or isinstance(v, bool):
        return "type"
    if isinstance(v, float) and not v.is_integer():
        return "int"
    if v < 0:
        return "sign"
    if v > 2**53 - 1:
        return "range"
    return None


def summary(o):
    """An outcome's summary for its record: at most GATEWAY_LIMITS.summary bytes as the record holds it."""
    s = frame_text(o)
    if enc(s) <= GATEWAY_LIMITS["summary"]:
        return s
    short = {"status": o["status"]}
    for k in ("reason", "ename", "ms", "incarnation"):
        if o.get(k) is not None:
            short[k] = o[k][:64] if isinstance(o[k], str) else o[k]
    s = frame_text(short)
    return s if enc(s) <= GATEWAY_LIMITS["summary"] else frame_text({"status": str(o["status"])[:32]})


# ---- the kernel, behind a port (tests inject a scripted one that speaks the same messages)

class ChildPort:
    """The production port: sagebrush.remote.child processes, each in its own session and process group, so a
    stop that the code doesn't honour, a restart, a takeover's replacement, the idle stop and shutdown end
    everything it started (design §4 E3: the fence first, then SIGTERM to the group, SIGKILL after 2 s)."""

    def __init__(self, cwd=None, python=None):
        self.cwd = cwd
        self.python = python or sys.executable

    def start(self, on_message, on_exit):
        return _ChildHandle(self, on_message, on_exit)


class _ChildHandle:
    def __init__(self, port, on_message, on_exit):
        self.proc = None
        self.gone = False
        self.queue = []
        self.on_message, self.on_exit = on_message, on_exit
        self.task = asyncio.get_running_loop().create_task(self._run(port))

    async def _run(self, port):
        try:
            self.proc = await asyncio.create_subprocess_exec(
                port.python, "-m", "sagebrush.remote.child", cwd=port.cwd, stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL, start_new_session=True, limit=4 * MiB)
            for m in self.queue:
                self._write(m)
            self.queue = None
            while True:
                line = await self.proc.stdout.readline()
                if not line:
                    break
                try:
                    m = json.loads(line)
                except ValueError:
                    continue
                if not self.gone:
                    self.on_message(m)
            code = await self.proc.wait()
            self._exit("exit %s" % code)
        except Exception as e:  # (spawn failed, or the pipe broke)
            self._exit("error: %s" % str(e)[:200])

    def _exit(self, why):
        # (whatever way the kernel ended, by itself, a pipe error or a spawn failure: its process group is killed,
        # since a descendant outlives its leader in it (astra's R762-TREE-2); the group is the kernel's pid)
        if self.proc is not None:
            _kill_tree(self.proc.pid)
        if not self.gone:
            self.gone = True
            self.on_exit(why)

    def _write(self, m):
        try:
            self.proc.stdin.write((frame_text(m) + "\n").encode("utf-8", "surrogatepass"))
        except (BrokenPipeError, ConnectionResetError, RuntimeError):
            pass

    def post(self, m):
        if self.queue is not None:
            self.queue.append(m)
        else:
            self._write(m)

    def interrupt(self, up_to):
        """A Stop: SIGINT to the kernel's whole process group, as Ctrl-C in a terminal reaches the foreground job, so
        a subprocess the cell waits on is interrupted too (daybreak3's R762-STOP-1)."""
        if self.proc is not None and self.proc.returncode is None:
            try:
                os.killpg(self.proc.pid, signal.SIGINT)
            except (ProcessLookupError, PermissionError):
                pass

    def descendants(self):
        """The processes left in the kernel's process group besides the kernel itself."""
        if self.proc is None or self.proc.returncode is not None:
            return []
        return [p for p in _group_members(self.proc.pid) if p != self.proc.pid]

    def kill_descendants(self):
        """What a stopped run left in the group (a process that ignored the SIGINT): SIGTERM now, SIGKILL 2 s later to
        whatever of them is still in the group.  The kernel itself, and its variables, stay."""
        pids = self.descendants()
        for p in pids:
            try:
                os.kill(p, signal.SIGTERM)
            except (ProcessLookupError, PermissionError):
                pass
        if not pids:
            return 0
        pgid = self.proc.pid

        def kill():
            for p in _group_members(pgid):
                if p in pids:
                    try:
                        os.kill(p, signal.SIGKILL)
                    except (ProcessLookupError, PermissionError):
                        pass
        asyncio.get_running_loop().call_later(2.0, kill)
        return len(pids)

    def terminate(self):
        self.gone = True
        p = self.proc
        if p is None:
            self.task.cancel()
            return
        _kill_tree(p.pid)


def _group_members(pgid):
    """The pids in process group pgid (Linux: /proc; elsewhere: ps)."""
    out = []
    if os.path.isdir("/proc/self"):
        for d in os.listdir("/proc"):
            if not d.isdigit():
                continue
            try:
                with open("/proc/%s/stat" % d, "rb") as f:
                    st = f.read()
            except OSError:
                continue
            fields = st[st.rfind(b")") + 2:].split()
            # (state, ppid, pgrp, ...: a zombie is already gone)
            if len(fields) > 2 and fields[0] != b"Z" and int(fields[2]) == pgid:
                out.append(int(d))
        return out
    import subprocess
    try:
        r = subprocess.run(["ps", "-A", "-o", "pid=,pgid=,stat="], capture_output=True, text=True, timeout=5)
    except (OSError, subprocess.SubprocessError):
        return out
    for line in r.stdout.splitlines():
        parts = line.split()
        if len(parts) >= 3 and parts[1] == str(pgid) and not parts[2].startswith("Z"):
            out.append(int(parts[0]))
    return out


ENDING_GROUPS = set()  # (kernel process groups sent SIGTERM whose SIGKILL is still due: drain_groups waits for them)


def _kill_tree(pgid):
    """The tree rule: SIGTERM to the child's process group, SIGKILL to it 2 s later (whatever is left)."""
    try:
        os.killpg(pgid, signal.SIGTERM)
    except (ProcessLookupError, PermissionError):
        return
    ENDING_GROUPS.add(pgid)
    loop = asyncio.get_running_loop()

    def kill():
        ENDING_GROUPS.discard(pgid)
        try:
            os.killpg(pgid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass
    loop.call_later(2.0, kill)


async def drain_groups(timeout=3.0):
    """At the runner's exit: wait until every kernel process group it ended is empty, at most `timeout` seconds,
    then SIGKILL what is left, so no descendant outlives `sagebrush remote` (design §7 R8; astra's a3 note).
    Returns the pgids that still had members at the deadline."""
    loop = asyncio.get_running_loop()
    end = loop.time() + timeout
    while True:
        alive = [g for g in list(ENDING_GROUPS) if _group_members(g)]
        for g in list(ENDING_GROUPS):
            if g not in alive:
                ENDING_GROUPS.discard(g)
        if not alive:
            return []
        if loop.time() >= end:
            for g in alive:
                try:
                    os.killpg(g, signal.SIGKILL)
                except (ProcessLookupError, PermissionError):
                    pass
                ENDING_GROUPS.discard(g)
            return alive
        await asyncio.sleep(0.05)


# ---- records, runs and the binding

class Run:
    def __init__(self, request, digest, wave, payload, charge):
        self.request, self.digest = request, digest
        self.wave, self.payload = wave, payload
        self.events, self.event_bytes = [], 0
        self.first_seq, self.next_seq = 1, 1
        self.outcome = None
        self.tomb = False
        self.listeners = []
        self.charge = charge
        self.owner = "wave" if wave is not None else "gateway"
        self.worker_id = 0
        self.ends = [None] * len(wave["entries"]) if wave is not None else None
        self.current = -1
        self.stop_latched = False
        self.stop_requested = False  # (a Stop reached it: at its end, what it left in the kernel's group is ended)
        self.worker_gen = 0  # (the kernel generation it was admitted under: no handoff to any other, astra's R762-FENCE-1)
        self.stop = None
        self.record_bytes = 0


class Binding:
    def __init__(self, id, conn):
        self.id, self.conn = id, conn
        self.epoch = 1
        self.incarnation = 1
        self.gen = 1
        self.runs = {}
        self.order = []
        self.busy = None
        self.event_bytes = 0
        self.applied = []
        self.applied_truncated = False


class Req:
    def __init__(self, id, n, rpc, ref, conn, auth, proof, accept, gen, binding):
        self.id, self.n, self.rpc, self.ref, self.conn = id, n, rpc, ref, conn
        self.auth, self.dpop, self.accept = auth, proof, accept
        self.body = None
        self.bytes = 0
        self.digest = None
        self.slot = None
        self.busy = False
        self.gen, self.binding = gen, binding
        self.cancelled = False
        self.answered = False
        self.sub = None


class _Sock:
    def __init__(self):
        self.last = 0
        self.open = {}
        self.jtis = {}


class Gateway:
    def __init__(self, server, port=None, cwd=None, auth_hold=None):
        self.server = server
        self.port = port or ChildPort(cwd)
        self.auth_hold = auth_hold
        self.binding = None
        self.worker = None
        self.worker_gen = 0
        self.next_binding = 1
        self.next_worker_id = 1
        self.run_slot = None
        self.complete_slot = None
        self.complete_waiter = None
        self.worker_runs = {}
        self.fallback_timer = None
        self.idle_timer = None
        self.nonce = dpop.b64url(secrets.token_bytes(16))
        self.nonce_at = server.timers.now()
        self.sockets = {}
        self.stats = {"queuedPayloadBytes": 0, "maxQueuedPayloadBytes": 0, "recordBytes": 0, "staleOutputs": 0,
                      "invariantFailures": 0, "workersStarted": 0, "fallbacks": 0, "executions": 0, "descendantsKilled": 0,
                      "fenced": {"closed": 0, "stale": 0}, "authRefusals": {}}

    # ---- the frame side (called by the pair server for a paired conn)

    def _state(self, c):
        s = self.sockets.get(id(c))
        if s is None:
            s = self.sockets[id(c)] = _Sock()
        return s

    def cancel(self, c, rid):
        """A notification {cancel: id}: the retirement handshake's start (r3.1 R3-1)."""
        s = self._state(c)
        n = int(rid[1:]) if isinstance(rid, str) and re.match(r"^t[1-9]\d{0,14}$", rid) else None
        if n is None or n > s.last:
            return c.close(1002, "a cancel for an id never sent")
        req = s.open.get(rid)
        if req is None:
            return self._send_control(c, {"id": rid, "retired": True})
        req.cancelled = True
        if req.sub is not None:
            run, listener = req.sub
            if listener in run.listeners:
                run.listeners.remove(listener)
            req.sub = None
            s.open.pop(req.id, None)
            return self._send_control(c, {"id": rid, "retired": True})

    def frame(self, c, msg):
        """A request frame: checked and decoded synchronously (its payload slot reserved), then authenticated."""
        s = self._state(c)
        rid = msg.get("id")
        if not isinstance(rid, str) or not re.match(r"^t\d+$", rid):
            return c.close(1002, "a frame id is t and digits")
        if rid.startswith("t0"):
            return c.close(1002, "a frame id has no leading zero")
        if len(rid) - 1 > GATEWAY_LIMITS["frameIdDigits"]:
            return c.close(1002, "a frame id is at most 15 digits")
        n = int(rid[1:])
        if rid in s.open or n == s.last:
            return c.close(1002, "a frame id reused")
        if n < s.last:
            return c.close(1002, "a frame id not above the last")
        s.last = n
        if any(k not in _FRAME_KEYS for k in msg):
            return c.close(1002, "an unknown frame member")
        rpc = msg.get("rpc")
        if not isinstance(rpc, str) or rpc not in TABLE:
            return c.close(1002, "an unknown rpc")
        method, members, _ = TABLE[rpc]
        ref = msg.get("ref")
        if not isinstance(ref, dict):
            return c.close(1002, "a ref is an object")
        if any(k not in members for k in ref):
            return c.close(1002, "a ref member the rpc doesn't take")
        for k in members:
            if k not in ref:
                return c.close(1002, "a ref member missing")
            if k == "after":
                p = _number_problem(ref["after"])
                if p:
                    return c.close(1002, "after: %s" % p)
                ref["after"] = int(ref["after"])
            elif not isinstance(ref[k], str) or not _ID.match(ref[k]):
                return c.close(1002, "a ref member not an id")
        if not all(isinstance(msg.get(k), str) for k in ("auth", "dpop", "accept")):
            return c.close(1002, "a request's headers")
        has_body = method == "POST"
        if (not isinstance(msg.get("body"), str)) if has_body else ("body" in msg):
            return c.close(1002, "a request's body")
        if len(s.open) >= GATEWAY_LIMITS["openIds"]:
            return c.close(1002, "too many open requests")
        b = self.binding
        req = Req(rid, n, rpc, ref, c, msg["auth"], msg["dpop"], msg["accept"], b.gen if b else 0, b.id if b else None)
        if has_body:
            # (the synchronous step: the length, the parse, the digest; then the raw text dropped)
            raw = msg.pop("body")
            req.bytes = len(raw.encode("utf-8", "surrogatepass"))
            if req.bytes > (BODY_MAX["run"] if rpc == "g.run" else BODY_MAX["other"]):
                return c.close(1002, "a body over its limit")
            try:
                req.body = json.loads(raw)
            except (ValueError, RecursionError):  # (a nesting deeper than the parser's stack: malformed, not a crash)
                req.body = None
            del raw
            if rpc == "g.run" and isinstance(req.body, dict):
                req.digest = hashlib.sha256(frame_text(req.body.get("payload")).encode("utf-8", "surrogatepass")).hexdigest()
            self._reserve(req)
        s.open[rid] = req
        asyncio.get_running_loop().create_task(self._handle(req))

    def _reserve(self, req):
        """The payload slots, reserved synchronously (cases v3 §3): a request whose slot is taken is busy, uncharged."""
        b = self.binding
        if req.rpc == "g.run":
            request = req.body.get("request") if isinstance(req.body, dict) else None
            if b is not None and isinstance(request, str) and request in b.runs:
                return  # (answered from its record: no charge)
            if self.run_slot is not None:
                req.busy, req.body = True, None
                return
            self.run_slot, req.slot = req, "run"
            self._charge(req.bytes)
        elif req.rpc == "g.complete":
            if self.complete_slot is not None:
                req.busy, req.body = True, None
                return
            self.complete_slot, req.slot = req, "complete"
            self._charge(req.bytes)

    def _charge(self, n):
        self.stats["queuedPayloadBytes"] += n
        self.stats["maxQueuedPayloadBytes"] = max(self.stats["maxQueuedPayloadBytes"], self.stats["queuedPayloadBytes"])

    def _unreserve(self, req):
        if req.slot == "run" and self.run_slot is req:
            self.run_slot = None
            self.stats["queuedPayloadBytes"] -= req.bytes
        elif req.slot == "complete" and self.complete_slot is req:
            self.complete_slot = None
            self.stats["queuedPayloadBytes"] -= req.bytes
        req.slot = None
        req.body = None

    def _fence(self, req):
        """May this request still have an effect?  "closed": no, and nothing is sent."""
        c = req.conn
        if not c.closed and not self._fence_invariant(c):
            self.stats["invariantFailures"] += 1
            return "closed"
        if c.closed:
            self.stats["fenced"]["closed"] += 1
            return "closed"
        b = self.binding
        if (b.gen if b else 0) != req.gen or (b.id if b else None) != req.binding:
            self.stats["fenced"]["stale"] += 1
            return "stale"
        return "ok"

    def _fence_invariant(self, c):
        return self.server.paired_conn is c and (self.binding is None or self.binding.conn is c)

    async def _handle(self, req):
        try:
            if self.auth_hold is not None:
                await self.auth_hold(req.id, req.conn)
            refusal = self._verify(req)
        except Exception:
            refusal = (401, "invalid_dpop_proof", None)
        f = self._fence(req)
        if f == "closed":
            self._unreserve(req)
            self._forget(req)
            return
        if refusal:
            self._unreserve(req)
            return self._answer(req, refusal[0], {"error": refusal[1]}, refusal[2] or {})
        if f == "stale":
            self._unreserve(req)
            return self._answer(req, 409, {"error": "stale"})
        if req.busy:
            return self._answer(req, 409, {"error": "busy"})
        try:
            self._dispatch(req)
        except Exception as e:  # (any validation or route failure: no effect kept, the slot and the id released)
            self.stats["internalErrors"] = self.stats.get("internalErrors", 0) + 1
            if self.run_slot is req or self.complete_slot is req:
                self._unreserve(req)
            if not req.answered:
                self._answer(req, 500, {"error": "internal", "detail": type(e).__name__})

    def _forget(self, req):
        s = self.sockets.get(id(req.conn))
        if s:
            s.open.pop(req.id, None)

    def _verify(self, req):
        c = req.conn
        method, _, path = TABLE[req.rpc]
        self._rotate_nonce()
        s = self._state(c)
        got = dpop.check(req.auth, req.dpop, token=c.token, jkt=c.jkt, method=method, htu=SYNTHETIC_BASE + path(req.ref),
                         now_ms=self.server.timers.now(), jtis=s.jtis, nonce=self.nonce)
        if got is None:
            return None
        status, error, reason, headers = got
        self.stats["authRefusals"][reason] = self.stats["authRefusals"].get(reason, 0) + 1
        return (status, error, headers)

    def current_nonce(self):
        """The DPoP nonce a page is given at pairing (the one its first proof must carry)."""
        self._rotate_nonce()
        return self.nonce

    def _rotate_nonce(self):
        t = self.server.timers.now()
        if t - self.nonce_at >= dpop.LIMITS["nonceMs"]:
            self.nonce = dpop.b64url(secrets.token_bytes(16))
            self.nonce_at = t

    # ---- answers and output

    def _answer(self, req, status, data, headers=None):
        c = req.conn
        s = self.sockets.get(id(c))
        if s:
            s.open.pop(req.id, None)
        req.answered = True
        if c.closed:
            return
        self._rotate_nonce()
        body = frame_text(data)
        if len(body.encode("utf-8", "surrogatepass")) > RESPONSE_MAX:
            status, body = 502, frame_text({"error": "answer-too-large"})
        h = {"content-type": "application/json", "dpop-nonce": self.nonce, "content-length": str(len(body.encode("utf-8", "surrogatepass")))}
        h.update(headers or {})
        c.send_text(frame_text({"id": req.id, "status": status, "headers": h, "body": body}), "data")
        if req.cancelled and not c.closed:
            self._send_control(c, {"id": req.id, "retired": True})

    def _send_control(self, c, obj):
        if not c.closed:
            c.send_text(frame_text(obj), "control")

    # ---- the routes, after authentication and the fence

    def _dispatch(self, req):
        b = self.binding
        body = req.body
        if req.rpc == "g.bind":
            if b is not None:
                return self._answer(req, 409, {"error": "in-use"})
            return self._bind(req)
        if b is None or req.ref["b"] != b.id:
            self._unreserve(req)
            return self._answer(req, 410 if b else 404, {"error": "binding-gone" if b else "not-found"})
        if req.rpc in ("g.record", "g.events"):
            run = b.runs.get(req.ref["r"])
            if run is None:
                return self._answer(req, 404, {"error": "not-found"})
            if req.rpc == "g.record":
                return self._answer(req, 200, self._record_view(run))
            return self._subscribe(req, run, req.ref["after"])
        if not isinstance(body, dict):
            self._unreserve(req)
            return self._answer(req, 400, {"error": "malformed"})
        if req.rpc == "g.takeover":
            return self._takeover(req, b, body)
        if body.get("epoch") != b.epoch or isinstance(body.get("epoch"), bool):
            self._unreserve(req)
            return self._answer(req, 409, {"error": "epoch"})
        if req.rpc == "g.run":
            return self._post_run(req, b, body)
        if req.rpc == "g.interrupt":
            return self._interrupt(req, b)
        if req.rpc == "g.restart":
            return self._restart(req, b, body)
        return self._complete(req, body)

    def _bind(self, req):
        bid = "b%d" % self.next_binding
        self.next_binding += 1
        self.binding = Binding(bid, req.conn)
        self.stats["recordBytes"] = 0
        self._ensure_worker()
        self._answer(req, 200, {"binding": bid, "epoch": 1, "incarnation": 1, "state": "ready"})

    def _record_view(self, run):
        v = {"request": run.request, "state": "done" if run.outcome else "running"}
        if run.outcome:
            v["outcome"] = run.outcome
        if run.wave is not None:
            v["entries"] = run.ends
            v["stop"] = run.stop
        return v

    def _post_run(self, req, b, body):
        request = body.get("request")
        if not isinstance(request, str) or not _ID.match(request):
            self._unreserve(req)
            return self._answer(req, 400, {"error": "malformed"})
        had = b.runs.get(request)
        if had is not None:
            self._unreserve(req)
            if had.digest != req.digest:
                return self._answer(req, 409, {"error": "conflict"})
            return self._answer(req, 202, {"request": request, "state": "done" if had.outcome else "running"})
        if len(b.runs) >= GATEWAY_LIMITS["runs"]:
            self._unreserve(req)
            return self._answer(req, 429, {"error": "limit", "reason": "runs"})
        is_wave = body.get("kind") == "wave"
        p = body.get("payload")
        if is_wave:
            bad = wave_envelope_invalid(p) or self._cell_code_too_large(p)
            if bad:
                self._unreserve(req)
                return self._answer(req, 400, {"error": "malformed", "detail": bad})
            modes = {p["mode"]} | {e["mode"] for e in p["entries"] if "place" not in e}
        elif not isinstance(p, dict) or not isinstance(p.get("code"), str):
            self._unreserve(req)
            return self._answer(req, 400, {"error": "malformed"})
        else:
            modes = {p.get("mode", "python") if isinstance(p.get("mode", "python"), str) else None}
        if not modes <= set(MODES):
            self._unreserve(req)
            return self._answer(req, 400, {"error": "mode-unsupported", "modes": list(MODES)})
        self._ensure_worker()  # (a kernel that exited is replaced lazily, at the next run, with a new incarnation)
        run = Run(request, req.digest, p if is_wave else None, None if is_wave else p, req.bytes)
        run.worker_gen = self.worker_gen
        # (the request's reservation becomes the run's: the same slot, the same charge)
        self.run_slot = run
        req.slot, req.body = None, None
        run.record_bytes = self._record_size(run)
        self.stats["recordBytes"] += run.record_bytes
        b.runs[request] = run
        b.order.append(run)
        b.busy = run
        self._answer(req, 202, {"request": request, "state": "admitted"})
        loop = asyncio.get_running_loop()
        loop.create_task(self._run_wave(b, run) if is_wave else self._run_single(b, run))

    def _cell_code_too_large(self, w):
        for e in w["entries"]:
            if isinstance(e.get("code"), str) and len(e["code"].encode("utf-8", "surrogatepass")) > GATEWAY_LIMITS["cellCode"]:
                return "an entry's code over its size limit"
        return None

    def _record_size(self, run):
        r = {"request": run.request, "digest": run.digest, "terminal": summary(run.outcome) if run.outcome else None}
        if run.tomb:
            r["tomb"] = True
        return enc(r)

    # ---- the kernel

    def _ensure_worker(self):
        if self.worker is not None:
            return
        self.worker_gen += 1
        gen = self.worker_gen
        self.stats["workersStarted"] += 1
        self.worker = self.port.start(lambda m: self._from_worker(gen, m), lambda why: self._worker_gone(gen, why))

    def _from_worker(self, gen, m):
        if gen != self.worker_gen:
            self.stats["staleOutputs"] += 1
            return
        if not isinstance(m, dict) or not isinstance(m.get("id"), int) or isinstance(m.get("id"), bool):
            return
        w = self.complete_waiter
        if w is not None and m["id"] == w[0] and ("matches" in m or m.get("done")):
            self.complete_waiter = None
            return w[1](m)
        h = self.worker_runs.get(m["id"])
        if h is not None:
            h[0](m)

    def _worker_gone(self, gen, why):
        """The kernel exited by itself (or its pipe broke): the fence first (a new kernel generation, and a new
        binding generation and incarnation, since its namespace is gone: the page sees it, §7 R4), then its runs
        ended; its process group was killed by the handle (_ChildHandle._exit).  A new kernel starts at the next run."""
        if gen != self.worker_gen:
            return
        self.worker = None
        self.worker_gen += 1
        b = self.binding
        if b is not None:
            b.gen += 1
            b.incarnation += 1
        self._end_all_runs({"status": "stopped", "reason": "kernel exited", "detail": why[:120]})
        if b is not None:
            for r in list(b.runs.values()):
                self._tombstone(b, r)

    def _drop_execution(self, wid):
        """An execution the kernel will never finish (it was replaced, it exited, or its run ended): its waiter is
        resolved with None, so _run_single/_run_wave return and keep nothing (daybreak3's R762-TASK-2)."""
        e = self.worker_runs.pop(wid, None)
        if e is not None and not e[1].done():
            e[1].set_result(None)

    def _end_all_runs(self, outcome):
        b = self.binding
        for wid in list(self.worker_runs):
            self._drop_execution(wid)
        if self.complete_waiter is not None:
            w, self.complete_waiter = self.complete_waiter, None
            w[1](None)
        if b is not None and b.busy is not None:
            self._terminal(b, b.busy, outcome)
        if self.fallback_timer is not None:
            self.server.timers.clear_timeout(self.fallback_timer)
            self.fallback_timer = None

    def _execute(self, run, code, p, on_event):
        """One run's code to the kernel; its messages become the run's events; resolves to its outcome."""
        loop = asyncio.get_running_loop()
        fut = loop.create_future()
        w = self.worker
        if run.outcome or w is None or self.worker_gen != run.worker_gen:
            # (the fence for every handoff, a wave's initial and final forget included: a run that ended, or whose
            # kernel was replaced since its admission, sends nothing to any kernel)
            fut.set_result(None)
            return fut
        wid = self.next_worker_id
        self.next_worker_id += 1
        run.worker_id = wid
        mode = p.get("mode") if isinstance(p.get("mode"), str) else "python"
        msg = {"id": wid, "code": code, "mode": mode}
        if isinstance(p.get("forget"), list) and p["forget"]:
            msg["forget"] = list(p["forget"])
        if isinstance(p.get("mangle"), str):
            msg["mangle"] = p["mangle"]
        if isinstance(p.get("seed"), str):
            msg["seed"] = p["seed"]

        def handler(m):
            if fut.done():
                return
            if m.get("start"):
                return on_event({"type": "start"})
            if isinstance(m.get("stream"), str):
                return on_event({"type": "stream", "name": "stderr" if m["stream"] == "stderr" else "stdout", "text": str(m.get("out", ""))})
            if "display" in m:
                return on_event({"type": "display", "data": m["display"]})
            if m.get("done"):
                self.worker_runs.pop(wid, None)  # (resolved just below: not dropped)
                ms = m.get("ms") if isinstance(m.get("ms"), (int, float)) and not isinstance(m.get("ms"), bool) else 0
                o = {"status": "error", "ms": ms} if m.get("error") else {"status": "ok", "ms": ms}
                if m.get("error") and m.get("ename"):
                    o["ename"] = str(m["ename"])[:64]
                fut.set_result(o)

        self.worker_runs[wid] = (handler, fut)
        self.stats["executions"] += 1
        w.post(msg)
        return fut

    def _admission_stale(self, run):
        """A scheduled run task's first check, before any effect (a payload read, an event, a handoff): a restart (or
        any end) in the same turn as its admission already ended or fenced it (astra's R762-FENCE-1, r3 follow-up)."""
        return run.outcome is not None or run.worker_gen != self.worker_gen or self.worker is None

    async def _run_single(self, b, run):
        if self._admission_stale(run):
            run.payload = None
            return
        p, run.payload = run.payload, None  # (handed to the kernel: the gateway keeps no reference)
        run.owner = "worker"
        self._emit(b, run, {"type": "start"})
        outcome = await self._execute(run, p["code"], p, lambda ev: ev["type"] != "start" and self._emit(b, run, ev))
        if outcome and not run.outcome:
            self._terminal(b, run, outcome)

    async def _run_wave(self, b, run):
        if self._admission_stale(run):
            return
        w = run.wave
        if w["forget"]:
            await self._execute(run, "", {"mode": w["mode"], "forget": w["forget"]}, lambda ev: None)
        st = WaveState()
        cancelled = []
        for k, e in enumerate(w["entries"]):
            if run.outcome:
                return
            if run.stop_latched and not st.stopped:
                wave_stop(st)
                run.stop = k
                self._emit(b, run, {"type": "stop", "before": k})
            d = wave_decide(w["policy"], st, k, e)
            if d["kind"] != "run":
                wave_record(st, k, e, d)
                if d["kind"] == "cancelled":
                    cancelled.extend(e.get("defs") or [])
                self._entry_end(b, run, k, d)
                continue
            code = e.pop("code")  # (the destructive handoff: the gateway keeps no dispatched code)
            self._emit(b, run, {"type": "start", "entry": k})
            run.current = k

            def on_event(ev, k=k):
                if ev["type"] != "start" and not run.ends[k]:
                    self._emit(b, run, dict(ev, entry=k))
            outcome = await self._execute(run, code, e, on_event)
            run.current = -1
            if not outcome or run.outcome:
                return
            wave_record(st, k, e, d, wave_run_result(outcome))
            self._entry_end(b, run, k, d, outcome)
        if run.outcome:
            return
        if cancelled:
            await self._execute(run, "", {"mode": w["mode"], "forget": cancelled}, lambda ev: None)
        self._terminal(b, run, {"status": "done"})

    def _entry_end(self, b, run, k, decision, outcome=None):
        if run.ends[k]:
            return
        run.ends[k] = {"decision": decision, **({"outcome": outcome} if outcome else {})}
        self._emit(b, run, {"type": "end", "entry": k, "decision": decision, **({"outcome": outcome} if outcome else {})})

    def _terminal(self, b, run, outcome):
        """A run's terminal: once; its charge released; the binding free for the next run."""
        if run.outcome:
            return
        run.outcome = outcome
        self._emit(b, run, {"type": "terminal", "outcome": outcome})
        if b.busy is run:
            b.busy = None
        if self.run_slot is run:
            self.run_slot = None
            self.stats["queuedPayloadBytes"] -= run.charge
        run.charge = 0
        run.owner = None
        run.payload = None
        if run.wave is not None:
            for e in run.wave["entries"]:
                e.pop("code", None)
        self._drop_execution(run.worker_id)
        if run.stop_requested and self.worker is not None:  # (None: the kernel was replaced or is gone: its group was killed)
            # (a stopped run that ended in a live kernel: whatever it left in the group, a process that ignored the
            # SIGINT, is ended now, before any next run can start, so it can't take a later run's children)
            self.stats["descendantsKilled"] += self.worker.kill_descendants()
        if self.fallback_timer is not None:
            self.server.timers.clear_timeout(self.fallback_timer)
            self.fallback_timer = None
        before = run.record_bytes
        run.record_bytes = self._record_size(run)
        self.stats["recordBytes"] += run.record_bytes - before
        self._arm_idle()

    # ---- events: retained per run and per binding, streamed to subscriptions

    def _emit(self, b, run, ev):
        e = {"seq": run.next_seq, **ev}
        run.next_seq += 1
        n = enc(e)
        run.events.append(e)
        run.event_bytes += n
        b.event_bytes += n
        while len(run.events) > GATEWAY_LIMITS["eventsPerRun"] or run.event_bytes > GATEWAY_LIMITS["runEventBytes"]:
            self._drop_oldest(b, run)
        for r in b.order:
            if b.event_bytes <= GATEWAY_LIMITS["bindingEventBytes"]:
                break
            if not r.outcome or r is run:
                continue
            while r.events and b.event_bytes > GATEWAY_LIMITS["bindingEventBytes"]:
                self._drop_oldest(b, r)
        for f in list(run.listeners):
            f(e)

    def _drop_oldest(self, b, run):
        e = run.events.pop(0)
        n = enc(e)
        run.event_bytes -= n
        b.event_bytes -= n
        run.first_seq = e["seq"] + 1

    def _subscribe(self, req, run, after):
        c = req.conn
        if after + 1 < run.first_seq and not (after == 0 and run.first_seq == 1):
            return self._answer(req, 410, {"error": "expired-cursor"})
        s = self._state(c)
        s.open[req.id] = req
        c.send_text(frame_text({"id": req.id, "status": 200, "headers": {"content-type": "text/event-stream", "dpop-nonce": self.nonce}}), "data")
        if c.closed:
            return

        def done():
            if listener in run.listeners:
                run.listeners.remove(listener)
            req.sub = None
            s.open.pop(req.id, None)

        def listener(e):
            if c.closed:
                return done()
            if e["seq"] <= after:
                return
            chunk = frame_text({"id": req.id, "chunk": "id: %d\ndata: %s\n\n" % (e["seq"], frame_text(e))})
            if not c.fits(len(chunk.encode("utf-8", "surrogatepass")), "data"):
                done()
                return self._send_control(c, {"id": req.id, "streamError": "slow"})
            c.send_text(chunk, "data")
            if e["type"] == "terminal":
                done()
                self._send_control(c, {"id": req.id, "end": True})

        req.sub = (run, listener)
        for e in list(run.events):
            listener(e)
            if req.sub is None:
                return
        run.listeners.append(listener)

    # ---- interrupt, restart, takeover, complete

    def _interrupt(self, req, b):
        run = b.busy
        if run is not None and run.wave is not None:
            if run.current >= 0:
                self._stop_worker(b, run)
            elif not run.outcome:
                run.stop_latched = True
        elif run is not None and run.owner == "worker" and not run.outcome:
            self._stop_worker(b, run)
        self._answer(req, 200, {"ok": True})

    def _stop_worker(self, b, run):
        """A Stop: SIGINT to the kernel's process group; if the run hasn't ended in fallbackMs, the whole group is killed
        and the kernel restarts; if it has, what it left in the group is ended (_terminal)."""
        run.stop_requested = True
        if self.worker is not None:
            self.worker.interrupt(run.worker_id)
        if self.fallback_timer is not None:
            return

        def fallback():
            self.fallback_timer = None
            if run.outcome:
                return
            self.stats["fallbacks"] += 1
            self._replace_worker(b, {"status": "stopped", "reason": "fallback"})
        self.fallback_timer = self.server.timers.set_timeout(fallback, GATEWAY_LIMITS["fallbackMs"])

    def _replace_worker(self, b, outcome):
        """The fence first (a new generation: late output dropped), then the kernel's tree killed, then a new kernel."""
        w = self.worker
        self.worker = None
        self.worker_gen += 1
        b.gen += 1
        b.incarnation += 1
        if w is not None:
            w.terminate()
        self._end_all_runs(outcome)
        for r in list(b.runs.values()):
            self._tombstone(b, r)
        self._ensure_worker()

    def _tombstone(self, b, r):
        if not r.outcome or r.tomb:
            return
        r.tomb = True
        b.event_bytes -= r.event_bytes
        r.events = []
        r.event_bytes = 0
        r.first_seq = r.next_seq
        before = r.record_bytes
        r.record_bytes = self._record_size(r)
        self.stats["recordBytes"] += r.record_bytes - before

    def _restart(self, req, b, body):
        self._replace_worker(b, {"status": "stopped", "reason": "kernel restarted"})
        if isinstance(body.get("op_id"), str):
            b.applied.append({"op_id": body["op_id"][:64], "kind": "restart", "epoch": b.epoch})
            if len(b.applied) > 64:
                b.applied.pop(0)
                b.applied_truncated = True
        self._answer(req, 200, {"outcome": {"status": "done", "incarnation": b.incarnation}})

    def _takeover(self, req, b, body):
        fe = body.get("from_epoch")
        frm = fe if isinstance(fe, int) and not isinstance(fe, bool) and abs(fe) <= 2**53 - 1 else None
        fence = body.get("fence") if isinstance(body.get("fence"), str) and body.get("fence") else None
        b.epoch += 1
        b.gen += 1
        if frm is not None:
            evidence = [a for a in b.applied if a["epoch"] >= frm]
        else:
            evidence, b.applied = b.applied, []
        ans = {"epoch": b.epoch, "state": "ready", "incarnation": b.incarnation,
               "applied_before_takeover": [{"op_id": a["op_id"], "kind": a["kind"]} for a in evidence], "in_flight": []}
        if frm is not None and fence:
            ans["continuity"] = {"from_epoch": frm, "sole": not (b.applied_truncated and frm < b.epoch - 1)}
        self._answer(req, 200, ans)

    def _complete(self, req, body):
        self._ensure_worker()
        w = self.worker
        code = body.get("code") if isinstance(body.get("code"), str) else ""
        if w is None:
            self._unreserve(req)
            return self._answer(req, 503, {"error": "unavailable"})
        mode = body.get("mode") if isinstance(body.get("mode"), str) else "python"
        wid = self.next_worker_id
        self.next_worker_id += 1
        gen = self.worker_gen

        def done(m):
            self._unreserve(req)
            if self._fence(req) != "ok" or gen != self.worker_gen:
                return self._answer(req, 409, {"error": "stale"})
            if not m or "matches" not in m:
                return self._answer(req, 200, {"matches": [], "prefix": ""})
            self._answer(req, 200, {"matches": m["matches"] if isinstance(m.get("matches"), list) else [],
                                    "prefix": m["prefix"] if isinstance(m.get("prefix"), str) else ""})
        self.complete_waiter = (wid, done)
        w.post({"id": wid, "complete": code, "mode": mode})

    # ---- lifecycle

    def socket_lost(self, c):
        """The paired socket gone: its binding stays with the kernel (the idle rule, below)."""
        s = self.sockets.pop(id(c), None)
        if s is not None:
            for req in s.open.values():
                if req.sub is not None:
                    run, listener = req.sub
                    if listener in run.listeners:
                        run.listeners.remove(listener)
                self._unreserve(req)
            s.open.clear()
        if self.binding is None or self.binding.conn is not c:
            return
        self._arm_idle()

    def _arm_idle(self):
        """After idleMs with no paired page and no run going, the kernel is stopped (its records stay)."""
        if self.server.paired_conn is not None or self.binding is None:
            return
        if self.idle_timer is not None:
            self.server.timers.clear_timeout(self.idle_timer)

        def idle():
            self.idle_timer = None
            b = self.binding
            if self.server.paired_conn is not None or b is None:
                return
            if b.busy is not None:
                return  # (a run going: never stopped for want of a page; re-armed at its terminal)
            w = self.worker
            self.worker = None
            self.worker_gen += 1
            b.gen += 1
            b.incarnation += 1
            if w is not None:
                w.terminate()
            for r in list(b.runs.values()):
                self._tombstone(b, r)
        self.idle_timer = self.server.timers.set_timeout(idle, GATEWAY_LIMITS["idleMs"])

    def socket_paired(self, c):
        """A page paired again: the binding moves to its socket; a kernel the idle rule stopped starts again."""
        if self.idle_timer is not None:
            self.server.timers.clear_timeout(self.idle_timer)
            self.idle_timer = None
        if self.binding is not None:
            self.binding.conn = c
            self._ensure_worker()

    def shutdown(self):
        """Ctrl-C or SIGTERM on `sagebrush remote` (R8), or unpairing: the kernel's tree killed, the binding fenced."""
        if self.idle_timer is not None:
            self.server.timers.clear_timeout(self.idle_timer)
            self.idle_timer = None
        b = self.binding
        w = self.worker
        self.worker = None
        self.worker_gen += 1
        if b is not None:
            b.gen += 1
        if w is not None:
            w.terminate()
        self._end_all_runs({"status": "stopped", "reason": "unpaired"})
        if self.complete_slot is not None:
            self._unreserve(self.complete_slot)
        if isinstance(self.run_slot, Run):
            self.stats["queuedPayloadBytes"] -= self.run_slot.charge
            self.run_slot.charge = 0
            self.run_slot = None
        self.binding = None
        self.stats["recordBytes"] = 0
