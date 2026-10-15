# dir() of a module, as CPython 3.14's module.__dir__: its own __dir__() if
# it defines one, else its __dict__'s names, not its type's attributes
# (test/coverage-fixes.test.ts).
import sys, os, math, json, types, collections

for m in (sys, os, math, json, collections):
    print(m.__name__, dir(m) == sorted(m.__dict__), "__class__" in dir(m), "__name__" in dir(m))
m = types.ModuleType("mm")
m.__dir__ = lambda: ["b", "a"]
print(dir(m))
m2 = types.ModuleType("m2", "doc")
m2.x = 1
print(dir(m2), m2.__doc__, m2.__package__, m2.__loader__, m2.__spec__)
class M(types.ModuleType):
    pass
print(dir(M("m3")))
