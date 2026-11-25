"""MATLAB's Krylov solvers pcg, minres, gmres, bicgstab and lsqr, for lib/_matlab.py.  Loaded lazily: lib/_matlab.py
registers each name as a stub that imports this module the first time one of them is called (so it is in the lazy
matlab-more chunk, web/lib-chunks.mts); importing it registers the real built-ins over the stubs.

The arguments, defaults and outputs are those of each solver's MATLAB documentation page; the iterations are the
published algorithms: conjugate gradients (Hestenes and Stiefel, 1952), MINRES (Paige and Saunders, 1975), GMRES
(Saad and Schultz, 1986), BiCGSTAB (van der Vorst, 1992) and LSQR (Paige and Saunders, 1982).  MATLAB R2026b's
outputs on small systems (observed 2026-11-24) fix what the pages leave open:

- a solver that doesn't converge returns the iterate with the least residual among all it computed, x0 included
  (iteration 0), and iter is that iterate's number;
- resvec holds the residual norm before the first iteration and after each one: one entry per half iteration for
  bicgstab, whose iter counts halves (9.5), and one per inner iteration for gmres, whose iter is [outer inner];
- a residual that meets the tolerance by its recurrence is checked against b - A*x before convergence is declared,
  and resvec's last entry is that true residual;
- pcg stops with flag 4 at the first step whose p'*A*p is not positive (a matrix that is not positive definite);
- lsqr's relres is norm(b - A*x)/norm(b) even when it converged by its least-squares test;
- gmres with a restart longer than size(A,1) warns (MATLAB:gmres:tooManyInnerItsRestart) and restarts never;
- without a flag output, a solver prints what happened: "pcg stopped at iteration 2 without converging to the
  desired tolerance 1e-12 / because the maximum number of iterations was reached. / The iterate returned (number 0)
  has relative residual 1." (the other messages follow that one's pattern, and are not yet checked against MATLAB).
"""

import math as _math

import numpy as np

import _matlab as _m
from _matlab import _bi, _err, _istext, _text

_EPS = 2.220446049250313e-16
# (stagnation: this many steps in a row that change x by less than eps relative to it)
_STAG_STEPS = 3
# (the memory admitted: each vector of the problem's length at 8 bytes an element, complex data twice that; the short
# recurrences hold this many such vectors at once, with the copies each product with A or M makes: measured under
# CPython's tracemalloc on a sparse tridiagonal system of 20,000 unknowns, at most 25 for bicgstab with M1 and M2, 19
# to 24 for the others, and gmres the same 20 or so besides its basis)
_VECTOR_BYTES = 8
_SHORT = 32


def _norm(v):
    return float(np.sqrt(np.sum(np.abs(v) ** 2))) if v.size else 0.0


def _dot(a, b):
    """a'*b, conjugating a"""
    return np.sum(np.conj(a) * b) if a.size else 0.0


def _finite(z):
    return bool(np.all(np.isfinite(z)))


def _col(v):
    return _m._unmat(np.asarray(v).reshape(-1, 1))


def _vec(v):
    """a MATLAB value as a flat vector, in its column order"""
    if type(v) is _m.Sparse:
        v = _m._B["full"].call(1, [v])
    return np.array(_m._farr(v).reshape(-1))


def _empty(v):
    return v is None or (not _m._iscallable(v) and _m._numel(v) == 0)


def _matrix_arg(v, fname, what):
    """a matrix argument's class checked: double, full or sparse"""
    if _istext(v) or not _m._isnumlike(v):
        raise _err("%s: %s must be a numeric matrix or a function handle." % (fname, what))
    cls = _m.class_(v)
    if cls == "single":
        raise _err("%s: single precision is not supported in Sagebrush; use double." % fname)
    if cls != "double":
        raise _err("%s: %s must be of class double." % (fname, what))
    if len(_m._dims(v)) > 2:
        raise _err("%s: %s must be a 2-D matrix." % (fname, what))


