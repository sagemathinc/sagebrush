"""Helpers for a board question's `check` (web/board-format.md, "Teaching"):
each compares the reader's answer with the expected one and returns a
Verdict, right, wrong or can't decide, with a short reason a hint can show.

    close(answer, pi, rel=1e-9)
    same_set(answer, [1, 2, 3])
    same_sequence(answer, [1, 1, 2, 3, 5], ordered=True)
    same_group(answer, SymmetricGroup(3))
    symbolic_equal(answer, (x + 1)^2)        (Sage)

A Verdict as a check's value: the board's check runtime (lib/_sb_check.py)
calls its __sagebrush_verdict__, which gives True (right), the reason (wrong)
or {"undecided": reason} (not an attempt, no hint). v.verdict() gives True or
the reason and raises CannotDecide when it can't decide; bool(v) is True only
when right, and raises CannotDecide too: never a guess. The module imports
nothing of Sage until a helper that needs it is called.
What a helper can't handle (a type it doesn't know, a missing tolerance)
raises: the check then decides nothing.
"""

import itertools
import math
from fractions import Fraction

__all__ = ["Verdict", "CannotDecide", "close", "same_set", "same_multiset", "same_sequence",
           "same_group", "same_permutation", "symbolic_equal", "parse_number", "parse_list", "parse_expression"]

# the most items read from an answer or an expected collection
MAX_ITEMS = 100000
# items named in a reason
SHOWN = 3


class CannotDecide(Exception):
    """A check that can't decide: not an attempt, and the reason is shown.

    EXAMPLES::

        sage: from board_checks import *
        sage: str(CannotDecide("too hard"))
        'too hard'
    """


class Verdict:
    """What a helper decided: ok is True (right), False (wrong) or None
    (can't decide), with a short reason (Markdown).

    EXAMPLES::

        sage: from board_checks import *
        sage: v = same_set([1, 2], [2, 1]); v.ok, v.verdict(), bool(v)
        (True, True, True)
        sage: w = same_set([1], [1, 2]); w.ok, w.verdict()
        (False, 'it is missing $2$')
    """

    __slots__ = ("ok", "reason")

    def __init__(self, ok, reason=""):
        if ok not in (True, False, None):
            raise TypeError("a Verdict is True, False or None")
        self.ok = ok
        self.reason = str(reason)

    def verdict(self):
        """The check's value: True, the reason (wrong), or CannotDecide raised."""
        if self.ok is None:
            raise CannotDecide(self.reason or "the check could not decide")
        if self.ok:
            return True
        return self.reason or "not right"

    def __sagebrush_verdict__(self):
        """The board's check runtime's value: True, the reason, or
        {"undecided": reason}."""
        if self.ok is None:
            return {"undecided": self.reason or "the check could not decide"}
        return True if self.ok else (self.reason or "not right")

    def __bool__(self):
        if self.ok is None:
            raise CannotDecide(self.reason or "the check could not decide")
        return self.ok

    def __repr__(self):
        return "Verdict(%r, %r)" % (self.ok, self.reason)


def _right(reason=""):
    return Verdict(True, reason)


def _wrong(reason):
    return Verdict(False, reason)


def _items(xs, what):
    """xs as a list, at most MAX_ITEMS of them (an endless iterable refused);
    a string is read by parse_list."""
    if isinstance(xs, str):
        return parse_list(xs)
    if isinstance(xs, bytes):
        raise TypeError("%s: give a collection, not bytes" % what)
    try:
        it = iter(xs)
    except TypeError:
        raise TypeError("%s: %s is not a collection" % (what, type(xs).__name__))
    out = list(itertools.islice(it, MAX_ITEMS + 1))
    if len(out) > MAX_ITEMS:
        raise ValueError("%s: more than %d items" % (what, MAX_ITEMS))
    return out


def _tex(v):
    """v for a reason, as math: its LaTeX if it has one, else str."""
    f = getattr(v, "_latex_", None)
    s = None
    if callable(f):
        try:
            s = str(f())
        except Exception:
            s = None
    if s is None:
        s = str(v)
    if len(s) > 80:
        s = s[:77] + "..."
    return "$" + s.replace("$", "\\$") + "$"


