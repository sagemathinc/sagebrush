"""`sagebrush remote` over the cloud relay (sagebrush/remote/relay.py; design remote-v1 §3-§5, §13.6; build step b3b),
against a fake relay written here on 127.0.0.1 (the challenge endpoint and the upgrade, as b1 and b2 serve them),
with the page's key a real WebCrypto P-256 key (remote_test_signer.mjs) and the runner's key its enrolled one:

- the control grammar (R17-CONTROL): each op in its one serialization; refused: whitespace, reordered, extra or
  missing keys, a key twice, escapes, floats, booleans, out-of-range numbers, unknown ops, over 256 bytes; and at
  the receiver, an application message with a top-level relay key is never acted on (the leg closes 1008);
- the client side of RFC 6455: masked frames out; refused in: masked frames, reserved bits, binary, bad lengths;
  fragments; ping answered; a close answered and reported;
- the upgrade: a fresh challenge per connection, signed by the enrolled key (checked here with the native verifier
  against the enrolled public key), the accept key checked, an extension refused;
- a page: page-open, the codeless hello (a code or session hello refused), bind and run with real DPoP proofs, its
  events; receipts acked with their token; one page at a time; page-close;
- robustness: a dropped leg dials again (backoff), the binding and its kernel kept (R1, the same incarnation);
  pings unanswered end the leg (R11); revoked (control and 4403) and replaced (4009) stop it, the kernels' groups
  emptied; a 404 challenge (unknown or revoked) stops it; 4429 backs off the longest;
- the proxy: HTTP CONNECT, with Basic auth, and a refusal;
- the CLI as a process: `sagebrush remote` with an enrolled key file, a run with a grandchild, Ctrl-C (R8): close
  1001, exit 0, the group gone.

    python engine/py/test_remote_relay.py
"""
import asyncio
import base64
import hashlib
import json
import os
import secrets
import shutil
import signal
import struct
import sys
import tempfile
import time

from sagebrush._native import remote as _native
from sagebrush.remote import keys as K
from sagebrush.remote import relay as R
from sagebrush.remote.gateway import drain_groups

HERE = os.path.dirname(os.path.abspath(__file__))
NODE = shutil.which("node")
sys.path.insert(0, HERE)
from test_remote_pair import Signer, Page, hello as pair_hello, aio  # noqa: E402

GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
R.RELAY_LIMITS["backoffMs"] = (50, 400)  # (fast reconnects in tests; the schedule itself is test_backoff's)


def b64u(b):
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode("ascii")


def hello(signer, **over):
    m = pair_hello(signer, **over)
    return m


# ================= the control grammar

def test_control_grammar():
    r22 = "A" * 22
    good = ['{"relay":"page-open","conn":"c1","kind":"runner","chan":"kernel","gen":1}',
            '{"relay":"page-open","conn":"c1","kind":"runner","chan":"terminal","gen":2}', '{"relay":"page-close","conn":"c1","gen":1}',
            '{"relay":"receipt","r":"%s","upto":1048576}' % r22, '{"relay":"revoked"}',
            '{"relay":"dropped","gen":3,"bytes":10}', '{"relay":"pong"}']
    for t in good:
        assert R.parse_control(t)["relay"] == json.loads(t)["relay"], t
    assert R.close_text(7) == '{"relay":"close","gen":7}'
    bad = [
        '{"relay":"pong" }', '{"relay":"pong","x":1}', '{"relay":"page-close","gen":1,"conn":"c1"}',
        '{"relay":"page-open","conn":"c1","kind":"runner"}', '{"relay":"pong","relay":"pong"}',
        '{"relay":"page-open","conn":"c1","kind":"runner","gen":1}', '{"relay":"page-open","conn":"c1","kind":"runner","chan":"box","gen":1}',
        '{"relay":"page-open","conn":"c1","kind":"runner","gen":1,"chan":"kernel"}',
        '{"relay":"p\\u006fng"}', '{"relay":"page-close","conn":"c1","gen":1.0}', '{"relay":"page-close","conn":"c1","gen":true}',
        '{"relay":"page-close","conn":"c1","gen":0}', '{"relay":"page-close","conn":"c1","gen":9007199254740992}',
        '{"relay":"page-close","conn":"c1","gen":1e2}', '{"relay":"page-close","conn":"c 1","gen":1}',
        '{"relay":"page-open","conn":"c1","kind":"box","chan":"kernel","gen":1}', '{"relay":"receipt","r":"short","upto":1}',
        '{"relay":"receipt","r":"%s","upto":-1}' % r22, '{"relay":"ping"}', '{"relay":"ack","r":"%s"}' % r22,
        '{"relay":"nope"}', '{"relay":"pong"}x', '{"relay":"page-open","conn":"%s","kind":"runner","chan":"kernel","gen":1}' % ("c" * 300),
        '{"relay":"page-close","conn":"c1","gen":NaN}', '{"relay":"page-close","conn":"c1","gen":[1]}',
        '{"relay":"page-close","conn":{"a":1},"gen":1}', '{"relay":5}',
    ]
    for t in bad:
        try:
            R.parse_control(t)
            raise AssertionError("accepted: " + t)
        except R.ControlError:
            pass
    assert R.ping_text() == '{"relay":"ping"}' and R.ack_text(r22) == '{"relay":"ack","r":"%s"}' % r22


def test_generation_prefix():
    """T1.4 §T2: `[1-9][0-9]{0,15}\n` then the exact payload; everything else refused."""
    assert R.split_prefix('7\n{"id":"x"}') == (7, '{"id":"x"}')
    assert R.split_prefix("9007199254740991\n") == (2 ** 53 - 1, "")
    assert R.split_prefix("1\n\n{}") == (1, "\n{}")  # (the payload's own bytes, a newline included, untouched)
    for bad in ('0\n{}', '07\n{}', '9007199254740992\n{}', '12345678901234567\n{}', '7{}', '7 \n{}', ' 7\n{}',
                '+7\n{}', '-7\n{}', '7\r\n{}', '{"id":"x"}', '', '\n{}', '٧\n{}'):
        try:
            R.split_prefix(bad)
            raise AssertionError("accepted: %r" % bad)
        except R.ControlError:
            pass


def test_backoff():
    fast = R.RELAY_LIMITS["backoffMs"]
    R.RELAY_LIMITS["backoffMs"] = (1_000, 60_000)  # (the design's schedule)
    try:
        for attempt, base in [(0, 1000), (1, 2000), (2, 4000), (5, 32000), (6, 60000), (40, 60000)]:
            lo, hi = R.backoff_ms(attempt, lambda: 0.0), R.backoff_ms(attempt, lambda: 1.0)
            assert lo == int(base * 0.8) and hi == int(base * 1.2), (attempt, lo, hi)
    finally:
        R.RELAY_LIMITS["backoffMs"] = fast


# ================= the fake relay

def read_head(buf):
    i = buf.find(b"\r\n\r\n")
    return (None, buf) if i < 0 else (buf[:i].decode("latin-1"), buf[i + 4:])


