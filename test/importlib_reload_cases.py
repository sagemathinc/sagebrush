# importlib.reload of a module and a package from files: CPython's output for this program and Sagebrush's are
# compared line for line by test/importlib-reload.test.ts. It writes its modules in a fresh folder of its own.
import importlib
import os
import sys
import tempfile

# (no bytecode: CPython would otherwise reuse a .pyc whose source changed within the same second at the same size)
sys.dont_write_bytecode = True
here = tempfile.mkdtemp()
sys.path.insert(0, here)


def write(rel, text):
    path = os.path.join(here, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as fh:
        fh.write(text)
    importlib.invalidate_caches()


write("rmod.py", "X = 1\nY = 'kept'\ndef f():\n    return X\nclass C:\n    def who(self):\n        return 'old'\n")
import rmod

f_old, C_old, c = rmod.f, rmod.C, rmod.C()
print("first", rmod.X, rmod.f(), c.who())

# (changed: the same module object, new names in, old names kept, the old function sees the new globals)
write("rmod.py", "X = 2\nZ = 3\ndef f():\n    return X * 10\nclass C:\n    def who(self):\n        return 'new'\n")
m = importlib.reload(rmod)
print("reloaded", m is rmod, rmod.X, rmod.Y, rmod.Z, rmod.f(), f_old(), f_old is rmod.f)
print("classes", rmod.C is C_old, c.who(), rmod.C().who(), isinstance(c, rmod.C))

# (an exception partway: the module keeps what ran, and stays in sys.modules)
write("rmod.py", "X = 5\nraise ValueError('half way')\nX = 6\n")
try:
    importlib.reload(rmod)
except ValueError as e:
    print("raised", e, rmod.X, sys.modules["rmod"] is rmod)

# (a module that replaces itself in sys.modules: reload returns what is there)
write("rself.py", "import sys, types\nX = 1\n")
import rself
write("rself.py", "import sys, types\nX = 2\nsys.modules[__name__] = types.SimpleNamespace(X='replacement')\n")
r = importlib.reload(rself)
print("replaced", r.X, rself.X, r is rself)

# (a package: its __init__ runs again)
write("rpkg/__init__.py", "N = 1\n")
import rpkg
write("rpkg/__init__.py", "N = 2\nfrom . import sub\n")
write("rpkg/sub.py", "S = 'sub'\n")
importlib.reload(rpkg)
print("package", rpkg.N, rpkg.sub.S, hasattr(rpkg, "__path__"))

# (the argument checks)
for bad in (3, "rmod"):
    try:
        importlib.reload(bad)
    except TypeError as e:
        print("TypeError", e)
import types
gone = types.ModuleType("gone_module")
try:
    importlib.reload(gone)
except ImportError as e:
    print("ImportError", e)
