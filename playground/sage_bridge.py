"""Use the Sagebrush engine from Sage: `load('~/sagebrush/playground/sage_bridge.py')`.

Adds the engine's virtualenv to sys.path (same Python 3.14 as Sage) and
defines chi(eps), which turns a Sage DirichletCharacter into the
chi=(order, gens, vals) form that sagebrush.mf expects.
"""
import os
import site

site.addsitedir(os.path.expanduser("~/sagebrush/engine/.venv/lib/python3.14/site-packages"))

from sagebrush import mf  # noqa: E402


def chi(eps):
    """(order, gens, vals) with eps(gens[i]) = zeta_order^vals[i], where
    zeta_order = G.zeta() for G = eps.parent()."""
    G = eps.parent()
    return (int(G.zeta_order()), [int(g) for g in G.unit_gens()], [int(x) for x in eps.element()])
