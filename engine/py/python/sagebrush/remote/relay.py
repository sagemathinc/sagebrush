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
  - the runner closes one page with {"relay":"close","gen":n} (r1.9): a refused hello, an unpair, an answer the page
    isn't reading (1013) end that page only, never the leg; the relay answers with that page's page-close;
  - generations only go up, across page-close too: a page-open whose gen isn't above every gen seen is refused;
  - (T1.4 §T2) page-open names the page's channel, and every application message on the leg carries its page's
    generation as a prefix, `<gen>\n`, both ways; the runner keeps its pages by generation (one kernel page at a
    time; a terminal page is answered with close {gen} until b5), and a message for no page it holds is refused;
  - the output gate counts this leg's own transport buffer only; the relay's per-page window (8 MiB, receipts from
    the page) is the authority on a page that doesn't read (r1.9: the runner never sees those receipts);
  - a lost leg leaves the bindings and their kernels running (R1); dialing again backs off 1, 2, 4 ... 60 s, +-20%;
  - revoked ({"relay":"revoked"} or close 4403), or replaced by another runner with this key (4009): every kernel
    stopped by the tree rule, and the command ends.  4429 (the account's day budget): back off the longest.

The agent channel (--serve-agents, off by default): a page on channel "agent" chats with the person's own agent, a
child process of this runner (agent_child.py), at most one per kind the runner offers (--agent NAME=COMMAND, at most
AGENT_KINDS; --agent-cmd is the kind "default").  The hello's "agent" names the kind (none: the first one given), checked
before anything changes; the answer's "agent" and "agents" say which one is attached and which are offered.  Each kind
has its own child, resume secret, grace and page: a resume secret is good for its own kind only, and a page's messages
reach only its own kind's child while that child has it attached.  This assumes the relay forwards messages as written,
as the kernel and terminal channels already do: what this adds is that every page message after the hello is bound to the paired page's
key, this runner, this page's generation and its exact bytes, and can't be replayed:
  - the hello is an envelope {"a": "", "p": proof, "m": hello-text}, self-signed by the page's key: htu
    "sb-agent-hello:<remote_id>#<sha256 of hello-text>", jti and iat as dpop.py checks them;
  - every later message is {"a": "DPoP <token>", "p": proof, "m": payload}: htu
    "sb-agent:<remote_id>/<incarnation>/<gen>#<sha256 of payload>"; the runner checks it, then forwards the payload's
    exact bytes and a newline to the child, never re-serialized ({"unpair":true} and {"interrupt":true} it handles);
  - the hello's result carries limits.frame (AGENT_FRAME), the bound on the whole serialized envelope the page sends: a
    page must measure each envelope against it and refuse in words over it (the relay would close it 1009, wordless).
    maxFrameBytes (4 MiB less 4 KiB) is a payload that fits only when JSON escapes nothing in it: quotes and
    backslashes double inside the envelope's "m" string;
  - asked to remember, the hello's result carries a resume secret (kept as its SHA-256,
    bound to the page key's thumbprint): a later page with it takes the chat over (one transition, no await), and a
    detached child (no page) is kept AGENT_GRACE_MS for that;
  - memory: the leg reads one message at most max(kernel frame, AGENT_FRAME) = 4 MiB less 2 KiB, and each message is
    checked against its own page's channel cap after the generation prefix; agent_child.py states the child's bounds.
"""

import asyncio
import base64
import hashlib
import hmac
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

from sagebrush.remote import dpop as _dpop
from sagebrush.remote import keys as _keys
from sagebrush.remote.agent_child import AGENT_ADVERTISED, AGENT_FRAME, AGENT_GRACE_MS, AgentChild, AgentLog
from sagebrush.remote.enroll import USER_AGENT, EnrollError, _post, check_origin
from sagebrush.remote.gateway import Gateway
from sagebrush.remote.pair import GUID, PAIR_LIMITS, RealTimers, _close_status_ok, b64url, page_key_error, strict_json

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
    # (a message from the relay: the largest channel this runner serves plus its `<gen>\n` prefix (at most 17 bytes);
    # each page is then held to its own channel's cap, after the prefix. Without --serve-agents the kernel's frame is
    # the largest; with it, the agent channel's 4 MiB less 2 KiB)
    "inbound": PAIR_LIMITS["frame"] + 17,
    "inboundAgents": max(PAIR_LIMITS["frame"], AGENT_FRAME) + 17,
    "fragments": 1024,
    "outData": PAIR_LIMITS["outData"],
    "outTotal": PAIR_LIMITS["outTotal"],
}
_SAFE = 2 ** 53 - 1
CHANNELS = ("kernel", "terminal", "agent")  # (terminal addendum T1.4 §T2; terminal pages by default since T-3; agent pages with --serve-agents)
AGENT_NAME = re.compile(r"[a-z][a-z0-9-]{0,15}\Z")  # (an agent kind's name: --agent NAME=COMMAND, the hello's "agent")
AGENT_KINDS = 4  # (the most kinds one runner offers, so the most agent children it has at once)
AGENT_START_WAIT_S = 10  # (at the runner's exit: how long a start under way is given, then again after its cancel)
TERMINAL_FRAME = 65_536  # (a terminal message's whole serialization, either way: T2's terminal row, T12-CAP-1)
_GEN_PREFIX = re.compile(r"([1-9][0-9]{0,15})\n")
_CONN = re.compile(r"[A-Za-z0-9_-]{1,64}")
_TOKEN = re.compile(r"[A-Za-z0-9_-]{22}")
# (relay -> peer: each op's keys after "relay", in order, and each value's check)
_IN_OPS = {
    "page-open": ("conn", "kind", "chan", "gen"),
    "page-close": ("conn", "gen"),
    "receipt": ("r", "upto"),
    "revoked": (),
    "dropped": ("gen", "bytes"),
    "pong": (),
}
_CHECK = {
    "conn": lambda v: isinstance(v, str) and bool(_CONN.fullmatch(v)),
    "kind": lambda v: v in ("runner", "agent"),
    "chan": lambda v: v in CHANNELS,
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


def split_prefix(text):
    """(gen, payload) of an application message on the peer leg: `<gen>\n` then the exact bytes (T1.4 §T2: closed,
    canonical: no zero, no leading zero, at most 2^53 - 1, the newline required), or ControlError."""
    m = _GEN_PREFIX.match(text)
    if m is None:
        raise ControlError("an application message without its generation prefix")
    gen = int(m.group(1))
    if gen > _SAFE:
        raise ControlError("a generation over 2^53 - 1")
    return gen, text[m.end():]


def ping_text():
    return '{"relay":"ping"}'


def ack_text(r):
    return '{"relay":"ack","r":"%s"}' % r


def close_text(gen):
    return '{"relay":"close","gen":%d}' % gen


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


def _left(deadline):
    """Seconds left before deadline (time.monotonic()), or Retry if none: one absolute deadline for the whole dial."""
    t = deadline - time.monotonic()
    if t <= 0:
        raise Retry("the connection to the relay timed out")
    return t


def _dial(host, port, deadline, proxy=None):
    """A connected blocking socket to host:port, directly or through an HTTP CONNECT proxy (run in a thread), by the
    absolute deadline: the connect and every read of the proxy's answer get only what is left of it (astra's #768
    first look: a per-read timeout restarted with each byte, so a slow proxy could hold the dial far past it)."""
    if not proxy:
        return socket.create_connection((host, port), timeout=_left(deadline))
    u = urllib.parse.urlsplit(proxy if "://" in proxy else "http://" + proxy)
    if u.scheme not in ("http", ""):
        raise Retry("only an http:// proxy is supported (HTTPS_PROXY=%s)" % u.scheme)
    s = socket.create_connection((u.hostname, u.port or 80), timeout=_left(deadline))
    try:
        auth = ""
        if u.username:
            cred = "%s:%s" % (urllib.parse.unquote(u.username), urllib.parse.unquote(u.password or ""))
            auth = "Proxy-Authorization: Basic %s\r\n" % base64.b64encode(cred.encode("utf-8")).decode("ascii")
        s.sendall(("CONNECT %s:%d HTTP/1.1\r\nHost: %s:%d\r\n%s\r\n" % (host, port, host, port, auth)).encode("ascii"))
        head = b""
        while b"\r\n\r\n" not in head:
            s.settimeout(_left(deadline))
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

    def __init__(self, reader, writer, on_text, on_end, inbound=None):
        self.r, self.w = reader, writer
        self.inbound = RELAY_LIMITS["inbound"] if inbound is None else inbound
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
    def start(self):
        self.task = asyncio.ensure_future(self.run(getattr(self, "first", b"")))
        return self

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
            if not control and self.parts_len + n > self.inbound:
                return self.close(1009, "message too big")
            if len(self.buf) < at + n:
                return
            payload = bytes(self.buf[at:at + n])
            del self.buf[:at + n]
            if op == 0x8:
                # (as pair.py reads a client's: RFC 6455 §5.5.1, §7.4)
                if len(payload) == 1:
                    return self.close(1002, "a close status is two bytes")
                if len(payload) >= 2 and not _close_status_ok(int.from_bytes(payload[:2], "big")):
                    return self.close(1002, "a close status a peer may not send")
                try:
                    reason = payload[2:].decode("utf-8")
                except UnicodeDecodeError:
                    return self.close(1007, "a close reason not UTF-8")
                code = int.from_bytes(payload[:2], "big") if len(payload) >= 2 else 1005
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


async def _in_thread(fn, *args, cleanup=None):
    """fn(*args) in a thread, awaited so that cancelling the await returns at once (Stop): the thread runs to its own
    end (bounded by its deadline), and what it then returns goes to cleanup (a socket: closed), never leaked."""
    fut = asyncio.ensure_future(asyncio.to_thread(fn, *args))
    try:
        return await asyncio.shield(fut)
    except asyncio.CancelledError:
        if cleanup is not None:
            fut.add_done_callback(lambda f: None if f.cancelled() or f.exception() is not None else cleanup(f.result()))
        raise


def _close_quietly(sock):
    try:
        sock.close()
    except OSError:
        pass


async def open_leg(origin, key, on_text, on_end, post=_post, connect_ms=None, inbound=None):
    """A fresh challenge, signed; the connection (proxy, TLS); the upgrade.  A Leg, running, or Retry / Fatal."""
    connect_ms = connect_ms or RELAY_LIMITS["connectMs"]
    try:
        status, d = await _in_thread(post, origin, "/api/remote/v1/challenge", {"remote_id": key.remote_id})
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
        sock = await _in_thread(_dial, host, port, deadline, _proxy_for(host, u.scheme), cleanup=_close_quietly)
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
                      "Sec-WebSocket-Key: %s\r\nSec-WebSocket-Version: 13\r\nUser-Agent: %s\r\n"
                      "x-sb-remote-challenge: %s\r\nx-sb-remote-signature: %s\r\n\r\n"
                      % (RELAY_PATH, hostport, wskey, USER_AGENT, c, sig)).encode("ascii"))
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
        tokens = [t.strip().lower() for t in h.get("connection", "").split(",")]
        if (h.get("upgrade", "").lower() != "websocket" or "upgrade" not in tokens
                or h.get("sec-websocket-accept") != accept or "sec-websocket-extensions" in h or "sec-websocket-protocol" in h):
            raise Retry("the relay's upgrade answer isn't a plain WebSocket")
    except BaseException:
        writer.transport.abort()
        raise
    leg = Leg(reader, writer, on_text, on_end, inbound=inbound)
    leg.first = rest  # (read by start(): the caller starts the leg once it holds it, so no message comes before)
    return leg


def agent_envelope(msg):
    """An agent page's message, (auth, proof, payload) or None: an object with exactly "a", "p" and "m", each a string,
    the payload one line (no line feed or carriage return: it goes to the child as one)."""
    if not (isinstance(msg, dict) and sorted(msg) == ["a", "m", "p"]):
        return None
    a, pr, m = msg["a"], msg["p"], msg["m"]
    if not (isinstance(a, str) and isinstance(pr, str) and isinstance(m, str)) or "\n" in m or "\r" in m:
        return None
    return a, pr, m


def _sha(text):
    return b64url(hashlib.sha256(text.encode("utf-8", "surrogatepass")).digest())


class RelayPage:
    """A page, from page-open to page-close (or its replacement): what the gateway sees as a socket."""

    def __init__(self, runner, leg, conn, gen, chan="kernel"):
        self.runner, self.leg, self.conn, self.gen, self.chan = runner, leg, conn, gen, chan
        self.prefix = "%d\n" % gen
        self.closed = False
        self.paired = False
        self.token = None
        self.jkt = None
        self.hello_timer = None
        self.grant = None  # (a terminal page's attachment grant, terminal.py)
        self.jtis = {}     # (a terminal page's (and an agent page's) proofs' jtis: once each)
        self.nonce = None  # (an agent page's DPoP nonce, for its life)
        self.slot = None   # (an agent page's kind, an AgentSlot, from its hello)

    # ---- an agent page, as agent_child.AgentChild sees it
    def deliver(self, text):
        """One message from the agent; False if the leg has no room for it yet (the caller holds it and retries)."""
        if self.closed:
            return True  # (gone: the child's pump looks again and finds no page)
        n = len(text.encode("utf-8", "surrogatepass"))
        if not self.leg.fits(n + len(self.prefix), "data"):
            return False
        return self.send_text(text, "data") or True

    def told(self, text, code):
        """The agent's end, said to this page in words, then the page closed."""
        if not self.closed:
            self.send({"jsonrpc": "2.0", "method": "agent.ended", "params": {"text": text}})
            self.close(code, text[:100])

    def notice(self, text):
        if not self.closed:
            self.send({"jsonrpc": "2.0", "method": "agent.notice", "params": {"text": text}})

    def fits(self, n, kind):
        return not self.closed and self.leg.fits(n + len(self.prefix), kind)

    def send_text(self, text, kind):
        if self.closed:
            return False
        data = (self.prefix + text).encode("utf-8", "surrogatepass")
        if not self.leg.fits(len(data), kind):
            # (this page's answers aren't leaving: this page ends, 1013; the leg and any next page go on)
            self.close(1013, "the page isn't reading its answers")
            return False
        return self.leg.write(client_frame(0x1, data), kind)

    def send(self, obj):
        return self.send_text(json.dumps(obj, separators=(",", ":")), "data")

    def close(self, code, reason=""):
        """This page only: ended here, and {"relay":"close","gen":n} to the relay, which closes the page's leg and
        answers with its page-close (r1.9).  (code and reason are the runner's own log; the page sees its leg end.)"""
        if self.closed:
            return
        self.runner.page_gone(self)
        self.runner.stats["pageCloses"] += 1
        self.leg.send_text(close_text(self.gen), "control")


