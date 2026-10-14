"""Run a corpus of published MATLAB examples and compare with their printed output.

    python3 matlab-tests/docs.py [--examples FILE] [--out RESULTS.json] [-j N] [name ...]

The examples (code and the output MATLAB printed) are kept outside this
repository: see design/matlab.md.  Each example runs under
`sagebrush --matlab` with SAGEBRUSH_MATLAB_DISPLAY=doc (`x = 1×3` and the
values, no blank lines), and each step's output is compared token by token
(the corpus's whitespace is not MATLAB's).

Results: pass, diff (the first step that differs), missing (a function
Sagebrush lacks) and error.  Examples with figures run too (their pictures
are not compared): "figure" when they run and their text output matches.
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
    r = run1(e)
    if e.get("images") and r["status"] == "pass":
        r["status"] = "figure"
    return r


def run1(e):
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
        # (the CLI's note of a figure it saved is not MATLAB's output)
        got = [l for l in got if not (l.startswith("Saved ") and ".svg" in l) and not l.startswith("<Figure size")]
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
    figs = sum(1 for e in exs if e.get("images"))
    print("%d examples: %d pass, %d diff, %d missing a function, %d error" % (
        len(results), c["pass"] + c["figure"], c["diff"], c["missing"], c["error"]))
    print("without figures: %d of %d pass; with figures: %d of %d run (text output matching)" % (
        c["pass"], len(results) - figs, c["figure"], figs))
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
