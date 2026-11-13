"""`sagebrush remote --loopback`: the native runner on this computer's
loopback address, paired with a sagebrush.space page exactly as `sagebrush
notebook --pair` is (src/notebook-pair.ts, whose contract this ports; design
remote-v1 §11 (a)).  A page that speaks that contract connects here unchanged;
the code runs in this computer's own CPython (gateway.py, child.py).  The
page's side is web/notebook/pair-tunnel.js and remote-ui.js ("Your computer").

The contract (the agent pairing's, design/workspace-agent-protocol.md §2, at its own path):
  - a WebSocket on 127.0.0.1 only, at GET /sagebrush-kernel (any other path: 400, before any WebSocket);
  - the Origin exactly https://sagebrush.space (or the one development origin SAGEBRUSH_KERNEL_DEV_ORIGIN names),
    the Host 127.0.0.1:<port> or localhost:<port> (no DNS rebinding); a repeated header: 400;
  - a 128-bit code, single use, for 5 minutes, compared in constant time; 5 wrong attempts retire it;
  - the hello carries purpose "kernel", exactly one of code and session, and the page's DPoP public key and its
    RFC 7638 thumbprint; the result: a token for this socket and that key, a DPoP nonce, and (asked to remember) a
    session secret, kept here only as its SHA-256, in memory;
  - one paired page at a time; at most 8 sockets in their handshake or hello; 8 KiB before the hello; the hello
    within 30 s; RFC 6455 framing, strict, as a server must read a client's (masked, no reserved bits or opcodes,
    shortest lengths, control frames <= 125 bytes and unfragmented, text only, UTF-8, strict JSON).

Output is bounded: every frame goes through one gate (Conn.write), which admits a frame only if the transport's
buffered bytes plus the whole frame stay within 7 MiB (data) or 8 MiB (control: pongs, closes); a refused frame is
never appended (a refused data frame closes 1013, a refused control frame aborts the socket).  At most 8 sockets
are closing at once (more are aborted at once), each aborted after 5 s.  Input is bounded: a socket holds at most
one message being read, its bytes within the cap (8 KiB before the hello, PAIR_LIMITS["frame"] after) and at most
1024 fragments, each counted.
"""

import asyncio
import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import sys
import time

from sagebrush._native import remote as _es256
from sagebrush.remote.gateway import Gateway

PAIR_PATH = "/sagebrush-kernel"
PAGE_ORIGIN = "https://sagebrush.space"
PAIR_LIMITS = {
    "codeMs": 5 * 60_000,     # a code's life
    "wrongAttempts": 5,       # wrong codes (or purposes) before the code is retired; wrong sessions before it is forgotten
    "helloMs": 30_000,        # from connecting to the hello
    "unpaired": 8,            # sockets in their handshake or hello at once
    "preHello": 8 * 1024,     # a message before the hello
    "frame": int(2.25 * 1024 * 1024) + 64 * 1024,  # a message after it: a run's body and its envelope
    "fragments": 1024,        # a message's fragments, empty ones counted
    "outData": 7 * 1024 * 1024,   # a socket's buffered output plus an answer's whole frame
    "outTotal": 8 * 1024 * 1024,  # ... plus a control frame's (room for the 1013 close)
    "closing": 8,             # sockets closing at once (more are aborted at once)
    "closingMs": 5_000,       # a closing socket's life before it is aborted
    "keyChars": 64,           # jkt and the key's x and y, before any other check of them
    "httpHead": 8 * 1024,     # the upgrade request's head
}
GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
_B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
_B64URL43 = re.compile(r"[A-Za-z0-9_-]{43}")
_WSKEY = re.compile(r"[A-Za-z0-9+/]{22}==")


def runner_version():
    """This runner's sagebrush version, as the hello reports it: the installed distribution's, or "dev" when this code
    isn't that distribution's (a source checkout, whatever else is installed)."""
    try:
        from importlib import metadata
        dist = metadata.distribution("sagebrush")
        here = os.path.realpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "__init__.py"))
        if os.path.realpath(str(dist.locate_file("sagebrush/__init__.py"))) != here:
            return "dev"
        return dist.version
    except Exception:
        return "dev"


