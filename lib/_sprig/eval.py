"""Sprig's evaluator (design/sprig-mvp.md §5.2, §8).

Standard evaluation rewrites until nothing changes: evaluate the head,
then the arguments its attributes don't hold; splice Sequence, flatten Flat
heads, thread Listable ones over lists, sort Orderless arguments; apply the
builtin's rule; evaluate the result again if it changed.

It runs on an explicit stack (a trampoline, §8.3): evaluating a head or an
argument pushes a continuation, never a host frame.  A builtin is either a
function of its evaluated expression, giving the new expression or None
(no rule applies), or, when it needs evaluation itself (CompoundExpression,
Set, ToExpression), a generator: it yields ("eval", e) to have e evaluated
on the same stack and returns its value, or Tail(e) to have e evaluated in
its place.  Nothing re-enters `evaluate`, so deep recursion in Sprig grows
a list.  The continuation stack is reserved against the session's memory
as it grows (§8.4), and given back however the evaluation ends.

Nothing here catches Stop (KeyboardInterrupt) or any exception it doesn't
name (§8.1); the loop is a compiled loop, which tests Stop each iteration.
"""

from . import mem
from . import pattern
from .expr import Expr, Sym, NULL, LIST, same, size_of, sort_canonical

SEQUENCE = Sym("Sequence")
# (the type of a generator builtin's call)
GENERATOR = type((lambda: (yield))())
# the evaluation's first reservation is this many frames' worth, which its frames and what they hold share
KONT_CHUNK = 4096
# the per-level counts (its[], owns[]) grow by this many levels at a time
LEVEL_ROOM = 64
ZEROS = (0,) * LEVEL_ROOM
# $RecursionLimit's and $IterationLimit's defaults, the oracle's (sprig-tests/PROVENANCE.json's limits)
RECURSION_LIMIT = 200
ITERATION_LIMIT = 4096
LIMIT_NAMES = ("$RecursionLimit", "$IterationLimit")


class Tail:
    """A generator builtin's result to be evaluated in its call's place."""
    __slots__ = ("e",)

    def __init__(self, e):
        self.e = e


class SprigAbort(Exception):
    """The current top-level statement ends with $Aborted (a message has said why)."""


