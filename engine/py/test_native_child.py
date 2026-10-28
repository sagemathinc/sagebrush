"""The raster child's native process handle and its creation (#157 simpler
path: engine/py/src/child.rs), on POSIX and Windows (the tests that are
about POSIX alone, the kill pipe, reaping and signals, are skipped there).

    python engine/py/test_native_child.py [-k NAME]
"""
import os
import signal
import sys
import tempfile
import threading
import time

import sagebrush  # noqa: F401
from sagebrush._native import raster

# A child that behaves as the raster child does for these purposes: READY
# ("R") on fd 1, a watchdog on fd 3 (the kill pipe) ending it at once, fd 4
# (the life pipe) kept open.
WATCHED = r'''
import os, threading, time
def watch():
    os.read(3, 1)
    os._exit(137)
threading.Thread(target=watch, daemon=True).start()
os.write(1, b"R")
time.sleep(120)
'''
# One that ignores the kill pipe (no watchdog): the SIGKILL fallback's case.
DEAF = r'''
import os, time
os.write(1, b"R")
time.sleep(120)
'''
QUICK = r'''
import os, sys
os.write(1, b"R")
sys.exit(3)
'''
# One that starts a grandchild, writes its pid, and waits (Windows: the job
# ends the grandchild with it).
PARENT = r'''
import os, subprocess, sys, time
g = subprocess.Popen([sys.executable, "-I", "-S", "-c", "import time; time.sleep(120)"], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
os.write(1, b"R" + str(g.pid).encode() + b"\n")
time.sleep(120)
'''
WINDOWS = sys.platform == "win32"


def posix_only(f):
    f.posix_only = True
    return f


def linux_only(f):
    f.linux_only = True
    return f


def children():
    """This process's child processes (Linux: /proc's per-thread lists)."""
    out = set()
    for t in os.listdir("/proc/self/task"):
        try:
            with open("/proc/self/task/%s/children" % t) as f:
                out |= {int(x) for x in f.read().split()}
        except OSError:
            pass
    return out


class Ob:
    pass


def fds():
    """This process's descriptors (Windows: its handle count)."""
    if WINDOWS:
        import ctypes
        n = ctypes.c_ulong()
        assert ctypes.windll.kernel32.GetProcessHandleCount(ctypes.windll.kernel32.GetCurrentProcess(), ctypes.byref(n))
        return n.value
    return len(os.listdir("/proc/self/fd")) if os.path.isdir("/proc/self/fd") else len(os.listdir("/dev/fd"))


def env():
    e = {"LC_ALL": "C"}
    for k in ("SYSTEMROOT", "PATH"):  # (as launch_plan: Windows needs SYSTEMROOT to start)
        if WINDOWS and k in os.environ:
            e[k] = os.environ[k]
    return e


def start(code, fail_after=None):
    """A child made the way _raster_child makes one: a SpawnTask run on
    another thread (the spawner), then taken into an object."""
    err = tempfile.TemporaryFile()
    t = raster.SpawnTask(sys.executable, [sys.executable, "-I", "-S", "-c", code], env(), err.fileno(), fail_after)
    th = threading.Thread(target=t.run)
    th.start()
    th.join(10)
    assert t.done()
    ob = Ob()
    t.take_into(ob)
    ob.err = err
    c = ob.child
    assert os.read(c.rfd, 1) == b"R"
    return c


def gone(pid):
    if WINDOWS:
        # (never os.kill there: any signal number but the console events is a TerminateProcess)
        import ctypes
        k = ctypes.windll.kernel32
        h = k.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
        if not h:
            return True
        try:
            code = ctypes.c_ulong()
            k.GetExitCodeProcess(h, ctypes.byref(code))
            return code.value != 259  # STILL_ACTIVE
        finally:
            k.CloseHandle(h)
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return True
    return False


