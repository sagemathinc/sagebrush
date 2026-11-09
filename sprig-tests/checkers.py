"""The value checkers for Sprig's KNOWN classes (design/sprig-mvp.md §7.3).

    sagebrush sprig-tests/checkers.py --controls    # run the negative controls; JSON verdicts; exit 1 if any is wrong

A listed difference from the oracle is accepted only if its class's checker
passes. The checkers are deliberately independent of lib/_sprig/: they read the
oracle's and Sprig's FullForm text with their own small parser, and convert to
Sage's symbolic ring with their own fixed table, so a bug in Sprig's parser or
printer can't make both sides agree.

- term_order(ours, theirs, orderless): equal after sorting the arguments of the
  oracle's Orderless heads, recursively, and nothing else.
- equivalent(ours, theirs): the same free symbols; then symbolically (the
  difference simplifies to 0), else numerically at 50 digits on at least 7
  seeded points, of which at least 5 must be finite, with
  |a - b| <= 1e-20 max(1, |a|, |b|). Returns how it was decided. With
  up_to_constant=VAR (Integrate only), the derivative of the difference must
  pass instead.
- host_limit(message, ours, expected): the oracle's refusal is on the closed
  list, and Sprig's result is the accepted value.
- normalize(text): the one normalization of the oracle's InputForm (§7.2): its
  seven single-character operators written in ASCII, outside string literals.
  The table is closed: ⇾ ⧴ ⩵ as bare characters (S0), and ∧ ∨ ≠ ❘ only spaced
  as the oracle records them (the grader's ruling, Nov 9), so a form not seen
  is never rewritten.
- leftover(text): the non-ASCII characters outside string literals that
  normalize() leaves (the runner's census: each must be in a KNOWN case).

A head the conversion table doesn't know makes the check fail: an expression
the checker can't evaluate is never taken as equal.
"""
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))


class NotDecided(Exception):
    pass


def var_name(name):
    """The Sage variable for a Sprig symbol: one injective mapping, used for conversion, substitution and
    up_to_constant alike. ASCII letters and digits are kept; every other character, "_" included, becomes
    "_" and its four hex digits, so two different names never share a variable (a$b and a`b stay apart)."""
    return "sv_" + "".join(c if (c.isascii() and c.isalnum()) else "_%04x" % ord(c) for c in name)


# ---------------------------------------------------------------- FullForm text

TOKEN = re.compile(r"""
    (?P<ws>\s+)
  | (?P<str>"(?:[^"\\]|\\.)*")
  | (?P<num>-?\d+(?:\.\d*)?(?:`[\d.]*)?(?:\*\^-?\d+)?)
  | (?P<sym>[A-Za-z$][A-Za-z0-9$`]*)
  | (?P<punct>[\[\]{},])
""", re.X)


def tokens(text):
    out, i = [], 0
    while i < len(text):
        m = TOKEN.match(text, i)
        if not m:
            raise NotDecided("can't read FullForm at %r" % text[i:i + 20])
        i = m.end()
        if m.lastgroup != "ws":
            out.append((m.lastgroup, m.group()))
    return out


def parse(text):
    """FullForm text as a tree: ("int", n), ("real", text), ("str", s), ("sym", name) or ("app", head, [args]).
    Braces are List, as the oracle prints lists in FullForm."""
    toks = tokens(text)
    pos = [0]

    def peek():
        return toks[pos[0]] if pos[0] < len(toks) else (None, None)

    def take(v=None):
        t = peek()
        if t[0] is None or (v is not None and t[1] != v):
            raise NotDecided("FullForm: expected %r at token %d" % (v, pos[0]))
        pos[0] += 1
        return t

    def args(close):
        out = []
        if peek()[1] == close:
            take(close)
            return out
        while True:
            out.append(expr())
            t = take()
            if t[1] == close:
                return out
            if t[1] != ",":
                raise NotDecided("FullForm: expected , or %s" % close)

    def expr():
        kind, v = take()
        if v == "{":
            e = ("app", ("sym", "List"), args("}"))
        elif kind == "num":
            e = ("real", v) if ("." in v or "`" in v or "*^" in v) else ("int", int(v))
        elif kind == "str":
            e = ("str", json.loads(v))
        elif kind == "sym":
            e = ("sym", v)
        else:
            raise NotDecided("FullForm: unexpected %r" % v)
        while peek()[1] == "[":
            take("[")
            e = ("app", e, args("]"))
        return e

    e = expr()
    if pos[0] != len(toks):
        raise NotDecided("FullForm: trailing text")
    return e


def text_of(e):
    k = e[0]
    if k == "int":
        return str(e[1])
    if k == "real":
        return e[1]
    if k == "str":
        return json.dumps(e[1])
    if k == "sym":
        return e[1]
    return "%s[%s]" % (text_of(e[1]), ", ".join(text_of(a) for a in e[2]))


# ---------------------------------------------------------------- the one normalization (§7.2)

