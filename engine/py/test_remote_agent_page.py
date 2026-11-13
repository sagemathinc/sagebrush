"""The Agents page's real agent leg (web/workspace/agent-relay.ts), its pairing and its permission cards, against a real
runner, end to end (Chat here): the page runs under bun (remote_agent_page.mjs) with a real WebCrypto key and real DPoP
proofs, its socket bridged over stdio to this test, which plays the relay (test_remote_relay's FakeRelay) in front of a
RelayRunner whose agent is the vendored sagebrush-agent 0.5.0 (its fake model). Checked:
- chat turns with the page's workspace verbs;
- "search": the permission card, Allow with the page's digest, and the agent's "You allowed"; a wrong digest, and a
  right action's digest under another request_id, refused;
- the shared vector: the page's digest and the vendored agent's own permissionDigest agree (non-ASCII, escapes, key
  order, lone surrogates);
- an envelope of exactly F is carried, F + 1 refused by the page with the leg kept; a 7 MiB write refused as an error
  result, the leg kept, the next turn working;
- a message changed by one byte after signing, and one sent twice (its jti), refused by the runner;
- the hello's iat at both edges on a held clock, and its jti used twice;
- a second tab's refusal, in the runner's words;
- a runner offering two kinds: the page asks for one by name and chats with that kind's agent, the other kind
  untouched; a kind not offered, refused in the runner's words;
- Disconnect: grant.changed {}, then {"unpair":true}, then the agent's process group gone;
- the branch and run tools: each reaches the page's verb exactly, and latex_build's pages pass the agent's PNG check.

    python engine/py/test_remote_agent_page.py
"""
import asyncio
import base64
import json
import os
import shutil
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from test_remote_agent import Run, STUB_DEPS, unpack_vendored, group_gone, until  # noqa: E402
from test_remote_pair import aio  # noqa: E402
from sagebrush.remote import agent_child as A  # noqa: E402

PAGE = os.path.join(HERE, "remote_agent_page.mjs")
BUN = shutil.which("bun")
NODE = shutil.which("node")
ROOT = os.path.dirname(os.path.dirname(HERE))


def vendored_cmd():
    pkg = unpack_vendored()
    return pkg, ["env", "SAGEBRUSH_AGENT_FAKE=1", NODE, "--import", STUB_DEPS, os.path.join(pkg, "bin", "sagebrush-agent.mjs"), "--stdio"]


def claims(envelope_text):
    p = json.loads(envelope_text)["p"].split(".")[1]
    return json.loads(base64.urlsafe_b64decode(p + "=" * (-len(p) % 4)))


class Page:
    """One page process, bridged to the relay's leg as page generation `gen`."""

    def __init__(self, run, hold_hello=False, kind=None):
        self.run, self.leg, self.kind = run, run.leg, kind
        self.events, self.sent, self.hello, self.hold_hello = [], [], None, hold_hello

    async def start(self):
        self.run.gen += 1
        self.gen = self.run.gen
        self.leg.control(relay="page-open", conn="c%d" % self.gen, kind="runner", chan="agent", gen=self.gen)
        self.proc = await asyncio.create_subprocess_exec(BUN, PAGE, self.run.key.remote_id, *([self.kind] if self.kind else []), stdin=asyncio.subprocess.PIPE,
                                                         stdout=asyncio.subprocess.PIPE, cwd=ROOT, limit=16 * 1024 * 1024)
        self.reader = asyncio.ensure_future(self._read())
        return self

    async def _read(self):
        while True:
            line = await self.proc.stdout.readline()
            if not line:
                return
            kind, _, rest = line.decode().rstrip("\n").partition(" ")
            if kind == "W":
                if rest.startswith('{"relay":'):
                    if rest == '{"relay":"ping"}':
                        self.to_page('{"relay":"pong"}')
                    continue
                self.sent.append(rest)
                if self.hold_hello and self.hello is None:
                    self.hello = rest  # (held: the test decides when, and how often, it reaches the runner)
                    continue
                self.forward(rest)
            elif kind == "E":
                self.events.append(json.loads(rest))

    def forward(self, text, gen=None):
        # (the page's exact text, as the relay forwards it: never re-serialized)
        self.leg.send_text("%d\n%s" % (self.gen if gen is None else gen, text))

    def to_page(self, text):
        self.proc.stdin.write(("R " + text + "\n").encode())

    def cmd(self, **c):
        self.proc.stdin.write(("C " + json.dumps(c) + "\n").encode())

    def ev(self, t):
        return [e for e in self.events if e["t"] == t]

    def said(self, needle, since=0):
        """The agent's text since event `since`, its deltas joined, contains `needle`."""
        text = "".join(e["params"]["event"].get("text", "") for e in self.events[since:] if e["t"] == "notify" and e["params"].get("event", {}).get("type") == "text_delta")
        return needle in text

    async def end(self):
        try:
            self.proc.kill()
        except ProcessLookupError:
            pass
        await self.proc.wait()
        self.reader.cancel()


