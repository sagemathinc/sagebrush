#!/usr/bin/env python3
"""The table behind test/magma-compare.test.ts: every binary operation and
every sequence or set intrinsic that takes two values (PAIR_OPS, and
UNIVERSE_OPS with typed empty universes), for every pair of values of the
kinds Magma mode supports, with the outcome Magma 2.18 gives for each (run
as a black box).

    python3 scripts/magma-compare-table.py run /path/to/magma > pairs.out
    python3 scripts/magma-compare-table.py table pairs.out > test/magma-compare.json

(`run` runs the program in chunks, each in a fresh Magma; a chunk in which
Magma crashes, an internal error, is split until the statements that crash
it are alone; those are coded "X", and the test skips them.)

The JSON holds the values, the operations and Magma's outcomes, coded:
"T"/"F" (true or false), "V" (another value) or the index of an error line
in "errors".  "fail_closed" maps the statements where Sagebrush refuses
what Magma accepts (REFUSED) to the index of the reason in "reasons"; the
test requires an error there.
The test builds the same program from the JSON (keep the two in step).
"""
import json
import re
import sys

PRELUDE = [
    "P<x> := PolynomialRing(Integers());",
    "Q<y> := PolynomialRing(Rationals());",
    "P2<z> := PolynomialRing(Integers());",
    "K<a> := NumberField(x^2 - 2);",
    "L<b> := NumberField(x^2 - 2);",
    "M<c> := NumberField(x^2 - 3);",
    "F := recformat< u >;",
]

VALUES = [
    ("int", "3"), ("rat", "3/4"), ("real", "1.5"), ("str", '"ab"'), ("one", "1"), ("bool", "true"),
    ("seq", "[1, 2]"), ("seqq", "[1/2]"), ("seqs", '["p"]'), ("empty", "[]"),
    ("set", "{1, 2}"), ("iset", "{@ 1, 2 @}"), ("mset", "{* 1, 1 *}"),
    ("tup", "<1, 2>"), ("tup3", "<1, 2, 3>"), ("rec", "rec< F | u := 1 >"),
    ("map", "map< Integers() -> Integers() | n :-> n + 1 >"),
    ("ZZ", "Integers()"), ("QQ", "Rationals()"), ("RR", "RealField(30)"), ("RR20", "RealField(20)"),
    ("Px", "P"), ("Qy", "Q"), ("P2z", "P2"),
    ("x", "x"), ("y", "y"), ("x2", "x^2"), ("z", "z"),
    ("K", "K"), ("L", "L"), ("M", "M"), ("a", "a"), ("b", "b"), ("c", "c"), ("K1", "K!1"),
    ("A22", "Matrix(Integers(), 2, 2, [1, 2, 3, 4])"), ("I22", "Matrix(Integers(), 2, 2, [1, 0, 0, 1])"),
    ("Q22", "Matrix(Rationals(), 2, 2, [1, 0, 0, 1])"), ("A14", "Matrix(Integers(), 1, 4, [1, 2, 3, 4])"),
    ("A11", "Matrix(Integers(), 1, 1, [1])"),
    ("MS", "Parent(Matrix(Integers(), 2, 2, [1, 2, 3, 4]))"), ("MSQ", "Parent(Matrix(Rationals(), 2, 2, [1, 0, 0, 1]))"),
    # a second, separately made map (maps compare only with themselves)
    ("map2", "map< Integers() -> Integers() | n :-> n + 1 >"),
]

# typed empty universes: [ U | ] for these structures
UNIVERSES = ["ZZ", "QQ", "Px", "Qy", "K", "M", "MS", "MSQ", "RR"]

# every operation on a pair of values p, q ({p}, {q} are the values)
PAIR_OPS = [
    ("eq", "{p} eq {q};"), ("in", "{p} in [{q}];"), ("incl", "Include([{q}], {p});"),
    ("lt", "{p} lt {q};"), ("le", "{p} le {q};"), ("gt", "{p} gt {q};"), ("ge", "{p} ge {q};"),
    ("add", "{p} + {q};"), ("sub", "{p} - {q};"), ("mul", "{p} * {q};"), ("div", "{p} / {q};"),
    ("idiv", "{p} div {q};"), ("mod", "{p} mod {q};"), ("pow", "{p} ^ {q};"),
    ("cat", "{p} cat {q};"), ("scat", "[{p}] cat [{q}];"),
    ("join", "{{{p}}} join {{{q}}};"), ("meet", "{{{p}}} meet {{{q}}};"), ("diff", "{{{p}}} diff {{{q}}};"),
    ("sdiff", "{{{p}}} sdiff {{{q}}};"), ("subset", "{{{p}}} subset {{{q}}};"),
    ("notsubset", "{{{p}}} notsubset {{{q}}};"),
    ("vjoin", "{p} join {q};"),
    ("append", "Append([{q}], {p});"), ("insert", "Insert([{q}], 1, {p});"), ("excl", "Exclude([{q}], {p});"),
    ("index", "Index([{q}], {p});"), ("remincl", "Include(Remove([{q}], 1), {p});"),
]

