"""The engine channel at the runner (remote r3, step P2a: sagebrush/remote/relay.py; design/remote-r3.md, H1, H2, H4,
H5), against test_remote_relay.py's fake relay, with a kernel double (the engine's and Native (Python)'s kernels are
P2c's and P2d's):

- the grammar: an engine page-open's identity (nb, entry, sgen, cgen), only for chan "engine" and never without it;
  {"relay":"cgen"}; bad notebooks, entries and generations refused;
- engine/1 said on the upgrade only with a kernel factory; without one an engine page is closed and binary is 1003;
- one kernel per (notebook, entry): started on the first page, kept across page loss, leg loss and reconnects, found
  again by a later page (fresh false); the notebook's page for another entry stops the other entry's kernel (H4);
  the notebook's newer page detaches the older;
- generations: a page whose sgen isn't above its notebook's last, or whose cgen is below the highest seen, is
  refused (its page only); a higher cgen detaches every engine page of the older one, kernels kept (H2, H5);
- the wire: text and binary both ways, with the prefix; binary for a page that isn't an engine page: 1008; over
  ENGINE_FRAME: that page 1009;
- the runner's figures equal the relay's (RUNNER_ENGINE_FRAME, ENGINE_ENTRIES).

    python engine/py/test_remote_engine_page.py
"""
import asyncio
import json
import os
import re
import sys

from sagebrush.remote import relay as R
from sagebrush.remote.gateway import drain_groups

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from test_remote_pair import aio  # noqa: E402
from test_remote_relay import FakeRelay, enrolled  # noqa: E402

R.RELAY_LIMITS["backoffMs"] = (50, 400)


class Kernel:
    """A kernel double: what happened to it, in order; it echoes text and reverses bytes."""

    made = []

    def __init__(self, nb, entry, on_end):
        self.nb, self.entry, self.on_end = nb, entry, on_end
        self.events = []
        self.page = None
        Kernel.made.append(self)

    def attach(self, page, fresh):
        self.page = page
        self.events.append(("attach", page.gen, fresh))
        page.send({"engine": "attached", "nb": self.nb, "entry": self.entry, "fresh": fresh})

    def detach(self, page):
        self.events.append(("detach", page.gen))
        if self.page is page:
            self.page = None

    def page_text(self, page, text):
        self.events.append(("text", text))
        page.send_text("echo:" + text, "data")

    def page_bytes(self, page, data):
        self.events.append(("bytes", data))
        page.send_bytes(data[::-1])

    def stop(self, why):
        self.events.append(("stop", why))


class Run:
    async def start(self, kernels=True):
        Kernel.made = []
        self.relay = await FakeRelay(None).start()
        self.key = enrolled(self.relay.origin)
        self.relay.key = self.key
        self.said = []
        self.runner = R.RelayRunner(self.key, err=self.said.append, rnd=lambda: 0.5, kernels=Kernel if kernels else None)
        self.stop = asyncio.Event()
        self.task = asyncio.ensure_future(self.runner.run(self.stop))
        return self

    async def end(self):
        self.stop.set()
        try:
            await asyncio.wait_for(self.task, 10)
        except Exception:
            pass
        self.runner.gateway.shutdown()
        if self.runner.engine is not None:
            self.runner.engine.stop_all("the runner stopped")
        await drain_groups(3.0)
        self.relay.stop()


def open_engine(leg, gen, nb="nbA", entry="sagebrush-magma", sgen=1, cgen=1):
    leg.control(relay="page-open", conn="c%d" % gen, kind="runner", chan="engine", gen=gen, nb=nb, entry=entry, sgen=sgen, cgen=cgen)


async def msg(leg, timeout=10):
    """The next text or binary message the runner sent a page: ("text", gen, obj-or-text) or ("binary", gen, bytes)."""
    while True:
        kind, v = await leg.next(timeout)
        if kind == "text":
            try:
                return ("text", leg.got_gens[-1], json.loads(v))
            except ValueError:
                return ("text", leg.got_gens[-1], v)
        if kind == "binary":
            return ("binary", v[0], v[1])
        if kind in ("close", "eof"):
            return (kind, None, v)


async def settle():
    await asyncio.sleep(0.15)


