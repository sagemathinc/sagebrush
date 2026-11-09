# open()'s errors= on a text file's writes, as CPython's TextIOWrapper: each handler, in encodings that can and can't
# hold the characters (found by P3c-2: ElementTree's write(path) is us-ascii with "xmlcharrefreplace"). namereplace
# is left out: str.encode's handler for named characters is a separate gap. In a fresh temporary directory.
import os
import tempfile

d = tempfile.mkdtemp()
p = os.path.join(d, "x.txt")
for enc in ("ascii", "us-ascii", "latin-1", "utf-8", "cp1252"):
    for err in (None, "xmlcharrefreplace", "backslashreplace", "replace", "ignore", "strict"):
        try:
            with open(p, "w", encoding=enc, errors=err) as f:
                f.write("aé€\U0001f600b\n")
                e = f.errors
            with open(p, "rb") as f:
                print(enc, err, e, f.read())
        except Exception as ex:
            print(enc, err, type(ex).__name__, ex)
with open(p, "a", encoding="ascii", errors="xmlcharrefreplace") as f:
    f.write("ÿ")
with open(p, "rb") as f:
    print("append", f.read())
with open(p, "r", encoding="ascii", errors="replace") as f:
    print("read", repr(f.read()), f.errors)
os.remove(p)
os.rmdir(d)
