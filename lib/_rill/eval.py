"""Rill's evaluator, A1.1's part (design/rill.md §4, §8).

A1.1 evaluates what its builtins need: constants, symbols, assignment,
`(`, `{`, `&&`, `||`, `quote` and calls of builtins.  It walks the tree with
an explicit continuation stack, never host recursion, and counts nested
calls against `options(expressions)` (5000), as R does (rill-tests/parse/
test_4.R, test_5.R).  A1.3 replaces it with the full trampoline (closures,
promises, control flow), which keeps this shape.

Errors are RError (R's message and, if R names one, the call); a
construct A1.1 doesn't evaluate yet is NotSupported, Rill's own message.
Nothing here catches Stop (KeyboardInterrupt) or any exception it doesn't
name (design §8.1).
"""

from .values import MISSING, NULL, Formals, Lang, Placeholder, Sym, RVector, chr_

NESTED_TOO_DEEPLY = "evaluation nested too deeply: infinite recursion / options(expressions=)?"
# A1.3 evaluates these (closures and control flow); A1.1 says so
LATER = {"function": "A1.3", "if": "A1.3", "for": "A1.3", "while": "A1.3", "repeat": "A1.3",
         "break": "A1.3", "next": "A1.3"}


class RError(Exception):
    """An R error: its message and the call R names in "Error in <call> :", or None."""

    def __init__(self, message, call=None):
        Exception.__init__(self, message)
        self.message = message
        self.call = call


class NotSupported(Exception):
    """Something Rill doesn't evaluate yet; its message is Rill's, not R's."""

    def __init__(self, what):
        Exception.__init__(self, what)
        self.what = what


