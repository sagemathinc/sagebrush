# hashlib (lib/hashlib.py, the hashes in Python) on pyjs: each line printed
# here is compared with CPython's (test/hashlib.test.ts).
import hashlib

NAMES = ("md5", "sha1", "sha224", "sha256", "sha384", "sha512")


def show(f):
    try:
        print(f())
    except Exception as e:
        print(type(e).__name__ + ":", e)


# digests: every length from 0 to 300 (each block boundary and padding case),
# 1000 and 4099 bytes, for every algorithm
for name in NAMES:
    for n in list(range(0, 301)) + [1000, 4099]:
        data = bytes((i * 31 + n * 7) & 255 for i in range(n))
        print(name, n, hashlib.new(name, data).hexdigest())

# the standards' test vectors
for name in NAMES:
    for v in (b"", b"abc", b"abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq",
              b"abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu",
              b"The quick brown fox jumps over the lazy dog", b"a" * 1000):
        print(name, len(v), getattr(hashlib, name)(v).hexdigest())

# incremental updates, copies, every buffer kind
for name in NAMES:
    h = getattr(hashlib, name)()
    for chunk in (b"a", b"bc" * 40, b"", bytearray(b"xyz" * 30), memoryview(b"q" * 70), memoryview(b"abcdef")[1:4], b"\xff" * 129):
        h.update(chunk)
        c = h.copy()
        c.update(b"!")
        print(name, h.hexdigest(), c.hexdigest(), h.digest() == bytes.fromhex(h.hexdigest()))
    print(name, h.name, h.digest_size, h.block_size, len(h.digest()), type(h.digest()).__name__, type(h.hexdigest()).__name__)
    h2 = getattr(hashlib, name)(b"part one ")
    h2.update(b"part two")
    print(h2.hexdigest() == getattr(hashlib, name)(b"part one part two").hexdigest())

# the constructors' arguments
print(hashlib.md5(data=b"a").hexdigest(), hashlib.md5(string=b"a").hexdigest(), hashlib.sha1(usedforsecurity=False).hexdigest())
print(hashlib.new("md5", b"a").hexdigest(), hashlib.new("SHA256", b"x").hexdigest(), hashlib.new("sha512", data=b"x").hexdigest()[:16])
print(hashlib.new("md5", usedforsecurity=False).name, hashlib.new("sha1", string=b"s").hexdigest())
print(hashlib.sha256(bytearray(b"ab")).hexdigest() == hashlib.sha256(memoryview(b"ab")).hexdigest() == hashlib.sha256(b"ab").hexdigest())
print(hashlib.md5(memoryview(b"abcd").cast("H")).hexdigest(), hashlib.sha1(memoryview(bytearray(b"abcdef"))[::2].tobytes()).hexdigest())
import array
print(hashlib.md5(array.array("B", [1, 2, 3])).hexdigest())

# the errors
show(lambda: hashlib.md5("abc"))
show(lambda: hashlib.md5(5))
show(lambda: hashlib.md5().update("x"))
show(lambda: hashlib.md5().update(5))
show(lambda: hashlib.md5().update(None))
show(lambda: hashlib.sha256([1, 2]))
show(lambda: hashlib.new("nope"))
show(lambda: hashlib.new(5))
show(lambda: hashlib.new("md5", "text"))
show(lambda: hashlib.md5(b"a", string=b"b"))
show(lambda: type(hashlib.md5())())
show(lambda: setattr(hashlib.md5(), "name", "x"))
show(lambda: setattr(hashlib.sha1(), "digest_size", 1))
show(lambda: setattr(hashlib.sha1(), "block_size", 1))

# the module
print(sorted(set(NAMES) & hashlib.algorithms_guaranteed), sorted(set(NAMES) & hashlib.algorithms_available))
print(type(hashlib.md5()).__name__, type(hashlib.md5()).__module__, isinstance(hashlib.sha1(), type(hashlib.md5())))
print(callable(hashlib.md5), callable(hashlib.new))
print(repr(hashlib.sha256()).startswith("<sha256 _hashlib.HASH object @ 0x"))
print(sorted(n for n in dir(hashlib) if not n.startswith("_") and n in ("HASH", "new", "md5")))

# a buffer must be C-contiguous, as CPython's BufferError says (H345-A1)
mv = memoryview(b"abcdef")
for v in (mv[::2], mv[::-1], mv[1:5:2]):
    show(lambda: hashlib.md5(v).hexdigest())
    show(lambda: hashlib.sha256().update(v))
for v in (mv[1:4], mv[::1], memoryview(b"abcd").cast("H"), memoryview(bytearray(b"xyz"))):
    show(lambda: hashlib.sha1(v).hexdigest())

# data and string: given or not given, as CPython tells them apart (H345-A2)
for kw in ({"string": None}, {"data": None}, {"data": b"", "string": b"x"}, {"data": b"a", "string": None},
           {"data": b"", "string": None}, {"string": b""}, {"string": ""}, {"string": b"s"}, {"data": b""}, {}):
    show(lambda: hashlib.md5(**kw).hexdigest())
    show(lambda: hashlib.new("sha1", **kw).hexdigest())
show(lambda: hashlib.md5(b"", string=b"x"))
show(lambda: hashlib.md5(b"", string=None))
show(lambda: hashlib.new("md5", b"", string=None))

# a name's own characters, whatever a str subclass's methods say (H345-A3)
class Liar(str):
    def lower(self): return "md5"
    def upper(self): return "MD5"
    def __eq__(self, other): return True
    def __hash__(self): return 0
    def __str__(self): return "md5"
for n in ("sha256", "SHA384", "Sha1", "nope", "MD5"):
    show(lambda: hashlib.new(Liar(n)).name)
    show(lambda: hashlib.new(n).name)
