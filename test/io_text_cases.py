# io.TextIOWrapper, io.BufferedWriter and io.IncrementalNewlineDecoder: what a program sees. The .out is CPython
# 3.14.10's output (python3 -I, its C _io). Deterministic: no ids, addresses or temporary paths are printed.
import io


def t(f):
    try:
        return repr(f())
    except Exception as e:
        return type(e).__name__ + ": " + str(e)


def w(encoding="utf-8", errors=None, newline=None, text=("aé€😀\n", "b\r\nc\r", "")):
    b = io.BytesIO()
    tw = io.TextIOWrapper(b, encoding=encoding, errors=errors, newline=newline)
    for s in text:
        tw.write(s)
    tw.flush()
    return b.getvalue()


print("-- writing: encodings, BOMs, errors")
for enc in ("utf-8", "UTF8", "utf-8-sig", "utf-16", "utf-16-le", "utf-16-be", "utf-32", "utf-32-le", "latin-1", "ascii", "cp1252"):
    print(enc, t(lambda: w(enc, "replace")))
for errors in ("strict", "replace", "ignore", "xmlcharrefreplace", "backslashreplace", "surrogateescape"):
    print(errors, t(lambda: w("ascii", errors)))
print(t(lambda: w("klingon")), t(lambda: w(1)), t(lambda: w("utf-8", 1)), t(lambda: w("utf-8", None, "x")), t(lambda: w("utf-8", None, 1)))
print(t(lambda: w("utf-8", "strict", None, ("\ud800",))), t(lambda: w("utf-8", "surrogatepass", None, ("\ud800",))))

print("-- writing: newline translation")
for nl in (None, "", "\n", "\r", "\r\n"):
    print(repr(nl), t(lambda: w("utf-8", None, nl)))

print("-- a BOM once: several writes, empty writes, a seek away from 0")
b = io.BytesIO()
tw = io.TextIOWrapper(b, encoding="utf-16")
print(tw.write(""), tw.write("a"), tw.write("b"))
tw.flush()
print(b.getvalue())
b2 = io.BytesIO(b"xx")
b2.seek(2)
tw2 = io.TextIOWrapper(b2, encoding="utf-16")
tw2.write("z")
tw2.flush()
print(b2.getvalue())
b3 = io.BytesIO()
tw3 = io.TextIOWrapper(b3, encoding="utf-8-sig")
tw3.write("x")
tw3.seek(0)
tw3.write("y")
tw3.flush()
print(b3.getvalue())

print("-- reading: read, read(n), readline, iteration, universal newlines, newlines")
data = "line1\nline2\r\nline3\rlast é€😀".encode("utf-8")
for nl in (None, "", "\n", "\r", "\r\n"):
    r = io.TextIOWrapper(io.BytesIO(data), encoding="utf-8", newline=nl)
    print(repr(nl), [r.readline() for _ in range(5)], repr(r.newlines))
r = io.TextIOWrapper(io.BytesIO(data), encoding="utf-8")
print(repr(r.read(3)), repr(r.read(0)), repr(r.readline(2)), repr(r.readline()), repr(r.read()), repr(r.read()))
print(list(io.TextIOWrapper(io.BytesIO(data), encoding="utf-8")))
print(io.TextIOWrapper(io.BytesIO(data), encoding="utf-8").readlines())
print(io.TextIOWrapper(io.BytesIO(data), encoding="utf-8").readlines(8))
print(t(lambda: io.TextIOWrapper(io.BytesIO(data), encoding="utf-8").read("3")), t(lambda: io.TextIOWrapper(io.BytesIO(data), encoding="utf-8").readline(None)))

print("-- reading other encodings, BOMs, and multibyte sequences split across 2048-byte chunks")
big = ("é€😀x" * 700) + "\n" + ("z" * 3000) + "\r\nend"
for enc in ("utf-8", "utf-8-sig", "utf-16", "utf-16-le", "utf-16-be", "utf-32", "latin-1", "cp1252"):
    try:
        raw = big.encode(enc)
    except UnicodeEncodeError:
        raw = big.encode(enc, "replace")
    r = io.TextIOWrapper(io.BytesIO(raw), encoding=enc)
    got = r.read()
    print(enc, len(raw), len(got), got[:12], got[-6:], got == big.replace("\r\n", "\n") or got == raw.decode(enc).replace("\r\n", "\n"))
