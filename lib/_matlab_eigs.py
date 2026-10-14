"""MATLAB's eigs, for lib/_matlab.py: a few eigenvalues (and eigenvectors) of
a matrix or of an operator given as a function, by a direct (thick)
Ritz-vector restarted Arnoldi method, the Lanczos form when the operator is
Hermitian.  The Arnoldi extension and the Ritz estimate follow Lehoucq and
Sorensen ("Deflation techniques for an implicitly re-started Arnoldi
iteration", Rice University CAAM TR94-13, 1994, revised 1995, sections 2
and 3); the restart is Sagebrush's own, which under the stated hypotheses
retains the wanted range their exact-shift restart retains.  There is no
locking or deflation, and none of the paper's guarantees for them or for
multiple eigenvalues is claimed.  The interface is the eigs documentation
page's; what neither the paper nor the page fixes is Sagebrush's own choice
and says so.
"""

import math as _math

import numpy as np

import _matlab as _m
import _matlab_sparse as _sp
from _matlab import _bi, _err, _istext, _text

_EPS = 2.220446049250313e-16

# (the sigma words, with their names before R2017a, as the page's table
# lists them)
_SIGMAS = {"largestabs": "largestabs", "lm": "largestabs", "smallestabs": "smallestabs", "sm": "smallestabs",
           "largestreal": "largestreal", "lr": "largestreal", "la": "largestreal",
           "smallestreal": "smallestreal", "sr": "smallestreal", "sa": "smallestreal",
           "bothendsreal": "bothendsreal", "be": "bothendsreal",
           "largestimag": "largestimag", "smallestimag": "smallestimag", "bothendsimag": "bothendsimag"}
# ('li' is 'largestimag' for a complex A and 'bothendsimag' for a real one,
# and 'si' is 'smallestimag' for a complex A, as the page's table says)

# (the options structure's fields and the name-value names, as the page's
# table pairs them)
_OPTION_FIELDS = {"issym": "IsFunctionSymmetric", "tol": "Tolerance", "maxit": "MaxIterations",
                  "p": "SubspaceDimension", "v0": "StartVector", "disp": "Display", "fail": "FailureTreatment",
                  "spdb": "IsSymmetricDefinite", "cholb": "IsCholesky", "permb": "CholeskyPermutation"}
_OPTION_NAMES = {v.lower(): v for v in _OPTION_FIELDS.values()}


def _is_matrix(v):
    return type(v) is _m.Sparse or (_m._isnumlike(v) and type(v) is not _m.Char)


class _Matrix:
    """A (full or sparse) as products and solves"""

    def __init__(self, v):
        self.sparse = type(v) is _m.Sparse
        if self.sparse:
            self.S = v
            self.n = v.n
            self.cols = _sp._cols(v)
            self.vals = _sp._fvals(v)
            self.cplx = self.vals.dtype.kind == "c"
        else:
            self.A = np.array(_m._mat(v))
            if self.A.dtype.kind not in "fc":
                self.A = self.A.astype(float)
            self.n = self.A.shape[1]
            self.cplx = self.A.dtype.kind == "c"

    def times(self, x):
        if not self.sparse:
            return self.A @ x
        prod = self.vals * x[self.cols]
        if prod.dtype.kind == "c":
            return (np.bincount(self.S.ir, weights=prod.real, minlength=self.S.m)
                    + 1j * np.bincount(self.S.ir, weights=prod.imag, minlength=self.S.m))
        return np.bincount(self.S.ir, weights=prod, minlength=self.S.m)

    def hermitian(self):
        if self.sparse:
            return _m._logical_val(_m._B["ishermitian"].f(1, self.S))
        return bool(np.array_equal(self.A, np.conj(self.A.T)))

    def shifted_solver(self, sigma, B=None):
        """x -> (A - sigma*B) \\ x, B the identity when None; an error when the
        shifted matrix is singular, as the page says (sigma may not be an
        eigenvalue)"""
        if self.sparse or (B is not None and B.sparse):
            Bs = B.S if B is not None and B.sparse else (_sp.from_full(_m._unmat(B.A)) if B is not None else None)
            n = self.n
            if Bs is None:
                rows = np.concatenate([self.S.ir, np.arange(n)])
                cols = np.concatenate([self.cols, np.arange(n)])
                vals = np.concatenate([self.vals.astype(complex if isinstance(sigma, complex) or self.cplx else float),
                                       -sigma * np.ones(n)])
                M = _sp.make(n, n, rows, cols, vals)
            else:
                As = self.S if self.sparse else _sp.from_full(_m._unmat(self.A))
                M = _sp.binop("minus", As, _sp.binop("times", sigma, Bs)) if sigma != 0 else As
            F = _sp._sparse_lu(M)
            if F.singular:
                raise _err("eigs: the shifted operator A - sigma*B is singular; sigma may not be an eigenvalue. "
                           "Use a sigma near the eigenvalue instead.")
            return lambda x: F.solve(x.reshape((-1, 1))).reshape(-1)
        M = self.A - sigma * (np.eye(self.n) if B is None else B.A)
        lu = _dense_lu(M) if np.all(np.isfinite(M)) else None
        if lu is None:
            raise _err("eigs: the shifted operator A - sigma*B is singular; sigma may not be an eigenvalue. "
                       "Use a sigma near the eigenvalue instead.")
        return lambda x: _lu_solve(lu, x)