# The oracle's InputForm writes these operators as single characters; Sprig writes the ASCII forms. Nothing else is
# normalized, and a result with any other non-ASCII character is compared as it is.
NORMALIZE = {"\u21fe": "->", "\u29f4": ":>", "\u2a75": "==",
             " \u2227 ": " && ", " \u2228 ": " || ", " \u2260 ": " != ", " \u2758 ": " | "}


STRING = re.compile(r'"(?:[^"\\]|\\.)*"')


def normalize(text):
    """The operators outside string literals; a quoted literal, escapes included, is kept byte for byte."""
    out, i = [], 0
    for m in STRING.finditer(text):
        out.append(_operators(text[i:m.start()]))
        out.append(m.group())
        i = m.end()
    out.append(_operators(text[i:]))
    return "".join(out)


def leftover(text):
    """The non-ASCII characters outside string literals after normalize(), sorted."""
    return sorted({ch for ch in STRING.sub('""', normalize(text)) if ord(ch) > 127})


def census(paths):
    """Every recorded case whose result, FullForm or printed output keeps a non-ASCII character outside string
    literals after normalize(): [{"file", "id", "chars"}]."""
    out = []
    for path in paths:
        rec = json.load(open(path, encoding="utf-8"))
        for c in rec["cases"]:
            chars = sorted(set(leftover(c["result"])) | set(leftover(c["fullform"])) | set(leftover(c["output"])))
            if chars:
                out.append({"file": rec["file"], "id": c["id"], "chars": chars})
    return out


def _operators(text):
    for k, v in NORMALIZE.items():
        text = text.replace(k, v)
    return text


# ---------------------------------------------------------------- term-order

def canonical(e, orderless):
    if e[0] != "app":
        return text_of(e)
    head = canonical(e[1], orderless)
    args = [canonical(a, orderless) for a in e[2]]
    if e[1] == ("sym", e[1][1]) and e[1][0] == "sym" and e[1][1] in orderless:
        args.sort()
    return "%s[%s]" % (head, ", ".join(args))


def term_order(ours, theirs, orderless):
    """Equal multisets of arguments under the Orderless heads, recursively, and nothing else."""
    return canonical(parse(ours), orderless) == canonical(parse(theirs), orderless)


# ---------------------------------------------------------------- to Sage

def sage():
    import sage_all
    return sage_all


FUNCTIONS = {"Sin": "sin", "Cos": "cos", "Tan": "tan", "Cot": "cot", "Sec": "sec", "Csc": "csc",
             "ArcSin": "arcsin", "ArcCos": "arccos", "ArcTan": "arctan", "Sinh": "sinh", "Cosh": "cosh",
             "Tanh": "tanh", "Exp": "exp", "Sqrt": "sqrt"}
CONSTANTS = {"Pi": "pi", "E": "e", "I": "I"}


def symbols(e):
    """The free symbols of a tree: symbols in argument positions that aren't constants."""
    if e[0] == "sym":
        return set() if e[1] in CONSTANTS or e[1] in ("Infinity", "True", "False", "Null") else {e[1]}
    if e[0] == "app":
        out = set()
        for a in e[2]:
            out |= symbols(a)
        return out
    return set()


def to_sr(e, S):
    k = e[0]
    if k == "int":
        return S.SR(S.Integer(e[1]))
    if k == "real":
        m = re.match(r"^(-?\d+(?:\.\d*)?)(?:`[\d.]*)?(?:\*\^(-?\d+))?$", e[1])
        if not m:
            raise NotDecided("real %r" % e[1])
        return S.SR(S.QQ(m.group(1)) * S.QQ(10) ** int(m.group(2) or 0))
    if k == "str":
        raise NotDecided("a string has no value to compare")
    if k == "sym":
        if e[1] in CONSTANTS:
            return getattr(S, CONSTANTS[e[1]]) if e[1] != "I" else S.SR(S.I)
        if e[1] == "Infinity":
            return S.SR(S.oo)
        return S.SR.var(var_name(e[1]))
    head, args = e[1], e[2]
    if head[0] != "sym":
        raise NotDecided("a compound head: %s" % text_of(head))
    h = head[1]
    a = [to_sr(x, S) for x in args]
    if h == "Plus":
        return sum(a, S.SR(0))
    if h == "Times":
        r = S.SR(1)
        for x in a:
            r = r * x
        return r
    if h == "Power" and len(a) == 2:
        return a[0] ** a[1]
    if h == "Rational" and len(a) == 2:
        return a[0] / a[1]
    if h == "Complex" and len(a) == 2:
        return a[0] + S.I * a[1]
    if h == "Log" and len(a) in (1, 2):
        return S.log(a[0]) if len(a) == 1 else S.log(a[1]) / S.log(a[0])
    if h == "Abs" and len(a) == 1:
        return abs(a[0])
    if h in FUNCTIONS and len(a) == 1:
        return getattr(S, FUNCTIONS[h])(a[0])
    raise NotDecided("no conversion for %s" % h)


# ---------------------------------------------------------------- equivalent-form

DIGITS = 50
MIN_FINITE = 5