class _Op:
    """A (or a preconditioner): a matrix applied with MATLAB's own mtimes and mldivide, so full, sparse and complex
    matrices are all A*x and M\\x as MATLAB computes them, or a function handle that returns them"""

    def __init__(self, v, fname, what, m, n, transp=False, precond=False):
        self.fname, self.what, self.m, self.n, self.transp = fname, what, m, n, transp
        self.handle = _m._iscallable(v)
        self.diag, self.isdiag = None, False
        if not self.handle:
            _matrix_arg(v, fname, what)
            d = _m._dims(v)
            if (d[0], d[1]) != (m, n):
                raise _err("%s: %s must be %d-by-%d." % (fname, what, m, n))
            # (a diagonal preconditioner, Jacobi's: M\x is x divided by its diagonal, as mldivide divides, without
            # mldivide's work on the whole matrix at every step; the diagonal is taken at the first solve, after the
            # solver's memory is admitted)
            self.isdiag = precond and bool(_m._B["isdiag"].call(1, [v]))
        self.v = v

    def _diagonal(self):
        if self.diag is None:
            self.diag = _vec(_m._B["diag"].call(1, [self.v]))
        return self.diag

    def _handle_call(self, x, opt, rows):
        args = [_col(x)] + ([_m.Char(opt)] if self.transp else [])
        r = _m._call(self.v, args)
        if not _m._isnumlike(r) or _istext(r) or _m._numel(r) != rows:
            raise _err("%s: the function handle for %s must return a vector of length %d." % (self.fname, self.what, rows))
        return _vec(r)

    def times(self, x):
        """A*x"""
        if self.handle:
            return self._handle_call(x, "notransp", self.m)
        return _vec(_m._B["mtimes"].call(1, [self.v, _col(x)]))

    def ctimes(self, x):
        """A'*x, as (x'*A)' so that A is never transposed into a copy"""
        if self.handle:
            return self._handle_call(x, "transp", self.n)
        row = _m._B["mtimes"].call(1, [_m._B["ctranspose"].call(1, [_col(x)]), self.v])
        return np.conj(_vec(row))

    def solve(self, x):
        """M\\x, or None when it isn't finite (an ill-conditioned preconditioner)"""
        if self.handle:
            y = self._handle_call(x, "notransp", self.n)
        elif self.isdiag:
            with np.errstate(divide="ignore", invalid="ignore"):
                y = x / self._diagonal()
        else:
            y = _vec(_m._B["mldivide"].call(1, [self.v, _col(x)]))
        return y if _finite(y) else None

    def csolve(self, x):
        """M'\\x"""
        if self.handle:
            y = self._handle_call(x, "transp", self.n)
        elif self.isdiag:
            with np.errstate(divide="ignore", invalid="ignore"):
                y = x / np.conj(self._diagonal())
        else:
            y = _vec(_m._B["mldivide"].call(1, [_m._B["ctranspose"].call(1, [self.v]), _col(x)]))
        return y if _finite(y) else None


class _Precond:
    """M = M1*M2 (either may be absent): M\\x is M2\\(M1\\x), M'\\x is M1'\\(M2'\\x)"""

    def __init__(self, ops):
        self.ops = [o for o in ops if o is not None]

    def solve(self, x):
        for o in self.ops:
            x = o.solve(x)
            if x is None:
                return None
        return x

    def csolve(self, x):
        for o in reversed(self.ops):
            x = o.csolve(x)
            if x is None:
                return None
        return x


def _scalar_arg(v, fname, what, default, integer=False):
    if _empty(v):
        return default
    if _istext(v) or not _m._isnumlike(v) or _m._numel(v) != 1 or np.iscomplexobj(_m._farr(v)):
        raise _err("%s: %s must be a real scalar." % (fname, what))
    s = _m._scalar(v)
    if integer:
        if not _math.isfinite(s) or s != _math.floor(s) or s < 0:
            raise _err("%s: %s must be a nonnegative integer." % (fname, what))
        return int(s)
    if _math.isnan(s):
        raise _err("%s: %s must be a real scalar." % (fname, what))
    return s