def _dense_lu(M):
    """P M = L U by Gaussian elimination with partial pivoting, as
    (perm, LU), or None when a pivot is exactly zero (M singular); a matrix
    of tiny but nonzero numbers is not singular"""
    n = M.shape[0]
    U = np.array(M, dtype=float)
    perm = np.arange(n)
    for j in range(n):
        p = j + int(np.argmax(np.abs(U[j:, j])))
        if U[p, j] == 0:
            return None
        if p != j:
            U[[j, p], :] = U[[p, j], :]
            perm[[j, p]] = perm[[p, j]]
        if j + 1 < n:
            U[j + 1:, j] /= U[j, j]
            U[j + 1:, j + 1:] -= np.outer(U[j + 1:, j], U[j, j + 1:])
    return perm, U


def _lu_solve(lu, b):
    perm, U = lu
    n = U.shape[0]
    x = np.array(b, dtype=float)[perm]
    for i in range(1, n):
        x[i] -= U[i, :i] @ x[:i]
    for i in range(n - 1, -1, -1):
        x[i] = (x[i] - U[i, i + 1:] @ x[i + 1:]) / U[i, i]
    return x


def _wanted(theta, k, kind, shift_invert):
    """the indices of the k wanted Ritz values theta, best first: by the
    page's sigma (for shift-invert, the largest |theta|, the eigenvalues
    nearest sigma)"""
    idx = np.arange(len(theta))
    if shift_invert or kind == "largestabs":
        key = -np.abs(theta)
    elif kind == "largestreal":
        key = -theta.real
    elif kind == "smallestreal":
        key = theta.real
    elif kind == "largestimag":
        key = -theta.imag
    elif kind == "smallestimag":
        key = theta.imag
    elif kind in ("bothendsreal", "bothendsimag"):
        part = theta.real if kind == "bothendsreal" else theta.imag
        hi = list(idx[np.argsort(-part, kind="stable")])
        lo = list(idx[np.argsort(part, kind="stable")])
        out = []
        # (k/2 from each end, the one more from the high end, as the page says)
        while len(out) < k and (hi or lo):
            for src in ((hi, lo) if len(out) % 2 == 0 else (lo, hi)):
                while src and src[0] in out:
                    src.pop(0)
                if src and len(out) < k:
                    out.append(src.pop(0))
                    break
        return out
    else:
        raise _err("eigs: unknown sigma '%s'." % kind)
    return list(idx[np.argsort(key, kind="stable")][:k])