def _list(vs):
    vs = list(vs)
    shown = ", ".join(_tex(v) for v in vs[:SHOWN])
    return shown + (" and %d more" % (len(vs) - SHOWN) if len(vs) > SHOWN else "")


# --------------------------------------------------------------- parsing
# A text answer (an input of kind text) is a string: these read one without
# evaluating it as code, within bounds; the helpers call them on a string.
MAX_TEXT = 100000
_NUM = None


def parse_number(s):
    """A number written as text: an integer, a decimal (also 1e-3), or a
    fraction p/q, read exactly (int or Fraction; a decimal is its exact
    decimal value). Anything else is a ValueError; nothing is evaluated.

    EXAMPLES::

        sage: from board_checks import *
        sage: parse_number(' -12 '), parse_number('3.25'), parse_number('2/6'), parse_number('1e-3')
        (-12, Fraction(13, 4), Fraction(1, 3), Fraction(1, 1000))
        sage: parse_number('2**10')
        Traceback (most recent call last):
        ...
        ValueError: not a number: '2**10'
    """
    import re
    from fractions import Fraction
    global _NUM
    if not isinstance(s, str):
        raise TypeError("parse_number: give a string")
    t = s.strip().replace("\u2212", "-")
    if len(t) > 200:
        raise ValueError("not a number: more than 200 characters")
    if _NUM is None:
        _NUM = re.compile(r"^([+-]?)(?:(\d+)/(\d+)|(\d+(?:\.\d*)?|\.\d+)(?:[eE]([+-]?\d{1,4}))?)$")
    m = _NUM.match(t)
    if m is None:
        raise ValueError("not a number: %r" % s[:60])
    sign = -1 if m.group(1) == "-" else 1
    if m.group(2) is not None:
        q = int(m.group(3))
        if q == 0:
            raise ValueError("not a number: a fraction over 0")
        return sign * Fraction(int(m.group(2)), q)
    if m.group(5) is not None and builtins_abs(int(m.group(5))) > 1000:
        raise ValueError("not a number: an exponent beyond 1000")
    v = Fraction(m.group(4)) * (Fraction(10) ** int(m.group(5) or 0))
    v = sign * v
    return int(v) if v.denominator == 1 and "." not in m.group(4) and m.group(5) is None else v


def parse_list(s):
    """A list written as text, '1, 2, 3', '[1, 2, 3]', '{1, 2}' or '(1, 2)':
    its items, each a number (parse_number) if it reads as one, else the
    item's text. One level: no lists inside lists. Nothing is evaluated.

    EXAMPLES::

        sage: from board_checks import *
        sage: parse_list('{1, 2, 3/4}')
        [1, 2, Fraction(3, 4)]
        sage: parse_list('[a, b , 3]'), parse_list(''), parse_list('[]')
        (['a', 'b', 3], [], [])
    """
    if not isinstance(s, str):
        raise TypeError("parse_list: give a string")
    if len(s) > MAX_TEXT:
        raise ValueError("parse_list: more than %d characters" % MAX_TEXT)
    t = s.strip()
    if len(t) >= 2 and (t[0], t[-1]) in (("[", "]"), ("{", "}"), ("(", ")")):
        t = t[1:-1].strip()
    if not t:
        return []
    if any(c in t for c in "[]{}"):
        raise ValueError("parse_list: a list inside a list is not read")
    out = []
    for item in t.split(","):
        item = item.strip()
        try:
            out.append(parse_number(item))
        except ValueError:
            out.append(item)
        if len(out) > MAX_ITEMS:
            raise ValueError("parse_list: more than %d items" % MAX_ITEMS)
    return out


# (a text expression's functions and constants; any other name is a variable)
_FUNCTIONS = ("sin", "cos", "tan", "cot", "sec", "csc", "asin", "acos", "atan", "arcsin", "arccos", "arctan",
              "sinh", "cosh", "tanh", "exp", "log", "ln", "sqrt", "abs")
_CONSTANTS = ("pi", "e", "I", "i")
MAX_EXPRESSION = 1000
MAX_POWER = 1000


