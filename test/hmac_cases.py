# CPython's hmac.py (lib/hmac.py, unchanged) on pyjs, over hashlib and
# _operator._compare_digest: each line printed here is compared with
# CPython's (test/hmac.test.ts).
import hmac, hashlib, array
from _operator import _compare_digest


def show(f):
    try:
        print(f())
    except Exception as e:
        print(type(e).__name__ + ":", e)


# RFC 2104 / RFC 4231 style vectors, and keys around the block size
for name in ("md5", "sha1", "sha224", "sha256", "sha384", "sha512"):
    bs = hashlib.new(name).block_size
    for key in (b"", b"key", b"\x0b" * 20, b"k" * (bs - 1), b"k" * bs, b"k" * (bs + 1), b"\xaa" * 131):
        for msg in (b"", b"Hi There", b"what do ya want for nothing?", b"\xdd" * 50, b"m" * 1000):
            print(name, len(key), len(msg), hmac.new(key, msg, name).hexdigest())

# the interface
h = hmac.new(b"key", b"part one ", "sha256")
c = h.copy()
h.update(b"part two")
print(h.hexdigest(), c.hexdigest(), h.digest() == bytes.fromhex(h.hexdigest()))
print(h.hexdigest() == hmac.new(b"key", b"part one part two", "sha256").hexdigest())
print(h.name, h.digest_size, h.block_size, c.name)
for dm in ("md5", hashlib.sha1, lambda: hashlib.sha512(), hashlib):
    show(lambda: hmac.new(b"k", b"m", dm).hexdigest())
print(hmac.digest(b"key", b"msg", "sha256").hex(), hmac.digest(b"key", b"msg", hashlib.md5).hex())
print(hmac.new(bytearray(b"key"), memoryview(b"msg"), "sha1").hexdigest(), hmac.new(b"key", array.array("b", [1, 2]), "sha1").hexdigest())
print(hmac.digest_size, hmac.trans_5C[:4], hmac.trans_36[:4])

# the errors
show(lambda: hmac.new(b"key"))
show(lambda: hmac.new(b"key", digestmod=None))
show(lambda: hmac.new("key", b"m", "sha256"))
show(lambda: hmac.new(b"key", "m", "sha256"))
show(lambda: hmac.new(b"key", b"m", "nope"))
show(lambda: hmac.new(b"key", b"m", 5))
show(lambda: hmac.new(b"k", b"m", "sha1").update("x"))
show(lambda: hmac.digest(b"k", b"m", "nope"))
show(lambda: hmac.HMAC(5, b"m", "sha1"))

# compare_digest (hmac's, which is _operator's)
# (which C function it is depends on the build: OpenSSL's or _operator's)
print(callable(hmac.compare_digest), hmac.compare_digest(b"x", b"x"), _compare_digest("ab", "ab"))
class Liar(str):
    def __eq__(self, other): return True
    __hash__ = str.__hash__
for a, b in ((b"a", b"a"), (b"a", b"b"), (b"a", b"ab"), (b"ab", b"a"), (b"", b""), ("ab", "ab"), ("ab", "ac"), ("", ""),
             (bytearray(b"x"), b"x"), (memoryview(b"xy"), b"xy"), (array.array("b", [1]), b"\x01"),
             (Liar("x"), "y"), (Liar("x"), "x"), ("é", "é"), ("a", "é"), (b"a", "a"), ("a", b"a"),
             (5, 5), (None, b""), (b"", None), (memoryview(b"xyz")[::2], b"xz"), (b"xz", memoryview(b"xyz")[::2])):
    show(lambda: hmac.compare_digest(a, b))
show(lambda: _compare_digest(b"a"))
show(lambda: _compare_digest(b"a", b"a", b"a"))
show(lambda: _compare_digest(a=b"x", b=b"x"))
