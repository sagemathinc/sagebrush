#!/usr/bin/env python3
"""The table behind test/magma-scope.test.ts: the scope events of Magma
functions (forward, define, read, assign, skipped or failed assignment,
delete, local) in every order, with the outcome Magma 2.18 gives for each
statement (run as a black box, as one session).

    python3 scripts/magma-scope-table.py program > scope.m
    magma -b < scope.m > scope.out
    python3 scripts/magma-scope-table.py table scope.out > test/magma-scope.json

The test replays every case in Sagebrush three ways: all of a case's
statements in one translation, each statement in its own translation (as
notebook cells), and the case split in two; each statement's outcome must
be Magma's.  Every case uses names of its own, so the cases are
independent.  My own inputs.
"""
import itertools
import json
import re
import sys

PRELUDE = ["Z := Integers();"]

VAR = {
    "A": "x{k} := 5;",
    "S": "if false then x{k} := 9; end if;",
    "E": "x{k} := 1 div 0;",
    "X": "delete x{k};",
}
CONSUMERS = ["function f{k}() return x{k}; end function;", "g{k} := func< t | t + x{k} >;",
             "m{k} := map< Z -> Z | t :-> t + x{k} >;"]
POST = {"": [], "A2": ["x{k} := 6;"], "X2": ["delete x{k};"]}
VAR_OBS = ["assigned f{k}, assigned g{k}, assigned m{k};", "f{k}();", "g{k}(1);", "m{k}(1);"]

FWD = {
    "F": "forward h{k};",
    "U": "function u{k}(n) return h{k}(n); end function;",
    "D": "function h{k}(n) return n + 1; end function;",
}
FWD_OBS = ["assigned u{k};", "u{k}(1);", "h{k}(1);"]

FIXED = [
    # a forward redeclared: each consumer keeps its own definition
    ["forward h{k};", "function p{k}(n) return h{k}(n); end function;", "function h{k}(n) return n + 1; end function;",
     "forward h{k};", "function q{k}(n) return h{k}(n); end function;", "function h{k}(n) return n + 30; end function;",
     "p{k}(1), q{k}(1), h{k}(1);"],
    # a later definition doesn't change a consumer whose forward was filled
    ["forward h{k};", "function p{k}(n) return h{k}(n); end function;", "function h{k}(n) return n + 1; end function;",
     "function h{k}(n) return n + 2; end function;", "p{k}(1), h{k}(1);"],
    # forwards inside a function: one cell per call, re-entrant
    ["function B{k}(c)\n  forward w;\n  function v(n) return w(n); end function;\n"
     "  if c eq 1 then junk := B{k}(2); end if;\n  function w(n) return n + c; end function;\n  return v;\nend function;",
     "a{k} := B{k}(1); b{k} := B{k}(5);", "a{k}(10), b{k}(10);"],
    # a local definition of the name doesn't fill a top-level forward
    ["forward h{k};", "function c{k}(n) return h{k}(n); end function;",
     "function L{k}()\n  function h{k}(n) return n + 1; end function;\n  return h{k};\nend function;",
     "t{k} := L{k}();", "function h{k}(n) return n + 2; end function;", "c{k}(1);"],
    # an intrinsic Sagebrush lacks: the definition stands; a local of that
    # name elsewhere doesn't change it
    ["function i{k}(v) return KernelMatrix(v); end function;", "assigned i{k};",
     "function o{k}() KernelMatrix := 1; return KernelMatrix; end function;", "assigned i{k}, assigned o{k};"],
    # a name that is no variable and no intrinsic: rejected
    ["function n{k}() return notavariable{k}; end function;", "assigned n{k};"],
    # local: only at the start of a function
    ["local y{k};", "assigned y{k};"],
    ["y{k} := 3;", "function l{k}() local y{k}; return assigned y{k}; end function;", "l{k}();",
     "function r{k}() t := 1; local y{k}; return t; end function;", "assigned r{k};"],
    # delete inside a function makes the name its own
    ["y{k} := 3;", "function d{k}() y{k} := 4; delete y{k}; return assigned y{k}; end function;", "d{k}(), y{k};",
     "function e{k}() delete y{k}; return 0; end function;", "assigned e{k};"],
]


def cases():
    out = []
    for r in range(0, 5):
        for pre in itertools.permutations("ASEX", r):
            for post in POST:
                stmts = [VAR[e] for e in pre] + CONSUMERS + POST[post] + VAR_OBS
                out.append(("var %s|%s" % ("".join(pre), post), stmts))
    for perm in itertools.permutations("FUD"):
        for extra in ("", "D2"):
            stmts = [FWD[e] for e in perm] + (["function h{k}(n) return n + 2; end function;"] if extra else []) + FWD_OBS
            out.append(("fwd %s%s" % ("".join(perm), extra), stmts))
    for j, stmts in enumerate(FIXED):
        out.append(("fixed %d" % j, stmts))
    return [(name, [s.replace("{k}", str(k)) for s in stmts]) for k, (name, stmts) in enumerate(out)]


def program():
    lines = list(PRELUDE)
    n = 0
    for _, stmts in cases():
        for s in stmts:
            lines.append('print "@@%d";' % n)
            lines.append(s)
            n += 1
    return "\n".join(lines) + "\n"


def outcomes(text):
    cells, cur = {}, None
    for line in text.split("\n"):
        m = re.match(r"@@(\d+)$", line.strip())
        if m:
            cur = int(m.group(1))
            cells[cur] = []
        elif cur is not None:
            cells[cur].append(line)
    res = {}
    for k, lines in cells.items():
        err = next((l.strip() for l in lines if "error" in l.lower()), None)
        res[k] = err if err is not None else "\n".join(l for l in lines if l.strip())
    return res


def table(magma_out):
    res = outcomes(open(magma_out).read())
    cs = cases()
    n = sum(len(s) for _, s in cs)
    return {
        "about": "scope events of functions in every order, with Magma 2.18's outcome for each statement (run as a "
                 "black box, one session); made by scripts/magma-scope-table.py",
        "prelude": PRELUDE,
        "cases": [{"name": name, "statements": stmts} for name, stmts in cs],
        "outcomes": [res.get(k, "") for k in range(n)],
    }


if __name__ == "__main__":
    if sys.argv[1] == "program":
        sys.stdout.write(program())
    elif sys.argv[1] == "table":
        print(json.dumps(table(sys.argv[2]), indent=1))