def parse_expression(s):
    """A Sage expression written as text, read by a small parser, never
    evaluated as code: numbers, names (variables, or pi, e, I), + - * / ^ **,
    parentheses, the functions sin cos tan ... exp log ln sqrt abs, and a
    number or ) followed by a name or ( (2x, 2(x+1), (x+1)(x-1)) as a
    product. At most 1000 characters, 100 levels of parentheses, and a
    number to a numeric power above 1000 refused. Sage boards only.

    EXAMPLES::

        sage: from board_checks import *
        sage: parse_expression('2x^2 + 3(x - 1)')
        2*x^2 + 3*x - 3
        sage: parse_expression('sin(x)^2 + cos(x)^2').simplify_full()
        1
        sage: parse_expression('__import__("os")')
        Traceback (most recent call last):
        ...
        ValueError: parse_expression: unexpected '"' at 11
    """
    try:
        import sage_all as S
    except ImportError:
        raise NotImplementedError("parse_expression needs a Sage board")
    if not isinstance(s, str):
        raise TypeError("parse_expression: give a string")
    if len(s) > MAX_EXPRESSION:
        raise ValueError("parse_expression: more than %d characters" % MAX_EXPRESSION)
    return _Parser(s, S).parse()


class _Parser:
    def __init__(self, s, S):
        import re
        self.S = S
        self.src = s
        self.toks = []
        # (2e3x: 2000x or 2*e3x? refused rather than read either way)
        if re.search(r"(?:\d|\.)[eE][+-]?\d+[A-Za-z_.]", s):
            raise ValueError("parse_expression: a number in scientific notation followed by a name: write 2e3*x or 2*e3x")
        pos = 0
        # (a number as parse_number reads it, scientific too: 1e-3 is 1/1000,
        # never 1*e - 3; "2e" alone, or 2e followed by a name, is 2*e)
        tok = re.compile(r"\s*(?:((?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+(?![A-Za-z_0-9.]))?)|([A-Za-z_][A-Za-z_0-9]*)|(\*\*|[-+*/^(),]))")
        while pos < len(s):
            if s[pos:].strip() == "":
                break
            m = tok.match(s, pos)
            if m is None:
                c = s[pos:].lstrip()[:1]
                raise ValueError("parse_expression: unexpected %r at %d" % (c, len(s) - len(s[pos:].lstrip())))
            num, name, op = m.groups()
            self.toks.append(("num", num) if num else ("name", name) if name else ("op", "^" if op == "**" else op))
            pos = m.end()
        self.k = 0
        self.depth = 0

    def peek(self):
        return self.toks[self.k] if self.k < len(self.toks) else (None, None)

    def take(self, op=None):
        t = self.peek()
        if op is not None and t != ("op", op):
            raise ValueError("parse_expression: expected %r" % op)
        self.k += 1
        return t

    def parse(self):
        if not self.toks:
            raise ValueError("parse_expression: empty")
        v = self.sum()
        if self.k != len(self.toks):
            raise ValueError("parse_expression: unexpected %r" % (self.peek()[1],))
        return v

    def sum(self):
        v = self.product()
        while self.peek() in (("op", "+"), ("op", "-")):
            op = self.take()[1]
            w = self.product()
            v = v + w if op == "+" else v - w
        return v

    def product(self):
        v = self.unary()
        while True:
            t = self.peek()
            if t in (("op", "*"), ("op", "/")):
                self.take()
                w = self.unary()
                if t[1] == "/" and w == 0:
                    raise ValueError("parse_expression: division by 0")
                v = v * w if t[1] == "*" else v / w
            elif t[0] in ("num", "name") or t == ("op", "("):
                v = v * self.power()  # (2x, 2(x+1), (x+1)(x-1))
            else:
                return v

    def unary(self):
        if self.peek() == ("op", "-"):
            self.take()
            return -self.unary()
        if self.peek() == ("op", "+"):
            self.take()
            return self.unary()
        return self.power()

    def power(self):
        b = self.atom()
        if self.peek() == ("op", "^"):
            self.take()
            ex = self.unary()
            try:
                big = ex.is_constant() and b.is_constant() and abs(ex.n()) > MAX_POWER
            except Exception:
                big = False
            if big:
                raise ValueError("parse_expression: a power above %d" % MAX_POWER)
            return b ** ex
        return b

    def atom(self):
        S = self.S
        kind, v = self.take()
        if kind == "num":
            # (30 digits in the mantissa, the exponent aside, HARD-502-1)
            if sum(c.isdigit() for c in v.split("e")[0].split("E")[0]) > 30:
                raise ValueError("parse_expression: a number of more than 30 digits")
            q = parse_number(v)
            return S.SR(S.Integer(q) if isinstance(q, int) else S.QQ(q.numerator) / S.QQ(q.denominator))
        if kind == "name":
            if v in _FUNCTIONS:
                self.take("(")
                self.enter()
                arg = self.sum()
                self.take(")")
                self.depth -= 1
                f = {"ln": "log", "arcsin": "asin", "arccos": "acos", "arctan": "atan"}.get(v, v)
                return getattr(S, f)(arg)
            if v in _CONSTANTS:
                return {"pi": S.pi, "e": S.e, "I": S.I, "i": S.I}[v]
            return S.var(v)
        if (kind, v) == ("op", "("):
            self.enter()
            x = self.sum()
            self.take(")")
            self.depth -= 1
            return x
        raise ValueError("parse_expression: unexpected %r" % (v,))

    def enter(self):
        self.depth += 1
        if self.depth > 100:
            raise ValueError("parse_expression: more than 100 levels of parentheses")


