"""logcat-crash.py LOGCAT PACKAGE PID: does a `logcat -d -v threadtime` dump
show the app crashing?  For app/selftest/android-release-start.sh (the release
APK on the emulator: R8 or LTO removing something reached only through JNI or
reflection shows up here, not in the debug self-test).

- A crash of the PACKAGE, in any process of it (a restarted one has another
  pid): an AndroidRuntime "Process: <name>, PID: <n>" line, which Android
  writes only in a FATAL EXCEPTION report, whose name is PACKAGE or
  PACKAGE:<sub>.  Another app's crash on the emulator is not ours.
- A native crash of the PACKAGE (a SIGSEGV in libsagebrush_app_lib.so, say):
  the tombstone that debuggerd writes to logcat under the DEBUG tag names the
  process as ">>> <name> <<<", with name PACKAGE or PACKAGE:<sub>.
- In the app's own process (PID): UnsatisfiedLinkError, ClassNotFoundException,
  NoSuchMethodError, NoSuchFieldError, even when caught and only logged.

Exit 0: none (prints "ok: ..."); 1: found (prints each line); 2: the dump
can't be read or has no threadtime lines, so it can't be judged.
app/selftest/test-logcat-crash.sh runs it on fixed dumps."""
import re
import sys

LINE = re.compile(r"^\d\d-\d\d \d\d:\d\d:\d\d\.\d+\s+(\d+)\s+(\d+)\s+([VDIWEFA])\s+(.*?)\s*:\s(.*)$")
PROCESS = re.compile(r"^Process: ([^,\s]+), PID: (\d+)")
TOMBSTONE = re.compile(r">>> (\S+) <<<")
ERRORS = re.compile(r"\b(UnsatisfiedLinkError|ClassNotFoundException|NoSuchMethodError|NoSuchFieldError)\b")


def main(path, package, pid):
    if not pid.isdigit():
        print(f"logcat-crash: the pid {pid!r} is not a number")
        return 2
    try:
        text = open(path, encoding="utf-8", errors="replace").read()
    except OSError as e:
        print(f"logcat-crash: can't read {path}: {e}")
        return 2
    parsed = 0
    found = []
    for raw in text.splitlines():
        m = LINE.match(raw.rstrip("\r"))
        if not m:
            continue
        parsed += 1
        line_pid, tag, msg = m.group(1), m.group(4), m.group(5)
        if tag == "AndroidRuntime":
            p = PROCESS.match(msg)
            if p and (p.group(1) == package or p.group(1).startswith(package + ":")):
                found.append(f"crash of {p.group(1)} (pid {p.group(2)}): {raw}")
        if tag == "DEBUG":
            t = TOMBSTONE.search(msg)
            if t and (t.group(1) == package or t.group(1).startswith(package + ":")):
                found.append(f"native crash of {t.group(1)}: {raw}")
        if line_pid == pid and ERRORS.search(msg):
            found.append(f"in the app's process {pid}: {raw}")
    if parsed == 0:
        print(f"logcat-crash: no threadtime lines in {path}, so it can't be judged")
        return 2
    if found:
        print("FAIL: the app crashed or failed to link:")
        for f in found:
            print("  " + f)
        return 1
    print(f"ok: no crash of {package} and no link/class errors in pid {pid} ({parsed} log lines)")
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 4:
        print("usage: logcat-crash.py LOGCAT PACKAGE PID")
        sys.exit(2)
    sys.exit(main(*sys.argv[1:]))
