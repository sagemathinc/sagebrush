"""2-descent through the cubic algebra (curves without rational 2-torsion).

On E: y^2 = f(x) = x^3 - 27 c4 x - 54 c6 (isomorphic to the minimal model)
with f irreducible, A = Q[t]/(f) is a cubic field and the 2-Selmer group is
the subgroup of A(S,2) = {alpha in A*/A*^2 : v_P(alpha) even for P not above
S} (S = {2, 3} and the bad primes) cut out by the local conditions: at each
p in S and at infinity, the image of alpha in (A tensor Q_p)*/squares lies
in the image of E(Q_p)/2E(Q_p) under P -> x(P) - t.

A(S,2) comes from the certified relations of the class group computation
(engine op bnf_relations, every prime above S in its factor base): they
generate the group of factor-base units, so A(S,2) is spanned by their
products with even valuations outside S.  Its dimension is known exactly
(unit rank + 1 + #factor base - rank of the valuations mod 2), and
quadratic characters at auxiliary primes pick a basis of exactly that size.

The local square classes are computed in the components of A tensor Q_p
(from the p-adic roots of f): explicit coordinates for p odd (valuation and
residue character), and for p = 2 coordinates relative to a basis of
L*/L*^2 found with exact square tests.  The cost is polynomial in log |Delta|
(the class group computation dominates), where a search for the BSD
quartics costs about |Delta|^(1/2).
"""

import math as _m
from fractions import Fraction as _F

_K = {2: 400}           # p-adic precision (digits), default 80; doubled on demand
_PREC_BITS = 256        # real roots
_EXTRA_CHARS = 48       # quadratic characters beyond dim A(S,2)


class PrecisionError(ArithmeticError):
    pass


def _K_of(p):
    return _K.get(p, 80)


def _v(n, p):
    """v_p of a nonzero integer."""
    if n == 0:
        raise PrecisionError("valuation of 0")
    v = 0
    while n % p == 0:
        n //= p
        v += 1
    return v


def _vq(x, p):
    x = _F(x)
    return _v(x.numerator, p) - _v(x.denominator, p)


