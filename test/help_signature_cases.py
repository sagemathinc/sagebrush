# help()'s signature line (lib/_pyjs_help.py's signature) for a compiled function, as CPython's
# str(inspect.signature(f)) prints it: run with the argument "inspect" under CPython, without it under Sagebrush
# (test/call-errors.test.ts). It reads the code object's co_varnames in CPython's order, and marks the positional-only
# parameters with "/".
import sys

def f1(a, b=2, *args, c, d=4, **kw): pass
def f2(a, /, b, *, c): pass
def f3(*args): pass
def f4(a, b, c=3): pass
def f5(*, k="x", **rest): pass
def f6(a, *r, q): pass
class K:
    def m(self, a, *rest, k=0): pass
fs = (f1, f2, f3, f4, f5, f6, K.m)
if "inspect" in sys.argv:
    import inspect
    for f in fs: print(str(inspect.signature(f)))
else:
    import _pyjs_help
    for f in fs: print(_pyjs_help.signature(f))
class P:
    def a(self, /, x): pass
    def b(self, x, /, y): pass
for f in (P().a, P().b, P.b):
    if "inspect" in sys.argv: print(str(inspect.signature(f)))
    else: print(_pyjs_help.signature(f))