async def pump(run, pages, cond, timeout=30):
    """The runner's messages to the page of their generation, and its closes, until cond() or the timeout."""
    loop = asyncio.get_running_loop()
    end = loop.time() + timeout
    by_gen = {p.gen: p for p in pages}
    run.__dict__.setdefault("seen", 0)
    run.__dict__.setdefault("ctl", 0)
    while not cond():
        for c in run.leg.controls[run.ctl:]:
            if c.get("relay") == "close" and c.get("gen") in by_gen:
                by_gen[c["gen"]].proc.stdin.write(b"CLOSE\n")
        run.ctl = len(run.leg.controls)
        if loop.time() > end:
            return False
        try:
            kind, v = await asyncio.wait_for(run.leg.inbox.get(), 0.2)
        except asyncio.TimeoutError:
            continue
        if kind == "text":
            g = run.leg.got_gens[run.seen]
            run.seen += 1
            if g in by_gen:
                by_gen[g].to_page(v)
    return True


def skip():
    if BUN is None or NODE is None:
        print("  (no bun or no node) SKIPPED")
        return True
    return False


async def paired_page(run, **kw):
    p = await Page(run, **kw).start()
    assert await pump(run, [p], lambda: p.ev("paired") or p.ev("end"), 60), p.events
    assert p.ev("paired"), p.events
    p.cmd(do="grant")
    assert await pump(run, [p], lambda: p.ev("granted"), 10), p.events
    return p


async def turn(run, p, text, mid, timeout=60):
    """One chat message; the turn's events until it finishes."""
    p.cmd(do="chat", text=text, id=mid)
    mine = lambda: [e["params"]["event"] for e in p.events if e["t"] == "notify" and e["method"] == "turn.event" and e["params"].get("in_reply_to") == mid]
    assert await pump(run, [p], lambda: any(e["type"] == "turn_finished" for e in mine()), timeout), p.events[-5:]
    return mine()


@aio
async def test_chat_search_digest_and_limits_with_the_vendored_agent():
    if skip():
        return
    pkg, cmd = vendored_cmd()
    run = await Run().start(cmd=cmd)
    try:
        p = await paired_page(run)
        child = p.ev("paired")[0]["child"]
        assert child and p.ev("paired")[0]["agent"]["version"] == "0.5.0", p.ev("paired")
        # (a 7 MiB write: refused inside the agent as an error result; the leg kept; the next turn works)
        events = await turn(run, p, "big 7340032", "m0")
        done = [e for e in events if e["type"] == "tool_call_finished"]
        assert done and done[0]["status"] == "error" and "over this connection's limit" in done[0]["body"], [(e["type"], str(e)[:200]) for e in events]
        assert not p.ev("end")
        # (the next turn: a tool that writes through the page's workspace verbs)
        await turn(run, p, "big 10", "m1")
        p.cmd(do="files")
        assert await pump(run, [p], lambda: p.ev("files"), 5)
        assert p.ev("files")[-1]["files"].get("/big.txt") == 10, p.ev("files")
        # (search: the card, Allow with the page's digest, the agent's "You allowed")
        n = len(p.events)
        p.cmd(do="chat", text="search cats", id="m2")
        assert await pump(run, [p], lambda: any(e["t"] == "notify" and e["params"].get("event", {}).get("type") == "attention" for e in p.events[n:]), 60)
        card = next(e["params"]["event"] for e in p.events[n:] if e["t"] == "notify" and e["params"].get("event", {}).get("type") == "attention")
        assert card["child"] == child and card["request_id"] == card["id"] and card["conversation"] == "c1", card
        p.cmd(do="answer", id=card["id"], allow=True)
        assert await pump(run, [p], lambda: p.said("You allowed the search"), 30), p.events[-4:]
        # (a wrong digest: refused; the right action's digest under another request_id: refused)
        for name, extra in (("wrong", {"digest": "A" * 43}), ("another request", {"digestRequest": "perm-000000000000"})):
            n = len(p.events)
            p.cmd(do="chat", text="search dogs", id="m-" + name)
            assert await pump(run, [p], lambda: any(e["t"] == "notify" and e["params"].get("event", {}).get("type") == "attention" and e["params"]["event"]["state"] == "open" for e in p.events[n:]), 60)
            card = next(e["params"]["event"] for e in p.events[n:] if e["t"] == "notify" and e["params"].get("event", {}).get("type") == "attention")
            p.cmd(do="permission", id=card["id"], card=card, **extra)
            assert await pump(run, [p], lambda: p.said("You said no to the search", n), 30), (name, p.events[-4:])
        # (an envelope of exactly F is carried; F + 1 is refused by the page, the leg kept)
        F = p.ev("open")[0]["frame"]
        assert F == A.AGENT_FRAME, F
        p.cmd(do="sized", id="m5", bytes=F)
        assert await pump(run, [p], lambda: p.ev("sent") and p.ev("sent")[-1].get("bytes") == F, 10), p.events[-3:]
        assert p.ev("sent")[-1]["r"] == "ok"
        assert await pump(run, [p], lambda: any(e["t"] == "notify" and e["params"].get("turn_id") and e["params"]["event"]["type"] == "turn_finished" and e["params"]["conversation"] == "c1" for e in p.events[-3:]), 60)
        p.cmd(do="sized", id="m6", bytes=F + 1)
        assert await pump(run, [p], lambda: p.ev("sent")[-1].get("bytes") == F + 1, 10)
        assert p.ev("sent")[-1]["r"] == "over" and not p.ev("end") and run.runner.agent is not None
        await turn(run, p, "big 3", "m7")
        # (a message changed by one byte after signing, then one sent twice: the runner refuses both, in words)
        last = next(t for t in reversed(p.sent) if '"chat.message"' in json.loads(t)["m"])
        env = json.loads(last)
        p.forward(json.dumps({**env, "m": env["m"].replace("big 3", "big 4")}, separators=(",", ":")))
        assert await pump(run, [p], lambda: any("can't verify (htu)" in e["text"] for e in p.ev("notice")), 10), p.ev("notice")
        p.forward(last)
        assert await pump(run, [p], lambda: any("can't verify (jti-reused)" in e["text"] for e in p.ev("notice")), 10), p.ev("notice")
        # (Disconnect: grant.changed {}, then the unpair, then the agent's group gone)
        pgid = run.runner.agent.pgid
        p.cmd(do="disconnect")
        assert await pump(run, [p], lambda: p.ev("end"), 10), p.events[-3:]
        tail = [json.loads(json.loads(t)["m"]) for t in p.sent[-2:]]
        assert tail == [{"jsonrpc": "2.0", "method": "grant.changed", "params": {}}, {"unpair": True}], tail
        assert p.ev("end")[-1]["end"]["kind"] == "disconnected", p.ev("end")
        await until(lambda: group_gone(pgid), timeout=5.0, what="the agent's group to end")
        assert run.runner.agent is None
        await p.end()
    finally:
        await run.end()


