"""A terminal page's output and input paths on the runner (sagebrush/remote/terminal_output.py; terminal addendum
T1.4 T3, T7; build step T-1b), over the fake relay with real PTYs:

- bytes: all 256 byte values reach the page exactly (raw output mode), behind a replay that starts with a reset;
- credit: a page that never acks gets at most 256 KiB, the runner stops reading and the producer blocks; acking
  resumes it, and no byte is lost or duplicated (numbered lines);
- ack cheats (past what was sent, going back, not an integer) close the page;
- input: a 1 MiB paste of random bytes reaches the program exactly, in frames of at most 16,384 bytes with at most
  64 KiB unacknowledged; non-canonical or oversized frames, and input past its credit, close the page;
- Ctrl-C reaches the program while its output is paused;
- reattach: a takeover's replay holds the earlier output, then live;
- units: the coalescing throttle's timer and rate steps (a logical clock), the frame cap at 49,137 and 49,138 bytes,
  canonical base64.

    python engine/py/test_remote_terminal_output.py
"""
import asyncio
import base64
import hashlib
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from test_remote_terminal import Run, tpaired, recv, shell, script, until, NODE, TMP  # noqa: E402
from test_remote_pair import Signer, aio  # noqa: E402
from sagebrush.remote import terminal_output as O  # noqa: E402


class Stream:
    """A page's view of its terminal output: decoded bytes, the order of replay/live, inacks."""

    def __init__(self, p, ack=True):
        self.p, self.ack = p, ack
        self.data = bytearray()
        self.events = []
        self.inack = 0
        self.closed = False

    async def pump(self, pred, timeout=15):
        end = time.monotonic() + timeout
        while not pred(self):
            left = end - time.monotonic()
            if left <= 0:
                return False
            try:
                g, m = await recv(self.p.leg, left, stream=True)
            except asyncio.TimeoutError:
                return False
            if g == "closed":
                self.closed = True
                return pred(self)
            if g != self.p.gen:
                continue
            t = m.get("t")
            self.events.append(t)
            if t == "out":
                self.data += base64.b64decode(m["b"])
                if self.ack:
                    self.p.send({"t": "ack", "upto": len(self.data)})
            elif t == "inack":
                self.inack = m["upto"]
        return True


async def quiet(get, ms=600):
    """True if get() doesn't change for ms milliseconds."""
    a = get()
    await asyncio.sleep(ms / 1000)
    return get() == a


PY = sys.executable
BYTES = shell("bytes.sh", "stty -opost -echo\n%s -I -S -c \"import os; os.write(1, bytes(range(256)) * 64 + b'END-MARK')\"\n"
              "while :; do sleep 0.05; done\n" % PY)
COUNTER = script("counter.py", """import os, sys
n = 0
while True:
    os.write(1, b"%012d\\n" % n)
    n += 1
""")
NUMBERED = shell("numbered.sh", "stty -opost -echo\n%s -I -S %s\n" % (PY, COUNTER))
CATSHA = script("catsha.py", """import hashlib, os, sys
n = int(sys.argv[1]); h = hashlib.sha256(); got = 0
while got < n:
    b = os.read(0, min(65536, n - got))
    if not b:
        break
    h.update(b); got += len(b)
os.write(1, ("SHA:%s:%d\\n" % (h.hexdigest(), got)).encode())
""")
PASTE_N = 1024 * 1024
PASTE = shell("paste.sh", "stty raw -echo\n%s -I -S %s %d\nwhile :; do sleep 0.05; done\n" % (PY, CATSHA, PASTE_N))
FLOODPID = os.path.join(TMP, "flood.pid")
YES = script("yes.py", """import os, sys
with open(sys.argv[1], "w") as f:
    f.write(str(os.getpid()))
while True:
    os.write(1, b"y" * 4096)
""")
INTFLOOD = shell("intflood.sh", "%s -I -S %s %s\nwhile :; do sleep 0.05; done\n" % (PY, YES, FLOODPID))
SLEEPER = shell("sleeper.sh", "echo first-marker\nwhile :; do sleep 0.05; done\n")
NOREAD = shell("noread.sh", "stty raw -echo\nwhile :; do sleep 0.05; done\n")


