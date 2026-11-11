"""Sprig's patterns (design/sprig-mvp.md §5.2, §8.3): matching, substitution, and the specificity order of
definitions.

The matcher runs on the evaluator's stack.  `match` is a generator: a Condition or a PatternTest yields
("eval", e) to have e evaluated by the trampoline, and the matcher resumes with its value, so a condition never
re-enters `evaluate`.  Matching itself is iterative: the goals still to meet are a linked list, and each place with
more than one way to match (an Alternatives, a sequence pattern's length, an Optional) is a choice point on an explicit
stack, tried in order and backtracked to on failure.  The choice points are reserved against the session's memory as
they grow (§8.4), and given back however the match ends.

S1.2 matches without Orderless or Flat (S3 has those): a call's arguments are matched in order.
"""

from . import mem
from .expr import Expr, Sym, LIST, TRUE, same, head_of, size_of

PATTERN, BLANK, BLANK_SEQ, BLANK_NULL_SEQ = Sym("Pattern"), Sym("Blank"), Sym("BlankSequence"), Sym("BlankNullSequence")
ALTERNATIVES, CONDITION, PATTERN_TEST, OPTIONAL = Sym("Alternatives"), Sym("Condition"), Sym("PatternTest"), Sym("Optional")
HOLD_PATTERN, SEQUENCE = Sym("HoldPattern"), Sym("Sequence")
PATTERN_HEADS = (PATTERN, BLANK, BLANK_SEQ, BLANK_NULL_SEQ, ALTERNATIVES, CONDITION, PATTERN_TEST, OPTIONAL,
                 HOLD_PATTERN)
# the choice-point stack is reserved in chunks of this many entries
CHOICE_CHUNK = 1024


def _is(e, head):
    return type(e) is Expr and e.head is head


def has_pattern(e):
    """Whether e contains a pattern object anywhere (iterative)."""
    stack = [e]
    while stack:
        x = stack.pop()
        if type(x) is Expr:
            if x.head in PATTERN_HEADS:
                return True
            stack.append(x.head)
            stack.extend(x.args)
    return False


def _seq_kind(p):
    """For a pattern in an argument list: (min length, the blank's head or None, the name or None, its conditions,
    its tests) when it matches a sequence of arguments, else None.  A Condition around it (x__ /; c) is checked once
    the sequence is bound; a PatternTest (x__?t) tests each of the sequence's elements."""
    conds, tests = [], []
    q = p
    while True:
        if _is(q, CONDITION) and len(q.args) == 2:
            conds.append(q.args[1])
            q = q.args[0]
        elif _is(q, PATTERN_TEST) and len(q.args) == 2:
            tests.append(q.args[1])
            q = q.args[0]
        else:
            break
    name = None
    if _is(q, PATTERN) and len(q.args) == 2 and type(q.args[0]) is Sym:
        name, q = q.args[0], q.args[1]
    if type(q) is Expr and q.head in (BLANK_SEQ, BLANK_NULL_SEQ) and len(q.args) <= 1:
        return (1 if q.head is BLANK_SEQ else 0), (q.args[0] if q.args else None), name, conds, tests
    return None


def _optional(p):
    """For Optional[q, default] (or q:default): (q, default), else None.  x_. (Optional[q] alone) has no default S1.2
    knows (it needs Default, S3), so it matches only an argument that is there."""
    if _is(p, OPTIONAL) and len(p.args) == 2:
        return p.args[0], p.args[1]
    return None


def _pattern_name(p):
    """The name an Optional's pattern binds, if any."""
    if _is(p, PATTERN) and len(p.args) == 2 and type(p.args[0]) is Sym:
        return p.args[0]
    return None


class _Choices:
    """The matcher's choice points, reserved against the session's memory in chunks as they grow."""

    def __init__(self):
        self.items = []
        self.chunks = []
        self.limit = 0

    def push(self, c):
        if len(self.items) >= self.limit:
            r = mem.reserve(CHOICE_CHUNK * mem.KONT_BYTES,
                            "A pattern match with " + mem.count(self.limit + CHOICE_CHUNK, "open alternative"), "Pattern")
            r.acquire()
            self.chunks.append(r)
            self.limit += CHOICE_CHUNK
        self.items.append(c)

    def release(self):
        for r in self.chunks:
            r.release()
        self.chunks = []


