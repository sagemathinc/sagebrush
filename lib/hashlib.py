"""Sagebrush: hashlib, CPython's interface to secure hashes and message
digests, for md5, sha1, sha224, sha256, sha384 and sha512.

The hashes are written in Python here (CPython's come from OpenSSL or HACL*):
the same digests, for any data, but slow (megabytes take seconds) and NOT
hardened: no constant-time guarantee, no protection against timing or other
side channels.  They are for compatibility and non-security uses: reproducing
a digest another program computes, a content checksum, uuid3/uuid5.  Don't
use them where an attacker can measure them or choose the input to defeat
them: MD5 and SHA-1 are broken for collision resistance (two different inputs
with the same digest can be made), so neither may authenticate or sign
anything.  usedforsecurity is accepted, as CPython's, and changes nothing
here: every algorithm is available either way, and none is hardened.
blake2, sha3, shake, pbkdf2_hmac, scrypt and file_digest are not here yet.

The interface is CPython 3.14's: new(name, data=b"") and the named
constructors (data=b"", *, usedforsecurity=True, string=None), each hash
object's update, digest, hexdigest, copy, name, digest_size and block_size,
and CPython's errors (str data: "Strings must be encoded before hashing").
"""

__all__ = ("md5", "sha1", "sha224", "sha256", "sha384", "sha512",
           "new", "algorithms_guaranteed", "algorithms_available")

_NAMES = ("md5", "sha1", "sha224", "sha256", "sha384", "sha512")
algorithms_guaranteed = frozenset(_NAMES)
algorithms_available = frozenset(_NAMES)

_M32 = 0xFFFFFFFF
_M64 = 0xFFFFFFFFFFFFFFFF


def _bytes_of(data):
    # (a hash reads a buffer's bytes; a str must be encoded first)
    if isinstance(data, str):
        raise TypeError("Strings must be encoded before hashing")
    if isinstance(data, (bytes, bytearray)):
        return bytes(data)
    if not isinstance(data, memoryview):
        try:
            data = memoryview(data)
        except TypeError:
            raise TypeError("object supporting the buffer API required") from None
    if not data.c_contiguous:
        raise BufferError("memoryview: underlying buffer is not C-contiguous")
    return data.tobytes()


_MD5_K = (
    0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a,
    0xa8304613, 0xfd469501, 0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be,
    0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821, 0xf61e2562, 0xc040b340,
    0x265e5a51, 0xe9b6c7aa, 0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
    0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed, 0xa9e3e905, 0xfcefa3f8,
    0x676f02d9, 0x8d2a4c8a, 0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c,
    0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70, 0x289b7ec6, 0xeaa127fa,
    0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
    0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92,
    0xffeff47d, 0x85845dd1, 0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1,
    0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391,
)

_SHA256_K = (
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
    0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
    0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
    0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
    0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
    0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
)