# --------------------------------------------------------------- numbers
def _number(v, what):
    """v as a Python complex or float, for comparing; what can't be refused."""
    if isinstance(v, bool):
        raise TypeError("%s: a bool is not a number here" % what)
    if isinstance(v, (int, float)):
        return float(v)
    if isinstance(v, complex):
        return v
    for conv in (float, complex):
        try:
            return conv(v)
        except OverflowError:
            raise
        except Exception:
            continue
    raise TypeError("%s: %s is not a number" % (what, type(v).__name__))


def close(answer, expected, rel=None, abs=None):
    """Right when |answer - expected| <= max(rel * |expected|, abs). Give
    at least one tolerance. Real or complex numbers (ints, floats,
    fractions, Sage numbers and exact constants with a numeric value); nan
    is never close, an infinity only to itself.

    EXAMPLES::

        sage: from board_checks import *
        sage: close(3.14159, pi, rel=1e-5).ok, close(3.14, pi, rel=1e-5).verdict()
        (True, 'off by about $0.00159$, more than the tolerance')
        sage: close(1, 1.05, abs=0.1).ok
        True
        sage: close(1, 2)
        Traceback (most recent call last):
        ...
        ValueError: close: give a tolerance, rel= or abs=
    """
    if rel is None and abs is None:
        raise ValueError("close: give a tolerance, rel= or abs=")
    # (each tolerance exact, its sign checked as it is, before anything
    # else: a tiny negative one must not round to -0.0, CORR-230-2)
    tols = []
    for t in (rel, abs):
        if t is None:
            tols.append(Fraction(0))
            continue
        q = _exact_complex(t)
        if q is None or q[1] != 0 or isinstance(t, bool):
            raise ValueError("close: a tolerance is a finite real number (an int, a fraction, a float or a Sage real), at least 0")
        if q[0] < 0:
            raise ValueError("close: a tolerance is a finite number, at least 0")
        tols.append(q[0])
    qr, qb = tols
    if isinstance(answer, str):
        answer = parse_number(answer)
    if isinstance(expected, str):
        expected = parse_number(expected)
    # (nan and infinities: only values that are one, never a finite number
    # a float could not hold, CORR-502-2)
    if _nan(answer):
        return _wrong("it is not a number")
    if _nan(expected):
        return Verdict(None, "the expected value is not a number")
    ia, ie = _infinite(answer), _infinite(expected)
    if ia or ie:
        if ia and ie:
            try:
                same = complex(answer) == complex(expected)
            except Exception:
                return Verdict(None, "the check could not compare these infinities")
            return _right() if same else _wrong("it is %s, not %s" % (_inf(complex(answer)), _inf(complex(expected))))
        return _wrong("it is %s, not %s" % ("infinite" if ia else "finite", "finite" if ia else "infinite"))
    # (exactly, when both are numbers with rational parts, complex ones too,
    # Sage reals as the dyadic rationals they are: |d|^2 <= max(rel^2 |e|^2,
    # abs^2), nothing rounded, CORR-230-1, CORR-502-1)
    qa, qe = _exact_complex(answer), _exact_complex(expected)
    if qa is not None and qe is not None:
        dr, di = qa[0] - qe[0], qa[1] - qe[1]
        d2, e2 = dr * dr + di * di, qe[0] * qe[0] + qe[1] * qe[1]
        if d2 <= max(qr * qr * e2, qb * qb):
            return _right()
        return _wrong("off by %s%s, more than the tolerance" % (
            _sci_exact(d2, root=True), " (relative %s)" % _sci_exact(d2 / e2, root=True) if e2 else ""))
    # (something not a number is refused, as before: the check decides nothing)
    for v, what in ((answer, "the answer"), (expected, "the expected value")):
        if _exact_complex(v) is None:
            try:
                _number(v, "close: " + what)
            except OverflowError:
                pass
    # (an irrational real, pi or sqrt(2): a certified enclosure, right only
    # if all of |d| is within the tolerance, wrong only if all of it is
    # beyond; else undecided)
    for prec in (128, 1024):
        got = _by_intervals(answer, expected, qr, qb, prec)
        if got is not None:
            return got
    return Verdict(None, "the check could not decide whether these are close")


