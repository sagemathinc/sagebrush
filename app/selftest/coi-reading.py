"""Read the self-test's diagnosis of cross-origin isolation: which readings
its facts are consistent with.  Information only, never a verdict.

    python3 -I app/selftest/coi-reading.py report.txt (--logcat FILE | --no-logcat) [--summary FILE]

report.txt is the self-test's report (web/index.html selftest() and
diagnose()): the check lines and the "info <key>: <value>" lines, whose
grammar android-report.py has already judged.  --logcat FILE is the app's
log on Android (adb logcat), for the debug build's "[localhost]" server lines
and the "[page] start" line that reaches the log the same way; --no-logcat
says there is none (desktop), and the readings that need it say "not
applicable".

Every reading that applies is printed, one line each, "reading <tag>: <text>"
(the tags: incomplete, contradictory, logcat-unknown, logcat-na,
navigation-unverified, isolated, h1, h2, h3, h4, policy, not-distinguished);
none of them excludes another, and each says "consistent with", never
"caused by".  Exit 0, or 2 for a usage error.
"""
import json
import re
import sys

COI_CHECK = "cross-origin isolated (Stop keeps variables)"
CRITICAL = ["origin", "secure-context", "top-level", "isolated-document", "sab-document", "coi-policy",
            "kernel-interrupt-shared", "kernel-isolated", "kernel-sab", "fetch-page", "fetch-kernel-script"]
FETCHES = {"fetch-page": "?sb-diag=1", "fetch-kernel-script": "/sagebrush-worker.js?sb-diag=2"}
ORIGIN = re.compile(r'"http://127\.0\.0\.1:[0-9]+"')


def usage():
    print(__doc__.strip().splitlines()[2].strip(), file=sys.stderr)
    sys.exit(2)


def parse_args(argv):
    if len(argv) < 2:
        usage()
    report, logcat, summary, rest = argv[0], None, None, argv[1:]
    mode = None
    while rest:
        a = rest.pop(0)
        if a == "--logcat" and rest:
            mode, logcat = "logcat", rest.pop(0)
        elif a == "--no-logcat":
            mode = "none"
        elif a == "--summary" and rest:
            summary = rest.pop(0)
        else:
            usage()
    if mode is None:
        usage()
    return report, mode, logcat, summary