def match(sess, pat, expr, binds=None):
    """A generator: the bindings (a dict, name -> value) when expr matches pat, or None.  It yields ("eval", e) for
    each condition and test it evaluates."""
    choices = _Choices()
    try:
        goals = (("m", pat, expr), None)
        b = dict(binds) if binds else {}
        while True:
            ok = True
            while goals is not None:
                g, goals = goals
                kind = g[0]
                if kind == "m":
                    p, e = g[1], g[2]
                    t = type(p)
                    if t is not Expr:
                        if not (p is e or same(p, e)):
                            ok = False
                            break
                        continue
                    h = p.head
                    if h is PATTERN and len(p.args) == 2 and type(p.args[0]) is Sym:
                        goals = (("m", p.args[1], e), (("bind", p.args[0], e), goals))
                        continue
                    if h is BLANK:
                        if len(p.args) > 1 or (p.args and not (head_of(e) is p.args[0])):
                            ok = False
                            break
                        continue
                    if h is BLANK_SEQ or h is BLANK_NULL_SEQ:
                        # (a sequence pattern given one expression: that expression, a sequence of one)
                        if len(p.args) > 1 or (p.args and not (head_of(e) is p.args[0])):
                            ok = False
                            break
                        continue
                    if h is ALTERNATIVES:
                        if not p.args:
                            ok = False
                            break
                        alts = [(("m", a, e), goals) for a in p.args[1:]]
                        if alts:
                            choices.push((dict(b), alts, 0))
                        goals = (("m", p.args[0], e), goals)
                        continue
                    if h is CONDITION and len(p.args) == 2:
                        goals = (("m", p.args[0], e), (("cond", p.args[1]), goals))
                        continue
                    if h is PATTERN_TEST and len(p.args) == 2:
                        goals = (("m", p.args[0], e), (("test", p.args[1], e), goals))
                        continue
                    if h is OPTIONAL and p.args:
                        goals = (("m", p.args[0], e), goals)
                        continue
                    if h is HOLD_PATTERN and len(p.args) == 1:
                        goals = (("m", p.args[0], e), goals)
                        continue
                    if type(e) is not Expr:
                        ok = False
                        break
                    goals = (("m", h, e.head), (("seq", p.args, 0, e.args, 0), goals))
                    continue
                if kind == "bind":
                    name, v = g[1], g[2]
                    old = b.get(name)
                    if old is not None:
                        if not same(_val(old), _val(v)):
                            ok = False
                            break
                    else:
                        b[name] = v
                    continue
                if kind == "cond":
                    v = yield ("eval", substitute(g[1], _vals(b)))
                    if v is not TRUE:
                        ok = False
                        break
                    continue
                if kind == "test":
                    v = yield ("eval", Expr(g[1], g[2]))
                    if v is not TRUE:
                        ok = False
                        break
                    continue
                if kind == "seq":
                    pats, i, args, j = g[1], g[2], g[3], g[4]
                    if i == len(pats):
                        if j != len(args):
                            ok = False
                            break
                        continue
                    p = pats[i]
                    sk = _seq_kind(p)
                    if sk is not None:
                        lo, bh, name, conds, tests = sk
                        # (the elements a sequence pattern can take: up to the first that its head refuses)
                        hi = j
                        while hi < len(args) and (bh is None or head_of(args[hi]) is bh):
                            hi += 1
                        # (the shortest first, then longer: every other pattern after it needs at least one argument
                        # unless it too is a null sequence or optional, so the longest is capped by what remains)
                        need = sum(1 for q in pats[i + 1:] if _min_len(q) > 0)
                        top = min(hi, len(args) - need)
                        if top - j < lo:
                            ok = False
                            break
                        # (one choice point for all the lengths, each option's goals made only when it is tried:
                        # never a list of every split, which would be quadratic in the arguments)
                        opts = _SeqOptions(pats, i, args, j, j + lo, top, name, goals, conds, tests)
                        if len(opts) > 1:
                            choices.push((dict(b), opts, 1))
                        goals = opts[0]
                        continue
                    op = _optional(p)
                    if op is not None:
                        q, default = op
                        # (the argument there first; then the default, the argument left for the next pattern)
                        skip = (("seq", pats, i + 1, args, j), goals)
                        n = _pattern_name(q)
                        if n is not None:
                            skip = (("bind", n, default), skip)
                        if j < len(args):
                            choices.push((dict(b), [skip], 0))
                            goals = (("m", q, args[j]), (("seq", pats, i + 1, args, j + 1), goals))
                        else:
                            goals = skip
                        continue
                    if j >= len(args):
                        ok = False
                        break
                    goals = (("m", p, args[j]), (("seq", pats, i + 1, args, j + 1), goals))
                    continue
                raise AssertionError(kind)
            if ok:
                return _vals(b)
            # backtrack: the latest choice point's next alternative
            while choices.items:
                saved, opts, k = choices.items[-1]
                if k < len(opts):
                    choices.items[-1] = (saved, opts, k + 1)
                    b = dict(saved)
                    goals = opts[k]
                    break
                choices.items.pop()
            else:
                return None
    finally:
        choices.release()


class _Slice:
    """A sequence pattern's binding, args[j:k], made a Sequence only when it is needed (compared, substituted, or
    returned): trying every length of x__ makes no copy per length."""
    __slots__ = ("args", "j", "k")

    def __init__(self, args, j, k):
        self.args, self.j, self.k = args, j, k

    def value(self):
        return Expr(SEQUENCE, *self.args[self.j:self.k])


def _val(v):
    return v.value() if type(v) is _Slice else v


def _vals(b):
    return {k: _val(v) for k, v in b.items()}