def test_the_kill_pipe_ends_a_watched_child_without_a_signal():
    # (Windows: TerminateProcess on the handle, once, exit code 1 as Popen.kill's)
    want, sent = (1, 1) if WINDOWS else (137, 0)
    c = start(WATCHED)
    pid = c.pid
    print("  pidfd: %s" % c.has_pidfd)
    t0 = time.monotonic()
    # (a slice long enough that a slow VM's watchdog isn't overtaken by the
    # SIGKILL fallback: the exit itself ends the wait at once)
    code = c.kill_and_reap(0.2)
    dt = time.monotonic() - t0
    assert code == want and c.state == "reaped" and c.signals_sent == sent, (code, c.state, c.signals_sent)
    assert dt < 0.25 and gone(pid), dt
    # (reaped is terminal: nothing more is ever sent)
    assert c.kill_and_reap() == want and c.signals_sent == sent


@posix_only
def test_a_child_without_a_watchdog_gets_the_sigkill_fallback():
    c = start(DEAF)
    t0 = time.monotonic()
    code = c.kill_and_reap(0.025)
    assert code == -signal.SIGKILL and c.signals_sent >= 1 and c.state == "reaped", (code, c.signals_sent)
    assert time.monotonic() - t0 < 0.25


def test_an_exit_is_seen_and_reaped_once():
    c = start(QUICK)
    t0 = time.monotonic()
    while not c.poll_exit():
        assert time.monotonic() - t0 < 10
        time.sleep(0.01)
    assert c.state == "reaped" and c.returncode == 3 and c.signals_sent == 0
    assert c.kill_and_reap() == 3 and c.signals_sent == 0


@posix_only
def test_a_child_reaped_by_someone_else_is_lost_and_never_signalled():
    # (outside the supported contract: our wait gets ECHILD, and the handle
    # stops: Lost, no signal to that pid ever again)
    c = start(QUICK)
    pid = c.pid
    os.waitpid(pid, 0)
    assert c.poll_exit() and c.state == "lost" and c.returncode is None
    assert c.kill_and_reap() is None and c.signals_sent == 0


def test_cancellation_before_during_and_after_the_creation_leaves_nothing():
    base = fds()
    err = tempfile.TemporaryFile()
    argv = [sys.executable, "-I", "-S", "-c", WATCHED]
    # before: never runs
    t = raster.SpawnTask(sys.executable, argv, env(), err.fileno())
    t.cancel_and_clean()
    t.run()
    ob = Ob()
    try:
        t.take_into(ob)
        raise AssertionError("taken")
    except RuntimeError:
        pass
    # after it ran, before it was taken: ended and reaped by the cancel
    t = raster.SpawnTask(sys.executable, argv, env(), err.fileno())
    t.run()
    t.cancel_and_clean()
    # during: the spawner thread ends what it makes, and the cancel waits for it
    t = raster.SpawnTask(sys.executable, argv, env(), err.fileno())
    th = threading.Thread(target=t.run)
    th.start()
    t.cancel_and_clean()
    th.join(10)
    assert t.done()
    time.sleep(0.2)
    err.close()
    assert fds() == base, (fds(), base)
    if WINDOWS:
        return
    # (no child of ours left: every one was reaped)
    try:
        os.waitpid(-1, os.WNOHANG)
        raise AssertionError("a child is left")
    except ChildProcessError:
        pass


def test_a_failed_creation_closes_what_it_made():
    base = fds()
    for k in range(4):
        try:
            start(WATCHED, fail_after=k)
            raise AssertionError("not refused")
        except OSError as e:
            assert "test fault" in str(e)
    assert fds() == base, (fds(), base)


def test_the_job_ends_what_the_child_started():
    # (Windows: the kill-on-close job; POSIX: the grandchild isn't ours to
    # end, so it is only reported)
    c = start(PARENT)
    line = b""
    while not line.endswith(b"\n"):
        line += os.read(c.rfd, 1)
    g = int(line)
    c.kill_and_reap()
    t0 = time.monotonic()
    while not gone(g) and time.monotonic() - t0 < 5:
        time.sleep(0.02)
    if WINDOWS:
        assert gone(g), "the grandchild outlived the job"
    else:
        print("  grandchild gone with its parent: %s" % gone(g))
        if not gone(g):
            os.kill(g, signal.SIGKILL)


