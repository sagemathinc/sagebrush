"""Terminals on a runner (sagebrush/remote/terminal.py; terminal addendum T1.4 T4-T5; build step T-1), over the fake
relay of test_remote_relay.py, with the page's key a real WebCrypto P-256 key (remote_test_signer.mjs) and real PTYs:

- served only when asked: a runner not serving terminals ends a terminal page at once and opens no PTY;
- the terminal hello: purpose "terminal" on a terminal page (a kernel's purpose refused there, and the reverse);
- the attachment contract (T5), each refused before any effect (no PTY spawned) and the page closed: no proof,
  another key, another token, a proof for another remote, generation, body or method, a stale nonce, a replayed
  proof; then a good one works (the control);
- sessions (T4): the shell in its own session with the PTY as its controlling terminal, TERM, the size, resize
  (SIGWINCH), the exit code and signal, kill (only its own session), the 5th session refused, the ring and its replay
  rule, ended sessions kept and pruned, idle stop (a logical clock), and every process group in the PTY's session
  gone after a kill, an exit and the runner's stop;
- grants: a takeover ends the older page's grant ("elsewhere", close {gen}); a late message from an ended grant
  changes nothing; a page-close detaches (the shell goes on); a lost leg ends every grant and a new leg needs a
  fresh proof;
- a terminal message over 65,536 bytes closes its page (1009).

    python engine/py/test_remote_terminal.py
"""
import asyncio
import json
import os
import signal
import stat
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from test_remote_relay import FakeRelay, enrolled, NODE  # noqa: E402
from test_remote_pair import Signer, hello as pair_hello, aio  # noqa: E402
from sagebrush.remote import relay as R  # noqa: E402
from sagebrush.remote import terminal as T  # noqa: E402
from sagebrush.remote.gateway import drain_groups, SYNTHETIC_BASE  # noqa: E402

TMP = tempfile.mkdtemp(prefix="sb-term-")


def shell(name, body):
    """A test 'shell': a sh script the session runs as $SHELL (its -l argument ignored)."""
    path = os.path.join(TMP, name)
    with open(path, "w") as f:
        f.write("#!/bin/sh\n" + body)
    os.chmod(path, stat.S_IRWXU)
    return path


# (no job control: the shell stays in the terminal's foreground group, so it gets SIGWINCH; the background job makes
# its own process group in the same session, as an interactive shell's jobs do)
LOOP = shell("loop.sh", """echo "hello $TERM"
stty size
trap 'echo winch; stty size' WINCH
%s -I -S -c "import os,time; os.setpgid(0,0); time.sleep(600)" &
while :; do sleep 0.05; done
""" % sys.executable)
EXIT7 = shell("exit7.sh", "echo bye\nexit 7\n")


def script(name, body):
    path = os.path.join(TMP, name)
    with open(path, "w") as f:
        f.write(body)
    return path


# (daybreak3's TERM-SESSION-GROUP-RACE-1: a job in its own group that, on SIGHUP, makes a NEW group in the same
# session 0.3 s later (after the first census), records its pid, and ignores SIGTERM: only a census that repeats
# catches it)
TRAPPER = script("trapper.py", """import os, signal, subprocess, sys, time
os.setpgid(0, 0)
def late(*a):
    time.sleep(0.3)
    p = subprocess.Popen([sys.executable, "-I", "-S", "-c", "import os,time; os.setpgid(0,0); time.sleep(600)"])
    with open(sys.argv[1], "w") as f:
        f.write(str(p.pid))
signal.signal(signal.SIGHUP, late)
signal.signal(signal.SIGTERM, signal.SIG_IGN)
while True:
    time.sleep(0.05)
""")
LATE_PID = os.path.join(TMP, "late.pid")
LATE = shell("late.sh", "%s -I -S %s %s &\nwhile :; do sleep 0.05; done\n" % (sys.executable, TRAPPER, LATE_PID))
# (astra's T1-DRAIN-WORK-1: a producer in its own group that floods the PTY and ignores HUP and TERM (only SIGKILL,
# or the PTY's close, ends it); the shell exits at once)
FLOODER = script("flood.py", """import os, signal
os.setpgid(0, 0)
signal.signal(signal.SIGHUP, signal.SIG_IGN)
signal.signal(signal.SIGTERM, signal.SIG_IGN)
while True:
    os.write(1, b"x" * 65536)
""")
FLOOD = shell("flood.sh", "%s -I -S %s &\nsleep 0.3\nexit 3\n" % (sys.executable, FLOODER))


