"""The PNG engine's process for the Python package (PNG plan r8 sections
2.3 to 2.6): the raster child, its spawn, its limits and its protocol.

A PNG is drawn or read in a process of its own (python -I -S -c PRELUDE,
the extension loaded from its file, running engine/py/src/raster_child.rs),
so the engine running out of memory, or crashing, ends that process, never
this one, and Ctrl-C ends it at once.

The isolation modes (SAGEBRUSH_RASTER_ISOLATION):

- "enforced": on Linux, where the child is started by the static launcher
  (_bin/raster-launch-<arch>), which sets RLIMIT_AS before Python runs, and
  the per-call limits can be set (prlimit): the engine's address space stays
  within the memory admitted for it.
- "contained", the default elsewhere (macOS, Windows, or Linux when the
  launcher or prlimit can't be used): the child is the same process without
  the limit; a crash stays contained, but the engine may use more memory
  than admitted.  A warning says so, once.  Setting "enforced" refuses
  instead.
- "in-process": only when set; the engine runs inside this Python, with no
  protection against crashes or memory exhaustion.

Failing to start the child never falls back to in-process.
"""

import os
import struct
import sys

import _capacity
import _memguard
import _memledger

MAGIC = 0x46524253
PING, RENDER, DECODE, SHUTDOWN = 1, 2, 3, 4
ERR_START = 7
READY, PONG, OK_RENDER, OK_DECODE = 100, 101, 102, 103
ERR_INPUT, ERR_BACKEND, ERR_MEMORY = 110, 111, 112
_HEAD = struct.Struct("<IIQ")

# The launcher's and the prelude's ERR_START stages
STAGE_LIMIT, STAGE_PDEATHSIG, STAGE_FOOTPRINT, STAGE_EXEC, STAGE_FLAGS, STAGE_IMPORT_MEMORY = 1, 2, 3, 4, 5, 6

_WAKE = 0.025           # (the wait loop's wake, to see Ctrl-C and a child's exit: a polling slice, not a limit; Stop within 250 ms end to end, William Oct 27)
_STDERR_TAIL = 4096     # (the bytes of the child's standard error shown after a failure: display only)


class SagebrushEngineError(RuntimeError):
    """The PNG engine's process failed for a reason that is not the input
    and not shown to be memory: a Sagebrush bug, or something outside it
    (oom_suspected: the system's out-of-memory killer was active then)."""

    oom_suspected = False


def _frame(kind, stage, errno=0, observed=0):
    return _HEAD.pack(MAGIC, kind, 16) + struct.pack("<IIQ", stage, errno, observed)


# The child's program: its flags checked before anything else, the extension
# loaded from its file (not the sagebrush package), then the engine's loop.
# The two refusals it can write are frames built here, constants of its code.
PRELUDE = r'''
import sys
F = %r
M = %r
if sys.flags.isolated != 1 or sys.flags.no_site != 1 or "" in sys.path:
    import os; os.write(1, F); os._exit(105)
import os
if os.getcwd() in sys.path:
    os.write(1, F); os._exit(105)
try:
    import importlib.util as u
    s = u.spec_from_file_location("sagebrush._native", sys.argv[1])
    m = u.module_from_spec(s)
    s.loader.exec_module(m)
except MemoryError:
    os.write(1, M); os._exit(106)
except ImportError as e:
    if "Cannot allocate memory" in str(e):
        os.write(1, M); os._exit(106)
    raise
m.raster.raster_child_main()
''' % (_frame(ERR_START, STAGE_FLAGS), _frame(ERR_START, STAGE_IMPORT_MEMORY))

_warned = set()


def _warn(reason):
    if reason not in _warned:
        _warned.add(reason)
        sys.stderr.write("Sagebrush cannot enforce a memory bound on its PNG engine here (%s); "
                         "a crash stays contained, but the engine may use more memory than admitted.\n" % reason)


