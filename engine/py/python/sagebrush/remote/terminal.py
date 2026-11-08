"""Terminals on a runner (terminal addendum T1.4, build steps T-1 and T-1b): the sessions, their PTYs and lifecycle,
the attachment contract (T5), and each attachment's output and input paths (T3: credit, coalescing, replay, chunked
input; terminal_output.py).  The runner's hello lists the `terminal` channel (relay.py serves terminal pages by
default since T-3, the page's terminal: web/notebook/remote-terminal.js).

A terminal page (channel `terminal`, its own generation on the peer leg) pairs with a hello like a kernel page's,
purpose "terminal": its DPoP key, no code.  Then, on that page:

  page -> runner   {"t":"open","body":B,"auth":"DPoP <token>","dpop":P}   B: {"rows":r,"cols":c} (a new session) or
                                                                         {"session":id,"rows":r,"cols":c} (reattach)
                   {"t":"resize","rows":r,"cols":c}    {"t":"kill","session":id}
                   {"t":"in","b":"<base64>"}    {"t":"ack","upto":n}
  runner -> page   {"t":"opened","session":id,"nonce":n}   {"t":"replay"}  {"t":"out","b":"<base64>"}...  {"t":"live"}
                   {"t":"out","b":"<base64>"}   {"t":"inack","upto":n}
                   {"t":"exit","code":n|null,"signal":s|null}   {"t":"error","error":e}
                   ("sessions" also carries "limit": n, the running sessions allowed)

The proof (T5): P is a DPoP proof (RFC 9449, dpop.check, as a kernel request's) by the page's key over method POST
and the URL SYNTHETIC_BASE + "/terminal/open?remote=<remote_id>&gen=<page generation>&body=<b64url sha256 of B's
exact bytes>", with this page's token and the runner's current nonce.  So it binds this remote, the terminal
channel (the path, and a token only a terminal hello is given), the exact body (the session and the size), a fresh
nonce and this page's generation; a jti once only.  It is checked before any effect: no PTY opened, no session
attached, nothing replayed until it passes.  A refused proof closes the page.

A verified open makes one attachment grant: (the leg's incarnation, the page's generation, its key's thumbprint, the
session).  It is the only authority for the page's terminal: resize and kill are taken only from the page holding
the live grant, for its own session.  A takeover (another page opening the session), the page's close or
page-close, a revoke and the leg's loss end it before any later effect; a late message from an ended grant does
nothing.  Every reattach and every new leg needs a fresh proof.

Sessions (T4): at most 4 running; a PTY with the user's $SHELL (else /bin/sh) as a login shell, in a new session,
TERM=xterm-256color, the runner's cwd and environment; output read into a 1 MiB ring at most 1 MiB/s, and while a page
is attached only within its credit (terminal_output.py); ended sessions' rings kept 10 minutes, the last 8, by an expiry timer of
their own (and checked again at a reattach), their ring and any grant released when they go; a detached session with
no output and no attach for 24 h stopped.  Stopping (kill, exit's leftovers, the runner ending) is the tree rule over
every process group in the PTY's session: SIGHUP, SIGTERM, then SIGKILL 2 s later, with the session counted again
every 50 ms until it is empty, so a group made after one census (a job trapping HUP or TERM) is caught by the next.
Only then is the PTY drained (bounded: one ring's worth) and closed; meanwhile it is read at the rate ceiling only,
and at 30 s it is closed whatever still writes.  At the runner's exit drain_sessions waits for every such session.
"""

import base64
import fcntl
import hashlib
import json
import os
import pty
import secrets
import signal
import struct
import subprocess
import sys
import termios
import urllib.parse

from sagebrush.remote import dpop
from sagebrush.remote.gateway import SYNTHETIC_BASE, _kill_tree
from sagebrush.remote.terminal_output import Attachment, IN_MAX, OUT_MAX, canonical_b64

