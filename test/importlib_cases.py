# importlib.import_module, invalidate_caches and reload's argument checks,
# and importlib.metadata's not-found and error paths (lib/importlib),
# compared with CPython 3.14 by test/stdlib-html-importlib.test.ts. A found
# distribution depends on what each side has installed, so it is checked
# apart from CPython, in that test.
import importlib
import importlib.metadata as md
import sys
import types


def show(label, f):
    try:
        r = f()
        print(label, "->", r.__name__ if isinstance(r, types.ModuleType) else ascii(r))
    except Exception as e:
        print(label, "raises", type(e).__name__, e)


show("absolute", lambda: importlib.import_module("json"))
show("dotted, the submodule itself", lambda: importlib.import_module("json.decoder"))
show("relative", lambda: importlib.import_module(".decoder", "json"))
show("relative, package dotted", lambda: importlib.import_module(".encoder", "json.decoder"))
show("relative, two levels", lambda: importlib.import_module("..", "json.decoder"))
show("relative, two levels and a name", lambda: importlib.import_module("..scanner", "json.decoder"))
show("relative, one dot alone", lambda: importlib.import_module(".", "json"))
show("relative without a package", lambda: importlib.import_module(".x"))
show("relative, package ''", lambda: importlib.import_module(".x", ""))
show("relative, package not a str", lambda: importlib.import_module(".x", 5))
show("relative beyond the top", lambda: importlib.import_module("...x", "a.b"))
show("empty name", lambda: importlib.import_module(""))
show("name not a str", lambda: importlib.import_module(5))
show("name bytes", lambda: importlib.import_module(b"json"))
show("missing", lambda: importlib.import_module("no_such_module_xyz"))
show("missing submodule", lambda: importlib.import_module("json.no_such_submodule"))
show("missing parent", lambda: importlib.import_module("no_such_parent_xyz.child"))
sys.modules["blocked_xyz"] = None
show("None in sys.modules", lambda: importlib.import_module("blocked_xyz"))
show("package ignored when absolute", lambda: importlib.import_module("json", "no.such"))
show("importlib.__import__", lambda: importlib.__import__("json.decoder"))
show("invalidate_caches", lambda: importlib.invalidate_caches())
show("reload, not a module", lambda: importlib.reload(5))
show("reload, not in sys.modules", lambda: importlib.reload(types.ModuleType("loose_xyz")))
fake = types.ModuleType("json")
show("reload, another object of the name", lambda: importlib.reload(fake))
show("missing submodule of importlib", lambda: importlib.import_module("importlib.no_such_xyz"))

show("version, not found", lambda: md.version("no-such-distribution-xyz-123"))
show("version, empty", lambda: md.version(""))
show("version, None", lambda: md.version(None))
show("version, int", lambda: md.version(5))
try:
    md.version("No_Such.Dist-xyz")
except md.PackageNotFoundError as e:
    print("not found:", ascii(str(e)), ascii(e.name), e.args, isinstance(e, ModuleNotFoundError), isinstance(e, ImportError))
e = md.PackageNotFoundError("abc")
print("PackageNotFoundError", ascii(str(e)), ascii(e.name), ascii(repr(e)), type(e).__mro__[1].__name__)
show("PackageNotFoundError two args, name", lambda: md.PackageNotFoundError("a", "b").name)
show("PackageNotFoundError no args, str", lambda: str(md.PackageNotFoundError()))
print("importlib all", sorted(importlib.__all__))