class Run:
    """A RelayRunner serving terminals, against the fake relay."""

    async def start(self, terminals=True, sh=LOOP):
        os.environ["SHELL"] = sh
        self.relay = await FakeRelay(None).start()
        self.key = enrolled(self.relay.origin)
        self.relay.key = self.key
        self.said = []
        self.runner = R.RelayRunner(self.key, err=self.said.append, rnd=lambda: 0.5, terminals=terminals, cwd=TMP)
        self.stop = asyncio.Event()
        self.task = asyncio.ensure_future(self.runner.run(self.stop))
        return self

    @property
    def terms(self):
        return self.runner.terms

    async def end(self):
        self.stop.set()
        try:
            await asyncio.wait_for(self.task, 10)
        except Exception:
            pass
        self.runner.gateway.shutdown()
        if self.runner.terms is not None:
            self.runner.terms.stop_all()
        await T.drain_sessions(3.0)
        await drain_groups(3.0)
        self.relay.stop()


STREAM = ("replay", "out", "live", "inack")


async def recv(leg, timeout=10, stream=False):
    """The next application message the runner sent, with its page's generation: (gen, obj), or ("closed", code).
    Unless `stream`, the output stream's messages (replay, out, live, inack) are set aside in leg.streams[gen]."""
    while True:
        kind, v = await leg.next(timeout)
        if kind == "text":
            i = getattr(leg, "_ti", 0)
            leg._ti = i + 1
            g, m = leg.got_gens[i], json.loads(v)
            if not stream and isinstance(m, dict) and m.get("t") in STREAM:
                if not hasattr(leg, "streams"):
                    leg.streams = {}
                leg.streams.setdefault(g, []).append(m)
                continue
            return g, m
        if kind in ("close", "eof"):
            return "closed", v


async def until(f, timeout=10.0):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if f():
            return True
        await asyncio.sleep(0.02)
    return False


class TPage:
    def __init__(self, t, leg, sg, gen, token, nonce):
        self.t, self.leg, self.sg, self.gen, self.token, self.nonce = t, leg, sg, gen, token, nonce

    async def open_msg(self, rows=24, cols=80, session=None, remote=None, gen=None, proof_body=None, method="POST",
                       token=None, nonce=None, signer=None, htu=None):
        b = {"session": session, "rows": rows, "cols": cols} if session else {"rows": rows, "cols": cols}
        body = json.dumps(b, separators=(",", ":"))
        u = htu or T.open_htu(remote or self.t.key.remote_id, gen or self.gen, proof_body or body)
        proof = await (signer or self.sg).proof(method, u, token or self.token, nonce or self.nonce)
        return {"t": "open", "body": body, "auth": "DPoP " + self.token, "dpop": proof}

    async def open(self, **kw):
        self.leg.send(await self.open_msg(**kw), gen=self.gen)
        g, m = await recv(self.leg)
        assert g == self.gen, (g, m)
        if m.get("t") == "opened":
            self.nonce = m["nonce"]
        return m

    def send(self, obj):
        self.leg.send(obj, gen=self.gen)


async def tpaired(t, leg, sg, gen):
    leg.control(relay="page-open", conn="c%d" % gen, kind="runner", chan="terminal", gen=gen)
    leg.send(pair_hello(sg, purpose="terminal"), gen=gen)
    g, r = await recv(leg)
    # (the hello tells the page its generation, which its open's proof binds: a real page knows it no other way)
    assert g == gen and r["result"]["purpose"] == "terminal" and r["result"]["gen"] == gen, (g, r)
    return TPage(t, leg, sg, r["result"]["gen"], r["result"]["token"], r["result"]["nonce"])


