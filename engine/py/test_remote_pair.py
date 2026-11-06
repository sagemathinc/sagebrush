"""`sagebrush remote --loopback` (sagebrush/remote/pair.py; design remote-v1
§11 (a)): the page's pairing with this computer, ported from
src/notebook-pair.ts, over real sockets on 127.0.0.1, with a WebSocket client
written here playing the page (and the attackers), and the page's key a real
WebCrypto P-256 key (remote_test_signer.mjs, under Node):

- the upgrade: the path, Origin, Host (no DNS rebinding), a repeated header,
  the key and version, at most 8 sockets unpaired;
- the hello: protocol 1, exactly one of code and session, the key's shape,
  canonical encoding, curve and thumbprint, a wrong code, 5 wrong attempts
  retiring it, a wrong purpose not spending it, a used code, an expired code,
  a second page, remember and a session hello;
- RFC 6455 as a server reads a client: masked, no reserved bits or opcodes,
  text only, a message over 8 KiB before the hello, fragments (1024 at most),
  UTF-8, strict JSON (a key twice), close statuses, ping/pong;
- the output gate at its caps (L22-L24, exact bytes);
- end to end, the runner as a process: pair, bind, run code in this Python
  with real DPoP proofs, its events, Stop, unpair; and Ctrl-C (R8): close
  1001, exit 0, the kernel's process group gone.

    python engine/py/test_remote_pair.py
"""
import asyncio
import base64
import hashlib
import json
import os
import re
import secrets
import shutil
import signal
import struct
import sys
import time

from sagebrush.remote import pair as P

HERE = os.path.dirname(os.path.abspath(__file__))
NODE = shutil.which("node")


def b64u(b):
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode("ascii")


# ---- the page's key (Node's WebCrypto)

class Signer:
    async def start(self):
        self.p = await asyncio.create_subprocess_exec(NODE, os.path.join(HERE, "remote_test_signer.mjs"),
                                                      stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE)
        k = json.loads(await self.p.stdout.readline())
        self.jwk, self.jkt = k["jwk"], k["jkt"]
        self.n = 0
        return self

    async def sign(self, text):
        self.n += 1
        self.p.stdin.write((json.dumps({"id": self.n, "input": text}) + "\n").encode())
        await self.p.stdin.drain()
        return json.loads(await self.p.stdout.readline())["sig"]

    async def proof(self, method, htu, token, nonce):
        h = b64u(json.dumps({"typ": "dpop+jwt", "alg": "ES256", "jwk": self.jwk}).encode())
        c = b64u(json.dumps({"jti": b64u(secrets.token_bytes(24)), "htm": method, "htu": htu, "iat": int(time.time()),
                             "ath": b64u(hashlib.sha256(token.encode()).digest()), "nonce": nonce}).encode())
        return "%s.%s.%s" % (h, c, await self.sign(h + "." + c))

    def close(self):
        self.p.stdin.close()
        self.p.kill()


# ---- a WebSocket client

class WS:
    @classmethod
    async def open(cls, port, path=P.PAIR_PATH, origin=P.PAGE_ORIGIN, host=None, headers=(), key=None):
        self = cls()
        self.r, self.w = await asyncio.open_connection("127.0.0.1", port)
        key = key if key is not None else base64.b64encode(secrets.token_bytes(16)).decode()
        lines = ["GET %s HTTP/1.1" % path, "Host: %s" % (host or "127.0.0.1:%d" % port), "Upgrade: websocket",
                 "Connection: Upgrade", "Sec-WebSocket-Key: %s" % key, "Sec-WebSocket-Version: 13"]
        if origin is not None:
            lines.append("Origin: %s" % origin)
        lines += list(headers)
        self.w.write(("\r\n".join(lines) + "\r\n\r\n").encode())
        head = await asyncio.wait_for(self.r.readuntil(b"\r\n\r\n"), 10)
        self.status = int(head.split(b" ")[1])
        return self

    def frame(self, op, payload, fin=True, masked=True, rsv=0):
        b0 = (0x80 if fin else 0) | rsv | op
        n = len(payload)
        head = bytes([b0]) + (bytes([(0x80 if masked else 0) | n]) if n < 126 else bytes([(0x80 if masked else 0) | 126]) + struct.pack(">H", n)
                              if n < 65536 else bytes([(0x80 if masked else 0) | 127]) + struct.pack(">Q", n))
        if masked:
            mask = secrets.token_bytes(4)
            payload = bytes(b ^ mask[i & 3] for i, b in enumerate(payload))
            head += mask
        self.w.write(head + payload)

    def send(self, obj):
        self.frame(0x1, json.dumps(obj).encode())

    async def recv(self, timeout=30):
        """(opcode, payload), or (None, b"") at EOF."""
        try:
            h = await asyncio.wait_for(self.r.readexactly(2), timeout)
        except asyncio.IncompleteReadError:
            return None, b""
        n = h[1] & 0x7F
        if n == 126:
            n = struct.unpack(">H", await self.r.readexactly(2))[0]
        elif n == 127:
            n = struct.unpack(">Q", await self.r.readexactly(8))[0]
        return h[0] & 0x0F, await self.r.readexactly(n)

    async def json(self, timeout=30):
        while True:
            op, data = await self.recv(timeout)
            if op == 0x1:
                return json.loads(data)
            if op in (0x8, None):
                return {"closed": int.from_bytes(data[:2], "big") if len(data) >= 2 else None, "reason": data[2:].decode()}

    async def closed_with(self):
        while True:
            op, data = await self.recv()
            if op is None:
                return None
            if op == 0x8:
                return int.from_bytes(data[:2], "big")

    def close(self):
        self.w.close()


