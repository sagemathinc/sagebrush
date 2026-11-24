# The package's submodules, reached the ways lessons reach them: from the
# package, as attributes after importing it, and by their full names.
from _cases import case


def from_package():
    from sklearn import datasets, utils, model_selection, tree, metrics
    return [m.__name__ for m in (datasets, utils, model_selection, tree, metrics)]


def attribute():
    import sklearn
    return sklearn.datasets.__name__, sklearn.utils.validation.__name__


def alias():
    import sklearn as sk
    from sklearn import datasets
    return sk.datasets is datasets, sk.preprocessing.__name__


def full_name():
    import sklearn.model_selection
    from sklearn.datasets import load_iris
    return sklearn.model_selection.__name__, load_iris.__name__


def unknown():
    import sklearn
    return sklearn.no_such_module


def unknown_from():
    # (the message up to the module's file, which CPython appends and the package has none of)
    try:
        from sklearn import no_such_module
    except ImportError as e:
        return type(e).__name__, str(e).split(" (")[0]


case("from-package", from_package)
case("attribute", attribute)
case("alias", alias)
case("full-name", full_name)
case("unknown", unknown)
case("unknown-from", unknown_from)
case("version-type", lambda: type(__import__("sklearn").__version__).__name__)
