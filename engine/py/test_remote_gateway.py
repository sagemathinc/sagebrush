"""The remote runner's gateway lane (sagebrush/remote/gateway.py; design
remote-v1 §4), in process: the local kernel p3a cases v3 (§4.3-4.9) that
don't need the socket (a3 adds the socket's gate: L22-L24), against a fake
paired conn, a logical clock and a scripted kernel port, plus the real kernel
child for the cases that are about it (Stop, the 2 s fallback with a kernel
that ignores SIGINT, the process group, the idle stop, mode-unsupported).

Authentication is test_remote_dpop.py's (the same dpop.check, called with the
socket's token, key and the rebuilt htu): here a request is authenticated
unless its auth is "refuse".

    python engine/py/test_remote_gateway.py
"""
import asyncio
import json
import os
import shutil
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))

from sagebrush.remote import gateway as G
from sagebrush.remote.wave_policy import WAVE_CAPS


# ---- fakes

class Clock:
    def __init__(self):
        self.t = 1_800_000_000_000
        self.timers = {}
        self.n = 0

    def now(self):
        return self.t

    def set_timeout(self, fn, ms):
        self.n += 1
        self.timers[self.n] = (self.t + ms, fn)
        return self.n

    def clear_timeout(self, h):
        self.timers.pop(h, None)

    def advance(self, ms):
        end = self.t + ms
        while True:
            due = sorted((at, h) for h, (at, _) in self.timers.items() if at <= end)
            if not due:
                break
            at, h = due[0]
            self.t = at
            _, fn = self.timers.pop(h)
            fn()
        self.t = end


class Conn:
    def __init__(self):
        self.closed = False
        self.token, self.jkt = "tok", "jkt"
        self.frames = []        # every frame sent, parsed, in order
        self.close_code = None
        self.room = None        # (bytes this conn still fits; None: unlimited)

    def send_text(self, text, kind):
        assert not self.closed
        self.frames.append(json.loads(text))

    def fits(self, n, kind):
        return self.room is None or n <= self.room

    def close(self, code, reason=""):
        if not self.closed:
            self.closed, self.close_code = True, code


class Server:
    def __init__(self):
        self.timers = Clock()
        self.paired_conn = None


class Handle:
    def __init__(self, port, on_message, on_exit):
        self.port, self.on_message, self.on_exit = port, on_message, on_exit
        self.posts, self.interrupts, self.terminated = [], [], False

    def post(self, m):
        self.posts.append(m)
        if self.port.auto and "code" in m:
            self.on_message({"id": m["id"], "start": True})
            if m["code"]:
                self.on_message({"id": m["id"], "out": "ran %s\n" % m["code"][:20], "stream": "stdout"})
            self.on_message({"id": m["id"], "done": True, "ms": 1})
        if self.port.auto and "complete" in m:
            self.on_message({"id": m["id"], "matches": self.port.matches, "prefix": "x"})

    def interrupt(self, up_to):
        self.interrupts.append(up_to)

    def kill_descendants(self):
        self.port.descendant_kills += 1
        return 0

    def terminate(self):
        self.terminated = True


class Scripted:
    """A kernel port that answers runs at once (auto) or holds them for the test to drive."""

    def __init__(self, auto=True):
        self.auto = auto
        self.handles = []
        self.matches = ["xa", "xb"]
        self.descendant_kills = 0

    def start(self, on_message, on_exit):
        h = Handle(self, on_message, on_exit)
        self.handles.append(h)
        return h

    @property
    def h(self):
        return self.handles[-1]


class GW(G.Gateway):
    def _verify(self, req):
        return (401, "invalid_token", None) if req.auth == "refuse" else None


class Page:
    """One paired page: frames out, answers in."""

    def __init__(self, gw, conn):
        self.gw, self.c, self.n = gw, conn, 0

    def frame(self, rpc, ref, body=None, n=None, auth="DPoP tok", **extra):
        self.n = n if n is not None else self.n + 1
        f = {"id": "t%d" % self.n, "rpc": rpc, "ref": ref, "auth": auth, "dpop": "p", "accept": "application/json"}
        if body is not None:
            f["body"] = body if isinstance(body, str) else json.dumps(body)
        f.update(extra)
        self.gw.frame(self.c, f)
        return f["id"]

    def answers(self, rid):
        return [f for f in self.c.frames if f.get("id") == rid]

    def answer(self, rid):
        a = [f for f in self.answers(rid) if "status" in f and "body" in f]
        assert len(a) == 1, (rid, self.answers(rid), self.c.close_code)
        return a[0]["status"], json.loads(a[0]["body"])


async def settle():
    for _ in range(20):
        await asyncio.sleep(0)


def setup(port=None, hold=None):
    s = Server()
    c = Conn()
    s.paired_conn = c
    gw = GW(s, port=port if port is not None else Scripted(), auth_hold=hold)
    return s, c, gw, Page(gw, c)


async def bound(port=None, hold=None):
    s, c, gw, p = setup(port, hold)
    rid = p.frame("g.bind", {}, {})
    await settle()
    st, a = p.answer(rid)
    assert st == 200 and a["binding"] == "b1", (st, a)
    return s, c, gw, p


def run_body(request, code="1+1", epoch=1, **payload):
    return {"request": request, "epoch": epoch, "payload": {"code": code, "mode": "python", **payload}}


def aio(f):
    def wrapped():
        asyncio.run(f())
    wrapped.__name__ = f.__name__
    return wrapped


# ================= 4.3 frames

@aio
async def test_L13_L14_frames():
    for frame, why in [
        ({"id": "t1", "rpc": "g.nope", "ref": {}, "auth": "a", "dpop": "p", "accept": "x"}, "L13a"),
        ({"id": "t1", "rpc": "g.record", "ref": {"b": "b 1", "r": "r"}, "auth": "a", "dpop": "p", "accept": "x"}, "L13b"),
        ({"id": "t1", "rpc": "g.run", "ref": {"b": "b1", "after": 0}, "auth": "a", "dpop": "p", "accept": "x", "body": "{}"}, "L13c"),
        ({"id": "x1", "rpc": "g.bind", "ref": {}, "auth": "a", "dpop": "p", "accept": "x", "body": "{}"}, "L14a-pfx"),
        ({"id": "t0", "rpc": "g.bind", "ref": {}, "auth": "a", "dpop": "p", "accept": "x", "body": "{}"}, "L14a-lz"),
        ({"id": "t01", "rpc": "g.bind", "ref": {}, "auth": "a", "dpop": "p", "accept": "x", "body": "{}"}, "L14a-lz"),
        ({"id": "t" + "1" * 16, "rpc": "g.bind", "ref": {}, "auth": "a", "dpop": "p", "accept": "x", "body": "{}"}, "L14a-len"),
        ({"id": "t1", "rpc": "g.bind", "ref": {}, "auth": "a", "dpop": "p", "accept": "x", "body": "{}", "x": 1}, "unknown member"),
        ({"id": "t1", "rpc": "g.record", "ref": {"b": "b1", "r": "r1"}, "auth": "a", "dpop": "p", "accept": "x", "body": "{}"}, "a GET with a body"),
        ({"id": "t1", "rpc": "g.bind", "ref": {}, "auth": "a", "dpop": "p", "accept": "x"}, "a POST without a body"),
    ]:
        s, c, gw, p = setup()
        gw.frame(c, frame)
        assert c.closed and c.close_code == 1002, why
    s, c, gw, p = setup()
    p.frame("g.bind", {}, {}, n=10**15 - 1)  # (L14a-len+: 15 digits pass)
    assert not c.closed
    for n, why in [(10**15 - 1, "L14b reused"), (5, "L14c not above")]:
        s2, c2, gw2, p2 = setup()
        p2.frame("g.bind", {}, {}, n=7)
        p2.frame("g.bind", {}, {}, n=n if n != 10**15 - 1 else 7)
        assert c2.closed and c2.close_code == 1002, why


