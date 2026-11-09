"""Sprig's oracle, Mathics3, run as a black box (design/sprig-mvp.md §2, §7.1).

    python3 oracle.py MATHICS cases.json > results.json

Each case runs in a fresh Mathics3 process: the case's text is evaluated with
ToExpression (statement by statement; the result is the last one's), inside
CheckAbort so an aborted evaluation records $Aborted, and the process prints
marked lines around it. What a case recorded:

- "result":   the result's InputForm text;
- "fullform": the result's FullForm text;
- "output":   everything printed while it ran, Print output and messages, in order;
- "messages": the lines of "output" that are messages ("Tag::name: text").

Any nonzero exit of the oracle, for a case, `--version` or the limits probe,
is refused: oracle.py exits 1 and prints nothing, so run.py records nothing.

Every run also prints the oracle's environment record (the same in every run):
Mathics3's version line and its dependencies' versions (`--version`), the heads
that are Orderless, and the language's limits as the oracle sets them. Nothing
here reads or depends on Mathics3's source: only its printed output.
"""
import concurrent.futures as cf
import json
import os
import re
import subprocess
import sys

MARK = "@@@SPRIG@@@"
# (the exact arguments every oracle run uses, after the program's path; PROVENANCE.json records them)
ARGS = ["-q", "--no-readline", "--colors", "NoColor"]
MESSAGE = re.compile(r"^[A-Za-z$][A-Za-z0-9$`]*::[A-Za-z0-9$]+: ")
ORDERLESS_PROBE = ["Plus", "Times", "Max", "Min", "GCD", "LCM", "Xor", "And", "Or", "Equal", "Union"]


def quote(s):
    return '"' + s.replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n") + '"'


def program(code):
    probe = "{" + ", ".join(ORDERLESS_PROBE) + "}"
    return "\n".join([
        'Print["%s BEGIN"]; $sbR = CheckAbort[ToExpression[%s], $Aborted];' % (MARK, quote(code.rstrip("\n"))),
        'Print["%s RESULT ", ToString[InputForm[$sbR]]];' % MARK,
        'Print["%s FULLFORM ", ToString[FullForm[$sbR]]];' % MARK,
        'Print["%s ORDERLESS ", ToString[InputForm[Select[%s, MemberQ[Attributes[#], Orderless] &]]]];' % (MARK, probe),
        'Print["%s END"];' % MARK,
        "",
    ])


def oracle(argv, what, **kw):
    """Run the oracle; any nonzero exit is refused, whatever it printed."""
    p = subprocess.run(argv, capture_output=True, text=True, timeout=600, **kw)
    if p.returncode != 0:
        raise SystemExit("the oracle exited %d (%s): nothing is recorded\n%s" % (p.returncode, what, p.stderr[-2000:]))
    return p


def run_case(mathics, case):
    p = oracle([mathics] + ARGS, "case %s#%s" % (case["file"], case["id"]), input=program(case["code"]))
    lines = p.stdout.split("\n")
    # (the CLI echoes its prompt, "In[n]:= ", before each input line's first output)
    lines = [re.sub(r"^In\[\d+\]:= ", "", l) for l in lines]
    out, res, ff, orderless, state = [], None, None, None, "pre"
    for l in lines:
        if l == MARK + " BEGIN":
            state = "run"
        elif l.startswith(MARK + " RESULT "):
            res, state = l[len(MARK + " RESULT "):], "post"
        elif l.startswith(MARK + " FULLFORM "):
            ff = l[len(MARK + " FULLFORM "):]
        elif l.startswith(MARK + " ORDERLESS "):
            orderless = l[len(MARK + " ORDERLESS "):]
        elif state == "run" and not l.startswith("Out["):
            out.append(l)
    while out and out[-1] == "":
        out.pop()
    if res is None or ff is None:
        raise SystemExit("case %s#%s: no result from the oracle\n%s" % (case["file"], case["id"], p.stdout[-2000:] + p.stderr[-2000:]))
    if "$sbR" in res or "$sbR" in ff:
        raise SystemExit("case %s#%s: the driver's own variable leaked into the result" % (case["file"], case["id"]))
    output = "\n".join(out) + ("\n" if out else "")
    return {"file": case["file"], "id": case["id"], "result": res, "fullform": ff, "output": output,
            "messages": [l for l in out if MESSAGE.match(l)], "orderless": orderless}


def environment(mathics):
    v = oracle([mathics, "--version"], "--version").stdout.strip().split("\n")
    limits = 'Print["%s LIMITS ", ToString[InputForm[{$RecursionLimit, $IterationLimit, Options[ReplaceRepeated]}]]]\n' % MARK
    p = oracle([mathics] + ARGS, "the limits probe", input=limits)
    lim = [re.sub(r"^In\[\d+\]:= ", "", l) for l in p.stdout.split("\n")]
    lim = [l[len(MARK + " LIMITS "):] for l in lim if l.startswith(MARK + " LIMITS ")]
    return {"version": v[0], "versions": v, "limits": lim[0] if lim else None, "argv": ["<program>"] + ARGS}


if __name__ == "__main__":
    mathics, cj = sys.argv[1], sys.argv[2]
    cases = json.load(open(cj, encoding="utf-8"))
    with cf.ThreadPoolExecutor(max_workers=int(os.environ.get("SPRIG_ORACLE_JOBS", "8"))) as ex:
        futures = [ex.submit(run_case, mathics, c) for c in cases]
        results = []
        for f in futures:
            try:
                results.append(f.result())
            except SystemExit as e:
                # (a refused run fails the whole recording: stdout stays empty, so run.py writes nothing)
                for g in futures:
                    g.cancel()
                sys.stderr.write("%s\n" % e)
                sys.exit(1)
    env = environment(mathics)
    orderless = set(r.pop("orderless") for r in results)
    if len(orderless) != 1:
        raise SystemExit("the oracle's Orderless heads differ between runs: %s" % sorted(orderless))
    env["orderless"] = orderless.pop()
    json.dump({"record": env, "results": results}, sys.stdout, ensure_ascii=False, indent=1, sort_keys=True)
    sys.stdout.write("\n")