@aio
async def test_the_hello_iat_edges_and_its_jti_on_a_held_clock():
    if skip():
        return
    for name, shift, accepted in (("60 s in the past", 60, True), ("61 s in the past", 61, False), ("5 s ahead", -5, True), ("6 s ahead", -6, False)):
        run = await Run().start()
        p = await Page(run, hold_hello=True).start()
        try:
            assert await pump(run, [p], lambda: p.hello is not None, 10)
            run.clock.frozen = (claims(p.hello)["iat"] + shift) * 1000
            p.forward(p.hello)
            assert await pump(run, [p], lambda: p.ev("open") or p.ev("end"), 10), (name, p.events)
            assert bool(p.ev("open")) == accepted, (name, p.events)
            if not accepted:
                assert "iat" in p.ev("end")[0]["end"]["why"], (name, p.ev("end"))
            else:
                # (the same hello again, on a new page: its jti refused)
                q = await Page(run, hold_hello=True).start()
                assert await pump(run, [q], lambda: q.hello is not None, 10)
                q.forward(p.hello)
                assert await pump(run, [q], lambda: q.ev("end"), 10), (name, q.events)
                assert "jti-reused" in q.ev("end")[0]["end"]["why"], (name, q.ev("end"))
                await q.end()
        finally:
            await p.end()
            await run.end()


@aio
async def test_a_second_tab_is_refused_in_the_runners_words():
    if skip():
        return
    run = await Run().start()
    try:
        a = await Page(run).start()
        assert await pump(run, [a], lambda: a.ev("open"), 10)
        b = await Page(run).start()
        assert await pump(run, [a, b], lambda: b.ev("end"), 10), b.events
        e = b.ev("end")[0]["end"]
        assert e["kind"] == "refused" and e["why"].startswith("The agent is already open in another page or tab."), e
        assert not a.ev("end"), a.events
        await a.end()
        await b.end()
    finally:
        await run.end()


