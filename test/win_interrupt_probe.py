"""What interrupts a blocked computation in a child made the way sagebrush's
session makes its worker (engine/py/python/sagebrush/session.py: on Windows,
CREATE_NEW_PROCESS_GROUP, SIGINT and SIGBREAK raising KeyboardInterrupt), for
the follow-up "Windows cancel of a blocking sleep restarts instead of
interrupting" (test_mcp's cancelling, pypi run 40250674281).  A probe: it
prints a table and changes nothing.

For each way of asking (below) and each workload (time.sleep(30), an Event's
wait(30), a busy loop), it reports whether the child raised KeyboardInterrupt
and how soon after the ask, or that it didn't within 8 s.
  break            the parent sends CTRL_BREAK_EVENT (SIGINT elsewhere): what session.py does
  break+handler    the same, the child having a console control handler that raises SIGINT in its thread
  break+main       the same, that handler calling _thread.interrupt_main()
  thread-raise     a thread of the child calls signal.raise_signal(SIGINT)
  thread-main      a thread of the child calls _thread.interrupt_main()

    python test/win_interrupt_probe.py
"""
import os
import signal
import subprocess
import sys
import time

CHILD = r'''
import os, signal, sys, threading, time, _thread
how, work = sys.argv[1], sys.argv[2]
def handler(signum, frame):
    raise KeyboardInterrupt
for n in ("SIGINT", "SIGBREAK"):
    if hasattr(signal, n):
        signal.signal(getattr(signal, n), handler)
keep = []
if how in ("break+handler", "break+main") and os.name == "nt":
    import ctypes
    from ctypes import wintypes
    ROUTINE = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.DWORD)
    def on_ctrl(event):
        if event == 1:  # CTRL_BREAK_EVENT
            if how == "break+handler":
                signal.raise_signal(signal.SIGINT)
            else:
                _thread.interrupt_main()
            return True
        return False
    r = ROUTINE(on_ctrl)
    keep.append(r)
    k = ctypes.WinDLL("kernel32", use_last_error=True)
    k.SetConsoleCtrlHandler.argtypes = (ROUTINE, wintypes.BOOL)
    k.SetConsoleCtrlHandler.restype = wintypes.BOOL
    if not k.SetConsoleCtrlHandler(r, True):
        print("NOHANDLER", ctypes.get_last_error(), flush=True)
def poke():
    sys.stdin.readline()
    if how == "thread-raise":
        signal.raise_signal(signal.SIGINT)
    elif how == "thread-main":
        _thread.interrupt_main()
threading.Thread(target=poke, daemon=True).start()
print("READY", flush=True)
t0 = time.monotonic()
try:
    if work == "sleep":
        time.sleep(30)
    elif work == "event":
        threading.Event().wait(30)
    else:
        while time.monotonic() - t0 < 30:
            pass
    print("RETURNED", flush=True)
except KeyboardInterrupt:
    print("KI", flush=True)
'''

HOWS = ["break", "break+handler", "break+main", "thread-raise", "thread-main"]
WORKS = ["sleep", "event", "busy"]


def one(how, work):
    flags = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0) if os.name == "nt" else 0
    p = subprocess.Popen([sys.executable, "-c", CHILD, how, work], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, creationflags=flags)
    try:
        first = p.stdout.readline().strip()
        if first != "READY":
            return "no start (%s)" % first
        time.sleep(1.0)
        t0 = time.monotonic()
        if how.startswith("break"):
            p.send_signal(signal.CTRL_BREAK_EVENT if os.name == "nt" else signal.SIGINT)
        else:
            p.stdin.write("go\n")
            p.stdin.flush()
        try:
            out, _ = p.communicate(timeout=8)
        except subprocess.TimeoutExpired:
            return "NOT interrupted within 8 s"
        dt = time.monotonic() - t0
        last = (out.strip().splitlines() or ["(nothing)"])[-1]
        return "%s after %.2f s (exit %s)" % ("KeyboardInterrupt" if last == "KI" else last, dt, p.returncode)
    finally:
        if p.poll() is None:
            p.kill()
            p.wait()


def main():
    print("python %s on %s (%s)" % (sys.version.split()[0], sys.platform, os.name))
    for how in HOWS:
        for work in WORKS:
            print("%-14s %-6s %s" % (how, work, one(how, work)), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