def _start_vector(n, given, cplx):
    if given is not None:
        v = np.array(_m._arr(given)).reshape(-1).astype(complex if cplx or np.iscomplexobj(_m._arr(given)) else float)
        if v.size != n:
            raise _err("eigs: StartVector must have n elements.")
        if not np.any(v):
            raise _err("eigs: StartVector must not be zero.")
        return v
    # (Sagebrush's own reproducible start: its own fixed stream, which the
    # global random state does not affect, as the page says of eigs's)
    rng = np.random.default_rng(20171)
    v = rng.standard_normal(n)
    return v.astype(complex) if cplx else v


def _arnoldi(op, V, H, j0, m, hermitian, inner):
    """extend an Arnoldi factorization A V_j = V_j H_j + f e_j' from length
    j0 to m (the paper's Algorithm 2.1), with one step of
    reorthogonalization at each step, as section 2 says some form of it is
    needed (classical Gram-Schmidt applied twice, Sagebrush's choice); a
    breakdown (an invariant subspace) continues with a new direction
    orthogonal to V, with a zero subdiagonal"""
    n = V.shape[0]
    for j in range(j0, m):
        w = op(V[:, j])
        h = inner(V[:, :j + 1], w)
        w = w - V[:, :j + 1] @ h
        h2 = inner(V[:, :j + 1], w)
        w = w - V[:, :j + 1] @ h2
        h = h + h2
        beta = _math.sqrt(max(float(np.real(inner(w.reshape((-1, 1)), w)[0])), 0.0))
        H[:j + 1, j] = h
        if beta <= 10 * _EPS * max(float(np.linalg.norm(h)), 1e-300):
            # (an invariant subspace: a new direction, the subdiagonal 0)
            rng = np.random.default_rng(1000 + j)
            for _ in range(3):
                w = rng.standard_normal(n).astype(V.dtype)
                w = w - V[:, :j + 1] @ inner(V[:, :j + 1], w)
                w = w - V[:, :j + 1] @ inner(V[:, :j + 1], w)
                nw = _math.sqrt(max(float(np.real(inner(w.reshape((-1, 1)), w)[0])), 0.0))
                if nw > 0:
                    break
            V[:, j + 1] = w / nw
            H[j + 1, j] = 0.0
        else:
            V[:, j + 1] = w / beta
            H[j + 1, j] = beta


def _ritz(Hm, hermitian):
    if hermitian:
        T = (Hm + np.conj(Hm.T)) / 2
        theta, Y = np.linalg.eigh(T)
        return theta.astype(complex), Y
    theta, Y = np.linalg.eig(Hm)
    Y = Y / np.linalg.norm(Y, axis=0)
    return theta.astype(complex), Y


def _restart_basis(theta, Y, kept, hermitian, real_arith):
    """an orthonormal basis W of the wanted Ritz vectors of H_m (their real
    and imaginary parts for a real problem's complex pairs, each pair once,
    so that the columns are independent)"""
    if hermitian:
        W = np.real(Y[:, kept]) if real_arith else Y[:, kept]
        W, _ = np.linalg.qr(W)
        return W
    cols, taken = [], []
    for i in kept:
        y = Y[:, i]
        if real_arith:
            if any(abs(np.conj(theta[i]) - theta[t]) <= 1e-8 * max(abs(theta[i]), 1.0) for t in taken):
                continue
            taken.append(i)
            cols.append(np.real(y))
            if np.any(np.abs(np.imag(y)) > 0):
                cols.append(np.imag(y))
        else:
            cols.append(y)
    W, _ = np.linalg.qr(np.array(cols).T)
    return W


def _restart(V, H, m, W):
    """Sagebrush's direct (thick) restart with the wanted Ritz vectors: with
    W from _restart_basis, A V_m W = V_m W T + v_{m+1} beta_m (e_m' W) up to
    the Ritz vectors' own residual, T = W' H_m W, so the factorization goes
    on from V_m W, with v_{m+1} next and beta_m (e_m' W) as the row below
    T.  Under the paper's hypotheses (section 3) this is the range its
    implicit restart with the unwanted Ritz values as exact shifts keeps.
    Returns the length kept"""
    keep = W.shape[1]
    Hm = H[:m, :m]
    T = np.conj(W.T) @ Hm @ W
    b = H[m, m - 1] * W[m - 1, :]
    vnext = V[:, m].copy()
    V[:, :keep] = V[:, :m] @ W
    V[:, keep] = vnext
    H[:, :] = 0.0
    H[:keep, :keep] = T
    H[keep, :keep] = b
    return keep