class Session:
    """One Sprig session: its definitions, and where its printed text goes."""

    def __init__(self, write_out, write_err):
        from . import base
        self.own = {}                  # Sym -> (its value, the value's reservation): each published in one store (§8.2)
        self.down = {}                 # Sym -> its down values, a tuple of Definitions, most specific first; the
                                       # whole tuple published in one store
        self.value_charges = []        # the bytes of the statements' values the caller still has (keep_value),
        self.kept = mem.Held("A result", "Evaluation")  # charged together here
        # (the evaluation's holder and its hand-offs, made once and reused: each is empty between evaluations)
        self._ev = mem.Held(_held_subject, "Evaluation", mem.HELD_CHUNK)
        self._handoffs = (mem.Held("A result", "Evaluation"), mem.Held("A result", "Evaluation"))
        self.symbols = {}              # the names this session made (Sym's session table)
        self.holds = []                # reservations a builtin holds across its yields, released at its end or Stop
        self.names = []                # the reservations charging this session's names (symbols), in NAME_CHUNKs
        self.name_bytes = 0            # their charge so far, and what is reserved for it
        self.name_reserved = 0
        self.builtins = base.BUILTINS
        self.attributes = base.ATTRIBUTES  # Sprig's own, shared by every session and never changed
        self.user_attrs = {}               # Sym -> the attributes this session gave it (SetAttributes)
        self.texts = dict(base.MESSAGES)   # (symbol name, tag) -> text
        self.write_out = write_out     # Print's lines
        self.write_err = write_err     # messages
        self.messages = []             # this statement's messages, "f::tag: text"
        # the language's limits at their recorded defaults (design §5.2; sprig-tests/PROVENANCE.json): an int, or None
        # for Infinity
        self.recursion_limit = RECURSION_LIMIT
        self.iteration_limit = ITERATION_LIMIT

    # ---------------------------------------------------------------- definitions and the session's lifetime

    def define(self, sym, value, name):
        """Give sym its value, charging the value's nodes to the ledger for as long as it is defined (§8.4).  The new
        charge is reserved first (a refusal leaves the old definition), then the value and its reservation are
        published in one store, and the replaced value's reservation is given back.  Each definition is charged on
        its own, even when values share structure: an upper bound."""
        n = size_of(value)
        r = mem.reserve((n + 1) * mem.NODE_BYTES, "A definition of " + mem.count(n, "node"), name)
        r.acquire()
        old = self.own.get(sym)
        published = False
        try:
            self.own[sym] = (value, r)
            published = True
        finally:
            if not published:
                r.release()
            elif old is not None:
                old[1].release()

    def define_down(self, sym, lhs, rhs, name):
        """Add the definition lhs -> rhs to sym's down values, charged like an own value.  A definition whose lhs is
        the same as an existing one's replaces it in its place; a new one goes before the first that is more general
        (pattern.generality), after any equally general.  The new tuple of definitions is published in one store; the
        copy it is made in is reserved first, and the replaced definition retired (Definition)."""
        generality = pattern.generality
        n = size_of(lhs) + size_of(rhs)
        r = mem.reserve((n + 1) * mem.NODE_BYTES, "A definition of " + mem.count(n, "node"), name)
        r.acquire()
        old = self.down.get(sym, ())
        # (the list it is made in and the new tuple, both alive with the old tuple until it is published)
        # (and generality's walk of lhs, a reference per node at most)
        work = mem.reserve((2 * (len(old) + 1) + size_of(lhs)) * mem.SLOT_BYTES, "A definition of " + mem.count(n, "node"),
                           name)
        published = False
        replaced = None
        try:
            work.acquire()
            key = generality(lhs)
            d = Definition(key, lhs, rhs, r)
            rules = list(old)
            for i, x in enumerate(rules):
                if same(x.lhs, lhs):
                    replaced = x
                    rules[i] = d
                    break
            else:
                i = len(rules)
                for k, x in enumerate(rules):
                    if x.key > key:
                        i = k
                        break
                rules.insert(i, d)
            self.down[sym] = tuple(rules)
            published = True
            rules = old = None
        finally:
            work.release()
            if not published:
                r.release()
            elif replaced is not None:
                _retire_all((replaced,), 0)

    def undefine_down(self, sym, lhs):
        """Remove the definition with this lhs; whether there was one."""
        old = self.down.get(sym, ())
        # (the removed and the kept, both copies of the table's references, reserved first)
        with mem.reserve(2 * len(old) * mem.SLOT_BYTES, "A definition's removal", "Unset"):
            gone = [d for d in old if same(d.lhs, lhs)]
            if not gone:
                return False
            rules = tuple(d for d in old if not same(d.lhs, lhs))
            if rules:
                self.down[sym] = rules
            else:
                del self.down[sym]
            rules = old = None
            _retire_all(gone, 0)
            return True

    def clear(self, sym):
        """Clear[sym]: its own and down values removed, their reservations given back (a down value a reader has
        pinned, when its reader ends)."""
        o = self.own.pop(sym, None)
        if o is not None:
            o[1].release()
        _retire_all(self.down.pop(sym, ()), 0)

    def hold(self, r):
        """Keep reservation r for a builtin across its yields; evaluate() gives it back if Stop ends the builtin."""
        self.holds.append(r)

    def unhold(self, r):
        self.holds.remove(r)
        r.release()

    def charge_name(self, name):
        """Charge a new name this session makes, before it is made, for as long as the session lives: the names are
        reserved in NAME_CHUNKs (or a reservation of the name's own size, for a longer one)."""
        n = mem.SYM_BYTES + mem.SYM_BYTES_PER_CHAR * len(name)
        if self.name_bytes + n > self.name_reserved:
            size = max(mem.NAME_CHUNK, n)
            r = mem.reserve(size, "A name of " + mem.count(len(name), "character"), "Symbol")
            r.acquire()
            self.names.append(r)
            self.name_reserved += size
        self.name_bytes += n

    def activate(self):
        """Make this session's table the one new names go in, charged to it; returns the previous state, for
        restore()."""
        prev = (Sym._local, Sym._charge)
        Sym._local = self.symbols
        Sym._charge = self.charge_name
        return prev

    @staticmethod
    def restore(prev):
        Sym._local, Sym._charge = prev

    def close(self):
        """The session's end: every definition's reservation given back, and its names dropped.  Each kind is given
        back progress-safely (_drain), and each in a finally of the one before, so an interrupted one doesn't skip
        the rest."""
        own, self.own = self.own, {}
        down, self.down = self.down, {}
        holds, self.holds = self.holds, []
        names, self.names = self.names, []
        self.user_attrs = {}
        self.value_charges = []
        try:
            _drain([r for _, r in own.values()], 0)
        finally:
            try:
                _drain([d.r for rules in down.values() for d in rules], 0)
            finally:
                try:
                    _drain(holds, 0)
                finally:
                    try:
                        _drain(names, 0)
                    finally:
                        self.kept.release()
                        self.name_bytes = self.name_reserved = 0
                        self.symbols = {}

    # ---------------------------------------------------------------- messages

    def message(self, name, tag, *args):
        """Issue name::tag with its text (`1`, `2`, ... filled from args, already text)."""
        text = self.texts.get((name, tag))
        if text is None:
            text = self.texts.get(("General", tag), "")
        for i, a in enumerate(args):
            text = text.replace("`%d`" % (i + 1), a)
        line = "%s::%s: %s" % (name, tag, text)
        self.messages.append(line)
        self.write_err(line + "\n")

    def attrs(self, head):
        if type(head) is Sym:
            a = self.user_attrs.get(head)
            if a is not None:
                return a
            return self.attributes.get(head.name, ())
        return ()

    # ---------------------------------------------------------------- evaluation

    def evaluate(self, expr):
        """expr's value.  Its charge, the value's tree size, is kept in self.value_charge until the caller drops the
        value (keep_value); expr itself is the caller's, charged by it (a program's statements by its parse).

        The language's limits (design §5.2, S1.2) are counted here, as the oracle counts them: the recursion depth is
        how many evaluations are nested, an atom's included (a rewrite in place doesn't nest), checked as each starts,
        with the top-level statement at depth 1 (a nested list of 199 levels around a symbol evaluates, 200 doesn't);
        the iterations are how many times the expression at one level is rewritten in place: by a definition or a
        builtin, at most $IterationLimit - 1 times in a row, the count starting again when a symbol's value is read in
        place; symbols' values, at most $IterationLimit + 1 times at a level in all.  Past either, the statement ends with $Aborted and the limit's message.

        What the evaluation retains is charged to one holder, ev (§8.4), in bytes counted per frame: a frame's charge
        covers what it holds that isn't part of what a frame below it holds (its expression when that is a rewrite's
        result, its head's value, its argument list and the arguments evaluated so far, the call it built), and `cur`
        the value in flight when it isn't part of a frame's.  When a level ends, returning a value or rewriting in place,
        its charge becomes exactly the value's tree size (Expr.size * NODE_BYTES): more is admitted, the rest given back
        once every reference the level held is gone.  The hand-offs (mem.made, mem.received) are this evaluation's
        own."""
        konts = []
        holds0 = len(self.holds)       # (the builtins' holds from here on are this evaluation's)
        deep = 0                       # the frames charged so far: the stack's high-water mark
        KB, SB = mem.KONT_BYTES, mem.SLOT_BYTES
        room = 0                       # the levels its[] and owns[] have room for
        its = [1]                      # its[d]: the evaluations so far at depth d (len(konts)): the first one, then
                                       # each rewrite in place by a definition or a builtin since the last value
                                       # read, as the oracle counts them
        owns = [0]                     # owns[d]: the symbols' values read in place at depth d, all of them
        mode_eval = True
        head_eval = False
        val = None
        ev = self._ev
        ev.floor = 0
        ev.trim = 2 * ev.chunk
        cur = 0
        handoffs = mem.made, mem.received
        mem.made, mem.received = self._handoffs
        try:
            # (the evaluation's first reservation, a continuation chunk's worth, as the stack's alone was: its frames
            # and what they hold share it, so a small statement makes one admission)
            ev.prereserve(KONT_CHUNK * KB, (_levels, KONT_CHUNK))
            while True:
                n = len(konts)
                if n >= deep:
                    # (each new level's frame charged as the stack first reaches it, within the reservation without a
                    # call)
                    x = (n + 1 - deep) * KB
                    if ev.used + x > ev.reserved:
                        ev.grow(x, (_levels, n + 1))
                    else:
                        ev.used += x
                    deep = n + 1
                    if deep > room:
                        room += LEVEL_ROOM
                        its.extend(ZEROS)
                        owns.extend(ZEROS)
                if mode_eval:
                    e = expr
                    t = type(e)
                    # (read live: a statement can change the limit, $RecursionLimit = 500; ...; a compound expression's
                    # evaluation counts as a level, and a symbol's as an argument or a value, not as a head; a number's
                    # or a string's doesn't: the oracle's count, measured on nested lists, sums, lists and mutual
                    # recursion, in a statement of its own and in a compound one)
                    rl = self.recursion_limit
                    if rl is not None and n + 1 > rl and (t is Expr or (t is Sym and not head_eval)):
                        self._limit("$RecursionLimit", "reclim", rl)
                    head_eval = False
                    if t is Sym:
                        v = self.own.get(e)
                        v = v[0] if v is not None else None
                        if v is None and e.name in LIMIT_NAMES:
                            from .base import limit_symbol_value
                            v = limit_symbol_value(self, e)
                        if v is None or v is e:
                            val, mode_eval = e, False
                        else:
                            # (the oracle's count, measured on chains of values, of definitions, alternating and
                            # one after the other: at most $IterationLimit + 1 values read at a level, and a value
                            # read starts the count of rewrites again)
                            owns[n] += 1
                            its[n] = 1
                            il = self.iteration_limit
                            if il is not None and owns[n] > il + 1:
                                self._limit("$IterationLimit", "itlim", il)
                            # (a definition's value is charged again while it is in flight: a Clear or a new value
                            # meanwhile can't leave it uncharged; an upper bound, as each definition's charge is)
                            cur = _settle(ev, cur, v)
                            expr = e = v
                        continue
                    if t is not Expr:
                        val, mode_eval = e, False
                        continue
                    konts.append(("head", e, cur))
                    cur = 0
                    its[n + 1] = 1
                    owns[n + 1] = 0
                    expr = e.head
                    head_eval = True
                    continue
                if not konts:
                    # (every hand-off settled: each value made or given went to a holder)
                    if mem.made.used or mem.received.used:
                        raise AssertionError("an unsettled hand-off")
                    # (the value charged its own size whatever it is: an atom, or a part of the program, outlives
                    # the parse that held it until the caller drops it)
                    cur = _settle(ev, cur, val)
                    self._keep(ev, cur)
                    return val
                k = konts.pop()
                n = len(konts)
                kind = k[0]
                if kind == "head":
                    e, owe = k[1], k[2]
                    # (a head that evaluated to itself is the expression's own part, which owe covers already: its
                    # charge in flight given back rather than counted twice)
                    if val is e.head:
                        _release(ev, cur)
                    else:
                        owe += cur
                    cur = 0
                    head = val
                    held = self._held(head, e.args)
                    # (the argument list: its references, before it is made)
                    x = len(e.args) * SB
                    if ev.used + x > ev.reserved:
                        ev.grow(x)
                    else:
                        ev.used += x
                    owe += x
                    args = list(e.args)
                    i = self._next(held, args, 0)
                    if i is None:
                        r = self._apply(ev, e, head, args, konts, owe)
                    else:
                        konts.append(("args", e, head, args, held, i, owe))
                        its[n + 1] = 1
                        owns[n + 1] = 0
                        expr, mode_eval = args[i], True
                        continue
                elif kind == "args":
                    _, e, head, args, held, i, owe = k
                    # (likewise an argument that evaluated to itself, a call with no rule or an atom)
                    if val is e.args[i]:
                        _release(ev, cur)
                    else:
                        owe += cur
                    cur = 0
                    args[i] = val
                    j = self._next(held, args, i + 1)
                    if j is not None:
                        konts.append(("args", e, head, args, held, j, owe))
                        its[n + 1] = 1
                        owns[n + 1] = 0
                        expr, mode_eval = args[j], True
                        continue
                    r = self._apply(ev, e, head, args, konts, owe)
                else:
                    # ("gen", generator, the call, its frame's charge): the value it asked for, handed to it with its
                    # charge
                    ev.move(mem.received, cur)
                    cur = 0
                    r = self._resume(ev, k[1], k[2], val, konts, k[3])
                # r: ("ret", value, the level's charge) or ("eval", expression, its charge): a generator's request,
                # nested a level down (it pushed its frame; the charge is the request's own), or a rewrite in place
                # (the charge is the level's)
                # (every reference the level held is dropped before its charge is settled to the value's)
                k = e = head = args = val = expr = None
                if r[0] == "eval":
                    if len(konts) > n:
                        its[n + 1] = 1
                        owns[n + 1] = 0
                        cur = r[2]
                    else:
                        its[n] += 1
                        il = self.iteration_limit
                        if il is not None and its[n] > il:
                            self._limit("$IterationLimit", "itlim", il)
                        cur = _settle(ev, r[2], r[1])
                    expr, mode_eval = r[1], True
                else:
                    cur = _settle(ev, r[2], r[1])
                    val = r[1]
                r = None
        finally:
            self._unwind(konts, ev, holds0, handoffs)

    def _keep(self, ev, cur):
        """The statement's value's charge, moved from the evaluation to the session until the value is dropped, with
        its place in the list reserved first."""
        ev.grow(mem.SLOT_BYTES)
        ev.move(self.kept, cur + mem.SLOT_BYTES)
        self.value_charges.append(cur + mem.SLOT_BYTES)

    def keep_value(self, keep):
        """The values the caller no longer refers to: all but the last `keep` evaluated, their charges given back."""
        n = max(0, len(self.value_charges) - keep)
        if n:
            k = self.kept
            for i in range(n):
                b = self.value_charges[i]
                k.used -= b
                k.reserved -= b
                mem._open[0] -= b
            del self.value_charges[:n]

    def _unwind(self, konts, ev, holds0, handoffs):
        """The evaluation's end, however it ends: a generator builtin still suspended here, the matcher above all, is
        closed now, innermost first, so its own clean-up runs at once (its holders given back, its definitions
        unpinned) rather than when the host collects it; then every charge the evaluation still holds.  Each step runs
        in a finally of the one before, so a failure in one (a Stop during the clean-up) doesn't skip the rest."""
        try:
            _close_all(konts)
        finally:
            ev.release()
            mem.made.release()
            mem.received.release()
            mem.made, mem.received = handoffs
            _drain(self.holds, holds0)

    def _limit(self, name, tag, n):
        """A language limit passed: its message, and the statement ends with $Aborted."""
        self.message(name, tag, str(n))
        raise SprigAbort()

    def _held(self, head, args):
        """Which arguments aren't evaluated: None (none), "all", or a set of positions."""
        a = self.attrs(head)
        if not a:
            return None
        if "HoldAll" in a:
            return "all"
        if "HoldFirst" in a:
            return {0}
        if "HoldRest" in a:
            return set(range(1, len(args)))
        return None

    def _next(self, held, args, i):
        """The next argument position from i to evaluate, or None."""
        if held == "all":
            return None
        n = len(args)
        while i < n:
            if held is None or i not in held:
                return i
            i += 1
        return None

    def _apply(self, ev, e, head, args, konts, owe):
        """The call head[args] with its arguments evaluated: ("ret", value, charge) or ("eval", next expression,
        charge), the charge covering what the level holds (owe, the lists and call made here, the builtin's result)."""
        a = self.attrs(head)
        if "SequenceHold" not in a and "HoldAllComplete" not in a:
            if any(type(x) is Expr and x.head is SEQUENCE for x in args):
                m = sum(len(x.args) if type(x) is Expr and x.head is SEQUENCE else 1 for x in args)
                ev.grow(m * mem.SLOT_BYTES)
                owe += m * mem.SLOT_BYTES
                spliced = []
                for x in args:
                    if type(x) is Expr and x.head is SEQUENCE:
                        spliced.extend(x.args)
                    else:
                        spliced.append(x)
                args = spliced
        if "Flat" in a and any(type(x) is Expr and x.head is head for x in args):
            m = sum(len(x.args) if type(x) is Expr and x.head is head else 1 for x in args)
            ev.grow(m * mem.SLOT_BYTES)
            owe += m * mem.SLOT_BYTES
            flat = []
            for x in args:
                if type(x) is Expr and x.head is head:
                    flat.extend(x.args)
                else:
                    flat.append(x)
            args = flat
        if "Listable" in a:
            t = self._thread(head, args)
            if t is not None:
                return ("eval", t, owe + _collect(ev, mem.made))
        if "Orderless" in a and len(args) > 1:
            ev.grow(len(args) * mem.SLOT_BYTES)
            owe += len(args) * mem.SLOT_BYTES
            args = sort_canonical(args)
        if len(args) == len(e.args) and head is e.head and all(x is y for x, y in zip(args, e.args)):
            new = e
        else:
            # (the call's node and its references, before it is made)
            x = mem.NODE_BYTES + len(args) * mem.SLOT_BYTES
            if ev.used + x > ev.reserved:
                ev.grow(x)
            else:
                ev.used += x
            owe += x
            new = Expr(head, *args)
        f = self.builtins.get(head.name) if type(head) is Sym else None
        rules = self.down.get(head) if type(head) is Sym else None
        if rules:
            # (the session's definitions first, most specific first; a builtin's rule only when none matches)
            return self._resume(ev, self._down_values(new, rules, f), new, None, konts, owe)
        if f is None:
            return ("ret", new, owe)
        r = f(self, new)
        if type(r) is GENERATOR:
            return self._resume(ev, r, new, None, konts, owe)
        owe += _collect(ev, mem.made)
        if r is None or same(r, new):
            return ("ret", new, owe)
        return ("eval", r, owe)

    def _down_values(self, call, rules, f):
        """A generator builtin: the first of the definitions whose lhs matches call, its rhs with the bindings put in,
        evaluated in the call's place; else the builtin f's rule, if any.

        rules is the published tuple of definitions as the call began.  Nothing else runs until this first suspends
        (a condition or a test evaluated, or f's own request), so before that it pins them: a definition replaced or
        cleared meanwhile keeps its charge until no reader has it (Definition), and the tuple's references are
        charged here until the end, however it ends."""
        pins = _Pins(rules)
        try:
            for d in rules:
                keep = mem.Held("A pattern match", "Pattern")
                try:
                    b = yield from pattern.match(self, d.lhs, call, keep, pins.pin)
                    if b is not None:
                        r = pattern.substitute(d.rhs, b, mem.made)
                        b = None
                        # (a rewrite to the same expression is a fixed point: the call is its value, as the oracle
                        # has it)
                        return None if same(r, call) else Tail(r)
                finally:
                    keep.release()
            if f is None:
                return None
            r = f(self, call)
            if type(r) is GENERATOR:
                pins.pin()
                r = yield from r
                return r
            if r is None or same(r, call):
                return None
            return Tail(r)
        finally:
            pins.unpin()

    def _resume(self, ev, g, call, val, konts, owe):
        """The generator g resumed with val (its charge in mem.received): ("ret"|"eval", value, charge).  What g
        didn't take of val stays with its frame; what it left in mem.made is its result's or its request's."""
        try:
            req = g.send(val)
        except StopIteration as stop:
            r = stop.value
            val = None
            rc, md = mem.received, mem.made
            if rc.reserved:
                owe += _collect(ev, rc)
            if md.reserved:
                owe += _collect(ev, md)
            if type(r) is Tail:
                return ("eval", r.e, owe)
            return ("ret", call if r is None else r, owe)
        val = None
        rc, md = mem.received, mem.made
        if rc.reserved:
            owe += _collect(ev, rc)
        konts.append(("gen", g, call, owe))
        return ("eval", req[1], _collect(ev, md) if md.reserved else 0)

    def _thread(self, head, args):
        """head threaded over the lists among args, all of one length; None when there are none, or when their
        lengths differ (left as it is, with Thread::tdlen)."""
        n = None
        for x in args:
            if type(x) is Expr and x.head is LIST:
                if n is None:
                    n = len(x.args)
                elif len(x.args) != n:
                    self.message("Thread", "tdlen")
                    return None
        if n is None:
            return None
        with mem.produce((n + 1) * (len(args) + 1) * mem.NODE_BYTES, "A list of " + mem.count(n, "element"), head.name):
            items = []
            for i in range(n):
                items.append(Expr(head, *[x.args[i] if type(x) is Expr and x.head is LIST else x for x in args]))
            return Expr(LIST, *items)


