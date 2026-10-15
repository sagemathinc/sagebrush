"""The search box's MATLAB examples (lib/_matlab_examples.py): their outputs,
and their check against GNU Octave.

    python3 matlab-tests/doc_examples.py --update   # run every example in Sagebrush, write its output into the module
    python3 matlab-tests/doc_examples.py --octave   # write test_doc_examples.m, their values for run.py to compare
                                                    # with Octave (then: run.py --regen doc_examples)

Every example runs in one MATLAB session, each after `clear`, its output
delimited by a marker line; test/matlab-doc-examples.test.ts does the same
and compares the outputs exactly.  The Octave check compares values, not
displays (MATLAB's and Octave's differ): each example runs with its display
suppressed and show() prints the value it makes (the variables it assigns,
or the value of its expression).  Examples whose function Octave lacks, or
that only print, are left out of it (OCTAVE_SKIP, with the reason).
"""
import json, os, re, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
CLI = os.path.join(ROOT, "dist", "src", "cli.js")
MODULE = os.path.join(ROOT, "lib", "_matlab_examples.py")
MARK = "@@example %d@@"

# (Octave has no such function, or prints rather than returns)
OCTAVE_SKIP = {
    "contains": "not in Octave 11",
    "disp": "prints: MATLAB's and Octave's displays differ",
    "fprintf": "prints",
    "nthroot": "MATLAB's nthroot(-27, 3) is exactly -3, Octave's is not (design/matlab.md)",
    "histcounts": "not in Octave 11",
    "join": "string arrays: Octave has no string class",
    "string": "string arrays: Octave has no string class",
    "strlength": "not in Octave 11",
    "split": "not in Octave 11",
    "replace": "not in Octave 11",
}
# (compared to 12 significant digits: Octave's and Sagebrush's last bits differ)
OCTAVE_ROUND = {"inv", "polyfit", "linsolve", "gamma"}


def codes():
    ns = {}
    exec(open(MODULE).read(), ns)
    return ns["CODES"]


def program(cs):
    out = []
    for k, (_, code) in enumerate(cs):
        out.append("clear")
        out.append("fprintf('%s\\n');" % (MARK % k))
        out.append(code)
    return "\n".join(out) + "\n"


def run_sagebrush(cs):
    p = subprocess.run(["node", CLI, "--matlab", "-c", program(cs)], capture_output=True, text=True, timeout=1200)
    if p.returncode:
        sys.exit("sagebrush failed:\n" + p.stderr[-3000:])
    if p.stderr.strip():
        sys.exit("an example wrote to stderr (warnings are not for examples):\n" + p.stderr[-3000:])
    return split(p.stdout, len(cs))


def split(text, n):
    parts = re.split(r"@@example (\d+)@@\n", text)
    assert parts[0] == "", parts[0][:200]
    got = {int(parts[i]): parts[i + 1] for i in range(1, len(parts), 2)}
    assert sorted(got) == list(range(n)), "markers missing"
    return [got[k] for k in range(n)]


def update():
    cs = codes()
    outs = run_sagebrush(cs)
    src = open(MODULE).read()
    gen = "OUTPUTS = %s\n" % json.dumps({code: out for (_, code), out in zip(cs, outs)}, indent=0, ensure_ascii=True, sort_keys=False)
    head = src[:src.index("# ---- outputs")] if "# ---- outputs" in src else src
    open(MODULE, "w").write(head.rstrip("\n") + "\n\n# ---- outputs (matlab-tests/doc_examples.py --update) ----\n" + gen)
    print("%d examples, outputs written" % len(cs))


def value_program(cs):
    """the examples, their displays suppressed, show() of what each makes"""
    out = ["% The values the search box's MATLAB examples make (lib/_matlab_examples.py),",
           "% compared with GNU Octave's (made by matlab-tests/doc_examples.py --octave)."]
    for name, code in cs:
        if name in OCTAVE_SKIP:
            continue
        m = re.match(r"^\[(.*)\]\s*=(?!=)\s*(.*)$", code)
        n = re.match(r"^(\w+)\s*=(?!=)\s*(.*)$", code)
        sh = (lambda v: "show(round(%s * 1e12) / 1e12);" % v) if name in OCTAVE_ROUND else (lambda v: "show(%s);" % v)
        if m:
            names = [v.strip() for v in m.group(1).split(",")]
            body = code + ";\n" + "\n".join(sh(v) for v in names if v != "~")
        elif n:
            body = code + ";\n" + sh(n.group(1))
        else:
            body = "v = %s;\n%s" % (code, sh("v"))
        out.append("%% %s\nclear\n%s" % (name, body))
    return "\n".join(out) + "\n"


if __name__ == "__main__":
    if "--update" in sys.argv:
        update()
    elif "--octave" in sys.argv:
        open(os.path.join(HERE, "test_doc_examples.m"), "w").write(value_program(codes()))
        print("wrote matlab-tests/test_doc_examples.m")
    else:
        sys.exit(__doc__)