def _setup(fname, nargout, args, vectors, restart=False, square=True, nout=5):
    """the problem from a solver's arguments: (A, b, [restart,] tol, maxit, M1, M2, x0), as its page lists them; its
    work, vectors(n, restart, maxit) -> (vectors of the problem's length, other elements), admitted before any vector
    is made"""
    names = ["A", "b"] + (["restart"] if restart else []) + ["tol", "maxit", "M1", "M2", "x0"]
    if len(args) < 2:
        raise _err("Not enough input arguments.", "MATLAB:minrhs")
    if len(args) > len(names):
        # (the old trailing parameters passed on to a function handle are not supported: use an anonymous function)
        raise _err("Too many input arguments.", "MATLAB:TooManyInputs")
    if nargout > nout:
        raise _err("Too many output arguments.", "MATLAB:TooManyOutputs")
    a = dict(zip(names, args))
    A, b = a["A"], a["b"]
    if _istext(b) or not _m._isnumlike(b):
        raise _err("%s: b must be a numeric column vector." % fname)
    _matrix_arg(b, fname, "b")
    bd = _m._dims(b)
    if _m._iscallable(A):
        m = bd[0]
        n = m
        if not square:
            # (a handle's A has as many columns as A'*b has elements)
            probe = _m._call(A, [b, _m.Char("transp")])
            if _istext(probe) or not _m._isnumlike(probe):
                raise _err("%s: the function handle for A must return a numeric vector." % fname)
            n = _m._numel(probe)
    else:
        _matrix_arg(A, fname, "A")
        m, n = _m._dims(A)[0], _m._dims(A)[1]
        if square and m != n:
            raise _err("%s: the coefficient matrix A must be square." % fname, "MATLAB:%s:NonSquareMatrix" % fname)
    if bd[1] != 1 or bd[0] != m:
        raise _err("Right-hand side must be a column vector of length %d to match the coefficient matrix." % m,
                   "MATLAB:%s:RSHsizeMatchCoeffMatrix" % fname)
    tol = _scalar_arg(a.get("tol"), fname, "tol", 1e-6)
    r = None
    if restart:
        r = None if _empty(a.get("restart")) else _scalar_arg(a.get("restart"), fname, "restart", None, integer=True)
        if r is not None and r < 1:
            raise _err("%s: restart must be a positive integer." % fname)
    maxit = a.get("maxit")
    maxit = None if _empty(maxit) else _scalar_arg(maxit, fname, "maxit", None, integer=True)
    op = _Op(A, fname, "A", m, n, transp=not square)
    pre = []
    for k in ("M1", "M2"):
        v = a.get(k)
        if not _empty(v):
            pre.append(_Op(v, fname, k, n, n, transp=not square, precond=True))
    x0 = a.get("x0")
    if not _empty(x0):
        if _istext(x0) or not _m._isnumlike(x0):
            raise _err("%s: x0 must be a numeric column vector." % fname)
        _matrix_arg(x0, fname, "x0")
        xd = _m._dims(x0)
        if xd[1] != 1 or xd[0] != n:
            raise _err("Initial guess must be a column vector of length %d to match the problem size." % n,
                       "MATLAB:%s:WrongInitGuessSize" % fname)
    isreal = _m._B["isreal"]
    cplx = not isreal.call(1, [b]) or (not _empty(x0) and not isreal.call(1, [x0]))
    if not _m._iscallable(A):
        cplx = cplx or not isreal.call(1, [A])
    count, extra = vectors(max(m, n), r, maxit)
    _admit(fname, max(m, n), count, cplx, extra)
    bv = _vec(b)
    x0v = np.zeros(n, dtype=np.complex128 if cplx else np.float64) if _empty(x0) else _vec(x0)
    return op, bv, tol, maxit, r, _Precond(pre), x0v, m, n, cplx


def _admit(fname, n, vectors, cplx, extra=0):
    """the solver's vectors of length n (and extra elements) admitted before any is made"""
    per = _VECTOR_BYTES * (2 if cplx else 1)
    _m._admit_bytes(per * (n * vectors + extra), "%s of a system of %d unknowns" % (fname, n))


_REASONS = {
    1: "the maximum number of iterations was reached",
    2: "the system involving the preconditioner was ill conditioned",
    3: "the method stagnated",
    4: "a scalar quantity became too small or too large to continue computing",
    5: "the preconditioner is not symmetric positive definite",
}


def _it(v):
    return "%d" % v if v == int(v) else "%g" % v


def _report(fname, flag, relres, it_ret, it_stop, tol):
    """the message a solver prints when its flag isn't requested"""
    if flag == 0:
        _m._write("%s converged at iteration %s to a solution with relative residual %.2g.\n" % (fname, _it(it_ret), relres))
        return
    _m._write("%s stopped at iteration %s without converging to the desired tolerance %.2g\n"
              "because %s.\nThe iterate returned (number %s) has relative residual %.2g.\n"
              % (fname, _it(it_stop), tol, _REASONS[flag], _it(it_ret), relres))


def _outputs(nargout, x, flag, relres, it, resvec, extra=()):
    outs = [_col(x), float(flag), float(relres), it if not isinstance(it, (int, float)) else float(it),
            _col(np.array(resvec, dtype=np.float64))] + list(extra)
    if nargout <= 1:
        return outs[0]
    return outs[:nargout]


# ------------------------------------------------------------------ pcg