TERMINAL_LIMITS = {
    "sessions": 4,              # running sessions on this runner
    "ring": 1024 * 1024,        # scrollback bytes per session
    "replayCut": 4096,          # the replay starts after the first \n in the ring's oldest this many bytes
    "ended": 8,                 # ended sessions whose rings are kept
    "endedMs": 10 * 60_000,     # ... for this long
    "idleMs": 24 * 3600_000,    # a detached session with no output and no attach this long is stopped
    "rate": 1024 * 1024,        # output bytes read per second, at most
    "read": OUT_MAX,            # one PTY read, at most (T12-CAP-1: the decoded bytes one output frame holds)
    "size": (1, 1000),          # rows and cols
    "killMs": 2000,             # the tree rule's SIGTERM -> SIGKILL (gateway._kill_tree)
    "sweepMs": 50,              # a stopping session's census, again, until its PTY session is empty
    "sweepCapMs": 30_000,       # ... the PTY closed by then regardless; the census goes on every second
    "body": 256,                # an open's body, bytes
    "message": 8 * 1024,        # any message to the runner but `in`, bytes
    "in": IN_MAX,               # one input frame's decoded bytes
}
OPEN_PATH = "/terminal/open"
_SID_CHARS = frozenset("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_")
# (the PTY's slave becomes the shell's controlling terminal: start_new_session gives the child its own session,
# then this sets the terminal and execs the shell, so no preexec_fn runs in a threaded runner)
_CTTY = "import fcntl,os,sys,termios;fcntl.ioctl(0,termios.TIOCSCTTY,0);os.execvp(sys.argv[1],sys.argv[1:])"


def new_session_id():
    return dpop.b64url(secrets.token_bytes(16))  # (128 random bits, 22 characters)


def open_htu(remote_id, gen, body):
    """The URL an open's proof is made over: this remote, this page's generation, the body's exact bytes."""
    digest = dpop.b64url(hashlib.sha256(body.encode("utf-8", "surrogatepass")).digest())
    return SYNTHETIC_BASE + OPEN_PATH + "?" + urllib.parse.urlencode({"remote": remote_id, "gen": gen, "body": digest})


def _size_ok(v):
    lo, hi = TERMINAL_LIMITS["size"]
    return type(v) is int and lo <= v <= hi


def _session_groups(sid):
    """The process groups with a member in session sid (Linux: /proc; elsewhere: ps), zombies not counted."""
    groups = set()
    if os.path.isdir("/proc/self"):
        for d in os.listdir("/proc"):
            if not d.isdigit():
                continue
            try:
                with open("/proc/%s/stat" % d, "rb") as f:
                    st = f.read()
            except OSError:
                continue
            fields = st[st.rfind(b")") + 2:].split()
            # (state, ppid, pgrp, session, ...)
            if len(fields) > 3 and fields[0] != b"Z" and int(fields[3]) == sid:
                groups.add(int(fields[2]))
        return groups
    try:
        r = subprocess.run(["ps", "-A", "-o", "pgid=,sess=,stat="], capture_output=True, text=True, timeout=5)
    except (OSError, subprocess.SubprocessError):
        return groups
    for line in r.stdout.splitlines():
        parts = line.split()
        if len(parts) >= 3 and parts[1].isdigit() and int(parts[1]) == sid and not parts[2].startswith("Z"):
            groups.add(int(parts[0]))
    return groups


class Ring:
    """A session's last TERMINAL_LIMITS["ring"] output bytes, as bytes."""

    def __init__(self, cap=None):
        self.cap = cap or TERMINAL_LIMITS["ring"]
        self.buf = bytearray()
        self.total = 0  # (every byte ever appended)

    def append(self, b):
        self.total += len(b)
        self.buf += b
        if len(self.buf) > self.cap:
            del self.buf[:len(self.buf) - self.cap]

    def replay(self):
        """What a reattach replays (T4): the ring, from after the first \\n in its oldest replayCut bytes if the ring
        has wrapped and there is one, else whole; the page's leading reset covers any cut sequence."""
        b = bytes(self.buf)
        if self.total > len(b):
            i = b.find(b"\n", 0, TERMINAL_LIMITS["replayCut"])
            if i >= 0:
                return b[i + 1:]
        return b


