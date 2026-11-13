"""`sagebrush remote --serve-agents`: the agent channel (sagebrush/remote/relay.py's agent pages and
sagebrush/remote/agent_child.py), against test_remote_relay.py's fake relay, with the page's key a real WebCrypto P-256
key (remote_test_signer.mjs) and the agent a scripted fake (remote_agent_fake.py):

- the flag off: an agent page is refused, saying how to start it;
- the hello: signed by the page's key over its own bytes; its result (maxFrameBytes, a resume secret when asked);
- every later message: signed over its exact payload, this runner, this page's generation; forwarded byte for byte;
  refused before the child sees it when the body, the key, the generation or the jti is wrong;
- the child's life: one per runner; detached on page close and kept for the grace; taken over with the secret;
  refused or replaced without it; ended by unpair (the whole group, the SIGKILL fallback), the grace, its own exit;
  Stop is SIGINT to its group;
- caps: a page message over the channel's cap closes that page only; a kernel page is held to its own cap; a child
  line over the cap stops the child; a line that could pass for a relay control stops it;
- the child's environment (the runner's settings and proxy credentials out), its stderr (0600 in 0700, rotated,
  redacted, never to the page), no shell.

    python engine/py/test_remote_agent.py
"""
import asyncio
import base64
import hashlib
import json
import os
import secrets
import signal
import stat
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from sagebrush.remote import agent_child as A  # noqa: E402
from sagebrush.remote import relay as R  # noqa: E402
from sagebrush.remote.gateway import _group_members, drain_groups  # noqa: E402
from test_remote_pair import Signer, aio  # noqa: E402
from test_remote_relay import FakeRelay, enrolled  # noqa: E402

FAKE = os.path.join(HERE, "remote_agent_fake.py")
TMP = tempfile.mkdtemp(prefix="sb-agent-test-")


def b64u(b):
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode("ascii")


def sha(text):
    return b64u(hashlib.sha256(text.encode("utf-8")).digest())


def compact(obj):
    return json.dumps(obj, separators=(",", ":"))


class Clock:
    def __init__(self):
        self.off = 0
        self.frozen = None  # (a row that tests a time edge holds the clock still)

    def __call__(self):
        if self.frozen is not None:
            return self.frozen
        return int(time.time() * 1000) + self.off


class Run:
    """A runner serving agent pages, against a fake relay, in this process."""

    async def start(self, fake_args=("echo",), agents=True, grace_ms=60_000, cmd=None, env=None, kinds=None, agent_cmds=None):
        """kinds: [(name, fake args)], each kind's fake recording to its own log (kind_lines(name)), instead of one;
        agent_cmds: [(name, argv)], kinds with any command."""
        self.relay = await FakeRelay(None).start()
        self.key = enrolled(self.relay.origin)
        self.relay.key = self.key
        self.said = []
        self.dir = tempfile.mkdtemp(dir=TMP)
        self.fake_log = os.path.join(self.dir, "fake.log")
        os.environ["FAKE_LOG"] = self.fake_log
        if env:
            os.environ.update(env)
        self.log = A.AgentLog(os.path.join(self.dir, "state"))
        self.clock = Clock()
        self.kind_logs = {name: os.path.join(self.dir, "fake-%s.log" % name) for name, _ in kinds or ()}
        cmds = [(name, ["env", "FAKE_LOG=" + self.kind_logs[name], sys.executable, FAKE, *args]) for name, args in kinds or ()]
        cmds += list(agent_cmds or ())
        self.runner = R.RelayRunner(self.key, err=self.said.append, rnd=lambda: 0.5, agents=agents,
                                    agent_cmd=cmd or [sys.executable, FAKE, *fake_args], agent_grace_ms=grace_ms,
                                    agent_log=self.log, now_ms=self.clock, agent_cmds=cmds or None)
        self.stop = asyncio.Event()
        self.task = asyncio.ensure_future(self.runner.run(self.stop))
        self.leg = await self.relay.leg()
        self.gen = 0
        return self

    def fake_lines(self):
        try:
            with open(self.fake_log) as f:
                return [line[:-1] for line in f if line != "READY\n" and not line.startswith("RELAY ")]
        except FileNotFoundError:
            return []

    def relay_lines(self):
        """The runner's own lines the child got, in order, parsed."""
        try:
            with open(self.fake_log) as f:
                return [json.loads(line[6:]) for line in f if line.startswith("RELAY ")]
        except FileNotFoundError:
            return []

    def child_lines(self):
        """Everything the child got, in order: the runner's lines as dicts, the page's messages as text."""
        try:
            with open(self.fake_log) as f:
                return [json.loads(line[6:-1]) if line.startswith("RELAY ") else line[:-1] for line in f if line != "READY\n"]
        except FileNotFoundError:
            return []

    def kind_lines(self, name):
        """The page messages one kind's fake got, in order."""
        try:
            with open(self.kind_logs[name]) as f:
                return [line[:-1] for line in f if line != "READY\n" and not line.startswith("RELAY ")]
        except FileNotFoundError:
            return []

    def kind_ready(self, name):
        try:
            with open(self.kind_logs[name]) as f:
                return "READY\n" in f.readlines()
        except FileNotFoundError:
            return False

    def ready(self):
        try:
            with open(self.fake_log) as f:
                return "READY\n" in f.readlines()
        except FileNotFoundError:
            return False

    async def end(self):
        self.runner.stop_agent("the test ended")
        self.stop.set()
        try:
            await asyncio.wait_for(self.task, 10)
        except Exception:
            pass
        self.runner.gateway.shutdown()
        await drain_groups(3.0)
        self.relay.stop()