def hello(signer, code=None, session=None, **over):
    p = {"protocol": 1, "purpose": "kernel", "jwk": signer.jwk, "jkt": signer.jkt}
    if code is not None:
        p["code"] = code
    if session is not None:
        p["session"] = session
    p.update(over)
    return {"jsonrpc": "2.0", "id": "p1", "method": "hello", "params": p}


class Clock(P.RealTimers):
    def __init__(self):
        self.t = None

    def now(self):
        return self.t if self.t is not None else super().now()


async def server(**kw):
    s = P.PairServer(err=lambda m: None, **kw)
    await s.listen(0)
    return s


def aio(f):
    def wrapped():
        asyncio.run(f())
    wrapped.__name__ = f.__name__
    return wrapped


# ================= the upgrade

@aio
async def test_upgrade_refusals():
    s = await server()
    try:
        assert (await WS.open(s.port, path="/sagebrush")).status == 400
        assert (await WS.open(s.port, origin="https://evil.example")).status == 403
        assert (await WS.open(s.port, origin=None)).status == 403
        assert (await WS.open(s.port, host="evil.example:%d" % s.port)).status == 403  # (DNS rebinding)
        assert (await WS.open(s.port, headers=["Origin: %s" % P.PAGE_ORIGIN])).status == 400  # (a repeated header)
        assert (await WS.open(s.port, key="short")).status == 403
        lh = await WS.open(s.port, host="localhost:%d" % s.port)  # (kept open: it counts among the unpaired)
        assert lh.status == 101
        socks = [await WS.open(s.port) for _ in range(7)]
        assert all(w.status == 101 for w in socks)
        assert (await WS.open(s.port)).status == 503  # (8 unpaired at once: the 9th refused)
    finally:
        s.close()


# ================= the hello