class RelaySide:
    """The relay's end of one leg: it reads the runner's masked frames and writes unmasked ones, and plays the page."""

    def __init__(self, relay, reader, writer, rest):
        self.relay, self.r, self.w = relay, reader, writer
        self.buf = bytearray(rest)
        self.inbox = asyncio.Queue()
        self.controls = []
        self.auto_pong = True
        self.window = relay.window  # (bytes the runner may send a page that never acks: over it, 1013 (design §5))
        self.sent_to_page = 0
        self.gen = 0  # (the page this side plays: its messages carry `<gen>\n` on the peer leg (T1.4 §T2))
        self.got_gens = []  # (the generation prefix of each application message the runner sent)
        self.closed_code = None
        self.task = asyncio.ensure_future(self._read())

    async def _read(self):
        try:
            while True:
                while True:
                    f = self._frame()
                    if f is None:
                        break
                    op, payload = f
                    if op == 0x1:
                        t = payload.decode("utf-8")
                        if t.startswith('{"relay":"'):
                            c = json.loads(t)
                            self.controls.append(c)
                            if c["relay"] == "ping" and self.auto_pong:
                                self.send_text('{"relay":"pong"}')
                            if c["relay"] == "close":
                                # (as b2 will: the page's leg closed, and its page-close to the runner)
                                self.send_text('{"relay":"page-close","conn":"c%d","gen":%d}' % (c["gen"], c["gen"]))
                            continue
                        head, _, t = t.partition("\n")
                        assert head.isdigit() and not head.startswith("0"), "an application message without its prefix: %r" % t[:40]
                        self.got_gens.append(int(head))
                        self.sent_to_page += len(t.encode())
                        if self.window is not None and self.sent_to_page > self.window:
                            self.close(1013, "the page isn't reading")
                            await self.inbox.put(("window", self.sent_to_page))
                            continue
                        await self.inbox.put(("text", t))
                    elif op == 0x8:
                        self.closed_code = int.from_bytes(payload[:2], "big") if len(payload) >= 2 else 1005
                        await self.inbox.put(("close", self.closed_code))
                    elif op == 0xA:
                        await self.inbox.put(("pong", payload))
                chunk = await self.r.read(65536)
                if not chunk:
                    await self.inbox.put(("eof", None))
                    return
                self.buf += chunk
        except (ConnectionError, asyncio.CancelledError):
            await self.inbox.put(("eof", None))

    def _frame(self):
        b = self.buf
        if len(b) < 2:
            return None
        assert b[1] & 0x80, "a client frame must be masked"
        n, at = b[1] & 0x7F, 2
        if n == 126:
            if len(b) < 4:
                return None
            n, at = struct.unpack(">H", bytes(b[2:4]))[0], 4
        elif n == 127:
            if len(b) < 10:
                return None
            n, at = struct.unpack(">Q", bytes(b[2:10]))[0], 10
        if len(b) < at + 4 + n:
            return None
        mask = bytes(b[at:at + 4])
        payload = bytes(x ^ mask[i & 3] for i, x in enumerate(b[at + 4:at + 4 + n]))
        op = b[0] & 0x0F
        del b[:at + 4 + n]
        return op, payload

    def raw(self, op, payload, fin=True, masked=False, rsv=0):
        b0 = (0x80 if fin else 0) | rsv | op
        n = len(payload)
        head = bytes([b0]) + (bytes([(0x80 if masked else 0) | n]) if n < 126 else bytes([(0x80 if masked else 0) | 126]) + struct.pack(">H", n)
                              if n < 65536 else bytes([(0x80 if masked else 0) | 127]) + struct.pack(">Q", n))
        if masked:
            head += b"\0\0\0\0"
        self.w.write(head + payload)

    def send_text(self, t):
        self.raw(0x1, t.encode("utf-8"))

    def send(self, obj, gen=None):
        self.send_text("%d\n%s" % (self.gen if gen is None else gen, json.dumps(obj)))

    def control(self, **kw):
        op = kw.pop("relay")
        if op == "page-open":
            kw = {"conn": kw["conn"], "kind": kw["kind"], "chan": kw.get("chan", "kernel"), "gen": kw["gen"]}
            self.gen = kw["gen"]
        self.send_text(json.dumps({"relay": op, **kw}, separators=(",", ":")))

    def close(self, code, reason=""):
        self.raw(0x8, code.to_bytes(2, "big") + reason.encode())

    def drop(self):
        self.w.transport.abort()

    async def next(self, timeout=30):
        return await asyncio.wait_for(self.inbox.get(), timeout)

    async def json(self, timeout=60):
        while True:
            kind, v = await self.next(timeout)
            if kind == "text":
                return json.loads(v)
            if kind in ("close", "eof"):
                return {"closed": v}

    async def closed_with(self, timeout=30):
        while True:
            kind, v = await self.next(timeout)
            if kind in ("close", "eof"):
                return v


class FakeRelay:
    def __init__(self, key):
        self.key = key
        self.challenges = {}
        self.agents = []  # (each challenge POST's User-Agent)
        self.challenge_status = 200
        self.upgrade_status = 101
        self.extension = False
        self.connection = "Upgrade"
        self.accept = None  # (grader's U1: a wrong Sec-WebSocket-Accept, when set)
        self.extra_head = ""  # (grader's U5: more header lines, a repeated one)
        self.window = None
        self.legs = asyncio.Queue()
        self.upgrades = []
        self.server = None

    async def start(self):
        self.server = await asyncio.start_server(self.handle, "127.0.0.1", 0)
        self.port = self.server.sockets[0].getsockname()[1]
        self.origin = "http://127.0.0.1:%d" % self.port
        return self

    def stop(self):
        self.server.close()

    async def handle(self, reader, writer):
        buf = b""
        while True:
            head, rest = read_head(buf)
            if head is not None:
                break
            chunk = await reader.read(4096)
            if not chunk:
                writer.close()
                return
            buf += chunk
        lines = head.split("\r\n")
        method, path, _ = lines[0].split(" ")
        h = {}
        for line in lines[1:]:
            k, _, v = line.partition(":")
            h[k.strip().lower()] = v.strip()
        if method == "POST" and path == "/api/remote/v1/challenge":
            self.agents.append(("challenge", h.get("user-agent")))
            n = int(h.get("content-length", "0"))
            while len(rest) < n:
                rest += await reader.read(4096)
            body = json.loads(rest[:n])
            if self.challenge_status != 200:
                ans, st = {"error": "unknown_remote"}, self.challenge_status
            else:
                assert body == {"remote_id": self.key.remote_id}, body
                c = "%s.%s" % (b64u(os.urandom(24)), b64u(os.urandom(32)))
                self.challenges[c] = False
                ans, st = {"challenge": c, "expires_in": 30}, 200
            b = json.dumps(ans).encode()
            writer.write(b"HTTP/1.1 %d X\r\ncontent-type: application/json\r\ncontent-length: %d\r\nconnection: close\r\n\r\n" % (st, len(b)) + b)
            await writer.drain()
            writer.close()
            return
        assert method == "GET" and path == R.RELAY_PATH, (method, path)
        c, sig = h.get("x-sb-remote-challenge"), h.get("x-sb-remote-signature")
        ok = c in self.challenges and not self.challenges[c] and sig is not None
        if ok:
            raw = base64.urlsafe_b64decode(sig + "=" * (-len(sig) % 4))
            ok = _native.es256_verify(self.key.x, self.key.y, ("sb-remote-chal/1\n" + c).encode(), raw)
            self.challenges[c] = True  # (single use)
        self.upgrades.append({"ok": ok, "challenge": c, "agent": h.get("user-agent"), "agents": h.get("x-sb-remote-agents")})
        if not ok or self.upgrade_status != 101:
            writer.write(b"HTTP/1.1 %d No\r\ncontent-length: 0\r\n\r\n" % (403 if not ok else self.upgrade_status))
            await writer.drain()
            writer.close()
            return
        accept = base64.b64encode(hashlib.sha1((h["sec-websocket-key"] + GUID).encode()).digest()).decode()
        ext = "Sec-WebSocket-Extensions: permessage-deflate\r\n" if self.extension else ""
        writer.write(("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: %s\r\n"
                      "Sec-WebSocket-Accept: %s\r\n%s%s\r\n" % (self.connection, self.accept or accept, ext, self.extra_head)).encode())
        await self.legs.put(RelaySide(self, reader, writer, rest))

    async def leg(self, timeout=30):
        return await asyncio.wait_for(self.legs.get(), timeout)