def test_grammar():
    ok = '{"relay":"page-open","conn":"c1","kind":"runner","chan":"engine","gen":1,"nb":"nbA","entry":"python","sgen":1,"cgen":1}'
    d = R.parse_control(ok)
    assert (d["nb"], d["entry"], d["sgen"], d["cgen"]) == ("nbA", "python", 1, 1)
    assert R.parse_control('{"relay":"cgen","cgen":3}') == {"relay": "cgen", "cgen": 3}
    for bad in [
        '{"relay":"page-open","conn":"c1","kind":"runner","chan":"engine","gen":1}',  # (an engine page without its identity)
        '{"relay":"page-open","conn":"c1","kind":"runner","chan":"kernel","gen":1,"nb":"nbA","entry":"python","sgen":1,"cgen":1}',
        ok.replace('"nb":"nbA"', '"nb":"a/b"'), ok.replace('"nb":"nbA"', '"nb":""'), ok.replace('"nb":"nbA"', '"nb":"%s"' % ("n" * 44)),
        ok.replace('"entry":"python"', '"entry":"sagebrush-gap"'), ok.replace('"sgen":1', '"sgen":0'), ok.replace('"cgen":1', '"cgen":0'),
        ok.replace('"sgen":1,"cgen":1', '"cgen":1,"sgen":1'), ok.replace('"cgen":1}', '"cgen":1.0}'),
        '{"relay":"cgen","cgen":0}', '{"relay":"cgen"}', '{"relay":"cgen","cgen":true}',
    ]:
        try:
            R.parse_control(bad)
            raise AssertionError("accepted: " + bad)
        except R.ControlError:
            pass
    assert R.split_prefix_bytes(b"12\n\x00\xff") == (12, b"\x00\xff")
    for bad in (b"0\n", b"\n\x00", b"07\n", b"x\n", b"12345678901234567\n"):
        try:
            R.split_prefix_bytes(bad)
            raise AssertionError("accepted: %r" % bad)
        except R.ControlError:
            pass


def test_figures_match_the_relay():
    caps = open(os.path.join(HERE, "../../web/cloud/remote/relay-caps.ts"), encoding="utf-8").read()
    frame = re.search(r"export const RUNNER_ENGINE_FRAME = ([^;]+);", caps).group(1).replace("1024", "(1024)")
    assert eval(frame, {"__builtins__": {}}) == R.ENGINE_FRAME, frame
    entries = re.search(r"export const ENGINE_ENTRIES = \[([^\]]+)\]", caps).group(1)
    assert tuple(json.loads("[%s]" % entries)) == R.ENGINE_ENTRIES, entries
    assert re.search(r'export const ENGINE_CAP = "([^"]+)"', caps).group(1) == R.ENGINE_CAP


@aio
async def test_engine_only_with_a_kernel_factory():
    t = await Run().start(kernels=False)
    try:
        leg = await t.relay.leg()
        assert t.relay.upgrades[-1]["caps"] is None and "engine" not in t.runner.channels()
        open_engine(leg, 1)
        await settle()
        assert {"relay": "close", "gen": 1} in leg.controls and not t.runner.leg.closed
        leg.raw(0x2, b"1\n\x00")
        assert (await leg.closed_with()) == 1003
    finally:
        await t.end()
    t = await Run().start()
    try:
        await t.relay.leg()
        assert t.relay.upgrades[-1]["caps"] == "engine/1" and t.runner.channels()[-1] == "engine"
    finally:
        await t.end()


@aio
async def test_kernels_by_notebook_and_entry():
    t = await Run().start()
    try:
        leg = await t.relay.leg()
        open_engine(leg, 1, nb="nbA", entry="sagebrush-magma", sgen=1)
        kind, gen, m = await msg(leg)
        assert (kind, gen, m) == ("text", 1, {"engine": "attached", "nb": "nbA", "entry": "sagebrush-magma", "fresh": True}), (kind, gen, m)
        k1 = Kernel.made[0]
        # (text and binary, both ways, with the prefix)
        leg.send_text('1\n{"hello":1}')
        assert await msg(leg) == ("text", 1, 'echo:{"hello":1}')
        leg.raw(0x2, b"1\n\x01\x02\x03")
        assert await msg(leg) == ("binary", 1, b"\x03\x02\x01")
        assert k1.events[1:] == [("text", '{"hello":1}'), ("bytes", b"\x01\x02\x03")]
        # (another notebook: its own kernel)
        open_engine(leg, 2, nb="nbB", entry="python", sgen=1)
        assert (await msg(leg))[2]["fresh"] is True and len(Kernel.made) == 2
        # (the page goes: its kernel is detached, kept; the notebook's next page finds it)
        leg.control(relay="page-close", conn="c1", gen=1)
        await settle()
        assert k1.events[-1] == ("detach", 1) and t.runner.engine.get("nbA", "sagebrush-magma") is k1
        open_engine(leg, 3, nb="nbA", entry="sagebrush-magma", sgen=2)
        assert (await msg(leg))[2]["fresh"] is False and len(Kernel.made) == 2 and k1.events[-1] == ("attach", 3, False)
        # (the notebook's newer page detaches the older: one page per notebook)
        open_engine(leg, 4, nb="nbA", entry="sagebrush-magma", sgen=3)
        assert (await msg(leg))[2]["fresh"] is False
        assert ("detach", 3) in k1.events and {"relay": "close", "gen": 3} in leg.controls
        # (H4: the notebook with another entry stops the other entry's kernel, and starts its own)
        open_engine(leg, 5, nb="nbA", entry="python", sgen=4)
        assert (await msg(leg))[2] == {"engine": "attached", "nb": "nbA", "entry": "python", "fresh": True}
        assert k1.events[-1][0] == "stop" and t.runner.engine.get("nbA", "sagebrush-magma") is None
        assert t.runner.engine.get("nbB", "python") is Kernel.made[1] and ("stop",) not in [e[:1] for e in Kernel.made[1].events]
    finally:
        await t.end()