_NEED = re.compile(r"\d{1,6}(\.\d{1,6}){0,3}")  # (a minimum: a release's numbers, nothing else)
# (a runner's version: this subset of PEP 440's canonical form, whole, or "dev" (astra's VERSION-2): numbers, then
# optionally a pre-release (aN, bN, rcN), a post-release (.postN), a dev release (.devN) and a local part (+x.y))
_VERSION = re.compile(r"(\d{1,6}(?:\.\d{1,6}){0,3})((?:a|b|rc)\d{1,6})?(\.post\d{1,6})?(\.dev\d{1,6})?(\+[A-Za-z0-9]{1,16}(?:\.[A-Za-z0-9]{1,16}){0,3})?")


def version_at_least(v, need):
    """Is version v at least need (a release's numbers, e.g. "0.9.0")?  A release gate, as PEP 440 orders it: "dev" (a
    checkout) always is; a pre-release (0.9.0rc1, 0.9.0a2, 0.9.0.dev3) is below its release; a post-release or a local
    version (0.9.0.post1, 0.9.0+x) is not."""
    if not isinstance(need, str) or not _NEED.fullmatch(need):
        return False  # (a malformed minimum never passes, not even for "dev" (daybreak3's VERSION-3))
    if v == "dev":
        return True
    m = _VERSION.fullmatch(v) if isinstance(v, str) else None
    if not m:
        return False  # (a malformed version never passes: the whole version is checked before any ordering)
    a, b = [int(x) for x in m.group(1).split(".")], [int(x) for x in need.split(".")]
    n = max(len(a), len(b))
    a, b = a + [0] * (n - len(a)), b + [0] * (n - len(b))
    if a != b:
        return a > b
    # (the release's own numbers: below it if a pre-release or a dev release; a post or local version is not)
    return m.group(2) is None and m.group(4) is None


VERSION = runner_version()
UPGRADE = "Run the newest version: uvx sagebrush@latest remote --loopback (it always fetches the latest)."


def b64url(b):
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode("ascii")


def _base32(b):
    return base64.b32encode(b).decode("ascii").rstrip("=")


def jwk_thumbprint(jwk):
    """The RFC 7638 thumbprint of an EC P-256 public JWK: SHA-256 over {crv, kty, x, y} in that order."""
    canon = json.dumps({"crv": jwk["crv"], "kty": jwk["kty"], "x": jwk["x"], "y": jwk["y"]}, separators=(",", ":"))
    return b64url(hashlib.sha256(canon.encode("utf-8")).digest())


def _canonical32(c):
    """32 bytes as canonical base64url: 43 characters, the last one's unused bits zero."""
    if not isinstance(c, str) or not _B64URL43.fullmatch(c):
        return False
    try:
        raw = base64.urlsafe_b64decode(c + "=")
    except ValueError:
        return False
    return len(raw) == 32 and b64url(raw) == c


def strict_json(text):
    """Strict JSON: valid JSON with no key twice in an object, no NaN or Infinity, or ValueError."""
    def pairs(items):
        d = {}
        for k, v in items:
            if k in d:
                raise ValueError("a key twice")
            d[k] = v
        return d

    def const(name):
        raise ValueError("not JSON: %s" % name)
    return json.loads(text, object_pairs_hook=pairs, parse_constant=const)


def page_key_error(p, stats=None):
    """Why the hello's DPoP key (params jwk and jkt) is refused, or None: lengths first, then the shape, canonical
    base64url, a point on P-256, and only then the thumbprint (the one costly step, counted in stats)."""
    jwk = p.get("jwk")
    jx = jwk.get("x") if isinstance(jwk, dict) else None
    jy = jwk.get("y") if isinstance(jwk, dict) else None

    def too_long(v):
        return isinstance(v, str) and len(v) > PAIR_LIMITS["keyChars"]
    if too_long(p.get("jkt")) or too_long(jx) or too_long(jy):
        return "the page's key is too long"
    if not (isinstance(jwk, dict) and sorted(jwk) == ["crv", "kty", "x", "y"] and jwk["kty"] == "EC" and jwk["crv"] == "P-256"
            and isinstance(jx, str) and isinstance(jy, str)):
        return "the page's key must be an EC P-256 public key"
    if not (isinstance(p.get("jkt"), str) and _B64URL43.fullmatch(p["jkt"]) and _canonical32(jx) and _canonical32(jy)):
        return "the page's key is not canonical base64url"
    if not _es256.es256_key_ok(base64.urlsafe_b64decode(jx + "="), base64.urlsafe_b64decode(jy + "=")):
        return "the page's key isn't a point on P-256"
    if stats is not None:
        stats["thumbprints"] += 1
    if p["jkt"] != jwk_thumbprint(jwk):
        return "the key's thumbprint doesn't match"
    return None


