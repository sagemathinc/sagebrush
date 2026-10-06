"""A Sage-compatible namespace over the Sagebrush engines.

    >>> from sagebrush.sage import *
    >>> factor(2026)
    2 * 1013
    >>> x = PolynomialRing(QQ, 'x').gen()
    >>> K = NumberField(x**3 + 17*x + 1, 'a')
    >>> K.class_number()
    3

Names, behaviour and printing follow Sage, checked against Sage itself.
This is plain Python, without Sage's preparser: write x**3 (x^3 is xor),
Integer(2)/3 or QQ(2/3) for rationals (2/3 is a float), and K = NumberField(
f, 'a'); a = K.gen() for K.<a> = NumberField(f).  Integer(n) or ZZ(n) gives
an integer with Sage's methods: Integer(2026).is_prime().

The same Python files implement Sage mode in the browser
(https://sagebrush.space), where the preparser is applied.
"""

import importlib.abc as _abc
import importlib.util as _util
import os as _os
import sys as _sys

_DIR = _os.path.join(_os.path.dirname(__file__), "_sagelib")
# The layer's modules import each other by these top-level names (as in the
# browser); this finder resolves exactly these names, from _sagelib only.
_NAMES = {f[:-3] for f in _os.listdir(_DIR) if f.endswith(".py")}


class _Finder(_abc.MetaPathFinder):
    def find_spec(self, name, path=None, target=None):
        if path is None and name in _NAMES:
            return _util.spec_from_file_location(name, _os.path.join(_DIR, name + ".py"))
        return None


if not any(isinstance(f, _Finder) for f in _sys.meta_path):
    _sys.meta_path.insert(0, _Finder())

import sage_all as _sage_all  # noqa: E402

__all__ = list(_sage_all.__all__)
globals().update({k: getattr(_sage_all, k) for k in __all__})