for raw in (b"\xef\xbb\xbfhello", b"\xff\xfeh\x00i\x00", b"\xfe\xff\x00h\x00i", b"h\x00i\x00"):
    print(raw, t(lambda: io.TextIOWrapper(io.BytesIO(raw), encoding="utf-16").read()), t(lambda: io.TextIOWrapper(io.BytesIO(raw), encoding="utf-8-sig").read()))

print("-- decoding errors: where, and the errors handlers")
for raw in (b"ok\xffok", b"ok\xc3", b"ok\xe0\x80x", b"ok\xed\xa0\x80x", b"\xf0\x9f\x98", b"a\x00\xd8"):
    for errors in ("strict", "replace", "ignore", "surrogateescape", "backslashreplace"):
        print(raw, errors, t(lambda: io.TextIOWrapper(io.BytesIO(raw), encoding="utf-8" if raw[:1] != b"a" else "utf-16-le", errors=errors).read()))

print("-- tell and seek (opaque cookies, as CPython's)")
for enc in ("utf-8", "utf-16", "latin-1", "utf-8-sig"):
    raw = "ab\né€😀\nxyz\n".encode(enc, "replace")
    r = io.TextIOWrapper(io.BytesIO(raw), encoding=enc)
    marks = []
    while True:
        pos = r.tell()
        line = r.readline()
        marks.append((pos, line))
        if not line:
            break
    print(enc, marks)
    for pos, line in marks:
        r.seek(pos)
        print("  ", pos, repr(r.readline()) == repr(line), end="")
    print()
    r.seek(0)
    print("  ", repr(r.read(4)), r.tell(), repr(r.read(2)), r.tell())
    c = r.tell()
    r.read()
    r.seek(c)
    print("  ", repr(r.read()))
r = io.TextIOWrapper(io.BytesIO(b"abc\ndef\n"), encoding="utf-8")
print(t(lambda: r.seek(1, 1)), t(lambda: r.seek(1, 2)), t(lambda: r.seek(-1)), t(lambda: r.seek(0, 3)), t(lambda: r.seek(0, 2)), t(lambda: r.seek(0, 1)))
it = io.TextIOWrapper(io.BytesIO(b"abc\ndef\n"), encoding="utf-8")
next(it)
print(t(lambda: it.tell()))
print(t(lambda: io.TextIOWrapper(io.BytesIO(b"x"), encoding="utf-8").truncate()))

print("-- attributes, repr, closing, detach, reconfigure")
b = io.BytesIO()
tw = io.TextIOWrapper(b, encoding="latin-1", errors="replace", newline="\r\n", line_buffering=True)
print(tw.encoding, tw.errors, tw.line_buffering, tw.write_through, tw.buffer is b, tw.readable(), tw.writable(), tw.seekable(), tw.closed, t(lambda: hasattr(tw, "name")))
print(repr(tw), isinstance(tw, io.TextIOBase), isinstance(tw, io.IOBase), type(tw).__name__)
tw.write("x\ny")
print(b.getvalue())
print(t(lambda: tw.reconfigure(encoding="utf-8")), t(lambda: tw.reconfigure(newline="\n")), tw.encoding)
tw.write("é\n")
print(b.getvalue())
d = tw.detach()
print(d is b, t(lambda: tw.write("z")), t(lambda: tw.detach()), t(lambda: tw.encoding), t(lambda: tw.closed))
tw4 = io.TextIOWrapper(io.BytesIO(), encoding="utf-8")
tw4.close()
print(tw4.closed, t(lambda: tw4.write("x")), t(lambda: tw4.read()), t(lambda: tw4.tell()), t(lambda: tw4.seek(0)), t(lambda: tw4.close()))
with io.TextIOWrapper(io.BytesIO(), encoding="utf-8") as tw5:
    tw5.write("in with")
print(tw5.closed)
tw6 = io.TextIOWrapper(io.BytesIO(b"abc"), encoding="utf-8")
tw6.read(1)
print(t(lambda: tw6.reconfigure(encoding="latin-1")), t(lambda: tw6.reconfigure(errors=1)), t(lambda: tw6.reconfigure(line_buffering=True)), tw6.line_buffering)
print(t(lambda: io.TextIOWrapper(io.BytesIO(), encoding="utf-8").fileno()), t(lambda: io.TextIOWrapper(io.BytesIO(), encoding="utf-8").isatty()))
print(t(lambda: io.TextIOWrapper(io.BytesIO(), encoding="utf-8").write(b"x")), t(lambda: io.TextIOWrapper(io.BytesIO(), encoding="utf-8").newlines))
print(t(lambda: io.TextIOWrapper(io.BytesIO(), encoding="utf-8", newline="").write("a\nb")))