def _close_status_ok(s):
    """A Close status a peer may send (RFC 6455 §7.4)."""
    return (1000 <= s <= 1014 and s not in (1004, 1005, 1006)) or 3000 <= s <= 4999


def _frame_of(b0, payload):
    n = len(payload)
    if n < 126:
        head = bytes([b0, n])
    elif n < 65536:
        head = bytes([b0, 126]) + n.to_bytes(2, "big")
    else:
        head = bytes([b0, 127]) + n.to_bytes(8, "big")
    return head + payload


class RealTimers:
    def now(self):
        return int(time.time() * 1000)

    def set_timeout(self, fn, ms):
        return asyncio.get_running_loop().call_later(ms / 1000, fn)

    def clear_timeout(self, h):
        if h is not None:
            h.cancel()


class Conn:
    def __init__(self, transport, server):
        self.transport, self.server = transport, server
        self.buf = bytearray()
        self.parts, self.parts_len = [], 0
        self.in_msg = False
        self.fragments = 0
        self.closed = False
        self.paired = False
        self.token = None
        self.jkt = None
        self.hello_timer = None
        self.closing_timer = None

    # ---- the gate: the only writer of frames
    def _buffered(self):
        try:
            return self.transport.get_write_buffer_size()
        except Exception:
            return 0

    def write(self, frame, kind):
        if self.closed:
            return False
        caps = self.server.out_caps
        buffered = self._buffered()
        if buffered + len(frame) <= (caps["data"] if kind == "data" else caps["total"]):
            self.transport.write(frame)
            self.server.stats["maxBuffered"] = max(self.server.stats["maxBuffered"], buffered + len(frame))
            return True
        self.server.stats["overflows"] += 1
        if kind == "data":
            self.close(1013, "the page isn't reading its answers")
        else:
            self.destroy()
        return False

    def fits(self, n, kind):
        """Would a frame of n payload bytes fit through the gate now?  (A stream asks before each chunk.)"""
        caps = self.server.out_caps
        frame = n + (2 if n < 126 else 4 if n < 65536 else 10)
        return not self.closed and self._buffered() + frame <= (caps["data"] if kind == "data" else caps["total"])

    def send_text(self, text, kind):
        return self.write(_frame_of(0x81, text.encode("utf-8", "surrogatepass")), kind)

    def send(self, obj):
        self.write(_frame_of(0x81, json.dumps(obj, separators=(",", ":")).encode("utf-8")), "data")

    def close(self, code, reason=""):
        if self.closed:
            return
        body = code.to_bytes(2, "big") + reason[:120].encode("utf-8")
        if not self.write(_frame_of(0x88, body), "control"):
            return  # (refused: aborted)
        self.ended()

    def release(self):
        self.buf = bytearray()
        self.parts, self.parts_len = [], 0
        self.in_msg = False
        self.fragments = 0

    def ended(self):
        """Our side done (our close sent, or the page's EOF): closing, until the socket closes or closingMs."""
        self.closed = True
        self.release()
        try:
            if self.transport.can_write_eof():
                self.transport.write_eof()
        except (OSError, RuntimeError):
            pass
        self.server.dropped(self)
        self.server.closing_add(self)

    def destroy(self):
        self.closed = True
        self.release()
        self.transport.abort()
        self.server.dropped(self)
        self.server.closing_done(self)

    def cap(self):
        return PAIR_LIMITS["frame"] if self.paired else PAIR_LIMITS["preHello"]

    def feed(self, chunk):
        if self.closed:
            return
        self.buf += chunk
        while True:
            if self.closed or len(self.buf) < 2:
                return
            b0, b1 = self.buf[0], self.buf[1]
            fin, rsv, op, masked = bool(b0 & 0x80), b0 & 0x70, b0 & 0x0F, bool(b1 & 0x80)
            if rsv:
                return self.close(1002, "reserved bits")
            if not masked:
                return self.close(1002, "a client frame must be masked")
            n, at = b1 & 0x7F, 2
            if n == 126:
                if len(self.buf) < 4:
                    return
                n, at = int.from_bytes(self.buf[2:4], "big"), 4
                if n < 126:
                    return self.close(1002, "a length not in its shortest form")
            elif n == 127:
                if len(self.buf) < 10:
                    return
                big = int.from_bytes(self.buf[2:10], "big")
                if big >> 63:
                    return self.close(1002, "a 64-bit length's top bit must be 0")
                if big < 65536:
                    return self.close(1002, "a length not in its shortest form")
                if big > PAIR_LIMITS["frame"] * 2:
                    return self.close(1009, "too big")
                n, at = big, 10
            control = op >= 0x8
            if control and (n > 125 or not fin):
                return self.close(1002, "bad control frame")
            # (the cap, from the length alone, before any of the payload is buffered or parsed)
            if not control and self.parts_len + n > self.cap():
                return self.close(1009, "message too big")
            if len(self.buf) < at + 4 + n:
                return
            mask = bytes(self.buf[at:at + 4])
            payload = bytearray(self.buf[at + 4:at + 4 + n])
            for k in range(len(payload)):
                payload[k] ^= mask[k & 3]
            del self.buf[:at + 4 + n]
            if op == 0x8:
                if len(payload) == 1:
                    return self.close(1002, "a close status is two bytes")
                if len(payload) >= 2 and not _close_status_ok(int.from_bytes(payload[:2], "big")):
                    return self.close(1002, "a close status a peer may not send")
                if len(payload) > 2:
                    try:
                        bytes(payload[2:]).decode("utf-8")
                    except UnicodeDecodeError:
                        return self.close(1007, "a close reason not UTF-8")
                return self.close(1000)
            if op == 0x9:
                self.write(_frame_of(0x8A, bytes(payload)), "control")
                continue
            if op == 0xA:
                continue
            if op == 0x2:
                return self.close(1003, "text frames only")
            if op == 0x1:
                if self.in_msg:
                    return self.close(1002, "a new message inside a fragmented one")
                self.in_msg = True
                self.fragments = 0
            elif op == 0x0:
                if not self.in_msg:
                    return self.close(1002, "a continuation with nothing to continue")
            else:
                return self.close(1002, "reserved opcode")
            self.fragments += 1
            if self.fragments > PAIR_LIMITS["fragments"]:
                return self.close(1009, "too many fragments")
            if payload:
                self.parts.append(bytes(payload))
                self.parts_len += len(payload)
            if not fin:
                continue
            whole = b"".join(self.parts)
            self.parts, self.parts_len, self.in_msg, self.fragments = [], 0, False, 0
            try:
                text = whole.decode("utf-8")
            except UnicodeDecodeError:
                return self.close(1007, "not UTF-8")
            try:
                msg = strict_json(text)
            except (ValueError, RecursionError):
                return self.close(1007, "malformed JSON")
            self.server.message(self, msg)


