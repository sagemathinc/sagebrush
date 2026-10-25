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

_WAKE = 0.05            # (the wait loop's wake, to see Ctrl-C and a child's exit: an interval, not a limit)
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


def _launcher():
    """The launcher for this machine, or None (not Linux, or not shipped)."""
    if not sys.platform.startswith("linux"):
        return None
    import platform
    arch = {"x86_64": "x86_64", "amd64": "x86_64", "aarch64": "aarch64", "arm64": "aarch64"}.get(platform.machine().lower())
    if arch is None:
        return None
    p = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "_bin", "raster-launch-" + arch)
    return p if os.access(p, os.X_OK) else None


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


def _statm(pid):
    """(VmSize, VmRSS) in bytes from /proc/PID/statm (one read), or None."""
    try:
        with open("/proc/%d/statm" % pid, "rb") as f:
            v = f.read().split()
        return int(v[0]) * _PAGE, int(v[1]) * _PAGE
    except (OSError, ValueError, IndexError):
        return None


class Child:
    """A running raster child: its pid, its pipes, its standard error (an
    unlinked file), whether its limit is enforced, and its limit."""

    def __init__(self, pid, wfd, rfd, err, enforced, proc=None):
        self.pid, self.wfd, self.rfd, self.err, self.enforced, self.proc = pid, wfd, rfd, err, enforced, proc
        self.limit = None
        self.hard = None
        self.frames = []

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
        import signal
        try:
            if self.proc is not None:
                self.proc.kill()
            else:
                os.kill(self.pid, signal.SIGKILL)
        except OSError:
            pass
        return self.reap()

    def reap(self):
        """Waits for the process (after it exited or was killed): its exit
        status as os.waitstatus_to_exitcode gives it."""
        for fd in (self.wfd, self.rfd):
            try:
                os.close(fd)
            except OSError:
                pass
        self.wfd = self.rfd = -1
        if self.proc is not None:
            return self.proc.wait()
        while True:
            try:
                _, st = os.waitpid(self.pid, 0)
                return os.waitstatus_to_exitcode(st)
            except InterruptedError:
                continue
            except ChildProcessError:
                return None

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


def _from_spawner(f):
    """f() run on the one thread that starts raster children, which lives
    as long as the process: the launcher's parent-death signal follows the
    thread that started the child (prctl(2)), so a child started by a
    thread that then ends would be killed with it."""
    global _spawner
    import threading
    if _spawner is None:
        import queue
        q = queue.Queue()

        def loop():
            while True:
                fn, box, done = q.get()
                try:
                    box.append((True, fn()))
                except BaseException as e:  # (handed back to the caller)
                    box.append((False, e))
                done.set()
        threading.Thread(target=loop, name="sagebrush-raster-spawner", daemon=True).start()
        _spawner = q
    box, done = [], threading.Event()
    _spawner.put((f, box, done))
    done.wait()
    good, v = box[0]
    if good:
        return v
    raise v