_SHA512_K = (
    0x428a2f98d728ae22, 0x7137449123ef65cd, 0xb5c0fbcfec4d3b2f, 0xe9b5dba58189dbbc,
    0x3956c25bf348b538, 0x59f111f1b605d019, 0x923f82a4af194f9b, 0xab1c5ed5da6d8118,
    0xd807aa98a3030242, 0x12835b0145706fbe, 0x243185be4ee4b28c, 0x550c7dc3d5ffb4e2,
    0x72be5d74f27b896f, 0x80deb1fe3b1696b1, 0x9bdc06a725c71235, 0xc19bf174cf692694,
    0xe49b69c19ef14ad2, 0xefbe4786384f25e3, 0x0fc19dc68b8cd5b5, 0x240ca1cc77ac9c65,
    0x2de92c6f592b0275, 0x4a7484aa6ea6e483, 0x5cb0a9dcbd41fbd4, 0x76f988da831153b5,
    0x983e5152ee66dfab, 0xa831c66d2db43210, 0xb00327c898fb213f, 0xbf597fc7beef0ee4,
    0xc6e00bf33da88fc2, 0xd5a79147930aa725, 0x06ca6351e003826f, 0x142929670a0e6e70,
    0x27b70a8546d22ffc, 0x2e1b21385c26c926, 0x4d2c6dfc5ac42aed, 0x53380d139d95b3df,
    0x650a73548baf63de, 0x766a0abb3c77b2a8, 0x81c2c92e47edaee6, 0x92722c851482353b,
    0xa2bfe8a14cf10364, 0xa81a664bbc423001, 0xc24b8b70d0f89791, 0xc76c51a30654be30,
    0xd192e819d6ef5218, 0xd69906245565a910, 0xf40e35855771202a, 0x106aa07032bbd1b8,
    0x19a4c116b8d2d0c8, 0x1e376c085141ab53, 0x2748774cdf8eeb99, 0x34b0bcb5e19b48a8,
    0x391c0cb3c5c95a63, 0x4ed8aa4ae3418acb, 0x5b9cca4f7763e373, 0x682e6ff3d6b2b8a3,
    0x748f82ee5defb2fc, 0x78a5636f43172f60, 0x84c87814a1f0ab72, 0x8cc702081a6439ec,
    0x90befffa23631e28, 0xa4506cebde82bde9, 0xbef9a3f7b2c67915, 0xc67178f2e372532b,
    0xca273eceea26619c, 0xd186b8c721c0c207, 0xeada7dd6cde0eb1e, 0xf57d4f7fee6ed178,
    0x06f067aa72176fba, 0x0a637dc5a2c898a6, 0x113f9804bef90dae, 0x1b710b35131c471b,
    0x28db77f523047d84, 0x32caab7b40c72493, 0x3c9ebe0a15c9bebc, 0x431d67c49c100d4c,
    0x4cc5d4becb3e42b6, 0x597f299cfc657e2a, 0x5fcb6fab3ad6faec, 0x6c44198c4a475817,
)

_SHA224_H = (
    0xc1059ed8, 0x367cd507, 0x3070dd17, 0xf70e5939, 0xffc00b31, 0x68581511,
    0x64f98fa7, 0xbefa4fa4,
)

_SHA256_H = (
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
    0x1f83d9ab, 0x5be0cd19,
)

_SHA384_H = (
    0xcbbb9d5dc1059ed8, 0x629a292a367cd507, 0x9159015a3070dd17, 0x152fecd8f70e5939,
    0x67332667ffc00b31, 0x8eb44a8768581511, 0xdb0c2e0d64f98fa7, 0x47b5481dbefa4fa4,
)

_SHA512_H = (
    0x6a09e667f3bcc908, 0xbb67ae8584caa73b, 0x3c6ef372fe94f82b, 0xa54ff53a5f1d36f1,
    0x510e527fade682d1, 0x9b05688c2b3e6c1f, 0x1f83d9abfb41bd6b, 0x5be0cd19137e2179,
)


def _rotl32(x, n):
    return ((x << n) | (x >> (32 - n))) & _M32


def _rotr32(x, n):
    return ((x >> n) | (x << (32 - n))) & _M32


def _rotr64(x, n):
    return ((x >> n) | (x << (64 - n))) & _M64


_MD5_S = (7, 12, 17, 22) * 4 + (5, 9, 14, 20) * 4 + (4, 11, 16, 23) * 4 + (6, 10, 15, 21) * 4


def _md5_compress(h, block):
    x = [int.from_bytes(block[i:i + 4], "little") for i in range(0, 64, 4)]
    a, b, c, d = h
    for i in range(64):
        if i < 16:
            f = (b & c) | (~b & d)
            g = i
        elif i < 32:
            f = (d & b) | (~d & c)
            g = (5 * i + 1) % 16
        elif i < 48:
            f = b ^ c ^ d
            g = (3 * i + 5) % 16
        else:
            f = c ^ (b | (~d & _M32))
            g = (7 * i) % 16
        f = (f + a + _MD5_K[i] + x[g]) & _M32
        a, d, c = d, c, b
        b = (b + _rotl32(f, _MD5_S[i])) & _M32
    return [(u + v) & _M32 for u, v in zip(h, (a, b, c, d))]