class Session:
    """One Rill session: its global variables, options and pending warnings."""

    def __init__(self, write_out, write_err):
        from . import base
        self.globals = {}
        self.builtins = base.BUILTINS
        self.values = base.VALUES
        self.preflight = base.PREFLIGHT
        self.formals = base.FORMALS
        self.options = {"expressions": 5000, "digits": 7, "scipen": 0, "width": 80}
        self.warnings = []      # (call or None, message), printed after the statement
        self.write_out = write_out
        self.write_err = write_err
        self.visible = True
        self.depth = 0

    def warn(self, message, call=None):
        self.warnings.append((call, message))

    # ---------------------------------------------------------------- lookup

    def lookup(self, name):
        """A variable's value: R's global environment, then the builtins.  Nothing
        else is reachable by name (design §9's R-only boundary)."""
        v = self.globals.get(name)
        if v is not None:
            return v
        if name in self.values:
            return self.values[name]
        if name in self.builtins:
            raise NotSupported("a function as a value")
        raise RError("object '%s' not found" % name)

    def function(self, name, call):
        if name in LATER:
            raise NotSupported("'%s'" % name)
        f = self.builtins.get(name)
        if f is None:
            raise RError('could not find function "%s"' % name, call)
        return f

    # ---------------------------------------------------------------- evaluation

    def evaluate(self, expr):
        """expr's value; self.visible says whether the top level prints it."""
        konts = []
        mode, val = "eval", None
        depth0 = self.depth
        try:
            while True:
                if mode == "eval":
                    e = expr
                    if isinstance(e, RVector) or e is NULL:
                        val, self.visible, mode = e, True, "return"
                    elif isinstance(e, Sym):
                        val, self.visible, mode = self.lookup(e.name), True, "return"
                    elif isinstance(e, Lang):
                        mode, expr, val = self._enter(e, konts)
                    elif e is MISSING:
                        # (an empty index, as in x[]: `[` reads it as all of x)
                        val, self.visible, mode = e, True, "return"
                    else:
                        raise NotSupported("evaluating this kind of value")
                    continue
                if not konts:
                    return val
                k = konts.pop()
                kind = k[0]
                if kind == "args":
                    _, e, f, done, i, plan = k
                    done.append((e.args[i - 1][0], val))
                    if i < len(e.args):
                        konts.append(("args", e, f, done, i + 1, plan))
                        expr, mode = self._arg(e, i), "eval"
                        continue
                    val = self._apply(f, e, _named(done, plan))
                elif kind == "dollar":
                    # (x$name: only x is evaluated; the name is the field's, never a variable)
                    _, e, f = k
                    val = self._apply(f, e, [(None, val)])
                elif kind == "assign":
                    _, e, name, superassign = k
                    self.globals[name] = val
                    self.visible = False
                elif kind == "paren":
                    self.visible = True
                elif kind == "brace":
                    _, e, i = k
                    if i < len(e.args):
                        konts.append(("brace", e, i + 1))
                        expr, mode = e.args[i][1], "eval"
                        continue
                elif kind == "andand":
                    _, e, stage, left = k
                    op = e.fn.name
                    if stage == 1:
                        x = self._flag(val, "x", op, e)
                        if (op == "&&" and x is False) or (op == "||" and x is True):
                            val = RVector("logical", [x])
                        else:
                            konts.append(("andand", e, 2, x))
                            expr, mode = e.args[1][1], "eval"
                            continue
                    else:
                        y = self._flag(val, "y", op, e)
                        if op == "&&":
                            r = False if (left is False or y is False) else (None if (left is None or y is None) else True)
                        else:
                            r = True if (left is True or y is True) else (None if (left is None or y is None) else False)
                        val = RVector("logical", [r])
                    self.visible = True
                self.depth -= 1
        finally:
            self.depth = depth0

    def _arg(self, e, i):
        return e.args[i][1]

    def _enter(self, e, konts):
        """Start evaluating call e: (mode, expr, val) for the loop."""
        self.depth += 1
        if self.depth > self.options["expressions"]:
            raise RError(NESTED_TOO_DEEPLY)
        fn = e.fn
        if not isinstance(fn, Sym):
            if isinstance(fn, RVector) or fn is NULL:
                raise RError("attempt to apply non-function")
            raise NotSupported("calling a function value")
        name = fn.name
        args = e.args
        if name == "quote":
            if len(args) != 1 or args[0][0] is not None:
                raise NotSupported("quote() with these arguments")
            self.visible = True
            self.depth -= 1
            return "return", None, args[0][1]
        if name in ("<-", "=", "<<-"):
            target = args[0][1]
            if isinstance(target, Sym):
                tname = target.name
            elif isinstance(target, RVector) and target.type == "character" and len(target.data) == 1:
                tname = target.data[0]
            elif isinstance(target, Lang):
                raise NotSupported("replacement assignment such as x[i] <- v")
            else:
                raise RError("invalid (do_set) left-hand side to assignment", e)
            konts.append(("assign", e, tname, name == "<<-"))
            return "eval", args[1][1], None
        if name == "(":
            konts.append(("paren", e))
            return "eval", args[0][1], None
        if name == "{":
            if not args:
                self.visible = True
                self.depth -= 1
                return "return", None, NULL
            konts.append(("brace", e, 1))
            return "eval", args[0][1], None
        if name in ("&&", "||"):
            konts.append(("andand", e, 1, None))
            return "eval", args[0][1], None
        f = self.function(name, e)
        if name == "$":
            if len(args) != 2:
                raise NotSupported("$ with these arguments")
            konts.append(("dollar", e, f))
            return "eval", args[0][1], None
        # (a call's shape is checked before any argument is evaluated, so neither R's matching error nor a
        # refusal follows an argument's effect: design §9, rill-tests/args/)
        for _, v in args:
            if v is MISSING and name != "[":
                raise NotSupported("an empty argument")
        sig = self.formals.get(name)
        plan = None
        if sig is not None:
            from .args import match
            plan = match(e, sig, name)
        check = self.preflight.get(name)
        if check is not None:
            check(e, plan)
        if not args:
            return "return", None, self._apply_now(f, e, [], konts)
        konts.append(("args", e, f, [], 1, plan))
        return "eval", self._arg(e, 0), None

    def _apply_now(self, f, e, done, konts):
        v = self._apply(f, e, done)
        self.depth -= 1
        return v

    def _apply(self, f, e, args):
        self.visible = True
        return f(self, e, args)

    def _flag(self, v, which, op, call):
        """&&'s and ||'s operand as True, False or None (NA), with R's errors."""
        if isinstance(v, RVector) and v.type in ("logical", "integer", "double"):
            if len(v.data) > 1:
                raise RError("'length = %d' in coercion to 'logical(1)'" % len(v.data), call)
            if len(v.data) == 0:
                raise NotSupported("a zero-length operand of %s" % op)
            x = v.data[0]
            if x is None or x != x:
                return None
            return bool(x)
        if which == "x":
            raise RError("invalid 'x' type in 'x %s y'" % op, call)
        raise NotSupported("this type as the second operand of %s" % op)


def _named(done, plan):
    """The evaluated arguments, each under the formal it matched (args.match), or its own name where it went to
    `...`: what a builtin reads."""
    if plan is None:
        return done
    return [(plan[j] if plan[j] is not None else name, v) for j, (name, v) in enumerate(done)]


def is_language(v):
    return isinstance(v, (Lang, Sym, Formals, Placeholder))


def as_name(v):
    return chr_([v.name]) if isinstance(v, Sym) else v
