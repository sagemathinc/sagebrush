"""The answer for a name outside Sagebrush's sklearn subset: one of scikit-learn's public names (_sk_names, from the
oracle) is a NotImplementedError naming it; any other an AttributeError, as for any module."""

from ._sk_names import MODULES


def missing(module, name):
    if name in MODULES.get(module, ()):
        raise NotImplementedError("%s.%s is not in Sagebrush's sklearn 0.x subset" % (module, name))
    raise AttributeError("module %r has no attribute %r" % (module, name))


def module_names(module):
    """The public names scikit-learn 1.9.1's module has."""
    return MODULES.get(module, ())
