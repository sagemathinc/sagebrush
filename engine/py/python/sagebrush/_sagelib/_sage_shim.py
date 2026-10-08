"""Sage's module paths for code written for Sage: `from sage.modular.dims
import dimension_cusp_forms`, `import sage.all`, `from sage.rings.integer
import Integer` ...  Every sage.* module is a view of Sagebrush's public
names (sage_all, then the Sage-layer modules); a name Sagebrush lacks is an
ImportError, as for a missing name in Sage.

Installed in pyjs (sage_all installs it there).  Never under CPython by
default, where a real Sage may be installed: install() is explicit.
"""

import sys
import types

_SOURCES = ["sage_all", "_sage_modular", "_sage_ff", "_sage_ffmat", "_sage_qqbar", "_sage_mpoly", "_sage_frac", "_sage_real", "_sage_rdf", "_sage_series", "_sage_graph", "_sage_sandpile", "_sage_lie", "_sage_crystals", "_sage_poly", "_sage_nf",
            "_sage_matrix", "_sage_expr", "_sage_lang", "sage_plot", "sage_plot3d", "sage_permgroup"]


class _SageModule(types.ModuleType):
    """A sage.* module: attribute lookup in Sagebrush's Sage layer."""

    def __getattr__(self, name):
        if name.startswith("__"):
            raise AttributeError(name)
        if not name.startswith("_"):
            for src in _SOURCES:
                try:
                    m = sys.modules.get(src) or __import__(src)
                except ImportError:
                    continue
                if hasattr(m, name):
                    return getattr(m, name)
        raise AttributeError("module %r has no attribute %r" % (self.__name__, name))

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
        # `from sage.x import *`: every public name of the Sage layer
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
        module.__all__ = names
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
