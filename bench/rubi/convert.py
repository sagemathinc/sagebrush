"""Rubi's integration test suite (MIT; github.com/RuleBasedIntegration/
MathematicaSyntaxTestSuite) in Sage syntax, for the scorecard:

    git clone --depth 1 https://github.com/RuleBasedIntegration/MathematicaSyntaxTestSuite /tmp/rubi-tests
    python3 bench/rubi/convert.py /tmp/rubi-tests > /tmp/rubi.jsonl

One JSON object per problem: {"file", "in", "var"}; problems with
functions outside the engine (special functions, Hypergeometric2F1,
...) are skipped.  Mathematica's E is e; Rubi's parameter e becomes ee.
"""
import json, os, re, sys

NAMES = {
    "Sin": "sin", "Cos": "cos", "Tan": "tan", "Cot": "cot", "Sec": "sec", "Csc": "csc",
    "ArcSin": "arcsin", "ArcCos": "arccos", "ArcTan": "arctan", "ArcCot": "arccot", "ArcSec": "arcsec", "ArcCsc": "arccsc",
    "Sinh": "sinh", "Cosh": "cosh", "Tanh": "tanh", "Coth": "coth", "Sech": "sech", "Csch": "csch",
    "ArcSinh": "arcsinh", "ArcCosh": "arccosh", "ArcTanh": "arctanh", "ArcCoth": "arccoth", "ArcSech": "arcsech", "ArcCsch": "arccsch",
    "Log": "log", "Exp": "exp", "Sqrt": "sqrt", "Abs": "abs", "Erf": "erf",
}
CONST = {"E": "e", "Pi": "pi", "I": "I"}
TOKEN = re.compile(r"\s*(?:(\d+\.?\d*)|([A-Za-z][A-Za-z0-9]*)|(.))")


def split_top(s):
    """The comma-separated fields of {a, b, ...} at bracket depth 0."""
    out, depth, cur = [], 0, []
    for ch in s:
        if ch in "([{":
            depth += 1
        elif ch in ")]}":
            depth -= 1
        if ch == "," and depth == 0:
            out.append("".join(cur).strip())
            cur = []
        else:
            cur.append(ch)
    out.append("".join(cur).strip())
    return out


def convert(m):
    toks = []
    pos = 0
    while pos < len(m):
        t = TOKEN.match(m, pos)
        if not t or t.end() == pos:
            break
        pos = t.end()
        num, name, op = t.groups()
        toks.append(("n", num) if num else ("id", name) if name else ("op", op))
    out, stack = [], []
    prev = None
    for i, (kind, v) in enumerate(toks):
        nxt = toks[i + 1] if i + 1 < len(toks) else None
        # implicit multiplication: "2 x", "a (b)", ") x"
        if prev in ("n", "id", "close") and kind in ("n", "id") or prev in ("n", "id", "close") and kind == "op" and v == "(":
            if not (prev == "id" and kind == "op" and v == "("):
                out.append("*")
        if kind == "id":
            if nxt == ("op", "["):
                if v not in NAMES:
                    return None
                out.append(NAMES[v])
            elif v in CONST:
                out.append(CONST[v])
            elif v == "e":
                out.append("ee")
            elif v[0].isupper():
                return None
            else:
                out.append(v)
            prev = "id"
        elif kind == "n":
            out.append(v)
            prev = "n"
        else:
            if v == "[":
                out.append("(")
                stack.append("call")
                prev = "op"
            elif v == "]":
                out.append(")")
                stack.pop() if stack else None
                prev = "close"
            elif v == ")":
                out.append(")")
                prev = "close"
            elif v in "{}":
                return None
            else:
                out.append(v)
                prev = "op" if v != ")" else "close"
    return "".join(out)


def main(root):
    for dirpath, _, files in sorted(os.walk(root)):
        for f in sorted(files):
            if not f.endswith(".m"):
                continue
            path = os.path.join(dirpath, f)
            rel = os.path.relpath(path, root)
            for line in open(path, encoding="utf-8", errors="replace"):
                line = line.strip()
                if not (line.startswith("{") and line.endswith("}")):
                    continue
                fields = split_top(line[1:-1])
                if len(fields) < 2:
                    continue
                integrand, var = convert(fields[0]), fields[1]
                if integrand is None or not re.fullmatch(r"[a-z]", var):
                    continue
                print(json.dumps({"file": rel, "in": integrand, "var": "ee" if var == "e" else var}))


main(sys.argv[1])