@aio
async def test_a_kind_asked_by_name_chats_with_that_kinds_agent():
    if skip():
        return
    _, cmd = vendored_cmd()
    run = await Run().start(agent_cmds=[("claude", cmd), ("codex", cmd)])
    try:
        p = await paired_page(run, kind="codex")
        o = p.ev("open")[0]
        assert o["agent"] == "codex" and o["agents"] == ["claude", "codex"], o
        slots = run.runner.slots
        assert slots["codex"].child is not None and slots["codex"].child.page is not None and slots["claude"].child is None
        assert any(e["type"] == "turn_finished" for e in await turn(run, p, "hello", "m1"))
        assert slots["claude"].child is None  # (the other kind never started)
        q = await Page(run, kind="gemini").start()
        assert await pump(run, [p, q], lambda: q.ev("end"), 10), q.events
        e = q.ev("end")[0]["end"]
        assert e == {"kind": "refused", "why": "This computer's runner doesn't offer gemini. It offers: claude, codex."}, e
        assert not p.ev("end"), p.events
        await p.end()
        await q.end()
    finally:
        await run.end()


@aio
async def test_branch_and_run_tools_reach_the_pages_verbs():
    """The vendored agent's branch and run tools, through the real runner and the page's real leg and pairing: each
    reaches the page's verb with its parameters exactly (the page side records them), and latex_build's two PNG pages
    pass the agent's PNG check (no "isn't a PNG" line), its result text with each page's n, w and h only. The page sees
    a tool's text only, so the image blocks themselves are the package's own rows'. (This page is a bun stand-in with
    no browser, so its verbs are a recording stand-in: real runs and builds are the page's own browser suites'.)"""
    if skip():
        return
    pkg, cmd = vendored_cmd()
    run = await Run().start(cmd=cmd)
    try:
        p = await paired_page(run)
        events = await turn(run, p, "branch and run", "m-br", 60)
        verbs = [(e["method"], e["params"]) for e in p.events if e["t"] == "verb"]
        assert verbs == [
            ("workspace.git_branch", {"name": "fake-work"}),
            ("workspace.git_commit", {"name": "fake-work", "message": "Fake work\n\nfrom the fake model", "review": True}),
            ("workspace.run_file", {"path": "/Branches/fake-work/hello.py", "timeout_s": 30}),
            ("workspace.latex_build", {"path": "/Branches/fake-work/main.tex", "pages": [1, 2]}),
        ], verbs
        done = [e for e in events if e["type"] == "tool_call_finished"]
        assert len(done) == 4 and all(e["status"] == "ok" for e in done), [(e["status"], e.get("body", "")[:120]) for e in done]
        latex = json.loads(done[3]["body"])
        assert latex["pages"] == [{"n": 1, "w": 1, "h": 1}, {"n": 2, "w": 1, "h": 1}], latex
        assert "png" not in done[3]["body"] and "isn't a PNG" not in done[3]["body"], done[3]["body"][:300]
        assert not p.ev("end")
    finally:
        await run.end()


def test_the_shared_vector_page_and_vendored_agent_agree():
    """The same cards through the page's permissionDigest (bun) and the vendored agent's own (node)."""
    if skip():
        return
    import subprocess
    pkg = unpack_vendored()
    cards = [
        {"child": "ch-1", "conversation": "conv-é", "request": "perm-1", "tool": "WebFetch", "input": {"url": "https://e/x"}},
        {"child": "ch-1", "conversation": "c", "request": "perm-2", "tool": "WebSearch", "input": {"query": "Größe € 😀 ü", "b": 1, "a": [True, None, 0]}},
        {"child": "ch-1", "conversation": "c", "request": "perm-3", "tool": "WebFetch", "input": {"z": "quote \" back \\ nl \n tab \t nul \u0000 del \u007f ls  ", "é": {"y": 1, "x": 2}, "": 3}},
        {"child": "ch-1", "conversation": "c", "request": "perm-4", "tool": "WebFetch", "input": {"high": "x\ud800y", "low": "\udfff", "end": "ab\udbff"}},
    ]
    src = json.dumps(cards)  # (ASCII, the surrogates as \\u escapes: both sides parse the same strings)
    page = subprocess.run([BUN, "-e", "import { permissionDigest } from './web/workspace/agent-canon.ts';"
                           "const cs = JSON.parse(process.argv.at(-1)); console.log(JSON.stringify(await Promise.all(cs.map((c) => permissionDigest(c)))));", src],
                          capture_output=True, text=True, timeout=60, cwd=ROOT)
    agent = subprocess.run([NODE, "--input-type=module", "-e", "const { permissionDigest } = await import(%s);"
                            "const cs = JSON.parse(process.argv.at(-1)); console.log(JSON.stringify(cs.map((c) => permissionDigest(c))));" % json.dumps("file://" + os.path.join(pkg, "lib", "canon.mjs")), src],
                           capture_output=True, text=True, timeout=60)
    a, b = json.loads(page.stdout), json.loads(agent.stdout)
    assert len(a) == len(cards) and all(isinstance(d, str) and len(d) == 43 for d in a), (page.stdout, page.stderr[-300:])
    assert a == b, (a, b, agent.stderr[-300:])


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print("ok", name)
    print("all remote agent page tests passed")
