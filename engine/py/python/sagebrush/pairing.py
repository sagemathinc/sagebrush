"""The pairing of a person's Sagebrush page with this MCP server (design
workspace-files.md §8.7, the agent protocol): a WebSocket server on
127.0.0.1, which one page of the person's connects to with a one-time code.
Through it, the workspace tools reach the person's workspace
(sagebrush/workspace_tools.py) and, later, the chat panel reaches the agent.

What guards it (any program on this computer can reach the port, so the
port is not the guard; the code is):
- it listens on 127.0.0.1 only, never on another interface;
- the handshake must come from an allowed origin, exactly (Origin), to
  this port at 127.0.0.1 or localhost (Host, against DNS rebinding), at
  the path /sagebrush, as WebSocket version 13; anything else gets 403;
- the page's first message is "hello" with the code: 128 random bits,
  shown as 26 base32 letters, compared in constant time, used once, and
  valid for 5 minutes; 5 wrong codes and the code is retired;
- after the hello, one page is paired; another connection is refused;
- nothing runs before the person's grant (the page's "grant.changed"),
  and the grant is the page's: this server only follows it, and can't
  widen it;
- frames are limited (12 MiB, checked from the header, before the payload
  is read), the client's frames must be masked (RFC 6455), and fragments
  together are limited the same;
- at most 8 requests are in flight to the page, and at most 8
  connections are in their handshake at once (each for at most 30 s).

Nothing received is ever evaluated: messages are JSON, requests the page
answers are matched by id, and notifications go to fixed handlers.
"""

import base64
import hashlib
import hmac
import json
import os
import secrets
import socket
import struct
import threading
import time

from sagebrush.workspace_tools import NotConnected, PageError

PATH = "/sagebrush"
PROTOCOL = 1
ORIGINS = ("https://sagebrush.space",)
#: a frame's payload (and a fragmented message's) at most this many bytes:
#: 8 MiB of contents as base64, with the JSON around it
MAX_FRAME = 12 * 2**20
MAX_HEADER = 16 * 1024
CODE_SECONDS = 300
CODE_TRIES = 5
HELLO_SECONDS = 30
IN_FLIGHT = 8
#: connections still in their handshake or hello at once; more are closed at once
UNPAIRED = 8
_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"


class _Refused(Exception):
    pass


def _code():
    """128 random bits as 26 letters and digits (base32, no padding)."""
    return base64.b32encode(secrets.token_bytes(16)).decode().rstrip("=")