@posix_only
def test_a_start_whose_exec_fails_leaks_no_descriptor():
    # (glibc 2.39's pidfd_spawn leaked its pidfd when the exec failed, on the
    # measured Ubuntu libc; the creation is now posix_spawn, which makes no
    # pidfd, then our own pidfd_open: kept as the regression check)
    d = tempfile.mkdtemp()
    junk = os.path.join(d, "not-a-program")
    with open(junk, "wb") as f:
        f.write(b"\x00\x01\x02 not an executable format")
    os.chmod(junk, 0o755)
    base = fds()
    seen = set()
    for path in [junk] * 20 + [os.path.join(d, "missing")] * 5:
        err = tempfile.TemporaryFile()
        t = raster.SpawnTask(path, [path], {}, err.fileno())
        t.run()
        ob = Ob()
        try:
            t.take_into(ob)
            raise AssertionError("started")
        except OSError as e:
            seen.add(e.args[0])
        err.close()
    assert fds() == base, (fds(), base)
    print("  errors: %s" % sorted(seen))


LOW_FD = r'''
import os, sys, tempfile, threading, time
import sagebrush
from sagebrush._native import raster
# (fds 0, 1 and 2 closed: the stderr file and the pipes take the low numbers,
# so a mapping applied in place would overwrite a later source)
for fd in (0, 1, 2):
    os.close(fd)
err = tempfile.TemporaryFile()
CHILD = "import os\nos.write(2, b'E')\nfds = sorted(int(x) for x in os.listdir('/proc/self/fd'))\nos.write(1, repr(fds).encode() + b'\\n')\nd = os.read(0, 5)\nos.write(1, d)\n"
t = raster.SpawnTask(sys.executable, [sys.executable, "-I", "-S", "-c", CHILD], {"LC_ALL": "C"}, err.fileno())
t.run()
class Ob: pass
ob = Ob()
t.take_into(ob)
c = ob.child
os.write(c.wfd, b"hello")
got = b""
while not got.endswith(b"hello"):
    b = os.read(c.rfd, 64)
    if not b:
        break
    got += b
c.kill_and_reap()
err.seek(0)
r = (err.fileno(), got, err.read())
with open(sys.argv[1], "w") as f:
    f.write(repr(r))
'''


@linux_only
def test_a_parent_without_its_standard_descriptors_gives_the_child_exactly_its_five():
    # (astra2's low-fd gate: the child's 0, 1, 2, 3, 4 are the request pipe,
    # the reply pipe, the stderr file, the kill and life pipes, and nothing
    # else of ours; its stderr is the file, not a pipe)
    import subprocess
    d = tempfile.mkdtemp()
    out = os.path.join(d, "r")
    script = os.path.join(d, "low.py")
    with open(script, "w") as f:
        f.write(LOW_FD)
    p = subprocess.run([sys.executable, script, out], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=60)
    assert p.returncode == 0, p.stderr.decode()[-2000:]
    errfd, got, errtext = eval(open(out).read())
    lines = got.split(b"\n")
    fds_seen = eval(lines[0].decode())
    # (the child's listing opened one more descriptor for itself: 5)
    assert fds_seen in ([0, 1, 2, 3, 4], [0, 1, 2, 3, 4, 5]), fds_seen
    assert lines[1] == b"hello" and errtext == b"E", (got, errtext)
    print("  stderr file was fd %d in the parent; the child's fds %s" % (errfd, fds_seen))


@linux_only
def test_a_pidfd_that_cant_be_opened_keeps_the_pid_owner():
    base = fds()
    c = start(WATCHED, fail_after=10)
    assert not c.has_pidfd and c.state == "running"
    assert c.kill_and_reap(0.2) == 137 and c.state == "reaped" and c.signals_sent == 0
    c.close_io()
    del c
    assert children() == set() and fds() == base, (children(), fds(), base)