def enrolled(origin):
    k = K.RunnerKey.generate()
    k.remote_id, k.origin, k.name = "r" + "A" * 20, origin, "test-box"
    return k


class Run:
    """A RelayRunner against a fake relay, in this process."""

    async def start(self):
        self.relay = await FakeRelay(None).start()
        self.key = enrolled(self.relay.origin)
        self.relay.key = self.key
        self.said = []
        self.runner = R.RelayRunner(self.key, err=self.said.append, rnd=lambda: 0.5)
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
        await drain_groups(3.0)
        self.relay.stop()


async def paired(leg, sg, gen=1):
    leg.control(relay="page-open", conn="c%d" % gen, kind="runner", gen=gen)
    leg.send(hello(sg))
    r = await leg.json()
    assert "result" in r, r
    return Page(leg, sg, r["result"]["token"], r["result"]["nonce"]), r["result"]


# ================= the page, end to end over the relay

@aio
async def test_page_over_the_relay():
    if NODE is None:
        print("  (no node) SKIPPED")
        return
    sg = await Signer().start()
    t = await Run().start()
    try:
        leg = await t.relay.leg()
        assert t.relay.upgrades[-1]["ok"]
        # (the runner names itself on the challenge POST and on the upgrade alike: sagebrush.space's edge refuses
        # urllib's default agent (Cloudflare 1010))
        assert R.USER_AGENT == "sagebrush-remote/1" and t.relay.upgrades[-1]["agent"] == R.USER_AGENT, t.relay.upgrades[-1]
        assert t.relay.agents and all(a == ("challenge", R.USER_AGENT) for a in t.relay.agents), t.relay.agents
        # a code or session hello is refused on the relay (the transport picks the trust mode): that page closed with
        # {"relay":"close","gen":n} (r1.9), the leg kept
        for gen, over in enumerate(({"code": "ABC"}, {"session": "x"}, {"via": "loopback"}, {"purpose": "agent"}, {"jkt": "A" * 43}), 1):
            leg.control(relay="page-open", conn="c%d" % gen, kind="runner", gen=gen)
            leg.send(hello(sg, **over))
            r = await leg.json()
            assert r["error"]["data"]["code"] == "refused", (over, r)
            await asyncio.sleep(0.05)
            assert {"relay": "close", "gen": gen} in leg.controls, (over, leg.controls)
        await asyncio.sleep(0.1)
        assert len(t.relay.upgrades) == 1 and t.runner.stats["pageCloses"] == 5 and not t.runner.leg.closed
        page, res = await paired(leg, sg, gen=6)
        assert res["via"] == "relay" and res["incarnation"] == t.runner.incarnation
        st, b = await page.answer(await page.request("g.bind", {}, {}))
        assert st == 200 and b["binding"] == "b1", (st, b)
        payload = {"code": "import sys\nx = 6 * 7\nprint('hello from', sys.implementation.name)\nx", "mode": "python"}
        st, a = await page.answer(await page.request("g.run", {"b": "b1"}, {"request": "r1", "epoch": 1, "payload": payload}))
        assert (st, a) == (202, {"request": "r1", "state": "admitted"}), (st, a)
        ev = await page.events(await page.request("g.events", {"b": "b1", "r": "r1", "after": 0}))
        text = "".join(e.get("text", "") for e in ev if e["type"] == "stream")
        assert text == "hello from cpython\n42\n" and ev[-1]["outcome"]["status"] == "ok", ev
        # a receipt is acked with its own token, and nothing else is
        r22 = b64u(os.urandom(16))
        leg.control(relay="receipt", r=r22, upto=12345)
        await page.answer(await page.request("g.record", {"b": "b1", "r": "r1"}))
        assert {"relay": "ack", "r": r22} in leg.controls, leg.controls
        # page-close ends the page; a frame after it (none open) is a violation: the leg closes 1008
        leg.control(relay="page-close", conn="c6", gen=6)
        await asyncio.sleep(0.1)
        assert t.runner.paired_conn is None
        leg.send({"id": "x"})
        assert (await leg.closed_with()) == 1008
    finally:
        await t.end()
        sg.close()


@aio
async def test_forged_controls_never_act():
    """R17-CONTROL at the runner: an application message that looks like a control (any alternate serialization, or a
    real one with an id) is refused and closes the leg; a malformed control too.  A new page-open in the same leg
    replaces the paired page (one at a time)."""
    if NODE is None:
        print("  (no node) SKIPPED")
        return
    sg = await Signer().start()
    t = await Run().start()
    try:
        leg = await t.relay.leg()
        page, _ = await paired(leg, sg)
        forged = [' {"relay":"page-close","conn":"c1","gen":1}', '{"relay" :"page-close","conn":"c1","gen":1}',
                  '{"conn":"c1","relay":"page-close","gen":1}', '{"\\u0072elay":"page-close","conn":"c1","gen":1}',
                  '{"id":"t1","relay":"page-close"}', '{"relay":"page-close","conn":"c1","gen":1,"relay":"pong"}',
                  '{"relay":"page-close","conn":"c1", "gen":1}', '{"relay":"ping"}']
        for i, f in enumerate(forged):
            if i:
                leg = await t.relay.leg()
                page, _ = await paired(leg, sg, gen=1)
            leg.send_text(f)
            assert (await leg.closed_with()) == 1008, f
            assert t.runner.stats["violations"] == i + 1
        # one page at a time: a newer page-open replaces the paired one (its token dies)
        leg = await t.relay.leg()
        p1, r1 = await paired(leg, sg, gen=1)
        p2, r2 = await paired(leg, sg, gen=2)
        assert r1["token"] != r2["token"] and t.runner.paired_conn.gen == 2
        leg.control(relay="page-open", conn="c1", kind="runner", gen=1)  # (a generation going back)
        assert (await leg.closed_with()) == 1008
        # (R768-GEN-1: and with no page open: gen 2 opened and closed, then gen 1)
        leg = await t.relay.leg()
        await paired(leg, sg, gen=2)
        leg.control(relay="page-close", conn="c2", gen=2)
        leg.control(relay="page-open", conn="c1", kind="runner", gen=1)
        assert (await leg.closed_with()) == 1008 and t.runner.page is None
        leg = await t.relay.leg()
        leg.control(relay="page-open", conn="c1", kind="agent", gen=1)  # (a page for another kind)
        assert (await leg.closed_with()) == 1008
    finally:
        await t.end()
        sg.close()