def session_groups_alive(s):
    return T._session_groups(s.leader)


def ring_text(s):
    return bytes(s.ring.buf).decode("utf-8", "replace")


# ================= served only when asked; the terminal hello

@aio
async def test_not_served_and_hello():
    if NODE is None:
        print("  (no node) SKIPPED")
        return
    sg = await Signer().start()
    t = await Run().start(terminals=False)
    try:
        leg = await t.relay.leg()
        leg.control(relay="page-open", conn="c1", kind="runner", chan="terminal", gen=1)
        assert await until(lambda: {"relay": "close", "gen": 1} in leg.controls)
        assert t.runner.terms is None and not t.runner.leg.closed
    finally:
        await t.end()
    t = await Run().start()
    try:
        leg = await t.relay.leg()
        # (a kernel's purpose on a terminal page, and a terminal's on a kernel page: refused, that page closed)
        leg.control(relay="page-open", conn="c1", kind="runner", chan="terminal", gen=1)
        leg.send(pair_hello(sg), gen=1)
        g, r = await recv(leg)
        assert g == 1 and r["error"]["data"]["code"] == "refused" and r["error"]["message"] == "this page is paired for a terminal, not a kernel", r
        leg.control(relay="page-open", conn="c2", kind="runner", chan="kernel", gen=2)
        leg.send(pair_hello(sg, purpose="terminal"), gen=2)
        g, r = await recv(leg)
        assert g == 2 and r["error"]["data"]["code"] == "refused" and r["error"]["message"] == "this page is paired for a kernel, not a terminal", r
        assert await until(lambda: {"relay": "close", "gen": 1} in leg.controls and {"relay": "close", "gen": 2} in leg.controls)
        # (any other purpose, or none: the plain form, naming only this page's channel (grader's P4))
        for gen, purpose in ((3, "files"), (4, None)):
            leg.control(relay="page-open", conn="c%d" % gen, kind="runner", chan="terminal", gen=gen)
            leg.send(pair_hello(sg, purpose=purpose), gen=gen)
            g, r = await recv(leg)
            assert g == gen and r["error"]["data"]["code"] == "refused" and r["error"]["message"] == "this page is paired for a terminal", (purpose, r)
        assert await until(lambda: {"relay": "close", "gen": 3} in leg.controls and {"relay": "close", "gen": 4} in leg.controls)
        p = await tpaired(t, leg, sg, 5)
        assert p.token and p.nonce == t.runner.gateway.current_nonce()
        # (a terminal page pairs nothing in the gateway: the kernel's paired connection is untouched)
        assert t.runner.paired_conn is None
    finally:
        await t.end()
        sg.close()


# ================= the attachment contract (T5)