def mode():
    """The isolation mode asked for: "enforced", "contained" (the default)
    or "in-process"."""
    m = os.environ.get("SAGEBRUSH_RASTER_ISOLATION", "contained")
    if m not in ("enforced", "contained", "in-process"):
        raise ValueError("SAGEBRUSH_RASTER_ISOLATION=%r: one of enforced, contained, in-process" % m)
    return m


def _ext_path():
    from sagebrush import _native
    return _native.__file__


# The launchers' sha256 as scripts/build-raster-launch.mjs built them (it
# writes this table; with --check, CI fails if it or a binary differs from
# what the source builds).
LAUNCHER_SHA256 = {
    "x86_64": "850acbe7492feb1f455775a2db8bdec99a79d8d8b4f6a0c0adcde520d689f6c7",
    "aarch64": "ab3279f1c3041ccc16bbd40ca38155c1d72e1980a962cccff01a337c8f58f568",
}

_checked = {}


def _launcher():
    """The launcher for this machine, or None (not Linux, not shipped, or
    not the bytes this package was built with: then the contained mode)."""
    if not sys.platform.startswith("linux"):
        return None
    import platform
    arch = {"x86_64": "x86_64", "amd64": "x86_64", "aarch64": "aarch64", "arm64": "aarch64"}.get(platform.machine().lower())
    if arch is None:
        return None
    p = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "_bin", "raster-launch-" + arch)
    if not os.access(p, os.X_OK):
        return None
    if p not in _checked:
        import hashlib
        try:
            with open(p, "rb") as f:
                _checked[p] = hashlib.sha256(f.read()).hexdigest() == LAUNCHER_SHA256.get(arch)
        except OSError:
            _checked[p] = False
        if not _checked[p]:
            _warn("its launcher, %s, is not the one this package was built with" % p)
    return p if _checked[p] else None


# ------------------------------------------------------------ the footprint