@_bi("eigs")
def eigs_(nargout, *args):
    """eigs as its documentation page describes it: d = eigs(A),
    eigs(A, k), eigs(A, k, sigma), with name-value options or an options
    structure, eigs(A, B, ...) for A*V = B*V*D, eigs(Afun, n, ...) for an
    operator given as a function, and [V, D] and [V, D, flag].  sigma is a
    number (the eigenvalues nearest it, by shift-invert: the largest of
    (A - sigma*B) \\ B) or one of the page's words ('largestabs' by
    default, 'smallestabs' = 0, 'largestreal', 'smallestreal',
    'bothendsreal', 'largestimag', 'smallestimag', 'bothendsimag', and
    their names before R2017a).  The options are the page's: Tolerance
    (1e-14), MaxIterations (300), SubspaceDimension (max(2k, 20), at least
    k+1, or k+2 when not Hermitian), StartVector, FailureTreatment
    ('replacenan', 'keep' or 'drop'), Display, IsFunctionSymmetric,
    IsSymmetricDefinite, IsCholesky and CholeskyPermutation.  d is sorted
    as the page's table says; V's columns have 2-norm 1, or B-norm 1 when B
    is symmetric positive definite.

    The method is a direct (thick) Ritz-vector restarted Arnoldi method,
    the Lanczos form when the operator is Hermitian: the Arnoldi extension
    (Algorithm 2.1 with reorthogonalization) and the Ritz estimate (2.2)
    ||f|| |e_m' y| follow Lehoucq and Sorensen (TR94-13, sections 2-3); the
    restart (_restart) is Sagebrush's own, which retains, under the stated
    hypotheses, the wanted range an exact-shift restart retains.  With B
    symmetric positive definite the inner product is B's, so that B \\ A is
    self-adjoint.

    Sagebrush's own choices, where neither the paper nor the page fixes
    them: a Ritz value has converged when its estimate is at most Tolerance
    times max(|theta|, eps*||H||) and its actual residual is too (or is at
    rounding level, 100*eps*||H||); a real problem's complex pair is kept
    whole at a restart; when no restart fits the subspace the values and
    vectors of the current basis are returned; the start vector comes from
    Sagebrush's own fixed stream; the operator's dense eigenvalues are used
    when the subspace would be the whole space (SubspaceDimension >= n); a
    single A, B, StartVector or Afun result is computed in double and
    returned as single; a numeric sigma's values come nearest first, an
    order the page leaves open; a large sparse B (over 2000 rows) needs
    IsSymmetricDefinite, since Sagebrush cannot check it; the messages and
    the Display format are Sagebrush's.  The imaginary-part sigmas are
    refused for a Hermitian problem.  Complex matrices, shifts and start vectors are
    refused: Sagebrush's numpy has no complex eigenvalue or QR routines
    yet"""
    args = list(args)
    if not args:
        raise _err("Not enough input arguments.")
    if nargout > 3:
        raise _err("Too many output arguments.")
    # (A, or Afun and n)
    if _m._iscallable(args[0]) or _istext(args[0]):
        if len(args) < 2:
            raise _err("eigs: a function Afun needs the size n as the second input.")
        afun = _m._fn_arg(args[0])
        nv = args[1]
        if not _m._isnumlike(nv) or _m._numel(nv) != 1 or not _m._scalar(nv) >= 1 or _m._scalar(nv) != _math.floor(_m._scalar(nv)):
            raise _err("eigs: n must be a positive integer.")
        n = int(_m._scalar(nv))
        A = None
        args = args[2:]
    else:
        if not _is_matrix(args[0]):
            raise _err("eigs: the first input must be a square matrix or a function handle.")
        Av = args.pop(0)
        d = _m._dims(Av)
        if len(d) != 2 or d[0] != d[1]:
            raise _err("eigs: A must be a square matrix.")
        A = _Matrix(Av)
        n = A.n
        afun = None
    single = A is not None and _m.class_(Av) == "single"
    # (B: a matrix in the next place, before k; [] for none)
    B = None
    if args and _is_matrix(args[0]) and (_m._numel(args[0]) != 1 or type(args[0]) is _m.Sparse):
        # (a matrix before k is B; [] is no B, as the page says for a scalar A)
        Bv = args.pop(0)
        if _m._numel(Bv) != 0:
            if _m._dims(Bv) != (n, n):
                raise _err("eigs: B must be a square matrix the size of A.")
            B = _Matrix(Bv)
            single = single or _m.class_(Bv) == "single"
    k = 6
    if args and _m._isnumlike(args[0]) and type(args[0]) is not _m.Char:
        kv = args.pop(0)
        if _m._numel(kv) != 1 or np.iscomplexobj(_m._arr(kv)) or not _m._scalar(kv) >= 1 \
                or _m._scalar(kv) != _math.floor(_m._scalar(kv)):
            raise _err("eigs: k must be a positive integer.")
        k = int(_m._scalar(kv))
    k = min(k, n)
    kind, sigma = "largestabs", None
    if args and (_istext(args[0]) or (_m._isnumlike(args[0]) and type(args[0]) is not _m.Char)) \
            and not (_istext(args[0]) and _text(args[0]).lower() in _OPTION_NAMES):
        sv = args.pop(0)
        if _istext(sv):
            word = _text(sv).lower()
            real_a = not (A is not None and A.cplx)
            if word == "li":
                kind = "bothendsimag" if real_a else "largestimag"
            elif word == "si" and not real_a:
                kind = "smallestimag"
            elif word not in _SIGMAS:
                raise _err("eigs: unknown sigma '%s'%s." % (_text(sv), " (for a real A, 'si' is not one of the page's names)"
                                                             if word == "si" else ""))
            else:
                kind = _SIGMAS[word]
            if kind == "smallestabs":
                sigma = 0.0
        else:
            if _m._numel(sv) != 1:
                raise _err("eigs: a numeric sigma must be a scalar.")
            s = _m._arr(sv).reshape(-1)[0]
            sigma = complex(s) if np.iscomplexobj(s) and s.imag != 0 else float(np.real(s))
            kind = "sigma"
    # (options: a structure, or name-value pairs)
    opts = {}
    if args and type(args[0]) is _m.Struct:
        st = args.pop(0)
        for f, v in st.a[0].items():
            if f.lower() not in _OPTION_FIELDS:
                raise _err("eigs: unknown option field '%s'." % f)
            opts[_OPTION_FIELDS[f.lower()]] = v
    if len(args) % 2:
        raise _err("eigs: name-value arguments must come in pairs.")
    for i in range(0, len(args), 2):
        if not _istext(args[i]) or _text(args[i]).lower() not in _OPTION_NAMES:
            raise _err("eigs: unknown option%s." % (" '%s'" % _text(args[i]) if _istext(args[i]) else ""))
        opts[_OPTION_NAMES[_text(args[i]).lower()]] = args[i + 1]

    def flag_opt(name):
        return name in opts and bool(_m._logical_val(opts[name]))

    def num_opt(name, default, integer):
        if name not in opts:
            return default
        v = opts[name]
        if _istext(v) or not _m._isnumlike(v) or _m._numel(v) != 1 or np.iscomplexobj(_m._arr(v)):
            raise _err("eigs: %s must be a real scalar." % name)
        x = float(_m._scalar(v))
        if not x > 0 or (integer and x != _math.floor(x)):
            raise _err("eigs: %s must be a positive %s." % (name, "integer" if integer else "number"))
        return x
    # (single precision from the page's data arguments: A, B, StartVector,
    # or for Afun the class of its result, checked by one call)
    if "StartVector" in opts and _m.class_(opts["StartVector"]) == "single":
        single = True
    if A is None and not single:
        probe = _m._call(afun, [_m._unmat(_start_vector(n, opts.get("StartVector"), False).reshape((-1, 1)))])
        single = _m.class_(probe) == "single"
    tol = num_opt("Tolerance", 1e-6 if single else 1e-14, False)
    maxit = int(num_opt("MaxIterations", 300, True))
    fail = _text(opts["FailureTreatment"]).lower() if "FailureTreatment" in opts and _istext(opts["FailureTreatment"]) else "replacenan"
    if fail not in ("replacenan", "keep", "drop"):
        raise _err("eigs: FailureTreatment must be 'replacenan', 'keep' or 'drop'.")
    display = flag_opt("Display")
    if flag_opt("IsCholesky") and B is not None:
        # (B given as R with B = R'*R, or B(p, p) = R'*R)
        R = B
        Rd = R.A if not R.sparse else np.array(_m._mat(_sp.full(R.S)))
        Bd = np.conj(Rd.T) @ Rd
        if "CholeskyPermutation" in opts:
            p = np.array(_m._arr(opts["CholeskyPermutation"])).reshape(-1).astype(int) - 1
            Bf = np.zeros_like(Bd)
            Bf[np.ix_(p, p)] = Bd
            Bd = Bf
        B = _Matrix(_m._unmat(Bd))
    if (A is not None and A.cplx) or (B is not None and B.cplx) or isinstance(sigma, complex) \
            or ("StartVector" in opts and np.iscomplexobj(_m._arr(opts["StartVector"]))):
        raise _err("eigs: complex matrices, shifts and start vectors are not supported in Sagebrush.")
    # (the operator and the inner product)
    a_herm = flag_opt("IsFunctionSymmetric") if A is None else A.hermitian()
    cplx = (A.cplx if A is not None else False) or (B is not None and B.cplx) or isinstance(sigma, complex)
    b_spd = False
    if B is not None:
        if "IsSymmetricDefinite" in opts:
            b_spd = flag_opt("IsSymmetricDefinite")
        elif B.hermitian():
            b_spd = _spd(B)
            if b_spd is None:
                raise _err("eigs: Sagebrush cannot check whether a sparse B of more than 2000 rows is positive definite; "
                           "set IsSymmetricDefinite to true or false.")
    hermitian = a_herm and (B is None or b_spd) and not isinstance(sigma, complex)
    shift_invert = sigma is not None
    if hermitian and kind in ("largestimag", "smallestimag", "bothendsimag"):
        raise _err("eigs: '%s' is for nonsymmetric problems; a symmetric (Hermitian) problem's eigenvalues are real."
                   % kind)

    def apply_a(x):
        if A is not None:
            return A.times(x)
        r = _m._call(afun, [_m._unmat(x.reshape((-1, 1)))])
        y = np.array(_m._mat(r)).reshape(-1)
        if y.size != n:
            raise _err("eigs: Afun must return a vector of length n.")
        return y
    if B is not None and not shift_invert:
        solveB = B.shifted_solver(0.0)
    if shift_invert and A is not None:
        solve_shift = A.shifted_solver(sigma, B)
    if not shift_invert:
        op = (lambda x: solveB(apply_a(x))) if B is not None else apply_a
    elif A is not None:
        op = (lambda x: solve_shift(B.times(x))) if B is not None else solve_shift
    else:
        # (Afun already applies (A - sigma*B) \\ x, as the page says)
        op = (lambda x: apply_a(B.times(x))) if B is not None else apply_a
    if b_spd:
        inner = lambda W, x: np.conj(W.T) @ B.times(x)
    else:
        inner = lambda W, x: np.conj(W.T) @ x
    m = int(num_opt("SubspaceDimension", max(2 * k, 20), True))
    if m < k + (1 if hermitian else 2) and m < n:
        raise _err("eigs: SubspaceDimension must be at least k+1 (k+2 when the problem is not Hermitian).")
    m = min(m, n)
    dt = complex if cplx else float
    if m >= n or n <= 2:
        theta, X, flag = _dense_ritz(op, n, dt, hermitian, b_spd, A, B, sigma)
        conv = np.ones(len(theta), dtype=bool)
        sel = _wanted(theta, k, kind, shift_invert)
    else:
        v0 = _start_vector(n, opts.get("StartVector"), cplx)
        V = np.zeros((n, m + 1), dtype=dt)
        H = np.zeros((m + 1, m), dtype=dt)
        nv = _math.sqrt(max(float(np.real(inner(v0.reshape((-1, 1)), v0)[0])), 0.0))
        V[:, 0] = v0 / nv
        _arnoldi(op, V, H, 0, m, hermitian, inner)
        it = 0
        while True:
            it += 1
            theta, Y = _ritz(H[:m, :m], hermitian)
            sel = _wanted(theta, k, kind, shift_invert)
            beta = abs(H[m, m - 1])
            est = np.abs(beta * Y[m - 1, :])
            hn = float(np.linalg.norm(H[:m, :m]))
            conv_all = est <= tol * np.maximum(np.abs(theta), _EPS * hn)
            if display:
                _m._write("eigs: iteration %d, %d of %d converged, largest Ritz estimate %.2e\n"
                          % (it, int(np.sum(conv_all[sel])), k, float(np.max(est[sel]))))
            if np.any(conv_all[sel]):
                # (a value the estimate calls converged is checked by its
                # actual residual, to the estimate's tolerance or rounding,
                # 100 eps ||H||: the restart drops the Ritz vectors' own
                # residual, so the estimate can understate it)
                for i in sel:
                    if conv_all[i]:
                        x = V[:, :m] @ Y[:, i]
                        r = op(x) - theta[i] * x
                        rn = _math.sqrt(max(float(np.real(inner(r.reshape((-1, 1)), r)[0])), 0.0))
                        if rn > max(tol * max(abs(theta[i]), _EPS * hn), 100 * _EPS * hn):
                            conv_all[i] = False
            if np.all(conv_all[sel]) or it >= maxit:
                break
            W = _restart_basis(theta, Y, list(sel), hermitian, not cplx)
            if W.shape[1] >= m:
                # (no room left to extend: stop with the values and vectors of
                # this basis, which nothing has changed)
                break
            keep = _restart(V, H, m, W)
            _arnoldi(op, V, H, keep, m, hermitian, inner)
        conv = conv_all
        X = V[:, :m] @ Y
        flag = 0 if np.all(conv[sel]) else 1
    lam = theta[sel]
    conv_sel = conv[sel]
    lam = lam if not shift_invert else sigma + 1.0 / lam
    vecs = X[:, sel]
    if not (cplx or isinstance(sigma, complex)) and hermitian:
        lam = lam.real.astype(complex)
    # (the page's sort for each sigma)
    order = _output_order(lam, kind, k)
    lam, vecs, conv_sel = lam[order], vecs[:, order], conv_sel[order]
    if B is None or not b_spd:
        vecs = vecs / np.where(np.linalg.norm(vecs, axis=0) == 0, 1.0, np.linalg.norm(vecs, axis=0))
    else:
        bn = np.sqrt(np.abs(np.array([np.vdot(vecs[:, j], B.times(vecs[:, j])) for j in range(vecs.shape[1])])))
        vecs = vecs / np.where(bn == 0, 1.0, bn)
    if fail == "replacenan":
        lam = np.where(conv_sel, lam, np.nan)
    elif fail == "drop":
        lam, vecs = lam[conv_sel], vecs[:, conv_sel]
    if flag and nargout < 3:
        _m.warning_("eigs: %d of the %d requested eigenvalues converged." % (int(np.sum(conv_sel)), len(conv_sel)))
    real_out = not np.any(np.abs(np.imag(lam[np.isfinite(lam)])) > 0) if lam.size else True
    if real_out and not cplx and not np.any(np.abs(np.imag(vecs)) > 0):
        lam = lam.real
        vecs = vecs.real
    elif real_out:
        lam = lam.real

    def out(a):
        r = _m._unmat(np.asarray(a))
        return _m._B["single"].f(1, r) if single else r
    if nargout <= 1:
        return out(lam.reshape((-1, 1)))
    res = [out(vecs), out(np.diag(lam)) if lam.size else out(np.zeros((0, 0)))]
    if nargout == 3:
        res.append(float(flag))
    return res


