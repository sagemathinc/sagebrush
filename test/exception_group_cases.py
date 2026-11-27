# ExceptionGroup and BaseExceptionGroup as CPython 3.14's builtins
# (test/corpus-fixes.test.ts compares this file's output with CPython's).
import builtins


def show(label, thunk):
    try:
        print(label, repr(thunk()))
    except BaseException as e:
        print(label, type(e).__name__ + ":", e)


def shape(g):
    # (a group's tree: its type, message and leaves, nested groups as lists)
    if isinstance(g, BaseExceptionGroup):
        return (type(g).__name__, g.message, [shape(e) for e in g.exceptions])
    return repr(g)


# --- the builtins and their relations
print("in builtins:", "ExceptionGroup" in dir(builtins), "BaseExceptionGroup" in dir(builtins))
print("mro:", [c.__name__ for c in ExceptionGroup.__mro__])
print("mro base:", [c.__name__ for c in BaseExceptionGroup.__mro__])
print("issubclass:", issubclass(ExceptionGroup, Exception), issubclass(BaseExceptionGroup, Exception), issubclass(ExceptionGroup, BaseExceptionGroup))
print("module:", ExceptionGroup.__module__, BaseExceptionGroup.__module__)

# --- construction
eg = ExceptionGroup("there were problems", [ValueError(1), TypeError("t")])
print("str:", str(eg))
print("repr:", repr(eg))
print("message:", eg.message, "exceptions:", eg.exceptions, type(eg.exceptions).__name__)
print("args:", eg.args)
print("one:", str(ExceptionGroup("m", [ValueError()])))
print("type of Base with Exceptions:", type(BaseExceptionGroup("m", [ValueError()])).__name__)
print("type of Base with a BaseException:", type(BaseExceptionGroup("m", [KeyboardInterrupt()])).__name__)
print("from a tuple:", ExceptionGroup("m", (ValueError(1),)).exceptions)
show("nest a BaseException in ExceptionGroup:", lambda: ExceptionGroup("m", [KeyboardInterrupt()]))
show("message not a str:", lambda: ExceptionGroup(1, [ValueError()]))
show("exceptions not a sequence:", lambda: ExceptionGroup("m", ValueError()))
show("exceptions a set:", lambda: ExceptionGroup("m", {ValueError()}))
show("empty:", lambda: ExceptionGroup("m", []))
show("an item not an exception:", lambda: ExceptionGroup("m", [ValueError(), 1]))
show("an exception class, not an instance:", lambda: ExceptionGroup("m", [ValueError]))
show("one argument:", lambda: ExceptionGroup("m"))
show("three arguments:", lambda: ExceptionGroup("m", [ValueError()], 3))
show("keywords:", lambda: ExceptionGroup(message="m", exceptions=[ValueError()]))

# --- raising and catching, as the tutorial does
def f():
    excs = [OSError('error 1'), SystemError('error 2')]
    raise ExceptionGroup('there were problems', excs)


try:
    f()
except Exception as e:
    print(f'caught {type(e)}: {e}')

try:
    raise BaseExceptionGroup("b", [KeyboardInterrupt(), ValueError()])
except Exception:
    print("caught as Exception: wrong")
except BaseException as e:
    print("caught as BaseException:", type(e).__name__, e)

# --- subgroup and split
nested = ExceptionGroup("outer", [ValueError(1), ExceptionGroup("inner", [TypeError(2), ValueError(3)]), KeyError(4)])
print("subgroup type:", shape(nested.subgroup(ValueError)))
print("subgroup tuple:", shape(nested.subgroup((TypeError, KeyError))))
print("subgroup predicate:", shape(nested.subgroup(lambda e: isinstance(e, ValueError) and e.args[0] > 1)))
print("subgroup none:", nested.subgroup(OSError))
print("subgroup all:", nested.subgroup(Exception) is nested)
print("subgroup self by predicate:", nested.subgroup(lambda e: e is nested) is nested)
match, rest = nested.split(ValueError)
print("split match:", shape(match))
print("split rest:", shape(rest))
match, rest = nested.split(OSError)
print("split none:", match, shape(rest))
match, rest = nested.split(Exception)
print("split all:", match is nested, rest)
show("subgroup bad condition:", lambda: nested.subgroup(1))
show("split bad condition:", lambda: nested.split("x"))
show("subgroup a non-exception class:", lambda: nested.subgroup(int))

# --- what a derived group keeps: the message, __cause__, __context__, __notes__ (not __traceback__'s identity)
src = ExceptionGroup("keep", [ValueError(1), TypeError(2)])
src.__cause__ = RuntimeError("cause")
src.__context__ = LookupError("context")
src.add_note("a note")
sub = src.subgroup(ValueError)
print("derived:", type(sub).__name__, sub.message, repr(sub.__cause__), repr(sub.__context__), sub.__notes__, sub.__notes__ is src.__notes__)
d = src.derive([KeyError(9)])
print("derive:", type(d).__name__, d.message, d.exceptions, d.__cause__, d.__notes__ if hasattr(d, "__notes__") else "no notes")
print("derive base:", type(BaseExceptionGroup("b", [KeyboardInterrupt()]).derive([ValueError()])).__name__)
print("derive keeps base:", type(BaseExceptionGroup("b", [KeyboardInterrupt()]).derive([KeyboardInterrupt()])).__name__)


