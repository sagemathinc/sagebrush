"""The comparator of mpmath's results by their exact raw values (design/mpmath-core.md 6.1): an mpf's
(sign, man, exp, bc), an mpc's pair, a matrix's entries, never printed text.  One helper, shared by
perf.py's digests, the fuzzer (fuzz.py) and the pins."""
import hashlib


def canon(r, f64=False):
    """The canonical text of a result's exact value; f64: a double-precision row, to 12 digits."""
    import mpmath
    if isinstance(r, mpmath.matrix):
        return "matrix(%d,%d:%s)" % (r.rows, r.cols, ",".join(canon(r[i, j]) for i in range(r.rows) for j in range(r.cols)))
    if hasattr(r, "_mpf_"):
        s, m, e, b = r._mpf_
        return "mpf(%d,%x,%d,%d)" % (s, m, e, b)
    if hasattr(r, "_mpc_"):
        return "mpc(%s,%s)" % (canon(mpmath.mp.make_mpf(r._mpc_[0])), canon(mpmath.mp.make_mpf(r._mpc_[1])))
    if isinstance(r, float):
        return "f64(%.12g)" % r if f64 else "float(%s)" % r.hex()
    if isinstance(r, complex):
        return "complex(%s,%s)" % (canon(r.real, f64), canon(r.imag, f64))
    if isinstance(r, bool):
        return "bool(%d)" % r
    if isinstance(r, int):
        return "int(%x)" % r
    if isinstance(r, (list, tuple)):
        return "(%s)" % ",".join(canon(x, f64) for x in r)
    if r is None:
        return "None"
    raise TypeError("no canonical form for %r" % type(r))


def digest(r, f64=False):
    return hashlib.sha256(canon(r, f64).encode()).hexdigest()