@aio
async def test_channels_and_page_map():
    """T1.4 §T2 at the runner (b3c): on a runner not serving terminals (terminals=False; they are on by default since
    T-3), a terminal page is ended at once with close {gen}, the leg kept; every answer carries its page's generation; a newer kernel page replaces the older, whose late messages do
    nothing and whose page-close is accepted; a message for a page the runner never held, or without its prefix, is
    refused (1008)."""
    if NODE is None:
        print("  (no node) SKIPPED")
        return
    sg = await Signer().start()
    t = await Run().start()
    try:
        leg = await t.relay.leg()
        assert t.runner.serve_terminals and t.runner.channels() == ["kernel", "terminal"]  # (on by default, T6)
        t.runner.serve_terminals = False
        leg.control(relay="page-open", conn="c1", kind="runner", chan="terminal", gen=1)
        await asyncio.sleep(0.2)
        assert {"relay": "close", "gen": 1} in leg.controls and 1 not in t.runner.pages and not t.runner.leg.closed
        assert t.runner.page is None
        # (a kernel page: every answer prefixed with its gen)
        p2, _ = await paired(leg, sg, gen=2)
        st, b = await p2.answer(await p2.request("g.bind", {}, {}))
        assert st == 200 and set(leg.got_gens) == {2}, leg.got_gens
        # (a newer kernel page replaces it: the older one's late request does nothing; its page-close is accepted)
        p3, _ = await paired(leg, sg, gen=3)
        n = len(leg.got_gens)
        leg.send({"id": "late", "rpc": "g.record", "ref": {"b": "b1", "r": "r1"}}, gen=2)
        await asyncio.sleep(0.2)
        assert len(leg.got_gens) == n and not t.runner.leg.closed and t.runner.page.gen == 3
        leg.control(relay="page-close", conn="c2", gen=2)
        await asyncio.sleep(0.1)
        assert 2 not in t.runner.pages and not t.runner.leg.closed and t.runner.stats["violations"] == 0
        st, b = await p3.answer(await p3.request("g.bind", {}, {}))
        assert set(leg.got_gens[n:]) == {3}, (st, b, leg.got_gens)  # (routing: answered on gen 3 (the binding itself says in-use: takeover is the gateway's))
        # (a message for gen 2, now released: refused)
        leg.send({"id": "x"}, gen=2)
        assert (await leg.closed_with()) == 1008
        # (a message for a gen never opened, and one without its prefix: refused)
        for bad in ('99\n{"id":"x"}', '{"id":"x"}'):
            leg = await t.relay.leg()
            await paired(leg, sg, gen=1)
            leg.send_text(bad)
            assert (await leg.closed_with()) == 1008, bad
        # (a page-close naming the right gen but another connection: refused)
        leg = await t.relay.leg()
        await paired(leg, sg, gen=1)
        leg.control(relay="page-close", conn="cX", gen=1)
        assert (await leg.closed_with()) == 1008
    finally:
        await t.end()
        sg.close()


@aio
async def test_one_page_closed_not_the_leg():
    """r1.9: the runner ends one page with {"relay":"close","gen":n}: an answer the page isn't reading (1013), and
    an unpair, close that page only; the leg stays up (no new upgrade), and the next page pairs and reads the same
    binding's run, which went on."""
    if NODE is None:
        print("  (no node) SKIPPED")
        return
    sg = await Signer().start()
    t = await Run().start()
    try:
        leg = await t.relay.leg()
        page, _ = await paired(leg, sg, gen=1)
        await page.answer(await page.request("g.bind", {}, {}))
        code = "import time\nfor i in range(4):\n    print('tick', i, flush=True)\n    time.sleep(0.3)\n'done'"
        await page.answer(await page.request("g.run", {"b": "b1"}, {"request": "r1", "epoch": 1, "payload": {"code": code, "mode": "python"}}))
        # (the leg's buffer as if full: the page's next answer can't leave, so that page ends, 1013)
        real = t.runner.leg._buffered
        t.runner.leg._buffered = lambda: R.RELAY_LIMITS["outData"]
        await page.request("g.record", {"b": "b1", "r": "r1"})
        await asyncio.sleep(0.2)
        t.runner.leg._buffered = real
        assert {"relay": "close", "gen": 1} in leg.controls and t.runner.paired_conn is None, leg.controls
        assert not t.runner.leg.closed and len(t.relay.upgrades) == 1
        page, _ = await paired(leg, sg, gen=2)
        ev = await page.events(await page.request("g.events", {"b": "b1", "r": "r1", "after": 0}))
        assert ev[-1]["type"] == "terminal" and "tick 3" in "".join(e.get("text", "") for e in ev), ev
        # unpair: that page only
        leg.send({"unpair": True})
        await asyncio.sleep(0.2)
        assert {"relay": "close", "gen": 2} in leg.controls and not t.runner.leg.closed and len(t.relay.upgrades) == 1
        page, _ = await paired(leg, sg, gen=3)
        st, b = await page.answer(await page.request("g.bind", {}, {}))
        assert st == 200, (st, b)
    finally:
        await t.end()
        sg.close()


@aio
async def test_relay_window_stops_a_page_that_never_reads():
    """r1.9: the runner's gate is its own transport buffer; a page that never reads is stopped by the relay's
    window (the fake relay's, as b2's: the runner's leg closed 1013 once a page's unacknowledged bytes pass it), and
    the runner dials again with its binding kept."""
    if NODE is None:
        print("  (no node) SKIPPED")
        return
    sg = await Signer().start()
    t = await Run().start()
    t.relay.window = 64 * 1024
    try:
        leg = await t.relay.leg()
        page, r1 = await paired(leg, sg, gen=1)
        await page.answer(await page.request("g.bind", {}, {}))
        code = "for i in range(3000):\n    print('x' * 60, flush=True)"
        await page.answer(await page.request("g.run", {"b": "b1"}, {"request": "r1", "epoch": 1, "payload": {"code": code, "mode": "python"}}))
        await page.request("g.events", {"b": "b1", "r": "r1", "after": 0})
        while True:
            kind, v = await leg.next(30)
            if kind == "window":
                break
        assert (await leg.closed_with()) == 1013
        t.relay.window = None
        leg = await t.relay.leg(10)
        page, r2 = await paired(leg, sg, gen=1)
        assert r2["incarnation"] == r1["incarnation"]
        ev = await page.events(await page.request("g.events", {"b": "b1", "r": "r1", "after": 0}))
        text = "".join(e.get("text", "") for e in ev if e["type"] == "stream")
        assert ev[-1]["type"] == "terminal" and text.count("x" * 60) == 3000, (ev[-1:], text.count("x" * 60))
    finally:
        await t.end()
        sg.close()


