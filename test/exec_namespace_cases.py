# vars(), dir(), globals() and locals() in exec() and eval() with a dict, with
# separate locals, and in functions, as CPython 3.14 (test/coverage-fixes.test.ts).
ns = {"a": 1}
for src in ["print(sorted(vars()))", "print(dir())", "print(sorted(globals()))", "print(sorted(locals()))", "x = 2\nprint(vars()['x'], dir())", "def f():\n    y = 1\n    return dir(), sorted(vars())\nprint(f())"]:
    try:
        exec(src, dict(ns))
    except Exception as e:
        print(type(e).__name__, str(e)[:150])
try:
    print(sorted(eval("vars()", {"q": 1})))
except Exception as e:
    print(type(e).__name__, str(e)[:150])
exec("print(sorted(vars()), dir())", {"g": 1}, {"l": 2})
exec("print(sorted(globals()), sorted(locals()), dir())", {"g": 1}, {"l": 2})
exec("z = 3\nprint(sorted(locals()))", None, {"l": 2})
def f():
    k = 1
    exec("print(sorted(locals()), 'k' in globals())")
    exec("w = 1\nprint(sorted(vars()))", {"G": 0})
f()
print(sorted(eval("locals()", {"a": 1}, {"b": 2})), sorted(eval("globals()", {"a": 1}, {"b": 2})))
d = {}
exec("pass", d)
print(type(d["__builtins__"]).__name__)
import builtins
print(d["__builtins__"] is builtins.__dict__, "abs" in d["__builtins__"])
d2 = {}
eval("1", d2)
print(type(d2["__builtins__"]).__name__)
try:
    exec("vars(__builtins__)", {})
except TypeError as e:
    print(e)
# vars() of objects with no __dict__ is a TypeError (a dict's, a list's,
# an int's: object's generic __dict__ is not theirs), not an AttributeError
# (object() and a slotted instance aside: Sagebrush's have a __dict__, a
# divergence of their own);
# of those with one, it is (a function's, a class's, a module's, an
# instance's, a slotted instance's with __dict__ in its slots)
def _f():
    pass
_f.tag = 7
class _D:
    __slots__ = ("a", "__dict__")
class _P:
    pass
_p = _P()
_p.x = 1
_d = _D()
_d.y = 2
for _o in [{}, {1: 2}, [], 1, 2.5, "s", (), None, len]:
    try:
        vars(_o)
        print("vars", type(_o).__name__, "ok")
    except Exception as e:
        print("vars", type(_o).__name__, type(e).__name__, e)
import math
print(vars(_f), vars(_p), vars(_d), "sqrt" in vars(math), "__init__" in vars(_P))