class ReadOnly(io.BytesIO):
    def writable(self):
        return False


print(t(lambda: io.TextIOWrapper(ReadOnly(b"x"), encoding="utf-8").write("y")), t(lambda: io.TextIOWrapper(ReadOnly(b"x"), encoding="utf-8").read()))

print("-- line_buffering and write_through")


class Spy(io.BytesIO):
    def __init__(self):
        super().__init__()
        self.flushes = 0

    def flush(self):
        self.flushes += 1


s = Spy()
lb = io.TextIOWrapper(s, encoding="utf-8", line_buffering=True)
lb.write("no newline")
n0 = s.flushes
lb.write("with\n")
n1 = s.flushes
lb.write("cr\r")
print(n0, n1, s.flushes, s.getvalue())

print("-- BufferedWriter over a RawIOBase")


class Raw(io.RawIOBase):
    def __init__(self):
        self.data = bytearray()
        self.calls = []

    def writable(self):
        return True

    def write(self, b):
        self.calls.append(len(b))
        self.data += bytes(b)
        return len(b)

    def seekable(self):
        return True

    def tell(self):
        return len(self.data)

    def seek(self, pos, whence=0):
        return len(self.data)


raw = Raw()
bw = io.BufferedWriter(raw, buffer_size=8)
print(bw.write(b"abc"), raw.calls, bw.tell(), bw.write(b"defghijk"), raw.calls, bw.write(bytearray(b"!")), raw.calls)
bw.flush()
print(raw.calls, bytes(raw.data), bw.writable(), bw.raw is raw, isinstance(bw, io.BufferedIOBase), type(bw).__name__)
print(t(lambda: bw.write("str")), t(lambda: io.BufferedWriter(raw, 0)), t(lambda: io.BufferedWriter(io.BytesIO(), buffer_size=-1)))
print(t(lambda: bw.read()), t(lambda: bw.seek(0, 5)), t(lambda: bw.detach() is raw), t(lambda: bw.write(b"x")), t(lambda: bw.detach()))


class RO(io.RawIOBase):
    def writable(self):
        return False


print(t(lambda: io.BufferedWriter(RO())))
tb = io.TextIOWrapper(io.BufferedWriter(Raw()), encoding="utf-16")
tb.write("hé")
tb.flush()
print(bytes(tb.buffer.raw.data))

print("-- IncrementalNewlineDecoder")
nd = io.IncrementalNewlineDecoder(None, translate=True)
print([nd.decode(x) for x in ("a\r", "\nb\r", "c\n", "\r")], repr(nd.decode("", final=True)), nd.newlines, nd.getstate())
nd2 = io.IncrementalNewlineDecoder(None, translate=False)
print([nd2.decode(x) for x in ("a\r", "\nb\r", "c\n")], nd2.newlines, nd2.getstate())
nd2.reset()
print(nd2.newlines, nd2.getstate())
nd3 = io.IncrementalNewlineDecoder(None, False)
nd3.decode("x\r")
st = nd3.getstate()
nd4 = io.IncrementalNewlineDecoder(None, False)
nd4.setstate(st)
print(st, repr(nd4.decode("\ny")))
print(t(lambda: io.IncrementalNewlineDecoder()), isinstance(nd, io.IncrementalNewlineDecoder))

print("-- the io module")
print(all(hasattr(io, n) for n in ("TextIOWrapper", "BufferedWriter", "IncrementalNewlineDecoder")), "TextIOWrapper" in dir(io))
from io import TextIOWrapper, BufferedWriter
print(TextIOWrapper is io.TextIOWrapper, BufferedWriter.__name__, t(lambda: io.NoSuchThing))

print("-- the wrappers ElementTree's writer makes (its pins come with xml.etree): xmlcharrefreplace, newline '\\n'")
for enc in ("us-ascii", "utf-8", "iso-8859-1", "utf-16"):
    b = io.BytesIO()
    tw = io.TextIOWrapper(b, encoding=enc, errors="xmlcharrefreplace", newline="\n")
    tw.write('<a x="é">t€\n😀</a>')
    tw.flush()
    print(enc, b.getvalue(), tw.detach() is b, b.closed)