def _pcg(op, b, tol, maxit, M, x0):
    """preconditioned conjugate gradients: (x, flag, relres, iter, resvec, last iteration tried)"""
    n2b = _norm(b)
    if n2b == 0:
        return np.zeros_like(x0), 0, 0.0, 0, [0.0], 0
    x = x0.copy()
    r = b - op.times(x)
    normr = _norm(r)
    resvec = [normr]
    tolb = tol * n2b
    if normr <= tolb:
        return x, 0, normr / n2b, 0, resvec, 0
    xmin, normrmin, imin = x.copy(), normr, 0
    flag, rho, p, stag, ii = 1, 1.0, None, 0, 0
    for ii in range(1, maxit + 1):
        z = M.solve(r)
        if z is None:
            flag = 2
            break
        rho1, rho = rho, _dot(r, z)
        if rho == 0 or not _finite(rho):
            flag = 4
            break
        if ii == 1:
            p = z
        else:
            beta = rho / rho1
            if beta == 0 or not _finite(beta):
                flag = 4
                break
            p = z + beta * p
        q = op.times(p)
        pq = _dot(p, q)
        if not _finite(pq) or np.real(pq) <= 0:
            flag = 4
            break
        alpha = rho / pq
        if not _finite(alpha):
            flag = 4
            break
        stag = stag + 1 if _norm(p) * abs(alpha) < _EPS * _norm(x) else 0
        x = x + alpha * p
        r = r - alpha * q
        normr = _norm(r)
        resvec.append(normr)
        if normr <= tolb or stag >= _STAG_STEPS:
            # (the recurrence says the tolerance is met: b - A*x says whether it is, and goes on from there)
            r = b - op.times(x)
            normr = _norm(r)
            resvec[ii] = normr
            if normr <= tolb:
                return x, 0, normr / n2b, ii, resvec, ii
        if normr < normrmin:
            xmin, normrmin, imin = x.copy(), normr, ii
        if stag >= _STAG_STEPS:
            flag = 3
            break
    return xmin, flag, _norm(b - op.times(xmin)) / n2b, imin, resvec, ii


@_bi("pcg")
def pcg_(nargout, *args):
    """[x, flag, relres, iter, resvec] = pcg(A, b, tol, maxit, M1, M2, x0): preconditioned conjugate gradients for a
    symmetric (Hermitian) positive definite A, a matrix or a function handle returning A*x; M = M1*M2 the
    preconditioner, matrices or handles returning M\\x; tol 1e-6 and maxit min(size(A,1), 20) by default"""
    op, b, tol, maxit, _, M, x0, m, n, cplx = _setup("pcg", nargout, args, lambda n, r, k: (_SHORT, 0))
    maxit = min(n, 20) if maxit is None else maxit
    x, flag, relres, it, resvec, stop = _pcg(op, b, tol, maxit, M, x0)
    if nargout < 2:
        _report("pcg", flag, relres, it, stop, tol)
    return _outputs(nargout, x, flag, relres, it, resvec)


# ------------------------------------------------------------------ minres