@aio
async def test_framing():
    t = await Run().start()
    try:
        cases = [(lambda L: L.raw(0x1, b"{}", masked=True), 1002), (lambda L: L.raw(0x1, b"{}", rsv=0x40), 1002),
                 (lambda L: L.raw(0x2, b"\x00"), 1003), (lambda L: L.raw(0x9, b"x" * 126), 1002),
                 (lambda L: L.raw(0x0, b"x"), 1002), (lambda L: L.raw(0x3, b""), 1002),
                 (lambda L: L.w.write(bytes([0x81, 126, 0, 5]) + b"hello"), 1002),
                 (lambda L: L.raw(0x1, b"\xff\xfe"), 1007),
                 (lambda L: L.w.write(bytes([0x81, 127]) + (R.RELAY_LIMITS["inbound"] + 1).to_bytes(8, "big")), 1009),
                 # (R768-WS-2: malformed closes, as pair.py refuses a client's)
                 (lambda L: L.raw(0x8, b"\x03"), 1002), (lambda L: L.raw(0x8, (1006).to_bytes(2, "big")), 1002),
                 (lambda L: L.raw(0x8, (1005).to_bytes(2, "big")), 1002), (lambda L: L.raw(0x8, (999).to_bytes(2, "big")), 1002),
                 (lambda L: L.raw(0x8, (5000).to_bytes(2, "big")), 1002),
                 (lambda L: L.raw(0x8, (1000).to_bytes(2, "big") + b"\xff"), 1007)]
        for i, (act, want) in enumerate(cases):
            leg = await t.relay.leg()
            act(leg)
            assert (await leg.closed_with()) == want, (i, want)
        leg = await t.relay.leg()
        leg.raw(0x9, b"hi")
        kind, v = await leg.next()
        assert (kind, v) == ("pong", b"hi")
        # fragments: a control split over three frames is still one message (a pong, consumed, nothing answered)
        leg.raw(0x1, b'{"relay":', fin=False)
        leg.raw(0x0, b'"po', fin=False)
        leg.raw(0x9, b"")  # (a ping between fragments)
        leg.raw(0x0, b'ng"}')
        kind, v = await leg.next()
        assert kind == "pong"
        await asyncio.sleep(0.1)
        assert t.runner.stats["violations"] == 0 and not t.runner.leg.closed
        # the relay's close is answered and ends the leg; the runner dials again (an empty close: answered empty)
        leg.close(1001, "bye")
        assert (await leg.closed_with()) == 1001
        leg = await t.relay.leg()
        leg.raw(0x8, b"")
        assert (await leg.closed_with()) == 1005
        await t.relay.leg()
    finally:
        await t.end()


@aio
async def test_upgrade_checks():
    t = await Run().start()
    try:
        leg = await t.relay.leg()
        assert t.relay.upgrades[0]["ok"]
        t.relay.upgrade_status = 403
        leg.close(1000, "again")
        await asyncio.sleep(1.0)
        assert len(t.relay.upgrades) >= 2 and t.runner.stats["legs"] == 1
        assert any("refused this computer's key (403)" in s for s in t.said), t.said
        t.relay.upgrade_status = 101
        t.relay.extension = True
        await asyncio.sleep(1.0)
        assert any("isn't a plain WebSocket" in s for s in t.said), t.said
        t.relay.connection = "notupgrade"  # (R768-UPGRADE-3: the token, not a substring)
        n0 = len([s for s in t.said if "isn't a plain WebSocket" in s])
        t.relay.extension = False
        await asyncio.sleep(1.0)
        n = len([s for s in t.said if "isn't a plain WebSocket" in s])
        # (the runner's own count of legs it accepted: the fake queues every 101 it answered, refused ones too)
        assert n > n0 and t.runner.stats["legs"] == 1, (n0, n, t.runner.stats["legs"])
        t.relay.connection = "keep-alive, Upgrade"
        end = time.monotonic() + 10
        while t.runner.stats["legs"] < 2:
            assert time.monotonic() < end, "a token list with Upgrade was refused"
            await asyncio.sleep(0.05)
    finally:
        await t.end()
    # a challenge refused as unknown (revoked, or never enrolled there): the runner stops
    t = await Run().start()
    t.relay.challenge_status = 404
    try:
        code = await asyncio.wait_for(t.task, 10)
        assert code == 3 and any("enroll it again" in s for s in t.said), (code, t.said)
    finally:
        await t.end()


@aio
async def test_reconnect_keeps_the_binding():
    """R1: a dropped leg; the runner dials again; the page re-hellos, the binding and its running kernel kept, the same
    incarnation; its events read after the drop."""
    if NODE is None:
        print("  (no node) SKIPPED")
        return
    sg = await Signer().start()
    t = await Run().start()
    try:
        leg = await t.relay.leg()
        page, r1 = await paired(leg, sg)
        st, b = await page.answer(await page.request("g.bind", {}, {}))
        code = "import time\nfor i in range(3):\n    print('tick', i, flush=True)\n    time.sleep(0.4)\n'done'"
        await page.answer(await page.request("g.run", {"b": "b1"}, {"request": "r1", "epoch": 1, "payload": {"code": code, "mode": "python"}}))
        await asyncio.sleep(0.2)
        leg.drop()
        leg = await t.relay.leg()
        page, r2 = await paired(leg, sg, gen=2)
        assert r2["incarnation"] == r1["incarnation"]
        ev = await page.events(await page.request("g.events", {"b": "b1", "r": "r1", "after": 0}))
        text = "".join(e.get("text", "") for e in ev if e["type"] == "stream")
        assert text == "tick 0\ntick 1\ntick 2\n'done'\n" and ev[-1]["outcome"]["status"] == "ok", ev
    finally:
        await t.end()
        sg.close()


@aio
async def test_backoff_grows_and_resets():
    """Legs that drop at once: each wait doubles (1, 2, 4 ... in the fast test schedule 50, 100, 200, 400 ms); a leg
    that stayed up stableMs resets it."""
    old = R.RELAY_LIMITS["stableMs"]
    R.RELAY_LIMITS["stableMs"] = 300
    t = await Run().start()
    try:
        for i in range(4):
            (await t.relay.leg()).drop()
        leg = await t.relay.leg()
        assert t.runner.delays == [50, 100, 200, 400], t.runner.delays
        await asyncio.sleep(0.4)
        leg.drop()
        await t.relay.leg()
        assert t.runner.delays[-1] == 50, t.runner.delays
    finally:
        R.RELAY_LIMITS["stableMs"] = old
        await t.end()


