"""The pairing server (sagebrush/pairing.py) over real sockets on 127.0.0.1,
with a WebSocket client written here playing the person's page and the
attackers:

- a page that pairs with the code, then grants, then serves the workspace
  verbs (the fake page of test_workspace_tools.py);
- a wrong Origin or Host (DNS rebinding), a wrong path, version or key;
- a wrong code, a used code, an expired code, 5 wrong tries retiring it;
- a second page while one is paired;
- verbs before the person's grant;
- unmasked frames, an oversized frame refused from its header, binary
  frames, not JSON, too many handshakes at once;
- the page going away while a request waits.

    python engine/py/test_pairing.py
"""
import base64
import importlib.util
import json
import os
import socket
import struct
import sys
import threading
import time
import types

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "python", "sagebrush")
try:
    from sagebrush import pairing as P, workspace_tools as WS
except Exception as e:  # (no built engine here: load the two modules by path)
    if os.environ.get("CI"):
        raise
    pkg = types.ModuleType("sagebrush")
    pkg.__path__ = [SRC]
    sys.modules["sagebrush"] = pkg
    for name in ("workspace_tools", "pairing"):
        spec = importlib.util.spec_from_file_location("sagebrush." + name, os.path.join(SRC, name + ".py"))
        mod = importlib.util.module_from_spec(spec)
        sys.modules["sagebrush." + name] = mod
        spec.loader.exec_module(mod)
    from sagebrush import pairing as P, workspace_tools as WS

sys.path.insert(0, HERE)
import test_workspace_tools  # noqa: E402

test_workspace_tools.WS = WS  # (one PageError class: the fake page raises the one caught here)
FakePage = test_workspace_tools.FakePage

ORIGIN = "https://sagebrush.space"


class Client:
    """A minimal WebSocket client: the page, or an attacker."""

    def __init__(self, port, origin=ORIGIN, host=None, path="/sagebrush", version="13", key=None):
        self.s = socket.create_connection(("127.0.0.1", port), timeout=10)
        key = key or base64.b64encode(os.urandom(16)).decode()
        req = ("GET %s HTTP/1.1\r\nHost: %s\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: %s\r\n"
               "Sec-WebSocket-Version: %s\r\n%s\r\n" % (path, host or "127.0.0.1:%d" % port, key, version, "Origin: %s\r\n" % origin if origin else ""))
        self.s.sendall(req.encode())
        head = b""
        while b"\r\n\r\n" not in head:
            chunk = self.s.recv(1)
            if not chunk:
                break
            head += chunk
        self.status = int(head.split(b" ")[1]) if head else 0
        self.pongs = []

    def send_frame(self, opcode, data, masked=True, fin=True, declared=None):
        n = len(data) if declared is None else declared
        b = bytes([(0x80 if fin else 0) | opcode])
        mbit = 0x80 if masked else 0
        if n < 126:
            b += bytes([mbit | n])
        elif n < 1 << 16:
            b += bytes([mbit | 126]) + struct.pack("!H", n)
        else:
            b += bytes([mbit | 127]) + struct.pack("!Q", n)
        if masked:
            mask = os.urandom(4)
            b += mask + bytes(x ^ mask[i % 4] for i, x in enumerate(data))
        else:
            b += data
        self.s.sendall(b)

    def send(self, msg):
        self.send_frame(0x1, json.dumps(msg).encode())

    def recv(self):
        """The next message: a dict, or ("close", code, reason), or None at
        EOF (pongs are recorded in self.pongs)."""
        def exact(n):
            buf = b""
            while len(buf) < n:
                chunk = self.s.recv(n - len(buf))
                if not chunk:
                    return None
                buf += chunk
            return buf

        h = exact(2)
        if h is None:
            return None
        opcode, n = h[0] & 0x0F, h[1] & 0x7F
        if n == 126:
            n = struct.unpack("!H", exact(2))[0]
        elif n == 127:
            n = struct.unpack("!Q", exact(8))[0]
        data = exact(n)
        if opcode == 0x8:
            return ("close", struct.unpack("!H", data[:2])[0] if len(data) >= 2 else None, data[2:].decode())
        if opcode == 0xA:
            self.pongs.append(data)
            return self.recv()
        return json.loads(data)

    def hello(self, code, rid="h1"):
        self.send({"jsonrpc": "2.0", "id": rid, "method": "hello", "params": {"protocol": 1, "code": code, "page": {"origin": ORIGIN, "path": "/w/"}}})
        return self.recv()

    def close(self):
        # (shutdown first: close alone sends no FIN while another thread is in recv)
        try:
            self.s.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        self.s.close()


