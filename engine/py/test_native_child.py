"""The raster child's native process handle and its creation (#157 simpler
path: engine/py/src/child.rs), POSIX.

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


class Ob:
    pass


def fds():
    return len(os.listdir("/proc/self/fd")) if os.path.isdir("/proc/self/fd") else len(os.listdir("/dev/fd"))


def start(code, fail_after=None):
    """A child made the way _raster_child makes one: a SpawnTask run on
    another thread (the spawner), then taken into an object."""
    err = tempfile.TemporaryFile()
    t = raster.SpawnTask(sys.executable, [sys.executable, "-I", "-S", "-c", code], {"LC_ALL": "C"}, err.fileno(), fail_after)
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
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return True
    return False


def test_the_kill_pipe_ends_a_watched_child_without_a_signal():
    c = start(WATCHED)
    pid = c.pid
    print("  pidfd: %s" % c.has_pidfd)
    t0 = time.monotonic()
    # (a slice long enough that a slow VM's watchdog isn't overtaken by the
    # SIGKILL fallback: the exit itself ends the wait at once)
    code = c.kill_and_reap(0.2)
    dt = time.monotonic() - t0
    assert code == 137 and c.state == "reaped" and c.signals_sent == 0, (code, c.state, c.signals_sent)
    assert dt < 0.25 and gone(pid), dt
    # (reaped is terminal: nothing more is ever sent)
    assert c.kill_and_reap() == 137 and c.signals_sent == 0


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
    t = raster.SpawnTask(sys.executable, argv, {}, err.fileno())
    t.cancel_and_clean()
    t.run()
    ob = Ob()
    try:
        t.take_into(ob)
        raise AssertionError("taken")
    except RuntimeError:
        pass
    # after it ran, before it was taken: ended and reaped by the cancel
    t = raster.SpawnTask(sys.executable, argv, {}, err.fileno())
    t.run()
    t.cancel_and_clean()
    # during: the spawner thread ends what it makes, and the cancel waits for it
    t = raster.SpawnTask(sys.executable, argv, {}, err.fileno())
    th = threading.Thread(target=t.run)
    th.start()
    t.cancel_and_clean()
    th.join(10)
    assert t.done()
    time.sleep(0.2)
    err.close()
    assert fds() == base, (fds(), base)
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


def test_fifty_children_leave_no_descriptor():
    base = fds()
    for i in range(50):
        c = start(WATCHED if i % 2 else DEAF)
        c.kill_and_reap()
        c.close_io()
        del c
    assert fds() == base, (fds(), base)


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
    if sys.platform == "win32":
        print("n/a on Windows (child.rs is POSIX)")
        sys.exit(0)
    names = [n for n in list(globals()) if n.startswith("test_")]
    if "-k" in sys.argv:
        names = [n for n in names if sys.argv[sys.argv.index("-k") + 1] in n]
    for n in names:
        globals()[n]()
        print("ok", n, flush=True)