@aio
async def test_hello():
    sg = await Signer().start()
    try:
        s = await server()
        w = await WS.open(s.port)
        w.send({"jsonrpc": "2.0", "id": "p1", "method": "nothello", "params": {}})
        a = await w.json()
        assert a["error"]["data"]["code"] == "protocol" and (await w.closed_with()) == 1002
        for msg, why in [
            (hello(sg, code=s.code, protocol=2), "protocol 1 only"),
            (hello(sg, code=s.code, session="x"), "exactly one of code and session"),
            (hello(sg), "exactly one of code and session"),
            (hello(sg, code=s.code, jwk=dict(sg.jwk, kid="k")), "must be an EC P-256 public key"),
            (hello(sg, code=s.code, jkt=sg.jkt[:-1] + ("A" if sg.jkt[-1] != "A" else "B")), "thumbprint"),
            (hello(sg, code=s.code, jwk=dict(sg.jwk, x=sg.jwk["x"][:-1] + ("A" if sg.jwk["x"][-1] != "A" else "B"))), "point on P-256|thumbprint|canonical"),
            (hello(sg, code=s.code, jkt=sg.jkt + "\n"), "too long|canonical"),
        ]:
            w = await WS.open(s.port)
            w.send(msg)
            a = await w.json()
            assert re.search(why, a["error"]["message"]), (why, a)
            assert (await w.closed_with()) in (1008, 1002)
        # a wrong purpose with the right code: a wrong attempt, the code not spent
        w = await WS.open(s.port)
        w.send(hello(sg, code=s.code, purpose="agent"))
        assert "purpose" in (await w.json())["error"]["message"]
        # wrong codes: 3 more (4 wrong attempts so far), then the right one pairs
        for _ in range(3):
            w = await WS.open(s.port)
            w.send(hello(sg, code="WRONG"))
            assert (await w.json())["error"]["message"] == "wrong code"
        w = await WS.open(s.port)
        w.send(hello(sg, code=s.code.lower(), remember=True))  # (case-insensitive)
        a = await w.json()
        r = a["result"]
        assert r["protocol"] == 1 and r["purpose"] == "kernel" and len(r["token"]) == 43 and r["nonce"] and r["session"], a
        assert r["limits"] == {"frame": P.PAIR_LIMITS["frame"]}
        assert re.fullmatch(r"[0-9a-f]{16}", r["incarnation"]) and r["incarnation"] == s.incarnation
        w2 = await WS.open(s.port)
        w2.send(hello(sg, code=s.code))
        assert "was used" in (await w2.json())["error"]["message"]
        w3 = await WS.open(s.port)
        w3.send(hello(sg, session=r["session"]))
        assert "another page" in (await w3.json())["error"]["message"]
        w.send({"unpair": True})
        assert (await w.closed_with()) == 1000
        await asyncio.sleep(0.05)
        w4 = await WS.open(s.port)  # (unpair forgets the session)
        w4.send(hello(sg, session=r["session"]))
        assert "doesn't remember" in (await w4.json())["error"]["message"]
        s.close()
        # 5 wrong attempts retire the code
        s = await server()
        for _ in range(5):
            w = await WS.open(s.port)
            w.send(hello(sg, code="WRONG"))
            await w.json()
        w = await WS.open(s.port)
        w.send(hello(sg, code=s.code))
        assert "too many wrong attempts" in (await w.json())["error"]["message"]
        s.close()
        # an expired code (the clock past 5 minutes)
        clk = Clock()
        s = await server(timers=clk)
        clk.t = s.code_issued + P.PAIR_LIMITS["codeMs"] + 1
        w = await WS.open(s.port)
        w.send(hello(sg, code=s.code))
        assert "expired" in (await w.json())["error"]["message"]
        s.close()
        # a session hello after remember, on a fresh pairing, and 5 wrong sessions forget it
        s = await server()
        w = await WS.open(s.port)
        w.send(hello(sg, code=s.code, remember=True))
        sess = (await w.json())["result"]["session"]
        w.close()
        await asyncio.sleep(0.1)
        for _ in range(5):
            x = await WS.open(s.port)
            x.send(hello(sg, session="wrong"))
            await x.json()
        x = await WS.open(s.port)
        x.send(hello(sg, session=sess))
        assert "doesn't remember" in (await x.json())["error"]["message"]
        s.close()
    finally:
        sg.close()


# ================= framing

@aio
async def test_framing():
    s = await server()
    try:
        for send, code in [
            (lambda w: w.frame(0x1, b"{}", masked=False), 1002),
            (lambda w: w.frame(0x1, b"{}", rsv=0x40), 1002),
            (lambda w: w.frame(0x2, b"{}"), 1003),
            (lambda w: w.frame(0x3, b"{}"), 1002),
            (lambda w: w.frame(0x1, b"x" * (8 * 1024 + 1)), 1009),
            (lambda w: w.frame(0x1, b"\xff\xfe"), 1007),
            (lambda w: w.frame(0x1, b'{"a": 1, "a": 2}'), 1007),
            (lambda w: w.frame(0x1, b'{"a": NaN}'), 1007),
            (lambda w: w.frame(0x0, b"{}"), 1002),
            (lambda w: w.frame(0x8, (1005).to_bytes(2, "big")), 1002),
            (lambda w: w.frame(0x9, b"x" * 126), 1002),
            (lambda w: w.frame(0x8, (1000).to_bytes(2, "big")), 1000),
        ]:
            w = await WS.open(s.port)
            send(w)
            assert (await w.closed_with()) == code, code
            w.close()
        w = await WS.open(s.port)  # (ping -> pong)
        w.frame(0x9, b"hi")
        assert await w.recv() == (0xA, b"hi")
        w = await WS.open(s.port)  # (a fragmented message: 1024 fragments pass, as the hello)
        w.frame(0x1, b"", fin=False)
        for _ in range(1022):
            w.frame(0x0, b"", fin=False)
        w.frame(0x0, b'{"jsonrpc":"2.0","id":"p1","method":"x","params":{}}')
        assert (await w.json())["error"]["data"]["code"] == "protocol"
        w = await WS.open(s.port)  # (1025: 1009)
        w.frame(0x1, b"", fin=False)
        for _ in range(1024):
            w.frame(0x0, b"", fin=False)
        assert (await w.closed_with()) == 1009
    finally:
        s.close()


