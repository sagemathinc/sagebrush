"""The Sage-mode name index (lib/_sage_names.py) against the eager Sage layer:
scripts/sage_names.py --check verifies it from the sources (AST); this
verifies it from the objects, on CPython with every module imported.

- NAMES: each name's module has the name, and it is the very object sage_all
  gives (`is`);
- ALIASES: the same object as the name it aliases;
- ALL: exactly sage_all.__all__;
- SHIM_NAMES: each name is the object the sage.* shim's old lookup found
  (the first of _sage_shim._SOURCES that has it), so looking it up in the
  index changes nothing;
- coverage: every public attribute of every source module, other than a
  module object, is in ALL or SHIM_NAMES (a binding the AST can't see, such
  as globals()[name] = ..., would show here).

    python engine/py/test_sage_names.py
"""
import importlib
import sys
import types

import sagebrush.sage  # noqa: F401 (imports the Sage layer: sage_all, eagerly)

import _sage_names as N  # noqa: E402
import _sage_shim  # noqa: E402
import sage_all  # noqa: E402


def _resolved(v):
    """v, or the object a _sage_lazy stub stands for (sage_all's table and
    cached_function are stubs until their first use)."""
    return v._get() if type(v).__name__ == "LazyImport" else v


def main():
    problems = []
    for name, mod in N.NAMES.items():
        m = importlib.import_module(mod)
        if not hasattr(m, name):
            problems.append("NAMES: %s has no %s" % (mod, name))
        elif getattr(m, name) is not _resolved(getattr(sage_all, name)):
            problems.append("NAMES: %s.%s is not sage_all.%s" % (mod, name, name))
    for alias, target in N.ALIASES.items():
        if getattr(sage_all, alias) is not getattr(sage_all, target):
            problems.append("ALIASES: %s is not %s" % (alias, target))
    if set(N.ALL) != set(sage_all.__all__):
        problems.append("ALL differs from sage_all.__all__: %s" % sorted(set(N.ALL) ^ set(sage_all.__all__))[:20])
    sources = [importlib.import_module(s) for s in _sage_shim._SOURCES]

    def first_source(name):
        for m in sources:
            if hasattr(m, name):
                return getattr(m, name)
        raise KeyError(name)

    for name, mod in N.SHIM_NAMES.items():
        got = getattr(importlib.import_module(mod), name, None)
        if got is not first_source(name):
            problems.append("SHIM_NAMES: %s from %s is not the old lookup's object" % (name, mod))
    known = set(N.ALL) | set(N.SHIM_NAMES)
    for m in sources:
        for name in dir(m):
            if name.startswith("_") or name in known:
                continue
            if isinstance(getattr(m, name), types.ModuleType):
                continue
            problems.append("coverage: %s.%s is reachable by sage.* but not in the index" % (m.__name__, name))
    for p in problems[:40]:
        print(p)
    assert not problems, "%d problems" % len(problems)
    print("name index: %d NAMES, %d SHIM_NAMES, %d ALL: ok" % (len(N.NAMES), len(N.SHIM_NAMES), len(N.ALL)))


if __name__ == "__main__":
    sys.exit(main())
