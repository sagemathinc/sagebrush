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