def main():
    report, mode, logcat_path, summary = parse_args(sys.argv[1:])
    lines = open(report, encoding="utf-8").read().splitlines()
    info, coi_check = {}, None
    for line in lines:
        m = re.fullmatch(r"info ([a-z-]+): (.*)", line)
        if m:
            info.setdefault(m.group(1), []).append(m.group(2))
        elif line.startswith(("ok   ", "FAIL ")) and line[5:].split(": ")[0] == COI_CHECK:
            coi_check = line[:4].strip()
    readings = []

    def say(tag, text):
        readings.append(f"reading {tag}: {text}")

    # (a value is usable when it is there once, not an error, timeout or
    # placeholder, and not truncated)
    incomplete, val = [], {}
    for k in CRITICAL:
        v = info.get(k, [])
        if len(v) != 1:
            incomplete.append(f"{k} ({len(v)} lines)")
        elif v[0].startswith("error:") or v[0] == "timeout" or "...(truncated " in v[0]:
            incomplete.append(f"{k} ({v[0][:80]})")
        else:
            val[k] = v[0]
    # (a fetch is evidence about the resource asked for only if it answered
    # 200, unredirected, at that URL)
    fetch = {}
    for k, want in FETCHES.items():
        if k not in val:
            continue
        try:
            o = json.loads(val[k])
        except ValueError:
            incomplete.append(f"{k} (not JSON)")
            continue
        path_ok = o.get("url", "").endswith(want) if want.startswith("?") else o.get("url") == want
        if o.get("status") != 200 or o.get("ok") is not True or o.get("redirected") is not False or not path_ok:
            incomplete.append(f"{k} (status {o.get('status')}, redirected {o.get('redirected')}, url {o.get('url')!r})")
        else:
            fetch[k] = o
    if incomplete:
        say("incomplete", "data incomplete for " + "; ".join(incomplete) + ": fix the instrumentation before reading those")

    doc = val.get("isolated-document")
    if doc in ("true", "false") and coi_check in ("ok", "FAIL") and (doc == "true") != (coi_check == "ok"):
        say("contradictory", f"isolated-document is {doc} but the check line says {coi_check}: no reading from them")

    # the server's log (Android)
    log_ok, page_logged = False, None
    if mode == "none":
        say("logcat-na", "no app log here (desktop): the server-log readings are not applicable")
    else:
        log = open(logcat_path, encoding="utf-8", errors="replace").read().splitlines()
        sentinel = any("[localhost] logger start" in l for l in log)
        control = any("[page] start" in l for l in log)
        if not (sentinel and control):
            say("logcat-unknown", f"UNKNOWN: Rust stderr not seen in logcat (logger start: {sentinel}, [page] start: {control})")
        else:
            log_ok = True
            reqs = [l for l in log if re.search(r"\[localhost\] #[0-9]+ ", l)]
            capped = any("[localhost] cap reached" in l for l in log)
            page = [l for l in reqs if "diag=no" in l and re.search(r'url="/(index\.html)?(\?[^"]*)?"', l)]
            page_logged = bool(page)
            nav = [l for l in reqs if "dest=document" in l and "mode=navigate" in l]
            if not nav:
                first = page[0][page[0].index("#"):][:160] if page else "none logged" + (" (cap reached)" if capped else "")
                say("navigation-unverified", f"navigation delivery unverified: the server log has no request role; the first unmarked request for the page: {first}")

    # the preconditions
    pre = []
    if "origin" in val and not ORIGIN.fullmatch(val["origin"]):
        pre.append(f"origin {val['origin']}")
    for k in ("secure-context", "top-level"):
        if val.get(k) == "false":
            pre.append(f"{k} false")
    if pre:
        say("h3", "consistent with H3 (a precondition): " + ", ".join(pre))

    # the server's headers, from the fetches that count
    wrong = [f"{k}: COOP={o.get('COOP')!r} COEP={o.get('COEP')!r}" for k, o in fetch.items()
             if o.get("COOP") != "same-origin" or o.get("COEP") != "require-corp"]
    if wrong:
        say("h1", "consistent with H1 (the server's headers): " + "; ".join(wrong))

    if val.get("coi-policy") == "false":
        say("policy", "consistent with a policy restriction: the permission policy does not allow cross-origin-isolated")

    if doc == "true" and val.get("kernel-isolated") == "true":
        say("isolated", "isolated: the document and the kernel are cross-origin isolated")
    if doc == "true" and val.get("kernel-isolated") == "false":
        say("h4", "kernel discrepancy (H4): the document is isolated, the kernel is not; to investigate, no fix follows from this")
    preconditions_seen = ("origin" in val and ORIGIN.fullmatch(val["origin"]) and val.get("secure-context") == "true"
                          and val.get("top-level") == "true")
    if doc == "false" and preconditions_seen and len(fetch) == 2 and not wrong and log_ok and page_logged:
        say("h2", "consistent with H2 (an embedder, configuration or policy restriction): the expected origin, a secure top-level context, the exact headers on both fetches, the page request logged with them set, and the document not isolated; the headers' delivery to the document itself is callback-verified only")

    decided = {"isolated", "h1", "h2", "h3", "h4", "policy", "contradictory"}
    if not any(r.split(":")[0].split()[1] in decided for r in readings):
        say("not-distinguished", "not distinguished by these observations")

    text = "\n".join(readings) + "\n"
    print(text, end="")
    if summary:
        with open(summary, "a", encoding="utf-8") as f:
            f.write("Readings of the diagnosis (consistent with, not caused by):\n```\n" + text + "```\n\n")


main()
