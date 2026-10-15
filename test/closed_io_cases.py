# What a closed stream does, operation by operation, as CPython 3.14 does
# it: io.StringIO, io.BytesIO, and files from open() in text and binary
# modes (test/coverage-fixes.test.ts compares with python3).
import io
import os
import tempfile

d = tempfile.mkdtemp()
path = os.path.join(d, "f.txt")
with open(path, "w") as f:
    f.write("one\ntwo\n")


def ops(binary):
    data = b"x" if binary else "x"
    return [
        ("read()", lambda f: f.read()),
        ("read(1)", lambda f: f.read(1)),
        ("readline()", lambda f: f.readline()),
        ("readlines()", lambda f: f.readlines()),
        ("write", lambda f: f.write(data)),
        ("writelines", lambda f: f.writelines([data])),
        ("seek(0)", lambda f: f.seek(0)),
        ("tell()", lambda f: f.tell()),
        ("truncate()", lambda f: f.truncate()),
        ("flush()", lambda f: f.flush()),
        ("iter", lambda f: iter(f)),
        ("next", lambda f: next(f)),
        ("for", lambda f: [x for x in f]),
        ("with", lambda f: f.__enter__()),
        ("readable()", lambda f: f.readable()),
        ("writable()", lambda f: f.writable()),
        ("seekable()", lambda f: f.seekable()),
        ("isatty()", lambda f: f.isatty()),
        ("closed", lambda f: f.closed),
        ("close() again", lambda f: f.close()),
    ]


def show(label, make, binary=False, extra=()):
    for name, op in ops(binary) + list(extra):
        f = make()
        f.close()
        try:
            r = op(f)
            r = "ok %r" % (r,) if not hasattr(r, "__next__") else "ok iterator"
        except Exception as e:
            r = "%s: %s" % (type(e).__name__, e)
        print(label, name, r)


show("StringIO", lambda: io.StringIO("a\nb\n"), extra=[("getvalue()", lambda f: f.getvalue())])
show("BytesIO", lambda: io.BytesIO(b"a\nb\n"), binary=True, extra=[("getvalue()", lambda f: f.getvalue())])
show("open r", lambda: open(path))
show("open w", lambda: open(os.path.join(d, "w.txt"), "w"))
show("open a", lambda: open(path, "a"))
show("open r+", lambda: open(path, "r+"))
show("open rb", lambda: open(path, "rb"), binary=True)
show("open wb", lambda: open(os.path.join(d, "w.bin"), "wb"), binary=True)

# (an open file: the operation a mode does not allow)
for mode, name, op in (("r", "write", lambda f: f.write("x")), ("w", "read()", lambda f: f.read()),
                       ("a", "read()", lambda f: f.read()), ("rb", "write", lambda f: f.write(b"x"))):
    f = open(path if "r" in mode else os.path.join(d, "m.txt"), mode)
    try:
        r = "ok %r" % (op(f),)
    except Exception as e:
        r = "%s: %s" % (type(e).__name__, e)
    f.close()
    print("open", mode, "(not closed)", name, r)

# (the file's data, after the writes above that were refused)
print(open(path).read() == "one\ntwo\n")

# (binary files that read and write)
show("open r+b", lambda: open(path, "r+b"), binary=True)
show("open ab", lambda: open(os.path.join(d, "a.bin"), "ab"), binary=True)
show("open a+", lambda: open(os.path.join(d, "a2.txt"), "a+"))

# (readlines' hint: positive hints around line boundaries, and invalid ones,
# CORR-606-3)
makers = [("StringIO", lambda: io.StringIO("one\ntwo\nthree\n")), ("BytesIO", lambda: io.BytesIO(b"one\ntwo\nthree\n")),
          ("text", lambda: open(path)), ("binary", lambda: open(path, "rb"))]
with open(path, "w") as f:
    f.write("one\ntwo\nthree\n")
for name, mk in makers:
    for h in (1, 3, 4, 5, 8, 9, 0, -1, None, "bad", 1.5, True):
        f = mk()
        try:
            r = f.readlines(h)
            print(name, repr(h), r, repr(f.read()))
        except Exception as e:
            print(name, repr(h), type(e).__name__, e)

# (a bad argument on a closed stream: which is refused first, CORR-606-4)
for name, mk, bad in (("StringIO", lambda: io.StringIO(), None), ("StringIO", lambda: io.StringIO(), 5), ("StringIO", lambda: io.StringIO(), b"x"),
                      ("BytesIO", lambda: io.BytesIO(), "x"), ("BytesIO", lambda: io.BytesIO(), None),
                      ("text", lambda: open(os.path.join(d, "w2.txt"), "w"), None), ("text", lambda: open(os.path.join(d, "w2.txt"), "w"), 5),
                      ("binary", lambda: open(os.path.join(d, "w2.bin"), "wb"), "x")):
    f = mk()
    f.close()
    for op in ("write", "writelines"):
        try:
            getattr(f, op)(bad if op == "write" else [bad])
            print(name, op, repr(bad), "ok")
        except Exception as e:
            print(name, op, repr(bad), type(e).__name__, e)

# (what a write takes: bytes-like objects only)
import array
for b in (5, bytearray(b"ab"), memoryview(b"cd"), [1], 2.5, array.array("b", [1, 2])):
    f = io.BytesIO()
    try:
        print(type(b).__name__, f.write(b), f.getvalue())
    except Exception as e:
        print(type(b).__name__, type(e).__name__, e)