def _minres(op, b, tol, maxit, M, x0):
    """MINRES (Paige and Saunders): the Lanczos process on A, preconditioned by a symmetric positive definite M, and
    the residual's norm kept by plane rotations"""
    n2b = _norm(b)
    if n2b == 0:
        return np.zeros_like(x0), 0, 0.0, 0, [0.0], 0
    x = x0.copy()
    r1 = b - op.times(x)
    normr = _norm(r1)
    resvec = [normr]
    tolb = tol * n2b
    if normr <= tolb:
        return x, 0, normr / n2b, 0, resvec, 0
    y = M.solve(r1)
    if y is None:
        return x, 2, normr / n2b, 0, resvec, 0
    b2 = np.real(_dot(r1, y))
    if b2 <= 0 or not _finite(b2):
        return x, 5, normr / n2b, 0, resvec, 0
    beta1 = _math.sqrt(b2)
    xmin, normrmin, imin = x.copy(), normr, 0
    oldb, beta, dbar, epsln, phibar = 0.0, beta1, 0.0, 0.0, beta1
    cs, sn = -1.0, 0.0
    w = w2 = np.zeros_like(x)
    r2 = r1
    # (phibar is the residual's norm in M's inverse: the true residual's is scaled by the first one's ratio)
    scale = normr / beta1
    flag, stag, ii = 1, 0, 0
    for ii in range(1, maxit + 1):
        v = y / beta
        y = op.times(v)
        if ii >= 2:
            y = y - (beta / oldb) * r1
        alfa = np.real(_dot(v, y))
        y = y - (alfa / beta) * r2
        r1, r2 = r2, y
        y = M.solve(r2)
        if y is None:
            flag = 2
            break
        oldb = beta
        b2 = np.real(_dot(r2, y))
        if b2 < 0 or not _finite(b2):
            flag = 5
            break
        beta = _math.sqrt(b2)
        oldeps = epsln
        delta = cs * dbar + sn * alfa
        gbar = sn * dbar - cs * alfa
        epsln = sn * beta
        dbar = -cs * beta
        gamma = _math.hypot(gbar, beta)
        if gamma == 0 or not _math.isfinite(gamma):
            flag = 4
            break
        cs, sn = gbar / gamma, beta / gamma
        phi = cs * phibar
        phibar = sn * phibar
        w1, w2 = w2, w
        w = (v - oldeps * w1 - delta * w2) / gamma
        step = phi * w
        stag = stag + 1 if _norm(step) < _EPS * _norm(x) else 0
        x = x + step
        normr = abs(phibar) * scale
        resvec.append(normr)
        if normr <= tolb or beta == 0 or stag >= _STAG_STEPS:
            normr = _norm(b - op.times(x))
            resvec[ii] = normr
            if normr <= tolb:
                return x, 0, normr / n2b, ii, resvec, ii
        if normr < normrmin:
            xmin, normrmin, imin = x.copy(), normr, ii
        if stag >= _STAG_STEPS:
            flag = 3
            break
        if beta == 0:
            # (the Lanczos process ended: x is the best the Krylov space holds, and it didn't meet the tolerance)
            flag = 4
            break
    return xmin, flag, _norm(b - op.times(xmin)) / n2b, imin, resvec, ii


@_bi("minres")
def minres_(nargout, *args):
    """[x, flag, relres, iter, resvec] = minres(A, b, tol, maxit, M1, M2, x0): the minimum residual method for a
    symmetric (Hermitian) A, which may be indefinite; M = M1*M2 symmetric positive definite (flag 5 when it isn't);
    tol 1e-6 and maxit min(size(A,1), 20) by default.  The sixth output, resveccg, is not supported in Sagebrush"""
    if nargout > 5:
        raise _err("minres: the sixth output (resveccg) is not supported in Sagebrush.")
    op, b, tol, maxit, _, M, x0, m, n, cplx = _setup("minres", nargout, args, lambda n, r, k: (_SHORT, 0))
    maxit = min(n, 20) if maxit is None else maxit
    x, flag, relres, it, resvec, stop = _minres(op, b, tol, maxit, M, x0)
    if nargout < 2:
        _report("minres", flag, relres, it, stop, tol)
    return _outputs(nargout, x, flag, relres, it, resvec)


# ------------------------------------------------------------------ gmres