class _Protocol(asyncio.Protocol):
    """One TCP connection: the upgrade request's head, then the WebSocket's bytes to its Conn.

    It counts among the unpaired from its TCP admission, not from its upgrade (astra's R763-HTTP-1): a connection
    over the cap is refused at once (503), and one whose head isn't complete within helloMs is closed; at the upgrade
    the reservation passes to the Conn (counted once), and every other end (a refusal, EOF, a lost connection,
    shutdown) releases it."""

    def __init__(self, server):
        self.server = server
        self.transport = None
        self.head = bytearray()
        self.conn = None
        self.reserved = False
        self.timer = None
        self.deadline = None  # (ms: the handshake and the hello must both be done by then, from the TCP admission)

    def connection_made(self, transport):
        self.transport = transport
        if self.server.unpaired_count >= PAIR_LIMITS["unpaired"]:
            return self.server._refuse_http(transport, 503, "Service Unavailable")
        self.server.unpaired_count += 1
        self.reserved = True
        self.server.pending.add(self)

        def too_slow():
            self.timer = None
            if self.conn is None:
                self.release()
                transport.abort()
        self.deadline = self.server.timers.now() + PAIR_LIMITS["helloMs"]
        self.timer = self.server.timers.set_timeout(too_slow, PAIR_LIMITS["helloMs"])

    def release(self):
        """The reservation given back (a connection that never became a Conn)."""
        self.server.timers.clear_timeout(self.timer)
        self.timer = None
        self.server.pending.discard(self)
        if self.reserved:
            self.reserved = False
            self.server.unpaired_count -= 1

    def data_received(self, data):
        if self.conn is not None:
            return self.conn.feed(data)
        if not self.reserved:
            return  # (refused already)
        self.head += data
        end = self.head.find(b"\r\n\r\n")
        # (the head's own length bounds it, wherever its end falls in what arrived (astra's R763-HEAD-2): at most
        # httpHead bytes before the blank line, and no more than httpHead + 3 retained while looking for it)
        if (end < 0 and len(self.head) > PAIR_LIMITS["httpHead"] + 3) or end > PAIR_LIMITS["httpHead"]:
            self.head = bytearray()
            self.release()
            return self.server._refuse_http(self.transport, 431, "Request Header Fields Too Large")
        if end < 0:
            return
        rest = bytes(self.head[end + 4:])
        head = bytes(self.head[:end])
        self.head = bytearray()
        c = self.server._upgrade(self.transport, head, self)
        if c is None:
            self.release()
            return
        self.conn = c
        if rest:
            c.feed(rest)

    def eof_received(self):
        c = self.conn
        if c is None:
            self.release()
            return False
        if not c.closed:
            c.ended()
        return False

    def connection_lost(self, exc):
        c = self.conn
        if c is None:
            self.release()
            return
        if not c.closed:
            c.closed = True
            c.release()
            self.server.dropped(c)
        self.server.closing_done(c)


