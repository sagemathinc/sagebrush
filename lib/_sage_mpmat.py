"""Dense linear algebra over RealField(p), p > 53: the multiprecision core's
(engine/mp's linalg.rs, the same LU, inverse, determinant and solve as
mpmath's matrices, one call into the core each).  _sage_ffmat's det, inverse
and solve_right come here first for such a matrix; None means "not here"
(a special entry, an exponent the core does not take), and the field's own
Gaussian elimination answers as before.

Each result is the core's, rounded to the field's precision with the field's
rounding.  Like Sage's, these are floating-point results: they agree with
Sage's to within a few units in the last place, not bit for bit (Sage's
algorithm is not mpmath's).  A matrix the core finds numerically singular is
Sage's ZeroDivisionError for the inverse and 0 for the determinant."""


def _core():
    try:
        from sagebrush import _mpcore as C  # the CPython package: the core natively
    except ImportError:
        import _sagebrush_mpcore as C  # pyjs: the builtin module (WebAssembly, or the host's native core)
    return C


# the field's rounding as mpmath's (the core's codes)
_RND = {"RNDN": "n", "RNDZ": "d", "RNDU": "c", "RNDD": "f", "RNDA": "u"}


def _real_field(base):
    return type(base).__name__ == "RealField_" and base._rnd in _RND


def _raw(x):
    """A RealNumberMP as a raw mpf (sign, odd man, exp, bc); None for a special value."""
    if getattr(x, "_special", None):
        return None
    m, e = x._m, x._e
    if not m:
        return (0, 0, 0, 0)
    sign, m = (1, -m) if m < 0 else (0, m)
    tz = (m & -m).bit_length() - 1
    m >>= tz
    return (sign, m, e + tz, m.bit_length())


def _raws(xs):
    out = []
    for x in xs:
        r = _raw(x)
        if r is None:
            return None
        out.append(r)
    return out


def _real(R, t):
    """A raw mpf as an element of R: rounded to R's precision with R's rounding."""
    from _sage_real import RealNumberMP, _round_int
    sign, man, exp, bc = t
    if not man:
        return R.zero()
    return RealNumberMP(R, *_round_int(-man if sign else man, exp, R._prec, R._rnd))


def det(M):
    """The determinant, or None."""
    R = M._base
    if not _real_field(R):
        return None
    n = M.nrows()
    a = _raws(x for r in M._rows for x in r)
    if a is None:
        return None
    # (at 10 bits more than the field's, rounded once to it)
    d = _core().mat_det(a, n, R._prec + 10, _RND[R._rnd])
    if d is None:
        return None
    return R.zero() if d == 0 else _real(R, d)


def inverse(M):
    """The inverse, or None; ZeroDivisionError for a (numerically) singular matrix, as Sage."""
    from _sage_ffmat import FFMatrix
    R = M._base
    if not _real_field(R):
        return None
    n = M.nrows()
    a = _raws(x for r in M._rows for x in r)
    if a is None:
        return None
    try:
        x = _core().mat_inverse(a, n, R._prec, _RND[R._rnd])
    except ZeroDivisionError:
        raise ZeroDivisionError("input matrix must be nonsingular")
    if x is None:
        return None
    return FFMatrix(R, [[_real(R, x[i * n + j]) for j in range(n)] for i in range(n)], n)


def solve_right(M, cols):
    """The solutions of M x = c for each column c (lists of field elements), for a square nonsingular M, or
    None (a singular M: the field's elimination decides between no solution and many)."""
    R = M._base
    if not _real_field(R):
        return None
    n = M.nrows()
    a = _raws(x for r in M._rows for x in r)
    bs = [_raws(c) for c in cols]
    if a is None or any(b is None for b in bs):
        return None
    C, rnd = _core(), _RND[R._rnd]
    out = []
    for b in bs:
        try:
            x = C.mat_lu_solve(a, b, n, R._prec, rnd)
        except ZeroDivisionError:
            return None
        if x is None:
            return None
        out.append([_real(R, t) for t in x])
    return out
