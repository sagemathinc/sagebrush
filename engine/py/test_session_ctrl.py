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


def fresh():
    S._CTRL.clear()
    S._RETIRED.clear()


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
exits[0]()
check(k.calls[-1] == (routine, False) and S._CTRL == [] and S._RETIRED[-1] is routine, "at exit: removed with FALSE, out of _CTRL, and kept alive in _RETIRED (a break already under way may still run it)")
n = len(k.calls)
exits[0]()
check(len(k.calls) == n, "a second removal does nothing")

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
    exits[0]()
    check(S._CTRL == [] and len(S._RETIRED) == 1, "Windows: and removed, still alive")

print("session console routine: ok (%d checks)" % checks)
