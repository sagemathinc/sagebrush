"""Judge the Android self-test's report (app/selftest/android-selftest.sh).

    python3 -I app/selftest/android-report.py --engine chromium|webkit report.txt [summary.md]

--engine is the engine family the CALLER's platform fixes (android-selftest.sh: chromium, Android's WebView;
ios-selftest.sh: webkit, WKWebView), never read from the report; missing or unknown: a usage error, exit 2.
The Terminal's check 3 ("the shell worker can't reach the app's bridge", web/notebook/selftest-terminal.js)
must report that same engine, and its detail's closed grammar is judged again here with that engine's rule
(chromium: 3 of 3 connect-src violations, every IPC fetch refused; webkit: 0 or 3, the IPC fetches information
only; both: every route unavailable, the own-origin fetch refused while the policy-free control fetched it).

The report is selftest()'s check lines (web/index.html): "ok   <key>[: detail]"
or "FAIL <key>[: detail]", then "all passed" when every check passed.  The
keys are a closed list:
- REQUIRED: each must appear exactly once, as ok;
- REPORTED (the question this job asks: is the page cross-origin isolated in
  Android's WebView, so that Stop keeps the variables?): each must appear
  exactly once, ok or FAIL, and goes verbatim into the summary;
- "no exception" appears only when selftest() threw: that fails.
Then the diagnosis lines, "info <key>: <value>" (web/index.html diagnose()):
- INFO keys, a closed list: each must appear exactly once, with a non-empty
  value; they are facts, never pass or fail, and go verbatim into the
  summary (app/selftest/coi-reading.py reads them).
Any other line (a renamed or new check, garbage) fails: nothing passes
silently.  Exit 0 only if every REQUIRED key is ok.
"""
import re
import sys

REQUIRED = [
    "ready",
    "opened the notebook from disk",
    "ran it: Sage and the engines",
    "Python read a file in the notebook's folder",
    "3D graphics",
    "what Python wrote is in the notebook's folder",
    "saved the notebook with its outputs",
    # (the Terminal's shell worker in the real app: web/notebook/selftest-terminal.js; the native witness of the
    # page's and the worker's bridge markers is probe-log.py's, on the app's log)
    "the shell worker's policy (lib.rs)",
    "the page reaches the app's bridge",
    "the shell worker can't reach the app's bridge",
]
REPORTED = [
    "cross-origin isolated (Stop keeps variables)",
    "Stop interrupts a loop",
    "...and keeps the variables",
]
KNOWN = REQUIRED + REPORTED + ["no exception"]
# (none is a prefix of another)
INFO = [
    "origin",
    "secure-context",
    "top-level",
    "isolated-document",
    "sab-document",
    "coi-policy",
    "kernel-interrupt-shared",
    "kernel-isolated",
    "kernel-sab",
    "fetch-page",
    "fetch-kernel-script",
    "user-agent",
]
INFO_LINE = re.compile(r"info ([a-z-]+): (\S.*)")
ENGINES = ("chromium", "webkit")
CHECK3 = "the shell worker can't reach the app's bridge"
ROUTES = ["tauri-internals-invoke", "tauri-core-invoke", "ipc-postmessage", "webkit-ipc-postmessage", "webview2-postmessage"]
CHECK3_DETAIL = re.compile(
    r"engine=(chromium|webkit|unknown) mode=(all-events|webkit-differential) violations=([0-3]) "
    r"differential=own-origin:([a-z0-9-]+),control:([a-z0-9 -]+) routes=(\S+) "
    r"ipc=ipc-scheme:([a-z0-9-]+),ipc-localhost:([a-z0-9-]+)(\(information\))?")