def serve_verbs(client, page, stop):
    """Answer the server's workspace requests with the fake page, as the
    real page does with window.sagebrush.workspace."""
    while not stop.is_set():
        try:
            msg = client.recv()
        except OSError:
            return
        if msg is None or isinstance(msg, tuple):
            return
        try:
            result = page.request(msg["method"], msg["params"], 10)
            client.send({"jsonrpc": "2.0", "id": msg["id"], "result": result})
        except WS.PageError as e:
            client.send({"jsonrpc": "2.0", "id": msg["id"], "error": {"code": -32000, "message": e.message, "data": {"code": e.code, "message": e.message, "current": e.current}}})


def new():
    p = P.Pairing({"name": "Test agent", "client": "test", "version": "0"})
    port, code = p.start()
    return p, port, code


def test_pair_grant_and_verbs():
    p, port, code = new()
    assert p.sock.getsockname()[0] == "127.0.0.1"
    assert len(code) == 26 and code.isalnum()
    c = Client(port)
    assert c.status == 101
    r = c.hello(code.lower())  # (the code is case-insensitive, as typed)
    assert r["result"]["agent"]["name"] == "Test agent" and r["result"]["protocol"] == 1, r
    st = p.status()
    assert st["paired"] and not st["granted"] and not st["code_valid"]
    # nothing runs before the person's grant
    content, s, err = WS.call(p, "workspace_list", {"folder": "/"})
    assert err and s["error"]["code"] == "not_connected" and "not granted" in s["error"]["message"], s
    c.send({"jsonrpc": "2.0", "method": "grant.changed", "params": {"folders": ["/"], "write": True, "run": False}})
    for _ in range(100):
        if p.status()["granted"]:
            break
        time.sleep(0.01)
    assert p.status()["grant"]["write"] is True
    page, stop = FakePage(), threading.Event()
    t = threading.Thread(target=serve_verbs, args=(c, page, stop), daemon=True)
    t.start()
    assert not WS.call(p, "workspace_create", {"path": "/n.txt", "content": {"text": "hello"}})[2]
    _, s, err = WS.call(p, "workspace_read", {"path": "/n.txt"})
    assert not err and s["result"]["content"]["text"] == "hello", s
    _, s, err = WS.call(p, "workspace_write", {"path": "/n.txt", "content": {"text": "x"}, "base": 0})
    assert err and s["error"]["code"] == "conflict" and s["error"]["current"]["rev"] == 1, s
    # 8 MiB of binary contents fit in one frame as base64, both ways
    big = base64.b64encode(os.urandom(WS.MAX_CONTENT)).decode()
    assert not WS.call(p, "workspace_create", {"path": "/big.bin", "content": {"base64": big}})[2]
    _, s, err = WS.call(p, "workspace_read", {"path": "/big.bin"})
    assert not err and s["result"]["content"]["base64"] == big
    # a second page is refused while one is paired, even with a fresh code
    port2, code2 = p.start()
    assert port2 == port
    c2 = Client(port)
    r = c2.hello(code2)
    assert r["error"]["data"]["code"] == "refused" and "another page" in r["error"]["message"], r
    c2.close()
    # the grant revoked: no more verbs
    c.send({"jsonrpc": "2.0", "method": "grant.changed", "params": {}})
    time.sleep(0.2)
    _, s, err = WS.call(p, "workspace_list", {"folder": "/"})
    assert err and s["error"]["code"] == "not_connected"
    # the page goes away: waiting requests fail at once, and the status says so
    stop.set()
    c.close()
    for _ in range(100):
        if not p.status()["paired"]:
            break
        time.sleep(0.01)
    assert not p.status()["paired"] and not p.status()["granted"]
    p.close()