class AgentPage:
    """One agent page, played over the fake relay's leg: its own key, generation, token and nonce."""

    def __init__(self, run, signer):
        self.run, self.leg, self.sg = run, run.leg, signer
        self.token = self.nonce = None

    async def proof(self, htu, token, nonce=None, iat=None, jti=None):
        h = b64u(json.dumps({"typ": "dpop+jwt", "alg": "ES256", "jwk": self.sg.jwk}).encode())
        c = {"jti": jti or b64u(secrets.token_bytes(24)), "htm": "AGENT", "htu": htu,
             "iat": iat if iat is not None else self.run.clock() // 1000, "ath": b64u(hashlib.sha256(token.encode()).digest())}
        if nonce is not None:
            c["nonce"] = nonce
        cb = b64u(json.dumps(c).encode())
        return "%s.%s.%s" % (h, cb, await self.sg.sign(h + "." + cb))

    def page_open(self):
        self.run.gen += 1
        self.gen = self.run.gen
        self.leg.control(relay="page-open", conn="c%d" % self.gen, kind="runner", chan="agent", gen=self.gen)

    async def hello_frame(self, **params):
        p = {"protocol": 1, "purpose": "agent", "jwk": self.sg.jwk, "jkt": self.sg.jkt}
        p.update(params)
        m = compact({"jsonrpc": "2.0", "id": "p1", "method": "hello", "params": p})
        proof = await self.proof("sb-agent-hello:%s#%s" % (self.run.key.remote_id, sha(m)), "")
        return {"a": "DPoP ", "p": proof, "m": m}

    async def msg_frame(self, payload):
        htu = "sb-agent:%s/%s/%d#%s" % (self.run.key.remote_id, self.run.runner.incarnation, self.gen, sha(payload))
        return {"a": "DPoP " + self.token, "p": await self.proof(htu, self.token, self.nonce), "m": payload}

    async def open(self, **params):
        self.page_open()
        self.leg.send(await self.hello_frame(**params), gen=self.gen)
        return await self.answer()

    async def answer(self, seen=None):
        """The hello's answer; `seen`, if given, gets every other message read before it."""
        while True:  # (the fake relay plays every page on one leg: another page's notice may come first)
            r = await self.leg.json()
            if r.get("id") == "p1" or "closed" in r:
                break
            if seen is not None:
                seen.append(r)
        if "result" in r:
            self.token, self.nonce = r["result"]["token"], r["result"]["nonce"]
            self.result = r["result"]
        return r

    async def send(self, payload, gen=None, body=None, proof=None, iat=None, jti=None, signer=None):
        """payload: the exact text signed; body: the text actually sent (a tampered payload), if different."""
        g = self.gen if gen is None else gen
        htu = "sb-agent:%s/%s/%d#%s" % (self.run.key.remote_id, self.run.runner.incarnation, g, sha(payload))
        if proof is None:
            page = self if signer is None else AgentPage(self.run, signer)
            proof = await page.proof(htu, self.token, self.nonce, iat=iat, jti=jti)
        self.leg.send({"a": "DPoP " + self.token, "p": proof, "m": payload if body is None else body}, gen=self.gen)
        return proof


async def until(cond, timeout=10.0, what="the condition"):
    end = time.monotonic() + timeout
    while not cond():
        assert time.monotonic() < end, "timed out waiting for " + what
        await asyncio.sleep(0.02)


def group_gone(pgid):
    """No live member of the group (a zombie awaiting its reaper is gone in every way that matters; gateway's own
    census leaves zombies out too)."""
    return not _group_members(pgid)


def closed_gens(run):
    return [c["gen"] for c in run.leg.controls if c.get("relay") == "close"]


async def signer():
    return await Signer().start()


# ================= the flag, the hello, signed messages

@aio
async def test_flag_off_refuses_with_how_to_start():
    run = await Run().start(agents=False)
    sg = await signer()
    try:
        r = await AgentPage(run, sg).open()
        assert "error" in r and r["error"]["message"].startswith("This computer's runner doesn't offer agent pages. Start it with: sagebrush remote --serve-agents"), r
        assert run.runner.channels() == ["kernel", "terminal"]
    finally:
        sg.close()
        await run.end()


@aio
async def test_hello_and_exact_bytes_both_ways():
    run = await Run().start()
    sg = await signer()
    try:
        pg = AgentPage(run, sg)
        r = await pg.open(remember=True)
        res = r["result"]
        assert res["purpose"] == "agent" and res["maxFrameBytes"] == A.AGENT_ADVERTISED == 4 * 1024 * 1024 - 4096 and res["gen"] == pg.gen, res
        assert isinstance(res["resume"], str) and res["resumed"] is False and "agent" in res["channels"], res
        assert res["agent"] == "default" and res["agents"] == ["default"], res  # (--agent-cmd: the one kind "default")
        # (only the secret's SHA-256 is held, bound to the page key)
        assert run.runner.agent_resume == hashlib.sha256(res["resume"].encode()).digest() and run.runner.agent_resume_jkt == sg.jkt
        payload = '{"jsonrpc":"2.0","method":"chat.message","params":{"text":"caf\\u00e9 2^32+1"}}'
        await pg.send(payload)
        echo = await run.leg.json()
        assert echo == {"echo": payload}, echo
        await until(lambda: payload in run.fake_lines(), what="the child's record")
        assert run.fake_lines()[-1] == payload  # (byte for byte: the escape kept, never re-serialized)
    finally:
        sg.close()
        await run.end()


@aio
async def test_bad_proofs_never_reach_the_child():
    run = await Run().start()
    sg, other = await signer(), await signer()
    try:
        pg = AgentPage(run, sg)
        await pg.open()
        good = '{"n":1}'
        cases = []
        await pg.send(good, body='{"n":2}')                                 # one byte changed after signing
        cases.append("body")
        await pg.send(good, body='{ "n":1}')                                # the same JSON, other bytes
        cases.append("bytes")
        await pg.send(good, signer=other)                                   # another key
        cases.append("key")
        await pg.send(good, gen=pg.gen + 7)                                 # another generation
        cases.append("generation")
        jti = b64u(secrets.token_bytes(24))
        await pg.send('{"n":3}', jti=jti)                                   # accepted ...
        await pg.send('{"n":3}', jti=jti)                                   # ... and replayed
        cases.append("replay")
        notices = []
        while len(notices) < len(cases):
            m = await run.leg.json()
            if m.get("method") == "agent.notice":
                notices.append(m["params"]["text"])
        assert all(n.startswith("a message this runner can't verify") for n in notices), notices
        await asyncio.sleep(0.3)
        assert run.fake_lines() == ['{"n":3}'], run.fake_lines()  # (only the one good message, once)
    finally:
        sg.close()
        other.close()
        await run.end()


@aio
async def test_iat_window_both_edges():
    run = await Run().start()
    sg = await signer()
    try:
        pg = AgentPage(run, sg)
        await pg.open()
        # (held still: a second ticking between reading now and the runner's check would move both edges by one)
        run.clock.frozen = run.clock()
        now = run.clock() // 1000
        for i, (iat, ok) in enumerate([(now - 60, True), (now - 61, False), (now + 5, True), (now + 6, False)]):
            await pg.send('{"i":%d}' % i, iat=iat)
            if not ok:
                m = await run.leg.json()
                assert m.get("method") == "agent.notice" and "iat" in m["params"]["text"], (iat - now, m)
        await asyncio.sleep(0.3)
        assert run.fake_lines() == ['{"i":0}', '{"i":2}'], run.fake_lines()
    finally:
        sg.close()
        await run.end()


@aio
async def test_jti_store_full_then_slow_down():
    run = await Run().start(fake_args=())
    sg = await signer()
    try:
        pg = AgentPage(run, sg)
        await pg.open()
        page = run.runner.agent.page
        first = None
        for i in range(4096):  # (planted directly: 4096 signatures through the node signer is minutes)
            j = "j%022d" % i
            page.jtis[j] = run.clock()
            first = first or j
        await pg.send('{"x":1}')
        m = await run.leg.json()
        assert m == {"jsonrpc": "2.0", "method": "agent.notice", "params": {"text": "Too many messages at once. Wait a moment, then try again."}}, m
        assert first in page.jtis and len(page.jtis) == 4096  # (no live jti evicted)
        run.clock.off = 121_000
        await pg.send('{"x":2}')
        await until(lambda: '{"x":2}' in run.fake_lines(), what="the message after 120 s")
    finally:
        sg.close()
        await run.end()


# ================= the child's life

@aio
async def test_unpair_ends_the_whole_group():
    for extra in ((), ("ignore-term",)):
        run = await Run().start(fake_args=("grandchild",) + extra)
        sg = await signer()
        try:
            pg = AgentPage(run, sg)
            await pg.open()
            await until(lambda: any(line.startswith("GC ") for line in run.fake_lines()), what="the grandchild")
            pgid = run.runner.agent.pgid
            await pg.send('{"unpair":true}')
            t0 = time.monotonic()
            await until(lambda: group_gone(pgid), timeout=4.0, what="the group to end")
            assert time.monotonic() - t0 < 3.5, extra
            assert run.runner.agent is None and pg.gen in closed_gens(run)
        finally:
            sg.close()
            await run.end()


@aio
async def test_stop_is_sigint_to_the_group():
    run = await Run().start(fake_args=("keep-int", "grandchild"))
    sg = await signer()
    try:
        pg = AgentPage(run, sg)
        await pg.open()
        await until(lambda: any(line.startswith("GC ") for line in run.fake_lines()), what="the grandchild")
        a = run.runner.agent
        await pg.send('{"interrupt":true}')
        await until(lambda: "SIGINT" in run.fake_lines(), what="SIGINT at the child")
        await asyncio.sleep(0.3)
        assert not a.ended and not group_gone(a.pgid), "Stop killed the agent"
    finally:
        sg.close()
        await run.end()


@aio
async def test_detach_reattach_takeover_and_refusals():
    run = await Run().start(grace_ms=600)
    sg = await signer()
    try:
        p1 = AgentPage(run, sg)
        secret = (await p1.open(remember=True))["result"]["resume"]
        await until(lambda: run.runner.agent.pgid is not None, what="the child")
        pid = run.runner.agent.pgid
        # (a second page without the secret, while p1 is attached: refused, p1 untouched)
        p2 = AgentPage(run, sg)
        r = await p2.open()
        assert r["error"]["message"] == "The agent is already open in another page or tab. Close it there, then connect again here.", r
        # (a takeover with the secret, the old page's message in flight behind it: the old page told, the same
        # child, and the old message has no effect; the frames' order is forced by writing them together)
        p3 = AgentPage(run, sg)
        late = await p1.msg_frame('{"old":1}')
        p3.page_open()
        run.leg.send(await p3.hello_frame(resume=secret), gen=p3.gen)
        run.leg.send(late, gen=p1.gen)
        seen = []
        r = await p3.answer(seen)
        assert r["result"]["resumed"] is True and run.runner.agent.pgid == pid, r
        told = [m["params"]["text"] for m in seen if m.get("method") == "agent.ended"]
        assert told == ["This chat is now open in another tab. Open it here again to bring it back."], seen
        await until(lambda: p1.gen in closed_gens(run), what="the old page's close")
        await asyncio.sleep(0.3)
        assert '{"old":1}' not in run.fake_lines()
        # (detached, then back within the grace: the same child)
        run.leg.control(relay="page-close", conn="c%d" % p3.gen, gen=p3.gen)
        await asyncio.sleep(0.1)
        assert run.runner.agent.page is None
        p4 = AgentPage(run, sg)
        r = await p4.open(resume=secret)
        assert r["result"]["resumed"] is True and run.runner.agent.pgid == pid
        # (detached again: a page with a wrong secret is refused, and doesn't extend the grace)
        run.leg.control(relay="page-close", conn="c%d" % p4.gen, gen=p4.gen)
        await asyncio.sleep(0.05)
        r = await AgentPage(run, sg).open(resume="x" * 43)
        assert r["error"]["message"] == "This agent session has ended. Connect again to start a new one.", r
        r = await AgentPage(run, sg).open()
        assert r["error"]["message"] == "A chat is running on this runner. Reopen it from its tab, or start a new chat here, which ends that one.", r
        await until(lambda: group_gone(pid), timeout=4.0, what="the grace to end the child")
        # (after the grace: a new child)
        r = await AgentPage(run, sg).open()
        assert "result" in r
        await until(lambda: run.runner.agent is not None and run.runner.agent.pgid not in (None, pid), what="a new child")
    finally:
        sg.close()
        await run.end()


@aio
async def test_takeover_races_forced_order():
    """The old page's message and Stop around a takeover, each in both orders (frames written together, in order)."""
    for first in ("old", "new"):
        run = await Run().start(fake_args=("keep-int",))
        sg = await signer()
        try:
            p1 = AgentPage(run, sg)
            secret = (await p1.open(remember=True))["result"]["resume"]
            await until(lambda: run.ready(), what="the child, its handlers set")
            msg = await p1.msg_frame('{"from":"old"}')
            stop = await p1.msg_frame('{"interrupt":true}')
            p2 = AgentPage(run, sg)
            p2.page_open()
            hello2 = await p2.hello_frame(resume=secret)
            if first == "old":
                run.leg.send(msg, gen=p1.gen)
                run.leg.send(stop, gen=p1.gen)
                run.leg.send(hello2, gen=p2.gen)
            else:
                run.leg.send(hello2, gen=p2.gen)
                run.leg.send(msg, gen=p1.gen)
                run.leg.send(stop, gen=p1.gen)
            r = await p2.answer()
            assert r["result"]["resumed"] is True, r
            await asyncio.sleep(0.5)
            lines = run.fake_lines()
            got = run.child_lines()
            if first == "old":
                # (the old page's Stop is the runner's own act, at once; its message is old-binding work: it reached the
                # child before the detached line, or, not yet started on stdin at the takeover, it was dropped)
                assert "SIGINT" in lines, (first, lines)
                cut = next(i for i, x in enumerate(got) if isinstance(x, dict) and x.get("relay", {}).get("page") == "detached")
                if '{"from":"old"}' in got:
                    assert got.index('{"from":"old"}') < cut, (first, got)
                else:
                    assert run.runner.agent.stats["droppedAtDetach"] == 1, (first, run.runner.agent.stats)
            else:
                assert '{"from":"old"}' not in lines and "SIGINT" not in lines, (first, lines)
        finally:
            sg.close()
            await run.end()


@aio
async def test_fresh_chat_ends_the_detached_one():
    run = await Run().start()
    sg = await signer()
    try:
        p1 = AgentPage(run, sg)
        await p1.open()
        await until(lambda: run.runner.agent.pgid is not None, what="the child")
        pid = run.runner.agent.pgid
        run.leg.control(relay="page-close", conn="c%d" % p1.gen, gen=p1.gen)
        await asyncio.sleep(0.05)
        r = await AgentPage(run, sg).open(fresh=True)
        assert "result" in r
        await until(lambda: group_gone(pid), timeout=4.0, what="the old child to end")
    finally:
        sg.close()
        await run.end()


@aio
async def test_child_exit_tells_the_page_and_a_new_page_gets_a_new_child():
    run = await Run().start(fake_args=("exit", "3"))
    sg = await signer()
    try:
        pg = AgentPage(run, sg)
        await pg.open()
        await until(lambda: run.runner.agent.pgid is not None, what="the child")
        pid = run.runner.agent.pgid
        await pg.send('{"go":1}')
        while True:
            m = await run.leg.json()
            if m.get("method") == "agent.ended":
                break
        assert m["params"]["text"] == "The agent stopped (exit code 3). Connect again to restart it.", m
        await until(lambda: run.runner.agent is None, what="the runner to forget it")
        await AgentPage(run, sg).open()
        await until(lambda: run.runner.agent is not None and run.runner.agent.pgid not in (None, pid), what="a new child")
    finally:
        sg.close()
        await run.end()


@aio
async def test_detached_requests_answered_at_once():
    run = await Run().start(fake_args=("request",))
    sg = await signer()
    try:
        # (no page at the request's moment: the child starts with the page, then the page goes at once)
        pg = AgentPage(run, sg)
        await pg.open()
        run.leg.control(relay="page-close", conn="c%d" % pg.gen, gen=pg.gen)
        await until(lambda: any('"id":"r1"' in line and "no page is attached" in line for line in run.fake_lines())
                    or run.runner.agent is None or run.runner.agent.stats["toPage"] > 0, what="the request's fate")
        a = run.runner.agent
        if a is not None and a.stats["toPage"] == 0:
            await until(lambda: any("no page is attached" in line for line in run.fake_lines()), what="the error answer")
    finally:
        sg.close()
        await run.end()


# ================= caps

@aio
async def test_caps_page_only_never_the_leg():
    run = await Run().start(fake_args=("echo",))
    sg = await signer()
    try:
        pg = AgentPage(run, sg)
        await pg.open()
        # (an agent page's message one byte over its cap: that page closed (1009), the leg kept)
        over = "x" * (R.AGENT_FRAME + 1)
        run.leg.send_text("%d\n%s" % (pg.gen, over))
        await until(lambda: pg.gen in closed_gens(run), what="the page's close")
        assert run.task and not run.task.done()
        # (a kernel page is held to its own cap)
        run.gen += 1
        g = run.gen
        run.leg.control(relay="page-open", conn="c%d" % g, kind="runner", chan="kernel", gen=g)
        run.leg.send_text("%d\n%s" % (g, "y" * (R.PAIR_LIMITS["frame"] + 1)))
        await until(lambda: g in closed_gens(run), what="the kernel page's close")
        assert not run.task.done()
    finally:
        sg.close()
        await run.end()


@aio
async def test_child_line_over_the_cap_stops_it():
    run = await Run().start(fake_args=("big", str(A.AGENT_FRAME + 1)))
    sg = await signer()
    try:
        pg = AgentPage(run, sg)
        await pg.open()
        while True:
            m = await run.leg.json()
            if m.get("method") == "agent.ended":
                break
        assert m["params"]["text"] == "The agent sent a message over this connection's limit of about 4 MB and was stopped. Connect again to restart it.", m
    finally:
        sg.close()
        await run.end()


@aio
async def test_child_line_at_the_cap_passes():
    n = A.AGENT_FRAME
    run = await Run().start(fake_args=("big", str(n)))
    sg = await signer()
    try:
        pg = AgentPage(run, sg)
        await pg.open()
        m = await run.leg.json(timeout=60)
        assert set(m) == {"x"} and len(compact(m)) == n, (len(compact(m)), n)
    finally:
        sg.close()
        await run.end()


@aio
async def test_relay_looking_line_stops_the_child():
    run = await Run().start(fake_args=("relay",))
    sg = await signer()
    try:
        await AgentPage(run, sg).open()
        while True:
            m = await run.leg.json()
            if m.get("method") == "agent.ended":
                break
        assert not any(c.get("relay") == "close" and c.get("gen") == 1 and False for c in run.leg.controls)
    finally:
        sg.close()
        await run.end()


# ================= the child's process: environment, stderr, no shell

@aio
async def test_environment_deny_list():
    run = await Run().start(fake_args=("env",), env={"SAGEBRUSH_SECRET_THING": "x", "SSLKEYLOGFILE": "/tmp/k",
                                                   "HTTPS_PROXY": "http://user:pw@proxy.example:3128",
                                                   "ORDINARY_VAR": "kept"})
    sg = await signer()
    try:
        await AgentPage(run, sg).open()
        m = await run.leg.json()
        print("  the child's environment keys:", m["env"])
        assert "SAGEBRUSH_SECRET_THING" not in m["env"] and "SSLKEYLOGFILE" not in m["env"], m
        assert "ORDINARY_VAR" in m["env"] and "PATH" in m["env"] and "HOME" in m["env"], m
        assert m["proxy"] == "http://proxy.example:3128", m
    finally:
        for k in ("SAGEBRUSH_SECRET_THING", "SSLKEYLOGFILE", "HTTPS_PROXY", "ORDINARY_VAR"):
            os.environ.pop(k, None)
        sg.close()
        await run.end()


@aio
async def test_stderr_log_private_rotated_redacted():
    run = await Run().start(fake_args=("stderr", str(3 * 1024 * 1024)))
    sg = await signer()
    try:
        await AgentPage(run, sg).open()
        path = run.log.path
        await until(lambda: os.path.exists(path + ".1"), timeout=20, what="the log's rotation")
        await asyncio.sleep(0.3)
        assert stat.S_IMODE(os.stat(run.log.folder).st_mode) == 0o700
        assert stat.S_IMODE(os.stat(path).st_mode) == 0o600
        assert os.path.getsize(path) <= A.LOG_MAX
        both = open(path + ".1", "rb").read() + open(path, "rb").read()
        assert b"sk-ant-api03" not in both and b"[redacted]" in both
        secret = run.runner.agent_resume
        assert secret is None or secret not in both
    finally:
        sg.close()
        await run.end()


@aio
async def test_no_shell():
    # (the fake's "exit 0" mode exits after its first message. Through a shell, "exit 0 ; touch <mark>" would then run
    # touch, while the shell (the runner's child) is still alive; without one, ";" "touch" <mark> are only arguments.
    # The row waits for the child to exit by itself, then looks for the mark.)
    mark = os.path.join(TMP, "p")
    kinds = R.parse_args(["--serve-agents", "--agent-cmd", "%s %s exit 0 ; touch %s" % (sys.executable, FAKE, mark)])[1]
    assert [name for name, _ in kinds] == ["default"], kinds
    run = await Run().start(cmd=kinds[0][1])
    sg = await signer()
    try:
        pg = AgentPage(run, sg)
        await pg.open()
        await until(run.ready, what="the fake ready")
        a = run.runner.agent
        await pg.send(compact({"jsonrpc": "2.0", "method": "x", "params": {}}))
        await until(lambda: a.proc.poll() is not None, timeout=5.0, what="the child to exit by itself")
        assert not os.path.exists(mark)
    finally:
        sg.close()
        await run.end()


def test_cli_arguments():
    assert R.parse_args([]) == (False, [])
    assert R.parse_args(["--serve-agents", "--agent-cmd", "npx -y sagebrush-agent --stdio"]) == (True, [("default", ["npx", "-y", "sagebrush-agent", "--stdio"])])
    # (--agent NAME=COMMAND, repeated: in the order given, the first the default; --agent-cmd is the kind "default";
    # COMMAND keeps any "=" after the first, and is split like --agent-cmd's)
    assert R.parse_args(["--serve-agents", "--agent", "claude=npx -y a --stdio", "--agent", "codex=b --x=1", "--agent-cmd", "c"]) == (
        True, [("claude", ["npx", "-y", "a", "--stdio"]), ("codex", ["b", "--x=1"]), ("default", ["c"])])
    four = [x for i in range(4) for x in ("--agent", "a%d=x" % i)]
    assert len(R.parse_args(["--serve-agents", *four])[1]) == R.AGENT_KINDS == 4
    for bad, why in ((["--serve-agents"], "--serve-agents needs --agent-cmd or --agent"),
                     (["--agent-cmd"], "--agent-cmd needs the agent's command"),
                     (["--serve-agents", "--agent-cmd", "  "], "--agent-cmd needs the agent's command"),
                     (["--agent-cmd", "x"], "--agent-cmd and --agent need --serve-agents"),
                     (["--agent", "a=x"], "--agent-cmd and --agent need --serve-agents"),
                     (["--serve-agents", "--agent-cmd", "x", "--agent-cmd", "y"], "--agent-cmd is given twice"),
                     (["--serve-agents", "--agent"], "--agent needs NAME=COMMAND"),
                     (["--serve-agents", "--agent", "claude"], "--agent needs NAME=COMMAND"),
                     (["--serve-agents", "--agent", "claude="], "--agent claude needs the agent's command"),
                     (["--serve-agents", "--agent", "Claude=x"], "an agent's name is a lowercase letter"),
                     (["--serve-agents", "--agent", "=x"], "an agent's name is a lowercase letter"),
                     (["--serve-agents", "--agent", "1a=x"], "an agent's name is a lowercase letter"),
                     (["--serve-agents", "--agent", "a" * 17 + "=x"], "an agent's name is a lowercase letter"),
                     (["--serve-agents", "--agent", "a/b=x"], "an agent's name is a lowercase letter"),
                     (["--serve-agents", "--agent", "a\n=x"], "an agent's name is a lowercase letter"),
                     (["--serve-agents", "--agent", "a=x", "--agent", "a=y"], "an agent's name is given twice: a"),
                     (["--serve-agents", "--agent-cmd", "x", "--agent", "default=y"], "an agent's name is given twice: default"),
                     (["--serve-agents", *four, "--agent", "e=x"], "at most 4 agents per runner"),
                     (["--nope"], "unknown argument --nope")):
        try:
            R.parse_args(bad)
        except ValueError as e:
            assert str(e).startswith(why), (bad, str(e))
            continue
        raise AssertionError(bad)
    assert R.parse_args(["--serve-agents", "--agent", "a" * 16 + "=x"])[1][0][0] == "a" * 16  # (16 letters: the longest)


# ================= more edges: backpressure, stdin, lines, revoke

@aio
async def test_no_room_holds_the_line_never_closes():
    """The leg has no room (a kernel page's output buffered, or a page that doesn't read): the child's line is held,
    nothing more is read, and it's delivered once there's room, with no page closed."""
    run = await Run().start(fake_args=("big", str(1024 * 1024)))
    sg = await signer()
    try:
        room = {"open": False}
        leg_fits = None
        await AgentPage(run, sg).open()
        await until(lambda: run.runner.leg is not None, what="the leg")
        leg = run.runner.leg
        leg_fits = leg.fits
        leg.fits = lambda n, kind: room["open"] and leg_fits(n, kind)
        await asyncio.sleep(0.5)
        a = run.runner.agent
        assert a.stats["toPage"] == 0 and not closed_gens(run), (a.stats, closed_gens(run))
        room["open"] = True
        m = await run.leg.json(timeout=30)
        assert set(m) == {"x"} and a.stats["toPage"] == 1 and not closed_gens(run)
    finally:
        sg.close()
        await run.end()


@aio
async def test_child_not_reading_second_max_message_refused():
    run = await Run().start(fake_args=("noread",))
    sg = await signer()
    try:
        pg = AgentPage(run, sg)
        await pg.open()
        await until(lambda: run.runner.agent is not None and run.runner.agent.proc is not None, what="the child")
        big = compact({"blob": "z" * (A.AGENT_FRAME - 64 * 1024)})
        await pg.send(big)
        await until(lambda: run.runner.agent.queued > 0, what="the first message queued")
        await pg.send(big)
        m = await run.leg.json(timeout=30)
        assert m == {"jsonrpc": "2.0", "method": "agent.notice", "params": {"text": "The agent isn't reading messages right now. Try again in a moment."}}, m
        a = run.runner.agent
        assert a.queued <= A.AGENT_QUEUE and not closed_gens(run)
        # (Stop and unpair still work: signals)
        pgid = a.pgid
        await pg.send('{"unpair":true}')
        await until(lambda: group_gone(pgid), timeout=4.0, what="the group to end")
    finally:
        sg.close()
        await run.end()


@aio
async def test_page_message_exactly_at_the_cap_passes():
    run = await Run().start(fake_args=())
    sg = await signer()
    try:
        pg = AgentPage(run, sg)
        await pg.open()
        await until(lambda: run.runner.agent is not None and run.runner.agent.proc is not None, what="the child")
        # (the whole frame the page sends, envelope included, exactly AGENT_FRAME bytes)
        htu = "sb-agent:%s/%s/%d#%s" % (run.key.remote_id, run.runner.incarnation, pg.gen, "a" * 43)
        proof_len = len(await pg.proof(htu, pg.token, pg.nonce))  # (the same length as the real one's)
        # (the fake relay sends json.dumps's default form, so the frame is measured that way)
        def frame_of(pl):
            return len(json.dumps({"a": "DPoP " + pg.token, "p": "P" * proof_len, "m": pl}))
        payload = compact({"f": ""})
        payload = compact({"f": "f" * (A.AGENT_FRAME - frame_of(payload))})  # (the payload's escaped quotes counted)
        frame = frame_of(payload)
        assert frame == A.AGENT_FRAME, (frame, A.AGENT_FRAME)
        await pg.send(payload)
        await until(lambda: len(run.fake_lines()) == 1, timeout=30, what="the message at the cap")
        assert run.fake_lines()[0] == payload and not closed_gens(run)
    finally:
        sg.close()
        await run.end()


def test_max_frame_bytes_is_not_the_envelope_bound():
    # (a quote-heavy payload of exactly maxFrameBytes is over limits.frame once enveloped, even with an empty token and
    # proof: a page must measure its serialized envelope against limits.frame, not the payload against maxFrameBytes)
    n = A.AGENT_ADVERTISED
    payload = compact({"q": ""})
    payload = compact({"q": '"' * ((n - len(payload)) // 2)})
    payload = payload[:-2] + "x" * (n - len(payload)) + payload[-2:]
    assert len(payload) == n and json.loads(payload)["q"].count('"') > n // 3, len(payload)
    envelope = compact({"a": "", "p": "", "m": payload})
    assert len(envelope) > A.AGENT_FRAME, (len(envelope), A.AGENT_FRAME)
    # (while one with only its own four quotes escaped, at maxFrameBytes, leaves nearly 2 KiB for the token and proof)
    plain = compact({"q": "x" * (n - len(compact({"q": ""})))})
    room = A.AGENT_FRAME - len(compact({"a": "", "p": "", "m": plain}))
    assert len(plain) == n and 2000 < room < 2048, room


@aio
async def test_line_split_across_writes_and_a_last_line_without_newline():
    run = await Run().start(fake_args=("split",))
    sg = await signer()
    try:
        await AgentPage(run, sg).open()
        m = await run.leg.json()
        assert m == {"split": "yes"}, m
    finally:
        sg.close()
        await run.end()
    run = await Run().start(fake_args=("tail",))
    sg = await signer()
    try:
        await AgentPage(run, sg).open()
        while True:
            m = await run.leg.json()
            if m.get("method") == "agent.ended":
                break
        await asyncio.sleep(0.2)
        assert b"a last line with no newline was dropped" in open(run.log.path, "rb").read()
    finally:
        sg.close()
        await run.end()


@aio
async def test_revoke_and_replace_stop_the_child():
    for code in (4403, 4009):
        run = await Run().start(fake_args=("grandchild",))
        sg = await signer()
        try:
            await AgentPage(run, sg).open()
            await until(lambda: any(line.startswith("GC ") for line in run.fake_lines()), what="the grandchild")
            pgid = run.runner.agent.pgid
            run.leg.close(code, "test")
            await until(lambda: group_gone(pgid), timeout=4.0, what="the group to end on %d" % code)
            assert run.runner.agent is None and run.runner.agent_resume is None
        finally:
            sg.close()
            await run.end()


@aio
async def test_request_while_detached_gets_the_error_at_once():
    run = await Run().start(fake_args=("later-request", "0.5"))
    sg = await signer()
    try:
        pg = AgentPage(run, sg)
        await pg.open(remember=True)
        run.leg.control(relay="page-close", conn="c%d" % pg.gen, gen=pg.gen)
        await until(lambda: any('"id":"r2"' in line and "no page is attached: the person will reopen the chat" in line
                                for line in run.fake_lines()), timeout=5, what="the immediate error")
        assert run.runner.agent.stats["answeredDetached"] == 1
    finally:
        sg.close()
        await run.end()


# ================= the child's start and stop, as one state machine

class Barrier:
    """Holds the child's start at its first await after the spawn (attaching the first pipe) until released: the
    process already exists, and a stop or Stop lands in that window."""

    def __init__(self):
        self.entered, self.release = asyncio.Event(), asyncio.Event()

    def __enter__(self):
        loop = asyncio.get_running_loop()
        self.loop, self.real = loop, loop.connect_read_pipe
        first = {"held": False}

        async def held(*a, **k):
            if not first["held"]:
                first["held"] = True
                self.entered.set()
                await self.release.wait()
            return await self.real(*a, **k)
        loop.connect_read_pipe = held
        return self

    def __exit__(self, *e):
        self.loop.connect_read_pipe = self.real


def fake_child(*args, grace_ms=60_000):
    d = tempfile.mkdtemp(dir=TMP)
    log = os.path.join(d, "fake.log")
    os.environ["FAKE_LOG"] = log
    c = A.AgentChild([sys.executable, FAKE, *args], log=A.AgentLog(os.path.join(d, "state")), grace_ms=grace_ms)
    return c, log


def lines(log):
    try:
        with open(log) as f:
            return [x[:-1] for x in f]
    except FileNotFoundError:
        return []


def pid_gone(pid):
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return True
    return False


@aio
async def test_stop_before_start_spawns_nothing():
    c, _ = fake_child("echo")
    c.stop("stopped before it started")
    await c.start()
    assert c.proc is None and c.pgid is None and c.tasks == []


@aio
async def test_stop_while_starting_ends_the_group_at_once():
    """The process exists and its start is held: a stop ends its whole group at once (its pid known from the spawn),
    before the start resumes; then the start only tidies up."""
    c, log = fake_child("grandchild")
    with Barrier() as b:
        t = asyncio.ensure_future(c.start())
        await asyncio.wait_for(b.entered.wait(), 5)
        assert c.pgid is not None  # (known with no await after the spawn)
        await until(lambda: any(x.startswith("GC ") for x in lines(log)), what="the grandchild")
        c.stop("the person disconnected it while it started")
        await until(lambda: group_gone(c.pgid), timeout=4.0, what="the group to end while the start is held")
        b.release.set()
        await asyncio.wait_for(t, 10)
    await until(lambda: c.proc.returncode is not None, timeout=4.0, what="the process reaped")
    assert len(c.tasks) == 1  # (only the reaper: no pump, writer or watcher for a stopped child)


@aio
async def test_stop_signal_before_the_process_exists_is_delivered():
    c, log = fake_child("keep-int")
    c.interrupt()  # (before start: remembered)
    await c.start()
    try:
        # (it arrives as soon as the process exists, maybe before the fake has set its handler: then Python's own
        # default ends the process by SIGINT; either way the Stop was delivered, to that process)
        await until(lambda: "SIGINT" in lines(log) or c.proc.poll() == -signal.SIGINT, timeout=5,
                    what="the Stop sent before the process existed")
    finally:
        c.stop("the test ended")
        await until(lambda: group_gone(c.pgid), timeout=4.0, what="the group to end")


@aio
async def test_runner_exit_with_a_start_held_past_its_deadline():
    """The runner exits while a child's start is held (its process exists, its pipes not yet attached) past the
    deadline: the group is ended at the stop, the start is cancelled after the deadline, and no child or grandchild
    is left."""
    run = await Run().start(fake_args=("grandchild",))
    sg = await signer()
    try:
        with Barrier() as b:
            pg = AgentPage(run, sg)
            pg.page_open()
            run.leg.send(await pg.hello_frame(), gen=pg.gen)
            await asyncio.wait_for(b.entered.wait(), 10)
            a = run.runner.agent
            await until(lambda: run.ready() or any(x.startswith("GC ") for x in run.fake_lines()), what="the child running")
            gcs = [int(x.split()[1]) for x in run.fake_lines() if x.startswith("GC ")]
            # (as run_relay's exit does, with a short deadline: the start is never released)
            run.runner.stop_agent("the runner stopped")
            said = []
            run.runner.err = said.append
            cancelled = await R.finish_agent_starts(run.runner, wait_s=0.3)
            assert said == ["An agent start still under way at the exit was cancelled after 0.3 s.\n"], said
            assert cancelled and all(t.done() for t in cancelled), cancelled
        assert a.ended and a.pgid is not None
        await until(lambda: group_gone(a.pgid), timeout=4.0, what="the child's group to end")
        await until(lambda: a.proc.poll() is not None, timeout=4.0, what="the child reaped")
        for gc in gcs:
            await until(lambda: pid_gone(gc), timeout=4.0, what="the grandchild to end")
        assert not run.runner.agent_starts
        # (nothing outlives it: the group's SIGKILL timer settled (drain_groups finds nothing left), the reaper done)
        assert await drain_groups(3.0) == [] and a.pgid not in A.ending_groups_view()
        await until(lambda: all(t.done() for t in a.tasks), timeout=4.0, what="the reaper to finish")
    finally:
        sg.close()
        await run.end()


@aio
async def test_runner_exit_waits_the_default_for_a_start_that_finishes():
    """The runner exits while a start is held, and the start is released 0.3 s later: with the default wait
    (AGENT_START_WAIT_S), it finishes by itself and nothing is cancelled."""
    assert R.AGENT_START_WAIT_S == 10
    run = await Run().start(fake_args=())
    sg = await signer()
    try:
        with Barrier() as b:
            pg = AgentPage(run, sg)
            pg.page_open()
            run.leg.send(await pg.hello_frame(), gen=pg.gen)
            await asyncio.wait_for(b.entered.wait(), 10)
            starts = set(run.runner.agent_starts)
            run.runner.stop_agent("the runner stopped")
            asyncio.get_running_loop().call_later(0.3, b.release.set)
            cancelled = await R.finish_agent_starts(run.runner)
        assert cancelled == set(), cancelled
        assert starts and all(t.done() and not t.cancelled() for t in starts), starts
    finally:
        sg.close()
        await run.end()


@aio
async def test_natural_exit_with_a_descendant_holding_the_pipes():
    """The child exits on its own while a descendant keeps its stdout and stderr open: the exit is seen at once, the
    page told, and the whole group ended, without waiting for the pipes."""
    run = await Run().start(fake_args=("fork-exit",))
    sg = await signer()
    try:
        await AgentPage(run, sg).open()
        t0 = time.monotonic()
        while True:
            m = await run.leg.json(timeout=10)
            if m.get("method") == "agent.ended":
                break
        assert m["params"]["text"] == "The agent stopped (exit code 0). Connect again to restart it.", m
        assert time.monotonic() - t0 < 3, "the exit waited for the pipes"
        gc = [int(x.split()[1]) for x in run.fake_lines() if x.startswith("GC ")]
        assert gc
        await until(lambda: pid_gone(gc[0]), timeout=4.0, what="the descendant to end with the group")
        await until(lambda: run.runner.agent is None, what="the runner to forget the child")
    finally:
        sg.close()
        await run.end()



# ================= the runner's own lines to the child (start, detached, attached), and the binding epoch

def _relays(got):
    """The runner's lines in what the child got, as (kind, epoch)."""
    out = []
    for x in got:
        if isinstance(x, dict):
            r = x["relay"]
            out.append(("start", r["start"]["epoch"]) if "start" in r else (r["page"], r["epoch"]))
    return out


@aio
async def test_start_first_then_the_old_page_then_detached_attached_then_the_new_page():
    run = await Run().start(fake_args=("echo",))
    sg = await signer()
    try:
        p1 = AgentPage(run, sg)
        secret = (await p1.open(remember=True))["result"]["resume"]
        await p1.send('{"n":1}')
        await until(lambda: '{"n":1}' in run.fake_lines(), what="the first page's message")
        run.leg.control(relay="page-close", conn="c%d" % p1.gen, gen=p1.gen)
        p2 = AgentPage(run, sg)
        assert (await p2.open(resume=secret))["result"]["resumed"] is True
        await p2.send('{"n":2}')
        await until(lambda: '{"n":2}' in run.fake_lines(), what="the second page's message")
        got = run.child_lines()
        assert got[0] == {"relay": {"start": {"frame": A.AGENT_FRAME, "protocol": 1, "epoch": 0}}}, got[0]
        assert _relays(got) == [("start", 0), ("detached", 1), ("attached", 1)], got
        i = {k: n for n, k in enumerate(json.dumps(x) if isinstance(x, dict) else x for x in got)}
        d = json.dumps({"relay": {"page": "detached", "epoch": 1}})
        a = json.dumps({"relay": {"page": "attached", "epoch": 1}})
        assert i['{"n":1}'] < i[d] < i[a] < i['{"n":2}'], got
    finally:
        sg.close()
        await run.end()


@aio
async def test_takeover_with_the_writer_held_drops_the_old_page_queued_line_and_finishes_the_one_in_flight():
    """R-a and R-b: the child reads nothing for a while, so a large old-page line is half-written and a second sits
    queued; a takeover then drops the queued one, lets the half-written one finish whole, and the barrier comes before
    the new page's message."""
    run = await Run().start(fake_args=("slow-read", "1.5"))
    sg = await signer()
    try:
        p1 = AgentPage(run, sg)
        secret = (await p1.open(remember=True))["result"]["resume"]
        await until(run.ready, what="the child")
        big = compact({"big": "b" * (300 * 1024)})  # (larger than the pipe: its writing is held part way)
        await p1.send(big)
        await p1.send('{"old":2}')
        a = run.runner.agent
        await until(lambda: a.writing_item is not None and a.writing_item[1].startswith(b'{"big"'), what="the big line in flight")
        await until(lambda: any(x[1] == b'{"old":2}\n' for x in a.queue), what="the second line queued, not started")
        p2 = AgentPage(run, sg)
        assert (await p2.open(resume=secret))["result"]["resumed"] is True
        assert a.stats["droppedAtDetach"] == 1
        await p2.send('{"new":1}')
        await until(lambda: '{"new":1}' in run.fake_lines(), timeout=15, what="the new page's message")
        got = run.child_lines()
        assert '{"old":2}' not in got, "the old page's queued line never reached the child"
        assert got.index(big) < got.index({"relay": {"page": "detached", "epoch": 1}}) < got.index({"relay": {"page": "attached", "epoch": 1}}) < got.index('{"new":1}')
        assert a.queued == 0
    finally:
        sg.close()
        await run.end()



@aio
async def test_a_detach_with_a_line_in_flight_and_one_queued():
    """The page simply goes (no takeover) while a large line is being written and another waits: the waiting one is
    dropped and counted once; the one in flight reaches the child whole, then the detached line; every byte charged is
    given back once."""
    run = await Run().start(fake_args=("slow-read", "1.0"))
    sg = await signer()
    try:
        p1 = AgentPage(run, sg)
        await p1.open(remember=True)
        await until(run.ready, what="the child")
        big = compact({"big": "b" * (300 * 1024)})
        await p1.send(big)
        await p1.send('{"queued":1}')
        a = run.runner.agent
        await until(lambda: a.writing_item is not None and any(x[1] == b'{"queued":1}\n' for x in a.queue), what="one in flight, one queued")
        run.leg.control(relay="page-close", conn="c%d" % p1.gen, gen=p1.gen)
        await until(lambda: a.page is None, what="the detach")
        assert a.stats["droppedAtDetach"] == 1, a.stats
        await until(lambda: big in run.fake_lines() and len(run.relay_lines()) == 2, timeout=15, what="the child reading")
        got = run.child_lines()
        assert '{"queued":1}' not in got
        assert got.index(big) < got.index({"relay": {"page": "detached", "epoch": 1}}), got
        await until(lambda: a.writing_item is None, what="the write finished")
        assert a.queued == 0 and a.stats["droppedAtDetach"] == 1, (a.queued, a.stats)
    finally:
        sg.close()
        await run.end()

@aio
async def test_two_cycles_before_the_child_reads_give_the_latest_epoch_once():
    run = await Run().start(fake_args=("slow-read", "1.0"))
    sg = await signer()
    try:
        p1 = AgentPage(run, sg)
        secret = (await p1.open(remember=True))["result"]["resume"]
        await until(run.ready, what="the child")
        # (the writer held: a line larger than the pipe is in flight, so the control lines wait in their slots)
        big = compact({"big": "b" * (300 * 1024)})
        await p1.send(big)
        a = run.runner.agent
        await until(lambda: a.writing_item is not None, what="the big line in flight")
        for _ in range(2):
            run.leg.control(relay="page-close", conn="c%d" % run.gen, gen=run.gen)
            p = AgentPage(run, sg)
            assert (await p.open(resume=secret))["result"]["resumed"] is True
        await p.send('{"last":1}')
        await until(lambda: '{"last":1}' in run.fake_lines(), timeout=15, what="the last page's message")
        assert _relays(run.child_lines()) == [("start", 0), ("detached", 2), ("attached", 2)], _relays(run.child_lines())
        assert run.runner.agent.epoch == 2
    finally:
        sg.close()
        await run.end()


@aio
async def test_the_first_page_gone_before_start_is_written_gives_start_then_detached():
    run = await Run().start(fake_args=("echo",))
    sg = await signer()
    try:
        with Barrier() as b:
            p1 = AgentPage(run, sg)
            p1.page_open()
            run.leg.send(await p1.hello_frame(remember=True), gen=p1.gen)
            await asyncio.wait_for(b.entered.wait(), 10)
            run.runner.agent.detach()  # (the page goes while the child's pipes are still being attached)
            b.release.set()
            await until(lambda: len(run.relay_lines()) == 2, what="both runner lines")
        assert _relays(run.child_lines()) == [("start", 0), ("detached", 1)]
    finally:
        sg.close()
        await run.end()


@aio
async def test_a_page_message_with_a_top_level_relay_key_never_reaches_the_child():
    run = await Run().start(fake_args=("echo",))
    sg = await signer()
    try:
        p1 = AgentPage(run, sg)
        await p1.open()
        await until(lambda: len(run.relay_lines()) == 1, what="the start line")
        for forged in ('{"relay":{"page":"attached","epoch":9}}', '{"relay":{"start":{"frame":65536,"protocol":1,"epoch":0}}}'):
            await p1.send(forged)
        await p1.send('{"after":1}')
        await until(lambda: '{"after":1}' in run.fake_lines(), what="a message after them")
        assert run.relay_lines() == [{"relay": {"start": {"frame": A.AGENT_FRAME, "protocol": 1, "epoch": 0}}}]
        assert not any("relay" in x for x in run.fake_lines())
    finally:
        sg.close()
        await run.end()



@aio
async def test_attach_over_an_attached_page_ends_its_binding_first():
    """The relay closes the old page (and so detaches it) before a takeover's attach; AgentChild doesn't rely on that:
    an attach over an attached page ends that page's binding itself."""
    a = A.AgentChild(["true"])

    class P:
        closed = False
    a.attach(P())
    a.send('{"old":1}')
    a.attach(P())
    assert (a.epoch, a.slot_detached, a.slot_attached) == (1, 1, 1)
    assert not a.queue and a.queued == 0 and a.stats["droppedAtDetach"] == 1


@aio
async def test_cycles_ending_in_a_detach_leave_no_attached_line_behind():
    run = await Run().start(fake_args=("slow-read", "1.0"))
    sg = await signer()
    try:
        p1 = AgentPage(run, sg)
        secret = (await p1.open(remember=True))["result"]["resume"]
        await until(run.ready, what="the child")
        big = compact({"big": "b" * (300 * 1024)})
        await p1.send(big)
        a = run.runner.agent
        await until(lambda: a.writing_item is not None, what="the big line in flight")
        run.leg.control(relay="page-close", conn="c%d" % run.gen, gen=run.gen)
        p2 = AgentPage(run, sg)
        assert (await p2.open(resume=secret))["result"]["resumed"] is True
        run.leg.control(relay="page-close", conn="c%d" % run.gen, gen=run.gen)
        await until(lambda: len(run.relay_lines()) >= 2 and big in run.fake_lines(), timeout=15, what="the child reading")
        await asyncio.sleep(0.2)
        assert _relays(run.child_lines()) == [("start", 0), ("detached", 2)], _relays(run.child_lines())
    finally:
        sg.close()
        await run.end()


# ================= the reviewed sagebrush-agent, vendored: its version, and its clamp against the runner's frame

VENDORED = os.path.join(HERE, "fixtures", "sagebrush-agent-0.5.0.tgz")
VENDORED_SHA256 = "019b9020c12a0294705ac6c1ba76433b71dab8e89ef3be31e063cba54401016b"
STUB_DEPS = os.path.join(HERE, "remote_agent_stub_deps.mjs")


def unpack_vendored():
    """The vendored tarball, its SHA-256 checked before anything is read from it, unpacked into a new folder (regular
    files and folders under package/ only)."""
    import tarfile
    with open(VENDORED, "rb") as f:
        assert hashlib.sha256(f.read()).hexdigest() == VENDORED_SHA256, "the vendored tarball isn't the reviewed one"
    dest = tempfile.mkdtemp(prefix="sb-agent-pkg-", dir=TMP)  # (inside the test run's folder, removed with it)
    with tarfile.open(VENDORED, "r:gz") as t:
        for m in t.getmembers():
            assert (m.isfile() or m.isdir()) and m.name.startswith("package/") and ".." not in m.name.split("/"), m.name
        t.extractall(dest, filter="data")
    return os.path.join(dest, "package")


# (the vendored agent's branch and run tools take their words and parameters from its copy of this page's schema.json)
PAGE_TOOL_VERBS = ["git_branch", "git_commit", "git_status", "git_wait", "run_notebook", "run_file", "run_stop", "latex_build"]
SCHEMA = os.path.join(os.path.dirname(os.path.dirname(HERE)), "web", "workspace", "schema.json")


def test_the_vendored_agents_page_verbs_are_this_pages():
    """The vendored agent's lib/page-verbs.json (from the reviewed tarball) holds exactly its 8 verbs, and each equals
    web/workspace/schema.json's own entry, as this tree has it: a verb changed on either side, or one of the 8 gone from
    the page, fails here, naming it. Other verbs of the page are not the agent's and don't count."""
    pkg = unpack_vendored()
    with open(os.path.join(pkg, "lib", "page-verbs.json")) as f:
        theirs = json.load(f)["verbs"]
    with open(SCHEMA) as f:
        ours = json.load(f)["verbs"]
    names = ["workspace." + v for v in PAGE_TOOL_VERBS]
    assert sorted(theirs) == sorted(names), sorted(theirs)
    for n in names:
        assert n in ours, "%s: gone from web/workspace/schema.json" % n
        assert theirs[n] == ours[n], "%s: the vendored agent's copy differs from web/workspace/schema.json" % n


def test_vendored_agent_is_the_version_usage_names():
    pkg = unpack_vendored()
    with open(os.path.join(pkg, "package.json")) as f:
        version = json.load(f)["version"]
    assert "sagebrush-agent-%s.tgz" % version in R.USAGE, (version, R.USAGE)



def test_the_vendored_rows_stand_ins_fail_loudly_when_used():
    """The two npm imports the vendored agent gets as stand-ins throw on any real use (ws constructed, a zod schema
    validated or looked inside), so the clamp row passing shows neither does anything on the --stdio path."""
    import shutil
    import subprocess
    probe = (
        'const { z } = await import("zod");'
        'const s = z.object({ a: z.string().describe("x").optional() }).strict();'
        'const threw = [];'
        'for (const k of ["parse", "safeParse", "shape", "_def"]) { try { s[k]; } catch { threw.push(k); } }'
        'try { String(s); } catch { threw.push("String"); }'
        'try { JSON.stringify(s); } catch { threw.push("JSON"); }'
        'const ws = await import("ws");'
        'try { new ws.WebSocketServer({}); } catch { threw.push("ws"); }'
        'console.log(threw.join(","));'
    )
    r = subprocess.run([shutil.which("node"), "--import", STUB_DEPS, "--input-type=module", "-e", probe],
                       capture_output=True, text=True, timeout=60)
    assert r.stdout.strip() == "parse,safeParse,shape,_def,String,JSON,ws", (r.stdout, r.stderr[-500:])

@aio
async def test_vendored_agent_clamps_at_the_runner_frame():
    """The real runner with the reviewed agent as its child (its fake model): a request line of exactly AGENT_FRAME
    bytes reaches the page; one byte more is refused inside the agent, as an ordinary tool error, and the runner never
    stops the child."""
    import shutil
    node = shutil.which("node")
    assert node, "node is needed for this row (CI's engine job sets it up)"
    pkg = unpack_vendored()
    cmd = ["env", "SAGEBRUSH_AGENT_FAKE=1", node, "--import", STUB_DEPS, os.path.join(pkg, "bin", "sagebrush-agent.mjs"), "--stdio"]
    run = await Run().start(cmd=cmd)
    sg = await signer()
    try:
        pg = AgentPage(run, sg)
        await pg.open()
        raw = []

        async def next_message():
            while True:
                kind, v = await run.leg.next(60)
                if kind == "text":
                    raw.append(v)
                    return v, json.loads(v)
                assert kind not in ("close", "eof"), (kind, v)

        async def turn(text):
            """Send one chat message; answer the agent's requests as a page would; return the turn's events."""
            await pg.send(compact({"jsonrpc": "2.0", "method": "chat.message", "params": {"conversation": "c1", "id": text, "text": text, "author": "person"}}))
            events = []
            while True:
                v, m = await next_message()
                if isinstance(m.get("id"), str) and m.get("method"):
                    result = {"entry": None} if m["method"] == "workspace.stat" else {"entry": {"path": "/big.txt"}, "rev": 1}
                    await pg.send(compact({"jsonrpc": "2.0", "id": m["id"], "result": result}))
                    if m["method"] == "workspace.create":
                        events.append(("create", len(v.encode("utf-8"))))
                elif m.get("method") == "turn.event":
                    e = m["params"]["event"]
                    events.append((e["type"], e))
                    if e["type"] == "turn_finished":
                        return events

        while (await next_message())[1].get("method") != "agent.ready":
            pass
        await pg.send(compact({"jsonrpc": "2.0", "method": "grant.changed", "params": {"folders": ["/"], "write": True}}))
        # (the request line's own bytes, measured once, then aimed at the frame exactly and one byte over)
        probe = [n for k, n in await turn("big 10") if k == "create"]
        overhead = probe[0] - 10
        exact = [n for k, n in await turn("big %d" % (A.AGENT_FRAME - overhead)) if k == "create"]
        assert exact == [A.AGENT_FRAME], (exact, A.AGENT_FRAME)
        over = await turn("big %d" % (A.AGENT_FRAME - overhead + 1))
        assert not [n for k, n in over if k == "create"], "the line one byte over was never sent"
        done = [e for k, e in over if k == "tool_call_finished"]
        assert done and done[0]["status"] == "error" and "over this connection's limit" in done[0]["body"], done
        assert run.runner.agent is not None and not run.runner.agent.ended, "the child is still running"
    finally:
        sg.close()
        await run.end()


@aio
async def test_queue_charges_each_message_a_fixed_allowance_released_on_write_and_detach():
    """Each queued message costs its bytes plus QUEUE_ENTRY_BYTES against AGENT_QUEUE, so many tiny messages can't hold
    more than the cap in bookkeeping: tiny messages up to the cap, then one sized to fill it exactly, is taken; anything
    more is refused (the smallest message, a bare newline, costs 1 + QUEUE_ENTRY_BYTES); a detach gives it all back."""
    a = A.AgentChild(["true"])

    class P:
        closed = False
    a.attach(P())
    one = len(b"{}\n") + A.QUEUE_ENTRY_BYTES
    n = A.AGENT_QUEUE // one - 1  # (one fewer than fit, so the last message can be sized to land on the cap)
    for _ in range(n):
        assert a.send("{}")
    assert a.queued == n * one
    room = A.AGENT_QUEUE - a.queued - A.QUEUE_ENTRY_BYTES - 1  # (the bytes the last message may have, newline aside)
    assert room >= 0, room
    assert a.send("x" * room) and a.queued == A.AGENT_QUEUE, (a.queued, A.AGENT_QUEUE)
    assert not a.send(""), "at the cap, even the smallest message is refused"
    assert a.stats["refusedFull"] == 1
    a.queued -= A.QUEUE_ENTRY_BYTES  # (and with one byte short of the smallest charge free, still refused)
    assert not a.send("") and a.stats["refusedFull"] == 2
    a.queued += A.QUEUE_ENTRY_BYTES
    a.detach()
    assert a.queued == 0 and not a.queue, (a.queued, len(a.queue))

def test_inbound_limit_follows_the_channels_served():
    assert R.RELAY_LIMITS["inbound"] == R.PAIR_LIMITS["frame"] + 17
    assert R.RELAY_LIMITS["inboundAgents"] == max(R.PAIR_LIMITS["frame"], A.AGENT_FRAME) + 17
    key = enrolled("https://relay.example")
    assert R.RelayRunner(key).inbound_limit() == R.RELAY_LIMITS["inbound"]
    assert R.RelayRunner(key, agents=True, agent_cmd=["x"]).inbound_limit() == R.RELAY_LIMITS["inboundAgents"]
    assert R.Leg(None, None, None, None).inbound == R.RELAY_LIMITS["inbound"]


# ================= several kinds (--agent NAME=COMMAND): each its own child, resume secret, grace and page

KINDS = [("claude", ("echo",)), ("codex", ("echo",))]


@aio
async def test_kinds_the_hello_picks_one_and_the_answer_lists_them():
    run = await Run().start(kinds=KINDS)
    sg = await signer()
    try:
        # (no "agent": the first kind given; the answer names it and lists every kind, the first first)
        pc = AgentPage(run, sg)
        res = (await pc.open())["result"]
        assert res["agent"] == "claude" and res["agents"] == ["claude", "codex"], res
        # (another kind, with the first one's page still attached: its own child, never the first's)
        px = AgentPage(run, sg)
        res = (await px.open(agent="codex"))["result"]
        assert res["agent"] == "codex" and res["agents"] == ["claude", "codex"] and res["resumed"] is False, res
        await until(lambda: run.kind_ready("claude") and run.kind_ready("codex"), what="both fakes")
        c, x = run.runner.slots["claude"].child, run.runner.slots["codex"].child
        assert c is not x and c.page is pc_page(run, pc) and x.page is pc_page(run, px) and c.pgid != x.pgid
        await pc.send('{"to":"claude"}')
        await px.send('{"to":"codex"}')
        await until(lambda: run.kind_lines("claude") and run.kind_lines("codex"), what="each kind's message")
        await asyncio.sleep(0.2)
        assert run.kind_lines("claude") == ['{"to":"claude"}'] and run.kind_lines("codex") == ['{"to":"codex"}']
    finally:
        sg.close()
        await run.end()


def pc_page(run, page):
    """The runner's RelayPage for a played page (by its generation)."""
    return next(p for p in run.runner.pages.values() if p.gen == page.gen)


@aio
async def test_kinds_a_name_not_offered_is_refused_before_anything_changes():
    run = await Run().start(kinds=KINDS)
    sg = await signer()
    try:
        p1 = AgentPage(run, sg)
        secret = (await p1.open(remember=True))["result"]["resume"]
        await until(lambda: run.kind_ready("claude"), what="the claude fake")
        slot = run.runner.slots["claude"]
        child, resume, jkt = slot.child, slot.resume, slot.resume_jkt
        notname = "That isn't an agent's name. This computer's runner offers: claude, codex."
        cases = [("gemini", "This computer's runner doesn't offer gemini. It offers: claude, codex.")]
        cases += [(bad, notname) for bad in ("Claude", "", "a" * 17, "x\n", "a b", "<b>", 5, None, True, ["claude"], {"n": 1})]
        for name, want in cases:
            # (with every hello option that would change the asked-for kind: none reaches any kind)
            for extra in ({}, {"fresh": True}, {"resume": secret}, {"fresh": True, "remember": True}):
                r = await AgentPage(run, sg).open(agent=name, **extra)
                assert r["error"]["message"] == want and r["error"]["data"]["code"] == "refused", (name, extra, r)
        assert slot.child is child and not child.ended and child.page is pc_page(run, p1)
        assert (slot.resume, slot.resume_jkt) == (resume, jkt) and run.runner.slots["codex"].child is None
        await p1.send('{"still":1}')
        await until(lambda: '{"still":1}' in run.kind_lines("claude"), what="the first page still attached")
    finally:
        sg.close()
        await run.end()


@aio
async def test_kinds_a_resume_secret_is_good_for_its_own_kind_only():
    run = await Run().start(kinds=KINDS, grace_ms=60_000)
    sg = await signer()
    try:
        pc = AgentPage(run, sg)
        sc = (await pc.open(remember=True))["result"]["resume"]
        px = AgentPage(run, sg)
        sx = (await px.open(agent="codex", remember=True))["result"]["resume"]
        await until(lambda: run.kind_ready("claude") and run.kind_ready("codex"), what="both fakes")
        c, x = run.runner.slots["claude"].child, run.runner.slots["codex"].child
        for p in (pc, px):
            run.leg.control(relay="page-close", conn="c%d" % p.gen, gen=p.gen)
        await until(lambda: c.page is None and x.page is None, what="both detached")
        # (claude's secret asking for codex, and codex's for claude: refused as an ended session, nothing attached)
        r = await AgentPage(run, sg).open(agent="codex", resume=sc)
        assert r["error"]["message"] == "This agent session has ended. Connect again to start a new one.", r
        r = await AgentPage(run, sg).open(resume=sx)
        assert r["error"]["message"] == "This agent session has ended. Connect again to start a new one.", r
        assert c.page is None and x.page is None and not c.ended and not x.ended
        # (each secret, for its own kind: the same child back)
        assert (await AgentPage(run, sg).open(agent="claude", resume=sc))["result"]["resumed"] is True
        assert (await AgentPage(run, sg).open(agent="codex", resume=sx))["result"]["resumed"] is True
        assert run.runner.slots["claude"].child is c and run.runner.slots["codex"].child is x
    finally:
        sg.close()
        await run.end()


@aio
async def test_kinds_messages_and_answers_stay_with_their_own_kind():
    # (claude's child asks the page something (a permission question, say) as request "r1"; codex's page answering
    # "r1" reaches codex's child only. A page detached from its kind: its late message reaches no kind)
    run = await Run().start(kinds=[("claude", ("request",)), ("codex", ("echo",))])
    sg = await signer()
    try:
        pc = AgentPage(run, sg)
        secret = (await pc.open(remember=True))["result"]["resume"]
        px = AgentPage(run, sg)
        await px.open(agent="codex")
        await until(lambda: run.kind_ready("claude") and run.kind_ready("codex"), what="both fakes")
        await px.send('{"jsonrpc":"2.0","id":"r1","result":{"allow":true}}')
        await until(lambda: run.kind_lines("codex"), what="codex's message")
        # (claude's page's frame, sent on codex's page: its proof names the other page's token and generation)
        run.leg.send(await pc.msg_frame('{"cross":1}'), gen=px.gen)
        # (claude's chat taken over by another claude page, the old page's message in flight behind the new hello
        # (written together, in that order): it reaches neither claude's child nor codex's)
        r = await AgentPage(run, sg).open()  # (claude's page is attached: refused, codex's untouched)
        assert r["error"]["message"].startswith("The agent is already open in another page or tab."), r
        late = await pc.msg_frame('{"late":1}')
        p2 = AgentPage(run, sg)
        p2.page_open()
        run.leg.send(await p2.hello_frame(resume=secret), gen=p2.gen)
        run.leg.send(late, gen=pc.gen)
        assert (await p2.answer())["result"]["resumed"] is True
        await px.send('{"after":1}')
        await until(lambda: '{"after":1}' in run.kind_lines("codex"), what="codex's later message")
        await asyncio.sleep(0.2)
        assert run.kind_lines("claude") == [], run.kind_lines("claude")
        assert run.kind_lines("codex") == ['{"jsonrpc":"2.0","id":"r1","result":{"allow":true}}', '{"after":1}'], run.kind_lines("codex")
    finally:
        sg.close()
        await run.end()


@aio
async def test_kinds_unpair_and_a_fresh_chat_end_their_own_kind_only():
    run = await Run().start(kinds=KINDS, grace_ms=60_000)
    sg = await signer()
    try:
        pc = AgentPage(run, sg)
        sc = (await pc.open(remember=True))["result"]["resume"]
        px = AgentPage(run, sg)
        await px.open(agent="codex")
        await until(lambda: run.kind_ready("claude") and run.kind_ready("codex"), what="both fakes")
        c, x = run.runner.slots["claude"].child, run.runner.slots["codex"].child
        # (codex's Disconnect: codex's group ends; claude's child, page and secret stay)
        await px.send('{"unpair":true}')
        await until(lambda: group_gone(x.pgid), timeout=4.0, what="codex's group to end")
        assert run.runner.slots["codex"].child is None and run.runner.slots["claude"].child is c and c.page is pc_page(run, pc)
        assert run.runner.slots["claude"].resume == hashlib.sha256(sc.encode()).digest()
        # (a fresh codex chat while claude's is detached: claude's still comes back with its secret)
        run.leg.control(relay="page-close", conn="c%d" % pc.gen, gen=pc.gen)
        await until(lambda: c.page is None, what="claude detached")
        assert "result" in await AgentPage(run, sg).open(agent="codex", fresh=True)
        await until(lambda: run.runner.slots["codex"].child is not None and run.runner.slots["codex"].child.pgid, what="codex's new child")
        back = AgentPage(run, sg)
        assert (await back.open(resume=sc))["result"]["resumed"] is True and run.runner.slots["claude"].child is c
        # (a replaced child's exit leaves its kind's new child and secret alone)
        run.leg.control(relay="page-close", conn="c%d" % back.gen, gen=back.gen)
        await until(lambda: c.page is None, what="claude detached again")
        p2 = AgentPage(run, sg)
        s2 = (await p2.open(fresh=True, remember=True))["result"]["resume"]
        await until(lambda: group_gone(c.pgid), timeout=4.0, what="the replaced claude child to end")
        await asyncio.sleep(0.2)
        new = run.runner.slots["claude"].child
        assert new is not None and new is not c and run.runner.slots["claude"].resume == hashlib.sha256(s2.encode()).digest()
    finally:
        sg.close()
        await run.end()


@aio
async def test_kinds_the_runner_stop_ends_every_kind_starts_included():
    run = await Run().start(kinds=KINDS)
    sg = await signer()
    try:
        await AgentPage(run, sg).open()
        await AgentPage(run, sg).open(agent="codex")
        await until(lambda: run.kind_ready("claude") and run.kind_ready("codex"), what="both fakes")
        groups = [run.runner.slots[k].child.pgid for k in ("claude", "codex")]
        # (and a start under way: codex's page gone, a fresh codex chat replaces its child; its start is held after
        # the spawn (the process exists, its pipes not yet attached) when the runner stops)
        px = next(p for p in run.runner.pages.values() if p.slot is run.runner.slots["codex"])
        run.leg.control(relay="page-close", conn="c%d" % px.gen, gen=px.gen)
        await until(lambda: run.runner.slots["codex"].child.page is None, what="codex detached")
        with Barrier() as b:
            r = await AgentPage(run, sg).open(agent="codex", fresh=True)
            assert r["result"]["agent"] == "codex" and r["result"]["resumed"] is False, r
            await asyncio.wait_for(b.entered.wait(), 5)
            pending = run.runner.slots["codex"].child
            assert pending.pgid is not None and pending.pgid not in groups and len(run.runner.agent_starts) == 1
            groups.append(pending.pgid)
            run.runner.stop_agent("the runner stopped")
            assert all(s.child is None and s.resume is None for s in run.runner.slots.values())
            for g in groups:
                await until(lambda: group_gone(g), timeout=4.0, what="every kind's group to end, the held start's too")
            b.release.set()
            assert not await R.finish_agent_starts(run.runner)  # (the held start, released, finishes by itself)
        assert not run.runner.agent_starts and await drain_groups(3.0) == []
    finally:
        sg.close()
        await run.end()


@aio
async def test_kinds_each_logs_to_its_own_file():
    # (the first kind's is agent.log; every other kind's is agent-<name>.log, "default" included: --agent claude=...
    # then --agent-cmd ... gives agent.log and agent-default.log, never one file for two)
    for second in ("codex", "default"):
        run = await Run().start(kinds=[("claude", ("stderr", "100")), (second, ("stderr", "200"))])
        sg = await signer()
        try:
            await AgentPage(run, sg).open()
            await AgentPage(run, sg).open(agent=second)
            first, other = run.log.path, os.path.join(run.log.folder, "agent-%s.log" % second)
            assert first.endswith(os.sep + "agent.log") and first != other
            await until(lambda: os.path.exists(first) and os.path.exists(other), what="both logs")
            await asyncio.sleep(0.3)
            a, b = open(first, "rb").read(), open(other, "rb").read()
            assert b"e" * 100 + b" " in a and b"e" * 200 not in a and b"e" * 200 in b, (second, len(a), len(b))
            assert stat.S_IMODE(os.stat(other).st_mode) == 0o600 and b"sk-ant-api03" not in a + b
            assert sorted(f for f in os.listdir(run.log.folder) if f.endswith(".log")) == sorted(["agent.log", "agent-%s.log" % second])
        finally:
            sg.close()
            await run.end()


def test_kinds_the_runner_takes_at_most_four_valid_unique_ones():
    key = enrolled("https://127.0.0.1:9")
    five = [("k%d" % i, ["x"]) for i in range(5)]
    for kinds, why in ((five, "at most 4 agents per runner"), ([("a", ["x"]), ("a", ["y"])], "an agent's name is given twice"),
                       ([("A", ["x"])], "an agent's name is a lowercase letter"), ([("a", [])], "--agent a needs the agent's command")):
        try:
            R.RelayRunner(key, agents=True, agent_cmds=kinds)
        except ValueError as e:
            assert str(e).startswith(why), (kinds, str(e))
            continue
        raise AssertionError(kinds)
    r = R.RelayRunner(key, agents=True, agent_cmds=five[:4])
    assert list(r.slots) == ["k0", "k1", "k2", "k3"] and r.agent_default == "k0" and r.serve_agents
    assert not R.RelayRunner(key, agents=False, agent_cmds=five[:1]).serve_agents


if __name__ == "__main__":
    # (as the other remote test files: each test raises on failure; no sys.exit, since test_pairing.py runs this file
    # with runpy in its own process, and the files after it must still run)
    for name, f in list(globals().items()):
        if name.startswith("test_") and callable(f):
            t0 = time.monotonic()
            f()
            print("ok %s (%.1f s)" % (name, time.monotonic() - t0))
    os.environ.pop("FAKE_LOG", None)
    import shutil
    shutil.rmtree(TMP, ignore_errors=True)  # (this run's folder: fake logs, unpacked agents)
    print("all remote agent tests passed")
