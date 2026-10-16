#!/usr/bin/env python3
"""Magma 2.18's output for the examples of the Magma index
(lib/_magma_docsearch.py EXAMPLES), run as a black box, for
test/magma-examples.test.ts.

    python3 scripts/magma-examples-table.py /path/to/magma > test/magma-examples.json

Each example's input runs in a fresh Magma; the result has the example's
form (input after "> ", each statement followed by its output).
"""
import concurrent.futures as cf
import json
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))


def examples():
    src = open(os.path.join(HERE, "..", "lib", "_magma_docsearch.py")).read()
    g = {}
    exec(src.split("\ndef ")[0], g)
    # (and each signature's example, as name(types): _magma_docsearch.examples())
    out = dict(g["EXAMPLES"])
    for name, sigs in g.get("SIGNATURES", {}).items():
        for types, (_, example) in sigs.items():
            out["%s(%s)" % (name, types)] = example
    return out


def inputs(example):
    return [line[2:] for line in example.split("\n") if line.startswith("> ")]


def program(lines):
    """The input with a marker before each statement (the test builds the same)."""
    return "".join('print "@@%d";\n%s\n' % (k, line) for k, line in enumerate(lines)) + 'print "@@end";\n'


def transcript(lines, out):
    """The example's form of a run of program(lines)."""
    parts = re.split(r"^@@(?:\d+|end)\n", out, flags=re.M)[1:]
    if len(parts) != len(lines) + 1:
        return None
    text = []
    for line, o in zip(lines, parts):
        text.append("> " + line)
        if o.strip():
            text.extend(o.rstrip("\n").split("\n"))
    return "\n".join(text)


def run(magma, example):
    lines = inputs(example)
    out = subprocess.run([magma, "-b"], input=program(lines), capture_output=True, text=True, timeout=600).stdout
    return transcript(lines, out)


if __name__ == "__main__":
    magma = sys.argv[1]
    ex = examples()
    with cf.ThreadPoolExecutor(8) as pool:
        got = dict(zip(sorted(ex), pool.map(lambda n: run(magma, ex[n]), sorted(ex))))
    print(json.dumps({
        "about": "Magma 2.18's output for each example of lib/_magma_docsearch.py (run as a black box); made by "
                 "scripts/magma-examples-table.py",
        "magma": got,
    }, indent=1))
