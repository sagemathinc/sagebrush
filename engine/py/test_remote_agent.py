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
from sagebrush.remote.gateway import drain_groups  # noqa: E402
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

    def __call__(self):
        return int(time.time() * 1000) + self.off


class Run:
    """A runner serving agent pages, against a fake relay, in this process."""

    async def start(self, fake_args=("echo",), agents=True, grace_ms=60_000, cmd=None, env=None):
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
        self.runner = R.RelayRunner(self.key, err=self.said.append, rnd=lambda: 0.5, agents=agents,
                                    agent_cmd=cmd or [sys.executable, FAKE, *fake_args], agent_grace_ms=grace_ms,
                                    agent_log=self.log, now_ms=self.clock)
        self.stop = asyncio.Event()
        self.task = asyncio.ensure_future(self.runner.run(self.stop))
        self.leg = await self.relay.leg()
        self.gen = 0
        return self

    def fake_lines(self):
        try:
            with open(self.fake_log) as f:
                return [line[:-1] for line in f]
        except FileNotFoundError:
            return []

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

    async def answer(self):
        while True:  # (the fake relay plays every page on one leg: another page's notice may come first)
            r = await self.leg.json()
            if r.get("id") == "p1" or "closed" in r:
                break
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
    try:
        os.killpg(pgid, 0)
    except ProcessLookupError:
        return True
    return False


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
        assert res["purpose"] == "agent" and res["maxFrameBytes"] == 6 * 1024 * 1024 and res["gen"] == pg.gen, res
        assert isinstance(res["resume"], str) and res["resumed"] is False and "agent" in res["channels"], res
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
        assert r["error"]["message"] == "The agent is already open in another page or tab. Close it there, then reload this page.", r
        # (a takeover with the secret, the old page's message in flight behind it: the old page told, the same
        # child, and the old message has no effect; the frames' order is forced by writing them together)
        p3 = AgentPage(run, sg)
        late = await p1.msg_frame('{"old":1}')
        p3.page_open()
        run.leg.send(await p3.hello_frame(resume=secret), gen=p3.gen)
        run.leg.send(late, gen=p1.gen)
        r = await p3.answer()
        assert r["result"]["resumed"] is True and run.runner.agent.pgid == pid, r
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
        assert r["error"]["message"] == "This agent session has ended. Reload to start a new one.", r
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
            await until(lambda: run.runner.agent is not None and run.runner.agent.pgid is not None, what="the child")
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
            if first == "old":
                assert '{"from":"old"}' in lines and "SIGINT" in lines, (first, lines)
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
        assert m["params"]["text"] == "The agent stopped (exit code 3). Reload to start it again.", m
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
        assert m["params"]["text"] == "The agent sent a message over this connection's 6 MiB limit and was stopped. Reload to start it again.", m
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
    mark = os.path.join(TMP, "p")
    run = await Run().start(cmd=R.parse_args(["--serve-agents", "--agent-cmd", "%s %s x; touch %s" % (sys.executable, FAKE, mark)])[1])
    sg = await signer()
    try:
        await AgentPage(run, sg).open()
        await asyncio.sleep(1.0)
        assert not os.path.exists(mark)
    finally:
        sg.close()
        await run.end()


def test_cli_arguments():
    assert R.parse_args([]) == (False, None)
    assert R.parse_args(["--serve-agents", "--agent-cmd", "npx -y sagebrush-agent --stdio"]) == (True, ["npx", "-y", "sagebrush-agent", "--stdio"])
    for bad in (["--serve-agents"], ["--agent-cmd"], ["--nope"]):
        try:
            R.parse_args(bad)
        except ValueError:
            continue
        raise AssertionError(bad)


if __name__ == "__main__":
    tests = [(k, v) for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    failed = 0
    for name, fn in tests:
        t0 = time.monotonic()
        try:
            fn()
            print("ok   %s (%.1f s)" % (name, time.monotonic() - t0))
        except Exception as e:
            failed += 1
            import traceback
            traceback.print_exc()
            print("FAIL %s: %s" % (name, e))
    print("%s: %d of %d" % ("FAILED" if failed else "ok", len(tests) - failed, len(tests)))
    sys.exit(1 if failed else 0)
