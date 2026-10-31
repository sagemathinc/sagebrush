# A module whose import raised leaves sys.modules, as CPython's _load_unlocked
# deletes the entry, so the next import runs it again (the remote preview's
# 14(c): a Stop during the first `import time` left a `time` with no sleep).
# Its output is CPython 3.14.4's, written into test/import-failed.test.ts.
import sys


class Finder:
    fail = KeyboardInterrupt
    replace = False

    def find_spec(self, name, path=None, target=None):
        if name != "metamod":
            return None
        try:
            from importlib.machinery import ModuleSpec
        except ImportError:  # (Sagebrush's import reads only the spec's loader)
            import types
            return types.SimpleNamespace(name=name, loader=self)
        return ModuleSpec(name, self)

    def create_module(self, spec):
        return None

    def exec_module(self, module):
        module.x = 1
        if Finder.replace:
            sys.modules["metamod"] = "a stand-in"
        if Finder.fail is not None:
            raise Finder.fail("in exec_module")
        module.y = 2


sys.meta_path.insert(0, Finder())
for label, fail, replace in [("KeyboardInterrupt", KeyboardInterrupt, False), ("ValueError", ValueError, False), ("replaced, then raised", ValueError, True)]:
    Finder.fail, Finder.replace = fail, replace
    try:
        import metamod
        print(label, "imported?")
    except BaseException as e:
        print(label, "raised", type(e).__name__)
    print(label, "left in sys.modules:", "metamod" in sys.modules)
    Finder.fail, Finder.replace = None, False
    import metamod
    print(label, "then imported again, complete:", metamod.x, metamod.y)
    del sys.modules["metamod"]
