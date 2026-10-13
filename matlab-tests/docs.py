"""Run the examples of MATLAB's Function Reference and compare with their documented output.

    python3 matlab-tests/docs.py [--examples FILE] [--out RESULTS.json] [-j N] [name ...]

The examples (code and the output MATLAB printed, in the documentation's
layout) are extracted from MathWorks' PDF documentation, which is not part
of this repository: see design/matlab.md.  Each example runs under
`sagebrush --matlab` with SAGEBRUSH_MATLAB_DISPLAY=doc (the documentation's
layout: `x = 1×3` and the values, no blank lines), and each step's output
is compared token by token (whitespace is the PDF's, not MATLAB's).

Results: pass, diff (the first step that differs), missing (a function
Sagebrush lacks), error, and skipped (examples with figures).
"""
import json, os, re, subprocess, sys, tempfile, concurrent.futures as cf
from collections import Counter

HERE = os.path.dirname(os.path.abspath(__file__))
CLI = os.path.join(os.path.dirname(HERE), "dist", "src", "cli.js")
args = sys.argv[1:]


def opt(name, default):
    if name in args:
        i = args.index(name)
        v = args[i + 1]
        del args[i:i + 2]
        return v
    return default


EXAMPLES = opt("--examples", os.environ.get("MATLAB_DOC_EXAMPLES", "/scratch/mwdoc/examples.jsonl"))
OUT = opt("--out", "/scratch/mwdoc/results.json")
JOBS = int(opt("-j", "12"))
names = args
MARK = "@@SAGEBRUSH-STEP@@"


def norm(lines):
    # (the documentation writes some headers as the Live Editor does: "1×3 string", "2×1 cell")
    s = " ".join(" ".join(lines).split())
    # (the documentation writes a common scale factor as the Live Editor does: 10^3 ×)
    s = re.sub(r"1\.0e([+-])0*(\d+) \*", lambda m: "10^%s%s ×" % ("-" if m.group(1) == "-" else "", m.group(2)), s)
    return s.replace(" string array", " string").replace(" cell array", " cell")


def run(e):
    if e.get("images"):
        return {"status": "skipped"}
    code = []
    for s in e["steps"]:
        code.append(s["code"])
        code.append("fprintf('%s\\n');" % MARK)
    with tempfile.TemporaryDirectory() as d:
        f = os.path.join(d, "example.m")
        open(f, "w").write("\n".join(code) + "\n")
        try:
            p = subprocess.run(["node", CLI, "--matlab", f], cwd=d, capture_output=True, timeout=60,
                               env=dict(os.environ, SAGEBRUSH_MATLAB_DISPLAY="doc"))
        except subprocess.TimeoutExpired:
            return {"status": "error", "why": "timeout"}
    out = p.stdout.decode(errors="replace")
    err = p.stderr.decode(errors="replace")
    parts = out.split(MARK + "\n")
    for k, s in enumerate(e["steps"]):
        if k >= len(parts) - 1:
            m = re.search(r"Unrecognized function or variable '(\w+)'", err)
            if m and not re.search(r"\b%s\s*=" % re.escape(m.group(1)), "\n".join(x["code"] for x in e["steps"])):
                return {"status": "missing", "why": m.group(1), "step": k}
            first = (err.strip().split("\n") or [""])[0][:200]
            return {"status": "error", "why": first, "step": k}
        got = parts[k].split("\n")
        if norm(got) != norm(s["out"]):
            return {"status": "diff", "step": k, "want": s["out"][:12], "got": got[:12]}
    return {"status": "pass"}


def main():
    exs = [json.loads(l) for l in open(EXAMPLES)]
    if names:
        exs = [e for e in exs if any(n == e["func"] or n in e["func"].split(", ") for n in names)]
    with cf.ThreadPoolExecutor(JOBS) as ex:
        results = list(ex.map(run, exs))
    for e, r in zip(exs, results):
        r["func"] = e["func"]
        r["title"] = e["title"]
        r["page"] = e["page"]
    json.dump(results, open(OUT, "w"), indent=1)
    c = Counter(r["status"] for r in results)
    ran = len(results) - c["skipped"]
    print("%d examples: %d pass, %d diff, %d missing a function, %d error, %d skipped (figures)" % (
        len(results), c["pass"], c["diff"], c["missing"], c["error"], c["skipped"]))
    if ran:
        print("pass rate of those run: %.1f%%" % (100 * c["pass"] / ran))
    miss = Counter(r["why"] for r in results if r["status"] == "missing")
    print("most wanted functions:", ", ".join("%s (%d)" % kv for kv in miss.most_common(40)))
    if names:
        for r in results:
            if r["status"] not in ("pass", "skipped"):
                print("--", r["func"], "|", r["title"], "p.%d" % r["page"], r["status"], r.get("why", ""))
                if r["status"] == "diff":
                    print("   want:", norm(r["want"])[:300])
                    print("   got: ", norm(r["got"])[:300])


main()