class AgentSlot:
    """One agent kind this runner offers: its name and command, and its child (if any) with that child's resume secret's
    SHA-256 and the page key it is bound to."""

    def __init__(self, name, cmd):
        self.name, self.cmd = name, list(cmd)
        self.child = None
        self.resume = None
        self.resume_jkt = None
        self.log = None  # (its AgentLog, made at its first child)


def agent_kinds(kinds):
    """[(name, argv)], checked as the runner takes them: valid unique names, each with a command, at most AGENT_KINDS;
    or raises ValueError with the reason."""
    kinds = [(name, list(cmd)) for name, cmd in kinds]
    names = [name for name, _ in kinds]
    for name, cmd in kinds:
        if not isinstance(name, str) or not AGENT_NAME.match(name):
            raise ValueError("an agent's name is a lowercase letter, then up to 15 lowercase letters, digits or -: %r" % (name,))
        if not cmd or not all(isinstance(a, str) for a in cmd):
            raise ValueError("--agent %s needs the agent's command" % name)
    if len(set(names)) != len(names):
        raise ValueError("an agent's name is given twice: %s" % ", ".join(sorted(n for n in set(names) if names.count(n) > 1)))
    if len(kinds) > AGENT_KINDS:
        raise ValueError("at most %d agents per runner" % AGENT_KINDS)
    return kinds


