# bytes and bytearray's translate and maketrans as CPython's: each line
# printed here is compared with CPython's (test/bytes-translate.test.ts).
import array


def t(f):
    try:
        r = f()
        print(repr(r)[:120], type(r).__name__)
    except Exception as e:
        print(type(e).__name__ + ":", e)


class B(bytes): pass
class BA(bytearray): pass

tb = bytes.maketrans(b"abc", b"xyz")
print(len(tb), tb[95:101], type(tb).__name__, type(bytearray.maketrans(b"a", b"b")).__name__, bytes.maketrans(b"", b"") == bytes(range(256)))
for recv in (b"abcabc", bytearray(b"abcabc"), B(b"abcabc"), BA(b"abcabc"), b"", bytearray()):
    t(lambda: recv.translate(tb))
    t(lambda: recv.translate(None))
    t(lambda: recv.translate(None, b"b"))
    t(lambda: recv.translate(tb, delete=b"ac"))
    t(lambda: recv.translate(tb, b""))
for table in (bytearray(tb), memoryview(tb), array.array("B", tb), B(tb)):
    t(lambda: b"cab".translate(table))
for delete in (bytearray(b"a"), memoryview(b"ab"), array.array("b", [99]), B(b"c")):
    t(lambda: b"cab".translate(None, delete))
x = b"abc"
print(x.translate(None) is x, x.translate(tb) is x, x.translate(None, b"z") is x, B(b"a").translate(None) is B(b"a"))
y = bytearray(b"abc")
print(y.translate(None) is y, y.translate(None) == y)
print(bytes(range(256)).translate(tb)[95:101], bytes(range(256)).translate(None, bytes(range(0, 256, 2)))[:5])
t(lambda: b"x".maketrans(b"x", b"y")[118:123])
t(lambda: bytes.maketrans(bytearray(b"a"), memoryview(b"b"))[97:98])

# the errors
t(lambda: b"abc".translate(b"x"))
t(lambda: b"abc".translate(b"x" * 257))
t(lambda: b"abc".translate("x" * 256))
t(lambda: b"abc".translate(None, "b"))
t(lambda: b"abc".translate(5))
t(lambda: b"abc".translate())
t(lambda: b"abc".translate(table=None))
t(lambda: b"abc".translate(None, table=None))
t(lambda: b"abc".translate(None, bogus=1))
t(lambda: b"abc".translate(delete=b"a"))
t(lambda: b"abc".translate(None, b"a", b"b"))
t(lambda: b"abc".translate(None, b"a", delete=b"b"))
t(lambda: b"abc".translate(memoryview(tb + tb)[::2]))
t(lambda: b"abc".translate(None, memoryview(b"abcd")[::2]))
t(lambda: bytearray(b"abc").translate(b"short"))
t(lambda: bytes.maketrans(b"a", b"bc"))
t(lambda: bytes.maketrans("a", "b"))
t(lambda: bytes.maketrans(b"a", 5))
t(lambda: bytes.maketrans(b"a"))
t(lambda: bytes.maketrans(b"a", b"b", b"c"))
t(lambda: bytes.maketrans(frm=b"a", to=b"b"))
t(lambda: bytearray.maketrans(frm=b"a", to=b"b"))
t(lambda: bytes.maketrans(memoryview(b"ab")[::2], b"x"))

# the argument count before the keywords' names (astra's PR354 finding)
for recv in (b"a", bytearray(b"a")):
    t(lambda: recv.translate(None, b"", bogus=1))
    t(lambda: recv.translate(None, b"", b"", bogus=1))
    t(lambda: recv.translate(None, bogus=1))
    t(lambda: recv.translate(None, b"", delete=b""))
    t(lambda: recv.translate(bogus=1))
    t(lambda: recv.translate(None, delete=b"a", bogus=1))