@aio
async def test_pings_and_dead_legs():
    old = R.RELAY_LIMITS["pingMs"]
    R.RELAY_LIMITS["pingMs"] = 100
    t = await Run().start()
    try:
        leg = await t.relay.leg()
        await asyncio.sleep(0.45)
        pings = [c for c in leg.controls if c == {"relay": "ping"}]
        assert len(pings) >= 3 and not t.runner.leg.closed, leg.controls
        leg.auto_pong = False  # (half-open: R11)
        await leg.closed_with(5)
        assert any("stopped answering" in s for s in t.said)
        await t.relay.leg(5)
    finally:
        R.RELAY_LIMITS["pingMs"] = old
        await t.end()


@aio
async def test_revoked_and_replaced_stop():
    for how, want in (("control", 3), (4403, 3), (4009, 4)):
        t = await Run().start()
        try:
            leg = await t.relay.leg()
            if how == "control":
                leg.control(relay="revoked")
            else:
                leg.close(how, "x")
            code = await asyncio.wait_for(t.task, 10)
            assert code == want, (how, code)
            assert any(("revoked" if want == 3 else "took over") in s for s in t.said), t.said
            await asyncio.sleep(0.3)
            assert t.relay.legs.empty(), "dialed again after a stop"
        finally:
            await t.end()
    # 4429: dial again, after the longest backoff
    t = await Run().start()
    old = R.RELAY_LIMITS["budgetBackoffMs"]
    R.RELAY_LIMITS["budgetBackoffMs"] = 700
    try:
        leg = await t.relay.leg()
        t0 = time.monotonic()
        leg.close(4429, "budget")
        await t.relay.leg(10)
        assert time.monotonic() - t0 >= 0.65 and any("budget" in s for s in t.said)
    finally:
        R.RELAY_LIMITS["budgetBackoffMs"] = old
        await t.end()


@aio
async def test_proxy_connect():
    seen = []

    async def proxy(reader, writer):
        head = await reader.readuntil(b"\r\n\r\n")
        seen.append(head.decode())
        if b"Proxy-Authorization: Basic " + base64.b64encode(b"u:p w") not in head:
            writer.write(b"HTTP/1.1 407 Auth\r\n\r\n")
            writer.close()
            return
        host, port = head.split(b" ")[1].decode().rsplit(":", 1)
        r2, w2 = await asyncio.open_connection(host, int(port))
        writer.write(b"HTTP/1.1 200 Connection established\r\n\r\nX")  # (an early byte: it's the server's, not ours)

        async def pipe(a, b):
            while True:
                d = await a.read(65536)
                if not d:
                    break
                b.write(d)
        await asyncio.gather(pipe(reader, w2), pipe(r2, writer), return_exceptions=True)

    async def target(reader, writer):
        writer.write(b"hello")
        await writer.drain()
        writer.close()
    ps = await asyncio.start_server(proxy, "127.0.0.1", 0)
    ts = await asyncio.start_server(target, "127.0.0.1", 0)
    pport, tport = ps.sockets[0].getsockname()[1], ts.sockets[0].getsockname()[1]
    try:
        s = await asyncio.to_thread(R._dial, "127.0.0.1", tport, time.monotonic() + 5, "http://u:p%%20w@127.0.0.1:%d" % pport)
        def read6():
            got = b""
            s.settimeout(5)
            while len(got) < 6:
                d = s.recv(10)
                if not d:
                    break
                got += d
            s.close()
            return got
        got = await asyncio.to_thread(read6)  # (blocking reads off the loop the proxy runs on)
        assert got == b"Xhello" and "CONNECT 127.0.0.1:%d HTTP/1.1" % tport in seen[0], (got, seen)
        try:
            await asyncio.to_thread(R._dial, "127.0.0.1", tport, time.monotonic() + 5, "http://127.0.0.1:%d" % pport)
            raise AssertionError("no auth accepted")
        except R.Retry as e:
            assert "407" in str(e)
    finally:
        ps.close()
        ts.close()
    # the environment: HTTPS_PROXY for https, NO_PROXY honoured, never for http
    old = {k: os.environ.get(k) for k in ("https_proxy", "HTTPS_PROXY", "no_proxy", "NO_PROXY")}
    try:
        for k in old:
            os.environ.pop(k, None)
        os.environ["HTTPS_PROXY"] = "http://proxy.example:3128"
        os.environ["NO_PROXY"] = "internal.example"
        assert R._proxy_for("sagebrush.space", "https") == "http://proxy.example:3128"
        assert R._proxy_for("internal.example", "https") is None and R._proxy_for("sagebrush.space", "http") is None
    finally:
        for k, v in old.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v


@aio
async def test_dial_deadline_is_absolute():
    """astra's #768 first look: a CONNECT proxy answering one byte every 40 ms must not hold the dial past its
    deadline (a per-read timeout restarted with each byte); the dial gives up at the deadline, whatever the pace."""
    async def slow(reader, writer):
        await reader.readuntil(b"\r\n\r\n")
        try:
            for b in b"HTTP/1.1 200 Connection established\r\n\r\n":
                writer.write(bytes([b]))
                await writer.drain()
                await asyncio.sleep(0.04)
        except ConnectionError:
            pass
    ps = await asyncio.start_server(slow, "127.0.0.1", 0)
    pport = ps.sockets[0].getsockname()[1]
    try:
        t0 = time.monotonic()
        try:
            s = await asyncio.to_thread(R._dial, "127.0.0.1", 9, t0 + 0.1, "http://127.0.0.1:%d" % pport)
            s.close()
            raise AssertionError("a slow proxy's answer passed")
        except (R.Retry, OSError):
            pass
        took = time.monotonic() - t0
        assert took < 0.35, took  # (the whole answer takes ~1.5 s; per-read timeouts would wait it out)
        # (a deadline already past: refused before connecting at all, whatever the proxy would do)
        t0 = time.monotonic()
        try:
            s = await asyncio.to_thread(R._dial, "127.0.0.1", 9, t0 - 1, "http://127.0.0.1:%d" % pport)
            s.close()
            raise AssertionError("dialed after the deadline")
        except R.Retry:
            pass
        assert time.monotonic() - t0 < 0.1
    finally:
        ps.close()


@aio
async def test_stop_while_dialing():
    """Stop while the dial is in its thread (a connection that hasn't answered): run() returns at once, and the
    socket the dial makes afterwards is closed, not leaked."""
    made = []
    real = R._dial

    def stuck(host, port, deadline, proxy=None):
        time.sleep(1.0)  # (a slow network: the thread can't be interrupted)
        a, b = __import__("socket").socketpair()
        made.extend([a, b])
        return a
    R._dial = stuck
    t = await Run().start()
    try:
        await asyncio.sleep(0.3)  # (the challenge done, the dial in its thread)
        t0 = time.monotonic()
        t.stop.set()
        code = await asyncio.wait_for(t.task, 5)
        assert code == 0 and time.monotonic() - t0 < 0.5, time.monotonic() - t0
        await asyncio.sleep(1.2)
        assert made and made[0].fileno() == -1, made  # (closed once the thread returned it)
        assert t.runner.stats["legs"] == 0
    finally:
        R._dial = real
        for x in made[1:]:
            x.close()
        await t.end()