# --- subclasses
class MyGroup(ExceptionGroup):
    def derive(self, excs):
        return MyGroup(self.message + "!", excs)


g = MyGroup("mine", [ValueError(1), TypeError(2)])
print("subclass:", type(g).__name__, str(g), repr(g))
print("subclass subgroup:", shape(g.subgroup(ValueError)))
m, r = g.split(TypeError)
print("subclass split:", shape(m), shape(r))


class Plain(ExceptionGroup):
    pass


p = Plain("plain", [ValueError(1), TypeError(2)])
print("plain subclass subgroup:", shape(p.subgroup(ValueError)))


class WithInit(ExceptionGroup):
    def __new__(cls, message, excs, code):
        obj = super().__new__(cls, message, excs)
        obj.code = code
        return obj

    def __init__(self, message, excs, code):
        super().__init__(message, excs)

    def derive(self, excs):
        return WithInit(self.message, excs, self.code)


w = WithInit("w", [ValueError()], 42)
print("with init:", w.code, w.args, str(w))
show("Base subclass with Exceptions only:", lambda: type(type("B", (BaseExceptionGroup,), {})("m", [ValueError()])).__name__)

# --- generic alias, and the exceptions tuple being read-only
print("class_getitem:", ExceptionGroup[ValueError], BaseExceptionGroup[KeyError])
show("set exceptions:", lambda: setattr(eg, "exceptions", ()))
show("set message:", lambda: setattr(eg, "message", "x"))
lst = [ValueError(5)]
eg2 = ExceptionGroup("m", lst)
lst.append(TypeError(6))
print("list copied:", eg2.exceptions, len(eg2.args[1]))
print("repr after mutation:", repr(eg2), str(eg2))
print("repr from a tuple:", repr(ExceptionGroup("m", (ValueError(1),))))
print("repr nested:", repr(nested))


class BadDerive(ExceptionGroup):
    def derive(self, excs):
        return ValueError("not a group")


show("derive returning a non-group:", lambda: BadDerive("m", [ValueError(1), TypeError(2)]).subgroup(ValueError))


class Mine(ExceptionGroup):
    pass


class B(BaseExceptionGroup):
    pass


class E(BaseExceptionGroup, Exception):
    pass


show("subclass nesting a BaseException:", lambda: Mine("m", [KeyboardInterrupt()]))
print("Base subclass keeps a BaseException:", type(B("m", [KeyboardInterrupt()])).__name__)
show("Base+Exception subclass nesting:", lambda: E("m", [KeyboardInterrupt()]))
show("del exceptions:", lambda: delattr(eg, "exceptions"))
print("shared methods:", ExceptionGroup.__new__ is BaseExceptionGroup.__new__, ExceptionGroup.__init__ is BaseExceptionGroup.__init__)
print("qualnames:", BaseExceptionGroup.derive.__qualname__, BaseExceptionGroup.split.__qualname__, BaseExceptionGroup.subgroup.__qualname__)
print("own names:", sorted(k for k in vars(BaseExceptionGroup) if not k.startswith("__") or k in ("__str__", "__repr__", "__init__", "__new__", "__class_getitem__")))
print("docs:", BaseExceptionGroup.__doc__, ExceptionGroup.__doc__)
show("a str is a sequence:", lambda: ExceptionGroup("m", "ab"))


# --- a part's __suppress_context__ (set with its cause, as PyException_SetCause), and notes that are a str or a dict
part = ExceptionGroup("p", [ValueError(1), TypeError(2)]).subgroup(ValueError)
print("part suppresses context:", part.__suppress_context__, ExceptionGroup("q", [ValueError()]).__suppress_context__)
s_notes = ExceptionGroup("s", [ValueError(1), TypeError(2)])
s_notes.__notes__ = "ab"
print("str notes:", s_notes.subgroup(ValueError).__notes__)
d_notes = ExceptionGroup("d", [ValueError(1), TypeError(2)])
d_notes.__notes__ = {"k": 1}
print("dict notes:", hasattr(d_notes.subgroup(ValueError), "__notes__"))
t_notes = ExceptionGroup("t", [ValueError(1), TypeError(2)])
t_notes.__notes__ = ("x", "y")
print("tuple notes:", t_notes.subgroup(ValueError).__notes__)


# --- a part raised while handling another exception: its context is set but
# suppressed, so the chain a traceback prints is the part alone (as CPython's
# traceback walks it: __cause__, else __context__ unless suppressed)
def chain(e):
    out = []
    while e is not None:
        out.append(type(e).__name__)
        e = e.__cause__ if e.__cause__ is not None else (None if e.__suppress_context__ else e.__context__)
    return out


src_group = ExceptionGroup("src", [ValueError(1), TypeError(2)])
for how in ("subgroup", "split"):
    part = src_group.subgroup(ValueError) if how == "subgroup" else src_group.split(ValueError)[0]
    try:
        try:
            raise KeyError("while handling")
        except KeyError:
            raise part
    except ExceptionGroup as e:
        print("raised", how, "part:", type(e.__context__).__name__, e.__suppress_context__, chain(e))
plain = ExceptionGroup("plain", [ValueError(3)])
try:
    try:
        raise KeyError("while handling")
    except KeyError:
        raise plain
except ExceptionGroup as e:
    print("raised a plain group:", type(e.__context__).__name__, e.__suppress_context__, chain(e))
show("keywords to __init__:", lambda: ExceptionGroup("m", [ValueError()], x=1))
