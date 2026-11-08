"""A terminal page's output and input paths on the runner (terminal addendum T1.4, T3; build step T-1b).

One Attachment per attachment grant (terminal.py's Grant): its counters start at zero at the open and end with the
grant (takeover, the page's close, a revoke, the leg's loss).

Output (PTY -> page), credit with the program blocked by the PTY itself:
- the runner reads the PTY master only while this page's unacknowledged output plus the bytes waiting to be sent is
  under CREDIT_HIGH (256 KiB); at the mark it stops reading, so the kernel's PTY buffer fills and the program blocks
  in write(); it reads again once the page's acks bring the unacknowledged output down to CREDIT_LOW (64 KiB);
- credit is reserved before a read: a read is at most min(credit left, room in the frame, the rate ceiling);
- output is coalesced (the throttle below, ported from CoCalc with its constants): the bytes of one flush window go
  at once, at most 24 windows a second, stepping down to 8 as a window's bytes pass 32 KiB and to 4 past 128 KiB, and
  back to 24 at or below 8 KiB.  As in CoCalc the step is measured on the whole window's bytes; here a window is cut
  into frames {"t":"out","b":"<canonical base64 of the exact PTY bytes>"} of at most OUT_MAX = 49,137 decoded bytes
  (T12-CAP-1: 65,534 serialized bytes), sent back to back.  A window holds at most the credit left (<= 256 KiB);
- each PTY read is at most OUT_MAX bytes and at most the credit left;
- the exit is the last output message: the PTY's output up to its close (after the shell's groups are stopped) goes
  to the page first, within credit; what doesn't fit goes to the ring only (a reattach replays it);
- the page acks {"t":"ack","upto":<decoded bytes rendered>}, cumulative; an ack that goes back or names more than was
  sent closes the page before any credit changes;
- an attach first replays: {"t":"replay"}, then a terminal reset and the session's ring (scrollback) as out frames
  under the same credit, then {"t":"live"}; the PTY isn't read while the replay is sent, so live output follows it.

Input (page -> PTY), its own credit, never behind output: {"t":"in","b":"<canonical base64>"} of at most IN_MAX
(16,384) decoded bytes, with at most IN_PENDING (64 KiB) received but not yet written; written to the PTY master
non-blocking in IN_CHUNK (1 KiB) pieces as the PTY takes them (ported from CoCalc), and acked {"t":"inack","upto":n}
when the queue empties and every INACK_EVERY bytes.  So Ctrl-C reaches the line discipline while output is paused.
"""

import base64
import binascii
import json

# ---- Ported from CoCalc packages/conat/project/terminal/index.ts (SageMath, Inc.; relicensed by the copyright owner, Nov 7 2026)
# (lines 37-83 at commit 2265acac: the tuned constants only)
MAX_MSGS_PER_SECOND = 24
ADAPTIVE_MEDIUM_MSGS_PER_SECOND = 8
ADAPTIVE_SLOW_MSGS_PER_SECOND = 4
ADAPTIVE_MEDIUM_BYTES = 32768
ADAPTIVE_SLOW_BYTES = 131072
ADAPTIVE_COOL_BYTES = 8192
# ---- end of the ported constants