# operations with a typed empty universe [ U | ] ({u} is the structure)
UNIVERSE_OPS = [
    ("tin", "{p} in [ {u} | ];"), ("tappend", "Append([ {u} | ], {p});"), ("tinsert", "Insert([ {u} | ], 1, {p});"),
    ("trevincl", "Include(Reverse([ {u} | ]), {p});"),
]

# What Sagebrush refuses (an error, never a guess) where Magma accepts:
# (operations, first values, second values or universes, reason).  The
# rules apply only where Magma accepts; where Magma reports an error,
# Sagebrush must report the same one.
NUM = ("int", "rat", "real", "one")
POLY = ("x", "y", "x2", "z")
NFE = ("a", "b", "c", "K1")
MAT = ("A22", "I22", "Q22", "A14", "A11")
SEQL = ("seq", "seqq", "empty")
ALL = tuple(n for n, _ in VALUES) + tuple(UNIVERSES)
ORDER = ("lt", "le", "gt", "ge")
MUTATE = ("in", "incl", "tin", "append", "insert", "excl", "index", "remincl", "tappend", "tinsert", "trevincl")
ARITH = ("add", "sub", "mul", "div", "idiv", "mod")
RING = {"x": "P", "x2": "P", "y": "Q", "z": "P2"}
GE_TUPLES = "ge of tuples of two lengths (Magma answers true both ways, where lt, le and gt call them incompatible)"
SEQ_REASON = "a sequence converted into an element of a structure (Magma's coefficient conversion)"
REFUSED = [
    (MUTATE, SEQL, tuple(n for n in ALL if n not in SEQL + ("seqs",)), SEQ_REASON),
    (("incl", "append", "insert", "excl"), POLY, ("empty",),
     "[] read as the zero polynomial, to take a polynomial (Magma's coefficient conversion)"),
    (ORDER, NUM + POLY + NFE + MAT, POLY + MAT, "Magma's orders on polynomials and matrices"),
    (ORDER, POLY + MAT, NUM + POLY + NFE + MAT, "Magma's orders on polynomials and matrices"),
    (ORDER, ("mset",), ("mset",), "Magma's order on multisets"),
    (("ge",), ("tup",), ("tup3",), GE_TUPLES),
    (("ge",), ("tup3",), ("tup",), GE_TUPLES),
    (ARITH, POLY, POLY, "arithmetic of polynomials of two rings (Magma maps generator to generator)"),
    (("add", "sub", "mul", "idiv", "mod"), ("real",), POLY, "polynomials over the real numbers"),
    (("add", "sub", "mul", "idiv", "mod"), POLY, ("real",), "polynomials over the real numbers"),
    (("add", "sub"), NUM + POLY + NFE, MAT, "a scalar added to a matrix"),
    (("add", "sub"), MAT, NUM + POLY + NFE, "a scalar added to a matrix"),
    (("div",), MAT, NUM + NFE, "a matrix divided by a scalar"),
    (("idiv",), MAT, NUM + NFE, "div of a matrix by a scalar"),
    (("div",), POLY, NFE, "a polynomial divided by a rational number field element"),
    (("idiv", "mod"), NUM, POLY, "div and mod of a number by a polynomial"),
    (("idiv", "mod"), ("x", "x2", "z"), NUM, "div and mod of a polynomial over the integers by a number"),
    (("add",), ("tup", "tup3"), ("tup", "tup3"), "arithmetic of tuples"),
    (("mul",), NUM, ("empty",), "a number times the empty sequence"),
    (("pow",), ("map", "map2"), NUM, "powers of maps"),
    (("pow",), POLY, MAT, "a polynomial to the power of a matrix"),
    (("add", "mul", "div"), ("ZZ",), ("ZZ",), "arithmetic of the ring of integers (ideals)"),
    (("mul",), NUM, ("ZZ",), "ideals of the ring of integers"),
    (("pow",), ("ZZ",), NUM, "powers of the ring of integers (modules)"),
    (("add", "mul", "div"), ("Px", "Qy", "P2z"), ("Px", "Qy", "P2z"), "arithmetic of polynomial rings"),
    (("add", "mul", "div"), ("MS", "MSQ"), ("MS", "MSQ"), "arithmetic of matrix spaces"),
    (("join",), ("set", "iset"), ("mset",), "sets of sets joined with sets of multisets"),
]