def _close_all(konts):
    """Close the suspended generators on the continuation stack, the innermost first, each popped once it is closed
    (closing is idempotent, so one interrupted between the two is closed again; nothing is made to do so); if the loop
    is interrupted anywhere, the rest are closed in its finally (a nesting only as deep as the interruptions), and the
    interruption goes on."""
    done = False
    try:
        while konts:
            k = konts[-1]
            if k[0] == "gen":
                k[1].close()
            konts.pop()
        done = True
    finally:
        if not done:
            _close_all(konts)


def _retire_all(defs, i):
    """Retire defs[i:] (Definition.retire is idempotent); if interrupted anywhere, the rest are retired in the
    finally, the interrupted one again."""
    done = False
    try:
        while i < len(defs):
            defs[i].retire()
            i += 1
        done = True
    finally:
        if not done:
            _retire_all(defs, i)


def _drain(items, lo):
    """Release items[lo:], the last first, each popped once released (a release is idempotent, so one interrupted
    between the two is released again); if the loop is interrupted anywhere, the rest go on in its finally."""
    done = False
    try:
        while len(items) > lo:
            items[-1].release()
            items.pop()
        done = True
    finally:
        if not done:
            _drain(items, lo)


def _levels(n):
    return "An evaluation " + mem.count(n, "level") + " deep"