def _spd(B):
    """B symmetric (Hermitian) positive definite: a Cholesky factorization
    of it exists (the dense one, up to 2000 rows; None beyond: Sagebrush's
    own test)"""
    M = B.A if not B.sparse else (np.array(_m._mat(_sp.full(B.S))) if B.n <= 2000 else None)
    if M is None:
        return None
    try:
        np.linalg.cholesky(M)
        return True
    except Exception:
        return False


def _dense_ritz(op, n, dt, hermitian, b_spd, A, B, sigma):
    """the eigenvalues (as the operator's: 1/(lambda - sigma) for
    shift-invert) and vectors when the Krylov space would be the whole space
    (Sagebrush's own choice): a symmetric A with a symmetric positive
    definite B by the Cholesky-reduced symmetric problem L^-1 A L^-T (B =
    L L'), so that V is B-orthonormal; a symmetric A alone by the symmetric
    solver; otherwise from the operator's full matrix"""
    L = None
    if A is not None and hermitian and B is not None and b_spd:
        Bd = B.A if not B.sparse else np.array(_m._mat(_sp.full(B.S)))
        try:
            L = np.linalg.cholesky((Bd + np.conj(Bd.T)) / 2)
        except Exception:
            # (a semidefinite B, which IsSymmetricDefinite allows with a
            # numeric sigma: the shift-invert operator's matrix instead)
            L = None
    if A is not None and hermitian and (B is None or L is not None):
        Ad = A.A if not A.sparse else np.array(_m._mat(_sp.full(A.S)))
        Ad = (Ad + np.conj(Ad.T)) / 2
        if L is not None:
            Li = np.linalg.inv(L)
            C = Li @ Ad @ np.conj(Li.T)
            lam, Y = np.linalg.eigh((C + np.conj(C.T)) / 2)
            X = np.conj(Li.T) @ Y
        else:
            lam, X = np.linalg.eigh(Ad)
        lam = lam.astype(complex)
        if sigma is not None:
            with np.errstate(divide="ignore"):
                theta = 1.0 / (lam - sigma)
        else:
            theta = lam
        return theta, X, 0
    M = np.zeros((n, n), dtype=dt)
    for j in range(n):
        e = np.zeros(n, dtype=dt)
        e[j] = 1.0
        M[:, j] = op(e)
    if hermitian and not b_spd:
        theta, X = np.linalg.eigh((M + np.conj(M.T)) / 2)
        theta = theta.astype(complex)
    else:
        theta, X = np.linalg.eig(M)
        theta = theta.astype(complex)
        if hermitian:
            theta = theta.real.astype(complex)
    return theta, X, 0


def _output_order(lam, kind, k):
    """the page's output order for each sigma"""
    idx = np.arange(len(lam))
    if kind == "largestabs":
        key = -np.abs(lam)
    elif kind in ("smallestabs",):
        key = np.abs(lam)
    elif kind == "largestreal":
        key = -lam.real
    elif kind in ("smallestreal", "bothendsreal"):
        # (the page's table: ascending by real part)
        key = lam.real
    elif kind == "largestimag":
        key = -lam.imag
    elif kind == "smallestimag":
        key = lam.imag
    elif kind == "bothendsimag":
        key = -np.abs(lam.imag)
    else:
        # (a numeric sigma: the order the iteration found them, nearest first)
        return idx
    return idx[np.argsort(key, kind="stable")]