raw3 = Raw()
bw3 = io.BufferedWriter(raw3)
tw = io.TextIOWrapper(bw3, encoding="utf-8", errors="xmlcharrefreplace", newline="\n")
tw.write("é€")
tw.flush()
tw.detach()
bw3.detach()
print(bytes(raw3.data), raw3.calls)
parts = []
bb = io.BufferedIOBase()
bb.writable = lambda: True
bb.write = lambda d: parts.append(bytes(d)) or len(d)
tw = io.TextIOWrapper(bb, encoding="utf-8", errors="xmlcharrefreplace", newline="\n")
tw.write("x\ny")
tw.flush()
tw.detach()
print(parts)

print("-- bytearray deletion (BufferedWriter's buffer)")
ba = bytearray(b"abcdefgh")
del ba[0]
del ba[1:3]
del ba[::2]
print(ba, t(lambda: ba.__delitem__(10)), t(lambda: ba.__delitem__("x")))
ba2 = bytearray(b"abcdef")
del ba2[-1:0]
del ba2[5:1:-2]
print(ba2)
ba3 = bytearray(b"abc")
del ba3[1:1]
del ba3[:]
print(ba3)
class BA(bytearray):
    pass
ba4 = BA(b"xyz")
del ba4[1]
print(ba4, type(ba4).__name__)
x = io.BytesIO(b"abcdef")
print(x.truncate(2), x.getvalue(), x.read1(), io.BytesIO(b"ab").read1(1))
print(t(lambda: io.BufferedIOBase().read()), t(lambda: io.BufferedIOBase().read1()), t(lambda: io.BufferedIOBase().readinto(bytearray(1))), t(lambda: io.BufferedIOBase().write(b"")), t(lambda: io.BufferedIOBase().detach()), t(lambda: io.BytesIO().detach()))
print("-- BufferedWriter: C's behaviour and messages")
def t(f):
    try: return repr(f())
    except Exception as e: return type(e).__name__ + ": " + str(e)
class RawP(io.RawIOBase):
    def __init__(self, partial=None): self.data = bytearray(); self.calls = []; self.partial = partial
    def writable(self): return True
    def write(self, b):
        n = len(b) if self.partial is None else min(self.partial, len(b))
        self.calls.append(len(b)); self.data += bytes(b)[:n]; return n
r = RawP(); bw = io.BufferedWriter(r, 4)
print([bw.write(x) for x in (b"ab", b"cdefghij", b"k", b"lmnop")], r.calls); bw.flush(); print(r.calls, bytes(r.data))
r = RawP(partial=3); bw = io.BufferedWriter(r, 4)
print(t(lambda: bw.write(b"abcdefghij")), r.calls, bytes(r.data)); bw.flush(); print(r.calls, bytes(r.data))
bw = io.BufferedWriter(RawP(), 4); bw.close()
print(t(lambda: bw.write(b"x")), t(lambda: bw.flush()), t(lambda: bw.tell()), t(lambda: bw.close()), bw.closed)
bw = io.BufferedWriter(RawP(), 4); bw.detach()
print(t(lambda: bw.write(b"x")), t(lambda: bw.flush()), t(lambda: bw.closed), t(lambda: bw.raw), t(lambda: repr(bw)))
print(t(lambda: io.BufferedWriter(RawP(), "4")), t(lambda: io.BufferedWriter(RawP(), 4.0)), t(lambda: io.BufferedWriter(RawP(), buffer_size=2**70)))
print(t(lambda: io.BufferedWriter(io.BufferedWriter(RawP()).write(1))), t(lambda: io.BufferedWriter(RawP()).write(memoryview(b"ab"))), t(lambda: io.BufferedWriter(RawP()).write([1])))
print(t(lambda: io.BufferedWriter(RawP()).readable()), t(lambda: io.BufferedWriter(RawP()).read1()), t(lambda: io.BufferedWriter(RawP()).readinto(bytearray(1))), t(lambda: io.BufferedWriter(RawP()).truncate()))
print(repr(io.BufferedWriter(RawP())), t(lambda: io.BufferedIOBase().read()), t(lambda: io.BufferedIOBase().write(b"")), t(lambda: io.BufferedIOBase().detach()), t(lambda: io.BufferedIOBase().read1()), t(lambda: io.BufferedIOBase().readinto(bytearray())))
print(t(lambda: io.BufferedWriter()), t(lambda: io.IncrementalNewlineDecoder(None)), t(lambda: io.IncrementalNewlineDecoder(None, 1, 2, 3)))
class RawP(io.RawIOBase):
    def __init__(self, partial=None): self.calls = []; self.partial = partial
    def writable(self): return True
    def write(self, b):
        n = len(b) if self.partial is None else min(self.partial, len(b)); self.calls.append(len(b)); return n