class RelayRunner:
    """The gateway's host on the relay: its pages, its leg, and dialing again."""

    def __init__(self, key, timers=None, cwd=None, err=None, post=_post, rnd=random.random, sleep=asyncio.sleep, port=None,
                 terminals=True, agents=False, agent_cmd=None, agent_grace_ms=AGENT_GRACE_MS, agent_log=None,
                 now_ms=None, agent_cmds=None):
        self.key = key
        # (agent pages (agent_child.py): off unless --serve-agents, with each kind's command: agent_cmds [(name, argv)],
        # in the order given, the first the default; agent_cmd alone is the one kind "default")
        kinds = agent_kinds(agent_cmds if agent_cmds else [("default", agent_cmd)] if agent_cmd else [])
        self.slots = {name: AgentSlot(name, cmd) for name, cmd in kinds}
        self.agent_default = kinds[0][0] if kinds else None
        self.serve_agents = bool(agents and kinds)
        self.agent_grace_ms = agent_grace_ms
        self.agent_log = agent_log  # (the first kind's log, if given; every other kind's is its own file in that folder)
        self.agent_starts = set()   # (children's starts under way: the runner's exit waits for them, bounded)
        self.hello_jtis = {}        # (agent hellos' proofs' jtis, runner-wide)
        self.now_ms = now_ms or (lambda: int(time.time() * 1000))
        # (terminal pages (terminal.py): on by default (terminal addendum T6, William Nov 6: a kernel on this runner can
        # already run any shell command as the box user, so a terminal adds no capability); terminals=False refuses
        # them at once, with no PTY opened)
        self.serve_terminals = terminals
        self.terms = None
        self.cwd = cwd
        self.origin = check_origin(key.origin)
        self.timers = timers or RealTimers()
        self.err = err or (lambda s: (sys.stderr.write(s), sys.stderr.flush()))
        self.post, self.rnd, self.sleep = post, rnd, sleep
        self.incarnation = os.urandom(8).hex()
        self.paired_conn = None
        self.page = None   # (the kernel page, if one is open)
        self.pages = {}    # (every page this leg has open or owes a page-close for, by generation)
        self.leg = None
        self.leg_ended = None
        self.end_code = None
        self.fatal = None
        self.pings_unanswered = 0
        self.stopping = False
        self.stats = {"legs": 0, "acks": 0, "pings": 0, "violations": 0, "thumbprints": 0, "pageCloses": 0}
        self.last_gen = 0      # (the highest page generation seen on this leg: they only go up (R768-GEN-1))
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
        try:
            gen, text = split_prefix(text)
        except ControlError as e:
            return self.violation(str(e))
        page = self.pages.get(gen)
        if page is None:
            return self.violation("a page's message for no page this runner holds")
        if page.closed:
            return  # (a page this runner ended (close {gen}) or replaced, whose page-close is still to come)
        if not page.paired and len(text.encode("utf-8", "surrogatepass")) > PAIR_LIMITS["preHello"]:
            return page.close(1009, "message too big")
        n = len(text.encode("utf-8", "surrogatepass"))
        if page.chan == "terminal" and n > TERMINAL_FRAME:
            return page.close(1009, "message too big")
        # (the leg reads up to the largest channel's cap; each page is held to its own channel's)
        if page.chan == "kernel" and n > PAIR_LIMITS["frame"]:
            return page.close(1009, "message too big")
        if page.chan == "agent" and n > AGENT_FRAME:
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
            if c["gen"] <= self.last_gen:
                return self.violation("a page's generation went back")
            self.last_gen = c["gen"]
            self.open_page(c["conn"], c["gen"], c["chan"])
        elif op == "page-close":
            p = self.pages.get(c["gen"])
            # (a page this runner holds: open, or ended or replaced here and owed its page-close)
            if p is None or p.conn != c["conn"]:
                return self.violation("a page-close for no page this runner holds")
            self.page_gone(p)
            del self.pages[c["gen"]]  # (the relay forwards nothing more for it: a message now is a violation)
            if self.page is p:
                self.page = None
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
    def open_page(self, conn, gen, chan="kernel"):
        p = RelayPage(self, self.leg, conn, gen, chan)
        self.pages[gen] = p
        if chan == "terminal" and self.serve_terminals:
            pass  # (any number the relay admits (4 per remote); each its own generation and grant)
        elif chan == "agent":
            pass  # (its hello decides: refused, with how to start it, when this runner doesn't serve agents)
        elif chan != "kernel":
            # (a channel this runner doesn't serve: that page ended at once, nothing opened for it)
            return p.close(1008, "this runner doesn't offer %s pages" % chan)
        else:
            if self.page is not None and not self.page.closed:
                self.page_gone(self.page)  # (one kernel page at a time: the newer one replaces it)
            self.page = p

        def no_hello():
            if self.pages.get(gen) is p and not p.paired and not p.closed:
                p.close(1008, "no hello in time")
        p.hello_timer = self.timers.set_timeout(no_hello, PAIR_LIMITS["helloMs"])

    def terminals(self):
        if self.terms is None:
            from sagebrush.remote.terminal import Terminals
            self.terms = Terminals(self, asyncio.get_running_loop(), cwd=self.cwd)
        return self.terms

    # (the first kind's child and resume secret: on a runner with one kind, its only ones)
    @property
    def agent(self):
        slot = self.slots.get(self.agent_default)
        return slot.child if slot is not None else None

    @property
    def agent_resume(self):
        slot = self.slots.get(self.agent_default)
        return slot.resume if slot is not None else None

    @property
    def agent_resume_jkt(self):
        slot = self.slots.get(self.agent_default)
        return slot.resume_jkt if slot is not None else None

    def page_gone(self, p):
        if p.closed:
            return
        p.closed = True
        self.timers.clear_timeout(p.hello_timer)
        if p.chan == "terminal":
            if self.terms is not None:
                self.terms.page_gone(p)  # (its grant ends; its session goes on, detached)
            p.token = None
            return
        if p.chan == "agent":
            a = p.slot.child if p.slot is not None else None
            if a is not None and a.page is p:
                a.detach()  # (the child stays for its grace; its page may come back)
            p.token = None
            return
        if p.paired:
            if self.paired_conn is p:
                self.paired_conn = None
            p.token = None
            self.gateway.socket_lost(p)

    def _refuse(self, p, rid, kind, message):
        p.send({"jsonrpc": "2.0", "id": rid if isinstance(rid, str) else None,
                "error": {"code": -32000, "message": message, "data": {"code": kind, "message": message}}})
        p.close(1008 if kind == "refused" else 1002, message)

    def page_message(self, p, msg):
        if not p.paired:
            return self.hello(p, msg)
        if p.chan == "terminal":
            return self.terminals().page_message(p, msg)
        if p.chan == "agent":
            return self.agent_message(p, msg)
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
        envelope = None
        if p.chan == "agent":
            envelope = agent_envelope(msg)
            if envelope is None:
                return self._refuse(p, None, "protocol", "the first message must be the hello, signed")
            try:
                msg = strict_json(envelope[2])
            except (ValueError, RecursionError):
                return self._refuse(p, None, "protocol", "the first message must be the hello")
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
        # (a page's purpose is its channel's: a kernel page pairs as a kernel, a terminal page as a terminal)
        if q.get("purpose") != p.chan:
            other = "terminal" if p.chan == "kernel" else "kernel"
            why = "this page is paired for a %s, not a %s" % (p.chan, other) if q.get("purpose") == other else "this page is paired for a %s" % p.chan
            return self._refuse(p, rid, "refused", why)
        bad = page_key_error(q, self.stats)
        if bad:
            return self._refuse(p, rid, "refused", bad)
        if p.chan == "agent":
            if not self.serve_agents:
                return self._refuse(p, rid, "refused", "This computer's runner doesn't offer agent pages. "
                                    "Start it with: sagebrush remote --serve-agents --agent-cmd \"<your agent's command>\"")
            why = self.agent_proof(envelope, q["jkt"], "", None, "sb-agent-hello:%s" % self.key.remote_id, self.hello_jtis)
            if why:
                return self._refuse(p, rid, "refused", why)
            slot, why = self.agent_slot(q)
            if why:
                return self._refuse(p, rid, "refused", why)
            p.slot = slot
        self.timers.clear_timeout(p.hello_timer)
        p.paired = True
        p.jkt = q["jkt"]
        p.token = b64url(os.urandom(32))  # (this page's and this key's; never written anywhere)
        if p.chan == "agent":
            return self.agent_hello(p, rid, q)
        if p.chan == "terminal":
            # (its token is good for this page's terminal opens only: no kernel binding, nothing in the gateway)
            return p.send({"jsonrpc": "2.0", "id": rid, "result": {
                "protocol": 1, "purpose": "terminal", "via": "relay", "token": p.token,
                "nonce": self.gateway.current_nonce(), "limits": {"frame": TERMINAL_FRAME},
                # (the page's generation on this leg: its open's proof binds it (T5), and only the runner knows it)
                "gen": p.gen, "incarnation": self.incarnation, "channels": self.channels()}})
        self.paired_conn = p
        self.gateway.socket_paired(p)
        self.err("A page is paired.\n")
        p.send({"jsonrpc": "2.0", "id": rid, "result": {
            "protocol": 1, "purpose": "kernel", "via": "relay", "token": p.token, "nonce": self.gateway.current_nonce(),
            "limits": {"frame": PAIR_LIMITS["frame"]}, "incarnation": self.incarnation, "channels": self.channels()}})

    # ---- the agent channel (agent_child.py)
    def agent_proof(self, envelope, jkt, token, nonce, htu_base, jtis):
        """Why an agent page's signed message is refused, or None: dpop.py's check, with htu bound to this runner (and
        the page's generation, after the hello) and to the payload's SHA-256."""
        auth, proof, payload = envelope
        bad = _dpop.check(auth, proof, token=token, jkt=jkt, method="AGENT", htu="%s#%s" % (htu_base, _sha(payload)),
                          now_ms=self.now_ms(), jtis=jtis, nonce=nonce)
        if bad is None:
            return None
        if bad[0] == 503:
            return "Too many messages at once. Wait a moment, then try again."
        return "a message this runner can't verify (%s)" % bad[2]

    def agent_slot(self, q):
        """(the kind a hello asks for, None) or (None, why it's refused): its "agent", or the first kind when it names
        none.  Nothing changes here, for any kind."""
        if "agent" not in q:
            return self.slots[self.agent_default], None
        name, offered = q["agent"], ", ".join(self.slots)
        if not isinstance(name, str) or not AGENT_NAME.match(name):
            return None, "That isn't an agent's name. This computer's runner offers: %s." % offered
        if name not in self.slots:
            return None, "This computer's runner doesn't offer %s. It offers: %s." % (name, offered)
        return self.slots[name], None

    def agent_hello(self, p, rid, q):
        """The hello's verdict for its own kind, one transition with no await: take over, attach, start a fresh child,
        or refuse.  Another kind's child, page and resume secret are never looked at."""
        slot = p.slot
        resume, fresh, remember = q.get("resume"), q.get("fresh") is True, q.get("remember") is True
        a = slot.child if slot.child is not None and not slot.child.ended else None
        matches = (a is not None and isinstance(resume, str) and slot.resume is not None
                   and hmac.compare_digest(hashlib.sha256(resume.encode("utf-8", "surrogatepass")).digest(), slot.resume)
                   and hmac.compare_digest(p.jkt, slot.resume_jkt or ""))
        secret = None
        if matches:
            old = a.page
            if old is not None and old is not p and not old.closed:
                old.told("This chat is now open in another tab. Open it here again to bring it back.", 1000)
            a.attach(p)
        elif a is not None and a.page is not None and not a.page.closed:
            return self._refuse(p, rid, "refused", "The agent is already open in another page or tab. Close it there, then connect again here.")
        elif a is not None and not fresh:
            if isinstance(resume, str):
                return self._refuse(p, rid, "refused", "This agent session has ended. Connect again to start a new one.")
            return self._refuse(p, rid, "refused", "A chat is running on this runner. Reopen it from its tab, or start a new chat here, which ends that one.")
        else:
            if a is not None:
                a.stop("the person started a new chat")
            a = slot.child = AgentChild(slot.cmd, cwd=self.cwd, log=self.slot_log(slot), grace_ms=self.agent_grace_ms,
                                        on_exit=self._agent_exited)
            slot.resume = slot.resume_jkt = None
            if remember:
                secret = b64url(os.urandom(32))
                slot.resume = hashlib.sha256(secret.encode("ascii")).digest()
                slot.resume_jkt = p.jkt
            a.attach(p)
            t = asyncio.ensure_future(self._agent_start(slot, a))
            self.agent_starts.add(t)
            t.add_done_callback(self.agent_starts.discard)
        p.paired = True
        p.nonce = b64url(os.urandom(16))
        result = {"protocol": 1, "purpose": "agent", "via": "relay", "token": p.token, "nonce": p.nonce,
                  "maxFrameBytes": AGENT_ADVERTISED, "limits": {"frame": AGENT_FRAME}, "gen": p.gen,
                  "incarnation": self.incarnation, "remote_id": self.key.remote_id, "channels": self.channels(),
                  "resumed": bool(matches), "agent": slot.name, "agents": list(self.slots)}
        if secret is not None:
            result["resume"] = secret
        p.send({"jsonrpc": "2.0", "id": rid, "result": result})

    def slot_log(self, slot):
        """A kind's log: the first kind's is agent.log (the given one, if any); every other kind's is its own file in
        the same folder, agent-<name>.log, whatever its name ("default" included), so no two kinds share one."""
        if slot.log is None:
            base = self.agent_log
            if slot.name == self.agent_default:
                slot.log = base if base is not None else AgentLog()
            else:
                slot.log = AgentLog(base.folder if base else None, **({"max_bytes": base.max} if base else {}), name=slot.name)
        return slot.log

    async def _agent_start(self, slot, a):
        try:
            await a.start()
        except (OSError, ValueError) as e:
            a.ended = True
            if slot.child is a:
                slot.child = None
                slot.resume = slot.resume_jkt = None
            page = a.page
            if page is not None and not page.closed:
                how = "--agent-cmd" if slot.name == "default" else "--agent %s=..." % slot.name
                page.told("The agent couldn't start (%s). Check the runner's %s." % (type(e).__name__, how), 1011)

    def _agent_exited(self, a):
        for slot in self.slots.values():
            if slot.child is a:  # (a replaced child's exit changes nothing for its kind's new one)
                slot.child = None
                slot.resume = slot.resume_jkt = None

    def stop_slot(self, slot, why):
        a, slot.child = slot.child, None
        slot.resume = slot.resume_jkt = None
        if a is not None:
            a.stop(why)

    def stop_agent(self, why):
        """Every kind's child, a start under way included (its stop ends the group once it exists)."""
        for slot in self.slots.values():
            self.stop_slot(slot, why)

    def agent_message(self, p, msg):
        """A paired agent page's message: verified before anything, then handled (unpair, interrupt) or forwarded."""
        env = agent_envelope(msg)
        if env is None:
            return p.close(1002, "not a message of this protocol")
        slot = p.slot
        a = slot.child if slot is not None else None
        if a is None or a.page is not p:
            return  # (a page its kind's child no longer has attached: its message has no effect)
        why = self.agent_proof(env, p.jkt, p.token, p.nonce,
                               "sb-agent:%s/%s/%d" % (self.key.remote_id, self.incarnation, p.gen), p.jtis)
        if why:
            return p.notice(why)
        payload = env[2]
        try:
            inner = strict_json(payload)
        except (ValueError, RecursionError):
            return p.notice("a message that isn't JSON")
        if not isinstance(inner, dict) or "relay" in inner:
            return p.notice("a message this connection doesn't carry")
        if inner == {"unpair": True}:
            self.stop_slot(slot, "the person disconnected it")  # (its own kind's only)
            return p.close(1000, "unpaired")
        if inner == {"interrupt": True}:
            return a.interrupt()
        if not a.send(payload):
            text = "The agent isn't reading messages right now. Try again in a moment."
            if isinstance(inner.get("id"), (str, int)) and "method" in inner:
                return p.send({"jsonrpc": "2.0", "id": inner["id"], "error": {"code": -32002, "message": text,
                                                                              "data": {"code": "busy"}}})
            return p.notice(text)

    def inbound_limit(self):
        """The largest message this runner takes from the relay: its largest channel's cap plus the generation prefix."""
        return RELAY_LIMITS["inboundAgents" if self.serve_agents else "inbound"]

    def channels(self):
        """The page channels this runner serves (T6: the page offers Terminal when it is listed)."""
        return ["kernel"] + (["terminal"] if self.serve_terminals else []) + (["agent"] if self.serve_agents else [])

    # ---- the leg's life
    def on_end(self, code, reason):
        for p in list(self.pages.values()):
            self.page_gone(p)
        self.pages.clear()
        self.page = None
        self.end_code = code
        if code == 4403 and self.fatal is None:
            self.fatal = Fatal("this computer's enrollment was revoked: it no longer runs code for the account", 3)
        elif code == 4009 and self.fatal is None:
            self.fatal = Fatal("another `sagebrush remote` with this computer's key took over", 4)
        if code in (4403, 4009):
            self.stop_agent("this runner's enrollment was revoked or replaced")  # (before anything could re-attach)
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
                self.last_gen, self.page, self.pages = 0, None, {}  # (generations are the leg's)
                # (Stop while connecting returns at once: the challenge or the dial in its thread is let go, and a
                # socket it makes later is closed (_in_thread))
                opening = asyncio.ensure_future(open_leg(self.origin, self.key, self.on_text, self.on_end, post=self.post,
                                                         inbound=self.inbound_limit()))
                stopped = asyncio.ensure_future(stop.wait())
                await asyncio.wait([opening, stopped], return_when=asyncio.FIRST_COMPLETED)
                stopped.cancel()
                if not opening.done():
                    opening.cancel()
                    try:
                        await opening
                    except BaseException:
                        pass
                    break
                self.leg = opening.result()
                if stop.is_set():
                    break
                self.leg.start()
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


