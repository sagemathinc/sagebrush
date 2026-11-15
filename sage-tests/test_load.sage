# load() runs a .sage file preparsed and a .py file as Python, in this
# namespace, and returns None; a missing file, a saved object (.sobj) that is
# not there, and detaching a file that is not attached are Sage's errors.
print(load("load_helper.sage"))
print(la, lb, lf(3), lf(1/2))
load("load_helper.py")
print(lc, ld)
for fn in ["missing.sage", "missing.py", "setup", "notes.txt"]:
    try:
        load(fn)
    except Exception as e:
        print(fn, type(e).__name__, e)
print(attached_files())
try:
    detach("load_helper.sage")
except Exception as e:
    print(type(e).__name__, e)