def _nan(v):
    if isinstance(v, float):
        return v != v
    if isinstance(v, complex):
        return v.real != v.real or v.imag != v.imag
    f = getattr(v, "is_NaN", None)
    try:
        return bool(f()) if callable(f) else False
    except Exception:
        return False


def _by_intervals(answer, expected, qr, qb, prec):
    """close's verdict from enclosures at prec bits (Sage), or None when they
    are too wide to decide (or there are none)."""
    try:
        import sage_all as S
        RIF = S.RealIntervalField(prec)
        a = RIF(answer if _exact_complex(answer) is None else _qq(S, _exact_complex(answer)))
        e = RIF(expected if _exact_complex(expected) is None else _qq(S, _exact_complex(expected)))
        d = a - e
        dl, dh = _iv(d)
        el, eh = _iv(e)
    except Exception:
        return None
    # |d| and |e| as exact intervals
    ad = (Fraction(0) if dl <= 0 <= dh else min(builtins_abs(dl), builtins_abs(dh)), max(builtins_abs(dl), builtins_abs(dh)))
    ae = (Fraction(0) if el <= 0 <= eh else min(builtins_abs(el), builtins_abs(eh)), max(builtins_abs(el), builtins_abs(eh)))
    tlo, thi = max(qr * ae[0], qb), max(qr * ae[1], qb)
    if ad[1] <= tlo:
        return _right()
    if ad[0] > thi:
        mid = (ad[0] + ad[1]) / 2
        return _wrong("off by about %s, more than the tolerance" % _sci_exact(mid))
    return None


def _qq(S, q):
    if q[1] != 0:
        raise TypeError("complex")
    return S.QQ(q[0].numerator) / S.QQ(q[0].denominator)


def _iv(x):
    """an interval's endpoints as exact Fractions"""
    lo, hi = x.lower(), x.upper()
    return _rational(lo.exact_rational()), _rational(hi.exact_rational())


def _exact_complex(v):
    """v as exact (real, imaginary) Fractions: an int, Fraction, finite
    float, complex of finite parts, Sage rational, or a finite Sage real or
    complex number (exactly the dyadic rational it is); else None."""
    if isinstance(v, complex):
        if not (math.isfinite(v.real) and math.isfinite(v.imag)):
            return None
        return (Fraction(v.real), Fraction(v.imag))
    q = _rational(v)
    if q is not None:
        return (q, Fraction(0))
    if isinstance(v, (int, float, str, bool)):
        return None
    re_im = None
    if callable(getattr(v, "exact_rational", None)):
        re_im = (v, None)
    elif callable(getattr(v, "real", None)) and callable(getattr(v, "imag", None)) and type(v).__name__.startswith("Complex"):
        try:
            re_im = (v.real(), v.imag())
        except Exception:
            return None
    if re_im is None:
        return None
    out = []
    for part in re_im:
        if part is None:
            out.append(Fraction(0))
            continue
        if _infinite(part) or getattr(part, "is_NaN", lambda: False)():
            return None
        try:
            r = _rational(part.exact_rational())
        except Exception:
            return None
        if r is None:
            return None
        out.append(r)
    return tuple(out)