async def finish_agent_starts(runner, wait_s=None):
    """At the runner's exit, after stop_agent: a start still under way.  Its process, if it exists, was already ended
    with its group (its pid is known from the spawn on); the start is given wait_s to tidy up, then cancelled, which
    tidies up the same way (the group ended, the process reaped), before drain_groups looks.  Returns the starts that
    were cancelled."""
    wait_s = AGENT_START_WAIT_S if wait_s is None else wait_s
    if not runner.agent_starts:
        return set()
    _, pending = await asyncio.wait(list(runner.agent_starts), timeout=wait_s)
    for t in pending:
        t.cancel()
    if pending:
        runner.err("An agent start still under way at the exit was cancelled after %g s.\n" % wait_s)
        await asyncio.wait(pending, timeout=wait_s)
    return pending


async def run_relay(key, err=None, cwd=None, agents=False, agent_cmds=None):
    """`sagebrush remote`: until Ctrl-C or SIGTERM (close 1001, the kernels' groups stopped: R8), or a Fatal."""
    runner = RelayRunner(key, err=err, cwd=cwd, agents=agents, agent_cmds=agent_cmds)
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
        runner.stop_agent("the runner stopped")
        await finish_agent_starts(runner)  # (it says so when it cancels a start)
        runner.gateway.shutdown()
        if runner.terms is not None:
            runner.terms.stop_all()
            from sagebrush.remote.terminal import drain_sessions
            left = await drain_sessions(3.0)  # (every PTY session empty, a late group included, before drain_groups)
            if left:
                runner.err("Terminal sessions %s were killed at the deadline.\n" % ", ".join(map(str, left)))
        from sagebrush.remote.gateway import drain_groups
        left = await drain_groups(3.0)
        if left:
            runner.err("Process groups %s were killed at the deadline.\n" % ", ".join(map(str, left)))
    return code