@aio
async def test_cli_ctrl_c():
    """The command as a process (R8): `sagebrush remote` with an enrolled key; a run with a grandchild; Ctrl-C closes the
    leg 1001, exits 0, and the kernel's group is gone."""
    if NODE is None:
        print("  (no node) SKIPPED")
        return
    sg = await Signer().start()
    relay = await FakeRelay(None).start()
    key = enrolled(relay.origin)
    relay.key = key
    home = tempfile.mkdtemp(prefix="sb-relay-")
    env = dict(os.environ, XDG_CONFIG_HOME=home)
    old = os.environ.get("XDG_CONFIG_HOME")
    os.environ["XDG_CONFIG_HOME"] = home
    try:
        K.save(key)
    finally:
        if old is None:
            os.environ.pop("XDG_CONFIG_HOME")
        else:
            os.environ["XDG_CONFIG_HOME"] = old
    p = await asyncio.create_subprocess_exec(sys.executable, "-m", "sagebrush.cli", "remote", env=env, cwd=HERE,
                                             stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    try:
        leg = await relay.leg(60)
        page, _ = await paired(leg, sg)
        await page.answer(await page.request("g.bind", {}, {}))
        code2 = "import subprocess, time\ng = subprocess.Popen(['sleep', '300'])\nprint(g.pid, flush=True)\nwhile True: time.sleep(0.01)"
        await page.answer(await page.request("g.run", {"b": "b1"}, {"request": "r2", "epoch": 1, "payload": {"code": code2, "mode": "python"}}))
        rid = await page.request("g.events", {"b": "b1", "r": "r2", "after": 0})
        grandchild = None
        while grandchild is None:
            m = await leg.json(60)
            if m.get("id") == rid and "chunk" in m:
                e = json.loads(m["chunk"].split("data: ", 1)[1])
                if e["type"] == "stream":
                    grandchild = int(e["text"].split()[0])
        p.send_signal(signal.SIGINT)
        assert (await leg.closed_with()) == 1001
        assert await asyncio.wait_for(p.wait(), 30) == 0
        end = time.monotonic() + 10

        def gone(pid):
            try:
                with open("/proc/%d/stat" % pid) as f:
                    return f.read().split(")")[-1].split()[0] == "Z"
            except OSError:
                return True
        while not gone(grandchild):
            assert time.monotonic() < end, "the kernel's grandchild outlived Ctrl-C"
            await asyncio.sleep(0.05)
        err = (await p.stderr.read()).decode()
        assert "Connected to %s as test-box" % relay.origin in err and K.b64url(key._d) not in err, err
    finally:
        if p.returncode is None:
            p.kill()
        relay.stop()
        sg.close()
        shutil.rmtree(home, ignore_errors=True)



# ================= grader's #768 pins (r768 at 3c75e0af)

def test_control_refusal_reasons():
    """C1-C3: each refusal says its own reason (the runner's log says it: "a malformed relay control (<reason>)"), and
    an oversized control is refused before it is parsed at all."""
    for t, why in [('{"relay":"pong","relay":"pong"}', "a key twice"),
                   ('{"relay":"page-close","conn":"c1","gen":1.0}', "a number not an integer"),
                   ('{"relay":"page-close","conn":"c1","gen":1e2}', "a number not an integer"),
                   ('{"relay":"pong","x":"%s"}' % ("a" * 300), "over 256 bytes")]:
        try:
            R.parse_control(t)
            raise AssertionError("accepted: " + t[:60])
        except R.ControlError as e:
            assert why in str(e), (t[:60], str(e))
    real, calls = R.json, []

    class Spy:
        dumps = staticmethod(real.dumps)

        @staticmethod
        def loads(*a, **k):
            calls.append(1)
            return real.loads(*a, **k)
    R.json = Spy
    try:
        try:
            R.parse_control('{"relay":"pong","pad":"%s"}' % ("a" * 10000))
            raise AssertionError("accepted")
        except R.ControlError:
            pass
        assert not calls, "an oversized control was parsed"
        R.parse_control('{"relay":"pong"}')
        assert calls == [1]  # (the spy itself works)
    finally:
        R.json = real


class FakeWriter:
    """The Leg's writer, for its gate: a buffer size the test sets, the frames written."""

    def __init__(self):
        self.buffered, self.out, self.closed = 0, [], False
        self.transport = self

    def get_write_buffer_size(self):
        return self.buffered

    def write(self, b):
        self.out.append(bytes(b))

    def close(self):
        self.closed = True

    def abort(self):
        self.closed = True


def test_send_gate_boundaries():
    """G1-G3: a frame exactly at the data limit is written; what is already buffered counts (a frame that fits alone
    but not on top of it is held back: the leg closes 1013); fits() counts the frame's header (6, 8 or 14 bytes)."""
    lim = R.RELAY_LIMITS["outData"]

    def leg():
        ends = []
        return R.Leg(None, FakeWriter(), lambda t: None, lambda c, r: ends.append(c)), ends
    frame = b"x" * 100
    L, ends = leg()
    L.w.buffered = lim - len(frame)
    assert L.write(frame, "data") and L.w.out == [frame] and not ends  # (G1: at the limit)
    L, ends = leg()
    L.w.buffered = lim - len(frame) + 1
    assert L.write(frame, "data") is False and ends == [1013] and frame not in L.w.out  # (G2: buffered counted)
    for n, head in ((100, 6), (1000, 8), (70000, 14)):
        L, _ = leg()
        L.w.buffered = lim - n - head
        assert L.fits(n, "data"), n
        L.w.buffered += 1
        assert not L.fits(n, "data"), n  # (G3: the header counted)


@aio
async def test_fragment_count():
    """F10: a message in 1025 frames (one and 1024 continuations, all empty) is refused, 1009."""
    t = await Run().start()
    try:
        leg = await t.relay.leg()
        leg.raw(0x1, b"", fin=False)
        for _ in range(R.RELAY_LIMITS["fragments"]):
            leg.raw(0x0, b"", fin=False)
        assert (await leg.closed_with(10)) == 1009
    finally:
        await t.end()


@aio
async def test_upgrade_answer_and_challenge_refusals():
    """U1: a wrong Sec-WebSocket-Accept; U5: a header twice; U8: a challenge with a space, a control or DEL. Each is
    a Retry for its own reason, before any leg."""
    relay = await FakeRelay(None).start()
    key = enrolled(relay.origin)
    relay.key = key

    async def refusal(**kw):
        try:
            leg = await R.open_leg(relay.origin, key, lambda t: None, lambda c, r: None, **kw)
            leg.abort("test")
            raise AssertionError("upgraded")
        except R.Retry as e:
            return str(e)
    try:
        relay.accept = "AAAAAAAAAAAAAAAAAAAAAAAAAAA="
        assert "isn't a plain WebSocket" in await refusal()
        relay.accept = None
        relay.extra_head = "Upgrade: websocket\r\n"
        assert "repeated the header upgrade" in await refusal()
        relay.extra_head = ""
        for c in ("a b", "a\x1fb", "a\x7fb"):
            async_post = (lambda c: (lambda origin, path, body, timeout=30.0: (200, {"challenge": c})))(c)
            assert "the challenge was refused" in await refusal(post=async_post), repr(c)
        leg = await R.open_leg(relay.origin, key, lambda t: None, lambda c, r: None)  # (the control: all well)
        leg.abort("test")
    finally:
        relay.stop()


@aio
async def test_proxy_answer_head_bound():
    """U10: a proxy whose answer head passes RELAY_LIMITS["head"] without ending is refused at once for its length,
    not waited on to the deadline."""
    async def chatty(reader, writer):
        await reader.readuntil(b"\r\n\r\n")
        writer.write(b"HTTP/1.1 200 OK\r\nX: " + b"a" * (R.RELAY_LIMITS["head"] + 100))
        await writer.drain()
        await asyncio.sleep(30)
    ps = await asyncio.start_server(chatty, "127.0.0.1", 0)
    try:
        t0 = time.monotonic()
        try:
            s = await asyncio.to_thread(R._dial, "127.0.0.1", 9, t0 + 5, "http://127.0.0.1:%d" % ps.sockets[0].getsockname()[1])
            s.close()
            raise AssertionError("dialed")
        except R.Retry as e:
            assert "too long" in str(e) and time.monotonic() - t0 < 2.5, (str(e), time.monotonic() - t0)
    finally:
        ps.close()


def test_proxy_connect_takes_what_is_left():
    """D8: the proxy's own TCP connect gets only what is left of the dial's deadline, never a fixed 30 s."""
    seen = []
    real = R.socket.create_connection

    def spy(addr, timeout=None, *a, **k):
        seen.append(timeout)
        raise OSError("no")
    R.socket.create_connection = spy
    try:
        try:
            R._dial("example.invalid", 443, time.monotonic() + 2, "http://127.0.0.1:9")
        except OSError:
            pass
    finally:
        R.socket.create_connection = real
    assert len(seen) == 1 and 0 < seen[0] <= 2, seen


@aio
async def test_page_generation_and_close_matching():
    """P1: a page-open with the same generation as the last is refused (the leg ends 1008); P5: a page-close for
    another conn, or another gen, is refused and leaves the page open."""
    t = await Run().start()
    try:
        leg = await t.relay.leg()
        leg.control(relay="page-open", conn="c1", kind="runner", gen=1)
        await asyncio.sleep(0.1)
        assert t.runner.page is not None and t.runner.stats["violations"] == 0
        leg.control(relay="page-open", conn="c1", kind="runner", gen=1)
        assert (await leg.closed_with(10)) == 1008 and t.runner.stats["violations"] == 1
        for conn, gen in (("c2", 1), ("c1", 2)):
            leg = await t.relay.leg()
            leg.control(relay="page-open", conn="c1", kind="runner", gen=1)
            await asyncio.sleep(0.1)
            page = t.runner.page
            n = t.runner.stats["violations"]
            leg.control(relay="page-close", conn=conn, gen=gen)
            assert (await leg.closed_with(10)) == 1008 and t.runner.stats["violations"] == n + 1, (conn, gen)
            assert page is not None  # (the page-close named no open page: refused as a violation, not acted on)
    finally:
        await t.end()


@aio
async def test_page_prehello_bounds():
    """P13: an unpaired page's message over PAIR_LIMITS["preHello"] closes that page, unread (no answer to it);
    P14: a page that never says hello is closed at helloMs."""
    t = await Run().start()
    old = R.PAIR_LIMITS["helloMs"]
    try:
        leg = await t.relay.leg()
        leg.control(relay="page-open", conn="c1", kind="runner", gen=1)
        leg.send({"jsonrpc": "2.0", "id": "p1", "method": "nothello", "params": {}, "pad": "x" * (R.PAIR_LIMITS["preHello"] + 1)})
        await asyncio.sleep(0.3)
        assert {"relay": "close", "gen": 1} in leg.controls and leg.inbox.empty(), (leg.controls, leg.inbox.qsize())
        R.PAIR_LIMITS["helloMs"] = 300
        leg.control(relay="page-open", conn="c2", kind="runner", gen=2)
        await asyncio.sleep(0.15)
        assert {"relay": "close", "gen": 2} not in leg.controls
        await asyncio.sleep(0.45)
        assert {"relay": "close", "gen": 2} in leg.controls, leg.controls
    finally:
        R.PAIR_LIMITS["helloMs"] = old
        await t.end()


@aio
async def test_exactly_missed_pongs():
    """L2: exactly missedPongs pings unanswered end the leg (no ping more)."""
    old = R.RELAY_LIMITS["pingMs"]
    R.RELAY_LIMITS["pingMs"] = 60
    t = await Run().start()
    try:
        leg = await t.relay.leg()
        leg.auto_pong = False
        await leg.closed_with(5)
        pings = [c for c in leg.controls if c == {"relay": "ping"}]
        assert len(pings) == R.RELAY_LIMITS["missedPongs"], len(pings)
    finally:
        R.RELAY_LIMITS["pingMs"] = old
        await t.end()


@aio
async def test_stop_as_the_leg_opens():
    """D7: Stop set while the leg was opening: the run ends there; the leg is never started (no "Connected")."""
    real = R.open_leg
    t = Run()

    async def opening(*a, **k):
        leg = await real(*a, **k)
        t.stop.set()
        return leg
    R.open_leg = opening
    try:
        await t.start()
        code = await asyncio.wait_for(t.task, 10)
        assert code == 0 and t.runner.stats["legs"] == 0 and not any("Connected" in s for s in t.said), (code, t.runner.stats, t.said)
    finally:
        R.open_leg = real
        await t.end()



def test_page_fits_counts_its_prefix():
    """grader's #774 H1: a page's message leaves with its channel prefix ("<gen>\\n"), and fits() counts it: a payload
    that fits alone but not with the prefix is held back; one byte smaller fits."""
    lim = R.RELAY_LIMITS["outData"]
    leg = R.Leg(None, FakeWriter(), lambda t: None, lambda c, r: None)
    page = R.RelayPage(None, leg, "c1", 12345)
    n = 1000
    head = 8  # (a client frame's header for 126..65535 bytes: 4, and its 4-byte mask)
    leg.w.buffered = lim - (n + len(page.prefix) + head)
    assert page.fits(n, "data") and leg.fits(n + len(page.prefix), "data")
    leg.w.buffered += 1
    assert not page.fits(n, "data") and leg.fits(n, "data"), "the payload alone fits; with its prefix it doesn't"
    assert page.fits(n - 1, "data")


if __name__ == "__main__":
    for name, f in list(globals().items()):
        if name.startswith("test_") and callable(f):
            f()
            print("ok", name)
    print("all remote relay tests passed")
