# `from pkg import sub` when importing sub fails: only sub itself being
# missing becomes "cannot import name"; anything raised while sub runs,
# including a ModuleNotFoundError for a module sub imports, propagates
# unchanged, as CPython's _handle_fromlist re-raises unless exc.name is the
# submodule's.  Its output is CPython 3.14.4's, written into
# test/import-failed.test.ts.
import os
import sys
import tempfile

sys.dont_write_bytecode = True
d = tempfile.mkdtemp()
sys.path.insert(0, d)


def package(name, files):
    os.mkdir(os.path.join(d, name))
    for fname, src in files.items():
        with open(os.path.join(d, name, fname), "w") as f:
            f.write(src)


package("p_inner_missing", {"__init__.py": "from . import sub\n", "sub.py": "import no_such_module_xyz\n"})
package("p_sub_missing", {"__init__.py": "from . import sub\n"})
package("p_sub_raises", {"__init__.py": "from . import sub\n", "sub.py": "raise ValueError('in sub')\n"})
package("p_circular", {"__init__.py": "from . import sub\nX = 1\n", "sub.py": "from p_circular import other\n",
                       "other.py": "Y = 2\n"})

package("p_halted", {"__init__.py": "from . import sub\n", "sub.py": "X = 1\n"})
sys.modules["p_halted.sub"] = None

for p in ("p_inner_missing", "p_sub_missing", "p_sub_raises", "p_circular", "p_halted"):
    try:
        __import__(p)
        print(p, "imported")
    except BaseException as e:
        # (up to " from": CPython names the module "partially initialized"
        # while its __init__ runs, and adds its path; Sagebrush doesn't track that)
        msg = str(e).split(" from ")[0]
        print(p, type(e).__name__, msg, "name=%s" % getattr(e, "name", None))
    print(p, "left in sys.modules:", p in sys.modules, p + ".sub" in sys.modules)
