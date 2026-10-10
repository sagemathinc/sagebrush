# Text I/O (DOC-F10..F12): headers, shapes, ndmin, usecols, complex, gzip.
import numpy as np
import os
import tempfile

d = tempfile.mkdtemp()
p = os.path.join(d, "a.txt")
np.savetxt(p, np.array([[1, 2], [3, 4]]), fmt="%d", header="units\n99 100", footer="end\n777 888")
print(open(p).read())
print(np.loadtxt(p))
q = os.path.join(d, "row.txt")


def put(t):
    with open(q, "w") as f:
        f.write(t)


put("3 1 2\n")
print(np.loadtxt(q).shape, np.loadtxt(q, ndmin=1).shape, np.loadtxt(q, ndmin=2).shape)
put("5\n")
print(np.loadtxt(q).shape, np.loadtxt(q, ndmin=2).shape)
put("1\n2\n3\n")
print(np.loadtxt(q, ndmin=2).shape)
try:
    np.loadtxt(q, ndmin=3)
except ValueError as e:
    print("ValueError")
put("1 2 3\n4 5 6\n")
print(np.loadtxt(q, usecols=1))
put("1+2j 3-1j\n")
print(np.loadtxt(q, dtype=complex))
g = os.path.join(d, "z.txt.gz")
np.savetxt(g, np.array([[1., 2.], [3., 4.]]))
print(open(g, "rb").read()[:2].hex(), np.loadtxt(g))

# R2-DOC-F5/F6: every gzip member is read; a corrupt one is refused
import zlib as _zlib, struct as _struct, os as _os, tempfile as _tempfile
def _gz(d):
    z = _zlib.compress(d)
    return b"\x1f\x8b\x08\x00\x00\x00\x00\x00\x00\xff" + z[2:-4] + _struct.pack("<II", _zlib.crc32(d) & 0xFFFFFFFF, len(d))
_dir = _tempfile.mkdtemp()
_two = _os.path.join(_dir, "two.txt.gz")
with open(_two, "wb") as _f:
    _f.write(_gz(b"1 2\n") + _gz(b"3 4\n"))
print(np.loadtxt(_two).tolist())
_bad = bytearray(_gz(b"1 2\n")); _bad[-8] ^= 1
for _b in (bytes(_bad), _gz(b"1 2\n")[:-8]):
    with open(_two, "wb") as _f:
        _f.write(_b)
    try:
        np.loadtxt(_two)
        print("accepted")
    except Exception:
        print("refused")
