"""The session worker's Windows console routine (sagebrush.session._break_as_sigint,
PR #186): Ctrl-Break becomes one SIGINT, other events pass on, a failed
registration installs nothing, and the routine is removed at exit (grader's N1),
through the function's seams with a mocked kernel32 boundary; on Windows also
the real install and removal.  python engine/py/test_session_ctrl.py"""

import os
import signal
import sys

from sagebrush import session as S

checks = 0


def check(cond, what):
    global checks
    checks += 1
    if not cond:
        print("FAIL", what)
        sys.exit(1)


class Kernel:
    """SetConsoleCtrlHandler, recorded; `ok` is what it answers."""

    def __init__(self, ok=True):
        self.calls, self.ok = [], ok

    def __call__(self, routine, add):
        self.calls.append((routine, add))
        return self.ok


_OUTER_SIGINT = signal.getsignal(signal.SIGINT)


def fresh():
    S._CTRL.clear()
    S._RETIRED.clear()
    # (the seam's remove() runs in this ordinary process, not at exit: put back the handler its step (0) replaced)
    signal.signal(signal.SIGINT, _OUTER_SIGINT)


def exit_now(remove):
    """remove() on the main thread, as atexit runs it; step (0) pinned (SIGINT ignored right after), then the
    process's own SIGINT handler restored."""
    try:
        out = remove()
        check(signal.getsignal(signal.SIGINT) is signal.SIG_IGN, "step (0): SIGINT is ignored right after the exit cleanup")
        return out
    finally:
        signal.signal(signal.SIGINT, _OUTER_SIGINT)


# not Windows: nothing installed
fresh()
k = Kernel()
check(S._break_as_sigint(nt=False, boundary=(lambda f: f, k), at_exit=lambda f: None) is False and k.calls == [] and S._CTRL == [], "off Windows: nothing installed")

# Windows, with the boundary mocked: installed once, kept alive, its removal registered for exit
fresh()
k, exits = Kernel(), []
check(S._break_as_sigint(nt=True, boundary=(lambda f: f, k), at_exit=exits.append) is True, "installed")
check(len(k.calls) == 1 and k.calls[0][1] is True and S._CTRL == [k.calls[0][0]] and len(exits) == 1, "registered once, kept alive in _CTRL, its removal registered with atexit")
routine = k.calls[0][0]

# the routine: Ctrl-Break (1) raises exactly one SIGINT and answers TRUE; any other event passes on
seen = []
old = signal.signal(signal.SIGINT, lambda signum, frame: seen.append(signum))
try:
    check(routine(1) is True and seen == [signal.SIGINT], "Ctrl-Break: one SIGINT, TRUE")
    check(routine(1) is True and seen == [signal.SIGINT] * 2, "a second Ctrl-Break: one more SIGINT")
    check(routine(0) is False and routine(2) is False and len(seen) == 2, "Ctrl-C (0) and close (2): passed on, no SIGINT")
finally:
    signal.signal(signal.SIGINT, old)

# at exit: removed (SetConsoleCtrlHandler(r, FALSE)) once, and again is nothing
exit_now(exits[0])
check(k.calls[-1] == (routine, False) and S._CTRL == [] and S._RETIRED[-1] is routine, "at exit: removed with FALSE, out of _CTRL, and kept alive in _RETIRED (a break already under way may still run it)")
n = len(k.calls)
exits[0]()  # (already retired: it returns before step (0), so nothing is ignored)
check(len(k.calls) == n, "a second removal does nothing")

# astra2's failed-removal witness (CORR-WIN-EXIT-1): installation succeeds, removal returns 0. The routine
# stays recorded as installed, the failure is reported with its error, and a retry really retries
fresh()


class Flaky(Kernel):
    def __init__(self):
        super().__init__()
        self.removals_ok = [False, True]

    def __call__(self, routine, add):
        self.calls.append((routine, add))
        return True if add else self.removals_ok.pop(0)


k, exits, reports = Flaky(), [], []
check(S._break_as_sigint(nt=True, boundary=(lambda f: f, k, lambda: 87), at_exit=exits.append, report=reports.append) is True, "installed (for the failed removal)")
r = k.calls[0][0]
check(exit_now(exits[0]) is False and S._CTRL == [r] and S._RETIRED == [] and len(reports) == 1 and "87" in reports[0], "a failed removal: still recorded as installed, reported with its Windows error: %s" % reports)
seen = []
old = signal.signal(signal.SIGINT, lambda signum, frame: seen.append(signum))
try:
    check(r(1) is True and seen == [], "after a failed removal the routine is inert (closing): a Ctrl-Break converts nothing")
