"""Write py/sklearn/_sk_names.py: scikit-learn's public modules and the public names of each, from the oracle, so a
name outside Sagebrush's sklearn subset raises NotImplementedError rather than AttributeError.

    /scratch/numeric-review/sk/venv/bin/python -I optional/sklearn/tests/gen-names.py > optional/sklearn/py/sklearn/_sk_names.py
"""
import importlib
import sklearn

MODULES = ["sklearn"] + ["sklearn." + m for m in sklearn.__all__ if m.islower() and m not in ("clone", "get_config", "set_config", "config_context", "show_versions", "externals", "experimental")]
MODULES += ["sklearn.base", "sklearn.utils", "sklearn.utils.validation", "sklearn.utils.multiclass", "sklearn.metrics.pairwise", "sklearn.model_selection._split"]
out = {}
for m in sorted(set(MODULES)):
    if m.endswith("._split"):
        continue
    mod = importlib.import_module(m)
    names = getattr(mod, "__all__", None)
    if names is None:
        names = [n for n in dir(mod) if not n.startswith("_") and getattr(getattr(mod, n), "__module__", "").startswith("sklearn")]
    out[m] = sorted(n for n in names if not n.startswith("_"))
print('"""scikit-learn %s\'s public modules and their public names (tests/gen-names.py, from the oracle)."""' % sklearn.__version__)
print()
print("VERSION = %r" % sklearn.__version__)
print()
print("MODULES = {")
for m, names in out.items():
    print("    %r: (" % m)
    line = "       "
    for n in names:
        piece = " %r," % n
        if len(line) + len(piece) > 118:
            print(line)
            line = "       "
        line += piece
    print(line)
    print("    ),")
print("}")