def _gmres(op, b, tol, restart, outer, M, x0, n):
    """restarted GMRES (Saad and Schultz) on M\\A x = M\\b: Arnoldi with modified Gram-Schmidt, orthogonalized
    twice, and Givens rotations for the least-squares problem; (x, flag, relres, [outer inner], resvec, stop)"""
    mb = M.solve(b)
    if mb is None:
        return x0, 2, 1.0, [0, 0], [_norm(b)], [0, 0]
    n2b = _norm(mb)
    if n2b == 0:
        return np.zeros_like(x0), 0, 0.0, [0, 0], [0.0], [0, 0]
    tolb = tol * n2b
    x = x0.copy()
    r = M.solve(b - op.times(x))
    if r is None:
        return x, 2, 1.0, [0, 0], [_norm(b)], [0, 0]
    normr = _norm(r)
    resvec = [normr]
    if normr <= tolb:
        return x, 0, normr / n2b, [0, 0], resvec, [0, 0]
    xmin, normrmin, itmin = x.copy(), normr, [0, 0]
    dt = np.complex128 if np.iscomplexobj(r) or np.iscomplexobj(x) else np.float64
    flag, stop = 1, [0, 0]
    for o in range(1, outer + 1):
        beta = _norm(r)
        V = np.zeros((restart + 1, n), dtype=dt)
        H = np.zeros((restart + 1, restart), dtype=dt)
        cs = np.zeros(restart, dtype=dt)
        sn = np.zeros(restart, dtype=dt)
        g = np.zeros(restart + 1, dtype=dt)
        V[0] = r / beta
        g[0] = beta
        k = 0
        done = False
        for k in range(1, restart + 1):
            stop = [o, k]
            w = M.solve(op.times(V[k - 1]))
            if w is None:
                flag, done = 2, True
                k -= 1
                break
            for _pass in range(2):
                for j in range(k):
                    h = _dot(V[j], w)
                    H[j, k - 1] += h
                    w = w - h * V[j]
            hk = _norm(w)
            # (a Krylov space of the whole dimension: the next vector is zero, exactly)
            if k >= n:
                hk = 0.0
            H[k, k - 1] = hk
            if hk != 0:
                V[k] = w / hk
            for j in range(k - 1):
                t = cs[j] * H[j, k - 1] + sn[j] * H[j + 1, k - 1]
                H[j + 1, k - 1] = -np.conj(sn[j]) * H[j, k - 1] + cs[j] * H[j + 1, k - 1]
                H[j, k - 1] = t
            a, c = H[k - 1, k - 1], H[k, k - 1]
            den = _math.hypot(abs(a), abs(c))
            if den == 0:
                flag, done = 4, True
                k -= 1
                break
            cs[k - 1] = abs(a) / den
            sn[k - 1] = (a / abs(a) if a != 0 else 1.0) * np.conj(c) / den
            H[k - 1, k - 1] = cs[k - 1] * a + sn[k - 1] * c
            H[k, k - 1] = 0
            g[k] = -np.conj(sn[k - 1]) * g[k - 1]
            g[k - 1] = cs[k - 1] * g[k - 1]
            est = abs(g[k])
            resvec.append(est)
            if est <= tolb or hk == 0:
                break
        if k > 0:
            y = np.zeros(k, dtype=dt)
            for i in range(k - 1, -1, -1):
                y[i] = (g[i] - np.dot(H[i, i + 1:k], y[i + 1:k])) / H[i, i]
            if not _finite(y):
                flag = 4
                break
            step = y @ V[:k]
            stagnant = _norm(step) < _EPS * _norm(x)
            x = x + step
        else:
            stagnant = False
        r = M.solve(b - op.times(x))
        if r is None:
            flag = 2
            break
        normr = _norm(r)
        if normr <= tolb:
            return x, 0, normr / n2b, [o, k], resvec, [o, k]
        if normr < normrmin:
            xmin, normrmin, itmin = x.copy(), normr, [o, k]
        if done:
            break
        if stagnant:
            flag = 3
            break
    r = M.solve(b - op.times(xmin))
    relres = _norm(r) / n2b if r is not None else normrmin / n2b
    return xmin, flag, relres, itmin, resvec, stop


