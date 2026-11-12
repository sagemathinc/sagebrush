"""`sagebrush remote --serve-agents`: the chat agent beside the runner.  One child process per runner (the person's own
agent, `--agent-cmd`, typically `sagebrush-agent --stdio`), piped to the runner's one agent page: one JSON message per
line on its stdin and stdout.  The page decides what the agent may do; this module only carries messages, bounded.

Bounds (every buffer finite):
  - child -> page: one line held at a time, read with a StreamReader whose limit is AGENT_FRAME + 1.  That limit is not
    a hard allocation cap: the reader buffers what the pipe delivers before readuntil looks, and asyncio pauses the
    pipe only once its buffer passes twice the limit, so the reader holds at most about 2 x AGENT_FRAME plus one
    pipe read (64 KiB).  A line over AGENT_FRAME (readuntil's overrun, or the length checked again after it) stops
    the child and releases the buffer; readuntil is never retried on it.  The held line waits until the leg's output gate
    has room for it (never refused for room), and while it waits nothing more is read: the child blocks on its own
    stdout (the OS pipe is the buffer).  A line over AGENT_FRAME, or not a JSON object, or one with a top-level
    "relay" key (it could pass for a relay control), stops the child: it broke the rule it was told.
  - page -> child: one FIFO of at most AGENT_QUEUE bytes, each message charged its bytes plus QUEUE_ENTRY_BYTES (so
    many small messages can't hold more than the cap in their own bookkeeping), written by one task in STDIN_HIGH
    chunks, each drained, the item in flight counted until its last chunk is drained; a message that would go over is
    refused (the caller tells the page), never queued.  Held for stdin: at most AGENT_QUEUE + 2 x STDIN_HIGH.
  - the agent channel's memory, conservatively: the stdout reader (about 2 x AGENT_FRAME + 64 KiB), one held line
    (AGENT_FRAME) and its frame on the leg (within the leg's 7 MiB output gate), and stdin (AGENT_QUEUE + 128 KiB).
  - detached (no page, during the grace): a request from the child (an object with "id" and "method") is answered at
    once with an error, through the same FIFO (dropped, and logged, if the FIFO can't take it); anything else is
    dropped as it is read.  Nothing is kept for replay.
  - stderr: read in 64 KiB chunks (a huge unterminated line included) into the agent log, at 0600 in a 0700 folder,
    rotated at LOG_MAX with one old file kept, with token-like strings redacted; never sent to the page.
Stop is SIGINT to the child's process group and the end is the tree rule (gateway._kill_tree: SIGTERM to the group,
SIGKILL 2 s later), so neither waits on a blocked pipe.

The runner's own lines to the child (the contract any --agent-cmd gets): before anything else, the start line
{"relay":{"start":{"frame":AGENT_FRAME,"protocol":1,"epoch":0}}}; then {"relay":{"page":"detached","epoch":n}} and
{"relay":{"page":"attached","epoch":n}} as pages go and come. The epoch goes up by one at every detach (a page closed,
replaced, taken over or its leg lost). A child must ignore a {"relay": ...} line it doesn't know; `protocol` goes up
on a change it couldn't ignore. Neither a page nor a child can send a line with a top-level "relay" key (a page's is
refused; a child that sends one is stopped), so these come only from the runner.
  - order: what the child gets is always the old page's work, then detached(n), then attached(n), then the new page's
    work. The two control lines wait in two fixed slots (the latest epoch of each kind), written before the next queued
    message, never behind a backlog; a line already being written finishes first.
  - at a detach, the departed page's messages not yet started on stdin are dropped (counted in stats["droppedAtDetach"]):
    they belong to a binding that is over. Only a line already being written finishes.
  - the slots: at most two control lines pending, about 40 bytes each, outside AGENT_QUEUE."""

import asyncio
import collections
import json
import os
import re
import signal
import subprocess

from sagebrush.remote.gateway import ENDING_GROUPS, _kill_tree
from sagebrush.remote.pair import strict_json