class Pairing:
    """Listen for one page.  start() returns (port, code); the code goes to
    the person (through the agent, which shows it, and stderr), who enters
    it in the page.  request() sends one JSON-RPC request to the paired
    page and returns its result (raising PageError or NotConnected)."""

    def __init__(self, agent, origins=ORIGINS, on_notify=None, now=time.monotonic):
        self.agent = agent  # {name, client, version}: what the hello's reply says
        self.origins = tuple(origins)
        self.on_notify = on_notify or (lambda method, params: None)
        self.now = now
        self.lock = threading.Lock()
        self.sock = None
        self.port = None
        self.code = None
        self.code_until = 0.0
        self.tries = 0
        self.conn = None  # the paired page's socket
        self.page = None  # its hello's page {origin, path}
        self.grant = None  # the person's grant, from the page
        self.pending = {}  # request id -> [event, result, error]
        self.ids = 0
        self.slots = threading.BoundedSemaphore(IN_FLIGHT)
        self.send_lock = threading.Lock()
        self.closed = False
        self.unpaired = 0

    # ---- listening
    def start(self):
        with self.lock:
            if self.sock is None:
                s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                s.bind(("127.0.0.1", 0))  # loopback only
                s.listen(4)
                self.sock = s
                self.port = s.getsockname()[1]
                threading.Thread(target=self._accept, daemon=True).start()
            self.code = _code()
            self.code_until = self.now() + CODE_SECONDS
            self.tries = 0
            return self.port, self.code

    def status(self):
        with self.lock:
            return {
                "listening": self.sock is not None,
                "port": self.port,
                "paired": self.conn is not None,
                "page": self.page,
                "granted": self.grant is not None,
                "grant": self.grant,
                "code_valid": self.code is not None and self.now() < self.code_until,
            }

    def close(self):
        self.closed = True
        with self.lock:
            s, self.sock = self.sock, None
            c = self.conn
        for x in (s, c):
            if x is not None:
                try:
                    x.close()
                except OSError:
                    pass

    def _accept(self):
        while not self.closed:
            try:
                c, addr = self.sock.accept()
            except OSError:
                return
            with self.lock:
                full = self.unpaired >= UNPAIRED
                if not full:
                    self.unpaired += 1
            if full:
                c.close()
                continue
            threading.Thread(target=self._serve, args=(c,), daemon=True).start()

    # ---- one connection
    def _serve(self, c):
        counted = True
        try:
            c.settimeout(HELLO_SECONDS)
            self._handshake(c)
            msg = self._read_message(c)
            hello = self._hello(c, msg)
            with self.lock:
                self.unpaired -= 1
            counted = False
            if not hello:
                return
            c.settimeout(None)
            while True:
                self._dispatch(self._read_message(c))
        except (_Refused, OSError, ValueError, ConnectionError):
            pass
        finally:
            with self.lock:
                if counted:
                    self.unpaired -= 1
                mine = self.conn is c
                if mine:
                    self.conn = self.page = self.grant = None
                    failed = list(self.pending.values())
                    self.pending.clear()
                else:
                    failed = []
            for slot in failed:
                slot[2] = NotConnected("the paired page closed or disconnected")
                slot[0].set()
            try:
                c.close()
            except OSError:
                pass

    def _handshake(self, c):
        data = b""
        while b"\r\n\r\n" not in data:
            chunk = c.recv(4096)
            if not chunk:
                raise _Refused("closed")
            data += chunk
            if len(data) > MAX_HEADER:
                self._http(c, 431, "Request Header Fields Too Large")
        head = data.split(b"\r\n\r\n", 1)[0].decode("latin-1")
        lines = head.split("\r\n")
        parts = lines[0].split(" ")
        headers = {}
        for line in lines[1:]:
            k, sep, v = line.partition(":")
            if not sep:
                self._http(c, 400, "Bad Request")
            k = k.strip().lower()
            if k in headers:  # (a repeated Origin or Host is not a guess to make)
                self._http(c, 400, "Bad Request")
            headers[k] = v.strip()
        hosts = ("127.0.0.1:%d" % self.port, "localhost:%d" % self.port)
        ok = (
            len(parts) == 3 and parts[0] == "GET" and parts[1] == PATH and parts[2] == "HTTP/1.1"
            and headers.get("host") in hosts
            and headers.get("origin") in self.origins
            and headers.get("upgrade", "").lower() == "websocket"
            and "upgrade" in [t.strip().lower() for t in headers.get("connection", "").split(",")]
            and headers.get("sec-websocket-version") == "13"
        )
        key = headers.get("sec-websocket-key", "")
        try:
            ok = ok and len(base64.b64decode(key, validate=True)) == 16
        except Exception:
            ok = False
        if not ok:
            self._http(c, 403, "Forbidden")
        accept = base64.b64encode(hashlib.sha1((key + _GUID).encode()).digest()).decode()
        c.sendall(("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                   "Sec-WebSocket-Accept: %s\r\n\r\n" % accept).encode())

    def _http(self, c, status, reason):
        try:
            c.sendall(("HTTP/1.1 %d %s\r\nContent-Length: 0\r\nConnection: close\r\n\r\n" % (status, reason)).encode())
        finally:
            raise _Refused(reason)

    def _hello(self, c, msg):
        """The page's first message: hello with the code.  True when this
        connection is now the paired page."""
        rid = msg.get("id") if isinstance(msg, dict) else None
        params = msg.get("params") if isinstance(msg, dict) else None
        if not (isinstance(msg, dict) and msg.get("jsonrpc") == "2.0" and msg.get("method") == "hello"
                and isinstance(rid, str) and isinstance(params, dict)):
            self._close(c, 1002, "the first message must be hello")
            return False
        if params.get("protocol") != PROTOCOL:
            self._reply_error(c, rid, "protocol", "this server speaks protocol %d" % PROTOCOL)
            self._close(c, 1002, "protocol")
            return False
        given = params.get("code")
        with self.lock:
            if self.conn is not None:
                refused = "another page is paired with this agent"
            elif self.code is None or self.now() >= self.code_until:
                refused = "the code has expired: ask the agent for a new one"
            elif not isinstance(given, str) or not hmac.compare_digest(given.strip().upper().encode(), self.code.encode()):
                self.tries += 1
                if self.tries >= CODE_TRIES:
                    self.code = None
                refused = "wrong code"
            else:
                refused = None
                self.code = None  # used once
                self.conn = c
                page = params.get("page")
                self.page = {"origin": page.get("origin"), "path": page.get("path")} if isinstance(page, dict) else None
        if refused:
            self._reply_error(c, rid, "refused", refused)
            self._close(c, 1008, refused)
            return False
        self._send(c, {"jsonrpc": "2.0", "id": rid, "result": {"protocol": PROTOCOL, "agent": self.agent, "wants": {"write": True, "run": False}}})
        return True

    def _dispatch(self, msg):
        if not isinstance(msg, dict) or msg.get("jsonrpc") != "2.0":
            raise _Refused("not JSON-RPC 2.0")
        if "method" in msg:
            if "id" in msg:  # (the page sends no requests after hello)
                raise _Refused("unexpected request")
            method, params = msg["method"], msg.get("params")
            if method == "grant.changed":
                with self.lock:
                    self.grant = params if isinstance(params, dict) and params else None
            elif method in ("chat.message", "chat.permission"):
                self.on_notify(method, params)
            return
        with self.lock:
            slot = self.pending.pop(msg.get("id"), None)
        if slot is None:
            return  # (an answer to a request given up on)
        if "error" in msg:
            err = msg["error"] if isinstance(msg["error"], dict) else {}
            data = err.get("data") if isinstance(err.get("data"), dict) else {}
            slot[2] = PageError(str(data.get("code") or "protocol"), str(data.get("message") or err.get("message") or "the page refused the request"),
                                current=data.get("current"), retry_after_ms=data.get("retryAfterMs"))
        else:
            slot[1] = msg.get("result")
        slot[0].set()

    # ---- requests to the page
    def request(self, method, params, timeout=60.0):
        with self.lock:
            c = self.conn
            if c is None:
                raise NotConnected("no Sagebrush page is paired with this agent: call workspace_connect for a code, and enter it in the page (Chrome or Firefox)")
            if self.grant is None:
                raise NotConnected("the page is paired but the person has not granted access yet: they choose what this agent may do in the page")
        if not self.slots.acquire(timeout=timeout):
            raise PageError("limit", "%d requests are already in flight to the page" % IN_FLIGHT, retry_after_ms=250)
        try:
            with self.lock:
                self.ids += 1
                rid = "s%d" % self.ids
                slot = [threading.Event(), None, None]
                self.pending[rid] = slot
            self._send(c, {"jsonrpc": "2.0", "id": rid, "method": method, "params": params})
            if not slot[0].wait(timeout):
                with self.lock:
                    self.pending.pop(rid, None)
                raise PageError("timeout", "the page did not answer within %g s" % timeout)
            if slot[2] is not None:
                raise slot[2]
            return slot[1]
        finally:
            self.slots.release()

    def notify(self, method, params):
        with self.lock:
            c = self.conn
        if c is None:
            raise NotConnected("no Sagebrush page is paired with this agent")
        self._send(c, {"jsonrpc": "2.0", "method": method, "params": params})

    # ---- frames (RFC 6455)
    def _send(self, c, msg):
        data = json.dumps(msg, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
        if len(data) > MAX_FRAME:
            raise PageError("limit", "the message is %d bytes; at most %d go in one frame" % (len(data), MAX_FRAME))
        self._frame(c, 0x1, data)

    def _frame(self, c, opcode, data):
        n = len(data)
        head = bytes([0x80 | opcode])
        if n < 126:
            head += bytes([n])
        elif n < 1 << 16:
            head += bytes([126]) + struct.pack("!H", n)
        else:
            head += bytes([127]) + struct.pack("!Q", n)
        with self.send_lock:
            c.sendall(head + data)

    def _close(self, c, code, reason):
        try:
            self._frame(c, 0x8, struct.pack("!H", code) + reason.encode("utf-8")[:120])
        except OSError:
            pass

    def _exact(self, c, n):
        buf = bytearray()
        while len(buf) < n:
            chunk = c.recv(min(n - len(buf), 1 << 16))
            if not chunk:
                raise ConnectionError("closed")
            buf += chunk
        return bytes(buf)

    def _read_message(self, c):
        """One whole message (text, possibly fragmented), as JSON; pings
        answered, a close ends the connection."""
        parts, total = [], 0
        while True:
            b0, b1 = self._exact(c, 2)
            fin, opcode, masked, n = b0 & 0x80, b0 & 0x0F, b1 & 0x80, b1 & 0x7F
            if b0 & 0x70:
                self._close(c, 1002, "reserved bits")
                raise _Refused("reserved bits")
            if not masked:
                self._close(c, 1002, "client frames must be masked")
                raise _Refused("unmasked")
            if n == 126:
                n = struct.unpack("!H", self._exact(c, 2))[0]
            elif n == 127:
                n = struct.unpack("!Q", self._exact(c, 8))[0]
            if opcode >= 0x8 and (n > 125 or not fin):
                self._close(c, 1002, "bad control frame")
                raise _Refused("bad control frame")
            if opcode < 0x8 and total + n > MAX_FRAME:
                self._close(c, 1009, "message too big: at most %d bytes" % MAX_FRAME)
                raise _Refused("too big")
            mask = self._exact(c, 4)
            payload = bytes(b ^ mask[i % 4] for i, b in enumerate(self._exact(c, n))) if n < 4096 else _unmask(self._exact(c, n), mask)
            if opcode == 0x8:
                self._close(c, 1000, "")
                raise ConnectionError("closed by the page")
            if opcode == 0x9:
                self._frame(c, 0xA, payload)
                continue
            if opcode == 0xA:
                continue
            if opcode == 0x2:
                self._close(c, 1003, "text frames only")
                raise _Refused("binary")
            if (opcode == 0x0) != bool(parts):
                self._close(c, 1002, "bad fragmentation")
                raise _Refused("fragmentation")
            parts.append(payload)
            total += n
            if fin:
                try:
                    return json.loads(b"".join(parts).decode("utf-8"))
                except ValueError:
                    self._close(c, 1007, "not JSON")
                    raise _Refused("not JSON")

    def _reply_error(self, c, rid, code, message):
        self._send(c, {"jsonrpc": "2.0", "id": rid, "error": {"code": -32000, "message": message, "data": {"code": code, "message": message}}})


def _unmask(data, mask):
    """XOR with the 4-byte mask, fast for large payloads."""
    n = len(data)
    m = int.from_bytes((mask * (n // 4 + 1))[:n], "big")
    return (int.from_bytes(data, "big") ^ m).to_bytes(n, "big")