# ================= the output gate (L22-L24): exact bytes

class FakeTransport:
    def __init__(self):
        self.buffered = 0
        self.written = []
        self.aborted = False

    def get_write_buffer_size(self):
        return self.buffered

    def write(self, b):
        self.written.append(bytes(b))

    def can_write_eof(self):
        return True

    def write_eof(self):
        pass

    def abort(self):
        self.aborted = True


def test_gate():
    s = P.PairServer(err=lambda m: None, out_caps={"data": 1000, "total": 1200}, timers=P.RealTimers())
    s.timers = type("T", (), {"now": lambda self: 0, "set_timeout": lambda self, f, ms: None, "clear_timeout": lambda self, h: None})()
    t = FakeTransport()
    c = P.Conn(t, s)
    s.conns.add(c)
    s.unpaired_count = 1
    frame = P._frame_of(0x81, b"x" * 100)  # 102 bytes
    t.buffered = 1000 - len(frame)
    assert c.write(frame, "data") and t.written[-1] == frame  # L23+: exactly 7 MiB (scaled)
    t.buffered = 1000 - len(frame) + 1
    assert c.fits(100, "data") is False
    t.written.clear()
    assert c.write(frame, "data") is False  # L23: one more: refused, not appended; close 1013 instead
    assert len(t.written) == 1 and t.written[0][:2] == bytes([0x88, len(t.written[0]) - 2]) and t.written[0][2:4] == (1013).to_bytes(2, "big")
    c2 = P.Conn(FakeTransport(), s)
    s.conns.add(c2)
    s.unpaired_count += 1
    ctl = P._frame_of(0x8A, b"y" * 100)
    c2.transport.buffered = 1200 - len(ctl)
    assert c2.write(ctl, "control")  # L24+
    c2.transport.buffered += 1
    assert c2.write(ctl, "control") is False and c2.transport.aborted and c2.closed  # L24b: destroyed, nothing appended


@aio
async def test_drain_groups():
    """The runner's exit awaits the escalation (astra's a3 note): a group that ignores SIGTERM is empty once
    drain_groups returns (its SIGKILL at 2 s, or at the 3 s deadline), and a group that obeys SIGTERM returns at once."""
    from sagebrush.remote import gateway as G
    for script, slow in (("trap '' TERM; sleep 30 & wait", True), ("sleep 30 & wait", False)):
        p = await asyncio.create_subprocess_exec("sh", "-c", script, start_new_session=True)
        await asyncio.sleep(0.2)
        assert G._group_members(p.pid), script
        t0 = time.monotonic()
        G._kill_tree(p.pid)
        left = await G.drain_groups(3.0)
        took = time.monotonic() - t0
        assert not G._group_members(p.pid) and p.pid not in G.ENDING_GROUPS, (script, left)
        assert (1.5 < took < 3.5) if slow else took < 1.0, (script, took)
        await p.wait()


# ================= end to end: the runner as a process, real DPoP

async def start_runner():
    env = dict(os.environ)
    p = await asyncio.create_subprocess_exec(sys.executable, "-m", "sagebrush.cli", "remote", "--loopback", "--port", "0",
                                             stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, env=env, cwd=HERE)
    link = (await asyncio.wait_for(p.stdout.readline(), 60)).decode().strip()
    m = re.search(r"kpair=([A-Z2-7]+)&kport=(\d+)", link)
    assert m and link.startswith(P.PAGE_ORIGIN), link
    return p, m.group(1), int(m.group(2))