@aio
async def test_bytes_exact_behind_a_reset():
    if NODE is None:
        print("  (no node) SKIPPED")
        return
    sg = await Signer().start()
    t = await Run().start(sh=BYTES)
    try:
        leg = await t.relay.leg()
        p = await tpaired(t, leg, sg, 1)
        m = await p.open()
        assert m["t"] == "opened", m
        st = Stream(p)
        assert await st.pump(lambda s: b"END-MARK" in s.data), (st.events[:5], bytes(st.data[:80]))
        assert st.events[0] == "replay" and "live" in st.events, st.events[:6]
        assert st.data.startswith(b"\x1bc"), bytes(st.data[:8])
        assert bytes(range(256)) * 64 + b"END-MARK" in st.data
    finally:
        await t.end()
        sg.close()


@aio
async def test_credit_pause_resume_no_loss():
    if NODE is None:
        print("  (no node) SKIPPED")
        return
    sg = await Signer().start()
    t = await Run().start(sh=NUMBERED)
    try:
        leg = await t.relay.leg()
        p = await tpaired(t, leg, sg, 1)
        sid = (await p.open())["session"]
        s = t.terms.running[sid]
        st = Stream(p, ack=False)
        # (no acks: the runner sends at most the high-water mark, then stops reading; the producer blocks)
        # (exactly the high-water mark arrives: the reset and the replay count toward it too)
        assert await st.pump(lambda x: len(x.data) >= O.CREDIT_HIGH, 10), len(st.data)
        assert s.grant.att.paused
        assert await quiet(lambda: t.terms.stats["outBytes"]), "the runner kept reading without credit"
        a = s.grant.att
        assert a.sent == len(st.data) == O.CREDIT_HIGH and a.outstanding() + a.throttle.buffered() <= O.CREDIT_HIGH, (a.sent, a.throttle.buffered())
        assert not s.reading
        # (acking resumes it)
        before = t.terms.stats["outBytes"]
        st.ack = True
        p.send({"t": "ack", "upto": len(st.data)})
        target = len(st.data) + 4 * O.CREDIT_HIGH
        assert await st.pump(lambda x: len(x.data) >= target, 20), len(st.data)
        assert t.terms.stats["outBytes"] > before
        # (no byte lost or duplicated: the numbered lines after the reset run on without a gap)
        lines = bytes(st.data[2:]).split(b"\n")[:-1]
        nums = [int(x) for x in lines if len(x) == 12 and x.isdigit()]
        assert len(nums) == len(lines) and nums == list(range(nums[0], nums[0] + len(nums))), (lines[:3], len(nums))
    finally:
        await t.end()
        sg.close()


@aio
async def test_ack_cheats_close_the_page():
    if NODE is None:
        print("  (no node) SKIPPED")
        return
    sg = await Signer().start()
    t = await Run().start(sh=SLEEPER)
    try:
        leg = await t.relay.leg()
        for gen, bad in ((1, lambda sent: sent + 1), (2, None), (3, lambda sent: True), (4, lambda sent: float(sent))):
            p = await tpaired(t, leg, sg, gen)
            await p.open()
            st = Stream(p, ack=False)
            assert await st.pump(lambda x: "live" in x.events and b"first-marker" in x.data, 10)
            sent = len(st.data)
            if bad is None:
                p.send({"t": "ack", "upto": sent})
                await asyncio.sleep(0.1)
                p.send({"t": "ack", "upto": sent - 1})  # (going back)
            else:
                p.send({"t": "ack", "upto": bad(sent)})
            assert await until(lambda: {"relay": "close", "gen": gen} in leg.controls, 5), gen
    finally:
        await t.end()
        sg.close()


