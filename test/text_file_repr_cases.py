# A text file's repr names its encoding, as CPython's TextIOWrapper
# (test/corpus-fixes.test.ts compares this file's output with CPython's).
# Only explicit encodings: the default one is the locale's in CPython.
import os
import tempfile

d = tempfile.mkdtemp()
p = os.path.join(d, "workfile")
for mode, enc in (("w", "utf-8"), ("w", "UTF-8"), ("a", "latin-1"), ("w", "ascii")):
    with open(p, mode, encoding=enc) as f:
        print(repr(f).replace(p, "PATH"), f.encoding)
with open(p, "r", encoding="utf-8") as f:
    print(repr(f).replace(p, "PATH"))
os.chdir(d)
f = open("workfile", "w", encoding="utf-8")
print(f)
f.close()
os.remove(p)
os.rmdir(d)
