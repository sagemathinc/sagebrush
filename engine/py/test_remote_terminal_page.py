"""The page's real terminal client (web/notebook/remote-terminal.js, step T-3) against a real runner, end to end: the
client runs under bun (remote_terminal_page.mjs; bun runs the page's modules, as in test_remote_pair) with a real WebCrypto key and real DPoP proofs, its socket bridged
over stdio to this test, which plays the relay (test_remote_relay's FakeRelay) in front of a RelayRunner with real
PTYs.  Checked:
- the runner's hello lists its channels, `terminal` included (default on, T6);
- echo: open, replay, live, typed input reaching the shell, its answer drawn, every byte acked, the exit last;
- Ctrl-C: input reaching the line discipline (the foreground program ends by SIGINT, the shell goes on);
- reattach: a second page (a fresh hello and proof) takes the session over and replays the earlier output;
- the relay's own controls (cloud relay.ts PAGE_OPS): this test's relay, like the real one, sends the page a receipt
  per 256 KiB it forwards (min(1 MiB, the terminal window 1 MiB / 4), each message charged its bytes + 256) and
  answers its pings; a flood's every receipt is acked with its own token, and with the pongs dropped the page gives
  up after 2 unanswered pings (and not while they are answered).

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
FLOOD = shell("flood.sh", "%s -I -S -c \"import sys\nfor i in range(40000): sys.stdout.write('%%06d' %% i + 'y' * 73 + chr(10))\"\necho flood-done\nexit 0\n" % PY)
RECEIPT_EVERY = 256 * 1024     # (relay.ts: min(receiptEvery 1 MiB, the terminal window 1 MiB / 4))
OVERHEAD = 256                 # (relay.ts RELAY_LIMITS.overhead: charged on top of each message's bytes)
INTSH = shell("int.sh", "trap 'echo trapped' INT\n%s -I -S -c \"import time; time.sleep(60)\"\necho after-int\nexit 4\n" % PY)
STAY = shell("stay.sh", "echo first-marker\nwhile :; do sleep 0.05; done\n")


class Page:
    """One node page process bridged to one relay page leg of generation `gen`."""

    def __init__(self, t, leg, gen, pongs=True):
        self.t, self.leg, self.gen = t, leg, gen
        self.events, self.data, self.sent = [], bytearray(), []
        # (the relay's side of this page leg: what it charged, its receipts' tokens, the page's acks and pings)
        self.pongs, self.charged, self.since, self.tokens, self.acked, self.pings, self.bad = pongs, 0, 0, [], [], 0, []

    async def start(self, scenario, session=None, ping_ms=None):
        self.leg.control(relay="page-open", conn="c%d" % self.gen, kind="runner", chan="terminal", gen=self.gen)
        args = [BUN, PAGE, self.t.key.remote_id, scenario] + ([session] if session else [])
        env = dict(os.environ, **({"PING_MS": str(ping_ms)} if ping_ms else {}))
        self.proc = await asyncio.create_subprocess_exec(*args, stdin=asyncio.subprocess.PIPE, env=env,
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
                if "relay" in msg:
                    # (a control to the relay: it stays here, never forwarded to the runner)
                    if rest == '{"relay":"ping"}':
                        self.pings += 1
                        if self.pongs:
                            self._to_page('{"relay":"pong"}')
                    elif msg.get("relay") == "ack" and list(msg) == ["relay", "r"] and msg["r"] in self.tokens:
                        self.tokens.remove(msg["r"])
                        self.acked.append(msg["r"])
                    else:
                        self.bad.append(rest)
                    continue
                self.leg.send(msg, gen=self.gen)
            elif kind == "E":
                self.events.append(json.loads(rest))
            elif kind == "D":
                self.data += base64.b64decode(rest)

    def _to_page(self, text):
        self.proc.stdin.write((text + "\n").encode())

    def deliver(self, msg):
        text = json.dumps(msg, separators=(",", ":"))
        self._to_page(text)
        # (charged as the relay charges it; a receipt behind the data once 256 KiB went since the last)
        n = len(text.encode()) + OVERHEAD
        self.charged += n
        self.since += n
        if self.since >= RECEIPT_EVERY:
            self.since = 0
            r = base64.urlsafe_b64encode(os.urandom(16)).decode().rstrip("=")
            self.tokens.append(r)
            self._to_page('{"relay":"receipt","r":"%s","upto":%d}' % (r, self.charged))

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


@aio
async def test_a_flood_acks_every_receipt():
    if NODE is None or BUN is None:
        print("  (no node or no bun) SKIPPED")
        return
    t = await Run().start(sh=FLOOD)
    try:
        leg = await t.relay.leg()
        p = await Page(t, leg, 1).start("none")
        assert await pump(leg, [p], lambda: "exit" in p.kinds() or "closed" in p.kinds(), 60), (p.kinds(), len(p.data))
        assert "exit" in p.kinds() and b"flood-done" in p.data, (p.kinds(), bytes(p.data[-80:]))
        assert len(p.acked) >= 10 and not p.tokens and not p.bad, (len(p.acked), p.tokens, p.bad)
        assert not [e for e in p.events if e["t"] == "error"], p.events
        await p.end()
    finally:
        await t.end()


@aio
async def test_no_pong_and_the_page_gives_up():
    if NODE is None or BUN is None:
        print("  (no node or no bun) SKIPPED")
        return
    t = await Run().start(sh=STAY)
    try:
        leg = await t.relay.leg()
        # (control: pongs answered, pings every 100 ms: still alive after 1 s)
        ok = await Page(t, leg, 1).start("none", ping_ms=100)
        await pump(leg, [ok], lambda: False, 1.2)
        assert ok.pings >= 5 and "closed" not in ok.kinds() and "socket-close" not in ok.kinds(), (ok.pings, ok.kinds())
        await ok.end()
        # (pongs dropped: after 2 pings unanswered the page ends, its own error and close 4002)
        p = await Page(t, leg, 2, pongs=False).start("none", ping_ms=100)
        assert await pump(leg, [p], lambda: "closed" in p.kinds(), 5), p.kinds()
        err = next(e for e in p.events if e["t"] == "error")
        closed = next(e for e in p.events if e["t"] == "closed")
        assert err["error"] == "relay" and err["reason"] == "no pong" and closed["code"] == 4002 and p.pings == 2, (p.events, p.pings)
        await p.end()
    finally:
        await t.end()


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print("ok", name)
    print("all remote terminal page tests passed")