def _legendre(u, p):
    r = pow(u % p, (p - 1) // 2, p)
    return -1 if r == p - 1 else r


# ------------------------------------------------------------------ Q_p

def _qp_coords(x, p, K):
    """Coordinates of the class of x (an integer, x mod p^K) in Q_p*/Q_p*^2:
    [v mod 2, residue character] (p odd) or [v mod 2, -1 part, 5 part]."""
    mod = p ** K
    x %= mod
    if x == 0:
        raise PrecisionError("p-adic zero")
    v = _v(x, p)
    u = x // p ** v
    if p == 2:
        if K - v < 3:
            raise PrecisionError("2-adic precision")
        return [v & 1, int(u % 4 == 3), int(u % 8 in (3, 5))]
    if K - v < 1:
        raise PrecisionError("p-adic precision")
    return [v & 1, int(_legendre(u, p) == -1)]


def _qp_coords_rat(x, p):
    """The same for a nonzero rational."""
    x = _F(x)
    if x == 0:
        raise PrecisionError("zero")
    v = _vq(x, p)
    n, d = x.numerator, x.denominator
    n //= p ** max(v, 0)
    d //= p ** max(-v, 0)
    if p == 2:
        u = (n * d) % 8          # d odd: 1/d = d mod 8
        return [v & 1, int(u % 4 == 3), int(u in (3, 5))]
    return [v & 1, int(_legendre(n * d, p) == -1)]


def _is_square_qp(x, p, K):
    """x mod p^K (an integer) a square in Q_p (0 counts as a square)?"""
    mod = p ** K
    x %= mod
    if x == 0:
        return True
    return not any(_qp_coords(x, p, K))


def _sqrt_zp(x, p, K):
    """A square root of x mod p^K in Q_p, or None (x a p-adic integer,
    given mod p^K; the root is good to about K - v/2 - 3 digits)."""
    mod = p ** K
    x %= mod
    if x == 0:
        return 0
    v = _v(x, p)
    if v & 1:
        return None
    u = x // p ** v
    if p == 2:
        if u % 8 != 1:
            return None
        s = 1
        for k in range(3, K - v):
            if (s * s - u) % (1 << (k + 1)):
                s += 1 << (k - 1)
        return (s << (v // 2)) % mod
    if _legendre(u, p) != 1:
        return None
    # Tonelli-Shanks mod p, then Hensel
    s = _sqrt_mod_p(u % p, p)
    pk = p
    while pk < mod:
        pk = min(pk * pk, mod)
        s = (s - (s * s - u) * pow(2 * s, -1, pk)) % pk
    return (s * p ** (v // 2)) % mod


def _sqrt_mod_p(a, p):
    if p % 4 == 3:
        return pow(a, (p + 1) // 4, p)
    q, s = p - 1, 0
    while q % 2 == 0:
        q //= 2
        s += 1
    z = 2
    while _legendre(z, p) != -1:
        z += 1
    m, c, t, r = s, pow(z, q, p), pow(a, q, p), pow(a, (q + 1) // 2, p)
    while t != 1:
        i, t2 = 0, t
        while t2 != 1:
            t2 = t2 * t2 % p
            i += 1
        b = pow(c, 1 << (m - i - 1), p)
        m, c, t, r = i, b * b % p, t * b * b % p, r * b % p
    return r


def _poly_eval_mod(c, x, mod):
    r = 0
    for ci in reversed(c):
        r = (r * x + ci) % mod
    return r


def _taylor_shift(c, r, p, mod):
    """The coefficients of c(r + p y) mod `mod` (constant first)."""
    n = len(c)
    out = [0] * n
    # c(r + p y) = sum_k (c^(k)(r) / k!) p^k y^k
    pk = 1
    for k in range(n):
        # value of the k-th Taylor coefficient: sum_i binom(i, k) c_i r^(i-k)
        t = 0
        for i in range(n - 1, k - 1, -1):
            t = t * r + _binom(i, k) * c[i]
        out[k] = (t * pk) % mod
        pk *= p
    return out


def _binom(n, k):
    return _m.comb(n, k)


def _panayi(c, p, prec, base, pw, out, want_all, depth=0):
    """The roots in Z_p of the polynomial c (integer coefficients known mod
    p^prec): append base + pw * (root) to out (approximations), or stop at
    the first one unless want_all.  Normalize by the content, take the roots
    mod p: a simple one lifts (Hensel), a multiple one recurses on
    c(r + p y).  Raises PrecisionError when the coefficients run out of
    digits."""
    mod = p ** prec
    c = [x % mod for x in c]
    while len(c) > 1 and c[-1] == 0:
        c.pop()
    nz = [x for x in c if x]
    if not nz:
        raise PrecisionError("p-adic polynomial below the precision")
    m = min(_v(x, p) for x in nz)
    if m:
        c = [x // p ** m for x in c]
        prec -= m
        mod = p ** prec
    if prec <= 2 or depth > 400:
        raise PrecisionError("p-adic root finding")
    dc = [(i * c[i]) for i in range(1, len(c))]
    for r in range(p):
        if _poly_eval_mod(c, r, p):
            continue
        if _poly_eval_mod(dc, r, p):
            if not want_all:
                out.append(base + pw * r)
                return True
            # Newton to full precision
            y = r
            pk = p
            while pk < mod:
                pk = min(pk * pk, mod)
                y = (y - _poly_eval_mod(c, y, pk) * pow(_poly_eval_mod(dc, y, pk), -1, pk)) % pk
            out.append(base + pw * y)
            continue
        g = _taylor_shift(c, r, p, mod)
        if _panayi(g, p, prec, base + pw * r, pw * p, out, want_all, depth + 1) and not want_all:
            return True
    return bool(out)


def _zp_roots(c, p, K):
    """The roots in Z_p of the polynomial c (integer coefficients mod p^K)
    with simple roots, as approximations mod p^(K/2)."""
    out = []
    _panayi(c, p, K, 0, 1, out, True)
    res = []
    for r in out:
        r %= p ** (K // 2)
        if all((r - s) % p ** (K // 4) for s in res):
            res.append(r)
    return res


def _has_root_zp(c, p, K):
    """Does the polynomial c (coefficients mod p^K) have a root in Z_p?"""
    return _panayi(c, p, K, 0, 1, [], False)


# ------------------------------------------------------------------ the cubic algebra

def _mulmod(a, b, A, B):
    """a b in Q[t]/(t^3 + A t + B) (coefficient lists of length 3)."""
    c = [0] * 5
    for i in range(3):
        if a[i]:
            for j in range(3):
                c[i + j] += a[i] * b[j]
    # t^4 = -A t^2 - B t, t^3 = -A t - B
    c[2] -= A * c[4]
    c[1] -= B * c[4]
    c[1] -= A * c[3]
    c[0] -= B * c[3]
    return c[:3]


def _charpoly(b, A, B):
    """(trace, s2, norm) of b0 + b1 t + b2 t^2 in Q[t]/(t^3 + A t + B):
    the characteristic polynomial is x^3 - tr x^2 + s2 x - norm."""
    t = [0, 1, 0]
    cols = [b, _mulmod(b, t, A, B), _mulmod(_mulmod(b, t, A, B), t, A, B)]
    M = [[cols[j][i] for j in range(3)] for i in range(3)]
    tr = M[0][0] + M[1][1] + M[2][2]
    s2 = (M[0][0] * M[1][1] - M[0][1] * M[1][0] + M[0][0] * M[2][2] - M[0][2] * M[2][0]
          + M[1][1] * M[2][2] - M[1][2] * M[2][1])
    det = (M[0][0] * (M[1][1] * M[2][2] - M[1][2] * M[2][1])
           - M[0][1] * (M[1][0] * M[2][2] - M[1][2] * M[2][0])
           + M[0][2] * (M[1][0] * M[2][1] - M[1][1] * M[2][0]))
    return tr, s2, det


_CONTENT_PRIMES = [2, 3, 5, 7]


def _integral(b):
    """b times the square of a common denominator: integer coefficients,
    without square factors of the content at 2, 3, 5, 7 and the primes of S
    (_CONTENT_PRIMES)."""
    d = 1
    for x in b:
        d = d * _F(x).denominator // _m.gcd(d, _F(x).denominator)
    b = [int(_F(x) * d * d) for x in b]
    # and without the square part of the content (it shortens p-adic work)
    g = 0
    for x in b:
        g = _m.gcd(g, x)
    s = 1
    for q in _CONTENT_PRIMES:
        while g % (q * q) == 0:
            g //= q * q
            s *= q * q
    return [x // s for x in b] if s > 1 else b


class _Component:
    """A factor of f over Q_p and the square classes of its field L."""

    def __init__(self, p, K, kind, data, A, B):
        self.p, self.K, self.kind, self.A, self.B = p, K, kind, A, B
        self.mod = p ** K
        if kind == "lin":
            self.r = data
            self.dim = 2 if p != 2 else 3
        elif kind == "quad":
            self.u, self.w = data      # t^2 + u t + w
            self.dim = 2 if p != 2 else 4
            if p != 2:
                D = (self.u * self.u - 4 * self.w) % self.mod
                vD = _v(D, p)
                if vD >= K - 2:
                    raise PrecisionError("quadratic factor")
                k = vD // 2
                self.k = k
                self.Dp = D // p ** (2 * k)          # D = p^(2k) D'
                self.ram = vD & 1
                if self.ram:
                    self.Dpp = self.Dp // p          # D' = p D''
        else:
            self.dim = 2 if p != 2 else 5
        self.basis = None
        if p == 2 and kind != "lin":
            self._find_basis()

    # elements: coefficient lists [b0, b1, b2] over Z (powers of t)
    def _quad_rep(self, b):
        """b reduced mod t^2 + u t + w: (c0, c1) mod p^K."""
        u, w, mod = self.u, self.w, self.mod
        # t^2 = -u t - w
        c0 = (b[0] - w * b[2]) % mod
        c1 = (b[1] - u * b[2]) % mod
        return c0, c1

    def is_square(self, b):
        p, K, mod = self.p, self.K, self.mod
        if self.kind == "lin":
            return _is_square_qp(_poly_eval_mod(b, self.r, mod), p, K)
        if self.kind == "quad":
            c0, c1 = self._quad_rep(b)
            u, w = self.u, self.w
            D = (u * u - 4 * w) % mod
            if c1 == 0:
                # b in Q_p: a square in L iff b or b D is one in Q_p
                if c0 == 0:
                    raise PrecisionError("quadratic component")
                return _is_square_qp(c0, p, K) or _is_square_qp(c0 * D, p, K)
            N = (c0 * c0 - u * c0 * c1 + w * c1 * c1) % mod
            Tr = (2 * c0 - u * c1) % mod
            n = _sqrt_zp(N, p, K)
            if n is None:
                return False
            prec = K - _v(N, p) // 2 - 4
            for s in (n, -n):
                # with b not in Q_p, Tr +- 2 sqrt(N) and their quotient by D
                # are nonzero: below the precision they are undecided
                x, y = (Tr + 2 * s) % p ** prec, ((Tr - 2 * s) * D) % p ** prec
                if x == 0 or y == 0:
                    raise PrecisionError("quadratic component")
                if _is_square_qp(x, p, prec) and _is_square_qp(y, p, prec):
                    return True
            return False
        # the cubic field: b square iff its norm c = C^2 and
        # (X^2 - a)^2 - 8 C X - 4 s2 has a root in Z_p (X = trace of the root)
        a, s2, c = _charpoly(b, self.A, self.B)
        if b[1] == 0 and b[2] == 0:
            return _is_square_qp(b[0], p, K)
        C = _sqrt_zp(c, p, K)
        if C is None:
            return False
        prec = K - _v(c, p) // 2 - 4
        for s in (C, -C):
            q = [(a * a - 4 * s2) % mod, (-8 * s) % mod, (-2 * a) % mod, 0, 1]
            if _has_root_zp(q, p, prec):
                return True
        return False

    def _mul(self, x, y):
        return _mulmod(x, y, self.A, self.B)

    def _norm_fix(self, b):
        """(the Q_2*/Q_2*^2 coordinates of N(b), b times the rational with
        that class): in a cubic L, N(q) = q^3 for rational q, so the norm is
        onto Q_2*/Q_2*^2 and b times the rational has square norm."""
        nc = _qp_coords_rat(_charpoly(b, self.A, self.B)[2], 2)
        q = (2 if nc[0] else 1) * (-1 if nc[1] else 1) * (5 if nc[2] else 1)
        return nc, [x * q for x in b]

    def _centered(self):
        """Elements x - t with x near the roots of the factor (at every
        scale 2^j), and products of two: when the roots are 2-adically close
        to each other, small elements of Z[t] see only the rational square
        classes."""
        mod = self.mod
        if self.kind == "quad":
            # 4 (x - t) with x = (-u + 2^j w) / 2, j up to v(disc)/2 + 6
            D = (self.u * self.u - 4 * self.w) % mod
            jmax = (_v(D, 2) if D else self.K // 2) // 2 + 6
            xs = [(2 * (-self.u + (w << j))) % mod for j in range(0, jmax) for w in (1, 3, -1, -3)]
            base = [[x, -4, 0] for x in xs]
        else:
            # x near a root of f in Z_2[t]/(f): v(f(x)) as large as the digits allow
            f = lambda x: x ** 3 + self.A * x + self.B
            c = 0
            for k in range(40):
                c1 = c + (1 << k)
                if _v(f(c1) or 1 << 200, 2) > _v(f(c) or 1 << 200, 2):
                    c = c1
            jmax = _v(-4 * self.A ** 3 - 27 * self.B ** 2, 2) // 2 + 6
            base = [[c + (w << j), -1, 0] for j in range(0, jmax) for w in (1, 3, -1, -3)]
        out = list(base)
        for i in range(0, len(base), 3):
            for k in range(i + 1, min(len(base), i + 12), 2):
                out.append(_mulmod(base[i], base[k], self.A, self.B))
        return out

    def _find_basis(self):
        """A basis of L*/L*^2 by exact square tests (p = 2).  In the cubic
        case: 2, -1, 5 and two elements of square norm."""
        if self.kind == "cub":
            ks = []
            cands = self._centered() + [[0, 1, 0], [1, 1, 0], [1, 2, 0], [1, 0, 1], [1, 0, 2], [3, 2, 0], [1, 4, 0], [1, 0, 4], [1, 1, 1], [1, 2, 2]]
            cands += _random_elements(400)
            for c in cands:
                if c[1] == 0 and c[2] == 0:
                    continue
                try:
                    _, c2 = self._norm_fix(c)
                    if self._independent(c2, ks):
                        ks.append(c2)
                except PrecisionError:
                    continue
                if len(ks) == 2:
                    self.basis = ks
                    return
            raise ArithmeticError("2-adic square classes of the cubic field: found %d of 2" % len(ks))
        cands = [[2, 0, 0], [-1, 0, 0], [3, 0, 0], [5, 0, 0], [0, 1, 0], [1, 1, 0], [1, 2, 0], [1, 4, 0],
                 [3, 2, 0], [1, 0, 2], [1, 0, 4], [1, 2, 2], [0, 0, 1], [1, 1, 1], [2, 1, 0], [1, 0, 1],
                 [3, 0, 2], [1, 2, 4], [5, 2, 0], [1, 6, 0], [1, 8, 0], [1, 0, 8], [7, 4, 2], [3, 4, 0]]
        cands = self._centered() + cands + _random_elements(400)
        basis = []
        for c in cands:
            if c == [0, 0, 0]:
                continue
            try:
                if self._independent(c, basis):
                    basis.append(c)
            except PrecisionError:
                continue
            if len(basis) == self.dim:
                break
        if len(basis) != self.dim:
            raise ArithmeticError("2-adic square classes: found %d of %d" % (len(basis), self.dim))
        self.basis = basis

    def _independent(self, c, basis):
        for mask in range(1 << len(basis)):
            y = c
            for i, b in enumerate(basis):
                if mask >> i & 1:
                    y = self._mul(y, b)
            if self.is_square(y):
                return False
        return True

    def coords(self, b):
        p, K, mod = self.p, self.K, self.mod
        if self.kind == "lin":
            return _qp_coords(_poly_eval_mod(b, self.r, mod), p, K)
        if p != 2:
            if self.kind == "cub":
                # odd degree, p odd: the norm is an isomorphism on square classes
                return _qp_coords_rat(_charpoly(b, self.A, self.B)[2], p)
            c0, c1 = self._quad_rep(b)
            # b = a + b' sqrt(D'), a = c0 - u c1 / 2, b' = c1 p^k / 2
            inv2 = pow(2, -1, mod)
            a = (c0 - self.u * c1 * inv2) % mod
            bb = (c1 * inv2 * p ** self.k) % mod
            va = _v(a, p) if a else K
            vb = _v(bb, p) if bb else K
            if min(va, vb) >= K - 2:
                raise PrecisionError("quadratic component")
            if not self.ram:
                vL = min(va, vb)
                if 2 * vL >= K - 2:
                    raise PrecisionError("quadratic component")
                N = (a * a - bb * bb * self.Dp) % mod
                u = N // p ** (2 * vL)
                return [vL & 1, int(_legendre(u, p) == -1)]
            if 2 * va <= 2 * vb + 1:
                m = va
                chi = _legendre(a // p ** m, p) * _legendre(self.Dpp, p) ** m
                return [0, int(chi == -1)]
            m = vb
            chi = _legendre(bb // p ** m, p) * _legendre(self.Dpp, p) ** m
            return [1, int(chi == -1)]
        # p = 2: the subset of the basis whose product with b is a square
        if self.kind == "cub":
            nc, b2 = self._norm_fix(b)
            for mask in range(4):
                y = b2
                for i, e in enumerate(self.basis):
                    if mask >> i & 1:
                        y = self._mul(y, e)
                if self.is_square(y):
                    return nc + [mask & 1, mask >> 1 & 1]
            raise ArithmeticError("2-adic square classes: no coordinate vector")
        out = None
        for mask in range(1 << self.dim):
            y = b
            for i, e in enumerate(self.basis):
                if mask >> i & 1:
                    y = self._mul(y, e)
            if self.is_square(y):
                if out is not None:
                    raise ArithmeticError("2-adic square classes: two coordinate vectors")
                out = [mask >> i & 1 for i in range(self.dim)]
        if out is None:
            raise ArithmeticError("2-adic square classes: no coordinate vector")
        return out


class _Local:
    """A tensor Q_p as a product of fields, with coordinates on its square
    classes and the image of E(Q_p)/2E(Q_p)."""

    def __init__(self, p, A, B, K=None):
        self.p = p
        self.A, self.B = A, B
        K = K or _K_of(p)
        self.K = K
        mod = p ** K
        f = [B % mod, A % mod, 0, 1]
        roots = _zp_roots(f, p, K)
        comps = []
        Kc = K // 2
        if len(roots) == 3:
            comps = [_Component(p, Kc, "lin", r, A, B) for r in roots]
        elif len(roots) == 1:
            r = roots[0]
            m2 = p ** Kc
            comps = [_Component(p, Kc, "lin", r, A, B), _Component(p, Kc, "quad", (r % m2, (r * r + A) % m2), A, B)]
        elif not roots:
            comps = [_Component(p, Kc, "cub", None, A, B)]
        else:
            raise ArithmeticError("f has %d roots in Q_%d" % (len(roots), p))
        self.comps = comps
        self.nlin = len(roots)
        self.dim = sum(c.dim for c in comps)
        # dim E(Q_p)/2E(Q_p) = dim E(Q_p)[2] (+1 at 2)
        self.d_image = {0: 0, 1: 1, 3: 2}[self.nlin] + (1 if p == 2 else 0)

    def coords(self, b):
        b = _integral(b)
        out = []
        for c in self.comps:
            out += c.coords(b)
        return out

    def image(self):
        """A basis (as bit masks) of the image of E(Q_p)/2E(Q_p)."""
        p, A, B = self.p, self.A, self.B
        basis = []          # (mask, pivot)
        want = self.d_image
        if want == 0:
            return []
        x0 = 5
        tries = 0
        for x in self._sample_x():
            tries += 1
            if tries > 20000:
                break
            fx = x ** 3 + A * x + B
            if fx == 0:
                continue
            if any(_qp_coords_rat(fx, p)):
                continue
            try:
                v = self.coords([x, -1, 0])
            except PrecisionError:
                continue
            m = _bits(v)
            m = _reduce(m, basis)
            if m:
                basis.append((m, m.bit_length() - 1))
                basis.sort(key=lambda t: -t[1])
                if len(basis) == want:
                    return [t[0] for t in basis]
        raise ArithmeticError("local image at %d: found %d of %d" % (p, len(basis), want))

    def _sample_x(self):
        """Rationals x, p-adically spread: small integers, x / p^(2j), and
        x = c + p^e w around the centre c of each factor's roots (a root in
        Q_p, -u/2 for t^2 + u t + w, an approximate root of a cubic factor)
        at every scale e: when roots are p-adically close, the classes other
        than the trivial one need x that close to them."""
        p = self.p
        rng = 12345
        centres = []
        for c in self.comps:
            if c.kind == "lin":
                centres.append(_F(c.r))
            elif c.kind == "quad":
                centres.append(_F(-c.u, 2))
            else:
                f = lambda x: x ** 3 + self.A * x + self.B
                best = 0
                pk = 1
                for k in range(60):
                    cands = [best + d * pk for d in range(p)]
                    best = max(cands, key=lambda y: _v(f(y), p) if f(y) else 10 ** 6)
                    pk *= p
                centres.append(_F(best))
        for x in range(-50, 51):
            yield _F(x)
        emax = 2 * self.K // 3
        k = 0
        while True:
            k += 1
            rng = (rng * 6364136223846793005 + 1442695040888963407) % (1 << 64)
            n = (rng >> 20) % (p ** 6) - p ** 6 // 2
            j = (rng >> 50) % 4
            yield _F(n, p ** (2 * j))
            for c in centres:
                rng = (rng * 6364136223846793005 + 1442695040888963407) % (1 << 64)
                e = (rng >> 8) % emax
                w = (rng >> 30) % 997 - 498
                m = p ** (e + 4)
                ct = _F(c.numerator * pow(c.denominator, -1, m) % m) if c.denominator % p else c
                yield ct + p ** e * w


def _random_elements(n):
    """Pseudo-random elements of Z[t] (coefficients up to 2^12 times a
    small power of 2): small ones alone can miss square classes when t has
    positive valuation."""
    out = []
    x = 0x9E3779B97F4A7C15
    for _ in range(n):
        c = []
        for _ in range(3):
            x = (x * 6364136223846793005 + 1442695040888963407) % (1 << 64)
            c.append((((x >> 20) % (1 << 13)) - (1 << 12)) << ((x >> 40) % 4))
        if any(c):
            out.append(c)
    return out


def _bits(v):
    m = 0
    for i, x in enumerate(v):
        if x:
            m |= 1 << i
    return m


def _reduce(m, basis):
    for b, piv in basis:
        if m >> piv & 1:
            m ^= b
    return m


def _span_basis(vectors):
    basis = []
    for m in vectors:
        m = _reduce(m, basis)
        if m:
            basis.append((m, m.bit_length() - 1))
            basis.sort(key=lambda t: -t[1])
    return basis


def _real_roots(A, B):
    """The real roots of t^3 + A t + B as Fractions (to _PREC_BITS bits)."""
    f = lambda x: x ** 3 + A * x + B
    # float approximations, then exact bisection on sign changes
    R = 1 + max(abs(A), abs(B)) ** 0.5 + abs(B) ** (1 / 3) + 1
    crit = []
    if A < 0:
        c = (-A / 3) ** 0.5
        crit = [-c, c]
    pts = [-R] + crit + [R]
    out = []
    for lo, hi in zip(pts, pts[1:]):
        lo, hi = _F(lo), _F(hi)
        flo, fhi = f(lo), f(hi)
        if flo == 0:
            out.append(lo)
            continue
        if (flo < 0) == (fhi < 0):
            continue
        for _ in range(_PREC_BITS + int(_m.log2(float(hi - lo) + 1)) + 8):
            mid = (lo + hi) / 2
            fm = f(mid)
            if (fm < 0) == (flo < 0):
                lo, flo = mid, fm
            else:
                hi = mid
            # keep the numbers small
            d = 1 << (_PREC_BITS + 8)
            lo = _F(_m.floor(lo * d), d)
            hi = _F(_m.ceil(hi * d), d)
            flo = f(lo)
        out.append((lo + hi) / 2)
    return out


def _real_coords(b, roots):
    """Signs of b at the real roots (each within 2^-_PREC_BITS relative)."""
    out = []
    for r in roots:
        v = b[0] + b[1] * r + b[2] * r * r
        err = (abs(b[1]) + 2 * abs(b[2]) * (abs(r) + 1)) * (abs(r) + 1) / _F(2) ** (_PREC_BITS - 4)
        if abs(v) <= err:
            raise ArithmeticError("the sign of an element at a real root is below the precision")
        out.append(int(v < 0))
    return out


# ------------------------------------------------------------------ a reduced defining polynomial

def _lll_exact(G):
    """LLL (delta 3/4) of a positive definite Gram matrix with rational
    entries: the transformation U (rows: the new basis over the old)."""
    n = len(G)
    U = [[_F(int(i == j)) for j in range(n)] for i in range(n)]
    def gram(i, j):
        return sum(U[i][a] * G[a][b] * U[j][b] for a in range(n) for b in range(n))
    k = 1
    while k < n:
        # Gram-Schmidt from scratch (n = 3)
        Bs, mu = [], [[_F(0)] * n for _ in range(n)]
        for i in range(n):
            for j in range(i):
                mu[i][j] = (gram(i, j) - sum(mu[j][t] * mu[i][t] * Bs[t] for t in range(j))) / Bs[j]
            Bs.append(gram(i, i) - sum(mu[i][t] ** 2 * Bs[t] for t in range(i)))
        for j in range(k - 1, -1, -1):
            q = round(mu[k][j])
            if q:
                U[k] = [x - q * y for x, y in zip(U[k], U[j])]
                for t in range(j + 1):
                    mu[k][t] -= q * (mu[j][t] if t < j else 1)
        if Bs[k] >= (_F(3, 4) - mu[k][k - 1] ** 2) * Bs[k - 1]:
            k += 1
        else:
            U[k], U[k - 1] = U[k - 1], U[k]
            k = max(k - 1, 1)
    return U


def _reduced_field(A, B):
    """(g, alpha): a defining polynomial g (constant first, monic) of
    Q[t]/(t^3 + A t + B) with small coefficients, and its root alpha as an
    element (coefficients of 1, t, t^2).  From the LLL-reduced integral
    basis for T2 (roots of f to _PREC_BITS bits): the class group
    computation's floating point needs a well-scaled polynomial (f has
    coefficients like 10^14 for a field of discriminant -1144).  None if
    f itself is no worse."""
    from sagebrush._engine import call
    nf = call("nf_data", f=[str(B), str(A), "0", "1"])
    den = int(nf["den"])
    W = [[_F(int(x), den) for x in row] for row in nf["basis"]]
    real = _real_roots(A, B)
    roots = [(r, _F(0)) for r in real]
    if len(real) == 1:
        # t^2 + r t + r^2 + A for the complex pair: -r/2 +- i sqrt(3 r^2 + 4 A)/2
        r = real[0]
        d = 3 * r * r + 4 * A
        scale = 1 << (2 * _PREC_BITS)
        sq = _F(_m.isqrt(int(d * scale)), 1 << _PREC_BITS)
        roots.append((-r / 2, sq / 2))
    def sigma(w, z):
        re, im = z
        # w0 + w1 z + w2 z^2
        z2 = (re * re - im * im, 2 * re * im)
        return (w[0] + w[1] * re + w[2] * z2[0], w[1] * im + w[2] * z2[1])
    emb = [[sigma(w, z) for z in roots] for w in W]
    mult = [1] * len(real) + [2] * (len(roots) - len(real))
    G = [[sum(m * (x[0] * y[0] + x[1] * y[1]) for m, x, y in zip(mult, emb[i], emb[j])) for j in range(3)] for i in range(3)]
    U = _lll_exact(G)
    vecs = [[sum(U[i][j] * W[j][c] for j in range(3)) for c in range(3)] for i in range(3)]
    cands = []
    for c1 in range(-2, 3):
        for c2 in range(-2, 3):
            for c0 in (0, 1):
                v = [c0 * vecs[0][c] + c1 * vecs[1][c] + c2 * vecs[2][c] for c in range(3)]
                if v[1] == 0 and v[2] == 0:
                    continue
                tr, s2, nm = _charpoly(v, A, B)
                g = [-nm, s2, -tr, 1]
                cands.append((max(abs(x) for x in g), g, v))
    size, g, alpha = min(cands, key=lambda t: t[0])
    if size >= max(abs(A), abs(B)):
        return None
    return [int(x) for x in g], alpha


def _to_theta(c, alpha, A, B):
    """sum c_i alpha^i as an element over 1, t, t^2."""
    out = [_F(0)] * 3
    pw = [_F(1), _F(0), _F(0)]
    for ci in c:
        out = [x + ci * y for x, y in zip(out, pw)]
        pw = _mulmod(pw, alpha, A, B)
    return out


# ------------------------------------------------------------------ Selmer

def _nullspace_f2(rows, ncols):
    """A basis of {e : sum e_i rows_i = 0} over F_2 (rows: bit masks over
    ncols columns), as bit masks over the rows."""
    n = len(rows)
    work = [(rows[i], 1 << i) for i in range(n)]
    pivots = []
    out = []
    for i in range(n):
        m, e = work[i]
        for pm, pe, pb in pivots:
            if m >> pb & 1:
                m ^= pm
                e ^= pe
        if m:
            pivots.append((m, e, m.bit_length() - 1))
        else:
            out.append(e)
    return out


def _rank_f2(rows):
    return len(_span_basis(rows))


def selmer(a, verbose=False):
    """The 2-Selmer group of the elliptic curve with minimal model a
    (no rational 2-torsion), as a dict: dim, the Selmer basis as elements
    of A (coefficients over Q of 1, t, t^2, products kept factored as
    exponent vectors over the relation elements), and the data used."""
    import _sage_ec as ec
    from sagebrush._engine import call
    c4, c6 = ec._c(a)
    A, B = -27 * c4, -54 * c6
    S = sorted({2, 3} | {p for p, e in ec._factor_int(ec._disc(a))})
    red = _reduced_field(A, B)
    g = red[0] if red else [B, A, 0, 1]
    try:
        d = call("bnf_relations", f=[str(x) for x in g], extra=S)
    except (ValueError, RuntimeError) as e:
        raise NotImplementedError("2-descent: the class group of the cubic field: %s" % e)
    if red:
        # the relation elements are polynomials in alpha: over 1, t, t^2
        d["elems"] = [([str(x) for x in _to_theta([_F(int(c), int(den_)) for c in num_], red[1], A, B)], "1") for num_, den_ in d["elems"]]
    r1, r2 = d["r1"], d["r2"]
    fb = [tuple(q) for q in d["fb"]]
    nfb = len(fb)
    rels = d["rels"]
    k = len(rels)
    gam = [[_F(x) / int(den) for x in num] for num, den in d["elems"]]
    gens = [[_F(-1), _F(0), _F(0)]] + gam          # -1, then the relation elements
    _CONTENT_PRIMES[:] = sorted(set([2, 3, 5, 7] + S))
    for p in S:
        if sum(q[1] * q[2] for q in fb if q[0] == p) != 3:
            raise ArithmeticError("the factor base misses primes above %d" % p)
    inS = [q[0] in S for q in fb]
    # valuation parities off S (columns), per generator (-1: none)
    nonS = [j for j in range(nfb) if not inS[j]]
    col = {j: i for i, j in enumerate(nonS)}
    rows = [0]
    for rel in rels:
        m = 0
        for j, e in rel:
            if j in col and e & 1:
                m ^= 1 << col[j]
        rows.append(m)
    ker = _nullspace_f2(rows, len(nonS))                 # combos with even valuations off S
    rank_off = _rank_f2(rows)
    dim_A = (r1 + r2 - 1) + 1 + nfb - rank_off
    if verbose:
        print("A(S,2): fb %d (S part %d), relations %d, dim %d (class group %s)" % (nfb, nfb - len(nonS), k, dim_A, d["cyc"]))
    # quadratic characters at degree-1 primes outside the factor base, to
    # take the kernel modulo squares
    fbp = {q[0] for q in fb}
    disc_f = -4 * A ** 3 - 27 * B ** 2
    chars = []
    q = 101
    while len(chars) < dim_A + _EXTRA_CHARS:
        q += 2
        if any(q % s == 0 for s in range(3, int(q ** 0.5) + 1, 2)) or q in fbp or disc_f % q == 0:
            continue
        if any(x.denominator % q == 0 for g in gam for x in g):
            continue
        for t0 in range(q):
            if (t0 ** 3 + A * t0 + B) % q == 0:
                chars.append((q, t0))
    def char_vec(g):
        m = 0
        for i, (q, t0) in enumerate(chars):
            v = sum((x.numerator * pow(x.denominator, -1, q)) * pow(t0, j, q) for j, x in enumerate(g)) % q
            if v == 0:
                raise ArithmeticError("character at a factor-base prime")
            if _legendre(v, q) == -1:
                m |= 1 << i
        return m
    cv = [char_vec(g) for g in gens]
    def combine(vecs, e):
        m = 0
        i = 0
        while e:
            if e & 1:
                m ^= vecs[i]
            e >>= 1
            i += 1
        return m
    # a basis of A(S,2): kernel vectors independent under the characters
    chosen = []
    cbasis = []
    for e in ker:
        m = _reduce(combine(cv, e), cbasis)
        if m:
            cbasis.append((m, m.bit_length() - 1))
            cbasis.sort(key=lambda t: -t[1])
            chosen.append(e)
    if len(chosen) != dim_A:
        err = ArithmeticError("A(S,2): the characters give dimension %d, not %d" % (len(chosen), dim_A))
        err.data = dict(char_vec=char_vec, ker=ker, cv=cv, gens=gens, combine=combine, cbasis=cbasis, chosen=chosen, A=A, B=B)
        raise err
    # local conditions
    places = []
    real = _real_roots(A, B)
    gc_real = [_bits(_real_coords(g, real)) for g in gens]
    img_real = []
    if len(real) == 3:
        # x between the two smaller roots: signs of x - e_i
        rs = sorted(real)
        x = (rs[0] + rs[1]) / 2
        img_real = [_bits(_real_coords([x, -1, 0], real))]
    places.append(("oo", len(real), gc_real, img_real))
    for p in S:
        # p-adic precision: doubled when the elements need more digits
        K = _K_of(p)
        for attempt in range(4):
            try:
                loc = _Local(p, A, B, K)
                gc = [_bits(loc.coords(g)) for g in gens]
                img = loc.image()
                break
            except PrecisionError:
                if attempt == 3:
                    raise
                K *= 2
        places.append((p, loc.dim, gc, img))
        if verbose:
            print("  p = %d: components %s, dim %d, image dim %d" % (p, [c.kind for c in loc.comps], loc.dim, loc.d_image))
    # conditions: the coordinates modulo each image must vanish
    cond = []
    for name, dim, gc, img in places:
        ib = _span_basis(img)
        piv = {b[1] for b in ib}
        cond.append((gc, ib, [i for i in range(dim) if i not in piv]))
    rows = []
    for e in chosen:
        m = 0
        shift = 0
        for gc, ib, free in cond:
            v = _reduce(combine(gc, e), ib)
            for t, i in enumerate(free):
                if v >> i & 1:
                    m |= 1 << (shift + t)
            shift += len(free)
        rows.append(m)
    sel = _nullspace_f2(rows, 0)
    sel_e = [_combine_masks(chosen, s) for s in sel]
    # check: the norms of the Selmer basis are squares
    norms = [_charpoly(_integral(g), A, B)[2] for g in gens]
    for e in sel_e:
        sign = 1
        vals = {}
        for i in range(len(gens)):
            if e >> i & 1:
                n = norms[i]
                if n < 0:
                    sign = -sign
                for p in S:
                    vals[p] = vals.get(p, 0) + _vq(n, p)
        if sign < 0 or any(v & 1 for v in vals.values()):
            raise ArithmeticError("a Selmer element without square norm")
    def in_A(b):
        """Is b (with even valuations off S) in the span found (characters)?"""
        return _reduce(char_vec(b), cbasis) == 0
    # (the class group's own status: certified under GRH, or assuming also
    # the stopping rule's estimate; dropped before, the systematic review's
    # EC-F11)
    return {"assumes": list(d.get("assumes", ["GRH"])), "certified": bool(d.get("certified", False)),
            "dim": len(sel_e), "elements": sel_e, "gens": gens, "dim_A": dim_A, "S": S,
            "class_group": d["cyc"], "A": A, "B": B, "in_A": in_A, "fb": fb, "rels": rels,
            "char_vec": char_vec, "chosen": chosen, "places": places, "rows": rows}


def _combine_masks(masks, e):
    m = 0
    i = 0
    while e:
        if e & 1:
            m ^= masks[i]
        e >>= 1
        i += 1
    return m