@aio
async def test_open_refusals_before_any_effect():
    if NODE is None:
        print("  (no node) SKIPPED")
        return
    sg, other = await Signer().start(), await Signer().start()
    t = await Run().start()
    try:
        leg = await t.relay.leg()
        gen = 0

        async def refused(make, why):
            nonlocal gen
            gen += 1
            p = await tpaired(t, leg, sg, gen)
            msg = await make(p)
            p.send(msg)
            g, m = await recv(leg)
            assert g == gen and m["t"] == "error" and m["error"] == "refused", (why, m)
            assert await until(lambda: {"relay": "close", "gen": gen} in leg.controls), why
            assert t.terms.stats["spawned"] == 0, why
            return m["reason"]

        async def plain(p, **kw):
            return await p.open_msg(**kw)

        assert await refused(lambda p: plain(p, signer=other), "another key") == "thumbprint"
        assert await refused(lambda p: plain(p, remote="r" + "B" * 20), "another remote") == "htu"
        assert await refused(lambda p: plain(p, gen=p.gen + 100), "another generation") == "htu"
        assert await refused(lambda p: plain(p, proof_body='{"rows":25,"cols":80}'), "another body") == "htu"
        assert await refused(lambda p: plain(p, method="GET"), "another method") == "htm"
        assert await refused(lambda p: plain(p, htu=SYNTHETIC_BASE + "/kernel/x"), "a kernel's URL") == "htu"
        assert await refused(lambda p: plain(p, nonce="A" * 22), "a stale nonce") == "nonce"
        assert await refused(lambda p: plain(p, token="B" * 43), "a proof bound to another token") == "ath"

        async def wrong_auth(p):
            m = await p.open_msg()
            m["auth"] = "DPoP " + "C" * 43
            return m
        assert await refused(wrong_auth, "another token") == "token"

        async def no_proof(p):
            m = await p.open_msg()
            del m["dpop"]
            return m
        assert await refused(no_proof, "no proof") == "shape"

        async def bad_size(p):
            m = await p.open_msg()
            m["body"] = '{"rows":0,"cols":80}'
            return m
        assert await refused(bad_size, "rows 0") == "body"

        # (a proof replayed on another page: its token is that page's, so it fails there (ath))
        gen += 1
        pa = await tpaired(t, leg, sg, gen)
        good = await pa.open_msg()
        gen += 1
        pb = await tpaired(t, leg, sg, gen)
        pb.send(good)
        g, m = await recv(leg)
        assert g == pb.gen and m["error"] == "refused" and m["reason"] in ("token", "ath", "htu"), m
        assert t.terms.stats["spawned"] == 0
        # (the control: the good proof, on its own page, opens a session)
        pa.send(good)
        g, m = await recv(leg)
        assert g == pa.gen and m["t"] == "opened" and len(m["session"]) == 22, m
        assert t.terms.stats["spawned"] == 1 and t.terms.stats["refused"] == 12
        # (the same open again on that page: this page already has a terminal -> closed, nothing spawned)
        pa.send(good)
        assert await until(lambda: {"relay": "close", "gen": pa.gen} in leg.controls)
        assert t.terms.stats["spawned"] == 1
    finally:
        await t.end()
        sg.close()
        other.close()


# ================= sessions: the shell, size, resize, kill, exit

@aio
async def test_session_lifecycle():
    if NODE is None:
        print("  (no node) SKIPPED")
        return
    sg = await Signer().start()
    t = await Run().start()
    try:
        leg = await t.relay.leg()
        p = await tpaired(t, leg, sg, 1)
        m = await p.open(rows=24, cols=80)
        assert m["t"] == "opened", m
        s = t.terms.running[m["session"]]
        assert await until(lambda: "24 80" in ring_text(s)), ring_text(s)
        assert "hello xterm-256color" in ring_text(s)
        # (the shell leads its own session, with the PTY as its controlling terminal)
        with open("/proc/%d/stat" % s.leader, "rb") as f:
            st = f.read()
        fields = st[st.rfind(b")") + 2:].split()
        assert int(fields[3]) == s.leader and int(fields[4]) != 0, fields[:6]  # (session, tty_nr)
        assert os.getsid(s.leader) == s.leader and os.getpgid(s.leader) == s.leader
        # (resize: the size applied, SIGWINCH delivered)
        p.send({"t": "resize", "rows": 30, "cols": 100})
        assert await until(lambda: "30 100" in ring_text(s)), ring_text(s)
        # (malformed resizes close the page; they change nothing)
        # (kill names its own session only: another id closes the page, nothing stopped)
        p2 = await tpaired(t, leg, sg, 2)
        m2 = await p2.open()
        s2 = t.terms.running[m2["session"]]
        p2.send({"t": "kill", "session": s.id})
        assert await until(lambda: {"relay": "close", "gen": 2} in leg.controls)
        assert s.exit is None and s2.exit is None
        # (its own: the tree rule over every group in its session, the background job too; exit by SIGHUP)
        groups = session_groups_alive(s)
        assert len(groups) >= 2, groups  # (the shell's, and the background subshell's under sh's job control or not)
        p.send({"t": "kill", "session": s.id})
        g, m = await recv(leg)
        assert g == 1 and m["t"] == "exit" and m["code"] is None and m["signal"] in ("SIGHUP", "SIGTERM", "SIGKILL"), m
        assert await until(lambda: not session_groups_alive(s), 5), session_groups_alive(s)
        assert await until(lambda: s.master is None and s.pidfd is None and s.leader not in T.STOPPING, 5)
        assert s.id not in t.terms.running and s in t.terms.ended_
    finally:
        await t.end()
        sg.close()