class PairServer:
    def __init__(self, dev_origin=None, timers=None, out_caps=None, port=None, cwd=None, err=None):
        self.timers = timers or RealTimers()
        self.out_caps = out_caps or {"data": PAIR_LIMITS["outData"], "total": PAIR_LIMITS["outTotal"]}
        self.dev_origin = dev_origin
        self.err = err or (lambda s: sys.stderr.write(s))
        self.port = 0
        self.code = _base32(secrets.token_bytes(16))  # (128 bits, 26 letters and digits)
        self.incarnation = secrets.token_hex(8)  # (random per process start: a page tells "the runner restarted" from "reconnected", §4)
        self.code_issued = self.timers.now()
        self.code_used = False
        self.code_retired = False
        self.wrong = 0
        self.session = None
        self.session_wrong = 0
        self.paired_conn = None
        self.unpaired_count = 0
        self.conns = set()
        self.closing = set()
        self.pending = set()  # (TCP connections before their upgrade, each holding an unpaired place)
        self.stats = {"maxBuffered": 0, "overflows": 0, "thumbprints": 0, "destroyedAtCap": 0}
        self.gateway = Gateway(self, port=port, cwd=cwd)
        self.server = None

    async def listen(self, port=0):
        loop = asyncio.get_running_loop()
        self.server = await loop.create_server(lambda: _Protocol(self), "127.0.0.1", port)
        self.port = self.server.sockets[0].getsockname()[1]
        return self.port

    def link(self):
        return "%s/?kpair=%s&kport=%d" % (self.dev_origin or PAGE_ORIGIN, self.code, self.port)

    def close(self):
        self.gateway.shutdown()
        for c in list(self.conns) + list(self.closing):
            self.timers.clear_timeout(c.hello_timer)
            self.timers.clear_timeout(c.closing_timer)
            c.closed = True
            c.release()
            c.transport.abort()
        for p in list(self.pending):
            p.release()
            p.transport.abort()
        self.conns.clear()
        self.closing.clear()
        if self.server is not None:
            self.server.close()

    def _refuse_http(self, transport, status, text):
        transport.write(("HTTP/1.1 %d %s\r\nConnection: close\r\nContent-Length: 0\r\n\r\n" % (status, text)).encode("ascii"))
        transport.close()

    def _upgrade(self, transport, head, proto=None):
        try:
            text = head.decode("latin-1")
        except UnicodeDecodeError:
            return self._refuse_http(transport, 400, "Bad Request")
        lines = text.split("\r\n")
        parts = lines[0].split(" ")
        if len(parts) != 3:
            return self._refuse_http(transport, 400, "Bad Request")
        method, target, _ = parts
        if target.split("?")[0] != PAIR_PATH:
            return self._refuse_http(transport, 400, "Bad Request")
        headers, counts = {}, {}
        for line in lines[1:]:
            if ":" not in line:
                return self._refuse_http(transport, 400, "Bad Request")
            k, v = line.split(":", 1)
            k = k.strip().lower()
            counts[k] = counts.get(k, 0) + 1
            headers[k] = v.strip()
        if any(counts.get(h, 0) > 1 for h in ("origin", "host", "sec-websocket-key", "sec-websocket-version", "upgrade", "connection")):
            return self._refuse_http(transport, 400, "Bad Request")
        origin = headers.get("origin")
        if not (origin == PAGE_ORIGIN or (self.dev_origin is not None and origin == self.dev_origin)):
            return self._refuse_http(transport, 403, "Forbidden")
        if headers.get("host") not in ("127.0.0.1:%d" % self.port, "localhost:%d" % self.port):
            return self._refuse_http(transport, 403, "Forbidden")
        key = headers.get("sec-websocket-key", "")
        key_ok = bool(_WSKEY.fullmatch(key)) and len(base64.b64decode(key)) == 16
        if method != "GET" or not key_ok or headers.get("sec-websocket-version") != "13" or headers.get("upgrade", "").lower() != "websocket":
            return self._refuse_http(transport, 403, "Forbidden")
        accept = base64.b64encode(hashlib.sha1((key + GUID).encode("ascii")).digest()).decode("ascii")
        transport.write(("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                         "Sec-WebSocket-Accept: %s\r\n\r\n" % accept).encode("ascii"))
        return self.attach(transport, proto)

    def attach(self, transport, proto=None):
        """An upgraded socket's Conn.  Its unpaired place is the TCP connection's reservation, passed on (counted once);
        attached without one (tests), it takes its own."""
        c = Conn(transport, self)
        self.conns.add(c)
        # (the hello's deadline is the connection's, from its TCP admission (astra's #763 r2 note): an upgrade passes
        # on what is left of it, never a fresh helloMs)
        left = PAIR_LIMITS["helloMs"]
        if proto is not None and proto.reserved:
            self.timers.clear_timeout(proto.timer)
            proto.timer = None
            proto.reserved = False
            self.pending.discard(proto)
            left = max(0, proto.deadline - self.timers.now())
        else:
            self.unpaired_count += 1

        def no_hello():
            if not c.paired:
                c.close(1008, "no hello in time")
        c.hello_timer = self.timers.set_timeout(no_hello, left)
        return c

    def dropped(self, c):
        """A socket gone: its hello timer, its place among the unpaired, or the pairing it held (and its token)."""
        self.timers.clear_timeout(c.hello_timer)
        if c not in self.conns:
            return
        self.conns.discard(c)
        if c.paired:
            if self.paired_conn is c:
                self.paired_conn = None
            c.token = None
            self.gateway.socket_lost(c)
        else:
            self.unpaired_count -= 1

    def closing_add(self, c):
        if len(self.closing) >= PAIR_LIMITS["closing"]:
            self.stats["destroyedAtCap"] += 1
            c.transport.abort()
            return
        self.closing.add(c)

        def done():
            c.closing_timer = None
            self.closing.discard(c)
            c.transport.abort()
        c.closing_timer = self.timers.set_timeout(done, PAIR_LIMITS["closingMs"])

    def closing_done(self, c):
        self.timers.clear_timeout(c.closing_timer)
        c.closing_timer = None
        self.closing.discard(c)

    def _refuse(self, c, rid, kind, message):
        c.send({"jsonrpc": "2.0", "id": rid if isinstance(rid, str) else None,
                "error": {"code": -32000, "message": message, "data": {"code": kind, "message": message}}})
        c.close(1008 if kind == "refused" else 1002, message)

    def message(self, c, msg):
        if not c.paired:
            return self._hello(c, msg)
        plain = isinstance(msg, dict)
        if plain and msg.get("unpair") is True and len(msg) == 1:
            self.session = None
            self.session_wrong = 0
            self.gateway.shutdown()
            return c.close(1000, "unpaired")
        if plain and len(msg) == 1 and "cancel" in msg:
            return self.gateway.cancel(c, msg["cancel"])
        if plain and "id" in msg:
            return self.gateway.frame(c, msg)
        return c.close(1002, "not a message of this protocol")

    def _hello(self, c, msg):
        ok = (isinstance(msg, dict) and msg.get("jsonrpc") == "2.0" and isinstance(msg.get("id"), str) and msg.get("method") == "hello"
              and isinstance(msg.get("params"), dict))
        rid = msg.get("id") if isinstance(msg, dict) else None
        if not ok:
            return self._refuse(c, rid, "protocol", "the first message must be the hello")
        p = msg["params"]
        if p.get("protocol") != 1 or isinstance(p.get("protocol"), bool):
            return self._refuse(c, rid, "protocol", "protocol 1 only")
        has_code, has_session = isinstance(p.get("code"), str), isinstance(p.get("session"), str)
        if has_code == has_session:
            return self._refuse(c, rid, "refused", "a hello carries exactly one of code and session")
        bad = page_key_error(p, self.stats)
        if bad:
            return self._refuse(c, rid, "refused", bad)
        if has_code:
            if self.code_used:
                return self._refuse(c, rid, "refused", "this code was used: run the command again for a new one")
            if self.code_retired:
                return self._refuse(c, rid, "refused", "too many wrong attempts: run the command again for a new code")
            if self.timers.now() - self.code_issued > PAIR_LIMITS["codeMs"]:
                return self._refuse(c, rid, "refused", "this code expired: run the command again for a new one")
            if not hmac.compare_digest(p["code"].upper().encode("utf-8"), self.code.encode("utf-8")):
                self.wrong += 1
                if self.wrong >= PAIR_LIMITS["wrongAttempts"]:
                    self.code_retired = True
                return self._refuse(c, rid, "refused", "wrong code")
            if p.get("purpose") != "kernel":  # (the right code, a wrong purpose: a wrong attempt; the code NOT spent)
                self.wrong += 1
                if self.wrong >= PAIR_LIMITS["wrongAttempts"]:
                    self.code_retired = True
                return self._refuse(c, rid, "refused", "this is a kernel's pairing (purpose \"kernel\")")
            if self.paired_conn is not None:
                return self._refuse(c, rid, "refused", "another page is paired with this computer")
            self.code_used = True
            session = None
            if p.get("remember") is True:
                session = b64url(secrets.token_bytes(32))
                self.session = hashlib.sha256(session.encode("ascii")).digest()
                self.session_wrong = 0
            return self._paired(c, rid, p["jkt"], session, p.get("needs"))
        if p.get("purpose") != "kernel":
            return self._refuse(c, rid, "refused", "this is a kernel's pairing (purpose \"kernel\")")
        if self.session is None:
            return self._refuse(c, rid, "refused", "this computer doesn't remember a page: pair with a new code")
        if not hmac.compare_digest(hashlib.sha256(p["session"].encode("utf-8", "surrogatepass")).digest(), self.session):
            self.session_wrong += 1
            if self.session_wrong >= PAIR_LIMITS["wrongAttempts"]:
                self.session, self.session_wrong = None, 0
            return self._refuse(c, rid, "refused", "wrong session")
        if self.paired_conn is not None:
            return self._refuse(c, rid, "refused", "another page is paired with this computer")
        return self._paired(c, rid, p["jkt"], None, p.get("needs"))

    def _paired(self, c, rid, jkt, session, needs=None):
        self.timers.clear_timeout(c.hello_timer)
        # (astra's NEEDS-1: only an authenticated hello's minimum is said, and only one of a release's numbers, so no
        # page text reaches this terminal; the page will refuse this runner, and the person is looking here too)
        if isinstance(needs, str) and _NEED.fullmatch(needs) and not version_at_least(VERSION, needs):
            self.err("This page needs sagebrush %s or newer; this is %s. %s\n" % (needs, VERSION, UPGRADE))
        c.paired = True
        c.jkt = jkt
        c.token = b64url(secrets.token_bytes(32))  # (this socket's and this key's; never written anywhere)
        self.unpaired_count -= 1
        self.paired_conn = c
        self.gateway.socket_paired(c)
        self.err("A page is paired.\n")
        result = {"protocol": 1, "purpose": "kernel", "token": c.token, "nonce": self.gateway.current_nonce(),
                  "limits": {"frame": PAIR_LIMITS["frame"]}, "incarnation": self.incarnation, "version": VERSION}
        if session:
            result["session"] = session
        c.send({"jsonrpc": "2.0", "id": rid, "result": result})


async def run_loopback(port=0, dev_origin=None, out=None, err=None, cwd=None):
    """`sagebrush remote --loopback [--port N]`: the link on stdout, the code on stderr; until Ctrl-C or SIGTERM,
    which close the sockets (1001) and stop the kernel's process group (design §7 R8)."""
    out = out or (lambda s: (sys.stdout.write(s), sys.stdout.flush()))
    err = err or (lambda s: (sys.stderr.write(s), sys.stderr.flush()))
    server = PairServer(dev_origin=dev_origin, err=err, cwd=cwd)
    await server.listen(port)
    err("sagebrush %s (Python %s at %s)\n" % (VERSION, sys.version.split()[0], sys.executable))
    out(server.link() + "\n")
    err("The link above is for a sagebrush.space page that pairs with this computer.\n"
        "Pairing code: %s (single use, for 5 minutes). Code you run there will run on this computer, in this Python "
        "(%s), with your files and permissions.\n" % (server.code, sys.executable))
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    import signal
    for s in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(s, stop.set)
        except (NotImplementedError, RuntimeError):
            pass
    try:
        await stop.wait()
    finally:
        for c in list(server.conns):
            c.close(1001, "the runner stopped")
        server.close()
        from sagebrush.remote.gateway import drain_groups
        left = await drain_groups(3.0)  # (the escalation awaited: every kernel group empty, or SIGKILLed at 3 s)
        if left:
            err("Stopped (process groups %s were killed at the deadline).\n" % ", ".join(map(str, left)))
        else:
            err("Stopped.\n")
    return 0


USAGE = ("usage: sagebrush remote [--serve-agents --agent-cmd COMMAND]\n"
         "       sagebrush remote login [--origin URL] [--name NAME] [--force]\n"
         "       sagebrush remote --loopback [--port N]\n"
         "  (this computer as a runner for your sagebrush.space notebooks, in this Python: through the\n"
         "   cloud relay, enrolling it first if needed; login: enroll it again; --loopback: a paired\n"
         "   page's runner, over 127.0.0.1; --serve-agents: also chat pages with your own agent, which\n"
         "   --agent-cmd starts: its command, split like a shell's words, never run through a shell)\n")


def main(argv):
    """`sagebrush remote` (the relay), `sagebrush remote login ...`, or `sagebrush remote --loopback [--port N]`."""
    if argv[:1] in (["-h"], ["--help"]):
        # (the usage, on stdout, and nothing started: no relay, no port, no enrollment)
        sys.stdout.write(USAGE)
        return 0
    if argv[:1] == ["login"]:
        from sagebrush.remote.enroll import main as login_main
        return login_main(argv[1:])
    if not argv or not (argv[0] in ("--loopback", "--port") or argv[0].startswith("--port=")):
        # (the relay, with its own arguments (--serve-agents, --agent-cmd), which it checks before anything starts;
        # the loopback's begin with --loopback or --port, so an agent's command is never read as one)
        from sagebrush.remote.relay import main as relay_main
        return relay_main(argv)
    port, loopback = 0, False
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--loopback":
            loopback = True
        elif a == "--port" and i + 1 < len(argv):
            i += 1
            port = argv[i]
        elif a.startswith("--port="):
            port = a[7:]
        else:
            sys.stderr.write("sagebrush remote: unknown argument %s\n" % a)
            return 2
        i += 1
    if os.name == "nt":
        # (Stop and the kernel's tree end use POSIX process groups, which Windows doesn't have)
        sys.stderr.write("sagebrush remote: not on Windows yet; run it in WSL (Windows Subsystem for Linux), where it works as "
                         "on Linux, and pair this browser with it as usual\n")
        return 2
    # (an ordinary check, never assert: python -O removes asserts (daybreak3's R763-CLI-1))
    try:
        port = int(port)
    except ValueError:
        port = -1
    if not 0 <= port <= 65535:
        sys.stderr.write("sagebrush remote: --port takes a port number (0 to 65535)\n")
        return 2
    if not loopback:
        sys.stderr.write(USAGE)
        return 2
    return asyncio.run(run_loopback(port, dev_origin=os.environ.get("SAGEBRUSH_KERNEL_DEV_ORIGIN") or None))