MiB = 1024 * 1024
AGENT_FRAME = 4 * MiB - 2048         # a message either way, envelope included: the relay's runner/agent cap
AGENT_ADVERTISED = AGENT_FRAME - 2048  # maxFrameBytes: fits only a payload JSON escapes nothing in; the page's bound is
#                                        its serialized envelope against limits.frame (AGENT_FRAME)
AGENT_QUEUE = AGENT_FRAME + 64 * 1024  # the page -> child FIFO's bytes, in all
QUEUE_ENTRY_BYTES = 128  # (charged per queued message on top of its bytes: its tuple, its bytes object's header, its slot)
AGENT_GRACE_MS = 5 * 60_000          # a detached child is kept this long for its page to come back
LOG_MAX = 1 * MiB
STDERR_CHUNK = 64 * 1024
STDIN_HIGH = 64 * 1024               # the stdin transport's high-water mark
EXIT_POLL_S = 0.05                   # how often the watcher looks at the child's return code
ROOM_POLL_S = 0.02                   # how often a held line looks for room on the leg

# (the runner's own variables never reach the child: its settings and any proxy credentials)
_DENY_PREFIXES = ("SAGEBRUSH_",)
_DENY = ("SSLKEYLOGFILE",)
_PROXIES = ("HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy")
_REDACT = re.compile(rb"(sk-[A-Za-z0-9_-]{16,}|[Bb]earer\s+[A-Za-z0-9._~+/=-]{16,}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)")


def child_env(env=None):
    """The child's environment: the runner's, minus its own settings and with proxy credentials stripped."""
    out = {}
    for k, v in (os.environ if env is None else env).items():
        if k in _DENY or k.startswith(_DENY_PREFIXES):
            continue
        if k in _PROXIES:
            v = re.sub(r"^([A-Za-z][A-Za-z0-9+.-]*://)[^/@]*@", r"\1", v)
        out[k] = v
    return out


def log_dir():
    base = os.environ.get("XDG_STATE_HOME") or os.path.join(os.path.expanduser("~"), ".local", "state")
    return os.path.join(base, "sagebrush")


