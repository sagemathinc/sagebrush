"""The examples of Python mode's search index (lib/_python_examples.py).

    python3 scripts/python-doc-examples.py --update    record Sagebrush's output of each
                                                       example in OUTPUTS (needs a built
                                                       dist/: npm run build)
    python3 scripts/python-doc-examples.py --cpython   run them under CPython with NumPy
                                                       and SciPy, and report each output
                                                       that differs from the recorded one

test/python-doc-examples.test.ts checks Sagebrush's outputs against OUTPUTS.
"""
import json
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FILE = os.path.join(ROOT, "lib", "_python_examples.py")
MARK = "# ---------------------------------------------------------------- outputs"


def sagebrush_outputs():
    code = "import json, _python_examples as e\nprint(json.dumps(e.run_all()))"
    r = subprocess.run(["node", os.path.join(ROOT, "dist", "src", "cli.js"), "-c", code], capture_output=True, text=True)
    if r.returncode:
        sys.exit(r.stderr)
    return json.loads(r.stdout)


def update():
    outputs = sagebrush_outputs()
    with open(FILE) as f:
        text = f.read()
    head = text[:text.index(MARK)]
    body = "".join("    %r:\n        %r,\n" % (k, v) for k, v in outputs.items())
    with open(FILE, "w") as f:
        f.write(head + MARK + "\n# (written by scripts/python-doc-examples.py --update: Sagebrush's output for\n"
                "# each example's code)\nOUTPUTS = {\n" + body + "}\n")
    print("%d outputs recorded" % len(outputs))


def cpython():
    sys.path.insert(0, os.path.join(ROOT, "lib"))
    import _python_examples as e
    sys.path.pop(0)
    os.environ.setdefault("MPLBACKEND", "Agg")
    bad = 0
    for name, _, _, codes in e.ENTRIES:
        for code in codes:
            try:
                got = e.run(code)
            except Exception as err:
                got = "%s: %s\n" % (type(err).__name__, err)
            want = e.OUTPUTS.get(code)
            if got != want:
                bad += 1
                print("--- %s: %s\n    CPython:   %r\n    Sagebrush: %r" % (name, code.replace("\n", "; "), got, want))
    total = sum(len(x[3]) for x in e.ENTRIES)
    print("%d of %d examples print the same under CPython %s" % (total - bad, total, sys.version.split()[0]))
    return 1 if bad else 0


if __name__ == "__main__":
    if "--update" in sys.argv:
        update()
    elif "--cpython" in sys.argv:
        sys.exit(cpython())
    else:
        print(__doc__)
