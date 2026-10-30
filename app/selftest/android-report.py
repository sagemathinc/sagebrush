"""Judge the Android self-test's report (app/selftest/android-selftest.sh).

    python3 -I app/selftest/android-report.py report.txt [summary.md]

The report is selftest()'s check lines (web/index.html): "ok   <key>[: detail]"
or "FAIL <key>[: detail]", then "all passed" when every check passed.  The
keys are a closed list:
- REQUIRED: each must appear exactly once, as ok;
- REPORTED (the question this job asks: is the page cross-origin isolated in
  Android's WebView, so that Stop keeps the variables?): each must appear
  exactly once, ok or FAIL, and goes verbatim into the summary;
- "no exception" appears only when selftest() threw: that fails.
Any other line (a renamed or new check, garbage) fails: nothing passes
silently.  Exit 0 only if every REQUIRED key is ok.
"""
import sys

REQUIRED = [
    "ready",
    "opened the notebook from disk",
    "ran it: Sage and the engines",
    "Python read a file in the notebook's folder",
    "3D graphics",
    "what Python wrote is in the notebook's folder",
    "saved the notebook with its outputs",
]
REPORTED = [
    "cross-origin isolated (Stop keeps variables)",
    "Stop interrupts a loop",
    "...and keeps the variables",
]
KNOWN = REQUIRED + REPORTED + ["no exception"]


def key_of(rest):
    # (the longest key first: a key may contain ": ", as "ran it: Sage and the engines" does)
    for k in sorted(KNOWN, key=len, reverse=True):
        if rest == k or rest.startswith(k + ": "):
            return k
    return None


def main():
    lines = open(sys.argv[1], encoding="utf-8").read().splitlines()
    summary = sys.argv[2] if len(sys.argv) > 2 else None
    seen, problems = {}, []
    for line in lines:
        if not line.strip() or line == "all passed":
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
    for k in REQUIRED:
        if len(seen.get(k, [])) == 1 and seen[k][0][0] != "ok":
            problems.append(f"required check failed: {seen[k][0][1][:300]}")
    if "no exception" in seen:
        problems.append(f"the self-test threw: {seen['no exception'][0][1][:300]}")
    out = ["### Android self-test (emulator)", "", "The question (reported, not required):", "```"]
    out += [seen[k][0][1] if len(seen.get(k, [])) == 1 else f"(missing) {k}" for k in REPORTED]
    out += ["```", "", "Required checks:", "```"]
    out += [seen[k][0][1] if len(seen.get(k, [])) == 1 else f"(missing) {k}" for k in REQUIRED]
    out += ["```", ""]
    out += ["**FAILED:**"] + [f"- {p}" for p in problems] if problems else ["Every required check passed."]
    text = "\n".join(out) + "\n"
    print(text)
    if summary:
        with open(summary, "a", encoding="utf-8") as f:
            f.write(text)
    sys.exit(1 if problems else 0)


main()