def spawn(limit, want):
    """A raster child under `limit` bytes of address space (enforced when
    the launcher can be used), or under none (contained).  want: the mode
    asked for.  Raises SagebrushEngineError if it can't be started."""
    import tempfile
    ext = _ext_path()
    env = {"LC_ALL": "C"}
    for k in ("SYSTEMROOT", "PATH"):  # (Windows needs SYSTEMROOT to start)
        if k in os.environ and sys.platform == "win32":
            env[k] = os.environ[k]
    prog = [sys.executable, "-I", "-S", "-c", PRELUDE, ext]
    err = tempfile.TemporaryFile()
    launcher = _launcher()
    if sys.platform == "win32" or not hasattr(os, "posix_spawn"):
        if want == "enforced":
            raise SagebrushEngineError("SAGEBRUSH_RASTER_ISOLATION=enforced: Sagebrush can't enforce a memory bound on its PNG engine on this system")
        _warn("this system has no memory limit Sagebrush can set for a process")
        import subprocess
        proc = subprocess.Popen(prog, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=err, env=env, bufsize=0)
        wfd, rfd = os.dup(proc.stdin.fileno()), os.dup(proc.stdout.fileno())
        proc.stdin.close()
        proc.stdout.close()
        return Child(proc.pid, wfd, rfd, err, False, proc)
    r_in, w_in = os.pipe()
    r_out, w_out = os.pipe()
    actions = [(os.POSIX_SPAWN_DUP2, r_in, 0), (os.POSIX_SPAWN_DUP2, w_out, 1), (os.POSIX_SPAWN_DUP2, err.fileno(), 2)]
    enforced = launcher is not None
    if not enforced:
        if want == "enforced":
            raise SagebrushEngineError("SAGEBRUSH_RASTER_ISOLATION=enforced: Sagebrush can't enforce a memory bound on its PNG engine here (no launcher for this system)")
        _warn("no launcher for this system" if sys.platform.startswith("linux") else "this system enforces no address-space limit")
        path, argv = sys.executable, prog
    else:
        bound = footprint_bound(launcher, [launcher, str(limit), str(os.getpid()), "1", "0"] + prog, env, launcher)
        path, argv = launcher, [launcher, str(limit), str(os.getpid()), "1", str(bound)] + prog
    try:
        pid = _from_spawner(lambda: os.posix_spawn(path, argv, env, file_actions=actions))
    except OSError as e:
        for fd in (r_in, w_in, r_out, w_out):
            os.close(fd)
        if enforced and want == "enforced":
            raise SagebrushEngineError("SAGEBRUSH_RASTER_ISOLATION=enforced: the PNG engine's launcher can't be run (%s)" % e) from None
        if enforced:
            # (the launcher can't run, a noexec mount: the contained mode)
            _warn("its launcher can't be run: %s" % e)
            return spawn_contained(prog, env, err)
        raise SagebrushEngineError("Sagebrush could not start its PNG engine process (%s). Set "
                                   "SAGEBRUSH_RASTER_ISOLATION=in-process to run it inside Python, without "
                                   "protection against crashes and memory exhaustion." % e) from None
    os.close(r_in)
    os.close(w_out)
    _set_nonblocking(w_in)
    _set_nonblocking(r_out)
    c = Child(pid, w_in, r_out, err, enforced)
    c.limit = limit if enforced else None
    return c


def spawn_contained(prog, env, err):
    r_in, w_in = os.pipe()
    r_out, w_out = os.pipe()
    actions = [(os.POSIX_SPAWN_DUP2, r_in, 0), (os.POSIX_SPAWN_DUP2, w_out, 1), (os.POSIX_SPAWN_DUP2, err.fileno(), 2)]
    try:
        pid = _from_spawner(lambda: os.posix_spawn(sys.executable, prog, env, file_actions=actions))
    except OSError as e:
        for fd in (r_in, w_in, r_out, w_out):
            os.close(fd)
        raise SagebrushEngineError("Sagebrush could not start its PNG engine process (%s)" % e) from None
    os.close(r_in)
    os.close(w_out)
    _set_nonblocking(w_in)
    _set_nonblocking(r_out)
    return Child(pid, w_in, r_out, err, False)


# ------------------------------------------------------------ I/O

class _Exited(Exception):
    """The child's output ended (it exited) before a whole frame."""


def _select(rl, wl):
    import select
    return select.select(rl, wl, [], _WAKE)


def write_all(child, parts):
    """The parts written in order, partially as the pipe allows, waking to
    see Ctrl-C (which propagates) and the child's exit."""
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
    if child.proc is not None:
        return child.proc.poll() is not None
    try:
        pid, _ = os.waitpid(child.pid, os.WNOHANG)
    except ChildProcessError:
        return True
    if pid:
        child.proc_status_lost = True
    return bool(pid)


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
        with open(_events) as f:
            for line in f:
                if line.startswith("oom_kill "):
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