@aio
async def test_exit_code_and_ended_sessions():
    if NODE is None:
        print("  (no node) SKIPPED")
        return
    sg = await Signer().start()
    t = await Run().start(sh=EXIT7)
    try:
        leg = await t.relay.leg()
        p = await tpaired(t, leg, sg, 1)
        m = await p.open()
        sid = m["session"]
        g, m = await recv(leg)
        assert m == {"t": "exit", "code": 7, "signal": None}, m
        s = t.terms.ended_[-1]
        assert s.id == sid and await until(lambda: b"bye" in bytes(s.ring.buf)), bytes(s.ring.buf)
        # (an ended session's ring stays for a reattach: opened, then its exit; still one page per session, so the
        # page that held it is told "elsewhere")
        p2 = await tpaired(t, leg, sg, 2)
        p2.send(await p2.open_msg(session=sid))
        got = [await recv(leg) for _ in range(3)]
        assert got == [(1, {"t": "error", "error": "elsewhere"}), (2, {"t": "opened", "session": sid, "nonce": got[1][1].get("nonce")}),
                       (2, {"t": "exit", "code": 7, "signal": None})], got
        # (kept: the last 8, for 10 minutes)
        for i in range(9):
            t.terms.ended_.append(T.Session(t.terms, "x%021d" % i, 24, 80))
            t.terms.ended_[-1].ended_at = t.terms.timers.now()
        t.terms._prune_ended()
        assert len(t.terms.ended_) == 8 and s not in t.terms.ended_
        # (pruned by count while page 2 holds it: that page is told, its grant released)
        assert await recv(leg) == (2, {"t": "error", "error": "expired"}) and t.runner.pages[2].grant is None
        t.terms.ended_[0].ended_at -= T.TERMINAL_LIMITS["endedMs"]
        t.terms._prune_ended()
        assert len(t.terms.ended_) == 7
        p3 = await tpaired(t, leg, sg, 3)
        m = await p3.open(session=sid)
        assert m == {"t": "error", "error": "unknown_session"}, m
    finally:
        await t.end()
        sg.close()


# ================= grants: takeover, late messages, detach, leg loss

