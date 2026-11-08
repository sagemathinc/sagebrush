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
