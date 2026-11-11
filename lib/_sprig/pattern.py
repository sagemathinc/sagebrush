"""Sprig's patterns (design/sprig-mvp.md §5.2, §8.3): matching, substitution, and the specificity order of
definitions.

The matcher runs on the evaluator's stack.  `match` is a generator: a Condition or a PatternTest yields
("eval", e) to have e evaluated by the trampoline, and the matcher resumes with its value, so a condition never
re-enters `evaluate`.  Matching itself is iterative: the goals still to meet are a linked list, and each place with
more than one way to match (an Alternatives, a sequence pattern's length, an Optional) is a choice point on an explicit
stack, tried in order and backtracked to on failure.

What a match retains is charged to its holder before it is made (§8.4), and the charge follows what is still
reachable.  The goals form one shared list: a goal is made at the front, never changed, so the goals made since the
last choice point (`work`) are reachable only from the current goals and from choice points pushed later.  A choice
point's charge is the goals made before it (since the previous one), its copy of the bindings, its alternatives (or
its lazy options) and the entry itself; going back to it gives back the goals made since and the bindings it replaces
(once the copy that replaces them is made), and leaving it, exhausted, gives back its charge, after the references to
what it covered are gone.  A condition's or a test's expression is made under mem.produce (the evaluator takes it);
its value is dropped once compared.  A successful match's bindings, the dict and every sequence made a Sequence, are
charged to the caller's holder (`keep`) before they are made.

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


def _unwrap(p):
    """p without the Conditions and PatternTests around it."""
    while type(p) is Expr and (p.head is CONDITION or p.head is PATTERN_TEST) and len(p.args) == 2:
        p = p.args[0]
    return p


def _seq_kind(p):
    """For a pattern in an argument list: (min length, the blank's head or None, the name or None) when it matches a
    sequence of arguments, else None.  A Condition around it (x__ /; c) is checked once the sequence is bound; a
    PatternTest (x__?t) tests each of the sequence's elements (_SeqOptions)."""
    q = _unwrap(p)
    name = None
    if _is(q, PATTERN) and len(q.args) == 2 and type(q.args[0]) is Sym:
        name, q = q.args[0], q.args[1]
    if type(q) is Expr and q.head in (BLANK_SEQ, BLANK_NULL_SEQ) and len(q.args) <= 1:
        return (1 if q.head is BLANK_SEQ else 0), (q.args[0] if q.args else None), name
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


def match(sess, pat, expr, keep, on_suspend=None):
    """A generator: the bindings (a dict, name -> value) when expr matches pat, charged to the holder keep, or None.
    It yields ("eval", e) for each condition and test it evaluates, calling on_suspend() before its first."""
    GOAL, BIND, SLOT = mem.GOAL_BYTES, mem.BIND_BYTES, mem.SLOT_BYTES
    mh = mem.Held(_match_subject, "Pattern", mem.HELD_CHUNK)
    choices = []        # (the bindings it saved, its options, the next option, the bytes it holds)
    try:
        mh.grow(GOAL)
        goals = (("m", pat, expr), None)
        work = GOAL     # the bytes of goals made since the last choice point or return to one
        b = {}
        bbytes = 0      # the bytes of the bindings b
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
                        mh.grow(2 * GOAL)
                        work += 2 * GOAL
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
                        na = len(p.args) - 1
                        if na:
                            # (the copy of the bindings, the alternatives' goals and their list, the entry)
                            need = len(b) * BIND + na * (GOAL + SLOT) + mem.KONT_BYTES
                            mh.grow(need)
                            alts = [(("m", a, e), goals) for a in p.args[1:]]
                            choices.append((dict(b), alts, 0, work + need))
                            alts = None
                            work = 0
                        mh.grow(GOAL)
                        work += GOAL
                        goals = (("m", p.args[0], e), goals)
                        continue
                    if h is CONDITION and len(p.args) == 2:
                        mh.grow(2 * GOAL)
                        work += 2 * GOAL
                        goals = (("m", p.args[0], e), (("cond", p.args[1]), goals))
                        continue
                    if h is PATTERN_TEST and len(p.args) == 2:
                        mh.grow(2 * GOAL)
                        work += 2 * GOAL
                        goals = (("m", p.args[0], e), (("test", p.args[1], e), goals))
                        continue
                    if (h is OPTIONAL and p.args) or (h is HOLD_PATTERN and len(p.args) == 1):
                        mh.grow(GOAL)
                        work += GOAL
                        goals = (("m", p.args[0], e), goals)
                        continue
                    if type(e) is not Expr:
                        ok = False
                        break
                    mh.grow(2 * GOAL)
                    work += 2 * GOAL
                    goals = (("m", h, e.head), (("seq", p.args, 0, e.args, 0), goals))
                    continue
                if kind == "bind":
                    name, v = g[1], g[2]
                    old = b.get(name)
                    if old is not None:
                        if not _same_binding(old, v):
                            ok = False
                            break
                    else:
                        mh.grow(BIND)
                        bbytes += BIND
                        b[name] = v
                    continue
                if kind == "cond":
                    if on_suspend is not None:
                        on_suspend()
                        on_suspend = None
                    # (made in a call, so the matcher holds no reference to it while it is evaluated: its charge goes
                    # with it)
                    v = yield ("eval", _condition(g[1], b))
                    ok = v is TRUE
                    v = None
                    mem.drop_received()
                    if not ok:
                        break
                    continue
                if kind == "test":
                    if on_suspend is not None:
                        on_suspend()
                        on_suspend = None
                    v = yield ("eval", _test_call(g[1], g[2]))
                    ok = v is TRUE
                    v = None
                    mem.drop_received()
                    if not ok:
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
                        lo, bh, name = sk
                        # (the elements a sequence pattern can take: up to the first that its head refuses)
                        hi = j
                        while hi < len(args) and (bh is None or head_of(args[hi]) is bh):
                            hi += 1
                        # (the shortest first, then longer, up to every argument its head allows: one that leaves the
                        # patterns after it too few fails there, after its own conditions have run, as the oracle's
                        # does: f[x__ /; (Print["c"]; True), y_] on one argument prints c)
                        top = hi
                        if top - j < lo:
                            ok = False
                            break
                        # (one choice point for all the lengths, each option's goals made only when it is tried:
                        # never a list of every split, which would be quadratic in the arguments)
                        if top - (j + lo) + 1 > 1:
                            need = len(b) * BIND + _SeqOptions.BYTES + mem.KONT_BYTES
                            mh.grow(need)
                            opts = _SeqOptions(pats, i, args, j, j + lo, top, name, goals)
                            choices.append((dict(b), opts, 1, work + need))
                            work = 0
                        else:
                            opts = _SeqOptions(pats, i, args, j, j + lo, top, name, goals)
                            mh.grow(_SeqOptions.BYTES)
                            work += _SeqOptions.BYTES
                        cost = opts.cost(0)
                        mh.grow(cost)
                        work += cost
                        goals = opts[0]
                        opts = None
                        continue
                    op = _optional(p)
                    if op is not None:
                        q, default = op
                        # (the argument there first; then the default, the argument left for the next pattern)
                        n = _pattern_name(q)
                        if j < len(args):
                            need = len(b) * BIND + (2 if n is not None else 1) * GOAL + SLOT + mem.KONT_BYTES
                            mh.grow(need)
                            skip = (("seq", pats, i + 1, args, j), goals)
                            if n is not None:
                                skip = (("bind", n, default), skip)
                            choices.append((dict(b), [skip], 0, work + need))
                            skip = None
                            work = 0
                            mh.grow(2 * GOAL)
                            work += 2 * GOAL
                            goals = (("m", q, args[j]), (("seq", pats, i + 1, args, j + 1), goals))
                        else:
                            mh.grow(2 * GOAL)
                            work += 2 * GOAL
                            goals = (("seq", pats, i + 1, args, j), goals)
                            if n is not None:
                                goals = (("bind", n, default), goals)
                        continue
                    if j >= len(args):
                        ok = False
                        break
                    mh.grow(2 * GOAL)
                    work += 2 * GOAL
                    goals = (("m", p, args[j]), (("seq", pats, i + 1, args, j + 1), goals))
                    continue
                raise AssertionError(kind)
            if ok:
                # (the bindings handed to the caller: the dict and every sequence made a Sequence, charged to it first)
                keep.grow(_vals_bytes(b))
                return _vals(b)
            # backtrack: the latest choice point's next option; the goals made since it, now unreachable, given back,
            # and the bindings once the copy replacing them is made
            g = goals = None
            while choices:
                saved, opts, k, nbytes = choices[-1]
                if k < len(opts):
                    cost = opts.cost(k) if type(opts) is _SeqOptions else 0
                    mh.grow(len(saved) * BIND + cost)
                    choices[-1] = (saved, opts, k + 1, nbytes)
                    b = dict(saved)
                    goals = opts[k]
                    saved = opts = None
                    mh.shrink(work + bbytes)
                    work = cost
                    bbytes = len(b) * BIND
                    break
                # (exhausted: the goals made before it, its copy and its options, unreachable once it is gone)
                choices.pop()
                saved = opts = None
                mh.shrink(nbytes)
            else:
                return None
    finally:
        choices.clear()
        mh.release()


def _condition(c, b):
    """The condition c with the bindings put in, charged to mem.made; the values with their sequences made are reserved
    while it is made from them."""
    with mem.reserve(_vals_bytes(b), _match_subject, "Pattern"):
        return substitute(c, _vals(b), mem.made)


def _test_call(t, x):
    """t[x], a pattern test's call, charged to mem.made."""
    with mem.produce(mem.NODE_BYTES + mem.SLOT_BYTES, _match_subject, "Pattern"):
        return Expr(t, x)


def _match_subject():
    return "A pattern match"


def _seq_items(v):
    """(args, j, k) for a sequence's binding or a Sequence[...], else None."""
    if type(v) is _Slice:
        return v.args, v.j, v.k
    if type(v) is Expr and v.head is SEQUENCE:
        return v.args, 0, len(v.args)
    return None


def _same_binding(old, v):
    """Whether a name already bound is bound again to the same, compared without making a sequence's copy."""
    if type(old) is not _Slice and type(v) is not _Slice:
        return same(old, v)
    x, y = _seq_items(old), _seq_items(v)
    if x is None or y is None:
        return False
    (xa, xj, xk), (ya, yj, yk) = x, y
    return xk - xj == yk - yj and all(same(xa[xj + t], ya[yj + t]) for t in range(xk - xj))


def _vals_bytes(b):
    """The bytes of b's values handed on: the dict, and each sequence made a Sequence (its node and references)."""
    n = len(b) * mem.BIND_BYTES
    for v in b.values():
        if type(v) is _Slice:
            n += mem.NODE_BYTES + (v.k - v.j) * mem.SLOT_BYTES
    return n


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
    """A sequence pattern's choice point: its options, the lengths first..last, as goals made on demand (cost(idx)
    is what option idx's goals take, reserved before they are made)."""
    __slots__ = ("pats", "i", "args", "j", "first", "n", "name", "rest", "nconds", "ntests")
    # (the object itself)
    BYTES = 256

    def __init__(self, pats, i, args, j, first, last, name, rest):
        self.pats, self.i, self.args, self.j, self.first = pats, i, args, j, first
        self.n = last - first + 1
        self.name, self.rest = name, rest
        nc = nt = 0
        q = pats[i]
        while type(q) is Expr and (q.head is CONDITION or q.head is PATTERN_TEST) and len(q.args) == 2:
            if q.head is CONDITION:
                nc += 1
            else:
                nt += 1
            q = q.args[0]
        self.nconds, self.ntests = nc, nt

    def __len__(self):
        return self.n

    def cost(self, idx):
        k = self.first + idx
        return (1 + self.nconds + self.ntests * (k - self.j) + (2 if self.name is not None else 0)) * mem.GOAL_BYTES

    def __getitem__(self, idx):
        k = self.first + idx
        gl = (("seq", self.pats, self.i + 1, self.args, k), self.rest)
        # (the conditions once the sequence is bound, innermost first; the tests on each element, before them,
        # innermost first, each in the elements' order)
        q = self.pats[self.i]
        while type(q) is Expr and (q.head is CONDITION or q.head is PATTERN_TEST) and len(q.args) == 2:
            if q.head is CONDITION:
                gl = (("cond", q.args[1]), gl)
            q = q.args[0]
        q = self.pats[self.i]
        while type(q) is Expr and (q.head is CONDITION or q.head is PATTERN_TEST) and len(q.args) == 2:
            if q.head is PATTERN_TEST:
                for t in range(k - 1, self.j - 1, -1):
                    gl = (("test", q.args[1], self.args[t]), gl)
            q = q.args[0]
        if self.name is not None:
            gl = (("bind", self.name, _Slice(self.args, self.j, k)), gl)
        return gl


def substitute(e, binds, into):
    """e with each symbol bound in binds replaced by its value (a sequence's value is a Sequence, spliced when it is
    evaluated).  Iterative: its walk is reserved while it runs, and the result's nodes are charged to the holder into
    before they are made (it holds them from then on)."""
    if not binds:
        return e
    # (the walks' stacks and output, at most one entry and one reference per node of e)
    m = size_of(e)
    with mem.reserve(m * (mem.WALK_BYTES + 2 * mem.SLOT_BYTES), "A substitution of " + mem.count(m, "node"),
                     "ReplaceAll"):
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
        stack = None
        into.grow(n * mem.NODE_BYTES, "A substitution of " + mem.count(n, "node"))
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
    """The rules of r (a rule, or a list of rules) as a tuple (r's own: no copy), or None."""
    if is_rule(r):
        return (r,)
    if type(r) is Expr and r.head is LIST and all(is_rule(x) for x in r.args):
        return r.args
    return None


def replace_all(sess, e, rules, into):
    """A generator: e with the first rule that matches each subexpression applied, outermost first, without looking
    inside what a rule replaced; returns (the result, whether anything changed), the nodes it made charged to the
    holder into.  Its walk is reserved for its whole run; what it made (the replacements and the rebuilt nodes) is
    held as it is made, and handed to into at the end."""
    # (pre-order on an explicit stack; each subexpression is tried against the rules in order, and if one matches its
    # replacement is final; else its head and arguments are visited, and it is rebuilt from their results)
    m = size_of(e)
    walk = mem.Held("A replacement in " + mem.count(m, "node"), "ReplaceAll")
    made = mem.Held("A replacement's result", "ReplaceAll")
    try:
        # (the stack's entries, the output's references and a rebuilt node's parts, at most one each per node of e)
        walk.grow(m * (mem.WALK_BYTES + 2 * mem.SLOT_BYTES))
        out = []
        stack = [(e, 0)]
        changed = False
        while stack:
            x, phase = stack.pop()
            if phase == 0:
                hit = None
                for r in rules:
                    keep = mem.Held("A pattern match", "ReplaceAll")
                    try:
                        b = yield from match(sess, r.args[0], x, keep)
                        if b is not None:
                            hit = substitute(r.args[1], b, made)
                            b = None
                            break
                    finally:
                        keep.release()
                if hit is not None:
                    out.append(hit)
                    hit = None
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
                    made.grow(mem.NODE_BYTES + k * mem.SLOT_BYTES)
                    out.append(Expr(parts[0], *parts[1:]))
                parts = None
        x = stack = None
        res = out.pop()
        out = None
        into.take(made)
        return res, changed
    finally:
        made.release()
        walk.release()