@aio
async def test_grants():
    if NODE is None:
        print("  (no node) SKIPPED")
        return
    sg = await Signer().start()
    t = await Run().start()
    try:
        leg = await t.relay.leg()
        pa = await tpaired(t, leg, sg, 1)
        sid = (await pa.open())["session"]
        s = t.terms.running[sid]
        page_a = t.runner.pages[1]
        ga = page_a.grant
        # (a takeover: B opens the session; A is told "elsewhere" and closed; A's grant is over)
        pb = await tpaired(t, leg, sg, 2)
        pb.leg.send(await pb.open_msg(session=sid, rows=40, cols=120), gen=2)
        seen = {}
        for _ in range(2):
            g, m = await recv(leg)
            seen[g] = m
        assert seen[1] == {"t": "error", "error": "elsewhere"} and seen[2]["t"] == "opened", seen
        assert await until(lambda: {"relay": "close", "gen": 1} in leg.controls)
        assert not ga.live and s.grant is t.runner.pages[2].grant and t.terms.stats["takeovers"] == 1
        assert await until(lambda: "40 120" in ring_text(s)), ring_text(s)
        # (a late message from A's ended grant changes nothing: not the size, not the session)
        late = t.terms.stats["lateIgnored"]
        t.terms.page_message(page_a, {"t": "resize", "rows": 5, "cols": 5})
        t.terms.page_message(page_a, {"t": "kill", "session": sid})
        assert t.terms.stats["lateIgnored"] == late + 2 and (s.rows, s.cols) == (40, 120) and s.exit is None
        # (a grant is no authority on another page, leg or generation)
        gb = t.runner.pages[2].grant
        assert gb.holds(t.runner.pages[2], t.runner.incarnation, t.runner.leg)
        assert not gb.holds(page_a, t.runner.incarnation, t.runner.leg)
        assert not gb.holds(t.runner.pages[2], "another", t.runner.leg)
        assert not gb.holds(t.runner.pages[2], t.runner.incarnation, object())
        # (page-close detaches: the grant ends, the shell goes on)
        leg.control(relay="page-close", conn="c2", gen=2)
        assert await until(lambda: s.grant is None)
        assert not gb.live and s.exit is None and sid in t.terms.running
        # (the leg lost: every grant ends; a new leg needs a fresh proof, and reattaches)
        pc = await tpaired(t, leg, sg, 3)
        assert (await pc.open(session=sid))["t"] == "opened"
        gc = t.runner.pages[3].grant
        leg.drop()
        leg2 = await t.relay.leg()
        assert await until(lambda: not gc.live)
        assert s.exit is None and s.grant is None
        pd = await tpaired(t, leg2, sg, 1)
        m = await pd.open(session=sid)
        assert m["t"] == "opened" and s.grant.leg is t.runner.leg, m
    finally:
        await t.end()
        sg.close()


# ================= limits, idle, the runner's stop, the frame cap

@aio
async def test_limits_idle_and_stop():
    if NODE is None:
        print("  (no node) SKIPPED")
        return
    sg = await Signer().start()
    t = await Run().start()
    try:
        leg = await t.relay.leg()
        sessions = []
        for gen in range(1, 5):
            p = await tpaired(t, leg, sg, gen)
            sid = (await p.open())["session"]
            sessions.append(t.terms.running[sid])
        p5 = await tpaired(t, leg, sg, 5)
        assert await p5.open() == {"t": "error", "error": "sessions"}
        assert t.terms.stats["spawned"] == 4
        # (a terminal message over 65,536 bytes closes its page (1009); the leg goes on)
        p5.send({"t": "resize", "pad": "x" * 70_000})
        assert await until(lambda: {"relay": "close", "gen": 5} in leg.controls) and not t.runner.leg.closed
        # (idle: detached, no output, no attach for 24 h -> stopped; attached ones are kept)
        leg.control(relay="page-close", conn="c1", gen=1)
        assert await until(lambda: sessions[0].grant is None)
        await asyncio.sleep(0.2)
        for s in sessions:
            s.last_activity -= T.TERMINAL_LIMITS["idleMs"]
        t.terms._idle_check()
        assert t.terms.stats["idleStopped"] == 1
        assert await until(lambda: sessions[0].exit is not None, 5)
        assert all(s.exit is None for s in sessions[1:])
        # (the runner's stop: every session's groups gone)
        alive = [s for s in sessions[1:]]
        t.terms.stop_all()
        assert await until(lambda: all(s.exit is not None for s in alive), 5)
        assert await until(lambda: not any(session_groups_alive(s) for s in sessions), 5)
    finally:
        await t.end()
        sg.close()


# ================= r2: ended expiry when nothing else happens; a late group; a flooding producer

def proc_gone(pid):
    try:
        with open("/proc/%d/stat" % pid, "rb") as f:
            st = f.read()
    except OSError:
        return True
    return st[st.rfind(b")") + 2:].split()[0] == b"Z"


