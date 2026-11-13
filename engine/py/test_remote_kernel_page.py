"""A notebook kernel on an enrolled computer through the relay, end to end: the page's own RemoteKernel and RemoteClient
(web/notebook/remote-kernel.js, remote-client.js) through its relay tunnel (web/notebook/relay-tunnel.js), run under bun
(remote_kernel_page.mjs) with a real WebCrypto key and real DPoP proofs, its socket bridged over stdio to this test,
which plays the relay (test_remote_relay's FakeRelay) in front of a real RelayRunner and its gateway.  Checked:
- the pairing on the kernel page leg: via "relay", the runner's channels, the frame limit held to the relay's cap;
- a run's output, an error's traceback, variables kept between runs, Stop of a busy run (the kernel and its variables
  still there), Restart (a fresh interpreter), and Disconnect;
- the relay's own controls (cloud relay.ts PAGE_OPS): this test's relay, like the real one, sends the page a receipt
  per 1 MiB it forwards on a kernel leg (min(1 MiB, the kernel window 8 MiB / 4), each message charged its bytes +
  256), and answers its pings; a run printing several MiB has every receipt acked with its own token, and the output
  whole; with the pongs dropped the page gives up after 2 unanswered pings (and not while they are answered).

    python engine/py/test_remote_kernel_page.py
"""
import asyncio
import base64
import json
import os
import shutil
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from test_remote_terminal import Run, recv, NODE  # noqa: E402
from test_remote_pair import aio  # noqa: E402

PAGE = os.path.join(HERE, "remote_kernel_page.mjs")
BUN = shutil.which("bun")
RECEIPT_EVERY = 1024 * 1024    # (relay.ts: min(receiptEvery 1 MiB, the kernel window 8 MiB / 4))
OVERHEAD = 256                 # (relay.ts RELAY_LIMITS.overhead: charged on top of each message's bytes)
RELAY_CAP = round(2.25 * 1024 * 1024) + 64 * 1024  # (relay-caps.ts: a kernel page's message, page to runner)


class Page:
    """One bun page process bridged to one kernel page leg of generation `gen`."""

    def __init__(self, t, leg, gen, pongs=True):
        self.t, self.leg, self.gen = t, leg, gen
        self.events, self.sent = [], []
        # (the relay's side of this page leg: what it charged, its receipts' tokens, the page's acks and pings)
        self.pongs, self.charged, self.since, self.tokens, self.acked, self.pings, self.bad = pongs, 0, 0, [], [], 0, []

    async def start(self, scenario, ping_ms=None):
        self.leg.control(relay="page-open", conn="c%d" % self.gen, kind="runner", chan="kernel", gen=self.gen)
        env = dict(os.environ, **({"PING_MS": str(ping_ms)} if ping_ms else {}))
        self.proc = await asyncio.create_subprocess_exec(BUN, PAGE, self.t.key.remote_id, scenario, stdin=asyncio.subprocess.PIPE,
                                                         env=env, stdout=asyncio.subprocess.PIPE, cwd=os.path.dirname(HERE),
                                                         limit=16 * 1024 * 1024)
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
                assert len(rest.encode()) <= RELAY_CAP, len(rest)
                self.leg.send(msg, gen=self.gen)
            elif kind == "E":
                self.events.append(json.loads(rest))

    def _to_page(self, text):
        self.proc.stdin.write((text + "\n").encode())

    def deliver(self, msg):
        text = json.dumps(msg, separators=(",", ":"))
        self._to_page(text)
        # (charged as the relay charges it; a receipt behind the data once 1 MiB went since the last)
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

    def event(self, t):
        return next(e for e in self.events if e["t"] == t)

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


def skipped():
    if NODE is None or BUN is None:
        print("  (no node or no bun) SKIPPED")
        return True
    return False


@aio
async def test_a_notebook_kernel_through_the_relay():
    if skipped():
        return
    t = await Run().start()
    try:
        leg = await t.relay.leg()
        p = await Page(t, leg, 1).start("run")
        assert await pump(leg, [p], lambda: "done" in p.kinds() or "error" in p.kinds(), 90), p.events
        assert "error" not in p.kinds(), p.events
        paired = p.event("paired")
        assert "kernel" in paired["channels"] and paired["frameMax"] == RELAY_CAP, paired
        assert p.event("started")["ok"] is True, p.events
        run = p.event("run")
        assert run["text"] == "hello via the relay cpython\n42\n" and run["terminal"][0] == "done", run
        err = p.event("error-run")
        assert "ZeroDivisionError" in err["text"] + err["errors"], err
        assert p.event("again")["text"] == "43\n", p.events
        stopped = p.event("stopped")
        assert not stopped["timeout"] and stopped["terminal"] is not None, stopped
        assert p.event("after-stop")["text"] == "42\n", p.events
        assert p.event("after-restart")["text"] == "False\n", p.events
        # (Disconnect: the page closed its leg itself, 1000)
        assert any(e["t"] == "socket-close" and e["code"] == 1000 for e in p.events), p.events
        # (every request went as pair-tunnel's frame; the hello carried no code and no session)
        hello = next(m for m in p.sent if m.get("method") == "hello")
        assert hello["params"]["via"] == "relay" and "code" not in hello["params"] and "session" not in hello["params"], hello
        assert sum(1 for m in p.sent if "rpc" in m) >= 6, len(p.sent)
        assert not p.bad, p.bad
        await p.end()
    finally:
        await t.end()


@aio
async def test_a_big_output_acks_every_receipt():
    if skipped():
        return
    t = await Run().start()
    try:
        leg = await t.relay.leg()
        p = await Page(t, leg, 1).start("big")
        assert await pump(leg, [p], lambda: "done" in p.kinds() or "error" in p.kinds(), 120), p.events[-3:]
        big = p.event("big")
        assert big["bytes"] == 30000 * 100 + len("big-done\n") and big["tail"] == "big-done\n" and big["terminal"][0] == "done", big
        assert p.charged > 2 * RECEIPT_EVERY and len(p.acked) >= 2 and not p.tokens and not p.bad, (p.charged, len(p.acked), p.tokens, p.bad)
        await p.end()
    finally:
        await t.end()


@aio
async def test_no_pong_and_the_page_gives_up():
    if skipped():
        return
    t = await Run().start()
    try:
        leg = await t.relay.leg()
        # (control: pongs answered, pings every 100 ms: still paired after 1.2 s)
        ok = await Page(t, leg, 1).start("idle", ping_ms=100)
        assert await pump(leg, [ok], lambda: "paired" in ok.kinds(), 15), ok.events
        await pump(leg, [ok], lambda: False, 1.2)
        assert ok.pings >= 5 and "closed" not in ok.kinds(), (ok.pings, ok.kinds())
        await ok.end()
        # (pongs dropped: after 2 pings unanswered the page ends its leg, 4002, "no pong")
        p = await Page(t, leg, 2, pongs=False).start("idle", ping_ms=100)
        assert await pump(leg, [p], lambda: "closed" in p.kinds() or "error" in p.kinds(), 10), p.events
        if "paired" in p.kinds():
            closed = p.event("closed")
            sock = p.event("socket-close")
            assert closed["why"] == "no pong" and sock["code"] == 4002, p.events
        else:
            # (the hello's answer came after the pongs stopped: the pairing itself fails, the leg closed)
            err = p.event("error")
            assert err["name"] == "PairError" and "no pong" in err["message"], p.events
        assert p.pings == 2, p.pings
        await p.end()
    finally:
        await t.end()


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print("ok", name)
    print("all remote kernel page tests passed")