@aio
async def test_L14e_after():
    for v, ok in [("1", False), (1.5, False), (-1, False), (2**53, False), (2**53 - 1, True), (0, True)]:
        s, c, gw, p = await bound()
        p.frame("g.events", {"b": "b1", "r": "r1", "after": v})
        assert c.closed == (not ok), v


@aio
async def test_L15_body_max():
    s, c, gw, p = await bound()
    pad = "é" * 10
    base = json.dumps(run_body("r1", code=""))
    room = G.BODY_MAX["run"] - len(base.encode())
    code = "#" + "é" * ((room - 1) // 2)
    body = json.dumps(run_body("r1", code=code), ensure_ascii=False)
    while len(body.encode()) < G.BODY_MAX["run"]:
        code += "#"
        body = json.dumps(run_body("r1", code=code), ensure_ascii=False)
    assert len(body.encode()) == G.BODY_MAX["run"]
    rid = p.frame("g.run", {"b": "b1"}, body)
    await settle()
    assert not c.closed and p.answer(rid)[0] == 202
    s, c, gw, p = await bound()
    p.frame("g.run", {"b": "b1"}, body + " ")
    assert c.closed and c.close_code == 1002
    del pad


@aio
async def test_L16_open_ids():
    hold = asyncio.Event()

    async def h(rid, conn):
        await hold.wait()
    s, c, gw, p = setup(hold=h)
    for i in range(8):
        p.frame("g.bind", {}, {})
    assert not c.closed
    p.frame("g.bind", {}, {})
    assert c.closed and c.close_code == 1002
    hold.set()
    await settle()


# ================= 4.4 retirement

@aio
async def test_L17_L19_retirement():
    hold = asyncio.Event()

    async def h(rid, conn):
        if rid == "t2":
            await hold.wait()
    s, c, gw, p = setup(hold=h)
    p.frame("g.bind", {}, {})
    await settle()
    rid = p.frame("g.record", {"b": "b1", "r": "nope"})
    gw.cancel(c, rid)
    hold.set()
    await settle()
    fr = p.answers(rid)
    assert len(fr) == 2 and fr[0]["status"] == 404 and fr[1] == {"id": rid, "retired": True}, fr  # (L17a/b)
    gw.cancel(c, "t1")  # (L19b: answered already)
    assert c.frames[-1] == {"id": "t1", "retired": True}
    gw.cancel(c, "t9")  # (L19a: never issued)
    assert c.closed and c.close_code == 1002


@aio
async def test_events_cancelled_before_their_stream():
    """r3.1 R3-1, the page tunnel's case: an events request cancelled before its stream began streams nothing, and
    `retired` is still its last frame (so the page's retired set empties, and the id no longer counts as open)."""
    s, c, gw, p = await bound()
    p.frame("g.run", {"b": "b1"}, run_body("r1", code="print(1)"))
    await settle()
    hold = asyncio.Event()

    async def h(rid, conn):
        await hold.wait()
    gw.auth_hold = h
    rid = p.frame("g.events", {"b": "b1", "r": "r1", "after": 0})
    await asyncio.sleep(0)
    gw.cancel(c, rid)
    hold.set()
    await settle()
    assert p.answers(rid) == [{"id": rid, "retired": True}] and not gw._state(c).open and not c.closed, p.answers(rid)


# ================= 4.5 streams

@aio
async def test_L21_events_and_L32c_cursor():
    s, c, gw, p = await bound()
    p.frame("g.run", {"b": "b1"}, run_body("r1", code="print(1)"))
    await settle()
    rid = p.frame("g.events", {"b": "b1", "r": "r1", "after": 0})
    await settle()
    fr = p.answers(rid)
    assert fr[0]["status"] == 200 and fr[0]["headers"]["content-type"] == "text/event-stream"
    seqs = [int(f["chunk"].split("\n")[0][4:]) for f in fr if "chunk" in f]
    assert seqs == sorted(seqs) and seqs[0] == 1 and fr[-1] == {"id": rid, "end": True}, fr
    types = [json.loads(f["chunk"].split("data: ")[1])["type"] for f in fr if "chunk" in f]
    assert types[0] == "start" and types[-1] == "terminal" and "stream" in types, types
    rid = p.frame("g.events", {"b": "b1", "r": "r1", "after": 2})  # (resume after a cursor)
    await settle()
    seqs2 = [int(f["chunk"].split("\n")[0][4:]) for f in p.answers(rid) if "chunk" in f]
    assert seqs2 == [x for x in seqs if x > 2], (seqs, seqs2)


@aio
async def test_slow_stream():
    s, c, gw, p = await bound()
    p.frame("g.run", {"b": "b1"}, run_body("r1"))
    await settle()
    c.room = 10  # (nothing more fits)
    rid = p.frame("g.events", {"b": "b1", "r": "r1", "after": 0})
    await settle()
    assert p.answers(rid)[-1] == {"id": rid, "streamError": "slow"}, p.answers(rid)


@aio
async def test_L25_answer_too_large():
    port = Scripted()
    s, c, gw, p = await bound(port)
    port.matches = ["x" * (G.RESPONSE_MAX + 1)]
    rid = p.frame("g.complete", {"b": "b1"}, {"epoch": 1, "code": "x"})
    await settle()
    assert p.answer(rid) == (502, {"error": "answer-too-large"})


# ================= 4.6 the binding

@aio
async def test_L26_L27_L28_binding_and_idempotency():
    port = Scripted(auto=False)
    s, c, gw, p = await bound(port)
    rid = p.frame("g.bind", {}, {})
    await settle()
    assert p.answer(rid) == (409, {"error": "in-use"})  # L26
    rid = p.frame("g.run", {"b": "b1"}, run_body("r1", code="x = 1  # MARKER-PAYLOAD"))
    await settle()
    assert p.answer(rid) == (202, {"request": "r1", "state": "admitted"})
    rid = p.frame("g.run", {"b": "b1"}, run_body("r2"))
    await settle()
    assert p.answer(rid) == (409, {"error": "busy"})  # L28
    rid = p.frame("g.run", {"b": "b1"}, run_body("r1", code="x = 1  # MARKER-PAYLOAD"))
    await settle()
    assert p.answer(rid) == (202, {"request": "r1", "state": "running"})  # L27a / L14d
    rid = p.frame("g.run", {"b": "b1"}, run_body("r1", code="x = 2"))
    await settle()
    assert p.answer(rid) == (409, {"error": "conflict"})  # L27b (R26: never runs)
    assert len([m for m in port.h.posts if "code" in m]) == 1  # (exactly one execution)
    run = gw.binding.runs["r1"]
    assert len(run.digest) == 64 and "MARKER" not in json.dumps(gw._record_view(run))  # L27c
    port.h.on_message({"id": 1, "done": True, "ms": 3})
    rid = p.frame("g.record", {"b": "b1", "r": "r1"})
    await settle()
    st, rec = p.answer(rid)
    assert rec["state"] == "done" and rec["outcome"] == {"status": "ok", "ms": 3}, rec
    assert gw.stats["queuedPayloadBytes"] == 0


@aio
async def test_L27c_record_size():
    s, c, gw, p = await bound()
    run = G.Run("r" * 64, "f" * 64, None, None, 0)
    run.outcome = {"status": "error", "reason": "x\"" * 300, "ms": 1.5}
    run.tomb = True
    assert gw._record_size(run) <= G.GATEWAY_LIMITS["recordBytes"], gw._record_size(run)


@aio
async def test_L29_runs_cap():
    s, c, gw, p = await bound()
    b = gw.binding
    for i in range(G.GATEWAY_LIMITS["runs"] - 1):
        r = G.Run("x%d" % i, "d", None, None, 0)
        r.outcome = {"status": "ok"}
        b.runs[r.request] = r
    rid = p.frame("g.run", {"b": "b1"}, run_body("last"))
    await settle()
    assert p.answer(rid)[0] == 202  # (L29a+: the 10,000th)
    rid = p.frame("g.run", {"b": "b1"}, run_body("over"))
    await settle()
    assert p.answer(rid) == (429, {"error": "limit", "reason": "runs"})


@aio
async def test_L30_L31_restart_and_rebind():
    port = Scripted()
    s, c, gw, p = await bound(port)
    p.frame("g.run", {"b": "b1"}, run_body("r1"))
    await settle()
    rid = p.frame("g.restart", {"b": "b1"}, {"epoch": 1, "op_id": "op1"})
    await settle()
    assert p.answer(rid) == (200, {"outcome": {"status": "done", "incarnation": 2}})
    n = gw.stats["executions"]
    rid = p.frame("g.run", {"b": "b1"}, run_body("r1"))
    await settle()
    assert p.answer(rid) == (202, {"request": "r1", "state": "done"}) and gw.stats["executions"] == n  # L30
    assert gw.binding.runs["r1"].tomb
    gw.shutdown()  # (Disconnect; then a new pairing)
    c2 = Conn()
    s.paired_conn = c2
    gw.socket_paired(c2)
    p2 = Page(gw, c2)
    rid = p2.frame("g.bind", {}, {})
    await settle()
    assert p2.answer(rid)[1]["binding"] == "b2"
    rid = p2.frame("g.record", {"b": "b1", "r": "r1"})
    await settle()
    assert p2.answer(rid) == (410, {"error": "binding-gone"})  # L31


@aio
async def test_L32_retention():
    s, c, gw, p = await bound()
    b = gw.binding
    run = G.Run("r1", "d", None, None, 0)
    b.runs["r1"] = run
    b.order.append(run)
    for i in range(G.GATEWAY_LIMITS["eventsPerRun"]):
        gw._emit(b, run, {"type": "stream", "name": "stdout", "text": "x"})
    assert run.first_seq == 1 and len(run.events) == G.GATEWAY_LIMITS["eventsPerRun"]  # L32a-count+
    gw._emit(b, run, {"type": "stream", "name": "stdout", "text": "x"})
    assert run.first_seq == 2  # L32a-count
    rid = p.frame("g.events", {"b": "b1", "r": "r1", "after": 1})  # (L32c: at the first retained event)
    await settle()
    assert p.answers(rid)[0]["status"] == 200
    rid = p.frame("g.events", {"b": "b1", "r": "r1", "after": 0})
    await settle()
    assert p.answer(rid) == (410, {"error": "expired-cursor"})


@aio
async def test_L34_complete():
    s, c, gw, p = setup()
    rid = p.frame("g.complete", {"b": "b1"}, {"epoch": 1, "code": "x"})
    await settle()
    assert p.answer(rid) == (404, {"error": "not-found"})  # L34a
    port = Scripted(auto=False)
    s, c, gw, p = await bound(port)
    r1 = p.frame("g.complete", {"b": "b1"}, {"epoch": 1, "code": "x"})
    r2 = p.frame("g.complete", {"b": "b1"}, {"epoch": 1, "code": "y"})
    await settle()
    assert p.answer(r2) == (409, {"error": "busy"})  # L34b
    port.h.on_message({"id": port.h.posts[-1]["id"], "matches": ["xy"], "prefix": "x"})
    assert p.answer(r1) == (200, {"matches": ["xy"], "prefix": "x"})


def wave(entries, mode="python", budget=None):
    return {"mode": mode, "policy": {"budget": budget, "all": True}, "forget": [], "entries": entries}


def entry(cell, code, parents=(), desc=(), **kw):
    return {"cell": cell, "code": code, "mode": "python", "auto": False, "est": 0, "parents": list(parents), "desc": list(desc), "defs": [], **kw}


@aio
async def test_L35_waves():
    for bad, why in [
        ([entry("a", "1"), entry("b", "#" * (G.GATEWAY_LIMITS["cellCode"] + 1))], "L35a-size"),
        ([entry("c%d" % i, "1") for i in range(WAVE_CAPS["entries"] + 1)], "L35a-count"),
        ([entry("a", "1"), entry("b", "2", parents=[{"in": 5}])], "L35a-ref"),
    ]:
        s, c, gw, p = await bound()
        rid = p.frame("g.run", {"b": "b1"}, {"request": "w", "epoch": 1, "kind": "wave", "payload": wave(bad)})
        await settle()
        st, a = p.answer(rid)
        assert st == 400 and a["error"] == "malformed" and gw.stats["executions"] == 0 and not gw.binding.runs, (why, st, a)
    port = Scripted(auto=False)
    s, c, gw, p = await bound(port)
    rid = p.frame("g.run", {"b": "b1"}, {"request": "w", "epoch": 1, "kind": "wave",
                                          "payload": wave([entry("a", "A", desc=[1, 2]), entry("b", "B", parents=[{"in": 0}], desc=[2]),
                                                           entry("c", "C", parents=[{"in": 1}])])})
    await settle()
    assert p.answer(rid)[0] == 202
    order = []
    run = gw.binding.runs["w"]
    while not run.outcome:
        await settle()
        m = port.h.posts[-1]
        if m["code"] in order:
            continue
        order.append(m["code"])
        k = len(order) - 1
        assert run.wave["entries"][k].get("code") is None  # (L36e: the destructive handoff)
        port.h.on_message({"id": m["id"], "done": True, "ms": 1, **({"error": True} if m["code"] == "B" else {})})
        await settle()
    assert order == ["A", "B"], order  # (L35b: in order; B failed, so C never ran)
    assert run.outcome == {"status": "done"} and gw.stats["queuedPayloadBytes"] == 0
    assert run.ends[2]["decision"] == {"kind": "cancelled", "by": 1, "why": "exception"}, run.ends


def test_wave_policy_parity():
    """The Python port decides as src/wave-policy.ts does (the page replays the gateway's decisions): 200 seeded waves
    from gen_remote_wave_cases.mjs, each entry's scripted result, and a Stop latched before some entry."""
    from sagebrush.remote import wave_policy as W
    with open(os.path.join(HERE, "test_remote_wave_cases.json"), encoding="utf8") as f:
        cases = json.load(f)["cases"]
    n = 0
    for c in cases:
        p = c["payload"]
        assert W.wave_envelope_invalid(p) is None
        st = W.WaveState()
        for k, e in enumerate(p["entries"]):
            if k == c["stopBefore"] and not st.stopped:
                W.wave_stop(st)
            d = W.wave_decide(p["policy"], st, k, e)
            assert d == c["decisions"][k], (c, k, d)
            W.wave_record(st, k, e, d, W.wave_run_result(c["outcomes"][k]) if d["kind"] == "run" else None)
            n += 1
    assert n == sum(len(c["decisions"]) for c in cases) and n > 800, n
    kinds = {d["kind"] for c in cases for d in c["decisions"]}
    assert kinds == {"run", "gone", "stale", "cancelled"}, kinds  # (every kind of decision exercised)


# ================= 4.7 the fence

def holder(names):
    ev = asyncio.Event()

    async def h(rid, conn):
        if rid in names:
            await ev.wait()
    return ev, h


@aio
async def test_L42_fence():
    # L42a: a held g.run, then the socket closes: nothing admitted, nothing sent
    ev, h = holder({"t2"})
    s, c, gw, p = await bound(hold=h)
    rid = p.frame("g.run", {"b": "b1"}, run_body("r1"))
    c.closed = True
    ev.set()
    await settle()
    assert not gw.binding.runs and p.answers(rid) == [] and gw.stats["queuedPayloadBytes"] == 0
    # L42f: a held g.interrupt, then a g.restart on the same socket: 409 stale, the new kernel not interrupted
    ev, h = holder({"t2"})
    port = Scripted()
    s, c, gw, p = await bound(port, hold=h)
    r_int = p.frame("g.interrupt", {"b": "b1"}, {"epoch": 1})
    r_rst = p.frame("g.restart", {"b": "b1"}, {"epoch": 1})
    await settle()
    assert p.answer(r_rst)[0] == 200
    ev.set()
    await settle()
    assert p.answer(r_int) == (409, {"error": "stale"}) and port.h.interrupts == []
    # L42g: a held g.run, then a g.takeover: 409 stale, zero admissions
    ev, h = holder({"t2"})
    s, c, gw, p = await bound(hold=h)
    r_run = p.frame("g.run", {"b": "b1"}, run_body("r1"))
    r_to = p.frame("g.takeover", {"b": "b1"}, {"from_epoch": 1})
    await settle()
    assert p.answer(r_to)[1]["epoch"] == 2
    ev.set()
    await settle()
    assert p.answer(r_run) == (409, {"error": "stale"}) and not gw.binding.runs and gw.stats["queuedPayloadBytes"] == 0
    # L42k: a held g.takeover, then the socket closes: no epoch change
    ev, h = holder({"t2"})
    s, c, gw, p = await bound(hold=h)
    p.frame("g.takeover", {"b": "b1"}, {})
    c.closed = True
    ev.set()
    await settle()
    assert gw.binding.epoch == 1
    # L42i: a held g.bind, then an unpair: no binding
    ev, h = holder({"t1"})
    s, c, gw, p = setup(hold=h)
    p.frame("g.bind", {}, {})
    c.closed = True
    s.paired_conn = None
    ev.set()
    await settle()
    assert gw.binding is None


@aio
async def test_L43_stale_outputs():
    port = Scripted(auto=False)
    s, c, gw, p = await bound(port)
    old = port.h
    p.frame("g.run", {"b": "b1"}, run_body("r1"))
    await settle()
    p.frame("g.restart", {"b": "b1"}, {"epoch": 1})
    await settle()
    assert old.terminated
    n = gw.stats["staleOutputs"]
    old.on_message({"id": 1, "out": "late", "stream": "stdout"})
    old.on_message({"id": 1, "done": True, "ms": 1})
    assert gw.stats["staleOutputs"] == n + 2
    assert gw.binding.runs["r1"].outcome == {"status": "stopped", "reason": "kernel restarted"}


@aio
async def test_L36d_eight_runs_one_admitted():
    port = Scripted(auto=False)
    s, c, gw, p = await bound(port)
    ids = [p.frame("g.run", {"b": "b1"}, run_body("r%d" % i)) for i in range(8)]
    await settle()
    st = [p.answer(i)[0] for i in ids]
    assert st.count(202) == 1 and st.count(409) == 7, st
    assert gw.stats["maxQueuedPayloadBytes"] == len(json.dumps(run_body("r0")).encode())


@aio
async def test_auth_refused_has_no_effect():
    s, c, gw, p = await bound()
    rid = p.frame("g.run", {"b": "b1"}, run_body("r1"), auth="refuse")
    await settle()
    assert p.answer(rid)[0] == 401 and not gw.binding.runs and gw.stats["queuedPayloadBytes"] == 0


# ---- grader's #762 TESTS group A: the real verification path (the GW fake above replaces _verify), the dedupe key,
# the event seq

class RealGW(G.Gateway):
    """The gateway as shipped: _verify is its own, calling dpop.check (replaced per test, restored after)."""


def real_setup(port=None):
    s = Server()
    c = Conn()
    s.paired_conn = c
    gw = RealGW(s, port=port if port is not None else Scripted())
    return s, c, gw, Page(gw, c)


class CheckStub:
    """dpop.check, scripted: raise, refuse or accept; it records the nonce each call was given."""

    def __init__(self):
        self.mode, self.nonces, self.real = "accept", [], G.dpop.check

    def __call__(self, auth, proof, **kw):
        self.nonces.append(kw["nonce"])
        if self.mode == "raise":
            raise RuntimeError("a verifier fault")
        return None if self.mode == "accept" else (401, "invalid_dpop_proof", "signature", {})

    def __enter__(self):
        G.dpop.check = self
        return self

    def __exit__(self, *a):
        G.dpop.check = self.real


@aio
async def test_verification_raising_is_refused():
    """G18: a verification that raises (dpop.check, or the auth hold) is a 401 invalid_dpop_proof: nothing dispatched,
    no effect, its slot released; the same request verified (the control) then goes through."""
    port = Scripted()
    s, c, gw, p = real_setup(port)
    with CheckStub() as chk:
        chk.mode = "raise"
        rid = p.frame("g.bind", {}, {})
        await settle()
        assert p.answer(rid) == (401, {"error": "invalid_dpop_proof"}) and gw.binding is None
        chk.mode = "accept"
        rid = p.frame("g.bind", {}, {})
        await settle()
        assert p.answer(rid)[0] == 200 and gw.binding is not None
        chk.mode = "raise"
        rid = p.frame("g.run", {"b": "b1"}, run_body("r1"))
        await settle()
        assert p.answer(rid) == (401, {"error": "invalid_dpop_proof"})
        posted = [m for h in port.handles for m in h.posts if "code" in m]
        assert not gw.binding.runs and gw.run_slot is None and gw.stats["queuedPayloadBytes"] == 0 and not posted, (
            gw.binding.runs, gw.run_slot, gw.stats["queuedPayloadBytes"], posted)
        chk.mode = "accept"
        rid = p.frame("g.run", {"b": "b1"}, run_body("r1"))
        await settle()
        assert p.answer(rid) == (202, {"request": "r1", "state": "admitted"}), p.answers(rid)
    # (an auth hold that raises: the same refusal)

    async def bad_hold(rid, conn):
        raise RuntimeError("a hold fault")
    s, c, gw, p = real_setup()
    gw.auth_hold = bad_hold
    with CheckStub():
        rid = p.frame("g.bind", {}, {})
        await settle()
        assert p.answer(rid) == (401, {"error": "invalid_dpop_proof"}) and gw.binding is None


@aio
async def test_verification_sees_the_rotated_nonce():
    """G16: the nonce rotates (after nonceMs) before a proof is checked, so a proof is checked against the current
    nonce, never one that has just expired; the answer carries the new one."""
    s, c, gw, p = real_setup()
    with CheckStub() as chk:
        rid = p.frame("g.bind", {}, {})
        await settle()
        n0 = gw.nonce
        assert chk.nonces == [n0]
        s.timers.advance(G.dpop.LIMITS["nonceMs"] + 1)
        rid = p.frame("g.record", {"b": "b1", "r": "r1"})
        await settle()
        assert chk.nonces[-1] != n0 and chk.nonces[-1] == gw.nonce, (n0, chk.nonces)
        assert [f for f in p.answers(rid) if "headers" in f][0]["headers"]["dpop-nonce"] == gw.nonce


@aio
async def test_dedupe_key_is_the_payload():
    """G22: at-most-once is keyed by (request, the payload's digest): the same run sent again with its envelope's keys
    in another order is the same admission (never a 409, never a second execution)."""
    port = Scripted(auto=False)
    s, c, gw, p = await bound(port)
    body = run_body("r1", code="x = 1")
    rid = p.frame("g.run", {"b": "b1"}, body)
    await settle()
    assert p.answer(rid) == (202, {"request": "r1", "state": "admitted"})
    again = json.dumps({"payload": body["payload"], "epoch": body["epoch"], "request": "r1"})
    rid = p.frame("g.run", {"b": "b1"}, again)
    await settle()
    assert p.answer(rid) == (202, {"request": "r1", "state": "running"}), p.answers(rid)
    assert len([m for m in port.h.posts if "code" in m]) == 1


@aio
async def test_event_seq_increases():
    """G19: a run's events carry seq 1, 2, 3 ... (the page's events?after= cursor depends on it)."""
    port = Scripted(auto=False)
    s, c, gw, p = await bound(port)
    rid = p.frame("g.run", {"b": "b1"}, run_body("r1"))
    await settle()
    h = port.h
    mid = h.posts[-1]["id"]
    h.on_message({"id": mid, "start": True})
    for i in range(3):
        h.on_message({"id": mid, "out": "line %d\n" % i, "stream": "stdout"})
    h.on_message({"id": mid, "done": True, "ms": 1})
    seqs = [e["seq"] for e in events_of(gw, "r1")]
    assert len(seqs) >= 4 and seqs == list(range(1, len(seqs) + 1)), seqs


# ---- grader's #762 TESTS groups B-D, the observable ones (the rest: equivalence, in the PR body)

def gate_hold(ids):
    """An auth hold that holds the given request ids until the gate opens."""
    gate = asyncio.Event()

    async def hold(rid, conn):
        if rid in ids:
            await gate.wait()
    return gate, hold


@aio
async def test_exit_fences_held_requests():
    """X2b: the kernel exiting by itself bumps the binding's generation, so a request admitted to the gateway before
    it and handled after it is stale (409), never run in the new kernel; G15: refusal wins over stale."""
    gate, hold = gate_hold({"t50", "t51"})
    port = Scripted()
    s, c, gw, p = await bound(port, hold)
    rid = p.frame("g.run", {"b": "b1"}, run_body("r1"))
    await settle()
    assert p.answer(rid)[0] == 202
    held = p.frame("g.run", {"b": "b1"}, run_body("r2"), n=50)
    refused = p.frame("g.run", {"b": "b1"}, run_body("r3"), n=51, auth="refuse")
    await settle()
    port.h.on_exit("crashed")
    gate.set()
    await settle()
    assert p.answer(held) == (409, {"error": "stale"}), p.answers(held)
    assert p.answer(refused)[0] == 401, p.answers(refused)  # (G15: refusal before stale)
    assert "r2" not in gw.binding.runs and "r3" not in gw.binding.runs


@aio
async def test_exit_tombstones_and_complete_restarts_kernel():
    """X4: after the kernel exits, its runs' events are dropped (the namespace they described is gone): a cursor into
    them is expired (410); X6: completion starts a kernel again (lazily) rather than answering unavailable."""
    port = Scripted()
    s, c, gw, p = await bound(port)
    rid = p.frame("g.run", {"b": "b1"}, run_body("r1"))
    await settle()
    assert p.answer(rid)[0] == 202 and gw.binding.runs["r1"].outcome
    port.h.on_exit("crashed")
    rid = p.frame("g.events", {"b": "b1", "r": "r1", "after": 0})
    await settle()
    assert p.answer(rid) == (410, {"error": "expired-cursor"}), p.answers(rid)
    n = len(port.handles)
    rid = p.frame("g.complete", {"b": "b1"}, {"epoch": 1, "code": "x", "mode": "python"})
    await settle()
    st, a = p.answer(rid)
    assert st == 200 and a["matches"] == ["xa", "xb"] and len(port.handles) == n + 1, (st, a)


@aio
async def test_second_stop_keeps_the_first_deadline():
    """G11: a second Stop doesn't push the fallback back: it fires fallbackMs after the first."""
    port = Scripted(auto=False)
    s, c, gw, p = await bound(port)
    p.frame("g.run", {"b": "b1"}, run_body("r1"))
    await settle()
    p.frame("g.interrupt", {"b": "b1"}, {"epoch": 1})
    await settle()
    s.timers.advance(1500)
    p.frame("g.interrupt", {"b": "b1"}, {"epoch": 1})
    await settle()
    s.timers.advance(501)
    assert gw.stats["fallbacks"] == 1


@aio
async def test_a_runs_end_clears_its_fallback():
    """G13: a stopped run that ends in time clears its fallback timer, so the next run's Stop arms its own."""
    port = Scripted(auto=False)
    s, c, gw, p = await bound(port)
    p.frame("g.run", {"b": "b1"}, run_body("r1"))
    await settle()
    p.frame("g.interrupt", {"b": "b1"}, {"epoch": 1})
    await settle()
    s.timers.advance(100)
    port.h.on_message({"id": port.h.posts[-1]["id"], "done": True, "error": True, "ename": "KeyboardInterrupt", "ms": 100})
    await settle()
    assert gw.binding.runs["r1"].outcome
    p.frame("g.run", {"b": "b1"}, run_body("r2"))
    await settle()
    p.frame("g.interrupt", {"b": "b1"}, {"epoch": 1})
    await settle()
    s.timers.advance(2001)
    assert gw.stats["fallbacks"] == 1 and gw.binding.runs["r2"].outcome == {"status": "stopped", "reason": "fallback"}


@aio
async def test_wave_stop_latch():
    """G28: a Stop between a wave's entries (none running) is latched: the next entry doesn't run, the wave stops there;
    G29: a Stop while an entry runs is sent to the kernel."""
    port = Scripted(auto=False)
    s, c, gw, p = await bound(port)
    p.frame("g.run", {"b": "b1"}, {"request": "w", "epoch": 1, "kind": "wave", "payload": wave([entry("a", "A"), entry("b", "B")])})
    p.frame("g.interrupt", {"b": "b1"}, {"epoch": 1})  # (handled before the wave's task starts its first entry)
    await settle()
    run = gw.binding.runs["w"]
    assert not [m for m in port.h.posts if m.get("code")] and any(e["type"] == "stop" for e in run.events), run.events
    port2 = Scripted(auto=False)
    s, c, gw, p = await bound(port2)
    p.frame("g.run", {"b": "b1"}, {"request": "w", "epoch": 1, "kind": "wave", "payload": wave([entry("a", "A"), entry("b", "B")])})
    await settle()
    assert [m["code"] for m in port2.h.posts if m.get("code")] == ["A"]
    p.frame("g.interrupt", {"b": "b1"}, {"epoch": 1})
    await settle()
    assert port2.h.interrupts, port2.h.interrupts


def test_wave_bounds():
    """W7: an entry can't list itself (d == k) as its own descendant; I6: a run outcome's ms is a finite JSON number
    within 2^53 - 1, anything else 0."""
    from sagebrush.remote import wave_policy as WP
    e = {"cell": "a", "auto": True, "est": 0, "code": "1", "parents": [], "desc": [0]}
    assert WP.wave_invalid([e]) == "a descendant not after its entry"
    e2 = dict(e, cell="b", desc=[])
    assert WP.wave_invalid([dict(e, desc=[1]), e2]) is None  # (the control: a later entry)
    for bad in (float("inf"), float("-inf"), float("nan"), 2 ** 60, -(2 ** 60), True, "5", None):
        assert WP.wave_run_result({"status": "ok", "ms": bad})["ms"] == 0, bad
    assert WP.wave_run_result({"status": "ok", "ms": 2 ** 53 - 1})["ms"] == 2 ** 53 - 1


@aio
async def test_mode_unsupported():
    for mode in ("matlab", "magma"):
        s, c, gw, p = await bound()
        b = run_body("r1")
        b["payload"]["mode"] = mode
        rid = p.frame("g.run", {"b": "b1"}, b)
        await settle()
        assert p.answer(rid) == (400, {"error": "mode-unsupported", "modes": ["python", "sage"]}) and not gw.binding.runs
    s, c, gw, p = await bound()
    rid = p.frame("g.run", {"b": "b1"}, {"request": "w", "epoch": 1, "kind": "wave", "payload": wave([entry("a", "1", mode="matlab")])})
    await settle()
    assert p.answer(rid)[1]["error"] == "mode-unsupported"


@aio
async def test_epoch():
    s, c, gw, p = await bound()
    rid = p.frame("g.run", {"b": "b1"}, run_body("r1", epoch=2))
    await settle()
    assert p.answer(rid) == (409, {"error": "epoch"})


# ================= 4.9 lifecycle, on the scripted port

@aio
async def test_L33b_fallback_fake_clock():
    port = Scripted(auto=False)
    s, c, gw, p = await bound(port)
    old = port.h
    p.frame("g.run", {"b": "b1"}, run_body("r1"))
    await settle()
    p.frame("g.interrupt", {"b": "b1"}, {"epoch": 1})
    await settle()
    assert old.interrupts == [1]
    s.timers.advance(1999)
    assert not old.terminated
    s.timers.advance(1)
    assert old.terminated and port.h is not old and gw.stats["fallbacks"] == 1
    assert gw.binding.runs["r1"].outcome == {"status": "stopped", "reason": "fallback"} and gw.binding.incarnation == 2


@aio
async def test_L37_idle():
    port = Scripted()
    s, c, gw, p = await bound(port)
    k = port.h
    s.paired_conn = None
    c.closed = True
    gw.socket_lost(c)
    s.timers.advance(10 * 60_000 - 1)
    assert not k.terminated  # L37+
    s.timers.advance(1)
    assert k.terminated and gw.binding is not None and gw.binding.incarnation == 2  # (the records stay)


@aio
async def test_idle_never_stops_a_run():
    port = Scripted(auto=False)
    s, c, gw, p = await bound(port)
    k = port.h
    p.frame("g.run", {"b": "b1"}, run_body("r1"))
    await settle()
    s.paired_conn = None
    c.closed = True
    gw.socket_lost(c)
    s.timers.advance(60 * 60_000)
    assert not k.terminated  # (design §7 R3: no page is never a reason to stop a run)
    k.on_message({"id": 1, "done": True, "ms": 1})
    await settle()
    s.timers.advance(10 * 60_000 - 1)
    assert not k.terminated
    s.timers.advance(1)
    assert k.terminated  # (idle from the run's end)


# ================= the real kernel child (ChildPort)

async def real(timeout=60):
    s, c, gw, p = await bound(G.ChildPort(cwd=HERE))
    return s, c, gw, p


async def until(pred, timeout=60):
    end = time.monotonic() + timeout

    def ok():
        try:
            return pred()
        except (KeyError, StopIteration):  # (not admitted, or no such event, yet)
            return False
    while not ok():
        assert time.monotonic() < end, "timed out"
        await asyncio.sleep(0.02)


def events_of(gw, request):
    run = gw.binding.runs.get(request)
    return run.events if run else []


@aio
async def test_real_kernel_run_and_stop():
    s, c, gw, p = await real()
    try:
        p.frame("g.run", {"b": "b1"}, run_body("r1", code="x = 6 * 7\nprint('hello')\nx"))
        await until(lambda: gw.binding.runs["r1"].outcome)
        ev = events_of(gw, "r1")
        text = "".join(e["text"] for e in ev if e["type"] == "stream")
        assert text == "hello\n42\n" and ev[-1]["outcome"]["status"] == "ok", ev
        p.frame("g.run", {"b": "b1"}, run_body("r2", code="import time\nwhile True: time.sleep(0.01)"))
        await until(lambda: any(e["type"] == "start" for e in events_of(gw, "r2")))
        await asyncio.sleep(0.3)
        p.frame("g.interrupt", {"b": "b1"}, {"epoch": 1})  # L33a: ends when the kernel says so
        await until(lambda: gw.binding.runs["r2"].outcome)
        assert gw.binding.runs["r2"].outcome["status"] == "error" and gw.stats["fallbacks"] == 0
        p.frame("g.run", {"b": "b1"}, run_body("r3", code="x"))  # (the variables are kept)
        await until(lambda: gw.binding.runs["r3"].outcome)
        assert "".join(e.get("text", "") for e in events_of(gw, "r3")) == "42\n"
    finally:
        gw.shutdown()


@aio
async def test_real_kernel_fallback_kills_the_tree():
    """L33b / R27: code that ignores SIGINT, with a grandchild: the 2 s fallback (fake clock) advances the generation
    first, then kills the process group; a new kernel answers."""
    s, c, gw, p = await real()
    try:
        code = ("import signal, subprocess\nsignal.signal(signal.SIGINT, signal.SIG_IGN)\n"
                "g = subprocess.Popen(['sleep', '300'])\nprint(g.pid, flush=True)\nimport time\nwhile True: time.sleep(0.01)")
        p.frame("g.run", {"b": "b1"}, run_body("r1", code=code))
        await until(lambda: any(e["type"] == "stream" for e in events_of(gw, "r1")))
        grandchild = int(next(e["text"] for e in events_of(gw, "r1") if e["type"] == "stream").split()[0])
        old = gw.worker.proc.pid
        gen = gw.binding.gen
        p.frame("g.interrupt", {"b": "b1"}, {"epoch": 1})
        await settle()
        await asyncio.sleep(0.5)
        assert not gw.binding.runs["r1"].outcome  # (SIGINT ignored)
        s.timers.advance(2000)
        assert gw.binding.gen == gen + 1 and gw.binding.runs["r1"].outcome == {"status": "stopped", "reason": "fallback"}

        def gone(pid):
            try:
                with open("/proc/%d/stat" % pid) as f:
                    return f.read().split(")")[-1].split()[0] == "Z"
            except OSError:
                return True
        await until(lambda: gone(old) and gone(grandchild), 10)
        p.frame("g.run", {"b": "b1"}, run_body("r2", code="1 + 1"))
        await until(lambda: gw.binding.runs["r2"].outcome)
        assert "".join(e.get("text", "") for e in events_of(gw, "r2")) == "2\n"
    finally:
        gw.shutdown()


def _gone(pid):
    try:
        with open("/proc/%d/stat" % pid) as f:
            return f.read().split(")")[-1].split()[0] == "Z"
    except OSError:
        return True


@aio
async def test_real_stop_while_waiting_on_a_child():
    """daybreak3's R762-STOP-1: a cell waiting on a subprocess; a Stop interrupts the kernel's whole process group, so
    the subprocess doesn't outlive the run; the outcome says KeyboardInterrupt (the page marks it interrupted); the
    kernel and its variables stay."""
    s, c, gw, p = await real()
    try:
        p.frame("g.run", {"b": "b1"}, run_body("r0", code="kept = 5"))
        await until(lambda: gw.binding.runs["r0"].outcome)
        kernel = gw.worker.proc.pid
        p.frame("g.run", {"b": "b1"}, run_body("r1", code="import subprocess\np = subprocess.Popen(['sleep', '60'])\nprint(p.pid, flush=True)\np.wait()"))
        await until(lambda: any(e["type"] == "stream" for e in events_of(gw, "r1")))
        child = int(next(e["text"] for e in events_of(gw, "r1") if e["type"] == "stream").split()[0])
        p.frame("g.interrupt", {"b": "b1"}, {"epoch": 1})
        await until(lambda: gw.binding.runs["r1"].outcome, 10)
        o = gw.binding.runs["r1"].outcome
        assert o["status"] == "error" and o["ename"] == "KeyboardInterrupt", o
        await until(lambda: _gone(child), 10)
        assert gw.worker.proc.pid == kernel and gw.stats["fallbacks"] == 0
        p.frame("g.run", {"b": "b1"}, run_body("r2", code="kept"))
        await until(lambda: gw.binding.runs["r2"].outcome)
        assert "".join(e.get("text", "") for e in events_of(gw, "r2")) == "5\n"
    finally:
        gw.shutdown()


@aio
async def test_real_stop_reaches_the_child_itself():
    """The SIGINT goes to the whole group, so the child gets it itself, not only the kernel.  (The child, a shell,
    records its own SIGINT in a file: the kernel printing the child's exit status raced its own KeyboardInterrupt,
    which can land after the try once the child is already reaped (seen on CI, Python 3.14).)"""
    s, c, gw, p = await real()
    d = tempfile.mkdtemp(prefix="sb-stop-")
    mark = os.path.join(d, "got-int")
    try:
        code = ("import subprocess\np = subprocess.Popen(['sh', '-c', 'trap \"echo got-int > %s; exit 3\" INT; "
                "sleep 60 & wait'])\nprint('started', flush=True)\np.wait()" % mark)
        p.frame("g.run", {"b": "b1"}, run_body("r1", code=code))
        await until(lambda: any(e["type"] == "stream" for e in events_of(gw, "r1")))
        await asyncio.sleep(0.3)
        p.frame("g.interrupt", {"b": "b1"}, {"epoch": 1})
        await until(lambda: gw.binding.runs["r1"].outcome, 10)
        await until(lambda: os.path.exists(mark), 10)
        with open(mark) as f:
            assert f.read().strip() == "got-int"
    finally:
        gw.shutdown()
        shutil.rmtree(d, ignore_errors=True)


@aio
async def test_real_stop_ends_what_ignored_the_sigint():
    """A subprocess that ignores SIGINT, left behind by a stopped run that did end: SIGTERM at the run's end (then
    SIGKILL), before any next run; the kernel stays."""
    s, c, gw, p = await real()
    try:
        code = ("import subprocess\np = subprocess.Popen(['sh', '-c', 'trap \"\" INT; sleep 60'])\n"
                "print(p.pid, flush=True)\np.wait()")
        p.frame("g.run", {"b": "b1"}, run_body("r1", code=code))
        await until(lambda: any(e["type"] == "stream" for e in events_of(gw, "r1")))
        child = int(next(e["text"] for e in events_of(gw, "r1") if e["type"] == "stream").split()[0])
        kernel = gw.worker.proc.pid
        await asyncio.sleep(0.2)
        p.frame("g.interrupt", {"b": "b1"}, {"epoch": 1})
        await until(lambda: gw.binding.runs["r1"].outcome, 10)
        assert gw.binding.runs["r1"].outcome.get("ename") == "KeyboardInterrupt"
        assert gw.stats["descendantsKilled"] >= 1
        await until(lambda: _gone(child), 10)
        assert gw.worker.proc.pid == kernel
    finally:
        gw.shutdown()


@aio
async def test_real_restart_kills_what_ignores_sigterm():
    """grader's G8 and G7b: a restart kills the kernel's whole process group, SIGTERM then SIGKILL after 2 s, to the
    group (killpg): a process in it ignoring SIGTERM and SIGINT is gone within the bound."""
    s, c, gw, p = await real()
    try:
        code = ("import subprocess, time\np = subprocess.Popen(['sh', '-c', 'trap \"\" TERM INT; sleep 60'])\n"
                "print(p.pid, flush=True)\ntime.sleep(60)")
        p.frame("g.run", {"b": "b1"}, run_body("r1", code=code))
        await until(lambda: any(e["type"] == "stream" for e in events_of(gw, "r1")))
        child = int(next(e["text"] for e in events_of(gw, "r1") if e["type"] == "stream").split()[0])
        await asyncio.sleep(0.2)
        p.frame("g.restart", {"b": "b1"}, {"epoch": 1})
        await until(lambda: _gone(child), 6)
    finally:
        gw.shutdown()


@aio
async def test_real_stop_ends_an_orphan_that_ignores_everything():
    """grader's S5 and S6: a stopped run's leftover, an orphan (its parent gone, reparented away from the kernel) still
    in the kernel's process group, ignoring SIGINT and SIGTERM: found by its process group (not its parent) and
    SIGKILLed 2 s after the SIGTERM, before any next run."""
    s, c, gw, p = await real()
    try:
        code = ("import subprocess, time\n"
                "o = subprocess.run(['sh', '-c', '(trap \"\" INT TERM; exec sleep 60) > /dev/null 2>&1 & echo $!'],"
                " capture_output=True, text=True).stdout\n"
                "print(o.strip(), flush=True)\ntime.sleep(60)")
        p.frame("g.run", {"b": "b1"}, run_body("r1", code=code))
        await until(lambda: any(e["type"] == "stream" for e in events_of(gw, "r1")))
        orphan = int(next(e["text"] for e in events_of(gw, "r1") if e["type"] == "stream").split()[0])
        with open("/proc/%d/stat" % orphan) as f:
            ppid = int(f.read().split(")")[-1].split()[1])
        assert ppid != gw.worker.proc.pid, "(the orphan's parent should no longer be the kernel)"
        await asyncio.sleep(0.2)
        p.frame("g.interrupt", {"b": "b1"}, {"epoch": 1})
        await until(lambda: gw.binding.runs["r1"].outcome, 10)
        await until(lambda: _gone(orphan), 6)
    finally:
        gw.shutdown()


@aio
async def test_real_zombies_are_not_descendants():
    """grader's S4: an exited, unreaped child (a zombie) in the group isn't counted, or signalled, as a live descendant
    when a stopped run ends."""
    s, c, gw, p = await real()
    try:
        code = ("import subprocess, time\nz = subprocess.Popen(['true'])\ntime.sleep(0.5)\n"
                "print(z.pid, flush=True)\ntime.sleep(60)")
        p.frame("g.run", {"b": "b1"}, run_body("r1", code=code))
        await until(lambda: any(e["type"] == "stream" for e in events_of(gw, "r1")))
        z = int(next(e["text"] for e in events_of(gw, "r1") if e["type"] == "stream").split()[0])
        with open("/proc/%d/stat" % z) as f:
            assert f.read().split(")")[-1].split()[0] == "Z"
        p.frame("g.interrupt", {"b": "b1"}, {"epoch": 1})
        await until(lambda: gw.binding.runs["r1"].outcome, 10)
        assert gw.stats["descendantsKilled"] == 0, gw.stats["descendantsKilled"]
    finally:
        gw.shutdown()


@aio
async def test_no_stuck_tasks():
    """daybreak3's R762-TASK-2: a run's task returns when its kernel is restarted, replaced by the fallback, exits or
    is shut down: no task is left waiting, nothing keeps its payload."""
    async def check(action):
        port = Scripted(auto=False)
        s, c, gw, p = await bound(port)
        p.frame("g.run", {"b": "b1"}, run_body("r1"))
        await settle()
        assert gw.binding.runs["r1"].owner == "worker"
        await action(s, gw, p, port)
        await settle()
        pending = [t for t in asyncio.all_tasks() if t is not asyncio.current_task()]
        assert not pending, (action.__name__, pending)
        assert not gw.worker_runs and (gw.binding is None or gw.binding.runs["r1"].outcome), action.__name__

    async def restart(s, gw, p, port):
        p.frame("g.restart", {"b": "b1"}, {"epoch": 1})

    async def fallback(s, gw, p, port):
        p.frame("g.interrupt", {"b": "b1"}, {"epoch": 1})
        await settle()
        s.timers.advance(2000)

    async def exits(s, gw, p, port):
        port.h.on_exit("exit 1")

    async def shutdown(s, gw, p, port):
        gw.shutdown()

    async def wave_restart(s, gw, p, port):
        p.frame("g.restart", {"b": "b1"}, {"epoch": 1})
    for a in (restart, fallback, exits, shutdown):
        await check(a)
    # a wave mid-entry, restarted
    port = Scripted(auto=False)
    s, c, gw, p = await bound(port)
    p.frame("g.run", {"b": "b1"}, {"request": "w", "epoch": 1, "kind": "wave", "payload": wave([entry("a", "A"), entry("b", "B")])})
    await settle()
    p.frame("g.restart", {"b": "b1"}, {"epoch": 1})
    await settle()
    assert not [t for t in asyncio.all_tasks() if t is not asyncio.current_task()]
    assert gw.binding.runs["w"].outcome["reason"] == "kernel restarted"


@aio
async def test_fence_every_handoff():
    """astra's R762-FENCE-1: a wave with an initial forget, then a restart in the same turn: the wave was stopped by
    the restart, and nothing of it (its forget included) reaches the new kernel.  The positive: without the restart
    the forget goes to the kernel it was admitted under."""
    port = Scripted(auto=False)
    s, c, gw, p = await bound(port)
    w = wave([entry("a", "print(42)")])
    w["forget"] = ["victim"]
    p.frame("g.run", {"b": "b1"}, {"request": "stale", "epoch": 1, "kind": "wave", "payload": w})
    p.frame("g.restart", {"b": "b1"}, {"epoch": 1})
    await settle()
    assert port.handles[0].terminated and port.h is not port.handles[0]
    assert port.h.posts == [], port.h.posts
    assert gw.binding.runs["stale"].outcome == {"status": "stopped", "reason": "kernel restarted"}
    assert not [t for t in asyncio.all_tasks() if t is not asyncio.current_task()]
    # the same for a single run (astra's r3 follow-up): no start event after its stop, no payload read, no post
    port = Scripted(auto=False)
    s, c, gw, p = await bound(port)
    errors = []
    asyncio.get_running_loop().set_exception_handler(lambda loop, ctx: errors.append(ctx))
    p.frame("g.run", {"b": "b1"}, run_body("single"))
    p.frame("g.restart", {"b": "b1"}, {"epoch": 1})
    await settle()
    run = gw.binding.runs["single"]
    assert run.outcome == {"status": "stopped", "reason": "kernel restarted"} and port.h.posts == [] and not errors, (run.outcome, port.h.posts, errors)
    assert [e["type"] for e in run.events] == [] and run.tomb and run.payload is None  # (tombstoned; no event after it)
    assert not [t for t in asyncio.all_tasks() if t is not asyncio.current_task()]
    asyncio.get_running_loop().set_exception_handler(None)
    port = Scripted(auto=False)
    s, c, gw, p = await bound(port)
    p.frame("g.run", {"b": "b1"}, {"request": "ok", "epoch": 1, "kind": "wave", "payload": w})
    await settle()
    assert port.h.posts[0]["forget"] == ["victim"] and port.h.posts[0]["code"] == "", port.h.posts


@aio
async def test_total_numbers_and_parse():
    """astra's R762-INPUT-3: JSON numbers no float holds (10**1000 as a budget or an est) and a nesting deeper than
    the parser's stack are refused, 400 malformed, with no effect: the slot and its bytes released, no kernel post,
    and a valid run admitted next."""
    for bad in ({"budget": 10**1000}, {"est": 10**1000}, {"est": -(10**400)}, {"budget": 2**53}):
        port = Scripted()
        s, c, gw, p = await bound(port)
        w = wave([entry("a", "print(42)")])
        if "budget" in bad:
            w["policy"]["budget"] = bad["budget"]
        else:
            w["entries"][0]["est"] = bad["est"]
        rid = p.frame("g.run", {"b": "b1"}, {"request": "bad", "epoch": 1, "kind": "wave", "payload": w})
        await settle()
        st, a = p.answer(rid)
        assert st == 400 and a["error"] == "malformed", (bad, st, a)
        assert gw.run_slot is None and gw.stats["queuedPayloadBytes"] == 0 and port.h.posts == [], bad
        rid = p.frame("g.run", {"b": "b1"}, run_body("good"))
        await settle()
        assert p.answer(rid)[0] == 202
    port = Scripted()
    s, c, gw, p = await bound(port)
    rid = p.frame("g.run", {"b": "b1"}, "[" * 100_000 + "0" + "]" * 100_000)
    await settle()
    assert p.answer(rid) == (400, {"error": "malformed"}) and gw.run_slot is None and gw.stats["queuedPayloadBytes"] == 0


@aio
async def test_route_failure_releases():
    """Any exception in a route: answered 500 internal, its slot and bytes released, its id closed; the next run admitted."""
    class Boom(GW):
        def _post_run(self, req, b, body):
            if body.get("request") == "boom":
                raise RuntimeError("boom")
            return super()._post_run(req, b, body)
    s = Server()
    c = Conn()
    s.paired_conn = c
    gw = Boom(s, port=Scripted())
    p = Page(gw, c)
    p.frame("g.bind", {}, {})
    await settle()
    rid = p.frame("g.run", {"b": "b1"}, run_body("boom"))
    await settle()
    assert p.answer(rid) == (500, {"error": "internal", "detail": "RuntimeError"})
    assert gw.run_slot is None and gw.stats["queuedPayloadBytes"] == 0 and not gw._state(c).open
    rid = p.frame("g.run", {"b": "b1"}, run_body("next"))
    await settle()
    assert p.answer(rid)[0] == 202


@aio
async def test_real_kernel_exit_kills_its_group():
    """astra's R762-TREE-2: a kernel that exits by itself (os._exit) with a grandchild in its group: the group is
    killed then, not only at an explicit restart or shutdown; the binding gets a new incarnation (its namespace is
    gone, §7 R4), and the next run starts a new kernel."""
    import tempfile
    s, c, gw, p = await real()
    pidfile = os.path.join(tempfile.mkdtemp(), "grandchild.pid")  # (os._exit loses the output buffer: a file instead)
    try:
        code = ("import subprocess, os\ng = subprocess.Popen(['sleep', '30'])\n"
                "open(%r, 'w').write(str(g.pid))\nos._exit(7)" % pidfile)
        p.frame("g.run", {"b": "b1"}, run_body("crash", code=code))
        await until(lambda: gw.binding.runs["crash"].outcome, 15)
        o = gw.binding.runs["crash"].outcome
        assert o["status"] == "stopped" and o["reason"] == "kernel exited", o
        with open(pidfile) as f:
            grandchild = int(f.read())
        await until(lambda: _gone(grandchild), 10)
        assert gw.worker is None and gw.binding.incarnation == 2
        p.frame("g.run", {"b": "b1"}, run_body("after", code="1 + 1"))
        await until(lambda: gw.binding.runs["after"].outcome, 30)
        assert "".join(e.get("text", "") for e in events_of(gw, "after")) == "2\n"
    finally:
        gw.shutdown()


@aio
async def test_ename_carried():
    port = Scripted(auto=False)
    s, c, gw, p = await bound(port)
    p.frame("g.run", {"b": "b1"}, run_body("r1"))
    await settle()
    port.h.on_message({"id": 1, "done": True, "ms": 2, "error": True, "ename": "KeyboardInterrupt"})
    await settle()
    assert gw.binding.runs["r1"].outcome == {"status": "error", "ms": 2, "ename": "KeyboardInterrupt"}


@aio
async def test_real_kernel_sage_and_complete():
    s, c, gw, p = await real()
    try:
        b = run_body("r1", code="2^10")
        b["payload"]["mode"] = "sage"
        p.frame("g.run", {"b": "b1"}, b)
        await until(lambda: gw.binding.runs["r1"].outcome)
        assert "".join(e.get("text", "") for e in events_of(gw, "r1")) == "1024\n"
        p.frame("g.run", {"b": "b1"}, run_body("r2", code="import math"))
        await until(lambda: gw.binding.runs["r2"].outcome)
        rid = p.frame("g.complete", {"b": "b1"}, {"epoch": 1, "code": "math.sq"})
        await until(lambda: p.answers(rid))
        st, a = p.answer(rid)
        assert st == 200 and "math.sqrt(" in a["matches"], a
    finally:
        gw.shutdown()


if __name__ == "__main__":
    for name, f in list(globals().items()):
        if name.startswith("test_") and callable(f):
            f()
            print("ok", name)
    print("all remote gateway tests passed")
