"""`sagebrush remote`: this computer as a runner for its account's sagebrush.space pages, through the cloud relay
(design remote-v1 §2-§5 and §13.6; build step b3b).  The runner dials out, so it works behind NAT and proxies; the
gateway (gateway.py) and the kernel child (child.py) are the loopback runner's, unchanged.

One outbound WebSocket, wss://<origin>/api/remote/v1/runner, RFC 6455 as a client (masked frames, server frames
unmasked, text only, no extensions), over `ssl` (and an HTTP CONNECT proxy from HTTPS_PROXY, honouring NO_PROXY):

  - its upgrade is authenticated by the enrolled key (keys.py): a challenge from POST /api/remote/v1/challenge,
    signed (ES256, native) over "sb-remote-chal/1\\n" + challenge, sent as the x-sb-remote-challenge and
    x-sb-remote-signature headers; a fresh challenge for every connection;
  - the relay's control messages are recognized only by the exact bytes {"relay":" at the start, and strict-parsed
    against a fixed schema (<= 256 bytes, the one serialization, `relay` first, a fixed key list per op, no other
    values); anything else is the page's application message, strict JSON, refused (1008) if it has a top-level
    `relay` key (R17-CONTROL: neither side can forge the other's controls);
  - page-open starts a page (one at a time: a new one replaces the old), which pairs with a hello carrying its DPoP
    key and no code (the relay authenticated the page's session; a code or session hello is refused here, as a
    codeless one is on loopback); page-close ends it; a receipt is acked at once, after every byte before it was read;
    pings every 15 s, and a leg with 2 pings unanswered is dead;
  - the runner can't close a page by itself (the peer's only controls are ping and ack): refusing or closing a page
    closes the whole leg, and the runner dials again; the page reconnects and reconciles (its existing recovery);
  - a lost leg leaves the bindings and their kernels running (R1); dialing again backs off 1, 2, 4 ... 60 s, +-20%;
  - revoked ({"relay":"revoked"} or close 4403), or replaced by another runner with this key (4009): every kernel
    stopped by the tree rule, and the command ends.  4429 (the account's day budget): back off the longest.
"""

import asyncio
import base64
import hashlib
import json
import os
import random
import re
import socket
import ssl
import sys
import time
import urllib.parse
import urllib.request

from sagebrush.remote import keys as _keys
from sagebrush.remote.enroll import EnrollError, _post, check_origin
from sagebrush.remote.gateway import Gateway
from sagebrush.remote.pair import GUID, PAIR_LIMITS, RealTimers, b64url, page_key_error, strict_json

RELAY_PATH = "/api/remote/v1/runner"
CHAL_TAG = "sb-remote-chal/1\n"
CONTROL_PREFIX = '{"relay":"'
RELAY_LIMITS = {
    "control": 256,             # a control message's bytes
    "pingMs": 15_000,           # between pings
    "missedPongs": 2,           # pings unanswered: the leg is dead
    "backoffMs": (1_000, 60_000),
    "jitter": 0.2,
    "budgetBackoffMs": 60_000,  # after 4429
    "stableMs": 60_000,         # a leg up this long resets the backoff
    "connectMs": 30_000,        # TCP, proxy, TLS and the upgrade's answer
    "head": 8 * 1024,           # the upgrade's (or the proxy's) answer head
    "inbound": PAIR_LIMITS["frame"],  # a message from the relay: the page's largest (2.25 MiB + 64 KiB)
    "fragments": 1024,
    "outData": PAIR_LIMITS["outData"],
    "outTotal": PAIR_LIMITS["outTotal"],
}
_SAFE = 2 ** 53 - 1
_CONN = re.compile(r"[A-Za-z0-9_-]{1,64}")
_TOKEN = re.compile(r"[A-Za-z0-9_-]{22}")
# (relay -> peer: each op's keys after "relay", in order, and each value's check)
_IN_OPS = {
    "page-open": ("conn", "kind", "gen"),
    "page-close": ("conn", "gen"),
    "receipt": ("r", "upto"),
    "revoked": (),
    "dropped": ("gen", "bytes"),
    "pong": (),
}
_CHECK = {
    "conn": lambda v: isinstance(v, str) and bool(_CONN.fullmatch(v)),
    "kind": lambda v: v in ("runner", "agent"),
    "gen": lambda v: type(v) is int and 1 <= v <= _SAFE,
    "r": lambda v: isinstance(v, str) and bool(_TOKEN.fullmatch(v)),
    "upto": lambda v: type(v) is int and 0 <= v <= _SAFE,
    "bytes": lambda v: type(v) is int and 0 <= v <= _SAFE,
}


