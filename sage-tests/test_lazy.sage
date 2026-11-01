# The lazy-import shim (lib/_sage_lazy.py; plan-sage-lazy-chunks r2, step 1),
# on its private fixture module.  The .out pins sagebrush's own contract
# (written by hand by @sagebrush-sage2): Sage's LazyImport differs in detail.
import sys
import _sage_lazy
from _sage_lazy import LazyImport, lazy_import, bind
def err(f):
    try:
        return "no error: %s" % (f(),)
    except Exception as ex:
        return type(ex).__name__
# this session was bound by Sage mode's start
print(any(ns is globals() for ns in _sage_lazy._SESSIONS))
# installing imports nothing
lazy_import("_sage_lazy_fixture", ["Thing", "double"], globals())
T0 = Thing
print("_sage_lazy_fixture" in sys.modules, type(Thing).__name__)
# one isinstance check imports it, once
print(isinstance(5, Thing), "_sage_lazy_fixture" in sys.modules)
fixture = sys.modules["_sage_lazy_fixture"]
# the session slot is now the real class; the saved alias stays a stub
print(Thing is fixture.Thing, type(T0).__name__, T0 is Thing)
print(isinstance(fixture.Thing(1), T0), T0(2))
# one stub copied into two bound namespaces, an overwritten slot, an unbound alias
stub = LazyImport("_sage_lazy_fixture", "double", {})
ns1 = {"double": stub}; ns2 = {"double": stub}; ns3 = {"double": stub}
bind(ns1); bind(ns2)
ns2["double"] = "mine"
print(stub(3), ns1["double"] is fixture.double, ns2["double"], ns3["double"] is stub)
# docs and repr come from the target
print(LazyImport("_sage_lazy_fixture", "double", {}).__doc__)
print(repr(LazyImport("_sage_lazy_fixture", "Thing", {})(7)))
# subclassing and issubclass with the stub as the class; as argument 1 it is not a class
P = LazyImport("_sage_lazy_fixture", "Thing", {})
class Sub(P):
    pass
print(Sub(4), issubclass(Sub, P), issubclass(int, P), err(lambda: issubclass(P, object)))
# a failure caches nothing: the next use tries again
F = LazyImport("_sage_lazy_fixture", "later", {})
print(err(lambda: F()))
fixture.later = lambda: 7
print(F())
# copy gives the target
import copy
D = LazyImport("_sage_lazy_fixture", "double", {})
print(copy.copy(D) is fixture.double, copy.deepcopy(D) is fixture.double)
# bind rebinds a stub already resolved
ns4 = {"double": D}
bind(ns4)
print(ns4["double"] is fixture.double)