def _sha1_compress(h, block):
    w = [int.from_bytes(block[i:i + 4], "big") for i in range(0, 64, 4)]
    for t in range(16, 80):
        w.append(_rotl32(w[t - 3] ^ w[t - 8] ^ w[t - 14] ^ w[t - 16], 1))
    a, b, c, d, e = h
    for t in range(80):
        if t < 20:
            f, k = (b & c) | (~b & d), 0x5A827999
        elif t < 40:
            f, k = b ^ c ^ d, 0x6ED9EBA1
        elif t < 60:
            f, k = (b & c) | (b & d) | (c & d), 0x8F1BBCDC
        else:
            f, k = b ^ c ^ d, 0xCA62C1D6
        a, b, c, d, e = (_rotl32(a, 5) + (f & _M32) + e + k + w[t]) & _M32, a, _rotl32(b, 30), c, d
    return [(u + v) & _M32 for u, v in zip(h, (a, b, c, d, e))]


def _sha256_compress(h, block):
    w = [int.from_bytes(block[i:i + 4], "big") for i in range(0, 64, 4)]
    for t in range(16, 64):
        s0 = _rotr32(w[t - 15], 7) ^ _rotr32(w[t - 15], 18) ^ (w[t - 15] >> 3)
        s1 = _rotr32(w[t - 2], 17) ^ _rotr32(w[t - 2], 19) ^ (w[t - 2] >> 10)
        w.append((w[t - 16] + s0 + w[t - 7] + s1) & _M32)
    a, b, c, d, e, f, g, hh = h
    for t in range(64):
        t1 = (hh + (_rotr32(e, 6) ^ _rotr32(e, 11) ^ _rotr32(e, 25)) + ((e & f) ^ (~e & g)) + _SHA256_K[t] + w[t]) & _M32
        t2 = ((_rotr32(a, 2) ^ _rotr32(a, 13) ^ _rotr32(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) & _M32
        a, b, c, d, e, f, g, hh = (t1 + t2) & _M32, a, b, c, (d + t1) & _M32, e, f, g
    return [(u + v) & _M32 for u, v in zip(h, (a, b, c, d, e, f, g, hh))]


def _sha512_compress(h, block):
    w = [int.from_bytes(block[i:i + 8], "big") for i in range(0, 128, 8)]
    for t in range(16, 80):
        s0 = _rotr64(w[t - 15], 1) ^ _rotr64(w[t - 15], 8) ^ (w[t - 15] >> 7)
        s1 = _rotr64(w[t - 2], 19) ^ _rotr64(w[t - 2], 61) ^ (w[t - 2] >> 6)
        w.append((w[t - 16] + s0 + w[t - 7] + s1) & _M64)
    a, b, c, d, e, f, g, hh = h
    for t in range(80):
        t1 = (hh + (_rotr64(e, 14) ^ _rotr64(e, 18) ^ _rotr64(e, 41)) + ((e & f) ^ (~e & g)) + _SHA512_K[t] + w[t]) & _M64
        t2 = ((_rotr64(a, 28) ^ _rotr64(a, 34) ^ _rotr64(a, 39)) + ((a & b) ^ (a & c) ^ (b & c))) & _M64
        a, b, c, d, e, f, g, hh = (t1 + t2) & _M64, a, b, c, (d + t1) & _M64, e, f, g
    return [(u + v) & _M64 for u, v in zip(h, (a, b, c, d, e, f, g, hh))]


# name: (initial state, compress, block size, word bytes, byte order, digest size, length field bytes)
_ALGORITHMS = {
    "md5": ((0x67452301, 0xEFCDAB89, 0x98BADCFE, 0x10325476), _md5_compress, 64, 4, "little", 16, 8),
    "sha1": ((0x67452301, 0xEFCDAB89, 0x98BADCFE, 0x10325476, 0xC3D2E1F0), _sha1_compress, 64, 4, "big", 20, 8),
    "sha224": (_SHA224_H, _sha256_compress, 64, 4, "big", 28, 8),
    "sha256": (_SHA256_H, _sha256_compress, 64, 4, "big", 32, 8),
    "sha384": (_SHA384_H, _sha512_compress, 128, 8, "big", 48, 16),
    "sha512": (_SHA512_H, _sha512_compress, 128, 8, "big", 64, 16),
}


class HASH:
    """A hash object: update(data) adds bytes, digest() and hexdigest() give
    the digest of everything added so far, copy() a copy."""

    __slots__ = ("_name", "_state")

    def __new__(cls, *args, **kwargs):
        raise TypeError("cannot create '_hashlib.HASH' instances")

    def _read_only(attr):
        def refuse(self, value):
            raise AttributeError("attribute '%s' of '_hashlib.HASH' objects is not writable" % attr)
        return refuse

    name = property(lambda self: self._name, _read_only("name"))
    digest_size = property(lambda self: _ALGORITHMS[self._name][5], _read_only("digest_size"))
    block_size = property(lambda self: _ALGORITHMS[self._name][2], _read_only("block_size"))
    del _read_only

    def update(self, obj, /):
        """Update this hash object's state with the provided string."""
        data = _bytes_of(obj)
        _, compress, bs = _ALGORITHMS[self._name][:3]
        h, buf, count = self._state
        buf += data
        n = len(buf) - len(buf) % bs
        for i in range(0, n, bs):
            h = compress(h, buf[i:i + bs])
        # (the new state is published in one store, after every block: an
        # exception or an interrupt in the loop leaves the old state whole)
        self._state = (h, buf[n:], count + len(data))

    def digest(self):
        """Return the digest value as a bytes object."""
        _, compress, bs, wb, order, size, lb = _ALGORITHMS[self._name]
        h, buf, count = self._state
        bits = (count * 8).to_bytes(lb, order)
        pad = b"\x80" + b"\x00" * ((bs - lb - 1 - len(buf)) % bs)
        tail = buf + pad + bits
        for i in range(0, len(tail), bs):
            h = compress(h, tail[i:i + bs])
        return b"".join(v.to_bytes(wb, order) for v in h)[:size]

    def hexdigest(self):
        """Return the digest value as a string of hexadecimal digits."""
        return self.digest().hex()

    def copy(self):
        """Return a copy of the hash object."""
        return _make(self._name, *self._state)

    def __repr__(self):
        return "<%s _hashlib.HASH object @ %#x>" % (self._name, id(self))


HASH.__module__ = "_hashlib"
_HASH = HASH  # (CPython's hashlib has no public name for it)
del HASH


def _make(name, h, buf, count):
    obj = object.__new__(_HASH)
    obj._name = name
    obj._state = (tuple(h), buf, count)
    return obj


class _Absent:
    # (a default that says it wasn't given: CPython tells data=b"" and
    # string=None given from not given; its repr is CPython's default's)
    __slots__ = ("_r",)

    def __init__(self, r):
        self._r = r

    def __repr__(self):
        return self._r


_NO_DATA = _Absent("b''")
_NO_STRING = _Absent("None")


def _constructor(name):
    def construct(data=_NO_DATA, *, usedforsecurity=True, string=_NO_STRING):
        if string is not _NO_STRING:
            if data is not _NO_DATA:
                raise TypeError("'data' and 'string' are mutually exclusive and support for "
                                "'string' keyword parameter is slated for removal in a future version.")
            data = string
        obj = _make(name, _ALGORITHMS[name][0], b"", 0)
        if data is not _NO_DATA:
            obj.update(data)
        return obj
    construct.__name__ = construct.__qualname__ = name
    construct.__doc__ = "Returns a %s hash object; optionally initialized with a string" % name
    return construct


md5 = _constructor("md5")
sha1 = _constructor("sha1")
sha224 = _constructor("sha224")
sha256 = _constructor("sha256")
sha384 = _constructor("sha384")
sha512 = _constructor("sha512")


def new(name, *args, **kwargs):
    """new(name, data=b'') - Return a new hashing object using the named algorithm;
    optionally initialized with data (which must be a bytes-like object).
    """
    if not isinstance(name, str):
        raise TypeError("new() argument 'name' must be str, not %s" % type(name).__name__)
    name = str.__str__(name)  # (its own characters, whatever a subclass's methods say)
    key = str.lower(name)
    if key not in _ALGORITHMS:
        raise ValueError("unsupported hash type " + name)
    return globals()[key](*args, **kwargs)