def test_handshake_refusals():
    p, port, code = new()
    bad = [
        dict(origin="https://evil.example"),
        dict(origin="https://sagebrush.space.evil.example"),
        dict(origin="http://sagebrush.space"),
        dict(origin=None),
        dict(host="evil.example:%d" % port),  # DNS rebinding: a name that resolves to 127.0.0.1
        dict(host="127.0.0.1:%d" % (port + 1)),
        dict(path="/"),
        dict(path="/sagebrush/x"),
        dict(version="8"),
        dict(key="short"),
    ]
    for kw in bad:
        c = Client(port, **kw)
        assert c.status == 403, (kw, c.status)
        c.close()
    # localhost as the host is as good as 127.0.0.1
    c = Client(port, host="localhost:%d" % port)
    assert c.status == 101
    assert "result" in c.hello(code)
    c.close()
    p.close()


def test_codes():
    p, port, code = new()
    # wrong codes: refused, and after 5 the code is retired
    for i in range(P.CODE_TRIES):
        c = Client(port)
        r = c.hello("A" * 26)
        assert r["error"]["data"]["code"] == "refused", r
        c.close()
    c = Client(port)
    r = c.hello(code)
    assert "expired" in r["error"]["message"], r  # retired: no longer valid
    c.close()
    # a fresh code works once, and only once
    port, code = p.start()
    c = Client(port)
    assert "result" in c.hello(code)
    c.close()
    for _ in range(100):
        if not p.status()["paired"]:
            break
        time.sleep(0.01)
    c = Client(port)
    r = c.hello(code)
    assert "error" in r, r
    c.close()
    # an expired code
    clock = [0.0]
    q = P.Pairing({"name": "t"}, now=lambda: clock[0])
    port, code = q.start()
    clock[0] = P.CODE_SECONDS + 1
    c = Client(port)
    r = c.hello(code)
    assert "expired" in r["error"]["message"], r
    c.close()
    # not hello first, or another protocol
    port, code = q.start()
    c = Client(port)
    c.send({"jsonrpc": "2.0", "id": "x", "method": "workspace.list", "params": {}})
    assert c.recv()[0] == "close"
    c.close()
    c = Client(port)
    c.send({"jsonrpc": "2.0", "id": "x", "method": "hello", "params": {"protocol": 2, "code": code}})
    assert c.recv()["error"]["data"]["code"] == "protocol"
    c.close()
    p.close()
    q.close()


def test_frames():
    p, port, code = new()
    # unmasked
    c = Client(port)
    c.send_frame(0x1, json.dumps({"jsonrpc": "2.0", "id": "h", "method": "hello", "params": {"protocol": 1, "code": code}}).encode(), masked=False)
    r = c.recv()
    assert r[0] == "close" and r[1] == 1002, r
    c.close()
    # too big, refused from the header: nothing of the payload is sent
    c = Client(port)
    t0 = time.time()
    c.send_frame(0x1, b"", declared=P.MAX_FRAME + 1)
    r = c.recv()
    assert r[0] == "close" and r[1] == 1009 and time.time() - t0 < 5, r
    c.close()
    # binary, and not JSON
    c = Client(port)
    c.send_frame(0x2, b"\0\1")
    assert c.recv()[1] == 1003
    c.close()
    c = Client(port)
    c.send_frame(0x1, b"{not json")
    assert c.recv()[1] == 1007
    c.close()
    # a fragmented hello is fine; a ping is answered
    c = Client(port)
    c.send_frame(0x9, b"hi")
    body = json.dumps({"jsonrpc": "2.0", "id": "h", "method": "hello", "params": {"protocol": 1, "code": code}}).encode()
    c.send_frame(0x1, body[:10], fin=False)
    c.send_frame(0x0, body[10:])
    r = c.recv()
    assert isinstance(r, dict) and "result" in r, r
    assert c.pongs == [b"hi"], c.pongs
    c.close()
    p.close()


def test_handshakes_at_once_are_bounded():
    p, port, code = new()
    idle = [socket.create_connection(("127.0.0.1", port)) for _ in range(P.UNPAIRED)]
    time.sleep(0.2)
    s = socket.create_connection(("127.0.0.1", port), timeout=5)
    assert s.recv(1) == b""  # closed at once
    s.close()
    for x in idle:
        x.close()
    time.sleep(0.3)
    c = Client(port)  # room again
    assert c.status == 101
    c.close()
    p.close()