class Grant:
    """One attachment's authority (T5): its leg, page generation, page key and session."""

    __slots__ = ("incarnation", "leg", "gen", "jkt", "session", "page", "live", "att")

    def __init__(self, incarnation, page, session):
        self.incarnation, self.gen, self.jkt, self.session = incarnation, page.gen, page.jkt, session
        self.leg = page.leg  # (the peer leg it was made on: meaningless on any other)
        self.page, self.live = page, True
        self.att = None  # (its output and input paths: terminal_output.Attachment)

    def holds(self, page, incarnation, leg):
        return (self.live and self.page is page and self.incarnation == incarnation and self.leg is leg
                and page.leg is leg and self.gen == page.gen and self.jkt == page.jkt and not page.closed)


class Session:
    """A PTY and its shell, from open to its exit (or stop), and its ring for a while after."""

    def __init__(self, host, sid, rows, cols):
        self.host, self.id = host, sid
        self.ring = Ring()
        self.grant = None
        self.proc = self.master = None
        self.leader = None          # (the shell's pid: its session id and its first group)
        self.exit = None            # ({"code", "signal"} once it has exited)
        self.ended_at = None
        self.last_activity = host.timers.now()
        self.reading = False
        self.writing = False
        self.rate_at, self.rate_bytes, self.rate_timer = 0, 0, None
        self.pidfd = None
        self.poll_timer = None
        self.stopping = False
        self.sweep_started = None   # (when the stop's census began)
        self.sweep_timer = None
        self.signalled = {}         # (process group -> when it was sent SIGHUP and the tree rule)
        self.rows, self.cols = rows, cols

    # ---- start
    def spawn(self, cwd, env):
        master, slave = pty.openpty()
        try:
            self._winsize(master, self.rows, self.cols)
            shell = env.get("SHELL") or "/bin/sh"
            if not (os.path.isabs(shell) and os.access(shell, os.X_OK)):
                shell = "/bin/sh"
            env = dict(env, TERM="xterm-256color")
            self.proc = subprocess.Popen([sys.executable, "-I", "-S", "-c", _CTTY, shell, "-l"], stdin=slave,
                                         stdout=slave, stderr=slave, cwd=cwd, env=env, start_new_session=True,
                                         close_fds=True)
        except BaseException:
            os.close(master)
            raise
        finally:
            os.close(slave)
        self.master, self.leader = master, self.proc.pid
        os.set_blocking(master, False)
        self.host.stats["spawned"] += 1
        self._read_on()
        self._watch_exit()

    @staticmethod
    def _winsize(fd, rows, cols):
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))

    def resize(self, rows, cols):
        self.rows, self.cols = rows, cols
        if self.master is not None and self.exit is None:
            self._winsize(self.master, rows, cols)  # (the kernel signals SIGWINCH to the foreground group)

    # ---- output into the ring, at most TERMINAL_LIMITS["rate"] bytes a second, and to an attached page within its
    # credit (T3): no credit, no read, so the PTY fills and the program blocks in write()
    def _att(self):
        """The attached page's output path, if it still takes output (not after its exit message)."""
        g = self.grant
        a = g.att if g is not None and g.live else None
        return a if a is not None and not a.exited else None

    def reading_changed(self):
        """Read again if nothing holds the reads back: the rate ceiling's pause, or an attached page's credit."""
        if self.master is None or self.rate_timer is not None:
            return
        a = self._att()
        if a is None or a.room() > 0:
            self._read_on()
        else:
            self._read_off()

    def writing_changed(self):
        a = self._att()
        want = a is not None and bool(a.inq) and self.master is not None
        if want and not self.writing:
            self.host.loop.add_writer(self.master, self._writable)
            self.writing = True
        elif not want and self.writing:
            self._write_off()

    def _write_off(self):
        if self.writing:
            self.host.loop.remove_writer(self.master)
            self.writing = False

    def _writable(self):
        a = self._att()
        if a is None or not a.writable():
            self._write_off()

    def write_pty(self, b):
        """Input to the PTY master, non-blocking: how many bytes it took, or None for none now.  After the shell's end
        (EIO) the bytes are dropped, as a terminal's would be."""
        try:
            return os.write(self.master, b)
        except BlockingIOError:
            return None
        except OSError:
            return len(b)

    def _read_on(self):
        if not self.reading and self.master is not None:
            self.host.loop.add_reader(self.master, self._readable)
            self.reading = True

    def _read_off(self):
        if self.reading:
            self.host.loop.remove_reader(self.master)
            self.reading = False

    def _readable(self):
        now = self.host.timers.now()
        if now - self.rate_at >= 1000:
            self.rate_at, self.rate_bytes = now, 0
        room = TERMINAL_LIMITS["rate"] - self.rate_bytes
        if room <= 0:
            return self._pause_until(self.rate_at + 1000 - now)
        a = self._att()
        if a is not None:
            room = min(room, a.room())  # (credit reserved before the read)
            if room <= 0:
                return self._read_off()  # (an ack or a flush reads again: reading_changed)
        try:
            b = os.read(self.master, min(TERMINAL_LIMITS["read"], room))
        except BlockingIOError:
            return
        except OSError:
            b = b""  # (EIO: every slave side closed, the shell's session is gone)
        if not b:
            return self._read_off()
        self.rate_bytes += len(b)
        if self.ring is not None:  # (released: an ended session pruned while its stop's sweep still runs)
            self.ring.append(b)
        self.last_activity = now
        self.host.stats["outBytes"] += len(b)
        if a is not None:
            a.feed(b)

    def _pause_until(self, ms):
        self._read_off()
        self.host.stats["ratePauses"] += 1

        def resume():
            self.rate_timer = None
            self.reading_changed()
        self.rate_timer = self.host.timers.set_timeout(resume, max(ms, 1))

    # ---- exit
    def _watch_exit(self):
        try:
            self.pidfd = os.pidfd_open(self.leader)
        except (AttributeError, OSError):
            self.pidfd = None
        if self.pidfd is not None:
            self.host.loop.add_reader(self.pidfd, self._reap)
        else:
            self._poll_exit()

    def _poll_exit(self):
        self.poll_timer = None
        if not self._reap():
            self.poll_timer = self.host.timers.set_timeout(self._poll_exit, 200)

    def _reap(self):
        if self.exit is not None:
            return True
        try:
            pid, status = os.waitpid(self.leader, os.WNOHANG)
        except ChildProcessError:
            pid, status = self.leader, None
        if pid == 0:
            return False
        self.proc.returncode = 0  # (reaped here: Popen mustn't wait for it again)
        code = os.waitstatus_to_exitcode(status) if status is not None else None
        if code is not None and code < 0:
            sig = signal.Signals(-code).name if -code in signal.valid_signals() else str(-code)
            self.exit = {"code": None, "signal": sig}
        else:
            self.exit = {"code": code, "signal": None}
        if self.pidfd is not None:
            self.host.loop.remove_reader(self.pidfd)
            os.close(self.pidfd)
            self.pidfd = None
        self.host.timers.clear_timeout(self.poll_timer)
        self.poll_timer = None
        # (what the shell left in its session, background jobs included: the tree rule, as at a kill; the PTY is
        # drained and closed once the session is empty, or at the sweep's bound, whichever is first)
        self._start_sweep()
        self.host.ended(self)
        return True

    def _drain(self):
        """The PTY's last output into the ring, once the session is empty: bounded work, never "until it stops"
        (at most one ring's worth, in at most that many reads), whatever is still writing."""
        left = TERMINAL_LIMITS["ring"]
        for _ in range(-(-left // TERMINAL_LIMITS["read"])):
            if self.master is None or left <= 0:
                return
            try:
                b = os.read(self.master, min(TERMINAL_LIMITS["read"], left))
            except OSError:
                return
            if not b:
                return
            left -= len(b)
            if self.ring is not None:
                self.ring.append(b)
            a = self._att()
            if a is not None:
                a.push_final(b)  # (within credit; the rest is in the ring only)

    def _release(self):
        self._read_off()
        self._write_off()
        self.host.timers.clear_timeout(self.rate_timer)
        self.rate_timer = None
        if self.master is not None:
            os.close(self.master)
            self.master = None
            if self.exit is not None:
                self.host.closed(self)  # (the PTY can yield nothing more: now the page's exit, after its last output)

    # ---- stop: the tree rule over every group in the PTY's session, again and again until it is empty
    def stop(self):
        self.stopping = True
        self._start_sweep()

    def _start_sweep(self):
        if self.leader is None or self.sweep_started is not None:
            return
        self.sweep_started = self.host.timers.now()
        STOPPING[self.leader] = self
        self._sweep()

    def _sweep(self):
        """One census of the PTY's session: a group not seen before gets SIGHUP and the tree rule (SIGTERM, SIGKILL
        2 s later); one seen and still there past that gets SIGKILL again.  So a job that makes a new group after
        an earlier census (trapping HUP or TERM) is caught by a later one.  Repeated every sweepMs until the session
        is empty and the shell reaped; then the bounded drain and the PTY closed.  At sweepCapMs the PTY is closed
        anyway (cleanup never waits on a producer), and the census goes on every second."""
        self.sweep_timer = None
        now = self.host.timers.now()
        groups = self.census()
        for g in groups:
            if g not in self.signalled:
                self.signalled[g] = now
                try:
                    os.killpg(g, signal.SIGHUP)
                except (ProcessLookupError, PermissionError):
                    continue
                _kill_tree(g)
                self.host.stats["groupsStopped"] += 1
            elif now - self.signalled[g] > TERMINAL_LIMITS["killMs"] + TERMINAL_LIMITS["sweepMs"]:
                try:
                    os.killpg(g, signal.SIGKILL)
                except (ProcessLookupError, PermissionError):
                    pass
        if not groups and self.exit is not None:
            self._drain()
            self._release()
            STOPPING.pop(self.leader, None)
            return
        late = now - self.sweep_started >= TERMINAL_LIMITS["sweepCapMs"]
        if late and self.master is not None:
            self.host.stats["sweepCapped"] += 1
            self._drain()
            self._release()
        self.sweep_timer = self.host.timers.set_timeout(self._sweep, 1000 if late else TERMINAL_LIMITS["sweepMs"])

    def census(self):
        groups = _session_groups(self.leader)
        if self.exit is None:
            groups.add(self.leader)
        return groups


STOPPING = {}  # (leader pid -> a Session being stopped whose census goes on: drain_sessions waits for them at exit)


async def drain_sessions(timeout=3.0):
    """At the runner's exit, before drain_groups: census every stopping session's PTY session until each is empty,
    giving any group made late its tree rule, then SIGKILL to every group still there at the deadline.  Returns the
    leaders whose sessions still had members then."""
    import asyncio
    loop = asyncio.get_running_loop()
    end = loop.time() + timeout
    while True:
        alive = []
        for leader, s in list(STOPPING.items()):
            groups = s.census()
            if not groups and s.exit is not None:
                STOPPING.pop(leader, None)
                continue
            alive.append(leader)
            for g in groups:
                if g not in s.signalled:
                    s.signalled[g] = s.host.timers.now()
                    try:
                        os.killpg(g, signal.SIGHUP)
                    except (ProcessLookupError, PermissionError):
                        continue
                    _kill_tree(g)
                elif loop.time() >= end:
                    try:
                        os.killpg(g, signal.SIGKILL)
                    except (ProcessLookupError, PermissionError):
                        pass
        if not alive or loop.time() >= end + 0.5:
            return alive
        await asyncio.sleep(0.05)


class Terminals:
    """A runner's terminal sessions and the grants of the pages attached to them."""

    def __init__(self, runner, loop, cwd=None):
        self.runner, self.loop = runner, loop
        self.timers = runner.timers
        self.cwd = cwd or os.getcwd()
        self.running = {}   # (session id -> Session)
        self.ended_ = []    # (ended Sessions, oldest first: at most TERMINAL_LIMITS["ended"], for endedMs)
        self.idle_timer = None
        self.prune_timer = None
        self.stats = {"spawned": 0, "opens": 0, "refused": 0, "takeovers": 0, "lateIgnored": 0, "outBytes": 0,
                      "ratePauses": 0, "groupsStopped": 0, "idleStopped": 0, "sweepCapped": 0, "expired": 0}

    # ---- pages
    def page_message(self, p, msg):
        if not isinstance(msg, dict) or not isinstance(msg.get("t"), str):
            return p.close(1002, "not a terminal message")
        t = msg["t"]
        if t == "open":
            return self.open(p, msg)
        g = p.grant
        if g is None or not g.holds(p, self.runner.incarnation, self.runner.leg):
            # (a message with no live grant: nothing happens (T5); a page that never opened is told so)
            self.stats["lateIgnored"] += 1
            if g is None:
                return self._error(p, "not_open")
            return None
        s = g.session
        if t == "resize":
            if set(msg) != {"t", "rows", "cols"} or not (_size_ok(msg["rows"]) and _size_ok(msg["cols"])):
                return p.close(1002, "a malformed resize")
            if s.exit is None:
                s.resize(msg["rows"], msg["cols"])
            return None
        if t == "kill":
            if set(msg) != {"t", "session"} or msg["session"] != s.id:
                return p.close(1002, "a kill for another session")
            if s.exit is None:
                s.stop()
            return None
        if t == "ack":
            if set(msg) != {"t", "upto"} or g.att is None or not g.att.ack(msg["upto"]):
                return p.close(1008, "a bad ack")  # (going back, past what was sent, or malformed: no credit change)
            return None
        if t == "in":
            b = canonical_b64(msg.get("b"), TERMINAL_LIMITS["in"]) if set(msg) == {"t", "b"} else None
            if b is None:
                return p.close(1008, "a malformed or oversized input frame")
            if s.exit is not None:
                return None  # (the shell has ended: input goes nowhere, as on a terminal)
            if not g.att.input(b):
                return p.close(1008, "input past its credit")
            return None
        return p.close(1002, "not a terminal message")

    def open(self, p, msg):
        """T5: everything checked before any effect, then the grant."""
        if p.grant is not None:
            return p.close(1008, "this page already has a terminal")
        if set(msg) != {"t", "body", "auth", "dpop"} or not all(isinstance(msg[k], str) for k in ("body", "auth", "dpop")):
            return self._refuse(p, "shape")
        body = msg["body"]
        if len(body.encode("utf-8", "surrogatepass")) > TERMINAL_LIMITS["body"]:
            return self._refuse(p, "body-size")
        try:
            b = json.loads(body)
        except ValueError:
            return self._refuse(p, "body-json")
        if not (isinstance(b, dict) and set(b) in ({"rows", "cols"}, {"session", "rows", "cols"})
                and _size_ok(b["rows"]) and _size_ok(b["cols"])):
            return self._refuse(p, "body")
        sid = b.get("session")
        if sid is not None and not (isinstance(sid, str) and len(sid) == 22 and set(sid) <= _SID_CHARS):
            return self._refuse(p, "body")
        runner = self.runner
        got = dpop.check(msg["auth"], msg["dpop"], token=p.token, jkt=p.jkt, method="POST",
                         htu=open_htu(runner.key.remote_id, p.gen, body), now_ms=self.timers.now(), jtis=p.jtis,
                         nonce=runner.gateway.current_nonce())
        if got is not None:
            return self._refuse(p, got[2])
        # ---- the proof holds: the effects
        if sid is None:
            if len(self.running) >= TERMINAL_LIMITS["sessions"]:
                return self._error(p, "sessions", limit=TERMINAL_LIMITS["sessions"])  # (the page says the number)
            s = Session(self, new_session_id(), b["rows"], b["cols"])
            try:
                s.spawn(self.cwd, dict(os.environ))
            except OSError as e:
                return self._error(p, "spawn", detail=type(e).__name__)
            self.running[s.id] = s
        else:
            self._prune_ended()  # (an ended session past its time is gone, whether or not its timer has run yet)
            s = self.running.get(sid) or next((e for e in self.ended_ if e.id == sid), None)
            if s is None:
                return self._error(p, "unknown_session")
            if s.grant is not None and s.grant.live:
                self.stats["takeovers"] += 1
                old = s.grant.page
                self._end_grant(s.grant)
                self._error(old, "elsewhere")
                old.close(4009, "the session was opened elsewhere")
            s.resize(b["rows"], b["cols"])
        g = s.grant = p.grant = Grant(runner.incarnation, p, s)
        g.att = Attachment(s, p, s.write_pty)
        s.last_activity = self.timers.now()
        self.stats["opens"] += 1
        p.send({"t": "opened", "session": s.id, "nonce": runner.gateway.current_nonce()})
        # (every attach replays: a reset, the ring, then live output; an ended session's exit comes after its replay)
        g.att.exit_after_replay = s.exit is not None and s.master is None  # (closed: else closed() sends it)
        g.att.start_replay(s.ring.replay() if s.ring is not None else b"")
        s.reading_changed()
        self._arm_idle()
        return None

    def page_gone(self, p):
        """The page closed, was closed, or its leg went: its grant ends; its session goes on, detached."""
        g = getattr(p, "grant", None)
        if g is not None:
            self._end_grant(g)

    def _end_grant(self, g):
        g.live = False
        g.page.grant = None
        if g.att is not None:
            g.att.end()  # (its buffered and replay bytes dropped: they are in the ring for the next attach)
        if g.session.grant is g:
            g.session.grant = None
            g.session.last_activity = self.timers.now()
            g.session.writing_changed()
            g.session.reading_changed()  # (detached: read into the ring at the rate ceiling only)

    def _refuse(self, p, reason):
        self.stats["refused"] += 1
        self._error(p, "refused", reason=reason)
        p.close(1008, "terminal open refused (%s)" % reason)

    def _error(self, p, error, **more):
        p.send(dict({"t": "error", "error": error}, **more))

    # ---- sessions' ends
    def ended(self, s):
        self.running.pop(s.id, None)
        s.ended_at = self.timers.now()
        self.ended_.append(s)
        self._prune_ended()
        # (the page's exit waits for the PTY's close (closed()): the shell's groups are stopped, the PTY drained to the
        # page within credit, and only then the exit, so no output can follow it)

    def closed(self, s):
        """An exited session's PTY is closed: its attached page gets what was buffered, then the exit, last."""
        g = s.grant
        if g is not None and g.live and not g.page.closed and g.att is not None and not g.att.exited:
            if g.att.replaying:
                g.att.exit_after_replay = True
            else:
                g.att.flush_now()
                g.att.send_exit()

    def _prune_ended(self):
        """Ended sessions past endedMs, or beyond the last `ended`, are gone: out of the list, their grant ended (so
        no page keeps one through it) and their ring released.  Then the next expiry is scheduled, running sessions
        or not."""
        now = self.timers.now()
        keep = [e for e in self.ended_ if now - e.ended_at < TERMINAL_LIMITS["endedMs"]][-TERMINAL_LIMITS["ended"]:]
        for e in self.ended_:
            if e not in keep:
                self.stats["expired"] += 1
                if e.grant is not None:
                    page = e.grant.page
                    self._end_grant(e.grant)
                    self._error(page, "expired")
                e.ring = None
        self.ended_ = keep
        self.timers.clear_timeout(self.prune_timer)
        self.prune_timer = None
        if keep:
            due = keep[0].ended_at + TERMINAL_LIMITS["endedMs"] - now
            self.prune_timer = self.timers.set_timeout(self._prune_ended, max(due, 1))

    def _arm_idle(self):
        if self.idle_timer is None and self.running:
            self.idle_timer = self.timers.set_timeout(self._idle_check, 60_000)

    def _idle_check(self):
        """Every minute while sessions run: a detached one with no output and no attach for idleMs is stopped."""
        self.idle_timer = None
        now = self.timers.now()
        for s in list(self.running.values()):
            if s.grant is None and not s.stopping and now - s.last_activity >= TERMINAL_LIMITS["idleMs"]:
                self.stats["idleStopped"] += 1
                s.stop()
        self._prune_ended()
        self._arm_idle()

    def stop_all(self):
        """The runner ending (Ctrl-C, SIGTERM, revoke, replacement): every session stopped by the tree rule (R8)."""
        self.timers.clear_timeout(self.idle_timer)
        self.timers.clear_timeout(self.prune_timer)
        self.idle_timer = self.prune_timer = None
        for s in list(self.running.values()):
            if s.grant is not None:
                self._end_grant(s.grant)
            s.stop()