def _gmres_inner(n, restart, maxit):
    """(inner iterations per cycle, outer cycles) from gmres's restart and maxit, as its page gives them"""
    if restart is not None and restart > n:
        restart = n
    if restart is None or restart == n:
        return (min(n, 10) if maxit is None else min(maxit, n)), 1
    return restart, (min(-(-n // restart), 10) if maxit is None else maxit)


def _gmres_work(n, restart, maxit):
    """gmres's work: its Krylov basis, a vector for each inner iteration and one more, besides the short
    recurrences' vectors; and the Hessenberg matrix's elements"""
    inner = max(_gmres_inner(n, restart, maxit)[0], 1)
    return inner + 1 + _SHORT, (inner + 1) * (inner + 4)


@_bi("gmres")
def gmres_(nargout, *args):
    """[x, flag, relres, iter, resvec] = gmres(A, b, restart, tol, maxit, M1, M2, x0): the generalized minimum
    residual method, restarted every restart inner iterations ([] or size(A,1): never), left preconditioned by
    M = M1*M2; tol 1e-6; maxit outer iterations, min(ceil(size(A,1)/restart), 10) by default, or min(size(A,1), 10)
    iterations without restarts; iter is [outer inner], and relres and resvec are of the preconditioned residual"""
    op, b, tol, maxit, restart, M, x0, m, n, cplx = _setup("gmres", nargout, args, _gmres_work, restart=True)
    if restart is not None and restart > n:
        _m.warning_("Number of inner iterations before restart is %d but should be bounded by size(A,1). "
                    "Setting the number of inner iterations to %d." % (restart, n), "MATLAB:gmres:tooManyInnerItsRestart")
        restart = n
    inner, outer = _gmres_inner(n, restart, maxit)
    # (maxit 0 without restarts: no iteration at all)
    x, flag, relres, it, resvec, stop = _gmres(op, b, tol, max(inner, 1), outer if inner else 0, M, x0, n)
    if nargout < 2:
        if flag == 0:
            _m._write("gmres converged at outer iteration %d (inner iteration %d) to a solution with relative "
                      "residual %.2g.\n" % (it[0], it[1], relres))
        else:
            _m._write("gmres stopped at outer iteration %d (inner iteration %d) without converging to the desired "
                      "tolerance %.2g\nbecause %s.\nThe iterate returned (number %d(%d)) has relative residual %.2g.\n"
                      % (stop[0], stop[1], tol, _REASONS[flag], it[0], it[1], relres))
    return _outputs(nargout, x, flag, relres, _m._unmat(np.array([[float(it[0]), float(it[1])]])), resvec)


# ------------------------------------------------------------------ bicgstab

def _bicgstab(op, b, tol, maxit, M, x0):
    """BiCGSTAB (van der Vorst), right preconditioned: two half iterations a step, each with its residual"""
    n2b = _norm(b)
    if n2b == 0:
        return np.zeros_like(x0), 0, 0.0, 0, [0.0], 0
    x = x0.copy()
    r = b - op.times(x)
    normr = _norm(r)
    resvec = [normr]
    tolb = tol * n2b
    if normr <= tolb:
        return x, 0, normr / n2b, 0, resvec, 0
    rt = r.copy()
    xmin, normrmin, imin = x.copy(), normr, 0
    flag, rho, alpha, omega, stag = 1, 1.0, 1.0, 1.0, 0
    p = v = None
    stop = 0
    for ii in range(1, maxit + 1):
        stop = ii
        rho1, rho = rho, _dot(rt, r)
        if rho == 0 or not _finite(rho):
            flag = 4
            break
        if ii == 1:
            p = r
        else:
            beta = (rho / rho1) * (alpha / omega)
            if beta == 0 or not _finite(beta):
                flag = 4
                break
            p = r + beta * (p - omega * v)
        ph = M.solve(p)
        if ph is None:
            flag = 2
            break
        v = op.times(ph)
        rtv = _dot(rt, v)
        if rtv == 0 or not _finite(rtv):
            flag = 4
            break
        alpha = rho / rtv
        if not _finite(alpha):
            flag = 4
            break
        stag = stag + 1 if _norm(ph) * abs(alpha) < _EPS * _norm(x) else 0
        xhalf = x + alpha * ph
        s = r - alpha * v
        normr = _norm(s)
        resvec.append(normr)
        if normr <= tolb or stag >= _STAG_STEPS:
            normr = _norm(b - op.times(xhalf))
            resvec[-1] = normr
            if normr <= tolb:
                return xhalf, 0, normr / n2b, ii - 0.5, resvec, ii - 0.5
        if normr < normrmin:
            xmin, normrmin, imin = xhalf.copy(), normr, ii - 0.5
        if stag >= _STAG_STEPS:
            flag, stop = 3, ii - 0.5
            break
        sh = M.solve(s)
        if sh is None:
            flag, stop = 2, ii - 0.5
            break
        t = op.times(sh)
        tt = np.real(_dot(t, t))
        if tt == 0 or not _finite(tt):
            flag = 4
            break
        omega = _dot(t, s) / tt
        if omega == 0 or not _finite(omega):
            flag = 4
            break
        stag = stag + 1 if _norm(sh) * abs(omega) < _EPS * _norm(xhalf) else 0
        x = xhalf + omega * sh
        r = s - omega * t
        normr = _norm(r)
        resvec.append(normr)
        if normr <= tolb or stag >= _STAG_STEPS:
            r = b - op.times(x)
            normr = _norm(r)
            resvec[-1] = normr
            if normr <= tolb:
                return x, 0, normr / n2b, ii, resvec, ii
        if normr < normrmin:
            xmin, normrmin, imin = x.copy(), normr, ii
        if stag >= _STAG_STEPS:
            flag = 3
            break
    return xmin, flag, _norm(b - op.times(xmin)) / n2b, imin, resvec, stop


@_bi("bicgstab")
def bicgstab_(nargout, *args):
    """[x, flag, relres, iter, resvec] = bicgstab(A, b, tol, maxit, M1, M2, x0): the biconjugate gradients
    stabilized method, right preconditioned by M = M1*M2; tol 1e-6 and maxit min(size(A,1), 20) by default; iter
    and resvec count half iterations"""
    op, b, tol, maxit, _, M, x0, m, n, cplx = _setup("bicgstab", nargout, args, lambda n, r, k: (_SHORT, 0))
    maxit = min(n, 20) if maxit is None else maxit
    x, flag, relres, it, resvec, stop = _bicgstab(op, b, tol, maxit, M, x0)
    if nargout < 2:
        _report("bicgstab", flag, relres, it, stop, tol)
    return _outputs(nargout, x, flag, relres, it, resvec)


# ------------------------------------------------------------------ lsqr

def _lsqr(op, b, tol, maxit, M, x0):
    """LSQR (Paige and Saunders): Golub-Kahan bidiagonalization of A*inv(M), right preconditioned; converged when
    norm(b - A*x)/norm(b) or the scaled normal-equations residual meets tol"""
    n2b = _norm(b)
    if n2b == 0:
        return np.zeros_like(x0), 0, 0.0, 0, [0.0], [], 0
    x = x0.copy()
    u = b - op.times(x)
    beta = _norm(u)
    resvec, lsvec = [beta], []
    tolb = tol * n2b
    if beta <= tolb:
        return x, 0, beta / n2b, 0, resvec, lsvec, 0
    u = u / beta
    v = M.csolve(op.ctimes(u))
    if v is None:
        return x, 2, beta / n2b, 0, resvec, lsvec, 0
    alpha = _norm(v)
    if alpha != 0:
        v = v / alpha
    w = v.copy()
    phibar, rhobar = beta, alpha
    anorm2 = 0.0
    xmin, normrmin, imin = x.copy(), beta, 0
    flag, stag, ii = 1, 0, 0
    for ii in range(1, maxit + 1):
        if alpha == 0:
            # (A'*r is zero: x already solves the least-squares problem)
            return x, 0, _norm(b - op.times(x)) / n2b, ii - 1, resvec, lsvec, ii - 1
        z = M.solve(v)
        if z is None:
            flag = 2
            break
        u = op.times(z) - alpha * u
        beta = _norm(u)
        if beta != 0:
            u = u / beta
        anorm2 += alpha * alpha + beta * beta
        vv = M.csolve(op.ctimes(u))
        if vv is None:
            flag = 2
            break
        v = vv - beta * v
        alpha = _norm(v)
        if alpha != 0:
            v = v / alpha
        rho = _math.hypot(rhobar, beta)
        if rho == 0 or not _math.isfinite(rho):
            flag = 4
            break
        c, s = rhobar / rho, beta / rho
        theta = s * alpha
        rhobar = -c * alpha
        phi = c * phibar
        phibar = s * phibar
        d = M.solve(w)
        if d is None:
            flag = 2
            break
        step = (phi / rho) * d
        stag = stag + 1 if _norm(step) < _EPS * _norm(x) else 0
        x = x + step
        w = v - (theta / rho) * w
        normr = abs(phibar)
        normar = abs(phibar * alpha * c)
        ls = normar / _math.sqrt(anorm2) if anorm2 > 0 else 0.0
        resvec.append(normr)
        lsvec.append(ls)
        if normr <= tolb or ls <= tol or stag >= _STAG_STEPS:
            true = _norm(b - op.times(x))
            resvec[ii] = true
            if true <= tolb or ls <= tol:
                return x, 0, true / n2b, ii, resvec, lsvec, ii
            normr = true
        if normr < normrmin:
            xmin, normrmin, imin = x.copy(), normr, ii
        if stag >= _STAG_STEPS:
            flag = 3
            break
    return xmin, flag, _norm(b - op.times(xmin)) / n2b, imin, resvec, lsvec, ii


@_bi("lsqr")
def lsqr_(nargout, *args):
    """[x, flag, relres, iter, resvec, lsvec] = lsqr(A, b, tol, maxit, M1, M2, x0): least squares by LSQR for any
    m-by-n A, a matrix or a function handle afun(x, 'notransp') = A*x, afun(x, 'transp') = A'*x; right
    preconditioned by an n-by-n M = M1*M2; tol 1e-6 and maxit min(size(A,1), 20) by default (the page's); lsvec the
    estimates of norm((A*inv(M))'*(b - A*x))/norm(A*inv(M), 'fro'), one each iteration"""
    op, b, tol, maxit, _, M, x0, m, n, cplx = _setup("lsqr", nargout, args, lambda n, r, k: (_SHORT, 0), square=False,
                                                      nout=6)
    maxit = min(m, 20) if maxit is None else maxit
    x, flag, relres, it, resvec, lsvec, stop = _lsqr(op, b, tol, maxit, M, x0)
    if nargout < 2:
        _report("lsqr", flag, relres, it, stop, tol)
    return _outputs(nargout, x, flag, relres, it, resvec, extra=[_col(np.array(lsvec, dtype=np.float64))])