def check3_problems(line, engine):
    """The Terminal's check 3, ok, judged again with the caller's engine (the grader's conditions)."""
    m = CHECK3_DETAIL.fullmatch(line[len("ok   " + CHECK3 + ": "):])
    if not m:
        return [f"check 3's detail is not the grammar: {line[:300]!r}"]
    eng, mode, n, own, control, routes, ipc1, ipc2, info = m.groups()
    n = int(n)
    out = []
    if eng != engine:
        out.append(f"check 3 reports engine {eng!r}, the platform's is {engine!r}")
    if mode != ("webkit-differential" if engine == "webkit" else "all-events"):
        out.append(f"check 3's mode {mode!r} is not {engine}'s")
    if routes != ",".join(r + ":unavailable" for r in ROUTES):
        out.append(f"check 3: a route is not unavailable: {routes}")
    if own != "refused" or control != "fetched-ok":
        out.append(f"check 3: no differential (own-origin {own}, control {control})")
    if n in (1, 2):
        out.append(f"check 3: {n} of 3 violations (inconsistent)")
    if engine == "chromium" and (n != 3 or ipc1 != "refused" or ipc2 != "refused" or info):
        out.append(f"check 3: chromium needs 3 of 3 violations and every IPC fetch refused (violations {n}, {ipc1}, {ipc2})")
    if engine == "webkit" and not info:
        out.append("check 3: webkit's IPC fetches must be marked information")
    return out


def key_of(rest):
    # (the longest key first: a key may contain ": ", as "ran it: Sage and the engines" does)
    for k in sorted(KNOWN, key=len, reverse=True):
        if rest == k or rest.startswith(k + ": "):
            return k
    return None


def main():
    args = sys.argv[1:]
    engine = None
    if len(args) >= 2 and args[0] == "--engine":
        engine, args = args[1], args[2:]
    if engine not in ENGINES or not 1 <= len(args) <= 2:
        print("usage: android-report.py --engine chromium|webkit report.txt [summary.md]", file=sys.stderr)
        sys.exit(2)
    lines = open(args[0], encoding="utf-8").read().splitlines()
    summary = args[1] if len(args) > 1 else None
    seen, info, problems = {}, {}, []
    for line in lines:
        if not line.strip() or line == "all passed":
            continue
        if line.startswith("info"):
            m = INFO_LINE.fullmatch(line)
            if not m or m.group(1) not in INFO:
                problems.append(f"not a known info line: {line[:200]!r}")
            else:
                info.setdefault(m.group(1), []).append(line)
            continue
        if line.startswith("ok   "):
            status, rest = "ok", line[5:]
        elif line.startswith("FAIL "):
            status, rest = "FAIL", line[5:]
        else:
            problems.append(f"not a check line: {line[:200]!r}")
            continue
        k = key_of(rest)
        if k is None:
            problems.append(f"unknown check (renamed or new?): {line[:200]!r}")
            continue
        seen.setdefault(k, []).append((status, line))
    for k in REQUIRED + REPORTED:
        n = len(seen.get(k, []))
        if n != 1:
            problems.append(f"{k!r}: {n} lines, expected exactly 1")
    for k in INFO:
        n = len(info.get(k, []))
        if n != 1:
            problems.append(f"info {k!r}: {n} lines, expected exactly 1")
    for k in REQUIRED:
        if len(seen.get(k, [])) == 1 and seen[k][0][0] != "ok":
            problems.append(f"required check failed: {seen[k][0][1][:300]}")
    if len(seen.get(CHECK3, [])) == 1 and seen[CHECK3][0][0] == "ok":
        problems += check3_problems(seen[CHECK3][0][1], engine)
    if "no exception" in seen:
        problems.append(f"the self-test threw: {seen['no exception'][0][1][:300]}")
    out = ["### Android self-test (emulator)", "", "The question (reported, not required):", "```"]
    out += [seen[k][0][1] if len(seen.get(k, [])) == 1 else f"(missing) {k}" for k in REPORTED]
    out += ["```", "", "Required checks:", "```"]
    out += [seen[k][0][1] if len(seen.get(k, [])) == 1 else f"(missing) {k}" for k in REQUIRED]
    out += ["```", "", "Diagnosis (facts, not judged; app/selftest/coi-reading.py reads them):", "```"]
    out += [info[k][0][:300] if len(info.get(k, [])) == 1 else f"(missing) info {k}" for k in INFO]
    out += ["```", ""]
    out += ["**FAILED:**"] + [f"- {p}" for p in problems] if problems else ["Every required check passed."]
    text = "\n".join(out) + "\n"
    print(text)
    if summary:
        with open(summary, "a", encoding="utf-8") as f:
            f.write(text)
    sys.exit(1 if problems else 0)


main()
