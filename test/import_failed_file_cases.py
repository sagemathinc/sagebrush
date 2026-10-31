# A Python file whose import raised leaves sys.modules, as CPython's
# _load_unlocked deletes the entry, so the next import runs it again (the
# loader's existing cleanup, src/compile.ts, pinned beside the builtin and
# meta_path paths). Its output is CPython 3.14.4's, written into
# test/import-failed.test.ts.
import os
import sys
import tempfile

sys.dont_write_bytecode = True
d = tempfile.mkdtemp()
sys.path.insert(0, d)
path = os.path.join(d, "filemod.py")
for label, src in [("KeyboardInterrupt", "x = 1\nraise KeyboardInterrupt\n"), ("ValueError", "x = 1\nraise ValueError('in the module')\n")]:
    with open(path, "w") as f:
        f.write(src)
    try:
        import filemod
        print(label, "imported?")
    except BaseException as e:
        print(label, "raised", type(e).__name__)
    print(label, "left in sys.modules:", "filemod" in sys.modules)
    with open(path, "w") as f:
        f.write("x = 1\ny = 2  # whole\n")
    import filemod
    print(label, "then imported again, complete:", filemod.x, filemod.y)
    del sys.modules["filemod"]
