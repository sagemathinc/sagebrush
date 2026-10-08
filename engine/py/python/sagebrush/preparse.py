"""Sage's preparser for CPython: Sage syntax to plain Python over
`sagebrush.sage` (the same rules as src/sagepre.ts, which the browser
runtime uses, plus what its grammar does there: `^` is a power and integer
literals are Sage Integers, so 2/3 is exact).

    from sagebrush.preparse import preparse
    preparse("R.<x> = QQ[]; f = x^2 - 1/2")
    # "R = QQ['x']; (x,) = R._first_ngens(1); f = x**Integer(2) - Integer(1)/Integer(2)"

    [a..b], [a,b..c], (a..b)   ellipsis_range(a,Ellipsis,b), ellipsis_iter(...)
    100r, 1.5r                 raw Python literals: 100, 1.5
    7, 0x1f                    Integer(7), Integer(0x1f)
    1.5, 2e3                   RealNumber('1.5'), RealNumber('2e3')
    a^b, a^^b                  a**b, a ^ b (xor)
    R.0                        R.gen(0)
    R.<x,y> = ...              R = ...; (x, y,) = R._first_ngens(2)
    f(x, y) = expr             __tmp__=var("x,y"); f = symbolic_expression(expr).function(x,y)

Lines keep their numbers; nothing inside string literals or comments
changes (except the fields of f-strings, which are code).
"""

import re

_OPEN, _CLOSE = "([{", ")]}"


def _strip(code):
    """String literals and comments replaced by \\0N\\0 placeholders."""
    lits = []
    out = []
    i, n = 0, len(code)
    while i < n:
        c = code[i]
        if c == "#":
            j = code.find("\n", i)
            e = n if j < 0 else j
            lits.append(code[i:e])
            out.append("\0%d\0" % (len(lits) - 1))
            i = e
            continue
        if c in "'\"":
            triple = code.startswith(c * 3, i)
            q = c * 3 if triple else c
            # (a string prefix, r, b, f, ..., stays in the code)
            j = i + len(q)
            while j < n:
                if code[j] == "\\":
                    j += 2
                    continue
                if code.startswith(q, j):
                    j += len(q)
                    break
                if not triple and code[j] == "\n":
                    break
                j += 1
            lits.append(code[i:j])
            out.append("\0%d\0" % (len(lits) - 1))
            i = j
            continue
        out.append(c)
        i += 1
    return "".join(out), lits


def _restore(code, lits):
    return re.sub(r"\0(\d+)\0", lambda m: lits[int(m.group(1))], code)


def _containing_block(code, i):
    depth, s = 0, i
    while s >= 0:
        ch = code[s]
        if ch in _CLOSE:
            depth += 1
        elif ch in _OPEN:
            if depth == 0:
                break
            depth -= 1
        s -= 1
    if s < 0 or code[s] == "{":
        return None
    depth, e = 0, i
    while e < len(code):
        ch = code[e]
        if ch in _OPEN:
            depth += 1
        elif ch in _CLOSE:
            if depth == 0:
                break
            depth -= 1
        e += 1
    if e >= len(code):
        return None
    return s, e + 1


def _ellipsis(code):
    ix = code.find("..")
    while ix != -1:
        if code[ix + 2:ix + 3] == "." or (ix > 0 and code[ix - 1] == "."):
            ix = code.find("..", ix + 3)
            continue
        b = _containing_block(code, ix)
        if not b:
            ix = code.find("..", ix + 2)
            continue
        s, e = b
        args = code[s + 1:e - 1].replace("..", ",Ellipsis,")
        args = re.sub(r",\s*,", ",", args)
        args = re.sub(r",\s*$", "", args)
        args = re.sub(r";\s*", ", step=", args, count=1)
        kind = "range" if code[s] == "[" else "iter"
        code = "%s(ellipsis_%s(%s))%s" % (code[:s], kind, args, code[e:])
        ix = code.find("..")
    return code


# a number not preceded by an identifier character, a dot or a placeholder
_NUM = re.compile(r"(?<![\w.\0])((?:0[xXoObB][0-9a-fA-F_]+)|(?:\d[\d_]*\.(?:\d[\d_]*)?|\.\d[\d_]*|\d[\d_]*)(?:[eE][+-]?\d[\d_]*)?)([rRjJ]?)(?!\w)")


def _numbers(code):
    # 12.factor() -> (12).factor(), but not 1.e5 or 1.5
    code = re.sub(r"(?<![\w.\0])(\d[\d_]*)\.(?=[A-Za-z_])(?![eE][+-]?\d)", r"(\1).", code)

    def num(m):
        lit, suffix = m.group(1), m.group(2)
        if suffix in ("r", "R"):
            return lit
        if suffix:
            return m.group(0)  # complex: Python's
        if re.match(r"0[xXoObB]", lit):
            return "Integer(%s)" % lit
        if re.search(r"[.eE]", lit):
            return "RealNumber('%s')" % lit.replace("_", "")
        return "Integer(%s)" % lit

    return _NUM.sub(num, code)