@linux_only
def test_waitid_without_p_pidfd_keeps_the_pidfd_for_the_rest():
    c = start(DEAF, fail_after=12)
    assert c.has_pidfd and c.state == "running"
    assert c.kill_and_reap() == -signal.SIGKILL and c.state == "reaped"
    assert children() == set()


@linux_only
def test_a_fault_after_the_creation_ends_and_reaps_the_child():
    base = fds()
    for _ in range(5):
        try:
            start(WATCHED, fail_after=11)
            raise AssertionError("not refused")
        except OSError as e:
            assert "test fault" in str(e)
    assert children() == set() and fds() == base, (children(), fds(), base)


@linux_only
def test_a_child_reaped_before_its_pidfd_is_lost_never_signalled():
    # (the negative control: an outside reap between the creation and
    # pidfd_open; the pid is no longer ours, and nothing is sent to it)
    c = start(QUICK, fail_after=13)
    assert c.poll_exit() and c.state == "lost" and c.returncode is None
    assert c.kill_and_reap() is None and c.signals_sent == 0


@posix_only
def test_a_child_that_exits_at_once_is_reaped_with_its_status():
    err = tempfile.TemporaryFile()
    t = raster.SpawnTask("/bin/sh", ["/bin/sh", "-c", "exit 7"], {}, err.fileno())
    t.run()
    ob = Ob()
    t.take_into(ob)
    c = ob.child
    t0 = time.monotonic()
    while not c.poll_exit():
        assert time.monotonic() - t0 < 10
        time.sleep(0.01)
    assert c.state == "reaped" and c.returncode == 7 and c.signals_sent == 0
    if sys.platform.startswith("linux"):
        assert children() == set()


def test_fifty_children_leave_no_descriptor():
    base = fds()
    for i in range(50):
        c = start(WATCHED if i % 2 else DEAF)
        c.kill_and_reap()
        c.close_io()
        del c
    assert fds() == base, (fds(), base)


@posix_only
def test_the_sigchld_contract_is_checked_before_anything_is_made():
    raster.sigchld_check()
    prev = signal.signal(signal.SIGCHLD, signal.SIG_IGN)
    try:
        base = fds()
        try:
            raster.sigchld_check()
            raise AssertionError("not refused")
        except RuntimeError as e:
            assert "SIG_IGN" in str(e)
        try:
            start(WATCHED)
            raise AssertionError("spawned")
        except OSError as e:
            assert "SIG_IGN" in str(e)
        assert fds() == base
        assert signal.getsignal(signal.SIGCHLD) == signal.SIG_IGN, "the application's state was changed"
    finally:
        signal.signal(signal.SIGCHLD, prev)


@posix_only
def test_a_handler_calling_into_the_busy_handle_is_refused_not_deadlocked():
    c = start(DEAF)
    seen = []

    def h(*a):
        try:
            c.poll_exit()
        except RuntimeError as e:
            seen.append(str(e))
            raise
    prev = signal.signal(signal.SIGALRM, h)
    try:
        signal.setitimer(signal.ITIMER_REAL, 0.005)
        try:
            # (the first slice, 200 ms, outlasts the alarm; the handler runs
            # at the check after it, inside the call)
            c.kill_and_reap(0.2)
            raise AssertionError("the handler's refusal didn't propagate")
        except RuntimeError as e:
            assert "busy" in str(e), e
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, prev)
    assert seen and "busy" in seen[0], seen
    # (the busy mark was cleared by the refused call's exit: the retry works)
    assert c.kill_and_reap() == -signal.SIGKILL and c.state == "reaped"
    assert c.poll_exit()


if __name__ == "__main__":
    names = [n for n in list(globals()) if n.startswith("test_")]
    if WINDOWS:
        names = [n for n in names if not getattr(globals()[n], "posix_only", False)]
    if not sys.platform.startswith("linux"):
        names = [n for n in names if not getattr(globals()[n], "linux_only", False)]
    if "-k" in sys.argv:
        names = [n for n in names if sys.argv[sys.argv.index("-k") + 1] in n]
    for n in names:
        globals()[n]()
        print("ok", n, flush=True)