@aio
async def test_paste_exact_with_input_credit():
    if NODE is None:
        print("  (no node) SKIPPED")
        return
    sg = await Signer().start()
    t = await Run().start(sh=PASTE)
    try:
        leg = await t.relay.leg()
        p = await tpaired(t, leg, sg, 1)
        await p.open()
        st = Stream(p)
        assert await st.pump(lambda x: "live" in x.events, 10)
        await asyncio.sleep(0.3)  # (the program is reading stdin by now)
        data = os.urandom(PASTE_N)
        assert set(data) == set(range(256))
        sent = 0
        while sent < len(data):
            # (at most 64 KiB unacknowledged: wait for inacks before sending more)
            ok = await st.pump(lambda x: sent - x.inack + O.IN_MAX <= O.IN_PENDING, 15)
            assert ok, (sent, st.inack)
            chunk = data[sent:sent + O.IN_MAX]
            p.send({"t": "in", "b": base64.b64encode(chunk).decode()})
            sent += len(chunk)
        want = ("SHA:%s:%d" % (hashlib.sha256(data).hexdigest(), PASTE_N)).encode()
        assert await st.pump(lambda x: want in x.data, 20), bytes(st.data[-120:])
        assert st.inack == PASTE_N
    finally:
        await t.end()
        sg.close()