def _expression(v):
    return "An expression of " + mem.count(size_of(v), "node")


def _held_subject():
    return "An evaluation's expressions"


def _collect(ev, h):
    """h's charge moved into the evaluation's holder: the bytes moved."""
    if not h.reserved:
        return 0
    n = h.used
    ev.take(h)
    return n


def _release(ev, n):
    """n bytes of ev no longer needed."""
    if n:
        ev.used -= n
        if ev.reserved > ev.trim and ev.reserved - ev.used > 2 * ev.chunk:
            ev.shrink(0)


def _settle(ev, have, v):
    """A level's charge, `have` bytes of ev, made exactly v's tree size: the value is all it still holds (growth
    admitted; within the reservation, and a shrink, without a call)."""
    nb = (v.size if type(v) is Expr else size_of(v)) * mem.NODE_BYTES
    d = nb - have
    if d > 0:
        if ev.used + d > ev.reserved:
            ev.grow(d, (_expression, v))
        else:
            ev.used += d
    elif d:
        ev.used += d
        if ev.reserved > ev.trim and ev.reserved - ev.used > 2 * ev.chunk:
            ev.shrink(0)
    return nb


class Definition:
    """A down value: its lhs and rhs, charged by r while it is published or a reader has it pinned (§8.4)."""

    def __init__(self, key, lhs, rhs, r):
        self.key, self.lhs, self.rhs, self.r = key, lhs, rhs, r
        self.pins = 0
        self.published = True

    def retire(self):
        """No longer published: its charge given back now, or when its last reader ends."""
        self.published = False
        if self.pins == 0:
            self.r.release()