class _SeqOptions:
    """A sequence pattern's choice point: its options, the lengths first..last, as goals made on demand."""
    __slots__ = ("pats", "i", "args", "j", "first", "n", "name", "rest", "conds", "tests")

    def __init__(self, pats, i, args, j, first, last, name, rest, conds=(), tests=()):
        self.pats, self.i, self.args, self.j, self.first = pats, i, args, j, first
        self.n = last - first + 1
        self.name, self.rest = name, rest
        self.conds, self.tests = conds, tests

    def __len__(self):
        return self.n

    def __getitem__(self, idx):
        k = self.first + idx
        gl = (("seq", self.pats, self.i + 1, self.args, k), self.rest)
        # (the conditions once the sequence is bound, innermost first; the tests on each element, before them)
        for c in self.conds:
            gl = (("cond", c), gl)
        for t in self.tests:
            for x in reversed(self.args[self.j:k]):
                gl = (("test", t, x), gl)
        if self.name is not None:
            gl = (("bind", self.name, _Slice(self.args, self.j, k)), gl)
        return gl


def _min_len(p):
    """How many arguments pattern p needs at least, in an argument list."""
    sk = _seq_kind(p)
    if sk is not None:
        return sk[0]
    if _optional(p) is not None:
        return 0
    return 1


def substitute(e, binds):
    """e with each symbol bound in binds replaced by its value (a sequence's value is a Sequence, spliced when it is
    evaluated).  Iterative; the result's nodes are reserved first."""
    if not binds:
        return e
    # (the size of the result: e's own, plus each bound symbol's occurrences grown to its value's size)
    n = 0
    stack = [e]
    while stack:
        x = stack.pop()
        if type(x) is Sym:
            v = binds.get(x)
            n += size_of(v) if v is not None else 1
        elif type(x) is Expr:
            n += 1
            stack.append(x.head)
            stack.extend(x.args)
        else:
            n += size_of(x)
    with mem.reserve(n * mem.NODE_BYTES, "A substitution of " + mem.count(n, "node"), "ReplaceAll"):
        return _subst(e, binds)


def _subst(e, binds):
    # (post-order on an explicit stack: each Expr rebuilt from its parts' results, unchanged parts kept as they are)
    out = []
    stack = [(e, False)]
    while stack:
        x, done = stack.pop()
        if type(x) is Expr:
            if not done:
                stack.append((x, True))
                for a in reversed(x.args):
                    stack.append((a, False))
                stack.append((x.head, False))
                continue
            k = len(x.args) + 1
            parts = out[-k:]
            del out[-k:]
            if parts[0] is x.head and all(p is a for p, a in zip(parts[1:], x.args)):
                out.append(x)
            else:
                out.append(Expr(parts[0], *parts[1:]))
        elif type(x) is Sym:
            v = binds.get(x)
            out.append(v if v is not None else x)
        else:
            out.append(x)
    return out[0]


def generality(lhs):
    """A sort key for definitions: smaller is more specific, tried first.  A definition without patterns is the most
    specific; then by how many arguments its patterns leave open, sequences weighing most; a condition or a test
    makes a pattern more specific.  Equal keys keep the order they were made in."""
    seqs = blanks = heads = conds = 0
    stack = [lhs]
    while stack:
        x = stack.pop()
        if type(x) is not Expr:
            continue
        h = x.head
        if h is BLANK_SEQ or h is BLANK_NULL_SEQ:
            seqs += 2 if h is BLANK_NULL_SEQ else 1
            if x.args:
                heads += 1
        elif h is BLANK:
            blanks += 1
            if x.args:
                heads += 1
        elif h is CONDITION or h is PATTERN_TEST:
            conds += 1
        stack.append(h)
        stack.extend(x.args)
    return (seqs, blanks - heads, blanks, -conds)


RULE, RULE_DELAYED = Sym("Rule"), Sym("RuleDelayed")


def is_rule(r):
    return type(r) is Expr and (r.head is RULE or r.head is RULE_DELAYED) and len(r.args) == 2


def rule_list(r):
    """The rules of r (a rule, or a list of rules), or None."""
    if is_rule(r):
        return [r]
    if type(r) is Expr and r.head is LIST and all(is_rule(x) for x in r.args):
        return list(r.args)
    return None


def replace_all(sess, e, rules):
    """A generator: e with the first rule that matches each subexpression applied, outermost first, without looking
    inside what a rule replaced; returns (the result, whether anything changed)."""
    # (pre-order on an explicit stack; each subexpression is tried against the rules in order, and if one matches its
    # replacement is final; else its head and arguments are visited, and it is rebuilt from their results)
    out = []
    stack = [(e, 0)]
    changed = False
    while stack:
        x, phase = stack.pop()
        if phase == 0:
            hit = None
            for r in rules:
                b = yield from match(sess, r.args[0], x)
                if b is not None:
                    hit = substitute(r.args[1], b)
                    break
            if hit is not None:
                out.append(hit)
                changed = True
                continue
            if type(x) is Expr:
                stack.append((x, 1))
                for a in reversed(x.args):
                    stack.append((a, 0))
                stack.append((x.head, 0))
                continue
            out.append(x)
        else:
            k = len(x.args) + 1
            parts = out[-k:]
            del out[-k:]
            if parts[0] is x.head and all(p is a for p, a in zip(parts[1:], x.args)):
                out.append(x)
            else:
                out.append(Expr(parts[0], *parts[1:]))
    return out[0], changed
