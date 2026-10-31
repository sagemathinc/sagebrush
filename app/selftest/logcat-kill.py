"""logcat-kill.py LOGCAT PACKAGE PID: was the app's process PID killed by the
system because something it depends on died?  For app/selftest/android-release-start.sh,
when the app's process is gone: it names that case instead of the generic
"not the same process" (a system kill, not a crash: the check still fails).

The one line it recognises is ActivityManager's, in a `logcat -d -v threadtime`
dump, for exactly this PACKAGE (not a sub-process) and this PID:
  ActivityManager: Killing <PID>:<PACKAGE>/<uid> (adj <n>): depends on provider <provider> in dying proc <process> ...
seen on the emulator when Google Play services' persistent process dies under
the app (its FontsProvider): runs 41078076607 and 41145830456, Oct 30.

Exit 0: found (prints "killed by the system (dependency died): ..."); 1: not
found (prints "no system kill ..."); 2: the dump can't be read or has no
threadtime lines, or the arguments are wrong, so it can't be judged; 3: this
script failed.  app/selftest/test-logcat-crash.sh runs it on fixed dumps."""
import re
import sys

LINE = re.compile(r"^\d\d-\d\d \d\d:\d\d:\d\d\.\d+\s+(\d+)\s+(\d+)\s+([VDIWEFA])\s+(.*?)\s*:\s(.*)$")
KILL = re.compile(r"^Killing (\d+):([^/\s]+)/\S+ \(adj -?\d+\): depends on provider (\S+) in dying proc (\S+)")


def main(path, package, pid):
    if not pid.isdigit():
        print(f"logcat-kill: the pid {pid!r} is not a number")
        return 2
    try:
        text = open(path, encoding="utf-8", errors="replace").read()
    except OSError as e:
        print(f"logcat-kill: can't read {path}: {e}")
        return 2
    parsed = 0
    for raw in text.splitlines():
        m = LINE.match(raw.rstrip("\r"))
        if not m:
            continue
        parsed += 1
        if m.group(4) != "ActivityManager":
            continue
        k = KILL.match(m.group(5))
        if k and k.group(1) == pid and k.group(2) == package:
            print(f"killed by the system (dependency died): provider {k.group(3)} in dying proc {k.group(4)} ({raw.split()[0]} {raw.split()[1]})")
            return 0
    if parsed == 0:
        print(f"logcat-kill: no threadtime lines in {path}, so it can't be judged")
        return 2
    print(f"no system kill of {package} pid {pid} for a dying dependency ({parsed} log lines)")
    return 1


if __name__ == "__main__":
    try:
        if len(sys.argv) != 4:
            print("usage: logcat-kill.py LOGCAT PACKAGE PID")
            sys.exit(2)
        sys.exit(main(*sys.argv[1:]))
    except SystemExit:
        raise
    except BaseException as e:  # (an internal failure is not a verdict)
        print(f"logcat-kill: internal error: {e!r}")
        sys.exit(3)
