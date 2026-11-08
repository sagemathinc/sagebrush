"""The page's real terminal client (web/notebook/remote-terminal.js, step T-3) against a real runner, end to end: the
client runs under bun (remote_terminal_page.mjs; bun runs the page's modules, as in test_remote_pair) with a real WebCrypto key and real DPoP proofs, its socket bridged
over stdio to this test, which plays the relay (test_remote_relay's FakeRelay) in front of a RelayRunner with real
PTYs.  Checked:
- the runner's hello lists its channels, `terminal` included (default on, T6);
- echo: open, replay, live, typed input reaching the shell, its answer drawn, every byte acked, the exit last;
- Ctrl-C: input reaching the line discipline (the foreground program ends by SIGINT, the shell goes on);
- reattach: a second page (a fresh hello and proof) takes the session over and replays the earlier output.

    python engine/py/test_remote_terminal_page.py
"""
import asyncio
import base64
import json
import os
import shutil
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from test_remote_terminal import Run, recv, shell, NODE  # noqa: E402
from test_remote_pair import aio, hello as pair_hello, Signer  # noqa: E402

PAGE = os.path.join(HERE, "remote_terminal_page.mjs")
BUN = shutil.which("bun")
PY = sys.executable
ECHO = shell("echo.sh", "read l\necho \"got:$l\"\nexit 0\n")
INTSH = shell("int.sh", "trap 'echo trapped' INT\n%s -I -S -c \"import time; time.sleep(60)\"\necho after-int\nexit 4\n" % PY)
STAY = shell("stay.sh", "echo first-marker\nwhile :; do sleep 0.05; done\n")


class Page:
    """One node page process bridged to one relay page leg of generation `gen`."""

    def __init__(self, t, leg, gen):
        self.t, self.leg, self.gen = t, leg, gen
        self.events, self.data, self.sent = [], bytearray(), []

    async def start(self, scenario, session=None):
        self.leg.control(relay="page-open", conn="c%d" % self.gen, kind="runner", chan="terminal", gen=self.gen)
        args = [BUN, PAGE, self.t.key.remote_id, scenario] + ([session] if session else [])
        self.proc = await asyncio.create_subprocess_exec(*args, stdin=asyncio.subprocess.PIPE,
                                                         stdout=asyncio.subprocess.PIPE, cwd=os.path.dirname(HERE))
        self.reader = asyncio.ensure_future(self._read())
        return self

    async def _read(self):
        while True:
            line = await self.proc.stdout.readline()
            if not line:
                return
            kind, _, rest = line.decode().rstrip("\n").partition(" ")
            if kind == "W":
                msg = json.loads(rest)
                self.sent.append(msg)
                self.leg.send(msg, gen=self.gen)
            elif kind == "E":
                self.events.append(json.loads(rest))
            elif kind == "D":
                self.data += base64.b64decode(rest)

    def deliver(self, msg):
        self.proc.stdin.write((json.dumps(msg, separators=(",", ":")) + "\n").encode())

    def kinds(self):
        return [e["t"] for e in self.events]

    async def end(self):
        try:
            self.proc.kill()
        except ProcessLookupError:
            pass
        await self.proc.wait()
        self.reader.cancel()


async def pump(leg, pages, until_fn, timeout=20):
    """Forward the runner's messages to the page of their generation until until_fn() or the timeout."""
    loop = asyncio.get_running_loop()
    end = loop.time() + timeout
    by_gen = {p.gen: p for p in pages}
    while not until_fn():
        left = end - loop.time()
        if left <= 0:
            return False
        try:
            g, m = await recv(leg, min(left, 0.5), stream=True)
        except asyncio.TimeoutError:
            continue
        if g in by_gen:
            by_gen[g].deliver(m)
    return True


@aio
async def test_hello_lists_terminal():
    if NODE is None or BUN is None:
        print("  (no node or no bun) SKIPPED")
        return
    sg = await Signer().start()
    t = await Run().start(sh=STAY)
    try:
        leg = await t.relay.leg()
        leg.control(relay="page-open", conn="c1", kind="runner", chan="kernel", gen=1)
        leg.send(pair_hello(sg), gen=1)
        g, r = await recv(leg)
        assert r["result"]["channels"] == ["kernel", "terminal"], r
    finally:
        await t.end()
        sg.close()


@aio
async def test_echo_end_to_end():
    if NODE is None or BUN is None:
        print("  (no node or no bun) SKIPPED")
        return
    t = await Run().start(sh=ECHO)
    try:
        leg = await t.relay.leg()
        p = await Page(t, leg, 1).start("echo")
        assert await pump(leg, [p], lambda: "exit" in p.kinds(), 20), (p.kinds(), bytes(p.data[-80:]))
        k = p.kinds()
        assert k.index("opened") < k.index("live") < k.index("exit") and k[-1] in ("exit", "closed", "socket-close"), k
        assert b"got:hello-e2e" in p.data, bytes(p.data)
        exit_ev = next(e for e in p.events if e["t"] == "exit")
        assert exit_ev["code"] == 0, exit_ev
        acks = [m["upto"] for m in p.sent if m.get("t") == "ack"]
        assert acks and acks[-1] == len(p.data), (acks[-3:], len(p.data))
        assert not [e for e in p.events if e["t"] == "error"], p.events
        await p.end()
    finally:
        await t.end()


@aio
async def test_ctrl_c_reaches_the_line_discipline():
    if NODE is None or BUN is None:
        print("  (no node or no bun) SKIPPED")
        return
    t = await Run().start(sh=INTSH)
    try:
        leg = await t.relay.leg()
        p = await Page(t, leg, 1).start("ctrlc")
        assert await pump(leg, [p], lambda: "exit" in p.kinds(), 20), (p.kinds(), bytes(p.data[-80:]))
        assert b"after-int" in p.data, bytes(p.data)
        assert next(e for e in p.events if e["t"] == "exit")["code"] == 4
        await p.end()
    finally:
        await t.end()


@aio
async def test_reattach_with_a_fresh_proof_replays():
    if NODE is None or BUN is None:
        print("  (no node or no bun) SKIPPED")
        return
    t = await Run().start(sh=STAY)
    try:
        leg = await t.relay.leg()
        p1 = await Page(t, leg, 1).start("none")
        assert await pump(leg, [p1], lambda: b"first-marker" in p1.data, 15)
        sid = next(e for e in p1.events if e["t"] == "opened")["session"]
        p2 = await Page(t, leg, 2).start("none", session=sid)
        assert await pump(leg, [p1, p2], lambda: "live" in p2.kinds() and "elsewhere" in p1.kinds(), 15), (p1.kinds(), p2.kinds())
        assert p2.data.startswith(b"\x1bc") and b"first-marker" in p2.data
        opens = [m for m in p1.sent + p2.sent if m.get("t") == "open"]
        assert len(opens) == 2 and opens[0]["dpop"] != opens[1]["dpop"]  # (each page its own key and proof)
        await p1.end()
        await p2.end()
    finally:
        await t.end()


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print("ok", name)
    print("all remote terminal page tests passed")