def test_page_gone_while_waiting():
    p, port, code = new()
    c = Client(port)
    c.hello(code)
    c.send({"jsonrpc": "2.0", "method": "grant.changed", "params": {"folders": ["/"], "write": False, "run": False}})
    time.sleep(0.2)
    out = {}

    def ask():
        out["r"] = WS.call(p, "workspace_list", {"folder": "/"}, timeout=30)

    t = threading.Thread(target=ask)
    t.start()
    assert c.recv()["method"] == "workspace.list"  # the request arrives; the page never answers
    t0 = time.time()
    c.close()
    t.join(10)
    content, s, err = out["r"]
    assert err and s["error"]["code"] == "not_connected" and time.time() - t0 < 5, s
    p.close()


def paired(grant=True):
    p, port, code = new()
    c = Client(port)
    assert "result" in c.hello(code)
    if grant:
        c.send({"jsonrpc": "2.0", "method": "grant.changed", "params": {"folders": ["/"], "write": True, "run": False}})
        for _ in range(200):
            if p.status()["granted"]:
                break
            time.sleep(0.01)
    return p, c


def test_reserved_opcodes():
    """CORR-6DA-2 (astra): a frame with a reserved opcode (3-7, 11-15) closes
    the connection with 1002; a correct hello inside one pairs nothing."""
    for op in (3, 7, 11, 15):
        p, port, code = new()
        c = Client(port)
        c.send_frame(op, json.dumps({"jsonrpc": "2.0", "id": "h", "method": "hello", "params": {"protocol": 1, "code": code}}).encode())
        r = c.recv()
        assert r[0] == "close" and r[1] == 1002, (op, r)
        assert not p.status()["paired"], op
        c.close()
        p.close()


def test_revoke_while_waiting_for_a_slot():
    """CORR-6DA-3 (astra): a request waiting for one of the 8 slots is
    admitted again when it gets one: a grant revoked meanwhile stops it, and
    the page never receives it."""
    p, c = paired()
    out = []

    def ask(i):
        out.append(WS.call(p, "workspace_create", {"path": "/f%d.txt" % i}, timeout=20))

    threads = [threading.Thread(target=ask, args=(i,)) for i in range(P.IN_FLIGHT)]
    for t in threads:
        t.start()
    first = [c.recv() for _ in range(P.IN_FLIGHT)]  # 8 requests reach the page, unanswered
    assert all(m["method"] == "workspace.create" for m in first)
    late = threading.Thread(target=ask, args=(99,))
    late.start()  # the ninth waits for a slot
    time.sleep(0.3)
    c.send({"jsonrpc": "2.0", "method": "grant.changed", "params": {}})  # revoked
    time.sleep(0.3)
    for m in first:  # the page answers the eight: slots free up
        c.send({"jsonrpc": "2.0", "id": m["id"], "result": {"entry": {"path": m["params"]["path"], "kind": "file"}}})
    late.join(10)
    for t in threads:
        t.join(10)
    c.s.settimeout(1)
    try:
        extra = c.recv()
    except socket.timeout:
        extra = None
    assert extra is None, "the page received a request after the revoke: %r" % (extra,)
    lates = [s for _, s, err in out if err]
    assert len(lates) == 1 and lates[0]["error"]["code"] == "not_connected", out
    c.close()
    p.close()


def test_pending_cleared_on_every_path():
    """CORR-6DA-4 (astra): a request whose frame can't be sent, or that times
    out, or whose page leaves, leaves nothing pending."""
    p, c = paired()
    for _ in range(3):
        try:
            p.request("workspace.create", {"path": "/x", "content": {"text": "x" * (P.MAX_FRAME + 1)}}, 5)
        except WS.PageError as e:
            assert e.code == "limit", e.code
        else:
            raise AssertionError("an oversized frame was sent")
    assert p.pending == {}, p.pending
    try:
        p.request("workspace.list", {}, 0.3)  # the page never answers
    except WS.PageError as e:
        assert e.code == "timeout"
    assert p.pending == {}, p.pending
    assert c.recv()["method"] == "workspace.list"
    # all 8 slots are free again
    assert all(p.slots.acquire(timeout=0) for _ in range(P.IN_FLIGHT))
    for _ in range(P.IN_FLIGHT):
        p.slots.release()
    c.close()
    p.close()