@aio
async def test_generations():
    t = await Run().start()
    try:
        leg = await t.relay.leg()
        open_engine(leg, 1, nb="nbA", sgen=5, cgen=2)
        await msg(leg)
        k = Kernel.made[0]
        # (an sgen not above the notebook's last: that page refused, nothing else changes)
        for gen, sgen in ((2, 5), (3, 4)):
            open_engine(leg, gen, nb="nbA", sgen=sgen, cgen=2)
            await settle()
            assert {"relay": "close", "gen": gen} in leg.controls and len(Kernel.made) == 1 and k.page is not None, (gen, sgen)
        # (a cgen below the highest seen: refused)
        open_engine(leg, 4, nb="nbB", sgen=1, cgen=1)
        await settle()
        assert {"relay": "close", "gen": 4} in leg.controls and len(Kernel.made) == 1
        # (a higher cgen: every engine page of the older one detached, its kernel kept)
        leg.control(relay="cgen", cgen=3)
        await settle()
        assert {"relay": "close", "gen": 1} in leg.controls and k.page is None and t.runner.engine.get("nbA", "sagebrush-magma") is k
        assert not t.runner.leg.closed and t.runner.stats["violations"] == 0
        # (a page of the old generation now: refused; of the new one: the same kernel)
        open_engine(leg, 5, nb="nbA", sgen=6, cgen=2)
        await settle()
        assert {"relay": "close", "gen": 5} in leg.controls and k.page is None
        open_engine(leg, 6, nb="nbA", sgen=7, cgen=3)
        assert (await msg(leg))[2]["fresh"] is False and k.page is not None
        # (a page-open with a higher cgen advances it too: the older generation's pages detached)
        open_engine(leg, 7, nb="nbB", entry="python", sgen=1, cgen=4)
        await msg(leg)
        assert {"relay": "close", "gen": 6} in leg.controls and k.page is None and t.runner.cgen == 4
        # (a lower cgen control changes nothing)
        leg.control(relay="cgen", cgen=2)
        await settle()
        assert t.runner.cgen == 4 and Kernel.made[1].page is not None
    finally:
        await t.end()


@aio
async def test_kernels_outlive_the_leg():
    t = await Run().start()
    try:
        leg = await t.relay.leg()
        open_engine(leg, 1, nb="nbA", sgen=1, cgen=1)
        await msg(leg)
        k = Kernel.made[0]
        leg.drop()
        leg2 = await t.relay.leg()
        assert ("detach", 1) in k.events and t.runner.engine.get("nbA", "sagebrush-magma") is k
        # (the new leg's page generations start again; the notebook's sgen goes on)
        open_engine(leg2, 1, nb="nbA", sgen=2, cgen=1)
        assert (await msg(leg2))[2]["fresh"] is False and len(Kernel.made) == 1
        open_engine(leg2, 2, nb="nbA", sgen=2, cgen=1)
        await settle()
        assert {"relay": "close", "gen": 2} in leg2.controls, "an sgen already used, across legs"
    finally:
        await t.end()
    assert k.events[-1] == ("stop", "the runner stopped")


@aio
async def test_wire_refusals():
    t = await Run().start()
    try:
        leg = await t.relay.leg()
        # (binary for a page that isn't an engine page: 1008)
        leg.control(relay="page-open", conn="c1", kind="runner", chan="terminal", gen=1)
        await settle()
        leg.raw(0x2, b"1\n\x00")
        assert (await leg.closed_with()) == 1008
        leg = await t.relay.leg()
        # (binary without its prefix, or for no page: 1008)
        for bad in (b"\x00\x01", b"9\n\x00"):
            leg.raw(0x2, bad)
            assert (await leg.closed_with()) == 1008, bad
            leg = await t.relay.leg()
        # (an engine message over ENGINE_FRAME: that page only, 1009)
        open_engine(leg, 1, nb="nbA", sgen=1, cgen=1)
        await msg(leg)
        leg.raw(0x2, b"1\n" + b"\x00" * (R.ENGINE_FRAME + 1))
        await settle()
        assert {"relay": "close", "gen": 1} in leg.controls and not t.runner.leg.closed
        open_engine(leg, 2, nb="nbA", sgen=2, cgen=1)
        await msg(leg)
        leg.raw(0x2, b"2\n" + b"\x00" * R.ENGINE_FRAME)
        kind, gen, data = await msg(leg)
        assert (kind, gen, len(data)) == ("binary", 2, R.ENGINE_FRAME), "exactly ENGINE_FRAME passes"
    finally:
        await t.end()


if __name__ == "__main__":
    for name, f in list(globals().items()):
        if name.startswith("test_") and callable(f):
            f()
            print("ok", name)
    print("all remote engine page tests passed")