def refused(op, p, q):
    """The reason Sagebrush refuses the statement `op p q`, if it does."""
    for ops, ps, qs, reason in REFUSED:
        if op in ops and p in ps and q in qs:
            if ops is ARITH and RING[p] == RING[q]:
                continue
            return reason
    return None


def statements():
    """(key, statement) in order (the test builds the same list)."""
    names = [n for n, _ in VALUES]
    out = []
    for op, t in PAIR_OPS:
        for p in names:
            for q in names:
                out.append(("%s %s %s" % (op, p, q), t.format(p="v_" + p, q="v_" + q)))
    for op, t in UNIVERSE_OPS:
        for u in UNIVERSES:
            for p in names:
                out.append(("%s %s %s" % (op, p, u), t.format(p="v_" + p, u="v_" + u)))
    return out


def program():
    lines = PRELUDE + ["v_%s := %s;" % (n, e) for n, e in VALUES]
    for k, (_, stmt) in enumerate(statements()):
        lines.append('print "@@%d";' % k)
        lines.append(stmt)
    return "\n".join(lines) + "\n"


def run(magma):
    """The output of the program, in Magma, chunk by chunk."""
    import subprocess
    stmts = statements()
    head = "\n".join(PRELUDE + ["v_%s := %s;" % (n, e) for n, e in VALUES]) + "\n"
    pieces = []

    def go(lo, hi):
        prog = head + "".join('print "@@%d";\n%s\n' % (k, stmts[k][1]) for k in range(lo, hi)) + 'print "@@end";\n'
        out = subprocess.run([magma, "-b"], input=prog, capture_output=True, text=True).stdout
        if "Internal error" not in out and "@@end" in out:
            pieces.append(out[out.index("@@%d" % lo):out.index("@@end")] if hi > lo else "")
            return
        if hi - lo == 1:
            pieces.append("@@%d\n%s\n" % (lo, CRASH))
            return
        mid = (lo + hi) // 2
        go(lo, mid)
        go(mid, hi)

    for lo in range(0, len(stmts), 2000):
        go(lo, min(lo + 2000, len(stmts)))
    return "".join(pieces)


CRASH = "Magma crashed (internal error)"


def outcomes(text):
    """The outcome of each statement in an output of the program."""
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
        err = next((l.strip() for l in lines if "error" in l.lower() or l.strip() == CRASH), None)
        if err is not None:
            res[k] = ("E", err)
        else:
            v = "\n".join(l for l in lines if l.strip())
            res[k] = ("T",) if v == "true" else ("F",) if v == "false" else ("V",)
    return res


def table(magma_out):
    stmts = statements()
    res = outcomes(open(magma_out).read())
    errors, codes, fail_closed, reasons = [], [], {}, []
    for k, (key, _) in enumerate(stmts):
        r = res[k]
        if r[0] == "E" and r[1] == CRASH:
            codes.append("X")
            continue
        if r[0] == "E":
            if r[1] not in errors:
                errors.append(r[1])
            codes.append(str(errors.index(r[1])))
        else:
            codes.append(r[0])
        reason = refused(*key.split())
        if r[0] != "E" and reason:
            if reason not in reasons:
                reasons.append(reason)
            fail_closed[key] = reasons.index(reason)
    return {
        "about": "binary operations and two-value sequence and set intrinsics for pairs of values, with Magma "
                 "2.18's outcomes (run as a black box); made by scripts/magma-compare-table.py",
        "prelude": PRELUDE, "values": VALUES, "universes": UNIVERSES,
        "pair_ops": PAIR_OPS, "universe_ops": UNIVERSE_OPS,
        "errors": errors, "codes": ",".join(codes), "fail_closed": fail_closed, "reasons": reasons,
    }


if __name__ == "__main__":
    if sys.argv[1] == "program":
        sys.stdout.write(program())
    elif sys.argv[1] == "run":
        sys.stdout.write(run(sys.argv[2]))
    elif sys.argv[1] == "table":
        print(json.dumps(table(sys.argv[2]), indent=1))