TERMINAL_FRAME = 65_536                  # a terminal message's whole serialization (relay.py; T2, T12-CAP-1)
OUT_MAX = 3 * ((TERMINAL_FRAME - 18) // 4)  # 49,137 decoded bytes: {"t":"out","b":"…"} is 18 bytes around its base64
CREDIT_HIGH = 256 * 1024
CREDIT_LOW = 64 * 1024
IN_MAX = 16_384
IN_PENDING = 64 * 1024
IN_CHUNK = 1024
INACK_EVERY = 16_384
COUNTER_MAX = 2 ** 53 - 1


class OutputThrottle:
    """Output coalescing: bytes written are emitted at most messagesPerSecond times a second, the first write after a
    quiet interval at once; the rate steps down to medium and slow as emitted frames grow past mediumBytes and
    slowBytes, and back to the base rate at or below coolBytes.

    Ported from CoCalc packages/util/throttle.ts (SageMath, Inc.; relicensed by the copyright owner, Nov 7 2026)
    (lines 14-73, class ThrottleString, and 130-194, createAdaptiveTerminalOutputThrottle, at commit 2265acac): the
    same timer rule and rate steps, over bytes instead of strings, on the runner's timers."""

    def __init__(self, timers, publish, messages_per_second=MAX_MSGS_PER_SECOND,
                 medium_messages_per_second=ADAPTIVE_MEDIUM_MSGS_PER_SECOND,
                 slow_messages_per_second=ADAPTIVE_SLOW_MSGS_PER_SECOND, medium_bytes=ADAPTIVE_MEDIUM_BYTES,
                 slow_bytes=ADAPTIVE_SLOW_BYTES, cool_bytes=ADAPTIVE_COOL_BYTES):
        if not (cool_bytes <= medium_bytes <= slow_bytes):
            raise ValueError("expected cool_bytes <= medium_bytes <= slow_bytes")
        self.timers, self.publish = timers, publish
        self.base = max(1, messages_per_second)
        self.medium = max(1, min(self.base, medium_messages_per_second))
        self.slow = max(1, min(self.medium, slow_messages_per_second))
        self.medium_bytes, self.slow_bytes, self.cool_bytes = medium_bytes, slow_bytes, cool_bytes
        self.rate = self.base
        self.buf = bytearray()
        self.last = timers.now()
        self.timer = None

    def close(self):
        self.timers.clear_timeout(self.timer)
        self.timer = None
        self.buf = bytearray()

    def write(self, data):
        self.buf += data
        until = 1000 / self.rate - (self.timers.now() - self.last)
        if until > 0:
            if self.timer is None:
                self.timer = self.timers.set_timeout(self._due, max(1, int(until + 0.999)))
        else:
            self.timers.clear_timeout(self.timer)
            self.timer = None
            self.flush()

    def _due(self):
        self.timer = None
        self.write(b"")

    def flush(self):
        data = bytes(self.buf)
        self.buf = bytearray()
        self.last = self.timers.now()
        if data:
            self.publish(data)
            self._adapt(len(data))

    def _adapt(self, emitted):
        if emitted >= self.slow_bytes:
            self.rate = self.slow
        elif emitted >= self.medium_bytes:
            self.rate = self.medium
        elif emitted <= self.cool_bytes:
            self.rate = self.base

    def buffered(self):
        return len(self.buf)


def out_message(b):
    """The serialized out frame for b (at most OUT_MAX bytes): never over TERMINAL_FRAME."""
    text = json.dumps({"t": "out", "b": base64.b64encode(b).decode("ascii")}, separators=(",", ":"))
    if len(text) > TERMINAL_FRAME:
        raise ValueError("an out frame over the terminal frame cap")  # (unreachable for len(b) <= OUT_MAX)
    return text


def canonical_b64(s, limit):
    """The bytes of a canonical base64 string of at most `limit` decoded bytes, or None."""
    if not isinstance(s, str) or len(s) > 4 * (-(-limit // 3)):
        return None
    try:
        b = base64.b64decode(s.encode("ascii"), validate=True)
    except (binascii.Error, ValueError, UnicodeEncodeError):
        return None
    if len(b) > limit or base64.b64encode(b).decode("ascii") != s:
        return None
    return b


class Attachment:
    """One attachment's output credit, coalescing, replay and input queue."""

    def __init__(self, session, page, write_pty):
        self.session, self.page = session, page
        self.timers = session.host.timers
        self.write_pty = write_pty     # (session: write bytes to the master non-blocking, returning how many)
        self.sent = self.acked = 0     # (decoded output bytes sent in out frames, and acknowledged)
        self.paused = False            # (at the high-water mark: reading waits for acks down to CREDIT_LOW)
        self.replay = bytearray()
        self.replaying = False
        self.exit_after_replay = False
        self.inq = bytearray()
        self.in_recv = self.in_written = self.in_acked = 0
        self.writing = False
        self.ended = False
        self.exited = False            # (the exit was sent: it is this attachment's last output message)
        self.throttle = OutputThrottle(self.timers, self._publish)

    # ---- output
    def outstanding(self):
        return self.sent - self.acked

    def credit(self):
        """How many more bytes may go toward the page now, live or replay alike: none from the high-water mark until
        acks bring the unacknowledged output down to the low-water mark (the one hysteresis for both)."""
        if self.ended or self.exited:
            return 0
        held = self.outstanding() + self.throttle.buffered()
        if held >= CREDIT_HIGH:
            self.paused = True
        if self.paused:
            return 0
        return max(0, CREDIT_HIGH - held)

    def room(self):
        """How many bytes one PTY read into this attachment may take now (0: don't read)."""
        if self.replaying:
            return 0
        return min(OUT_MAX, self.credit())

    def feed(self, b):
        """Bytes read from the PTY (at most room() of them) toward the page."""
        if not self.ended and not self.exited and b:
            self.throttle.write(b)

    def start_replay(self, ring_bytes):
        self.page.send({"t": "replay"})
        self.replay = bytearray(b"\x1bc" + ring_bytes)
        self.replaying = True
        self._pump_replay()

    def _pump_replay(self):
        if self.ended or not self.replaying:
            return
        if self.replay:
            room = min(OUT_MAX, self.credit())
            if room == 0:
                return  # (an ack, or the throttle's flush, pumps again)
            chunk = bytes(self.replay[:room])
            del self.replay[:room]
            self.throttle.write(chunk)
            return
        if self.throttle.buffered():
            return  # (its last bytes go at the throttle's next flush, which pumps again)
        self.replaying = False
        self.replay = bytearray()
        self.page.send({"t": "live"})
        if self.exit_after_replay:
            self.send_exit()
        self.session.reading_changed()

    def _publish(self, data):
        """One flush window's bytes, cut into frames of at most OUT_MAX, back to back."""
        if self.ended or self.exited:
            return
        for i in range(0, len(data), OUT_MAX):
            self.page.send_text(out_message(data[i:i + OUT_MAX]), "data")
        self.sent += len(data)
        if self.replaying:
            self._pump_replay()
        self.session.reading_changed()

    def ack(self, upto):
        """The page's cumulative ack; False: a cheat (going back, or past what was sent), refused before any effect."""
        if type(upto) is not int or upto < self.acked or upto > self.sent or upto > COUNTER_MAX:
            return False
        self.acked = upto
        if self.paused and self.outstanding() <= CREDIT_LOW:
            self.paused = False
        if self.replaying:
            self._pump_replay()
        self.session.reading_changed()
        return True

    def push_final(self, b):
        """The PTY's last bytes (its drain, at the close): as many as the credit allows go to the page; the rest is in
        the ring only.  During a replay they queue behind it (astra's ordering finding), so the page sees the reset,
        the ring, then these, then the exit; that queue is bounded by the drain itself (one ring's worth).  Returns how
        many were taken."""
        if self.ended or self.exited:
            return 0
        if self.replaying:
            self.replay += b
            return len(b)
        n = min(len(b), self.credit())
        if n:
            self.throttle.buf += b[:n]
        return n

    def flush_now(self):
        """Before the exit message: whatever is buffered goes now (it is within credit already)."""
        self.timers.clear_timeout(self.throttle.timer)
        self.throttle.timer = None
        self.throttle.flush()

    def send_exit(self):
        """The exit, terminal for this page's output: what the PTY yields after it (a background job of the shell's
        still writing while its groups are stopped) goes to the ring only, which a reattach replays."""
        e = self.session.exit
        self.exited = True
        self.throttle.close()
        self.page.send({"t": "exit", "code": e["code"], "signal": e["signal"]})
        self.session.reading_changed()

    # ---- input
    def input(self, b):
        """Decoded input bytes; False: over IN_PENDING (the page broke its credit)."""
        if self.in_recv - self.in_written + len(b) > IN_PENDING or self.in_recv + len(b) > COUNTER_MAX:
            return False
        self.inq += b
        self.in_recv += len(b)
        self.session.writing_changed()
        return True

    def writable(self):
        """The PTY can take input: one IN_CHUNK piece (CoCalc's chunked write).

        Ported from CoCalc packages/conat/project/terminal/writable-pty.ts (SageMath, Inc.; relicensed by the copyright owner, Nov 7 2026)
        (lines 21-65, writeToWritablePty and waitForDrain, at commit 2265acac): 1 KiB pieces, the next only once the
        PTY has taken the last (here, the master's writability instead of a stream's drain event)."""
        if self.ended or not self.inq:
            return False
        n = self.write_pty(bytes(self.inq[:IN_CHUNK]))
        if n is None:
            return True  # (the PTY took nothing now: wait for writability again)
        del self.inq[:n]
        self.in_written += n
        if not self.inq or self.in_written - self.in_acked >= INACK_EVERY:
            self.in_acked = self.in_written
            self.page.send({"t": "inack", "upto": self.in_written})
        return bool(self.inq)

    def end(self):
        self.ended = True
        self.throttle.close()
        self.replay = bytearray()
        self.inq = bytearray()