def test_strict_json_frames():
    """CORR-6DA-5 (astra): a frame of JSON with NaN or Infinity, a lone
    surrogate, bytes that aren't UTF-8, or a key twice in an object (which
    another reader could take differently: P319-B1) closes the connection
    (1007)."""
    for body in [b'{"jsonrpc": "2.0", "id": "h", "method": "hello", "params": {"protocol": 1, "code": NaN}}',
                 b'[Infinity]', b'"\\ud800"', b'\xff\xfe',
                 b'{"jsonrpc": "2.0", "id": "h", "method": "hello", "params": {"protocol": 1, "code": "A", "code": "B"}}',
                 b'{"jsonrpc": "2.0", "jsonrpc": "2.0", "id": "h", "method": "hello", "params": {}}',
                 b'[{"a": 1}, {"b": {"c": 1, "c": 2}}]']:
        p, port, code = new()
        c = Client(port)
        c.send_frame(0x1, body)
        r = c.recv()
        assert r[0] == "close" and r[1] == 1007, (body, r)
        c.close()
        p.close()
    # and after pairing: a result carrying a lone surrogate ends the pairing, never a crash
    p, c = paired()
    out = {}
    t = threading.Thread(target=lambda: out.update(r=WS.call(p, "workspace_list", {"folder": "/"}, timeout=10)))
    t.start()
    m = c.recv()
    c.send_frame(0x1, ('{"jsonrpc":"2.0","id":"%s","result":{"entries":[{"path":"/\\udc00","kind":"file"}]}}' % m["id"]).encode())
    t.join(10)
    _, s, err = out["r"]
    assert err and s["error"]["code"] == "not_connected", s
    c.close()
    p.close()
    # and a result with a key twice: the same, the pairing ended, the duplicate never read
    p, c = paired()
    out = {}
    t = threading.Thread(target=lambda: out.update(r=WS.call(p, "workspace_list", {"folder": "/"}, timeout=10)))
    t.start()
    m = c.recv()
    c.send_frame(0x1, ('{"jsonrpc":"2.0","id":"%s","result":{"entries":[],"entries":[{"path":"/x","kind":"file"}]}}' % m["id"]).encode())
    t.join(10)
    _, s, err = out["r"]
    assert err and s["error"]["code"] == "not_connected", s
    c.close()
    p.close()


def test_unpaired_memory_is_bounded():
    """LIMIT-6DA-1 (daybreak2): before the hello has paired a connection, a
    message is at most 8 KiB, refused from the frame's header before its
    payload is read; 8 attackers at once declaring 12 MiB each, then
    streaming, make the server hold almost nothing.  After pairing, a 12
    MiB-class message is read in chunks into one buffer: its peak is a small
    multiple of its size, not of the frame cap times the connections."""
    import tracemalloc

    p, port, code = new()
    tracemalloc.start()
    tracemalloc.reset_peak()
    attackers = []
    for _ in range(P.UNPAIRED):
        c = Client(port)
        c.send_frame(0x1, b"", declared=P.MAX_FRAME)  # a 12 MiB hello, declared
        attackers.append(c)
    for c in attackers:
        r = c.recv()
        assert r[0] == "close" and r[1] == 1009 and str(P.MAX_HELLO) in r[2], r
    # and just past the 8 KiB, really sent
    c = Client(port)
    c.send_frame(0x1, b" " * (P.MAX_HELLO + 1))
    assert c.recv()[1] == 1009
    _, peak = tracemalloc.get_traced_memory()
    assert peak < 2 * 2**20, "unpaired connections made the server hold %d bytes" % peak
    for x in attackers + [c]:
        x.close()
    # a hello within the 8 KiB still pairs
    c = Client(port)
    assert "result" in c.hello(code)
    c.send({"jsonrpc": "2.0", "method": "grant.changed", "params": {"folders": ["/"], "write": True}})
    time.sleep(0.2)
    # after pairing: a message of 10 MiB is accepted, at a peak of a few times its size
    out = {}
    t = threading.Thread(target=lambda: out.update(r=WS.call(p, "workspace_read", {"path": "/big.bin"}, timeout=30)))
    t.start()
    m = c.recv()
    data = base64.b64encode(b"\7" * (WS.MAX_CONTENT - 64)).decode()
    tracemalloc.reset_peak()
    base, _ = tracemalloc.get_traced_memory()
    c.send({"jsonrpc": "2.0", "id": m["id"], "result": {"entry": {"path": "/big.bin", "kind": "file"}, "rev": 1, "content": {"base64": data}}})
    t.join(30)
    _, peak = tracemalloc.get_traced_memory()
    tracemalloc.stop()
    _, s, err = out["r"]
    assert not err, s
    size = len(data)
    assert peak - base < 5 * size, "a %d-byte message peaked at %d bytes" % (size, peak - base)
    c.close()
    p.close()


