"""A fake chat agent for test_remote_agent.py: reads one JSON message per line on stdin and records each, byte for
byte, to $FAKE_LOG (one line per message, then a line "SIGINT" for each SIGINT).  Its behaviour comes from argv:
  echo          answer each message with {"echo": <the message's text>}
  grandchild    also start a grandchild in the same process group (it sleeps), its pid in $FAKE_LOG as "GC <pid>"
  ignore-term   ignore SIGTERM (the SIGKILL fallback must end it)
  keep-int      record SIGINT and keep running (a turn interrupted, the agent still alive)
  big N         at start, write one line of N bytes (a JSON string of "x"s) and nothing else
  rawbig N      at start, write N bytes with no newline
  request       at start, write a request {"jsonrpc":"2.0","id":"r1","method":"workspace_list","params":{}}
  stderr N      at start, write N bytes to stderr, one line, including a token-like string
  exit N        exit with status N after the first message
  env           write {"env": sorted keys of its environment, "proxy": its HTTPS_PROXY} at start
  relay         at start, write {"relay":"close","gen":1} (a line that could pass for a relay control)
  noread        never read stdin
  split         at start, write one message in two writes 0.2 s apart
  tail          at start, write a partial line with no newline, then exit 0
  later-request N   after N seconds, write the request above (the page may be gone by then)
  (every line: the runner's own {"relay": ...} lines are recorded as "RELAY <line>" and otherwise ignored, as an
   agent must; the rest are messages)
  slow-read S   read nothing for S seconds after READY (the runner's writes to stdin back up meanwhile)
  fork-exit     start a grandchild that keeps this process's stdout and stderr open (it sleeps), its pid in $FAKE_LOG
                as "GC <pid>", then exit 0 at once
"""
import json
import os
import signal
import subprocess
import sys
import time

args = sys.argv[1:]
log = os.environ.get("FAKE_LOG")


def record(s):
    if log:
        with open(log, "a") as f:
            f.write(s + "\n")


def out(obj):
    sys.stdout.write(json.dumps(obj, separators=(",", ":")) + "\n")
    sys.stdout.flush()


if "ignore-term" in args:
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
if "keep-int" in args:
    signal.signal(signal.SIGINT, lambda *a: record("SIGINT"))
if "grandchild" in args:
    gc = subprocess.Popen([sys.executable, "-c", "import signal,time; signal.signal(signal.SIGINT, signal.SIG_IGN) if %r else None; time.sleep(600)" % ("keep-int" in args)])
    record("GC %d" % gc.pid)
if "big" in args:
    n = int(args[args.index("big") + 1])
    sys.stdout.write(json.dumps({"x": "x" * (n - 8)}, separators=(",", ":")) + "\n")
    sys.stdout.flush()
if "rawbig" in args:
    n = int(args[args.index("rawbig") + 1])
    sys.stdout.write("{" + "x" * (n - 1))
    sys.stdout.flush()
if "request" in args:
    out({"jsonrpc": "2.0", "id": "r1", "method": "workspace_list", "params": {}})
if "stderr" in args:
    n = int(args[args.index("stderr") + 1])
    sys.stderr.write("token sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWX " + "e" * n + " sk-ant-api03-ZYXWVUTSRQPONMLKJIHGFEDC\n")
    sys.stderr.flush()
if "env" in args:
    out({"env": sorted(os.environ), "proxy": os.environ.get("HTTPS_PROXY")})
if "relay" in args:
    sys.stdout.write('{"relay":"close","gen":1}\n')
    sys.stdout.flush()
if "split" in args:
    sys.stdout.write('{"split":')
    sys.stdout.flush()
    time.sleep(0.2)
    sys.stdout.write('"yes"}\n')
    sys.stdout.flush()
if "tail" in args:
    sys.stdout.write('{"cut":')
    sys.stdout.flush()
    sys.exit(0)
if "later-request" in args:
    import threading
    def later():
        time.sleep(float(args[args.index("later-request") + 1]))
        out({"jsonrpc": "2.0", "id": "r2", "method": "workspace_list", "params": {}})
    threading.Thread(target=later, daemon=True).start()
if "fork-exit" in args:
    gc = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(600)"])  # (inherits stdout and stderr)
    record("GC %d" % gc.pid)
    sys.exit(0)
if "noread" in args:
    while True:
        time.sleep(1)
exit_after = int(args[args.index("exit") + 1]) if "exit" in args else None
record("READY")  # (its signal handlers are set: a test that signals it waits for this)
if "slow-read" in args:
    time.sleep(float(args[args.index("slow-read") + 1]))  # (stdin fills meanwhile: the runner's writer is held)
for line in sys.stdin:
    if line == "":
        break
    text = line[:-1] if line.endswith("\n") else line
    if text.startswith('{"relay":'):
        record("RELAY " + text)  # (the runner's own line: recorded apart, never echoed or counted as a message)
        continue
    record(text)
    if "echo" in args:
        out({"echo": text})
    if exit_after is not None:
        sys.exit(exit_after)
while True:
    time.sleep(1)