for bs, pre, n, partial in ((4, 1, 4, None), (4, 1, 3, None), (4, 2, 5, None), (4, 0, 5, 3), (4, 0, 6, 3), (4, 3, 9, 2), (8, 0, 9, 1), (4, 0, 4, 1), (4, 1, 8, 5)):
    r = RawP(partial); bw = io.BufferedWriter(r, bs)
    if pre: bw.write(b"p" * pre)
    c0 = list(r.calls)
    bw.write(b"x" * n)
    c1 = list(r.calls)
    bw.flush()
    print(bs, pre, n, partial, c0, c1, r.calls)
print("-- over a real file (open(..., 'rb'/'wb'/'w+b'); no paths printed)")
import os
import tempfile

fd_dir = tempfile.mkdtemp()
fp = os.path.join(fd_dir, "f.txt")
with open(fp, "wb") as f:
    fw = io.TextIOWrapper(f, encoding="utf-16", newline="\r\n")
    fw.write("a\nbé€\n")
    fw.flush()
    fw.detach()
with open(fp, "rb") as f:
    print(f.read())
with open(fp, "rb") as f:
    fr = io.TextIOWrapper(f, encoding="utf-16")
    print(repr(fr.readline()), fr.tell(), repr(fr.read()), repr(fr.newlines))
    fr.seek(0)
    print(repr(fr.read(2)), t(lambda: fr.name == fp), t(lambda: fr.isatty()))
with open(fp, "w+b") as f:
    fw = io.TextIOWrapper(f, encoding="utf-8")
    fw.write("x\ny\n")
    fw.seek(0)
    print(repr(fw.read()), t(lambda: fw.tell()))
fraw = open(fp, "rb", buffering=0)
print(t(lambda: io.TextIOWrapper(fraw, encoding="utf-8").read()))
fraw.close()
os.remove(fp)
os.rmdir(fd_dir)

print("-- r3: __index__ results (once, checked), Py_ssize_t overflow, bytearray deletion under a re-sizing __index__, the constructors C argument errors")
import io, warnings
def t(f):
    try: return repr(f())
    except BaseException as e: return type(e).__name__ + ": " + str(e)
calls = []
class X:
    def __index__(self): calls.append(1); return 1.5
class B:
    def __index__(self): calls.append(1); return True
w = lambda: io.TextIOWrapper(io.BytesIO(b"abc\ndef"), encoding="utf-8")
with warnings.catch_warnings(record=True) as ws:
    warnings.simplefilter("always")
    for o in (X, B):
        calls.clear(); a = t(lambda: io.BufferedWriter(io.BytesIO(), o())); n1 = len(calls)
        calls.clear(); b = t(lambda: w().read(o())); n2 = len(calls)
        calls.clear(); c = t(lambda: w().readline(o())); n3 = len(calls)
        print(o.__name__, a, n1, "|", b, n2, "|", c, n3)
    print([str(x.message)[:40] for x in ws])
for v in (2**70, -2**70, 2**63, 2**63 - 1, -2**63, -2**63 - 1):
    print(v, "|", t(lambda: w().read(v)), "|", t(lambda: w().readline(v)), *(["|", t(lambda: io.BufferedWriter(io.BytesIO(), v))] if v != 2**63 - 1 else []))
for mode in ("index", "slice", "step", "stop"):
    b = bytearray(b"abcd")
    order = []
    class I:
        def __init__(self, v, tag): self.v, self.tag = v, tag
        def __index__(self):
            order.append(self.tag); b[:] = b""; return self.v
    try:
        if mode == "index": del b[I(1, "i")]
        elif mode == "slice": del b[I(1, "start"):3]
        elif mode == "step": del b[I(0, "start"):I(4, "stop"):I(2, "step")]
        else: del b[:I(2, "stop")]
        print(mode, repr(b), order)
    except Exception as e:
        print(mode, type(e).__name__, e, repr(b), order)
