# A module file the import system finds but can't read (argv[1]: a directory holding locked.py, unreadable): the
# import raises the OSError open() raises on it, as CPython's loader does, and traceback formats it.
import sys, traceback

d = sys.argv[1]
sys.path.insert(0, d)
try:
    open(d + "/locked.py").read()
except OSError as e:
    o = (type(e).__name__, e.errno, e.strerror, e.filename == d + "/locked.py")
print("open", o)
try:
    import locked
except OSError as e:
    i = (type(e).__name__, e.errno, e.strerror, e.filename == d + "/locked.py")
    print("import", i, i == o)
    print("format_exc", traceback.format_exc().splitlines()[-1].replace(d, "<dir>"))
try:
    from locked import X
except Exception as e:
    print("from-import", type(e).__name__, e.errno)
print("locked" in sys.modules)
