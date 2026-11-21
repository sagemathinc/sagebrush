"""Sage's module paths for code written for Sage: `from sage.modular.dims
import dimension_cusp_forms`, `import sage.all`, `from sage.rings.integer
import Integer` ...  Every sage.* module is a view of Sagebrush's public
names (sage_all, then the Sage-layer modules); a name Sagebrush lacks is an
ImportError, as for a missing name in Sage.

A name is looked up in the name index (_sage_names): only the module that
supplies it is imported, not every Sage-layer module.  `from sage.x import *`
still gives every public name of the Sage layer, so it imports them all (and
only then: a module's __all__ is computed when it is first asked for).

Installed in pyjs (sage_all installs it there).  Never under CPython by
default, where a real Sage may be installed: install() is explicit.
"""

import sys
import types

_SOURCES = ["sage_all", "_sage_modular", "_sage_ff", "_sage_ffmat", "_sage_qqbar", "_sage_mpoly", "_sage_frac", "_sage_real", "_sage_rdf", "_sage_series", "_sage_graph", "_sage_sandpile", "_sage_lie", "_sage_crystals", "_sage_polyhedra", "_sage_coding", "_sage_manifolds", "_sage_milp", "_sage_poly", "_sage_nf",
            "_sage_matrix", "_sage_expr", "_sage_lang", "sage_plot", "sage_plot3d", "sage_permgroup"]


# Sage's packages: their lowercase attributes are subpackages and modules
# (sage.rings.ideal), not functions of the same name
_PACKAGES = {"sage"} | {"sage." + p for p in (
    "rings", "rings.polynomial", "rings.finite_rings", "rings.number_field", "rings.padics",
    "modular", "matrix", "combinat", "groups", "schemes", "misc", "graphs", "geometry",
    "calculus", "symbolic", "functions", "plot", "structure", "categories", "arith", "libs",
    "interfaces", "manifolds", "numerical", "coding", "crypto", "sandpiles", "algebras",
    "quadratic_forms", "sets", "homology", "topology", "modules", "databases", "lfunctions",
    "dynamics", "probability", "stats", "tensor", "typeset", "repl", "parallel")}

# modules whose `import *` gives only these names (as in Sage)
_EXPLICIT = {"sage.manifolds.operators": ["grad", "div", "curl", "laplacian"]}


def _source_of(name):
    """The Sage-layer module whose attribute `name` a sage.* module gives, as
    the name index records it (the session's names, then the names only Sage's
    module paths reach), or None.  The same module as the first of _SOURCES
    that has the name (engine/py/test_sage_names.py checks that)."""
    import _sage_names as N
    m = N.NAMES.get(name)
    if m is not None:
        return m
    m = N.SHIM_NAMES.get(name)
    if m is not None:
        return m
    if name in N.ALIASES or name in _all_names():
        return "sage_all"
    return None


_ALL = []


def _all_names():
    if not _ALL:
        import _sage_names as N
        _ALL.append(frozenset(N.ALL))
    return _ALL[0]


def _star_names():
    """Every public name of the Sage layer, the first module of _SOURCES that
    has a name first: what `from sage.x import *` binds."""
    names = []
    seen = set()
    for src in _SOURCES:
        try:
            m = sys.modules.get(src) or __import__(src)
        except ImportError:
            continue
        for n in getattr(m, "__all__", None) or [n for n in dir(m) if not n.startswith("_")]:
            if n not in seen and not n.startswith("_"):
                seen.add(n)
                names.append(n)
    return names


class _SageModule(types.ModuleType):
    """A sage.* module: attribute lookup in Sagebrush's Sage layer."""

    def __getattr__(self, name):
        if name == "__all__":
            # asked for by `from sage.x import *` only: every public name of
            # the Sage layer, so the whole layer is imported then, not before
            self.__all__ = _star_names()
            return self.__all__
        if name.startswith("__"):
            raise AttributeError(name)
        if name.islower() and self.__name__ in _PACKAGES and name != "all":
            # sage.rings.ideal is a module, not the function ideal
            return self._submodule(name)
        if not name.startswith("_"):
            src = _source_of(name)
            if src is not None:
                return getattr(sys.modules.get(src) or __import__(src), name)
            # a submodule by attribute (sage.rings.ideal.Katsura without an
            # import, as in a Sage session)
            if name.islower():
                return self._submodule(name)
        raise AttributeError("module %r has no attribute %r" % (self.__name__, name))

    def _submodule(self, name):
        full = self.__name__ + "." + name
        if full not in sys.modules:
            __import__(full)
        return sys.modules[full]

    def __call__(self, *args, **kwds):
        # `from sage.x import f` for an f Sagebrush lacks gives this module
        raise NotImplementedError("%s is not available in sagebrush" % self.__name__)


class _Finder:
    """A meta-path finder and loader for sage and sage.*."""

    def find_spec(self, name, path=None, target=None):
        if name != "sage" and not name.startswith("sage."):
            return None
        try:
            import importlib.machinery
            return importlib.machinery.ModuleSpec(name, self, is_package=True)
        except ImportError:
            # pyjs: no importlib; its import system needs only .name and .loader
            return types.SimpleNamespace(name=name, loader=self, parent=name.rpartition(".")[0])

    def create_module(self, spec):
        m = _SageModule(spec.name)
        m.__path__ = []
        return m

    def exec_module(self, module):
        # `from sage.x import *` gives every public name of the Sage layer
        # (__getattr__ computes __all__ when it is asked for)
        if module.__name__ in _EXPLICIT:
            module.__all__ = [n for n in _EXPLICIT[module.__name__] if hasattr(module, n)]
        parent, _, child = module.__name__.rpartition(".")
        if parent and parent in sys.modules:
            setattr(sys.modules[parent], child, module)


_INSTALLED = []


def install():
    """Make `import sage...` resolve to Sagebrush's names.

    EXAMPLES::

        sage: import _sage_shim; _sage_shim.install()  # sagebrush only
        sage: from sage.rings.finite_rings.finite_field_constructor import GF  # sagebrush only
        sage: GF(7)  # sagebrush only
        Finite Field of size 7
    """
    if not _INSTALLED:
        f = _Finder()
        sys.meta_path.insert(0, f)
        _INSTALLED.append(f)