class AgentLog:
    """The child's stderr, kept on this computer only: 0600 in a 0700 folder, rotated at LOG_MAX, token-like strings
    redacted chunk by chunk (a token split across two chunks is the one gap, and each chunk is 64 KiB)."""

    def __init__(self, folder=None, max_bytes=LOG_MAX):
        self.folder = folder or log_dir()
        self.max = max_bytes
        os.makedirs(self.folder, mode=0o700, exist_ok=True)
        os.chmod(self.folder, 0o700)
        self.path = os.path.join(self.folder, "agent.log")

    def write(self, chunk):
        chunk = _REDACT.sub(b"[redacted]", chunk)
        try:
            size = os.path.getsize(self.path)
        except OSError:
            size = 0
        if size + len(chunk) > self.max:
            try:
                os.replace(self.path, self.path + ".1")
            except OSError:
                pass
        fd = os.open(self.path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
        try:
            os.fchmod(fd, 0o600)
            os.write(fd, chunk[-self.max:])
        finally:
            os.close(fd)


class AgentChild:
    """One child: its process, its pipes and its pages.  `send_page(text)` is set by whoever attaches a page:
    it delivers one message to that page and returns False if there's no room yet (the pump waits and retries)."""

    def __init__(self, argv, cwd=None, env=None, log=None, grace_ms=AGENT_GRACE_MS, on_exit=None, loop=None):
        self.argv, self.cwd = list(argv), cwd
        self.env = child_env(env)
        self.log = log or AgentLog()
        self.grace_ms = grace_ms
        self.on_exit = on_exit
        self.proc = None
        self.stdout = self.stderr = self.stdin = None  # (asyncio's streams over the child's pipes)
        self.transports = []
        self.pgid = None
        self.page = None          # (an object with deliver(text) -> bool, told(text, code), closed)
        self.queue = collections.deque()  # (epoch, bytes): the page's messages not yet started, tagged with their binding
        self.queued = 0
        self.epoch = 0              # (the binding epoch: +1 at every detach)
        self.attached_once = False
        self.started_line = False   # (the start line written: it goes before anything else)
        self.slot_detached = None   # (epoch of a detached line not yet written)
        self.slot_attached = None   # (epoch of an attached line not yet written)
        self.writing_item = None    # (the message being written, off the queue: it finishes even if its binding ends)
        self.wake = asyncio.Event()
        self.grace = None
        self.tasks = []
        self.ended = False
        self.starting = False     # (between start() and the process existing: a stop then is honoured once it does)
        self.pending_interrupt = False  # (a Stop during that window, delivered once the process exists)
        self.exit_text = None
        self.stats = {"toPage": 0, "toChild": 0, "dropped": 0, "answeredDetached": 0, "refusedFull": 0, "droppedAtDetach": 0}

    async def start(self):
        """Start the child.  The start and the stop are one state machine.  The process is made by subprocess.Popen,
        synchronously, so its pid (and its process group) is known the moment it exists: there is no await between the
        spawn and the pgid, and a stop at any later point ends the whole group.  Stopped before start, nothing is
        spawned; stopped while its pipes are being attached, the group is already ended and the start only tidies up;
        a Stop sent before the process exists is delivered once it does."""
        if self.ended:
            return
        self.starting = True
        try:
            proc = subprocess.Popen(self.argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                    cwd=self.cwd, env=self.env, start_new_session=True, close_fds=True)
        except BaseException:
            self.starting = False
            raise
        self.proc, self.pgid = proc, proc.pid  # (no await since the spawn: a stop from here on ends its group)
        if self.pending_interrupt:
            self.pending_interrupt = False
            self.interrupt()
        try:
            loop = asyncio.get_running_loop()
            self.stdout = asyncio.StreamReader(limit=AGENT_FRAME + 1)
            t, _ = await loop.connect_read_pipe(lambda: asyncio.StreamReaderProtocol(self.stdout), proc.stdout)
            self.transports.append(t)
            self.stderr = asyncio.StreamReader(limit=2 * STDERR_CHUNK)
            t, _ = await loop.connect_read_pipe(lambda: asyncio.StreamReaderProtocol(self.stderr), proc.stderr)
            self.transports.append(t)
            t, pr = await loop.connect_write_pipe(lambda: asyncio.StreamReaderProtocol(asyncio.StreamReader()), proc.stdin)
            self.transports.append(t)
            # (after drain() at most this much sits in the transport: the stdin total is AGENT_QUEUE plus it)
            t.set_write_buffer_limits(high=STDIN_HIGH)
            self.stdin = asyncio.StreamWriter(t, pr, None, loop)
        except BaseException:
            # (cancelled, or a pipe couldn't be attached: the group ended, the process reaped, nothing left)
            self.starting = False
            self.stop("its start was cancelled or failed")
            self._close_pipes()
            self.tasks = [asyncio.ensure_future(self._reap())]
            raise
        self.starting = False
        if self.ended:
            # (stopped while its pipes were attached: its group is already ended (stop()); reap it, use nothing)
            self._close_pipes()
            self.tasks = [asyncio.ensure_future(self._reap())]
            return
        self.tasks = [asyncio.ensure_future(f) for f in (self._pump(), self._writer(), self._stderr(), self._watch())]
        if self.page is None:
            self.detach()  # (no page attached yet: the grace runs from the start too)

    # ---- pages
    def attach(self, page):
        if self.grace is not None:
            self.grace.cancel()
            self.grace = None
        if self.attached_once:
            if self.page is not None:
                self._end_binding()  # (a takeover: the old page's binding ends here, as at a detach)
            self.slot_attached = self.epoch
            self.wake.set()
        self.attached_once = True
        self.page = page

    def detach(self):
        if self.page is not None:
            self._end_binding()
        self.page = None
        if self.grace is None and not self.ended:
            self.grace = asyncio.get_running_loop().call_later(self.grace_ms / 1000, self._grace_over)

    def _end_binding(self):
        """The page's binding ends: the epoch goes up, the departed page's unstarted messages are dropped, and the
        detached line waits in its slot (an attached line for an earlier epoch is superseded: the next attach sends its
        own)."""
        self.epoch += 1
        for x in self.queue:  # (every message not yet started; the one being written is off the queue and finishes)
            self.queued -= len(x[1]) + QUEUE_ENTRY_BYTES
            self.stats["droppedAtDetach"] += 1
        self.queue.clear()
        self.slot_detached = self.epoch
        self.slot_attached = None
        self.wake.set()

    def _grace_over(self):
        self.grace = None
        if self.page is None:
            self.stop("the agent was idle with no page for %d s" % (self.grace_ms // 1000))

    # ---- page -> child
    def send(self, text):
        """Queue one message (compact JSON, no newline) for the child; False if the FIFO can't take it."""
        data = text.encode("utf-8", "surrogatepass") + b"\n"
        if self.ended or self.queued + len(data) + QUEUE_ENTRY_BYTES > AGENT_QUEUE:
            self.stats["refusedFull"] += 1
            return False
        self.queue.append((self.epoch, data))
        self.queued += len(data) + QUEUE_ENTRY_BYTES
        self.wake.set()
        return True

    def _control(self):
        """The next runner line due before any queued message, or None: the start line first, then detached, then
        attached."""
        if not self.started_line:
            self.started_line = True
            return ('{"relay":{"start":{"frame":%d,"protocol":1,"epoch":0}}}\n' % AGENT_FRAME).encode("ascii")
        if self.slot_detached is not None:
            n, self.slot_detached = self.slot_detached, None
            return ('{"relay":{"page":"detached","epoch":%d}}\n' % n).encode("ascii")
        if self.slot_attached is not None:
            n, self.slot_attached = self.slot_attached, None
            return ('{"relay":{"page":"attached","epoch":%d}}\n' % n).encode("ascii")
        return None

    async def _writer(self):
        try:
            while not self.ended:
                # (the runner's own lines first, between messages, never inside one)
                line = self._control()
                if line is not None:
                    self.stdin.write(line)
                    await self.stdin.drain()
                    continue
                if not self.queue:
                    self.wake.clear()
                    await self.wake.wait()
                    continue
                item = self.writing_item = self.queue.popleft()
                data = item[1]
                # (in STDIN_HIGH chunks, each drained: the high-water mark only pauses after a write, so one whole
                # 4 MiB write could sit in the transport; chunked, the transport holds at most 2 x STDIN_HIGH)
                view = memoryview(data)
                for at in range(0, len(data), STDIN_HIGH):
                    self.stdin.write(view[at:at + STDIN_HIGH])
                    await self.stdin.drain()
                self.writing_item = None
                self.queued -= len(data) + QUEUE_ENTRY_BYTES  # (counted until written: an item being drained is still resident)
                self.stats["toChild"] += 1
        except (ConnectionError, BrokenPipeError, asyncio.CancelledError):
            pass

    # ---- child -> page
    async def _pump(self):
        reader = self.stdout
        try:
            while True:
                try:
                    raw = await reader.readuntil(b"\n")
                except asyncio.LimitOverrunError:
                    return self.stop("the agent sent a message over this connection's limit of about 4 MB and was stopped",
                                     tell="The agent sent a message over this connection's limit of about 4 MB and was stopped. Reload to start it again.")
                except asyncio.IncompleteReadError as e:
                    if e.partial:
                        self._log(b"[runner] a last line with no newline was dropped (%d bytes)\n" % len(e.partial))
                    return
                line = raw[:-1]
                if len(line) > AGENT_FRAME:
                    return self.stop("the agent sent a message over this connection's limit of about 4 MB and was stopped",
                                     tell="The agent sent a message over this connection's limit of about 4 MB and was stopped. Reload to start it again.")
                try:
                    text = line.decode("utf-8")
                    msg = strict_json(text)
                except (UnicodeDecodeError, ValueError, RecursionError):
                    return self.stop("the agent sent a line that isn't JSON")
                if not isinstance(msg, dict) or "relay" in msg:
                    return self.stop("the agent sent a message this connection doesn't carry")
                await self._deliver(text, msg)
        except asyncio.CancelledError:
            pass

    async def _deliver(self, text, msg):
        while True:
            page = self.page
            if page is None or page.closed:
                if isinstance(msg.get("id"), (str, int)) and isinstance(msg.get("method"), str):
                    self.stats["answeredDetached"] += 1
                    err = {"jsonrpc": "2.0", "id": msg["id"], "error": {"code": -32001,
                           "message": "no page is attached: the person will reopen the chat",
                           "data": {"code": "detached"}}}
                    if not self.send(json.dumps(err, separators=(",", ":"))):
                        self._log(b"[runner] an answer to the agent while detached was dropped: its queue is full\n")
                else:
                    self.stats["dropped"] += 1
                return
            if page.deliver(text):
                self.stats["toPage"] += 1
                return
            # (no room on the leg: hold this one line and wait; a re-attach or detach is seen on the next look)
            await asyncio.sleep(ROOM_POLL_S)

    # ---- stderr, exit, stop
    async def _stderr(self):
        try:
            while True:
                chunk = await self.stderr.read(STDERR_CHUNK)
                if not chunk:
                    return
                self._log(chunk)
        except asyncio.CancelledError:
            pass

    def _log(self, b):
        try:
            self.log.write(b)
        except OSError:
            pass

    async def _exited(self):
        """The child's own exit, as soon as it happens (Popen.poll() reaps it), even while a descendant still holds its
        stdout or stderr: the pipes are never waited for."""
        while self.proc.poll() is None:
            await asyncio.sleep(EXIT_POLL_S)
        return self.proc.returncode

    async def _reap(self):
        await self._exited()
        self._close_pipes()

    def _close_pipes(self):
        for t in self.transports:  # (our ends of the pipes, whatever else still holds them: nothing more read)
            try:
                t.close()
            except Exception:
                pass
        for f in (self.proc.stdin, self.proc.stdout, self.proc.stderr) if self.proc is not None else ():
            try:
                f.close()
            except Exception:
                pass

    async def _watch(self):
        rc = await self._exited()
        if not self.ended:
            self.ended = True
            if self.exit_text is None:
                self.exit_text = describe_exit(rc)
            self._end_page()
        _kill_tree(self.pgid)  # (anything the child left in its group, at once: a descendant holding its pipes included)
        for t in self.tasks:
            if t is not asyncio.current_task():
                t.cancel()
        self._close_pipes()
        if self.grace is not None:
            self.grace.cancel()
            self.grace = None
        if self.on_exit:
            self.on_exit(self)

    def _end_page(self, tell=None):
        page, self.page = self.page, None
        if page is not None and not page.closed:
            page.told(tell or ("%s. Reload to start it again." % self.exit_text), 1011)

    def interrupt(self):
        """Stop: SIGINT to the child's process group (the agent ends its turn and says so).  While the process is
        still being spawned, it is delivered once it exists."""
        if self.ended:
            return
        if self.pgid is None:
            self.pending_interrupt = True
            return
        if not self.ended:
            try:
                os.killpg(self.pgid, signal.SIGINT)
            except (ProcessLookupError, PermissionError):
                pass

    def stop(self, why, tell=None):
        """The end: the page (if any) is told, then the tree rule on the child's group."""
        if self.ended:
            return
        self.ended = True
        self.exit_text = "The agent stopped"
        self._log(("[runner] stopping the agent: %s\n" % why).encode("utf-8"))
        self._end_page(tell)
        if self.pgid is not None:
            _kill_tree(self.pgid)


def ending_groups_view():
    """The process groups still being ended (gateway's set, for tests: a group's SIGKILL timer still due)."""
    return set(ENDING_GROUPS)


def describe_exit(rc):
    if rc is None:
        return "The agent stopped"
    if rc < 0:
        try:
            return "The agent stopped (signal %s)" % signal.Signals(-rc).name
        except ValueError:
            return "The agent stopped (signal %d)" % -rc
    return "The agent stopped (exit code %d)" % rc