def points(S):
    """The seeded points: negative, non-integer, and two complex values, exact (so no float enters)."""
    Q, I = S.QQ, S.I
    return [Q(-7) / 3, Q(1) / 2, Q(5) / 4, Q(-2) / 5, Q(13) / 7, Q(1) / 3 + Q(2) / 5 * I, Q(-3) / 4 + Q(1) / 7 * I]


def finite(z):
    try:
        c = complex(z)
    except Exception:
        return False
    return all(abs(p) < float("inf") and p == p for p in (c.real, c.imag))


def numeric_equal(A, B, names, S):
    """(passed, finite points used, why): why is "", "mismatch" or "too few finite points"."""
    vs = [S.SR.var(var_name(n)) for n in sorted(names)]
    pts = points(S)
    C = S.ComplexField(200)
    tol = S.RealField(200)(10) ** -20
    ok = 0
    for k in range(len(pts)):
        sub = {v: pts[(k + i) % len(pts)] for i, v in enumerate(vs)}
        try:
            a = C(S.SR(A).subs(sub).n(digits=DIGITS))
            b = C(S.SR(B).subs(sub).n(digits=DIGITS))
        except (ArithmeticError, ValueError, TypeError):
            # (a point where either side has no value, such as a pole, is skipped)
            continue
        if not (finite(a) and finite(b)):
            continue
        ok += 1
        if abs(a - b) > tol * max(1, abs(a), abs(b)):
            return False, ok, "mismatch"
        if not vs:
            # (a constant: one point decides it)
            return True, ok, ""
    return (True, ok, "") if ok >= MIN_FINITE else (False, ok, "too few finite points")


def equivalent(ours, theirs, up_to_constant=None, force_numeric=False):
    """(passed, how): how is "symbols", "symbolic", "numeric:<points>" or the reason it wasn't decided."""
    S = sage()
    try:
        a, b = parse(ours), parse(theirs)
    except NotDecided as e:
        return False, "not decided: %s" % e
    names = symbols(a) | symbols(b)
    if symbols(a) != symbols(b):
        return False, "symbols"
    try:
        A, B = to_sr(a, S), to_sr(b, S)
    except NotDecided as e:
        return False, "not decided: %s" % e
    except (ArithmeticError, ValueError) as e:
        # (an expression the symbolic ring can't even build, such as 0^-1, has no value to compare)
        return False, "not decided: %s" % type(e).__name__
    if up_to_constant:
        x = S.SR.var(var_name(up_to_constant))
        A, B = S.diff(A, x), S.diff(B, x)
    if not force_numeric:
        try:
            if bool(S.SR(A - B).simplify_full() == 0):
                return True, "symbolic"
        except Exception:
            pass
    passed, n, why = numeric_equal(A, B, names, S)
    return passed, ("numeric:%d" % n) + (" " + why if why else "")


# ---------------------------------------------------------------- oracle-host-limit

HOST_LIMIT_MESSAGES = [
    re.compile(r"^\$IterationLimit::limset: Cannot set \$IterationLimit to .+; value must be an integer between 20 and Infinity\.$"),
    re.compile(r"^\$RecursionLimit::limset: Cannot set \$RecursionLimit to .+; value must be an integer between 20 and 512; .+$"),
]


def host_limit(message, ours, expected):
    """The oracle's refusal is on the closed list, and Sprig gave the accepted value."""
    if not any(p.match(message) for p in HOST_LIMIT_MESSAGES):
        return False, "message not on the list"
    if ours != expected:
        return False, "Sprig refused the setting"
    return True, "listed"


# ---------------------------------------------------------------- controls

def run_controls(path):
    rows = []
    for c in json.load(open(path, encoding="utf-8"))["controls"]:
        k = c["class"]
        try:
            if k == "term-order":
                got, how = term_order(c["ours"], c["theirs"], set(c["orderless"])), "canonical"
            elif k in ("equivalent-form", "oracle-unevaluated", "oracle-wrong"):
                got, how = equivalent(c["ours"], c["theirs"], c.get("up_to_constant"), c.get("force_numeric", False))
            elif k == "oracle-host-limit":
                got, how = host_limit(c["message"], c["ours"], c["expected"])
            elif k == "normalize":
                got, how = normalize(c["theirs"]) == c["ours"], "normalized"
            else:
                got, how = False, "unknown class"
        except NotDecided as e:
            got, how = False, "not decided: %s" % e
        row = {"name": c["name"], "class": k, "expect": c["expect"], "got": "pass" if got else "fail", "how": how}
        # (a control can also name why it must fail or how it must pass, so it can't pass for the wrong reason)
        row["ok"] = row["got"] == row["expect"] and (not c.get("how") or re.search(c["how"], how) is not None)
        rows.append(row)
    return rows


if __name__ == "__main__":
    if sys.argv[1:2] == ["--controls"]:
        rows = run_controls(sys.argv[2] if len(sys.argv) > 2 else os.path.join(HERE, "checker-controls.json"))
        print(json.dumps(rows, indent=1))
        sys.exit(0 if all(r["ok"] for r in rows) else 1)
    if sys.argv[1:2] == ["--census"]:
        print(json.dumps(census(sys.argv[2:]), ensure_ascii=False))
        sys.exit(0)
    sys.exit(__doc__)