def _pages(n, p):
    return -(-n // p) * p


def _segments(path, p):
    """The launcher's PT_LOAD segments, each rounded to pages of p bytes."""
    with open(path, "rb") as f:
        b = f.read()
    if b[:4] != b"\x7fELF" or b[4] != 2 or b[5] != 1:
        raise OSError("the PNG engine's launcher is not a 64-bit ELF")
    phoff, = struct.unpack_from("<Q", b, 32)
    phentsize, phnum = struct.unpack_from("<HH", b, 54)
    total = 0
    for i in range(phnum):
        at = phoff + i * phentsize
        ptype, = struct.unpack_from("<I", b, at)
        if ptype == 1:
            vaddr, = struct.unpack_from("<Q", b, at + 16)
            memsz, = struct.unpack_from("<Q", b, at + 40)
            total += _pages(vaddr % p + memsz, p)
    return total


def _special_mappings():
    """[vdso], [vvar] and the like in this process: the kernel maps the same
    into every process."""
    total = 0
    try:
        with open("/proc/self/maps") as f:
            for line in f:
                name = line.split()[-1] if len(line.split()) >= 6 else ""
                if name.startswith("[v"):
                    a, b = line.split()[0].split("-")
                    total += int(b, 16) - int(a, 16)
    except OSError:
        pass
    return total


def footprint_bound(launcher, argv, env, path):
    """The launcher's whole address space before its limit (r8 section
    2.3), for this invocation: its segments, the initial stack (the strings,
    pointers and auxiliary vector, plus the kernel's 128 KiB expansion and a
    page), and the special mappings."""
    p = os.sysconf("SC_PAGE_SIZE")
    strings = sum(len(os.fsencode(a)) + 1 for a in argv) + sum(len(os.fsencode(k)) + len(os.fsencode(v)) + 2 for k, v in env.items())
    strings += len(os.fsencode(path)) + 1
    a = strings + 8 * (len(argv) + len(env) + 2) + 2 * 8 * 64 + 16 + 64 + 16
    return _segments(launcher, p) + _pages(a + 131072, p) + p + _special_mappings()


# ------------------------------------------------------------ the child

_PAGE = os.sysconf("SC_PAGE_SIZE") if hasattr(os, "sysconf") else 4096


def _small_read(path, n=512):
    """A small /proc or cgroup file's first n bytes, read (and closed)
    natively: no descriptor for Python code to close, so an interruption
    can't leave one open; no buffered file object either (a call's
    bookkeeping allocates next to nothing, _sbraster.BOOKKEEPING)."""
    from sagebrush._native import raster
    return raster.read_prefix(path, n)


def _statm(pid):
    """(VmSize, VmRSS) in bytes from /proc/PID/statm (one read), or None."""
    try:
        v = _small_read("/proc/%d/statm" % pid).split()
        return int(v[0]) * _PAGE, int(v[1]) * _PAGE
    except (OSError, ValueError, IndexError):
        return None


class Child:
    """A running raster child: the native handle that owns its process and
    the parent's ends of its pipes (child.rs: every state change recorded in
    the same native step as its system call), its standard error (an
    unlinked file), whether its limit is enforced, and its limit."""

    def __init__(self, h, err, enforced):
        self.h, self.err, self.enforced = h, err, enforced
        self.limit = None
        self.hard = None
        self.frames = []

    # (read from the handle each time: a closed end is -1 there, never a
    # number that another file may have been given since)
    @property
    def pid(self):
        return self.h.pid

    @property
    def wfd(self):
        return self.h.wfd

    @property
    def rfd(self):
        return self.h.rfd

    def vmsize(self):
        m = _statm(self.pid)
        return m[0] if m else None

    def rss(self):
        m = _statm(self.pid)
        return m[1] if m else 0

    def set_limit(self, n):
        import resource
        if self.hard is None:
            self.hard = resource.prlimit(self.pid, resource.RLIMIT_AS)[1]
        hard = self.hard
        if hard != resource.RLIM_INFINITY and n > hard:
            n = hard
        p = os.sysconf("SC_PAGE_SIZE")
        n -= n % p
        resource.prlimit(self.pid, resource.RLIMIT_AS, (n, hard))
        self.limit = n
        return n

    def charge(self):
        """The standing charge: the whole limit when enforced, else what is
        resident (an estimate: nothing bounds it)."""
        if self.enforced and self.limit is not None:
            return self.limit
        return self.rss()

    def kill(self):
        """Ended and reaped (the kill pipe, SIGKILL only as its fallback:
        child.rs), its pipes closed: its exit status as
        os.waitstatus_to_exitcode gives it (None if lost).  Idempotent."""
        code = self.h.kill_and_reap(_WAKE)
        self.h.close_io()
        return code

    def reap(self):
        """Its pipes closed and its exit waited for, without ending it (its
        output ended: its own status, not a kill's)."""
        self.h.close_io()
        return self.h.wait(_WAKE)

    def stderr_tail(self):
        try:
            self.err.seek(0, 2)
            n = self.err.tell()
            self.err.seek(max(0, n - _STDERR_TAIL))
            return self.err.read().decode("utf-8", "replace")
        except (OSError, ValueError):
            return ""


def _set_nonblocking(fd):
    os.set_blocking(fd, False)


_spawner = None


def _spawn_loop(q):
    while True:
        q.get()()


def _spawner_queue():
    """The one thread that starts raster children, which lives as long as
    the process: the launcher's parent-death signal follows the thread that
    started the child (prctl(2)), so a child started by a thread that then
    ends would be killed with it."""
    global _spawner
    if _spawner is None:
        import queue
        import threading
        q = queue.Queue()
        threading.Thread(target=_spawn_loop, args=(q,), name="sagebrush-raster-spawner", daemon=True).start()
        _spawner = q
    return _spawner


class Plan:
    """How the next child starts: the launcher (None: contained), the bound
    on its pre-limit footprint (r8 section 2.3: computed before admission,
    for the longest argv this invocation can have), the program and its
    environment."""

    __slots__ = ("launcher", "bound", "prog", "env")

    def __init__(self, launcher, bound, prog, env):
        self.launcher, self.bound, self.prog, self.env = launcher, bound, prog, env


def _launch_argv(launcher, limit, bound, prog):
    return [launcher, str(limit), str(os.getpid()), "1", str(bound)] + prog


def launch_plan(want):
    """The plan for starting a child in the mode asked for, or the refusal
    (want == "enforced" where no limit can be enforced), raised before
    anything is created."""
    # (the refusals first, before anything is looked up or made)
    portable = sys.platform == "win32" or not hasattr(os, "posix_spawn")
    launcher = None if portable else _launcher()
    if want == "enforced" and portable:
        raise SagebrushEngineError("SAGEBRUSH_RASTER_ISOLATION=enforced: Sagebrush can't enforce a memory bound on its PNG engine on this system")
    if want == "enforced" and launcher is None:
        raise SagebrushEngineError("SAGEBRUSH_RASTER_ISOLATION=enforced: Sagebrush can't enforce a memory bound on its PNG engine here (no launcher for this system)")
    env = {"LC_ALL": "C"}
    for k in ("SYSTEMROOT", "PATH"):  # (Windows needs SYSTEMROOT to start)
        if k in os.environ and sys.platform == "win32":
            env[k] = os.environ[k]
    prog = [sys.executable, "-I", "-S", "-c", PRELUDE, _ext_path()]
    if portable:
        _warn("this system has no memory limit Sagebrush can set for a process")
        return Plan(None, 0, prog, env)
    if launcher is None:
        _warn("no launcher for this system" if sys.platform.startswith("linux") else "this system enforces no address-space limit")
        return Plan(None, 0, prog, env)
    # (the limit's and the bound's own digits at their longest: the bound
    # covers the argv the launch will have)
    longest = "9" * 20
    bound = footprint_bound(launcher, _launch_argv(launcher, longest, longest, prog), env, launcher)
    return Plan(launcher, bound, prog, env)


def contained(plan):
    """The same start without the launcher."""
    return Plan(None, 0, plan.prog, plan.env)


def _threads():
    """Whether the pipes are driven by blocking calls on helper threads
    (Windows, whose select takes sockets only and has no readv; forced by
    the tests elsewhere) rather than select and non-blocking calls."""
    return sys.platform == "win32" or _FORCE_THREADS


_FORCE_THREADS = False


def spawn_into(ob, limit, plan):
    """A raster child under `limit` bytes of address space (enforced when
    the plan has the launcher), or under none (contained); raises
    SagebrushEngineError if it can't be started.

    The creation is native (child.rs, #157 r5 R3): a SpawnTask, published in
    ob.spawn before it is queued, run on the spawner thread, and moved into
    ob.handle in one native step (take_into), so no bytecode separates a
    process from its owner.  Whatever ends the call settles both
    (_sbraster's settle: ob.spawn.cancel_and_clean(), ob.handle's
    kill_and_reap); a failed creation has closed everything it made.
    Returns the Child (ob.child too)."""
    import tempfile
    from sagebrush._native import raster
    err = tempfile.TemporaryFile()
    ob.err = err
    if plan.launcher is None:
        path, argv = sys.executable, plan.prog
    else:
        path, argv = plan.launcher, _launch_argv(plan.launcher, limit, plan.bound, plan.prog)
    ob.spawn = raster.SpawnTask(path, argv, plan.env, err.fileno())
    _spawner_queue().put(ob.spawn.run)
    while not ob.spawn.wait_done(_WAKE):
        pass
    failed = None
    try:
        ob.spawn.take_into(ob, "handle")
    except OSError as e:
        # (the creation's own error: nothing of it is left.  Only its text
        # kept, and acted on after the handler: raised in it, the error's
        # traceback and this frame would hold each other (and the stderr
        # file) until a collection)
        failed = str(e)
    if failed is not None:
        if plan.launcher is not None and mode() == "enforced":
            raise SagebrushEngineError("SAGEBRUSH_RASTER_ISOLATION=enforced: the PNG engine's launcher can't be run (%s)" % failed)
        if plan.launcher is not None:
            # (the launcher can't run, a noexec mount: the contained mode)
            _warn("its launcher can't be run: %s" % failed)
            return spawn_into(ob, limit, contained(plan))
        raise SagebrushEngineError("Sagebrush could not start its PNG engine process (%s). Set "
                                   "SAGEBRUSH_RASTER_ISOLATION=in-process to run it inside Python, without "
                                   "protection against crashes and memory exhaustion." % failed)
    if not _threads():
        _set_nonblocking(ob.handle.wfd)
        _set_nonblocking(ob.handle.rfd)
    c = Child(ob.handle, err, plan.launcher is not None)
    c.limit = limit if plan.launcher is not None else None
    ob.child = c
    return c


class _Owner:
    """What spawn() gives spawn_into: an owner of its own."""


def spawn(limit, plan):
    """spawn_into with an owner of its own (tools and tests: an unsettled
    child is ended when its handle is collected)."""
    return spawn_into(_Owner(), limit, plan)


# ------------------------------------------------------------ I/O

class _Exited(Exception):
    """The child's output ended (it exited) before a whole frame."""


def _select(rl, wl):
    import select
    return select.select(rl, wl, [], _WAKE)


def _blocking(child, fn):
    """fn() run on a helper thread while this one waits in wakes of _WAKE,
    seeing Ctrl-C (which propagates: the caller kills the child, which ends
    fn's blocking call) and the child's exit.  fn's exception is raised
    here."""
    import threading
    out = []

    def run():
        try:
            out.append((True, fn()))
        except BaseException as e:
            out.append((False, e))
    t = threading.Thread(target=run, name="sagebrush-raster-io", daemon=True)
    t.start()
    while True:
        t.join(_WAKE)
        if not t.is_alive():
            break
    good, v = out[0]
    if good:
        return v
    raise v


def _write_blocking(child, parts):
    for part in parts:
        view = memoryview(part).cast("B")
        while len(view):
            try:
                n = os.write(child.wfd, view)
            except (BrokenPipeError, OSError) as e:
                if isinstance(e, BrokenPipeError) or getattr(e, "errno", None) in (22, 32):  # (EINVAL: Windows' broken pipe)
                    raise _Exited() from None
                raise
            view = view[n:]


def _read_blocking(child, buf):
    import io
    f = io.FileIO(child.rfd, "rb", closefd=False)
    view = memoryview(buf).cast("B")
    while len(view):
        try:
            n = f.readinto(view)
        except OSError:
            raise _Exited() from None
        if not n:
            raise _Exited()
        view = view[n:]


def write_all(child, parts):
    """The parts written in order, partially as the pipe allows, waking to
    see Ctrl-C (which propagates) and the child's exit."""
    if _threads():
        return _blocking(child, lambda: _write_blocking(child, parts))
    for part in parts:
        view = memoryview(part).cast("B")
        while len(view):
            _, w, _ = _select([], [child.wfd])
            if not w:
                if _exited(child):
                    raise _Exited()
                continue
            try:
                n = os.write(child.wfd, view)
            except BlockingIOError:
                continue
            except BrokenPipeError:
                raise _Exited() from None
            view = view[n:]


def read_into(child, buf):
    """buf filled from the child's output (partial reads, as they come)."""
    if _threads():
        return _blocking(child, lambda: _read_blocking(child, buf))
    view = memoryview(buf).cast("B")
    while len(view):
        r, _, _ = _select([child.rfd], [])
        if not r:
            continue
        try:
            n = os.readv(child.rfd, [view])
        except BlockingIOError:
            continue
        if n == 0:
            raise _Exited()
        view = view[n:]


def _exited(child):
    """Whether the child has ended (reaped or lost), after one non-blocking
    look (native: the reap and its record are one step)."""
    return child.h.poll_exit()


def read_frame(child, bounds):
    """A frame's (kind, payload length), its header validated: magic, a
    kind in `bounds` (kind -> the most its payload may be), its length
    within that.  The payload is the caller's to read."""
    h = bytearray(16)
    read_into(child, h)
    magic, kind, length = _HEAD.unpack(h)
    if magic != MAGIC or kind not in bounds or length > bounds[kind]:
        raise ProtocolError("kind %d, %d bytes" % (kind, length))
    return kind, length


class ProtocolError(Exception):
    pass


# ------------------------------------------------------------ outcomes

_events = None


def _oom_kills():
    """The oom_kill count of this process's cgroup (v2), or None."""
    global _events
    try:
        if _events is None:
            with open("/proc/self/cgroup") as f:
                rel = [l.strip().split(":", 2)[2] for l in f if l.startswith("0::")]
            _events = ("/sys/fs/cgroup" + rel[0] + "/memory.events") if rel else ""
        if not _events:
            return None
        for line in _small_read(_events, 1024).split(b"\n"):
            if line.startswith(b"oom_kill "):
                return int(line.split()[1])
    except (OSError, ValueError, IndexError):
        pass
    return None


def classify(child, status, frames, grant, killed_by_us, oom_before, startup):
    """The exception for a child that ended, by its evidence (r8 section
    2.4): a memory error only on positive evidence, else the engine's
    failure of unknown cause."""
    tail = child.stderr_tail()
    for kind, payload in frames:
        if kind == ERR_START and len(payload) >= 16:
            stage, errno, observed = struct.unpack_from("<IIQ", payload)
            if stage == STAGE_EXEC and errno == 12:
                return _memory("could not start within the %d bytes Sagebrush could give it" % grant, grant)
            if stage == STAGE_IMPORT_MEMORY:
                return _memory("could not load within the %d bytes Sagebrush could give it" % grant, grant)
            if stage == STAGE_LIMIT and errno == 0:
                return _memguard.SagebrushMemoryError(
                    "Not enough memory for this computation.\nThis process's address-space limit, set outside Sagebrush "
                    "(%d bytes), is below the memory admitted for the PNG engine." % observed,
                    "The PNG engine", None, observed, "this process's address-space limit")
            if stage == STAGE_FOOTPRINT:
                return FootprintRefused(observed)
            return SagebrushEngineError("the PNG engine process failed to start (stage %d, errno %d)" % (stage, errno))
    import re
    m = re.search(r"memory allocation of (\d+) bytes failed", tail)
    if m:
        return _memory("ran out of the %d bytes Sagebrush could give it (an allocation of %s bytes was refused)" % (grant, m.group(1)), grant)
    import signal
    if status == -signal.SIGKILL and not killed_by_us:
        e = SagebrushEngineError("the PNG engine process was killed from outside Sagebrush")
        after = _oom_kills()
        if oom_before is not None and after is not None and after > oom_before:
            e = SagebrushEngineError("the PNG engine process was killed from outside Sagebrush; the out-of-memory "
                                     "killer was active in this container at the time (cause unconfirmed)")
            e.oom_suspected = True
        return e
    what = "during startup" if startup else ""
    sig = (" (signal %d)" % -status) if isinstance(status, int) and status < 0 else (" (status %r)" % status)
    limit = (" under an address-space limit of %d bytes" % child.limit) if (startup and child.limit) else ""
    return SagebrushEngineError("the PNG engine process failed%s%s%s; cause unknown, please report this%s"
                                % (" " + what if what else "", sig, limit, ("\n" + tail.strip()) if tail.strip() else ""))


def _memory(how, grant):
    text = "Not enough memory for this computation.\nThe PNG engine %s.\n%s" % (how, _memguard.TEXT[_memguard.where()])
    return _memguard.SagebrushMemoryError(text, "The PNG engine", None, grant, "PNG work")


class FootprintRefused(Exception):
    """The launcher's footprint exceeded the bound computed for it: this
    host's kernel differs from the bound's assumptions, so the limit can't
    be shown to hold from the start (the contained mode, r8 section 2.3)."""

    def __init__(self, observed):
        Exception.__init__(self, observed)
        self.observed = observed
