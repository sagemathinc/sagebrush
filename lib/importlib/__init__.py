"""importlib, as much of CPython 3.14's Lib/importlib/__init__.py as this
runtime's import system supports (PSF License; see cdn/LICENSE-CPython.txt).

CPython's importlib is its import system written in Python (_bootstrap,
_bootstrap_external); Sagebrush's import system is its own, so this module
is not a copy: import_module() keeps CPython's checks, messages and
relative-name resolution (import_module, _bootstrap._sanity_check and
_bootstrap._resolve_name, ported), then imports with the runtime's
__import__ and returns the named module from sys.modules, as
_bootstrap._gcd_import does. What this runtime can't do is refused, never
approximated: reload() (a module is not re-executed here), and the
submodules it does not have (util, machinery, abc, resources) are missing,
an ImportError.
"""
import sys

__all__ = ["__import__", "import_module", "invalidate_caches", "reload"]

# (CPython's importlib.__import__ is the import statement's own function)
from builtins import __import__


def invalidate_caches():
    """Call the invalidate_caches() method on all meta path finders stored in
    sys.meta_path (where implemented)."""
    for finder in getattr(sys, "meta_path", None) or ():
        if hasattr(finder, "invalidate_caches"):
            finder.invalidate_caches()


def _sanity_check(name, package, level):
    """Verify arguments are "sane"."""
    if not isinstance(name, str):
        raise TypeError(f"module name must be str, not {type(name)}")
    if level < 0:
        raise ValueError("level must be >= 0")
    if level > 0:
        if not isinstance(package, str):
            raise TypeError("__package__ not set to a string")
        elif not package:
            raise ImportError("attempted relative import with no known parent package")
    if not name and level == 0:
        raise ValueError("Empty module name")


def _resolve_name(name, package, level):
    """Resolve a relative module name to an absolute one."""
    bits = package.rsplit(".", level - 1)
    if len(bits) < level:
        raise ImportError("attempted relative import beyond top-level package")
    base = bits[0]
    return f"{base}.{name}" if name else base


def import_module(name, package=None):
    """Import a module.

    The 'package' argument is required when performing a relative import. It
    specifies the package to use as the anchor point from which to resolve the
    relative import to an absolute import.

    """
    level = 0
    if name.startswith("."):
        if not package:
            raise TypeError("the 'package' argument is required to perform a "
                            f"relative import for {name!r}")
        for character in name:
            if character != ".":
                break
            level += 1
    name = name[level:]
    # (as _bootstrap._gcd_import: checked, resolved, then the module itself,
    # not the top-level package __import__ returns)
    _sanity_check(name, package, level)
    if level > 0:
        name = _resolve_name(name, package, level)
    __import__(name)
    return sys.modules[name]


def reload(module):
    """Reload the module and return it.

    The module must have been successfully imported before. Its argument is
    checked as CPython's is; then, as this runtime does not re-execute a
    module, the reload itself is refused.

    """
    try:
        name = module.__spec__.name
    except AttributeError:
        try:
            name = module.__name__
        except AttributeError:
            raise TypeError("reload() argument must be a module") from None

    if sys.modules.get(name) is not module:
        raise ImportError(f"module {name} not in sys.modules", name=name)
    raise NotImplementedError(f"importlib.reload({name}): re-executing a module is not supported here; "
                              "start a new session to run a changed module")
