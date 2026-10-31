"""probe-log.py: the terminal bridge probe's native-log witness.

    python3 -I app/selftest/probe-log.py --desktop STDERR NONCE REPORT
    python3 -I app/selftest/probe-log.py --android LOGCAT PID NONCE REPORT

The app's own log (the desktop app's stderr, read by run.mjs until exit; on
Android a `logcat -d -v threadtime` dump) must show what the self-test's
REPORT says the page did, and nothing from the shell worker.  The grammar is
frozen in the native-checks code packet (probe-grammar.md, r1): app_log logs
"[page] <message>", and the markers are the whole <message>:
  terminal bridge probe: page <nonce>
  terminal bridge probe: page-route:<route> <nonce>
  terminal bridge probe: worker-route:<route> <nonce>
  terminal bridge probe: done <nonce>   (the page's last probe line: after the
      Terminal checks cleaned up their workers, before selftest_report)
The route statuses come from the REPORT's check-2 line:
  ok   the page reaches the app's bridge: nonce=<nonce> routes=<route>:<status>,... (all 5, in order)

The rules (each violation printed; every one is a FAIL):
 1. exactly one check-2 line, ok, with this nonce and a well-formed routes field;
 2. at least one route ok;
 3. the page marker for NONCE exactly once;
 4. each ok route's page-route marker for NONCE exactly once;
 5. no page-route marker for NONCE for any other route;
 6. no line anywhere contains "terminal bridge probe: worker" (any nonce, any pid);
 7. other nonces are ignored for 3-5 (rule 6 still applies);
 8. Android: other pids are ignored for 3-5 and 9 (rule 6 still applies);
 9. the done sentinel for NONCE exactly once, and no probe marker for NONCE
    after it (in the pid's lines on Android).  It shows the capture reached
    the end of the probe; it is not an ordering barrier for other senders.
Exit 0: all hold; 1: a FAIL; 2: bad arguments or an unreadable file; 3: this
script failed.  app/selftest/test-probe-log.sh runs it on fixed inputs."""
import re
import sys

ROUTES = ["tauri-internals-invoke", "tauri-core-invoke", "ipc-postmessage", "webkit-ipc-postmessage", "webview2-postmessage"]
STATUSES = {"ok", "no-native-effect", "unavailable", "failed"}
UUID = r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
CHECK2_NAME = "the page reaches the app's bridge"
CHECK2_OK = re.compile(r"^ok   " + re.escape(CHECK2_NAME) + r": nonce=(" + UUID + r") routes=(\S+)$")
PREFIX = "[page] "
WORKER = "terminal bridge probe: worker"
# (logcat -v threadtime: date time pid tid level tag: message; as logcat-crash.py)
LOGCAT = re.compile(r"^\d\d-\d\d \d\d:\d\d:\d\d\.\d+\s+(\d+)\s+(\d+)\s+([VDIWEFA])\s+(.*?)\s*:\s(.*)$")


class Usage(Exception):
    pass


def read(path):
    try:
        with open(path, encoding="utf-8", errors="replace", newline="") as f:
            return [l.rstrip("\r\n") for l in f.read().split("\n")]
    except OSError as e:
        raise Usage(f"can't read {path}: {e}")


def routes_of(report, nonce, fails):
    """Rule 1: the check-2 line, parsed; None if it doesn't hold."""
    lines = [l for l in report if l[5:].startswith(CHECK2_NAME)]
    if len(lines) != 1:
        fails.append(f"rule 1: {len(lines)} check-2 lines in the report (\"{CHECK2_NAME}\"), need exactly 1")
        return None
    m = CHECK2_OK.match(lines[0])
    if not m:
        fails.append(f"rule 1: check 2 is not an ok line in the grammar: {lines[0][:200]}")
        return None
    if m.group(1) != nonce:
        fails.append(f"rule 1: check 2's nonce {m.group(1)} is not {nonce}")
        return None
    pairs = m.group(2).split(",")
    got = [p.split(":", 1) for p in pairs]
    if [p[0] for p in got] != ROUTES or any(len(p) != 2 or p[1] not in STATUSES for p in got):
        fails.append(f"rule 1: the routes field is not the 5 routes in order with known statuses: {m.group(2)[:200]}")
        return None
    return {r: s for r, s in got}


def messages(log, pid):
    """(message after "[page] ", the raw line) for the lines rules 3-5 count."""
    out = []
    for raw in log:
        if pid is None:
            if raw.startswith(PREFIX):
                out.append(raw[len(PREFIX):])
            continue
        m = LOGCAT.match(raw)
        if m and m.group(1) == pid and m.group(5).startswith(PREFIX):
            out.append(m.group(5)[len(PREFIX):].rstrip("\r"))
    return out


def judge(log, pid, nonce, report):
    fails = []
    routes = routes_of(report, nonce, fails)
    if routes is not None and "ok" not in routes.values():
        fails.append("rule 2: no route is ok in check 2 (no positive)")
    msgs = messages(log, pid)
    n = msgs.count(f"terminal bridge probe: page {nonce}")
    if n != 1:
        fails.append(f"rule 3: the page marker for {nonce} appears {n} times, need 1")
    if routes is not None:
        for r in ROUTES:
            k = msgs.count(f"terminal bridge probe: page-route:{r} {nonce}")
            want = 1 if routes[r] == "ok" else 0
            if k != want:
                fails.append(f"rule {4 if want else 5}: page-route:{r} ({routes[r]}) appears {k} times, need {want}")
    for raw in log:
        if WORKER in raw:
            fails.append(f"rule 6: a worker line: {raw[:200]}")
    done = f"terminal bridge probe: done {nonce}"
    at = [i for i, m in enumerate(msgs) if m == done]
    if len(at) != 1:
        fails.append(f"rule 9: the done sentinel for {nonce} appears {len(at)} times, need 1")
    else:
        later = [m for m in msgs[at[0] + 1:] if m.startswith("terminal bridge probe: ") and m.endswith(" " + nonce)]
        for m in later:
            fails.append(f"rule 9: a probe marker after the done sentinel: {m[:200]}")
    return fails


def main(argv):
    if len(argv) == 5 and argv[1] == "--desktop":
        _, _, log_path, nonce, report_path = argv
        pid = None
    elif len(argv) == 6 and argv[1] == "--android":
        _, _, log_path, pid, nonce, report_path = argv
        if not (pid.isdigit() and int(pid) > 0):
            print(f"FAIL rule 8: the pid {pid!r} is not a positive integer")
            return 1
    else:
        raise Usage("usage: probe-log.py --desktop STDERR NONCE REPORT | --android LOGCAT PID NONCE REPORT")
    if not re.fullmatch(UUID, nonce):
        raise Usage(f"the nonce {nonce!r} is not a lowercase UUID")
    fails = judge(read(log_path), pid, nonce, read(report_path))
    for f in fails:
        print("FAIL " + f)
    if fails:
        return 1
    print(f"ok   the probe's native log: the page and its ok routes once each, no worker line, the done sentinel last (nonce {nonce})")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv))
    except Usage as e:
        print(f"probe-log: {e}")
        sys.exit(2)
    except SystemExit:
        raise
    except BaseException as e:  # (an internal failure is not a verdict)
        print(f"probe-log: internal error: {e!r}")
        sys.exit(3)