b2 = bytearray(b"abcdefgh")
class Grow:
    def __index__(self): b2.extend(b"XYZ"); return -1
del b2[Grow()]
print(b2)
b3 = bytearray(range(10))
del b3[8:1:-3]; print(list(b3))
b4 = bytearray(range(10)); del b4[::-1]; print(list(b4))
b5 = bytearray(range(10)); del b5[-2::-4]; print(list(b5))
cases = [
 ("TW()", lambda: io.TextIOWrapper()),
 ("TW 7", lambda: io.TextIOWrapper(b(), "utf-8", None, None, False, False, 1)),
 ("TW foo=", lambda: io.TextIOWrapper(b(), foo=1)),
 ("TW buffer dup", lambda: io.TextIOWrapper(b(), buffer=b())),
 ("TW encoding dup", lambda: io.TextIOWrapper(b(), "utf-8", encoding="utf-8")),
 ("TW kw only", lambda: io.TextIOWrapper(buffer=b(), encoding="utf-8")),
 ("TW 2 unexpected", lambda: io.TextIOWrapper(b(), foo=1, bar=2)),
 ("BW()", lambda: io.BufferedWriter()),
 ("BW 3", lambda: io.BufferedWriter(b(), 8, 9)),
 ("BW foo=", lambda: io.BufferedWriter(b(), foo=1)),
 ("BW raw dup", lambda: io.BufferedWriter(b(), raw=b())),
 ("BW kw", lambda: io.BufferedWriter(raw=b(), buffer_size=4)),
 ("ND()", lambda: io.IncrementalNewlineDecoder()),
 ("ND 1", lambda: io.IncrementalNewlineDecoder(None)),
 ("ND 4", lambda: io.IncrementalNewlineDecoder(None, 1, "strict", 4)),
 ("ND dup", lambda: io.IncrementalNewlineDecoder(None, True, decoder=None)),
 ("ND foo=", lambda: io.IncrementalNewlineDecoder(None, True, foo=1)),
 ("ND kw", lambda: io.IncrementalNewlineDecoder(decoder=None, translate=True, errors="replace")),
 ("ND translate kw missing", lambda: io.IncrementalNewlineDecoder(decoder=None)),
]
for name, f in cases:
    r = t(f)
    print(name, "|", "ok" if r.startswith("<") else r)
class Sub(io.TextIOWrapper):
    def __init__(self, *a, **k):
        super().__init__(*a, **k)
print("sub", t(lambda: Sub(b(), encoding="utf-8")), t(lambda: Sub()))

print("-- r3: seek, whence as a C int and pos as an offset (TextIOWrapper, BufferedWriter)")
def t(f):
    try: return repr(f())
    except Exception as e: return type(e).__name__ + ": " + str(e)
calls = []
class X:
    def __init__(self, v): self.v = v
    def __index__(self): calls.append(1); return self.v
tw = lambda: io.TextIOWrapper(io.BytesIO(b"abc"), encoding="utf-8")
class Raw(io.RawIOBase):
    def writable(self): return True
    def write(self, b): return len(b)
    def seekable(self): return True
    def seek(self, p, w=0): return 0
    def tell(self): return 0
bw = lambda: io.BufferedWriter(Raw())
for name, mk in (("TextIOWrapper", tw), ("BufferedWriter", bw)):
    for wv in (X(0), X(1), X(2), X(5), 0.0, 2**70, -2**70, 2**31, 2**31 - 1, -2**31, -2**31 - 1, "0", None, True):
        calls.clear()
        r = t(lambda: mk().seek(0, wv))
        print(name, repr(wv) if not isinstance(wv, X) else "X(%d)" % wv.v, "|", r, len(calls))
    calls.clear()
    print(name, "cookie X |", t(lambda: mk().seek(X(0))), len(calls))
c = io.TextIOWrapper(io.BytesIO(b"abc"), encoding="utf-8"); c.close()
print(t(lambda: c.seek(0, 0.0)), t(lambda: c.seek(0, X(0))))
for v in (2**70, -2**70, 2**63, 1.5, "1", None, True):
    print(repr(v)[:12], t(lambda: bw().seek(v)))