@aio
async def test_bad_input_frames_close_the_page():
    if NODE is None:
        print("  (no node) SKIPPED")
        return
    sg = await Signer().start()
    t = await Run().start(sh=SLEEPER)
    try:
        leg = await t.relay.leg()
        cases = [
            {"t": "in", "b": "eA"},                                                     # (not canonical: no padding)
            {"t": "in", "b": "eB=="},                                                   # (not canonical: stray bits)
            {"t": "in", "b": base64.b64encode(b"x" * (O.IN_MAX + 1)).decode()},         # (over 16,384 bytes)
            {"t": "in", "b": "eA==", "x": 1},                                           # (another key)
        ]
        for gen, msg in enumerate(cases, 1):
            p = await tpaired(t, leg, sg, gen)
            await p.open()
            p.send(msg)
            assert await until(lambda: {"relay": "close", "gen": gen} in leg.controls, 5), msg
    finally:
        await t.end()
    # (past its credit: in raw mode with nothing reading stdin the PTY's input queue fills and the runner holds the
    # rest; more than 64 KiB unacknowledged closes the page)
    t = await Run().start(sh=NOREAD)
    try:
        leg = await t.relay.leg()
        gen = 1
        p = await tpaired(t, leg, sg, gen)
        await p.open()
        for _ in range(O.IN_PENDING // O.IN_MAX + 2):
            p.send({"t": "in", "b": base64.b64encode(b"z" * O.IN_MAX).decode()})
        assert await until(lambda: {"relay": "close", "gen": gen} in leg.controls, 5)
    finally:
        await t.end()
        sg.close()


@aio
async def test_ctrl_c_while_output_paused():
    if NODE is None:
        print("  (no node) SKIPPED")
        return
    sg = await Signer().start()
    t = await Run().start(sh=INTFLOOD)
    try:
        if os.path.exists(FLOODPID):
            os.unlink(FLOODPID)
        leg = await t.relay.leg()
        p = await tpaired(t, leg, sg, 1)
        sid = (await p.open())["session"]
        s = t.terms.running[sid]
        st = Stream(p, ack=False)
        assert await st.pump(lambda x: len(x.data) >= O.CREDIT_HIGH, 10), len(st.data)
        assert await until(lambda: os.path.exists(FLOODPID) and open(FLOODPID).read().strip(), 5)
        pid = int(open(FLOODPID).read())
        assert await quiet(lambda: t.terms.stats["outBytes"]) and not s.reading  # (paused at the high-water mark)
        p.send({"t": "in", "b": base64.b64encode(b"\x03").decode()})

        def gone():
            try:
                os.kill(pid, 0)
            except ProcessLookupError:
                return True
            with open("/proc/%d/stat" % pid, "rb") as f:
                return f.read().split(b")")[-1].split()[0] == b"Z"
        assert await until(gone, 3), "Ctrl-C didn't reach the program while its output was paused"
    finally:
        await t.end()
        sg.close()


@aio
async def test_takeover_replays_then_live():
    if NODE is None:
        print("  (no node) SKIPPED")
        return
    sg = await Signer().start()
    t = await Run().start(sh=SLEEPER)
    try:
        leg = await t.relay.leg()
        p1 = await tpaired(t, leg, sg, 1)
        sid = (await p1.open())["session"]
        st1 = Stream(p1)
        assert await st1.pump(lambda x: b"first-marker" in x.data, 10)
        p2 = await tpaired(t, leg, sg, 2)
        p2.send(await p2.open_msg(session=sid))
        # (the older page hears "elsewhere" first; then the new page's opened)
        g, m = await recv(leg)
        assert (g, m) == (1, {"t": "error", "error": "elsewhere"}), (g, m)
        g, m = await recv(leg)
        assert g == 2 and m["t"] == "opened", (g, m)
        st2 = Stream(p2)
        assert await st2.pump(lambda x: "live" in x.events, 10)
        i = st2.events.index("live")
        assert st2.events[0] == "replay" and all(e == "out" for e in st2.events[1:i]), st2.events
        assert st2.data.startswith(b"\x1bc") and b"first-marker" in st2.data
        assert await until(lambda: {"relay": "close", "gen": 1} in leg.controls, 5)
    finally:
        await t.end()
        sg.close()


class FakeTimers:
    def __init__(self):
        self.t, self.q, self.n = 0, {}, 0

    def now(self):
        return self.t

    def set_timeout(self, f, ms):
        self.n += 1
        self.q[self.n] = (self.t + ms, f)
        return self.n

    def clear_timeout(self, h):
        self.q.pop(h, None)

    def advance(self, ms):
        end = self.t + ms
        while True:
            due = [(at, h) for h, (at, f) in self.q.items() if at <= end]
            if not due:
                break
            at, h = min(due)
            self.t = at
            f = self.q.pop(h)[1]
            f()
        self.t = end


def test_throttle_timer_and_rate_steps():
    tm, out = FakeTimers(), []
    th = O.OutputThrottle(tm, out.append)
    tm.t = 1000
    th.write(b"a")
    assert out == [b"a"]  # (the first write after a quiet interval goes at once)
    tm.advance(10)
    th.write(b"b")
    th.write(b"c")
    assert out == [b"a"] and th.buffered() == 2
    tm.advance(31)  # (1000/24 = 41.7 ms after the last flush)
    assert out == [b"a"]
    tm.advance(2)
    assert out == [b"a", b"bc"]
    # (a medium frame steps the rate down to 8/s, a slow one to 4/s, a cool one back to 24/s)
    tm.advance(1000)
    th.write(b"x" * O.ADAPTIVE_MEDIUM_BYTES)
    assert th.rate == O.ADAPTIVE_MEDIUM_MSGS_PER_SECOND
    tm.advance(1000)
    th.write(b"x" * O.ADAPTIVE_SLOW_BYTES)
    assert th.rate == O.ADAPTIVE_SLOW_MSGS_PER_SECOND
    tm.advance(1000)
    th.write(b"x" * (O.ADAPTIVE_MEDIUM_BYTES - 1))
    assert th.rate == O.ADAPTIVE_SLOW_MSGS_PER_SECOND  # (between cool and medium: unchanged)
    tm.advance(1000)
    th.write(b"x" * O.ADAPTIVE_COOL_BYTES)
    assert th.rate == O.MAX_MSGS_PER_SECOND
    th.write(b"y")
    th.close()
    tm.advance(1000)
    assert out[-1] != b"y"  # (closed: its buffer dropped, its timer cleared)


def test_frame_cap_and_canonical_base64():
    assert O.OUT_MAX == 49_137
    assert len(O.out_message(b"\xff" * O.OUT_MAX)) == 65_534
    try:
        O.out_message(b"\xff" * (O.OUT_MAX + 1))
        raise AssertionError("an out frame over the cap was made")
    except ValueError:
        pass
    assert O.canonical_b64("eA==", 10) == b"x"
    for bad in ("eA", "eB==", "e A==", "eA==\n", 7, "e" * 100):
        assert O.canonical_b64(bad, 10) is None, bad
    assert O.canonical_b64(base64.b64encode(b"q" * 11).decode(), 10) is None


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print("ok", name)
    print("all remote terminal output tests passed")