USAGE = """usage: sagebrush remote [--serve-agents --agent-cmd COMMAND | --serve-agents --agent NAME=COMMAND ...]

  --serve-agents       also serve agent pages: the person's own agent, chatting beside their notebooks.  The agent
                       runs as you, in the folder this command was started in, and can change files there.
  --agent-cmd COMMAND  how to start the agent (split like a shell's words, never run through a shell), for example
                       --agent-cmd "npx -y https://agents.sagebrush.cloud/agents/sagebrush-agent-0.4.0.tgz --stdio"
                       It's required with --serve-agents unless --agent is given: the runner never chooses or
                       fetches an agent by itself.  Its name is "default".
  --agent NAME=COMMAND another agent the page can pick by NAME (a lowercase letter, then up to 15 lowercase letters,
                       digits or -), started with COMMAND as --agent-cmd's is; repeat it for each, at most 4 in all.
                       Of --agent-cmd and the --agent options, the first given is the one a page gets when it names none.

The agent gets one JSON message per line on stdin and answers on stdout. The runner's own lines start with
{"relay": ...}: first {"relay":{"start":{"frame":F,"protocol":1,"epoch":0}}}, where F is the largest message in
bytes either way, then {"relay":{"page":"detached",...}} and {"relay":{"page":"attached",...}} as pages go and
come. An agent must ignore a relay line it doesn't know, and must never send one: an agent that does is stopped.
"""