class Page:
    def __init__(self, ws, signer, token, nonce):
        self.ws, self.sg, self.token, self.nonce, self.n = ws, signer, token, nonce, 0

    async def request(self, rpc, ref, body=None):
        self.n += 1
        method, _, path = __import__("sagebrush.remote.gateway", fromlist=["TABLE"]).TABLE[rpc]
        from sagebrush.remote.gateway import SYNTHETIC_BASE
        proof = await self.sg.proof(method, SYNTHETIC_BASE + path(ref), self.token, self.nonce)
        f = {"id": "t%d" % self.n, "rpc": rpc, "ref": ref, "auth": "DPoP " + self.token, "dpop": proof,
             "accept": "text/event-stream" if rpc == "g.events" else "application/json"}
        if body is not None:
            f["body"] = json.dumps(body)
        self.ws.send(f)
        return f["id"]

    async def answer(self, rid):
        while True:
            m = await self.ws.json(60)
            if m.get("id") == rid and "status" in m:
                self.nonce = m["headers"].get("dpop-nonce", self.nonce)
                return m["status"], (json.loads(m["body"]) if "body" in m else None)

    async def events(self, rid):
        out = []
        while True:
            m = await self.ws.json(60)
            if m.get("id") != rid:
                continue
            if "chunk" in m:
                out.append(json.loads(m["chunk"].split("data: ", 1)[1]))
            if m.get("end") or "streamError" in m:
                return out


@aio
async def test_end_to_end_and_ctrl_c():
    if NODE is None:
        print("  (no node: the end-to-end case needs WebCrypto for the page's key) SKIPPED")
        return
    sg = await Signer().start()
    p, code, port = await start_runner()
    try:
        ws = await WS.open(port)
        ws.send(hello(sg, code=code))
        r = (await ws.json())["result"]
        page = Page(ws, sg, r["token"], r["nonce"])
        st, b = await page.answer(await page.request("g.bind", {}, {}))
        assert st == 200 and b["binding"] == "b1", (st, b)
        payload = {"code": "import sys\nx = 6 * 7\nprint('hello from', sys.implementation.name)\nx", "mode": "python"}
        st, a = await page.answer(await page.request("g.run", {"b": "b1"}, {"request": "r1", "epoch": 1, "payload": payload}))
        assert (st, a) == (202, {"request": "r1", "state": "admitted"}), (st, a)
        ev = await page.events(await page.request("g.events", {"b": "b1", "r": "r1", "after": 0}))
        text = "".join(e.get("text", "") for e in ev if e["type"] == "stream")
        assert text == "hello from cpython\n42\n" and ev[-1]["type"] == "terminal" and ev[-1]["outcome"]["status"] == "ok", ev
        # a proof for another path is refused (the htu is rebuilt by the runner)
        page.n += 1
        bad = await sg.proof("GET", "https://local.sagebrush.invalid/api/compute/v1/bindings/b1/runs/zz", page.token, page.nonce)
        ws.send({"id": "t%d" % page.n, "rpc": "g.record", "ref": {"b": "b1", "r": "r1"}, "auth": "DPoP " + page.token, "dpop": bad, "accept": "application/json"})
        st, a = await page.answer("t%d" % page.n)
        assert st == 401 and a == {"error": "invalid_dpop_proof"}, (st, a)
        # a run with a grandchild, then Ctrl-C on the runner (R8): close 1001, exit 0, the process group gone
        code2 = "import subprocess, time\ng = subprocess.Popen(['sleep', '300'])\nprint(g.pid, flush=True)\nwhile True: time.sleep(0.01)"
        await page.answer(await page.request("g.run", {"b": "b1"}, {"request": "r2", "epoch": 1, "payload": {"code": code2, "mode": "python"}}))
        rid = await page.request("g.events", {"b": "b1", "r": "r2", "after": 0})
        grandchild = None
        while grandchild is None:
            m = await ws.json(60)
            if m.get("id") == rid and "chunk" in m:
                e = json.loads(m["chunk"].split("data: ", 1)[1])
                if e["type"] == "stream":
                    grandchild = int(e["text"].split()[0])
        p.send_signal(signal.SIGINT)
        assert (await ws.closed_with()) == 1001
        assert await asyncio.wait_for(p.wait(), 30) == 0

        def gone(pid):
            try:
                with open("/proc/%d/stat" % pid) as f:
                    return f.read().split(")")[-1].split()[0] == "Z"
            except OSError:
                return True
        end = time.monotonic() + 10
        while not gone(grandchild):
            assert time.monotonic() < end, "the kernel's grandchild outlived Ctrl-C"
            await asyncio.sleep(0.05)
    finally:
        if p.returncode is None:
            p.kill()
        sg.close()


if __name__ == "__main__":
    for name, f in list(globals().items()):
        if name.startswith("test_") and callable(f):
            f()
            print("ok", name)
    print("all remote pair tests passed")