class ControlError(ValueError):
    pass


def parse_control(text):
    """A relay -> peer control message, strictly (design §5, r1.8 R17-CONTROL), or ControlError.  The caller has
    already seen the exact prefix {"relay":" (and only then calls this)."""
    if not text.startswith(CONTROL_PREFIX):
        raise ControlError("not a control message")
    if len(text.encode("utf-8", "surrogatepass")) > RELAY_LIMITS["control"]:
        raise ControlError("a control message over 256 bytes")

    def pairs(kv):
        names = [k for k, _ in kv]
        if len(set(names)) != len(names):
            raise ControlError("a key twice")
        return kv

    def no_float(s):
        raise ControlError("a number not an integer")

    def no_const(s):
        raise ControlError("not JSON: %s" % s)
    try:
        v = json.loads(text, object_pairs_hook=pairs, parse_float=no_float, parse_constant=no_const)
    except ControlError:
        raise
    except (ValueError, RecursionError):
        raise ControlError("malformed")
    if not isinstance(v, list) or not v or v[0][0] != "relay" or not isinstance(v[0][1], str):
        raise ControlError("relay first")
    op = v[0][1]
    fields = _IN_OPS.get(op)
    if fields is None:
        raise ControlError("an unknown op")
    if [k for k, _ in v] != ["relay", *fields]:
        raise ControlError("the op's keys, in order")
    d = dict(v)
    for f in fields:
        if not _CHECK[f](d[f]):
            raise ControlError("a bad %s" % f)
    if json.dumps(d, separators=(",", ":"), ensure_ascii=False) != text:
        raise ControlError("not the one serialization")
    return d


def ping_text():
    return '{"relay":"ping"}'


def ack_text(r):
    return '{"relay":"ack","r":"%s"}' % r


class Fatal(Exception):
    """The runner stops: revoked, replaced, or never enrolled."""

    def __init__(self, message, code):
        super().__init__(message)
        self.code = code


class Retry(Exception):
    """This leg failed; dial again (after the backoff, or at least delay_ms)."""

    def __init__(self, message, delay_ms=0):
        super().__init__(message)
        self.delay_ms = delay_ms


def backoff_ms(attempt, rnd=random.random):
    """1, 2, 4 ... 60 s, +-20% (design §4)."""
    lo, hi = RELAY_LIMITS["backoffMs"]
    base = min(hi, lo * (2 ** min(attempt, 16)))
    j = RELAY_LIMITS["jitter"]
    return int(base * (1 - j + 2 * j * rnd()))