class _Pins:
    """A reader's pins on a tuple of definitions: pin() before its first suspension (the tuple's references charged
    first, then each definition pinned in turn), unpin() at its end, undoing exactly those pinned.  `count` is how many
    of rules, from the first, are pinned.  Each step changes a definition's pins and the count; if it is interrupted
    (a Stop), its finally makes the count agree with what was done; and if unpin()'s loop is interrupted anywhere, its
    checkpoints included, it goes on with the rest in its finally, so neither a pin nor an unpin is lost or done
    twice."""

    def __init__(self, rules):
        self.rules = rules
        self.h = None
        self.count = 0

    def pin(self):
        if self.h is not None:
            return
        h = mem.Held("A definition's references", "Evaluation")
        self.h = h
        h.grow(len(self.rules) * mem.SLOT_BYTES)
        for d in self.rules:
            k, p = self.count, d.pins
            done = False
            try:
                d.pins = p + 1
                self.count = k + 1
                done = True
            finally:
                if not done:
                    self.count = k + 1 if d.pins == p + 1 else k

    def unpin(self):
        done = False
        try:
            while self.count:
                k = self.count - 1
                d = self.rules[k]
                p = d.pins
                stepped = False
                try:
                    d.pins = p - 1
                    self.count = k
                    if d.pins == 0 and not d.published:
                        d.r.release()
                    stepped = True
                finally:
                    if not stepped:
                        if d.pins == p - 1:
                            self.count = k
                            if d.pins == 0 and not d.published:
                                d.r.release()
                        else:
                            self.count = k + 1
            done = True
        finally:
            # (interrupted anywhere in the loop, its checkpoints included: the rest is unpinned now, in this finally)
            if not done:
                self.unpin()
            elif self.h is not None:
                self.h.release()