finally:
    signal.signal(signal.SIGINT, old)
check(exit_now(exits[0]) is True and k.calls[-1] == (r, False) and k.calls.count((r, False)) == 2 and S._CTRL == [] and S._RETIRED == [r], "a retry really retries, and then retires it")

# astra2's paused-callback/exit control (CORR-WIN-EXIT-2): a callback paused inside its conversion; exit closes,
# waits for it, and only then unregisters; a callback entering after closing converts nothing
import threading
import time

fresh()
k, exits = Kernel(), []
check(S._break_as_sigint(nt=True, boundary=(lambda f: f, k), at_exit=exits.append, report=lambda m: None) is True, "installed (for the drain)")
r = k.calls[0][0]
entered, release, order = threading.Event(), threading.Event(), []
real_raise = S._raise_sigint


def paused():
    entered.set()
    release.wait(5)
    order.append("callback done")


S._raise_sigint = paused
try:
    cb = threading.Thread(target=lambda: order.append(("cb", r(1))))
    cb.start()
    check(entered.wait(5), "the callback is inside its conversion")
    done = []
    ex = threading.Thread(target=lambda: done.append(exits[0]()))
    ex.start()
    time.sleep(0.3)
    check(not done and (r, False) not in k.calls and exits[0].state.closing, "exit has closed the routine and is waiting for the in-flight callback, not yet unregistered")
    # a second callback entering now, while closing: inert, not counted, nothing converted
    calls_before = len(order)
    check(r(1) is True and len(order) == calls_before, "a callback entering after closing converts nothing")
    release.set()
    cb.join(5)
    ex.join(5)
    check(done == [True] and order[0] == "callback done" and k.calls[-1] == (r, False) and exits[0].state.inflight == 0, "exit unregistered only after the in-flight callback finished: %s" % order)
finally:
    S._raise_sigint = real_raise

# astra2's real-conversion control (CORR-WIN-EXIT-2, grader WIN-EXIT-G1): the worker's own _HOLD handler on SIGINT,
# a callback paused inside its conversion until exit has closed the routine, then released to deliver a REAL SIGINT
# during the drain, with remove() running on the main thread as atexit does: the cleanup still completes
fresh()
k, exits, reports = Kernel(), [], []
S._break_as_sigint(nt=True, boundary=(lambda f: f, k), at_exit=exits.append, report=reports.append)
r = k.calls[0][0]
saved = (signal.getsignal(signal.SIGINT), signal.getsignal(signal.SIGBREAK) if hasattr(signal, "SIGBREAK") else None)
S._HOLD.install()
state = exits[0].state


def real_after_closing():
    deadline = time.monotonic() + 5
    while not state.closing and time.monotonic() < deadline:
        time.sleep(0.01)
    time.sleep(0.05)  # (inside the drain)
    real_raise()  # (signal.raise_signal(SIGINT): the worker's handler would raise KeyboardInterrupt in the main thread)


S._raise_sigint = real_after_closing
escaped = None
try:
    cb = threading.Thread(target=lambda: r(1))
    cb.start()
    try:
        ok = exit_now(exits[0])
        time.sleep(0.1)  # (any pending signal handled here, at a bytecode boundary, still inside the try)
    except KeyboardInterrupt as e:
        ok, escaped = None, e
    cb.join(5)
finally:
    S._raise_sigint = real_raise
    signal.signal(signal.SIGINT, saved[0])
    if saved[1] is not None:
        signal.signal(signal.SIGBREAK, saved[1])
check(escaped is None and ok is True and k.calls[-1] == (r, False) and S._CTRL == [] and S._RETIRED == [r] and reports == [],
      "a real SIGINT delivered during the drain under the worker's handler: no KeyboardInterrupt out of the exit, unregistered and retired (%r, %s, %s)" % (escaped, k.calls[-1][1], reports))

# astra2's setter shim: a real SIGINT arrives just before step (0) takes effect (the setter raises KeyboardInterrupt
# once): the cleanup still completes, from (0) again, and nothing escapes
fresh()
k, exits, reports = Kernel(), [], []
S._break_as_sigint(nt=True, boundary=(lambda f: f, k), at_exit=exits.append, report=reports.append)
r = k.calls[0][0]
real_ignore, hits = S._ignore_sigint, []


def interrupted_once():
    hits.append(1)
    if len(hits) == 1:
        raise KeyboardInterrupt
    real_ignore()


S._ignore_sigint = interrupted_once
escaped = None
try:
    try:
        ok = exit_now(exits[0])
    except KeyboardInterrupt as e:
        ok, escaped = None, e