def _mask(payload, key):
    n = len(payload)
    if not n:
        return b""
    rep = (key * (n // 4 + 1))[:n]
    return (int.from_bytes(payload, "little") ^ int.from_bytes(rep, "little")).to_bytes(n, "little")


def client_frame(op, payload, key=None):
    """A client frame: FIN, the opcode, masked (RFC 6455 §5.3: a client masks every frame)."""
    key = key if key is not None else os.urandom(4)
    n = len(payload)
    if n < 126:
        head = bytes([0x80 | op, 0x80 | n])
    elif n < 65536:
        head = bytes([0x80 | op, 0x80 | 126]) + n.to_bytes(2, "big")
    else:
        head = bytes([0x80 | op, 0x80 | 127]) + n.to_bytes(8, "big")
    return head + key + _mask(payload, key)


def _proxy_for(host, scheme):
    """The proxy URL for this host, from the environment (HTTPS_PROXY, NO_PROXY), or None."""
    if scheme != "https":
        return None
    p = urllib.request.getproxies_environment().get("https")
    if not p or urllib.request.proxy_bypass_environment(host):
        return None
    return p


def _dial(host, port, timeout, proxy=None):
    """A connected blocking socket to host:port, directly or through an HTTP CONNECT proxy (run in a thread)."""
    if not proxy:
        return socket.create_connection((host, port), timeout=timeout)
    u = urllib.parse.urlsplit(proxy if "://" in proxy else "http://" + proxy)
    if u.scheme not in ("http", ""):
        raise Retry("only an http:// proxy is supported (HTTPS_PROXY=%s)" % u.scheme)
    s = socket.create_connection((u.hostname, u.port or 80), timeout=timeout)
    try:
        auth = ""
        if u.username:
            cred = "%s:%s" % (urllib.parse.unquote(u.username), urllib.parse.unquote(u.password or ""))
            auth = "Proxy-Authorization: Basic %s\r\n" % base64.b64encode(cred.encode("utf-8")).decode("ascii")
        s.sendall(("CONNECT %s:%d HTTP/1.1\r\nHost: %s:%d\r\n%s\r\n" % (host, port, host, port, auth)).encode("ascii"))
        head = b""
        while b"\r\n\r\n" not in head:
            chunk = s.recv(1)  # (byte by byte: nothing past the head may be consumed; it's the TLS server's)
            if not chunk:
                raise Retry("the proxy closed the connection")
            head += chunk
            if len(head) > RELAY_LIMITS["head"]:
                raise Retry("the proxy's answer is too long")
        status = head.split(b"\r\n", 1)[0].split(b" ")
        if len(status) < 2 or status[1] != b"200":
            raise Retry("the proxy refused: %s" % head.split(b"\r\n", 1)[0].decode("latin-1")[:80])
        return s
    except BaseException:
        s.close()
        raise


class Leg:
    """One connection to the relay: the upgrade, then frames.  on_text(text) gets each whole message; on_end(code,
    reason) once, when it ends however it ends."""

    def __init__(self, reader, writer, on_text, on_end):
        self.r, self.w = reader, writer
        self.on_text, self.on_end = on_text, on_end
        self.buf = bytearray()
        self.parts, self.parts_len, self.in_msg, self.fragments = [], 0, False, 0
        self.closed = False
        self.ended = False
        self.task = None
        self.stats = {"maxBuffered": 0, "overflows": 0}

    # ---- the gate: the only writer
    def _buffered(self):
        try:
            return self.w.transport.get_write_buffer_size()
        except Exception:
            return 0

    def write(self, frame, kind):
        if self.closed:
            return False
        buffered = self._buffered()
        if buffered + len(frame) <= (RELAY_LIMITS["outData"] if kind == "data" else RELAY_LIMITS["outTotal"]):
            self.w.write(frame)
            self.stats["maxBuffered"] = max(self.stats["maxBuffered"], buffered + len(frame))
            return True
        self.stats["overflows"] += 1
        if kind == "data":
            self.close(1013, "the page isn't reading its answers")
        else:
            self.abort("the relay isn't reading")
        return False

    def fits(self, n, kind):
        frame = n + (6 if n < 126 else 8 if n < 65536 else 14)
        return not self.closed and self._buffered() + frame <= (RELAY_LIMITS["outData"] if kind == "data" else RELAY_LIMITS["outTotal"])

    def send_text(self, text, kind="data"):
        return self.write(client_frame(0x1, text.encode("utf-8", "surrogatepass")), kind)

    def close(self, code, reason=""):
        if self.closed:
            return
        self.write(client_frame(0x8, code.to_bytes(2, "big") + reason[:120].encode("utf-8")), "control")
        self.closed = True
        self._end(code, reason)
        try:
            self.w.close()
        except Exception:
            pass

    def abort(self, reason):
        self.closed = True
        try:
            self.w.transport.abort()
        except Exception:
            pass
        self._end(1006, reason)

    def _end(self, code, reason):
        if not self.ended:
            self.ended = True
            self.buf, self.parts = bytearray(), []
            self.on_end(code, reason)

    # ---- reading: the relay's frames, as a client must read a server's
    async def run(self, first=b""):
        try:
            if first:
                self.feed(first)
            while not self.closed:
                chunk = await self.r.read(65536)
                if not chunk:
                    break
                self.feed(chunk)
        except (OSError, ssl.SSLError, asyncio.IncompleteReadError):
            pass
        finally:
            if not self.ended:
                self.abort("the relay connection was lost")

    def feed(self, chunk):
        if self.closed:
            return
        self.buf += chunk
        while not self.closed and len(self.buf) >= 2:
            b0, b1 = self.buf[0], self.buf[1]
            fin, rsv, op, masked = bool(b0 & 0x80), b0 & 0x70, b0 & 0x0F, bool(b1 & 0x80)
            if rsv:
                return self.close(1002, "reserved bits")
            if masked:
                return self.close(1002, "a server frame must not be masked")
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
                n, at = big, 10
            control = op >= 0x8
            if control and (n > 125 or not fin):
                return self.close(1002, "bad control frame")
            if not control and self.parts_len + n > RELAY_LIMITS["inbound"]:
                return self.close(1009, "message too big")
            if len(self.buf) < at + n:
                return
            payload = bytes(self.buf[at:at + n])
            del self.buf[:at + n]
            if op == 0x8:
                code = int.from_bytes(payload[:2], "big") if len(payload) >= 2 else 1005
                reason = payload[2:].decode("utf-8", "replace")
                if not self.closed:
                    # (answer the close, then end: the relay's code is what on_end reports)
                    echo = payload[:2] if len(payload) >= 2 else b""
                    self.write(client_frame(0x8, echo), "control")
                    self.closed = True
                    self._end(code, reason)
                    try:
                        self.w.close()
                    except Exception:
                        pass
                return
            if op == 0x9:
                self.write(client_frame(0xA, payload), "control")
                continue
            if op == 0xA:
                continue
            if op == 0x2:
                return self.close(1003, "text frames only")
            if op == 0x1:
                if self.in_msg:
                    return self.close(1002, "a new message inside a fragmented one")
                self.in_msg, self.fragments = True, 0
            elif op == 0x0:
                if not self.in_msg:
                    return self.close(1002, "a continuation with nothing to continue")
            else:
                return self.close(1002, "reserved opcode")
            self.fragments += 1
            if self.fragments > RELAY_LIMITS["fragments"]:
                return self.close(1009, "too many fragments")
            if payload:
                self.parts.append(payload)
                self.parts_len += len(payload)
            if not fin:
                continue
            whole = b"".join(self.parts)
            self.parts, self.parts_len, self.in_msg, self.fragments = [], 0, False, 0
            try:
                text = whole.decode("utf-8")
            except UnicodeDecodeError:
                return self.close(1007, "not UTF-8")
            self.on_text(text)


async def open_leg(origin, key, on_text, on_end, post=_post, connect_ms=None):
    """A fresh challenge, signed; the connection (proxy, TLS); the upgrade.  A Leg, running, or Retry / Fatal."""
    connect_ms = connect_ms or RELAY_LIMITS["connectMs"]
    try:
        status, d = await asyncio.to_thread(post, origin, "/api/remote/v1/challenge", {"remote_id": key.remote_id})
    except EnrollError as e:
        raise Retry(str(e))
    if status == 404:
        raise Fatal("the relay doesn't know this computer (revoked, or remote compute isn't enabled there): enroll "
                    "it again with sagebrush remote login --force", 3)
    if status == 429:
        raise Retry("too many connections from here", RELAY_LIMITS["budgetBackoffMs"])
    c = d.get("challenge")
    if status != 200 or not isinstance(c, str) or not 1 <= len(c) <= 600 or any(ord(ch) < 0x21 or ord(ch) > 0x7E for ch in c):
        raise Retry("the challenge was refused (%s)" % (d.get("error") or status))
    sig = b64url(key.sign((CHAL_TAG + c).encode("ascii")))
    u = urllib.parse.urlsplit(origin)
    tls = u.scheme == "https"
    host, port = u.hostname, u.port or (443 if tls else 80)
    deadline = time.monotonic() + connect_ms / 1000

    def left():
        return max(0.001, deadline - time.monotonic())
    try:
        sock = await asyncio.to_thread(_dial, host, port, left(), _proxy_for(host, u.scheme))
        sock.setblocking(False)
        ctx = ssl.create_default_context() if tls else None
        reader, writer = await asyncio.wait_for(
            asyncio.open_connection(sock=sock, ssl=ctx, server_hostname=host if tls else None,
                                    limit=RELAY_LIMITS["head"] * 2), left())
    except (OSError, ssl.SSLError, asyncio.TimeoutError) as e:
        raise Retry("can't reach the relay (%s)" % (e.__class__.__name__ if not str(e) else e))
    try:
        wskey = base64.b64encode(os.urandom(16)).decode("ascii")
        hostport = host if u.port is None else "%s:%d" % (host, u.port)
        writer.write(("GET %s HTTP/1.1\r\nHost: %s\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                      "Sec-WebSocket-Key: %s\r\nSec-WebSocket-Version: 13\r\nUser-Agent: sagebrush-remote/1\r\n"
                      "x-sb-remote-challenge: %s\r\nx-sb-remote-signature: %s\r\n\r\n"
                      % (RELAY_PATH, hostport, wskey, c, sig)).encode("ascii"))
        head = b""
        while b"\r\n\r\n" not in head:
            chunk = await asyncio.wait_for(reader.read(4096), left())
            if not chunk:
                raise Retry("the relay closed the connection during the upgrade")
            head += chunk
            if len(head) > RELAY_LIMITS["head"] and b"\r\n\r\n" not in head[:RELAY_LIMITS["head"] + 4]:
                raise Retry("the relay's answer head is too long")
        head, rest = head.split(b"\r\n\r\n", 1)
        lines = head.decode("latin-1").split("\r\n")
        parts = lines[0].split(" ", 2)
        status = int(parts[1]) if len(parts) >= 2 and parts[1].isdigit() else 0
        if status != 101:
            if status in (401, 403, 404):
                raise Retry("the relay refused this computer's key (%d)" % status)
            if status == 429:
                raise Retry("the relay is limiting this account (429)", RELAY_LIMITS["budgetBackoffMs"])
            raise Retry("the relay answered %d" % status)
        h = {}
        for line in lines[1:]:
            k, _, v = line.partition(":")
            k = k.strip().lower()
            if k in h:
                raise Retry("the relay repeated the header %s" % k)
            h[k] = v.strip()
        accept = base64.b64encode(hashlib.sha1((wskey + GUID).encode("ascii")).digest()).decode("ascii")
        if (h.get("upgrade", "").lower() != "websocket" or "upgrade" not in h.get("connection", "").lower()
                or h.get("sec-websocket-accept") != accept or "sec-websocket-extensions" in h or "sec-websocket-protocol" in h):
            raise Retry("the relay's upgrade answer isn't a plain WebSocket")
    except BaseException:
        writer.transport.abort()
        raise
    leg = Leg(reader, writer, on_text, on_end)
    leg.task = asyncio.ensure_future(leg.run(rest))
    return leg


class RelayPage:
    """A page, from page-open to page-close (or its replacement): what the gateway sees as a socket."""

    def __init__(self, runner, leg, conn, gen):
        self.runner, self.leg, self.conn, self.gen = runner, leg, conn, gen
        self.closed = False
        self.paired = False
        self.token = None
        self.jkt = None
        self.hello_timer = None

    def fits(self, n, kind):
        return not self.closed and self.leg.fits(n, kind)

    def send_text(self, text, kind):
        if self.closed:
            return False
        return self.leg.send_text(text, kind)

    def send(self, obj):
        return self.send_text(json.dumps(obj, separators=(",", ":")), "data")

    def close(self, code, reason=""):
        """The runner can't close one page on the relay (its controls are ping and ack): it ends the page here, then
        the whole leg, and dials again."""
        if self.closed:
            return
        self.runner.page_gone(self)
        self.runner.restart_leg(code, reason)


class RelayRunner:
    """The gateway's host on the relay: its pages, its leg, and dialing again."""

    def __init__(self, key, timers=None, cwd=None, err=None, post=_post, rnd=random.random, sleep=asyncio.sleep, port=None):
        self.key = key
        self.origin = check_origin(key.origin)
        self.timers = timers or RealTimers()
        self.err = err or (lambda s: (sys.stderr.write(s), sys.stderr.flush()))
        self.post, self.rnd, self.sleep = post, rnd, sleep
        self.incarnation = os.urandom(8).hex()
        self.paired_conn = None
        self.page = None
        self.leg = None
        self.leg_ended = None
        self.end_code = None
        self.fatal = None
        self.pings_unanswered = 0
        self.stopping = False
        self.stats = {"legs": 0, "acks": 0, "pings": 0, "violations": 0, "thumbprints": 0}
        self.delays = []  # (each wait before dialing again, ms: the backoff as it went)
        self.gateway = Gateway(self, port=port, cwd=cwd)

    # ---- the leg's messages
    def on_text(self, text):
        if text.startswith(CONTROL_PREFIX):
            try:
                c = parse_control(text)
            except ControlError as e:
                return self.violation("a malformed relay control (%s)" % e)
            return self.control(c)
        page = self.page
        if page is None:
            return self.violation("a page's message with no page open")
        if page.closed:
            return
        if not page.paired and len(text.encode("utf-8", "surrogatepass")) > PAIR_LIMITS["preHello"]:
            return page.close(1009, "message too big")
        try:
            msg = strict_json(text)
        except (ValueError, RecursionError):
            return page.close(1007, "malformed JSON")
        if isinstance(msg, dict) and "relay" in msg:
            # (an alternate serialization of a control, or a forged one: never acted on (R17-CONTROL))
            return self.violation("a page's message with a relay key")
        self.page_message(page, msg)

    def control(self, c):
        op = c["relay"]
        if op == "pong":
            self.pings_unanswered = 0
        elif op == "receipt":
            # (every byte before this receipt has been read: ordered socket, handled in order (design §5))
            self.stats["acks"] += 1
            self.leg.send_text(ack_text(c["r"]), "control")
        elif op == "page-open":
            if c["kind"] != "runner":
                return self.violation("a page for another kind of peer")
            if self.page is not None and not self.page.closed and c["gen"] <= self.page.gen:
                return self.violation("a page's generation went back")
            if self.page is not None and not self.page.closed:
                self.page_gone(self.page)
            self.open_page(c["conn"], c["gen"])
        elif op == "page-close":
            p = self.page
            if p is None or p.closed or p.conn != c["conn"] or p.gen != c["gen"]:
                return self.violation("a page-close for no open page")
            self.page_gone(p)
            self.page = None  # (the relay forwards nothing more for it: a message now is a violation)
        elif op == "revoked":
            self.fatal = Fatal("this computer's enrollment was revoked: it no longer runs code for the account", 3)
            self.leg.close(1000, "revoked")
        elif op == "dropped":
            pass  # (a runner only answers: nothing of its was sent without a page; nothing to do)

    def violation(self, why):
        self.stats["violations"] += 1
        self.err("The relay sent something this runner refuses (%s); reconnecting.\n" % why)
        if self.leg is not None:
            self.leg.close(1008, why[:100])

    # ---- pages
    def open_page(self, conn, gen):
        p = RelayPage(self, self.leg, conn, gen)
        self.page = p

        def no_hello():
            if self.page is p and not p.paired and not p.closed:
                p.close(1008, "no hello in time")
        p.hello_timer = self.timers.set_timeout(no_hello, PAIR_LIMITS["helloMs"])

    def page_gone(self, p):
        if p.closed:
            return
        p.closed = True
        self.timers.clear_timeout(p.hello_timer)
        if p.paired:
            if self.paired_conn is p:
                self.paired_conn = None
            p.token = None
            self.gateway.socket_lost(p)

    def restart_leg(self, code, reason):
        if self.leg is not None and not self.leg.closed:
            self.leg.close(1000, ("the runner closed the page: %d %s" % (code, reason))[:120])

    def _refuse(self, p, rid, kind, message):
        p.send({"jsonrpc": "2.0", "id": rid if isinstance(rid, str) else None,
                "error": {"code": -32000, "message": message, "data": {"code": kind, "message": message}}})
        p.close(1008 if kind == "refused" else 1002, message)

    def page_message(self, p, msg):
        if not p.paired:
            return self.hello(p, msg)
        plain = isinstance(msg, dict)
        if plain and msg.get("unpair") is True and len(msg) == 1:
            self.gateway.shutdown()
            return p.close(1000, "unpaired")
        if plain and len(msg) == 1 and "cancel" in msg:
            return self.gateway.cancel(p, msg["cancel"])
        if plain and "id" in msg:
            return self.gateway.frame(p, msg)
        return p.close(1002, "not a message of this protocol")

    def hello(self, p, msg):
        ok = (isinstance(msg, dict) and msg.get("jsonrpc") == "2.0" and isinstance(msg.get("id"), str)
              and msg.get("method") == "hello" and isinstance(msg.get("params"), dict))
        rid = msg.get("id") if isinstance(msg, dict) else None
        if not ok:
            return self._refuse(p, rid, "protocol", "the first message must be the hello")
        q = msg["params"]
        if q.get("protocol") != 1 or isinstance(q.get("protocol"), bool):
            return self._refuse(p, rid, "protocol", "protocol 1 only")
        # (the transport picks the trust mode, never the message: on the relay, the page's session was checked by
        # the relay, so a code or session hello is refused here, as a codeless one is on loopback (§13.2))
        if "code" in q or "session" in q:
            return self._refuse(p, rid, "refused", "a code or session hello on the relay")
        if "via" in q and q["via"] != "relay":
            return self._refuse(p, rid, "refused", "this is the relay")
        if q.get("purpose") != "kernel":
            return self._refuse(p, rid, "refused", "this is a kernel's pairing (purpose \"kernel\")")
        bad = page_key_error(q, self.stats)
        if bad:
            return self._refuse(p, rid, "refused", bad)
        self.timers.clear_timeout(p.hello_timer)
        p.paired = True
        p.jkt = q["jkt"]
        p.token = b64url(os.urandom(32))  # (this page's and this key's; never written anywhere)
        self.paired_conn = p
        self.gateway.socket_paired(p)
        self.err("A page is paired.\n")
        p.send({"jsonrpc": "2.0", "id": rid, "result": {
            "protocol": 1, "purpose": "kernel", "via": "relay", "token": p.token, "nonce": self.gateway.current_nonce(),
            "limits": {"frame": PAIR_LIMITS["frame"]}, "incarnation": self.incarnation}})

    # ---- the leg's life
    def on_end(self, code, reason):
        if self.page is not None:
            self.page_gone(self.page)
        self.end_code = code
        if code == 4403 and self.fatal is None:
            self.fatal = Fatal("this computer's enrollment was revoked: it no longer runs code for the account", 3)
        elif code == 4009 and self.fatal is None:
            self.fatal = Fatal("another `sagebrush remote` with this computer's key took over", 4)
        if self.leg_ended is not None and not self.leg_ended.done():
            self.leg_ended.set_result(code)

    async def pinger(self, leg):
        while not leg.closed:
            await self.sleep(RELAY_LIMITS["pingMs"] / 1000)
            if leg.closed:
                return
            if self.pings_unanswered >= RELAY_LIMITS["missedPongs"]:
                self.err("The relay stopped answering; reconnecting.\n")
                return leg.abort("no pong")
            self.pings_unanswered += 1
            self.stats["pings"] += 1
            leg.send_text(ping_text(), "control")

    async def run(self, stop):
        """Dial, serve, dial again, until stop is set or a Fatal; returns the exit status."""
        attempt = 0
        first = True
        while not stop.is_set():
            delay = 0
            up_at = None
            try:
                self.leg_ended = asyncio.get_running_loop().create_future()
                self.pings_unanswered = 0
                self.leg = await open_leg(self.origin, self.key, self.on_text, self.on_end, post=self.post)
                self.stats["legs"] += 1
                up_at = time.monotonic()
                self.err("Connected to %s as %s. Pick it in a notebook's \"Run on\" menu.\n" % (self.origin, self.key.name)
                         if first else "Reconnected.\n")
                first = False
                ping = asyncio.ensure_future(self.pinger(self.leg))
                stopping = asyncio.ensure_future(stop.wait())
                await asyncio.wait([self.leg_ended, stopping], return_when=asyncio.FIRST_COMPLETED)
                ping.cancel()
                stopping.cancel()
                if stop.is_set():
                    break
                if self.end_code == 4429:
                    delay = RELAY_LIMITS["budgetBackoffMs"]
                    self.err("The account's daily relay budget is used up; trying again later.\n")
            except Retry as e:
                delay = e.delay_ms
                self.err("Can't connect: %s.\n" % e)
            except Fatal as e:
                self.fatal = e
            if self.fatal is not None:
                break
            if up_at is not None and time.monotonic() - up_at >= RELAY_LIMITS["stableMs"] / 1000:
                attempt = 0
            delay = max(delay, backoff_ms(attempt, self.rnd))
            attempt += 1
            self.delays.append(delay)
            waiting = asyncio.ensure_future(stop.wait())
            try:
                await asyncio.wait_for(asyncio.shield(waiting), delay / 1000)
            except asyncio.TimeoutError:
                pass
            waiting.cancel()
        if self.leg is not None and not self.leg.closed:
            self.leg.close(1001, "the runner stopped")
        if self.fatal is not None:
            self.err("Stopped: %s.\n" % self.fatal)
            return self.fatal.code
        return 0


async def run_relay(key, err=None, cwd=None):
    """`sagebrush remote`: until Ctrl-C or SIGTERM (close 1001, the kernels' groups stopped: R8), or a Fatal."""
    runner = RelayRunner(key, err=err, cwd=cwd)
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    import signal
    for s in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(s, stop.set)
        except (NotImplementedError, RuntimeError):
            pass
    try:
        code = await runner.run(stop)
    finally:
        runner.gateway.shutdown()
        from sagebrush.remote.gateway import drain_groups
        left = await drain_groups(3.0)
        if left:
            runner.err("Process groups %s were killed at the deadline.\n" % ", ".join(map(str, left)))
    return code


def main(argv):
    """`sagebrush remote`: enroll first if this computer isn't, then serve its account's pages through the relay."""
    if argv:
        sys.stderr.write("sagebrush remote: unknown argument %s\n" % argv[0])
        return 2
    try:
        key = _keys.load()
    except _keys.KeyFileError as e:
        sys.stderr.write("sagebrush remote: %s\n" % e)
        return 1
    if key is None:
        from sagebrush.remote.enroll import main as login_main
        code = login_main([])
        if code:
            return code
        key = _keys.load()
    try:
        check_origin(key.origin)
    except EnrollError as e:
        sys.stderr.write("sagebrush remote: the key file's origin: %s\n" % e)
        return 1
    return asyncio.run(run_relay(key))