cb = bw(); cb.close()
print(t(lambda: cb.seek(0)), t(lambda: cb.seek(0, 7)), t(lambda: cb.seek(1.5)))

print("-- an instance's repr names its class's __module__ (CPython's object.__repr__), the io classes' _io too")
import re


class MR1:
    __module__ = "_io"


class MR2:
    pass


MR2.__module__ = "elsewhere"


class MR3:
    pass


MR3.__module__ = 5
for o in (MR1(), MR2(), MR3(), io.IncrementalNewlineDecoder(None, True)):
    print(re.sub(r" at 0x[0-9a-f]+", " at ADDR", repr(o)))


print("-- r3: truncate, the bool flags, a raw stream's results, the decoder's contracts, reconfigure(encoding=)")
import io


def t(f):
    try:
        r = f()
        return repr(r) if not hasattr(r, "read") else type(r).__name__
    except BaseException as e:
        return type(e).__name__ + ": " + str(e)


calls = []


class X:
    def __init__(self, v):
        self.v = v

    def __index__(self):
        calls.append("i")
        return self.v


class Flip:
    def __init__(self):
        self.n = 0

    def __bool__(self):
        self.n += 1
        calls.append("b")
        return self.n % 2 == 1


def tw(data=b"abcdef"):
    return io.TextIOWrapper(io.BytesIO(data), encoding="utf-8")


print("-- 4: truncate(pos)")
for v in (X(2), 2.0, 2**70, 2**63, -1, None, "2", True):
    w = tw()
    calls.clear()
    r = t(lambda: w.truncate(v))
    print(repr(v) if not isinstance(v, X) else "X(2)", "|", r, calls, w.buffer.getvalue() if not w.closed else "")

print("-- 5: line_buffering / write_through / translate")
calls.clear()
f = Flip()
w = io.TextIOWrapper(io.BytesIO(), encoding="utf-8", line_buffering=f, write_through=Flip())
print(repr(w.line_buffering), repr(w.write_through), calls)
w.write("a\n")
w.write("b\n")
print(calls)
for v in (X(1), X(0), 2.0, 2**70, 2**63, -1, "x", None, 5, True):
    w = tw()
    calls.clear()
    r1 = t(lambda: w.reconfigure(line_buffering=v))
    r1v = t(lambda: w.line_buffering)
    w2 = tw()
    r2 = t(lambda: w2.reconfigure(write_through=v))
    print(repr(v) if not isinstance(v, X) else "X(%d)" % v.v, "|", r1, r1v, "|", r2, t(lambda: w2.write_through), calls)
calls.clear()
d = io.IncrementalNewlineDecoder(None, Flip())
print([d.decode(s) for s in ("a\r\n", "b\r\n", "c\r")], calls)
print(t(lambda: io.IncrementalNewlineDecoder(None, 2).decode("x\r\ny")), t(lambda: io.IncrementalNewlineDecoder(None, "").decode("x\r\ny")))

print("-- 6: BufferedWriter raw results")


class R(io.RawIOBase):
    def __init__(self, tell=0, seek=0, write=None):
        self.t, self.s, self.w = tell, seek, write

    def writable(self):
        return True

    def seekable(self):
        return True

    def tell(self):
        return self.t

    def seek(self, p, wh=0):
        return self.s

    def write(self, b):
        return len(b) if self.w is None else self.w


for v in (X(3), 3.0, "3", 2**70, -1, None, True):
    calls.clear()
    a = t(lambda: io.BufferedWriter(R(tell=v)).tell())
    b = t(lambda: io.BufferedWriter(R(seek=v)).seek(0))
    print("tell/seek", repr(v) if not isinstance(v, X) else "X(3)", "|", a, "|", b, calls)
for v in (X(2), 2.0, "2", 2**70, -1, 99, None, True):
    calls.clear()
    bw = io.BufferedWriter(R(write=v), 4)
    a = t(lambda: bw.write(b"abcdefgh"))
    bw2 = io.BufferedWriter(R(write=v), 4)
    bw2.write(b"ab")
    b = t(lambda: bw2.flush())
    print("write", repr(v) if not isinstance(v, X) else "X(2)", "|", a, "|", b, calls)
    bw.raw.w = bw2.raw.w = None  # (each finalizer's flush then succeeds, as quietly as CPython's)

