"""Rill's argument matcher (design/rill.md §4): how a call's arguments meet a
function's formals, as R does, checked before any argument is evaluated.

One path for every function: A1.2's builtins declare their formals as data
here, and A1.3's closures use the same matcher.  Two kinds, as R has them:

- a closure's formals, matched in R's three passes: exact names, then unique
  partial names (only formals before `...`, and only those still unmatched),
  then position; what is left goes to `...`, or is R's "unused argument"
  error.  Names after `...` match exactly or not at all.
- a primitive's fixed arity, with R's own count and name messages.

The texts are R 4.5.3's (rill-tests/args/).  match() returns, for each actual
argument in call order, the formal it matched, or None where it went to `...`;
the evaluator evaluates nothing until it has that plan.
"""

from .eval import RError
from .values import MISSING

DOTS = "..."


class Closure:
    """A closure-like signature: formal names in order (DOTS among them), and the ones with no default, which a
    call must supply: R reads them first, so a call without one is an error before any argument runs."""
    __slots__ = ("formals", "required")

    def __init__(self, *formals, required=()):
        assert all(f in formals and f != DOTS for f in required)
        self.formals = formals
        self.required = required


class Primitive:
    """A primitive's signature: it takes exactly len(names) arguments (or, with
    dots, at least `least` and any more after them, ignored by the caller)."""
    __slots__ = ("names", "dots", "least")

    def __init__(self, *names, dots=False, least=None):
        self.names = names
        self.dots = dots
        self.least = len(names) if least is None else least


def _deparse_args(call, idx):
    """R's "(foo = 1, 5)": the actual arguments at idx, as the call wrote them."""
    from .fmt import deparse_call_line
    from .values import Lang, sym
    text = deparse_call_line(Lang(sym("f"), [call.args[i] for i in idx]))
    return text[1:]


def match(call, sig, name):
    """For each actual argument of `call`, the formal it matches (None: `...`).
    Raises R's error for an argument that matches no formal, a formal matched
    twice, or a partial name matching several formals."""
    if isinstance(sig, Primitive):
        return _match_primitive(call, sig, name)
    formals = sig.formals
    dots_at = formals.index(DOTS) if DOTS in formals else len(formals)
    actuals = call.args
    plan = [None] * len(actuals)
    taken = {}
    # 1: exact names (any formal but ...)
    for i, (an, _) in enumerate(actuals):
        if an is None:
            continue
        if an in formals and an != DOTS:
            if an in taken:
                raise RError('formal argument "%s" matched by multiple actual arguments' % an, call)
            taken[an] = i
            plan[i] = an
    # 2: unique partial names, among the formals before ... that no exact name
    # took; a formal two partial names reach is matched twice (R 4.5.3:
    # numeric(len = 2, le = 3)), while one an exact name took is no candidate
    # (numeric(length = 1, len = 2): len is unused)
    exact = set(taken)
    for i, (an, _) in enumerate(actuals):
        if an is None or plan[i] is not None or an == "":
            continue
        hits = [f for f in formals[:dots_at] if f != DOTS and f not in exact and f.startswith(an)]
        if len(hits) > 1:
            raise RError("argument %d matches multiple formal arguments" % (i + 1), call)
        if hits:
            if hits[0] in taken:
                raise RError('formal argument "%s" matched by multiple actual arguments' % hits[0], call)
            taken[hits[0]] = i
            plan[i] = hits[0]
    # 3: position: unnamed actuals fill the unmatched formals before ...
    free = [f for f in formals[:dots_at] if f not in taken]
    unused = []
    for i, (an, v) in enumerate(actuals):
        if plan[i] is not None:
            continue
        if an is None and free:
            plan[i] = free.pop(0)
            taken[plan[i]] = i
        elif dots_at < len(formals):
            plan[i] = None          # (into ...)
        else:
            unused.append(i)
    if unused:
        word = "argument" if len(unused) == 1 else "arguments"
        raise RError("unused %s %s" % (word, _deparse_args(call, unused)), call)
    return plan


def _match_primitive(call, sig, name):
    actuals = call.args
    n = len(actuals)
    if (n != len(sig.names) and not sig.dots) or n < sig.least:
        word = "argument" if n == 1 else "arguments"
        need = len(sig.names)
        raise RError("%d %s passed to '%s' which requires %d" % (n, word, name, need), call)
    plan = []
    for i, (an, _) in enumerate(actuals):
        formal = sig.names[i] if i < len(sig.names) else None
        if an is not None and formal is not None and an != formal:
            raise RError("supplied argument name '%s' does not match '%s'" % (an, formal), call)
        plan.append(formal)
    return plan


def check_required(call, sig, plan):
    """R's error for a formal with no default that no argument matched, before any argument is evaluated
    (astra's and daybreak3's #999 MISSING-2 / FORMALS-1; rill-tests/access/#is-vector-missing-x-first)."""
    for formal in getattr(sig, "required", ()):
        if formal not in plan:
            raise RError('argument "%s" is missing, with no default' % formal, call)


def is_missing(v):
    return v is MISSING