def _infinite(v):
    """whether v is an infinity itself (not a finite number a float can't hold)"""
    if isinstance(v, (float, complex)):
        return math.isinf(v.real) or math.isinf(v.imag) if isinstance(v, complex) else math.isinf(v)
    f = getattr(v, "is_infinity", None)
    if callable(f):
        try:
            return bool(f())
        except Exception:
            return False
    return str(v) in ("+Infinity", "-Infinity", "Infinity")


def _sci_exact(q, root=False):
    """a non-negative Fraction (its square root, with root) for a reason, to
    3 significant digits (truncated), however small or large: integer
    arithmetic, no underflow to 0, no overflow."""
    n, d = q.numerator, q.denominator
    if n == 0:
        return "$0$"
    # (k with 100 <= v * 10^k < 1000, v the value: from the digit counts,
    # then corrected)
    est = (len(str(n)) - len(str(d))) // (2 if root else 1)
    k = 2 - est
    for _ in range(8):
        if root:
            v = math.isqrt(n * 10 ** (2 * k) // d) if k >= 0 else math.isqrt(n // (d * 10 ** (-2 * k)))
        else:
            v = n * 10 ** k // d if k >= 0 else n // (d * 10 ** (-k))
        if v < 100:
            k += 1
        elif v >= 1000:
            k -= 1
        else:
            break
    exp = 2 - k
    digits = str(v).rstrip("0") or "0"
    mant = digits[0] + ("." + digits[1:] if len(digits) > 1 else "")
    if -4 <= exp < 6:
        f = Fraction(v, 10 ** k) if k >= 0 else Fraction(v * 10 ** (-k))
        whole, frac = divmod(f.numerator, f.denominator)
        if frac == 0:
            return "$%d$" % whole
        places = max(k, 0)
        return "$%s$" % ("%d.%s" % (whole, str(frac * 10 ** places // f.denominator).rjust(places, "0").rstrip("0")))
    return "$%s \\times 10^{%d}$" % (mant, exp)


import builtins as _b
builtins_abs = _b.abs


def _rational(v):
    """v as an exact Fraction if it is an int, a Fraction, a float or a Sage
    rational number, else None."""
    from fractions import Fraction
    if isinstance(v, bool):
        return None
    if isinstance(v, (int, Fraction)):
        return Fraction(v)
    if isinstance(v, float):
        return Fraction(v) if math.isfinite(v) else None
    num, den = getattr(v, "numerator", None), getattr(v, "denominator", None)
    if callable(num) and callable(den) and type(v).__name__ in ("Integer", "Rational"):
        try:
            return Fraction(int(num()), int(den()))
        except Exception:
            return None
    return None


def _inf(z):
    """an infinite or finite number for a reason: $\\infty$, $-\\infty$, or finite"""
    if isinstance(z, complex):
        return "a complex infinity" if math.isinf(z.real) or math.isinf(z.imag) else "finite"
    return ("$\\infty$" if z > 0 else "$-\\infty$") if math.isinf(z) else "finite"


def _sci(v):
    s = "%.3g" % v
    if "e" in s:
        m, ex = s.split("e")
        return "$%s \\times 10^{%d}$" % (m, int(ex))
    return "$%s$" % s


# ------------------------------------------------------------ collections
def same_set(answer, expected):
    """Right when they are equal as sets (order and repeats aside).

    EXAMPLES::

        sage: from board_checks import *
        sage: same_set({3, 1, 2}, [1, 2, 3, 3]).ok
        True
        sage: same_set([1, 5], [1, 2]).verdict()
        'it is missing $2$; $5$ is not in it'
    """
    a = _items(answer, "same_set: the answer")
    e = _items(expected, "same_set: the expected set")
    try:
        sa, se = set(a), set(e)
    except TypeError as err:
        raise TypeError("same_set: items must be hashable (%s)" % err)
    if sa == se:
        return _right()
    return _wrong(_diff(se - sa, sa - se))


def _diff(missing, extra):
    parts = []
    if missing:
        parts.append("it is missing %s" % _list(_sorted(missing)))
    if extra:
        parts.append("%s %s not in it" % (_list(_sorted(extra)), "is" if len(extra) == 1 else "are"))
    return "; ".join(parts)


def _sorted(vs):
    try:
        return sorted(vs)
    except TypeError:
        return sorted(vs, key=repr)


def same_multiset(answer, expected):
    """Right when they are equal with their repeats (order aside).

    EXAMPLES::

        sage: from board_checks import *
        sage: same_multiset([2, 1, 2], [1, 2, 2]).ok
        True
        sage: same_multiset([1, 2], [1, 2, 2]).verdict()
        '$2$ appears 1 time, not 2'
    """
    a = _items(answer, "same_multiset: the answer")
    e = _items(expected, "same_multiset: the expected multiset")
    from collections import Counter
    try:
        ca, ce = Counter(a), Counter(e)
    except TypeError as err:
        raise TypeError("same_multiset: items must be hashable (%s)" % err)
    if ca == ce:
        return _right()
    bad = [v for v in _sorted(set(ca) | set(ce)) if ca[v] != ce[v]]
    v = bad[0]
    times = lambda n: "%d time%s" % (n, "" if n == 1 else "s")
    reason = "%s appears %s, not %d" % (_tex(v), times(ca[v]), ce[v])
    if len(bad) > 1:
        reason += " (and %d more differ%s)" % (len(bad) - 1, "s" if len(bad) == 2 else "")
    return _wrong(reason)


def same_sequence(answer, expected, ordered=True):
    """Right when they are equal item by item (ordered=False: as multisets).

    EXAMPLES::

        sage: from board_checks import *
        sage: same_sequence([1, 1, 2, 3], (1, 1, 2, 3)).ok
        True
        sage: same_sequence([1, 2, 4], [1, 2, 3]).verdict()
        'item 3 is $4$, not $3$'
        sage: same_sequence([3, 1, 2], [1, 2, 3], ordered=False).ok
        True
    """
    if not ordered:
        return same_multiset(answer, expected)
    a = _items(answer, "same_sequence: the answer")
    e = _items(expected, "same_sequence: the expected sequence")
    for i, (x, y) in enumerate(zip(a, e)):
        if not _eq(x, y):
            return _wrong("item %d is %s, not %s" % (i + 1, _tex(x), _tex(y)))
    if len(a) != len(e):
        return _wrong("it has %d item%s, not %d" % (len(a), "" if len(a) == 1 else "s", len(e)))
    return _right()


def _eq(x, y):
    r = x == y
    if r is True or r is False:
        return r
    # (a Sage relation, an array: decided, or refused)
    try:
        return bool(r)
    except Exception:
        raise TypeError("cannot compare %s with %s" % (type(x).__name__, type(y).__name__))


# ------------------------------------------------------------ permutations
def _perm(v, n, what):
    from sage_permgroup import PermutationGroupElement, SymmetricGroup
    if isinstance(v, PermutationGroupElement):
        g = v
    else:
        try:
            g = PermutationGroupElement(v)
        except Exception as err:
            raise TypeError("%s: %r is not a permutation (%s)" % (what, v, err))
    return g


def same_permutation(answer, expected):
    """Right when they are the same permutation; cycle strings ('(1,2,3)'),
    tuples of cycles, lists of images and group elements are read.

    EXAMPLES::

        sage: from board_checks import *
        sage: same_permutation('(1,2,3)', PermutationGroupElement([(1,2,3)])).ok
        True
        sage: same_permutation('(1,3,2)', '(1,2,3)').verdict()
        'it sends $1$ to $3$, not to $2$'
    """
    a = _perm(answer, None, "same_permutation: the answer")
    e = _perm(expected, None, "same_permutation: the expected permutation")
    n = max(_degree(a), _degree(e))
    ia, ie = _images(a, n), _images(e, n)
    for i in range(1, n + 1):
        if ia[i] != ie[i]:
            return _wrong("it sends %s to %s, not to %s" % (_tex(i), _tex(ia[i]), _tex(ie[i])))
    return _right()


def _degree(g):
    d = getattr(g, "_im", None)
    if d is not None:
        return len(d)
    return max([1] + [x for c in g.cycle_tuples() for x in c])


def _images(g, n):
    return {i: g(i) if i <= _degree(g) else i for i in range(1, n + 1)}


def same_group(answer, expected):
    """Right when they are the same permutation group (the same elements);
    a list of generators is read as the group they generate.

    EXAMPLES::

        sage: from board_checks import *
        sage: same_group(PermutationGroup(['(1,2)', '(1,2,3)']), SymmetricGroup(3)).ok
        True
        sage: same_group(['(1,2,3)'], SymmetricGroup(3)).verdict()
        'it has order $3$, not $6$'
    """
    from sage_permgroup import PermutationGroup
    a = answer if isinstance(answer, PermutationGroup) else _group(answer, "same_group: the answer")
    e = expected if isinstance(expected, PermutationGroup) else _group(expected, "same_group: the expected group")
    oa, oe = a.order(), e.order()
    if oa != oe:
        return _wrong("it has order %s, not %s" % (_tex(oa), _tex(oe)))
    for g in a.gens():
        if g not in e:
            return _wrong("%s is in it, but not in the expected group" % _tex(g))
    return _right()


def _group(gens, what):
    from sage_permgroup import PermutationGroup
    gs = _items(gens, what)
    try:
        return PermutationGroup(gs)
    except Exception as err:
        raise TypeError("%s: not a group or a list of generators (%s)" % (what, err))


# ------------------------------------------------------------ symbolic
# the exact points tried, for a difference that does not simplify to 0
_POINTS = [(1, 2), (2, 3), (3, 5), (5, 7), (7, 3)]


def symbolic_equal(answer, expected):
    """Equality as expressions: right when answer - expected simplifies to
    exactly 0, so cancellation counts (x^2/x equals x, though x^2/x is not
    defined at 0): an algebraic equality, not equality of functions on a
    domain. Wrong only with a proof: a point with positive rational
    coordinates where each side, on its own, evaluates to an exact rational
    and the two differ. Else it can't decide; sampling never makes it right.
    With assumptions in force (assume()), it only simplifies: a point might
    break them. A string is read by parse_expression. Sage boards only.

    EXAMPLES::

        sage: from board_checks import *
        sage: symbolic_equal((x + 1)^2, x^2 + 2*x + 1).ok
        True
        sage: symbolic_equal('x^2 + 2*x', x^2 + 2*x + 1).verdict()
        'they differ at $x = 1/2$'
        sage: symbolic_equal(sin(x)^2, 1 - cos(x)^2).ok
        True
    """
    try:
        import sage_all
    except ImportError:
        raise NotImplementedError("symbolic_equal needs a Sage board")
    SR = sage_all.SR
    a = _sym(answer, sage_all, "symbolic_equal: the answer")
    e = _sym(expected, sage_all, "symbolic_equal: the expected expression")
    d = a - e
    try:
        if d.is_zero():
            return _right()
    except Exception:
        pass
    try:
        assumed = bool(sage_all.assumptions())
    except Exception:
        assumed = False
    if assumed:
        return Verdict(None, "the check could not decide whether these are equal (with assumptions in force)")
    vs = _sorted(set(a.variables()) | set(e.variables()), )
    QQ = sage_all.QQ
    for k in range(len(_POINTS)):
        at = {v: QQ(_POINTS[(k + j) % len(_POINTS)][0]) / QQ(_POINTS[(k + j) % len(_POINTS)][1]) for j, v in enumerate(vs)}
        try:
            va = _exact(a, at, QQ)
            ve = _exact(e, at, QQ)
        except Exception:
            continue
        if va is None or ve is None:
            continue
        if va != ve:
            where = ", ".join("%s = %s" % (v, at[v]) for v in vs)
            return _wrong("they differ at $%s$" % where if vs else "they are different numbers")
    return Verdict(None, "the check could not decide whether these are equal")


def _sym(v, S, what):
    if isinstance(v, str):
        return parse_expression(v)
    try:
        return S.SR(v)
    except Exception as err:
        raise TypeError("%s: %s is not an expression (%s)" % (what, type(v).__name__, err))


def _exact(expr, at, QQ):
    """expr at the point, as an exact rational, or None if it isn't one."""
    v = expr.subs(at) if at else expr
    try:
        v = v.simplify_full()
    except Exception:
        pass
    try:
        q = QQ(v)
    except Exception:
        return None
    return q