print("-- 7: IncrementalNewlineDecoder's decoder contracts")


class Dec:
    def __init__(self, out=None, state=(b"", 0)):
        self.out, self.state = out, state
        self.set = []

    def decode(self, b, final=False):
        return self.out

    def getstate(self):
        return self.state

    def setstate(self, s):
        self.set.append(s)

    def reset(self):
        pass


for out in (b"x", None, 5, "ok\r", ["a"]):
    print("decode", repr(out), t(lambda: io.IncrementalNewlineDecoder(Dec(out=out), True).decode(b"z")))
for st in ((b"", 0), [b"", 0], (b"",), (b"", 0, 1), (b"", X(3)), (b"", 1.5), (b"", -1), (b"", 2**70), (b"", 2**64 + 5), "xy", (b"x", "s")):
    calls.clear()
    print("getstate", repr(st) if not isinstance(st, tuple) or not any(isinstance(z, X) for z in st) else "(b'', X(3))", t(lambda: io.IncrementalNewlineDecoder(Dec(state=st), True).getstate()), calls)
for st in ((b"", 0), (b"", 1), (b"", 6), [b"", 0], (b"",), (b"", X(5)), (b"", 1.5), (b"", -1), (b"", 2**70), (b"", -2**70), "xy", 5):
    calls.clear()
    d = Dec()
    r = t(lambda: io.IncrementalNewlineDecoder(d, True).setstate(st))
    print("setstate", repr(st) if not isinstance(st, tuple) or not any(isinstance(z, X) for z in st) else "(b'', X(5))", r, d.set, calls)
nd = io.IncrementalNewlineDecoder(None, True)
for st in ((b"", 1), (b"", -1), (b"x", 0), [b"", 0], (b"", 2**70)):
    print("setstate None", repr(st)[:20], t(lambda: nd.setstate(st)), t(lambda: nd.getstate()))

print("-- 8: reconfigure(encoding=...)")
for enc in ("klingon", "latin-1", "utf-16"):
    w = io.TextIOWrapper(io.BytesIO(), encoding="utf-8")
    print(enc, t(lambda: w.reconfigure(encoding=enc)), t(lambda: w.encoding), t(lambda: w.write("é")))
w = io.TextIOWrapper(io.BytesIO(), encoding="utf-8")
print(t(lambda: w.reconfigure(errors="bogus-handler")), t(lambda: w.errors), t(lambda: w.write("x")))

print("-- r3: BufferedWriter's construction asks the raw stream's position; BytesIO.truncate; truncate() after a readline")
import io
def t(f):
    try: return repr(f())
    except BaseException as e: return type(e).__name__ + ": " + str(e)
log = []
class R(io.RawIOBase):
    def __init__(self, tellv=0, seekable=True): self.tv, self.sk = tellv, seekable
    def writable(self): return True
    def seekable(self): log.append("seekable"); return self.sk
    def tell(self): log.append("tell"); return self.tv
    def write(self, b): return len(b)
for tv in (0, -1, "x"):
    log.clear(); r = t(lambda: io.BufferedWriter(R(tv)) and "made"); print("init", repr(tv), r, log)
log.clear(); print(t(lambda: io.BufferedWriter(R(0, False)) and "made"), log)
class X:
    def __index__(self): log.append("i"); return 2
for v in (X(), 2.0, 2**70, 2**63, -1, None, "2", True, 7):
    b = io.BytesIO(b"abcdef"); b.read(3); log.clear()
    print("bytesio.truncate", repr(v)[:10], t(lambda: b.truncate(v)), b.getvalue(), b.tell(), log)
w = io.TextIOWrapper(io.BytesIO(b"abc\ndef\nghi\n"), encoding="utf-8"); w.readline()
print("tw truncate None after readline", t(lambda: w.truncate()), w.buffer.getvalue(), t(lambda: w.tell()))

print("-- r3: StringIO.truncate")
import io
def t(f):
    try: return repr(f())
    except BaseException as e: return type(e).__name__ + ": " + str(e)
log = []
class X:
    def __index__(self): log.append("i"); return 2
for v in (X(), 2.0, 2**70, 2**63, -1, None, "2", True, 7):
    b = io.StringIO("abcdef"); b.read(3); log.clear()
    print("stringio.truncate", repr(v)[:10], t(lambda: b.truncate(v)), b.getvalue(), b.tell(), log)
