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
from .expr import Expr, Sym, NULL, LIST, same, size_of, sort_canonical

SEQUENCE = Sym("Sequence")
# (the type of a generator builtin's call)
GENERATOR = type((lambda: (yield))())
# the continuation stack is reserved in chunks of this many frames
KONT_CHUNK = 4096


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
        self.symbols = {}              # the names this session made (Sym's session table)
        self.holds = []                # reservations a builtin holds across its yields, released at its end or Stop
        self.names = []                # the reservations charging this session's names (symbols), in NAME_CHUNKs
        self.name_bytes = 0            # their charge so far, and what is reserved for it
        self.name_reserved = 0
        self.builtins = base.BUILTINS
        self.attributes = base.ATTRIBUTES
        self.texts = dict(base.MESSAGES)   # (symbol name, tag) -> text
        self.write_out = write_out     # Print's lines
        self.write_err = write_err     # messages
        self.messages = []             # this statement's messages, "f::tag: text"

    # ---------------------------------------------------------------- definitions and the session's lifetime

    def define(self, sym, value, name):
        """Give sym its value, charging the value's nodes to the ledger for as long as it is defined (§8.4).  The new
        charge is reserved first (a refusal leaves the old definition), then the value and its reservation are
        published in one store, and the replaced value's reservation is given back.  Each definition is charged on
        its own, even when values share structure: an upper bound."""
        n = size_of(value)
        r = mem.reserve((n + 1) * mem.NODE_BYTES, "A definition of %d nodes" % n, name)
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
            r = mem.reserve(size, "A name of %d character%s" % (len(name), "" if len(name) == 1 else "s"), "Symbol")
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
        """The session's end: every definition's reservation given back, and its names dropped."""
        own, self.own = self.own, {}
        for _, r in own.values():
            r.release()
        for r in self.holds:
            r.release()
        self.holds = []
        for r in self.names:
            r.release()
        self.names = []
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
            return self.attributes.get(head.name, ())
        return ()

    # ---------------------------------------------------------------- evaluation

    def evaluate(self, expr):
        """expr's value."""
        konts = []
        holds0 = len(self.holds)       # (the builtins' holds from here on are this evaluation's)
        chunks = []                    # the continuation stack's reservations
        limit = 0                      # frames reserved so far
        mode_eval = True
        val = None
        try:
            while True:
                if len(konts) >= limit:
                    r = mem.reserve(KONT_CHUNK * mem.KONT_BYTES, "An evaluation %d levels deep" % (limit + KONT_CHUNK),
                                    "Evaluation")
                    r.acquire()
                    chunks.append(r)
                    limit += KONT_CHUNK
                if mode_eval:
                    e = expr
                    t = type(e)
                    if t is Sym:
                        v = self.own.get(e)
                        v = v[0] if v is not None else None
                        if v is None or v is e:
                            val, mode_eval = e, False
                        else:
                            expr = v
                        continue
                    if t is not Expr:
                        val, mode_eval = e, False
                        continue
                    konts.append(("head", e))
                    expr = e.head
                    continue
                if not konts:
                    return val
                k = konts.pop()
                kind = k[0]
                if kind == "head":
                    e = k[1]
                    head = val
                    held = self._held(head, e.args)
                    args = list(e.args)
                    i = self._next(held, args, 0)
                    if i is None:
                        r = self._apply(e, head, args, konts)
                    else:
                        konts.append(("args", e, head, args, held, i))
                        expr, mode_eval = args[i], True
                        continue
                elif kind == "args":
                    _, e, head, args, held, i = k
                    args[i] = val
                    j = self._next(held, args, i + 1)
                    if j is not None:
                        konts.append(("args", e, head, args, held, j))
                        expr, mode_eval = args[j], True
                        continue
                    r = self._apply(e, head, args, konts)
                else:
                    # ("gen", generator, the call): the value it asked for
                    r = self._resume(k[1], k[2], val, konts)
                # r: ("ret", value) or ("eval", expression)
                if r[0] == "eval":
                    expr, mode_eval = r[1], True
                else:
                    val = r[1]
        finally:
            for r in chunks:
                r.release()
            for r in self.holds[holds0:]:
                r.release()
            del self.holds[holds0:]

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

    def _apply(self, e, head, args, konts):
        """The call head[args] with its arguments evaluated: ("ret", value) or ("eval", next expression)."""
        a = self.attrs(head)
        if "SequenceHold" not in a and "HoldAllComplete" not in a:
            if any(type(x) is Expr and x.head is SEQUENCE for x in args):
                spliced = []
                for x in args:
                    if type(x) is Expr and x.head is SEQUENCE:
                        spliced.extend(x.args)
                    else:
                        spliced.append(x)
                args = spliced
        if "Flat" in a and any(type(x) is Expr and x.head is head for x in args):
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
                return ("eval", t)
        if "Orderless" in a and len(args) > 1:
            args = sort_canonical(args)
        if len(args) == len(e.args) and head is e.head and all(x is y for x, y in zip(args, e.args)):
            new = e
        else:
            new = Expr(head, *args)
        f = self.builtins.get(head.name) if type(head) is Sym else None
        if f is None:
            return ("ret", new)
        r = f(self, new)
        if type(r) is GENERATOR:
            return self._resume(r, new, None, konts)
        if r is None or same(r, new):
            return ("ret", new)
        return ("eval", r)

    def _resume(self, g, call, val, konts):
        try:
            req = g.send(val)
        except StopIteration as stop:
            r = stop.value
            if type(r) is Tail:
                return ("eval", r.e)
            return ("ret", call if r is None else r)
        konts.append(("gen", g, call))
        return ("eval", req[1])

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
        with mem.reserve(n * len(args) * mem.NODE_BYTES, "A list of %d elements" % n, head.name):
            items = []
            for i in range(n):
                items.append(Expr(head, *[x.args[i] if type(x) is Expr and x.head is LIST else x for x in args]))
            return Expr(LIST, *items)