def _powers(code):
    return code.replace("^^", "\1").replace("^", "**").replace("\1", "^")


_GENS = re.compile(r"^(\s*)([A-Za-z_]\w*)\.<\s*([A-Za-z_][\w\s,]*)>\s*=\s*(.+?)\s*$")


def _top_semicolon(s):
    depth = 0
    for i, c in enumerate(s):
        if c in "([{":
            depth += 1
        elif c in ")]}":
            depth -= 1
        elif c == ";" and depth == 0:
            return i
    return -1


def _generators(line):
    m = _GENS.match(line)
    if not m:
        return line
    indent, name, gens, rhs_all = m.groups()
    names = [g.strip() for g in gens.split(",") if g.strip()]
    tup = "(%s,)" % ", ".join("'%s'" % g for g in names)
    cut = _top_semicolon(rhs_all)
    rest = "" if cut < 0 else rhs_all[cut:]
    rhs = (rhs_all if cut < 0 else rhs_all[:cut]).rstrip()
    if rhs.endswith("[[]]"):
        # R.<t> = QQ[[]]: power series
        rhs = rhs[:-4] + "[[%s]]" % ", ".join("'%s'" % g for g in names)
    elif rhs.endswith("[]"):
        rhs = rhs[:-2] + "[%s]" % tup
    elif rhs.endswith("()"):
        rhs = rhs[:-1] + "names=%s)" % tup
    elif rhs.endswith(")"):
        rhs = rhs[:-1] + ", names=%s)" % tup
    if rest:
        # the following statements: R.<x> = QQ[]; S.<y> = QQ[]
        rest = "; " + _generators(rest[1:].lstrip())
    return "%s%s = %s; (%s,) = %s._first_ngens(%d)%s" % (indent, name, rhs, ", ".join(names), name, len(names), rest)


_CALC = re.compile(r"^(\s*)([A-Za-z_]\w*)\s*\(([^()=]+)\)\s*=(?!=)\s*(.+)$")


def _calculus(line, lits=()):
    m = _CALC.match(line)
    if not m:
        return line
    indent, f, args, expr = m.groups()
    vs = [v.strip() for v in args.split(",")]
    if not all(re.match(r"^[A-Za-z_]\w*$", v) for v in vs):
        return line
    # f(x) = x^2  # a comment: the comment stays after the definition
    comment = ""
    c = re.search(r"\s*(\0(\d+)\0)\s*$", expr)
    if c and lits and lits[int(c.group(2))].startswith("#"):
        expr, comment = expr[:c.start()], "  " + c.group(1)
    # f(x) = x^2; f: the definition ends at a top-level ';'
    cut = _top_semicolon(expr)
    rest = "" if cut < 0 else expr[cut:]
    expr = expr if cut < 0 else expr[:cut]
    return '%s__tmp__=var("%s"); %s = symbolic_expression(%s).function(%s)%s%s' % (indent, ",".join(vs), f, expr.strip(), ",".join(vs), rest, comment)


def _expression(code):
    code = _ellipsis(code)
    # R.0 -> R.gen(0), QQ['x'].0, C.0.ideal() (a digit after a dot is not a
    # number literal); before the numbers, which would read .0 as a float
    code = re.sub(r"(\b[A-Za-z_]\w*|[)\]])\.(\d+)\b(?![ \t]*[(\w])", r"\1.gen(\2)", code)
    code = _numbers(code)
    code = _powers(code)
    return code


def _fstring(lit):
    out, i = [], 0
    while i < len(lit):
        c = lit[i]
        if c in "{}" and lit[i + 1:i + 2] == c:
            out.append(c + c)
            i += 2
            continue
        if c != "{":
            out.append(c)
            i += 1
            continue
        depth, j = 0, i + 1
        while j < len(lit):
            d = lit[j]
            if d in "([{":
                depth += 1
            elif d in ")]":
                depth -= 1
            elif d == "}" and depth == 0:
                break
            elif d == "}":
                depth -= 1
            elif d in ":!" and depth == 0 and lit[j + 1:j + 2] != "=":
                break
            j += 1
        inner, ls = _strip(lit[i + 1:j])
        out.append("{" + _restore(_expression(inner), ls))
        i = j
    return "".join(out)


def preparse(source):
    """Sage source to Python source (for `from sagebrush.sage import *`)."""
    code, lits = _strip(source)
    code = _expression(code)
    code = "\n".join(_calculus(_generators(line), lits) for line in code.split("\n"))

    def lit(m):
        prefix, k = m.group(1), int(m.group(2))
        s = lits[k]
        if re.search(r"[fF]", prefix):
            s = _fstring(s)
        return prefix + s

    return re.sub(r"([rRbBuUfF]*)\0(\d+)\0", lit, code)