def wait_unpaired(p):
    for _ in range(200):
        if not p.status()["paired"]:
            return
        time.sleep(0.01)
    raise AssertionError("still paired")


def test_session_reconnect():
    """"Remember this agent" (the protocol doc §2.1): a code hello's result
    carries a session secret; the page reconnects with it, any number of
    times, without a code; 5 wrong secrets, or a revoke, and it is
    forgotten; a hello carries a code or a session, never both."""
    p, port, code = new()
    c = Client(port)
    r = c.hello(code)
    secret = r["result"]["session"]
    assert isinstance(secret, str) and len(secret) == 43, secret  # (32 bytes, base64url without padding)
    assert p.session_hash != secret.encode() and len(p.session_hash) == 32  # (only its SHA-256 is kept)
    c.close()
    wait_unpaired(p)
    for _ in range(2):  # (not rotated)
        c = Client(port)
        c.send({"jsonrpc": "2.0", "id": "h", "method": "hello", "params": {"protocol": 1, "session": secret, "page": {"origin": ORIGIN, "path": "/"}}})
        r = c.recv()
        assert "result" in r and "session" not in r["result"], r
        c.close()
        wait_unpaired(p)
    # both, or neither
    port2, code2 = p.start()
    for params in ({"protocol": 1, "code": code2, "session": secret}, {"protocol": 1}):
        c = Client(port)
        c.send({"jsonrpc": "2.0", "id": "h", "method": "hello", "params": params})
        assert c.recv()["error"]["data"]["code"] == "refused"
        c.close()
    # 5 wrong secrets: forgotten, the right one refused after
    for _ in range(P.CODE_TRIES):
        c = Client(port)
        c.send({"jsonrpc": "2.0", "id": "h", "method": "hello", "params": {"protocol": 1, "session": "x" * 43}})
        assert "wrong session" in c.recv()["error"]["message"]
        c.close()
    c = Client(port)
    c.send({"jsonrpc": "2.0", "id": "h", "method": "hello", "params": {"protocol": 1, "session": secret}})
    assert "no longer knows" in c.recv()["error"]["message"]
    c.close()
    # a revoke forgets it too
    port, code = p.start()
    c = Client(port)
    secret = c.hello(code)["result"]["session"]
    c.send({"jsonrpc": "2.0", "method": "grant.changed", "params": {"folders": ["/"]}})
    c.send({"jsonrpc": "2.0", "method": "grant.changed", "params": {}})
    time.sleep(0.2)
    c.close()
    wait_unpaired(p)
    c = Client(port)
    c.send({"jsonrpc": "2.0", "id": "h", "method": "hello", "params": {"protocol": 1, "session": secret}})
    assert "no longer knows" in c.recv()["error"]["message"]
    c.close()
    p.close()


def test_dev_origin():
    """SAGEBRUSH_MCP_DEV_ORIGIN: one more origin, exactly; off by default;
    anything but http://localhost:<port> or http://127.0.0.1:<port> refused."""
    dev = "http://localhost:5173"
    p, port, code = new()
    assert Client(port, origin=dev).status == 403  # (off by default)
    p.close()
    os.environ[P.DEV_ORIGIN_ENV] = dev
    try:
        p, port, code = new()
        assert Client(port, origin=dev).status == 101
        assert Client(port, origin="http://localhost:5174").status == 403
        assert Client(port, origin=ORIGIN).status == 101
        p.close()
        for bad in ("https://evil.example", "http://localhost", "http://localhost:5173/", "*", "http://localhost:0"):
            os.environ[P.DEV_ORIGIN_ENV] = bad
            try:
                P.Pairing({"name": "t"})
            except ValueError:
                continue
            raise AssertionError("accepted %r" % bad)
    finally:
        del os.environ[P.DEV_ORIGIN_ENV]


if __name__ == "__main__":
    for name, f in list(globals().items()):
        if name.startswith("test_") and callable(f):
            f()
            print("ok", name)
    print("all pairing tests passed")
