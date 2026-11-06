"""A cell's `_` names in the native runner (sagebrush/remote/mangle.py), as the
page's mangleLocals (src/dataflow.ts) makes them in the browser: `_x` used as
the cell's global becomes `_cell_<id>_x`; names a function, lambda,
comprehension or class binds for itself, attributes, keywords and strings stay;
`__` is local, dunders aren't; `from m import *` leaves the cell unmangled.

    python engine/py/test_remote_mangle.py
"""
import ast
import os

HERE = os.path.dirname(os.path.abspath(__file__))

from sagebrush.remote.mangle import is_local, local_prefix, mangle

CASES = [
    ("_x = 1\nprint(_x + y)", "_cell_c_x = 1\nprint(_cell_c_x + y)"),
    ("__ = 2\n__", "_cell_c__ = 2\n_cell_c__"),
    ("__name__\n__doc__ = 1", "__name__\n__doc__ = 1"),
    ("x = _y", "x = _cell_c_y"),
    ("def f(_a):\n    return _a + _g", "def f(_a):\n    return _a + _cell_c_g"),
    ("def _f():\n    _t = 1\n    return _t", "def _cell_c_f():\n    _t = 1\n    return _t"),
    ("def f():\n    global _g\n    _g = 1", "def f():\n    global _cell_c_g\n    _cell_c_g = 1"),
    ("lambda _a: _a + _b", "lambda _a: _a + _cell_c_b"),
    ("[_i for _i in _xs]", "[_i for _i in _cell_c_xs]"),
    ("class C:\n    _cache = {}\n    def m(self):\n        return self._cache",
     "class C:\n    _cache = {}\n\n    def m(self):\n        return self._cache"),
    ("f(_k=_v)", "f(_k=_cell_c_v)"),
    ("s = '_x'\nobj._x", "s = '_x'\nobj._x"),
    ("import os as _os\n_os.sep", "import os as _cell_c_os\n_cell_c_os.sep"),
    ("for _i in range(3):\n    pass", "for _cell_c_i in range(3):\n    pass"),
    ("with open('f') as _fh:\n    pass", "with open('f') as _cell_c_fh:\n    pass"),
    ("try:\n    pass\nexcept E as _e:\n    _e", "try:\n    pass\nexcept E as _cell_c_e:\n    _cell_c_e"),
    ("from m import *\n_x = 1", "from m import *\n_x = 1"),
]


def test_cases():
    for src, want in CASES:
        tree = ast.parse(src)
        mangle(tree, "c")
        got = ast.unparse(tree)
        assert got == ast.unparse(ast.parse(want)), (src, got)


def test_sage_private_vars():
    """In Sage mode, var('_x') binds the cell's own _x (src/dataflow.ts privateVars); var('x') is left alone."""
    for src, want in [
        ("var('_x')\n_x + 1", "_cell_c_x = SR.var('_x')\n_cell_c_x + 1"),
        ("var('_a _b', domain='real')", "_cell_c_a, _cell_c_b = SR.var('_a _b', domain='real')"),
        ("var('_a', 'y')", "_cell_c_a, y = SR.var('_a y')"),
        ("var('x')", "var('x')"),
        ("var('_a', n)", "var('_a', n)"),
    ]:
        tree = ast.parse(src)
        mangle(tree, "c", sage=True)
        assert ast.unparse(tree) == ast.unparse(ast.parse(want)), (src, ast.unparse(tree))
    tree = ast.parse("var('_x')")
    mangle(tree, "c")  # (Python mode: no rewrite)
    assert ast.unparse(tree) == "var('_x')"


def test_names():
    assert is_local("_x") and is_local("__") and not is_local("__x") and not is_local("x") and not is_local("__x__")
    assert local_prefix("c1") == "_cell_c1_"


def test_runs_isolated():
    """Two cells' `_t` never meet in one namespace."""
    ns = {}
    for cell, src in (("a", "_t = 1"), ("b", "_t = 2")):
        tree = ast.parse(src)
        mangle(tree, cell)
        exec(compile(tree, "<cell>", "exec"), ns)
    assert ns["_cell_a_t"] == 1 and ns["_cell_b_t"] == 2 and "_t" not in ns


if __name__ == "__main__":
    for name, f in list(globals().items()):
        if name.startswith("test_") and callable(f):
            f()
            print("ok", name)
    print("all remote mangle tests passed")