def parse_args(argv):
    """(agents, [(name, argv)]) in the order given, or raises ValueError with the reason."""
    import shlex
    agents, kinds, default = False, [], False
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--serve-agents":
            agents = True
        elif a == "--agent-cmd":
            if i + 1 >= len(argv) or not shlex.split(argv[i + 1]):
                raise ValueError("--agent-cmd needs the agent's command")
            if default:
                raise ValueError("--agent-cmd is given twice")
            default = True
            kinds.append(("default", shlex.split(argv[i + 1])))
            i += 1
        elif a == "--agent":
            if i + 1 >= len(argv) or "=" not in argv[i + 1]:
                raise ValueError("--agent needs NAME=COMMAND")
            name, cmd = argv[i + 1].split("=", 1)
            kinds.append((name, shlex.split(cmd)))
            i += 1
        else:
            raise ValueError("unknown argument %s" % a)
        i += 1
    if agents and not kinds:
        raise ValueError("--serve-agents needs --agent-cmd or --agent")
    if kinds and not agents:
        raise ValueError("--agent-cmd and --agent need --serve-agents")
    return agents, agent_kinds(kinds)


def main(argv):
    """`sagebrush remote`: enroll first if this computer isn't, then serve its account's pages through the relay."""
    if argv and argv[0] in ("-h", "--help"):
        sys.stdout.write(USAGE)
        return 0
    try:
        agents, agent_cmds = parse_args(argv)
    except ValueError as e:
        sys.stderr.write("sagebrush remote: %s\n%s" % (e, USAGE))
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
    return asyncio.run(run_relay(key, agents=agents, agent_cmds=agent_cmds))