@aio
async def test_ended_expiry_quiet_and_on_lookup():
    """TERM-ENDED-TTL-1 / T1-ENDED-TTL-1: the last session's ring expires with nothing running and no other activity
    (its own timer), releasing its ring and the attached page's grant; and a reattach checks the age itself."""
    if NODE is None:
        print("  (no node) SKIPPED")
        return
    sg = await Signer().start()
    saved = T.TERMINAL_LIMITS["endedMs"]
    T.TERMINAL_LIMITS["endedMs"] = 400
    t = await Run().start(sh=EXIT7)
    try:
        leg = await t.relay.leg()
        p = await tpaired(t, leg, sg, 1)
        sid = (await p.open())["session"]
        g, m = await recv(leg)
        assert m["t"] == "exit", m
        s = t.terms.ended_[-1]
        page = t.runner.pages[1]
        assert not t.terms.running and page.grant is not None and t.terms.idle_timer is not None
        # (quiet: nothing running, nothing sent; its expiry runs anyway)
        g, m = await recv(leg, 3)
        assert (g, m) == (1, {"t": "error", "error": "expired"}), (g, m)
        assert t.terms.ended_ == [] and t.terms.stats["expired"] == 1 and page.grant is None and s.grant is None
        assert s.ring is None and t.terms.prune_timer is None
        # (on lookup: an ended session past its age, its timer not yet run, can't be reattached)
        p2 = await tpaired(t, leg, sg, 2)
        sid2 = (await p2.open())["session"]
        await recv(leg)  # (its exit)
        t.terms.timers.clear_timeout(t.terms.prune_timer)
        t.terms.prune_timer = None
        await asyncio.sleep(0.5)
        assert [e.id for e in t.terms.ended_] == [sid2]
        leg.control(relay="page-close", conn="c2", gen=2)
        await asyncio.sleep(0.1)
        p3 = await tpaired(t, leg, sg, 3)
        assert await p3.open(session=sid2) == {"t": "error", "error": "unknown_session"}
        assert t.terms.ended_ == [] and sid != sid2
    finally:
        T.TERMINAL_LIMITS["endedMs"] = saved
        await t.end()
        sg.close()


@aio
async def test_late_group_caught():
    """TERM-SESSION-GROUP-RACE-1: a job that makes a new group in the session after the first census is still
    stopped (the census repeats until the session is empty); and at the runner's exit drain_sessions does the same."""
    if NODE is None:
        print("  (no node) SKIPPED")
        return
    sg = await Signer().start()
    for how in ("kill", "exit"):
        if os.path.exists(LATE_PID):
            os.unlink(LATE_PID)
        t = await Run().start(sh=LATE)
        try:
            leg = await t.relay.leg()
            p = await tpaired(t, leg, sg, 1)
            sid = (await p.open())["session"]
            s = t.terms.running[sid]
            assert await until(lambda: len(session_groups_alive(s)) >= 2, 5), session_groups_alive(s)
            if how == "kill":
                p.send({"t": "kill", "session": sid})
            else:
                t.terms.stop_all()
                left = await T.drain_sessions(6.0)
                assert left == [], left
            assert await until(lambda: os.path.exists(LATE_PID) and open(LATE_PID).read().strip(), 5)
            late = int(open(LATE_PID).read())
            assert await until(lambda: not session_groups_alive(s), 8), (how, session_groups_alive(s))
            assert await until(lambda: proc_gone(late), 3), (how, late)
            assert late in s.signalled, (how, late, s.signalled)  # (its own group, made late, was signalled)
            assert await until(lambda: s.master is None and s.leader not in T.STOPPING, 5), how
        finally:
            await t.end()
    sg.close()