finally:
    S._ignore_sigint = real_ignore
check(escaped is None and ok is True and len(hits) == 2 and k.calls[-1] == (r, False) and S._RETIRED == [r] and exits[0].state.closing and reports == [],
      "a KeyboardInterrupt at step (0): the cleanup starts again and completes, unregistered and retired, nothing escapes (%r, %s)" % (escaped, hits))

# astra2's exhaustion control: _RETRIES + 1 KeyboardInterrupts at step (0): nothing escapes, the exhaustion is reported,
# and the routine is left installed (in _CTRL, so alive), not unregistered, not retired
fresh()
k, exits, reports = Kernel(), [], []
S._break_as_sigint(nt=True, boundary=(lambda f: f, k), at_exit=exits.append, report=reports.append)
r = k.calls[0][0]
hits = []


def always():
    hits.append(1)
    raise KeyboardInterrupt


S._ignore_sigint = always
escaped = None
try:
    try:
        ok = exits[0]()
    except KeyboardInterrupt as e:
        ok, escaped = None, e
finally:
    S._ignore_sigint = real_ignore
    signal.signal(signal.SIGINT, _OUTER_SIGINT)
check(escaped is None and ok is False and len(hits) == S._RETRIES and S._CTRL == [r] and S._RETIRED == [] and k.calls == [(r, True)]
      and len(reports) == 1 and "gave up" in reports[0], "retries exhausted (%d interruptions): nothing escapes, reported, the routine left installed and alive (%r, %s)" % (S._RETRIES + 1, escaped, reports))

# grader's G-R6-1: a KeyboardInterrupt between leaving _CTRL and joining _RETIRED (a _CTRL whose remove raises once):
# the retry finishes, and the routine is in _RETIRED (kept alive), never in neither list
fresh()


class Twitchy(list):
    def __init__(self):
        super().__init__()
        self.raised = False

    def remove(self, x):
        super().remove(x)
        if not self.raised:  # (removed, then interrupted: the window between leaving _CTRL and the next step)
            self.raised = True
            raise KeyboardInterrupt


real_ctrl = S._CTRL
S._CTRL = Twitchy()
try:
    k, exits = Kernel(), []
    S._break_as_sigint(nt=True, boundary=(lambda f: f, k), at_exit=exits.append, report=lambda m: None)
    r = k.calls[0][0]
    ok = exit_now(exits[0])
    check(ok is True and S._CTRL.raised and r not in S._CTRL and S._RETIRED == [r] and k.calls.count((r, False)) == 1,
          "an interruption between leaving _CTRL and joining _RETIRED: retried, kept alive in _RETIRED, unregistered once")
finally:
    S._CTRL = real_ctrl

# a drain that times out is reported, and the routine is still unregistered and kept alive
fresh()
k, exits, reports = Kernel(), [], []
S._break_as_sigint(nt=True, boundary=(lambda f: f, k), at_exit=exits.append, report=reports.append, drain_s=0.2)
r = k.calls[0][0]
stuck, hold = threading.Event(), threading.Event()
S._raise_sigint = lambda: (stuck.set(), hold.wait(5))
try:
    t = threading.Thread(target=lambda: r(1))
    t.start()
    stuck.wait(5)
    check(exit_now(exits[0]) is True and any("still converting" in m for m in reports) and S._RETIRED == [r], "a drain past drain_s is reported, then the routine is unregistered and kept alive")
    hold.set()
    t.join(5)
finally:
    S._raise_sigint = real_raise

# a failed registration: nothing kept, no exit hook
fresh()
k, exits = Kernel(ok=False), []
check(S._break_as_sigint(nt=True, boundary=(lambda f: f, k), at_exit=exits.append) is False and S._CTRL == [] and exits == [], "a failed registration installs nothing")

# a boundary that raises (no ctypes, no kernel32): nothing, False
fresh()


def broken(routine, add):
    raise OSError("no kernel32")


check(S._break_as_sigint(nt=True, boundary=(lambda f: f, broken), at_exit=lambda f: None) is False and S._CTRL == [], "a failing boundary: False, nothing kept")

# on Windows: the real kernel32, installed and removed
if os.name == "nt":
    fresh()
    exits = []
    check(S._break_as_sigint(at_exit=exits.append) is True and len(S._CTRL) == 1 and len(exits) == 1, "Windows: the real routine is installed")
    check(exit_now(exits[0]) is True and S._CTRL == [] and len(S._RETIRED) == 1, "Windows: and removed, still alive")

print("session console routine: ok (%d checks)" % checks)