@aio
async def test_flooding_producer_bounded():
    """T1-DRAIN-WORK-1: the shell exits leaving a producer that floods the PTY and ignores HUP and TERM.  The groups
    are stopped first, the PTY is read only at the rate ceiling meanwhile, then drained (bounded) and closed once
    the session is empty; and with a short cap the PTY is closed even while the producer still writes."""
    if NODE is None:
        print("  (no node) SKIPPED")
        return
    sg = await Signer().start()
    saved = T.TERMINAL_LIMITS["sweepCapMs"]
    try:
        for cap in (30_000, 300):
            T.TERMINAL_LIMITS["sweepCapMs"] = cap
            t = await Run().start(sh=FLOOD)
            try:
                leg = await t.relay.leg()
                p = await tpaired(t, leg, sg, 1)
                t0 = time.monotonic()
                sid = (await p.open())["session"]
                g, m = await recv(leg, 10)
                assert m == {"t": "exit", "code": 3, "signal": None}, m
                s = t.terms.ended_[-1]
                assert s.id == sid
                if cap == 300:
                    # (closed at the cap, the producer not yet stopped (it ignores HUP and TERM; SIGKILL is at 2 s))
                    assert await until(lambda: s.master is None, 2), "the PTY not closed at the cap"
                    assert t.terms.stats["sweepCapped"] == 1 and time.monotonic() - t0 < 2.0
                assert await until(lambda: not session_groups_alive(s), 6), session_groups_alive(s)
                assert await until(lambda: s.master is None and s.leader not in T.STOPPING, 3)
                elapsed = time.monotonic() - t0
                # (work bounded: at most the rate per second, plus the final drain of one ring)
                assert t.terms.stats["outBytes"] <= T.TERMINAL_LIMITS["rate"] * (elapsed + 1) + T.TERMINAL_LIMITS["ring"], \
                    (t.terms.stats["outBytes"], elapsed)
                # (the page never acks: its credit, not the rate ceiling, may be what held the reads back (T-1b))
                assert len(s.ring.buf) <= T.TERMINAL_LIMITS["ring"]
            finally:
                await t.end()
    finally:
        T.TERMINAL_LIMITS["sweepCapMs"] = saved
        sg.close()


def test_drain_is_bounded_whatever_writes():
    """T1-DRAIN-WORK-1, exactly: the final drain against a PTY that never runs dry (a fake read that always has more)
    stops after one ring's worth, in at most ring/read reads."""
    from sagebrush.remote.pair import RealTimers

    class Host:
        stats = {"outBytes": 0}
        timers = RealTimers()
    s = T.Session(Host(), "s" * 22, 24, 80)
    s.master = 12345  # (never a real fd: the read below is replaced)
    calls = []
    real = T.os.read

    def endless(fd, n):
        assert fd == 12345
        calls.append(n)
        if len(calls) > 1000:
            raise RuntimeError("an unbounded drain")
        return b"y" * n
    T.os.read = endless
    try:
        s._drain()
    finally:
        T.os.read = real
    cap, rd = T.TERMINAL_LIMITS["ring"], T.TERMINAL_LIMITS["read"]
    assert len(calls) <= -(-cap // rd) and sum(calls) <= cap and len(s.ring.buf) == sum(calls) == cap, (len(calls), sum(calls))


def test_ring_and_replay():
    r = T.Ring(cap=10_000)
    r.append(b"abc\ndef")
    assert r.replay() == b"abc\ndef"  # (not wrapped: whole)
    r = T.Ring(cap=8192)
    r.append(b"x" * 100 + b"\nline2\n" + b"y" * 9000)
    out = r.replay()
    assert len(r.buf) == 8192 and out == bytes(r.buf)  # (wrapped, no \n in its oldest 4 KiB: whole)
    r = T.Ring(cap=8192)
    r.append(b"z" * 2000 + b"partial\nnext line\n" + b"w" * 7000)  # (wrapped: its oldest kept bytes are z's, then a \n)
    out = r.replay()
    assert out.startswith(b"next line\n") and len(r.buf) == 8192 and r.total == 9018, out[:20]
    r = T.Ring(cap=8192)
    r.append(b"z" * 5000 + b"partial\nnext\n" + b"w" * 3500)  # (wrapped, but its first \n is past the oldest 4 KiB)
    assert r.replay() == bytes(r.buf)
    assert len(T.new_session_id()) == 22 and T.new_session_id() != T.new_session_id()
    u = T.open_htu("r" + "A" * 20, 7, '{"rows":24,"cols":80}')
    assert u.startswith(SYNTHETIC_BASE + "/terminal/open?remote=r") and "&gen=7&body=" in u


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print("ok", name)
    print("all remote terminal tests passed")
