"""Sage's modular forms and elliptic curves over Sagebrush's engines.

ModularSymbols, CuspForms, ModularForms, Gamma0, DirichletGroup and
EllipticCurve, with Sage's names and printed forms, computed by the Rust
engines (sagebrush.modsym, .mf, .ap; WebAssembly in the browser).  Hecke
polynomials are exact and proven (the engine checks a coefficient bound).
"""

import re as _re
from sagebrush import mf as _mf, ap as _ap
from sagebrush._engine import call as _call


def _gcd(a, b):
    while b:
        a, b = b, a % b
    return abs(a)


def _lcm(a, b):
    return a // _gcd(a, b) * b if a and b else 0


def _factor(n):
    f, p = [], 2
    while p * p <= n:
        if n % p == 0:
            e = 0
            while n % p == 0:
                n //= p
                e += 1
            f.append((p, e))
        p += 1 if p == 2 else 2
    if n > 1:
        f.append((n, 1))
    return f


def _phi(n):
    r = n
    for p, _ in _factor(n):
        r = r // p * (p - 1)
    return r


# ------------------------------------------------------------------ printing

def _poly_repr(coeffs, name, atomic=True):
    """A polynomial with coefficients coeffs (constant first), as Sage prints
    it (Polynomial._repr): highest degree first, unit coefficients dropped,
    non-atomic coefficients with several terms in parentheses."""
    s = " "
    m = len(coeffs)
    for n in range(m - 1, -1, -1):
        c = coeffs[n]
        if c == 0 or (isinstance(c, str) and c == "0"):
            continue
        if s != " ":
            s += " + "
        x = y = c if isinstance(c, str) else repr(c)
        if y.startswith("-"):
            y = y[1:]
        if not atomic and n > 0 and ("+" in y or "-" in y):
            x = "(%s)" % x
        if n > 1:
            v = "*%s^%s" % (name, n)
        elif n == 1:
            v = "*%s" % name
        else:
            v = ""
        s += x + v
    s = s.replace(" + -", " - ")
    s = _re.sub(r" 1\*", " ", s)
    s = _re.sub(r" -1\*", " -", s)
    if s == " ":
        return "0"
    s = s[1:]
    if s.startswith("1*"):
        s = s[2:]
    elif s.startswith("-1*"):
        s = "-" + s[3:]
    return s


def _cyclotomic(m):
    """The coefficients of the m-th cyclotomic polynomial (constant first)."""
    def mul(a, b):
        r = [0] * (len(a) + len(b) - 1)
        for i, x in enumerate(a):
            if x:
                for j, y in enumerate(b):
                    r[i + j] += x * y
        return r

    def div(a, b):  # exact division by a monic b
        a = list(a)
        q = [0] * (len(a) - len(b) + 1)
        for i in range(len(q) - 1, -1, -1):
            q[i] = a[i + len(b) - 1]
            for j, y in enumerate(b):
                a[i + j] -= q[i] * y
        return q

    f = [-1] + [0] * (m - 1) + [1]
    for d in range(1, m):
        if m % d == 0:
            f = div(f, _cyclotomic(d))
    return f


class _Cyc:
    """An element of Q(zeta_m) in the power basis 1, zeta_m, ...,
    zeta_m^(phi(m)-1), printed as Sage prints it (zeta_m named 'zetam')."""

    def __init__(self, m, coeffs):
        self.m = m
        self.c = list(coeffs)

    @staticmethod
    def zeta_power(m, j):
        """zeta_m^j reduced modulo the m-th cyclotomic polynomial."""
        if m <= 2:
            return _Cyc(m, [(-1) ** (j % m) if m == 2 else 1])
        f = _cyclotomic(m)
        d = len(f) - 1
        c = [0] * max(d, (j % m) + 1)
        c[j % m] = 1
        for i in range(len(c) - 1, d - 1, -1):
            t = c[i]
            if t:
                for k in range(d + 1):
                    c[i - d + k] -= t * f[k]
        return _Cyc(m, c[:d])

    def to_field(self, n):
        """This element (of Q(zeta_m), m | n) in the power basis of Q(zeta_n)."""
        out = [0] * max(1, _phi(n))
        for i, ci in enumerate(self.c):
            if ci:
                z = _Cyc.zeta_power(n, i * (n // self.m))
                for j, zj in enumerate(z.c):
                    out[j] += ci * zj
        return _Cyc(n, out)

    def __repr__(self):
        if self.m <= 2:
            return repr(self.c[0] if self.c else 0)
        return _poly_repr(self.c, "zeta%d" % self.m)


def _field_order(chi):
    """The cyclotomic field of a character's spaces, as Sage's
    minimize_base_ring picks it: the group's Q(zeta_lambda) if that is
    already Q(zeta_m), m = chi.order() (Q(zeta_3) = Q(zeta_6) is "of order 6"
    mod 7), else Q(zeta_m); 1 for QQ."""
    m = chi.order() if chi is not None else 1
    if m <= 2:
        return 1
    lam = chi.parent()._zeta_order()
    return lam if _phi(lam) == _phi(m) else m


def _ring_name(m):
    return "Rational Field" if m <= 2 else "Cyclotomic Field of order %d and degree %d" % (m, _phi(m))


class Polynomial:
    """A univariate polynomial over ZZ or Z[zeta_m] (coefficients constant
    first), as the engines return Hecke polynomials."""

    def __init__(self, coeffs, var="x", m=1, n=None):
        self._c = coeffs
        self._var = var
        self._m = m  # the coefficients are in Z[zeta_m] (power basis) ...
        self._n = n or m  # ... and printed in Q(zeta_n), m | n

    def __repr__(self):
        if self._m <= 2:
            return _poly_repr([c if isinstance(c, int) else c[0] for c in self._c], self._var)
        return _poly_repr([repr(_Cyc(self._m, c).to_field(self._n)) for c in self._c], self._var, atomic=False)

    def degree(self):
        return len(self._c) - 1

    def list(self):
        if self._m <= 2:
            return [c if isinstance(c, int) else c[0] for c in self._c]
        return [_Cyc(self._m, c).to_field(self._n) for c in self._c]

    coefficients = list

    def __eq__(self, other):
        if isinstance(other, Polynomial):
            return self._c == other._c and self._m == other._m
        return NotImplemented

    def __hash__(self):
        return hash(repr(self))

    def __call__(self, x):
        if self._m > 2:
            raise NotImplementedError("evaluating polynomials over cyclotomic fields")
        r = 0
        for c in reversed(self.list()):
            r = r * x + c
        return r

    def factor(self):
        raise NotImplementedError("factoring polynomials over ZZ is not available in sagebrush yet")


# ------------------------------------------------------------------ groups and characters

def _group_name(N):
    return "Modular Group SL(2,Z)" if N == 1 else "Congruence Subgroup Gamma0(%d)" % N


class Gamma0:
    def __init__(self, N):
        self._N = int(N)

    def level(self):
        return self._N

    def __repr__(self):
        return _group_name(self._N)

    def __eq__(self, other):
        return isinstance(other, Gamma0) and other._N == self._N

    def __hash__(self):
        return hash(("Gamma0", self._N))

    def _dims(self, k):
        return _mf.dims(self._N, k)

    def dimension_cusp_forms(self, k=2):
        return self._dims(k)["cusp"]

    def dimension_eis(self, k=2):
        return self._dims(k)["eisenstein"]

    def dimension_modular_forms(self, k=2):
        d = self._dims(k)
        return d["cusp"] + d["eisenstein"]

    def dimension_new_cusp_forms(self, k=2):
        return self._dims(k)["new"]


def _primitive_root(q, p):
    """The smallest generator of (Z/q)^*, q = p^e for an odd prime p."""
    phi = q // p * (p - 1)
    ps = [r for r, _ in _factor(phi)]
    g = 2
    while True:
        if _gcd(g, q) == 1 and all(pow(g, phi // r, q) != 1 for r in ps):
            return g
        g += 1


def _unit_gens(N):
    """Generators of (Z/N)^* as Sage's Integers(N).unit_gens(): one per
    cyclic factor (2-part first: -1, then 5), each 1 modulo the other prime
    powers; with their orders."""
    gens = []
    for p, e in _factor(N):
        q = p ** e
        if p == 2:
            local = [] if e == 1 else ([(q - 1, 2)] if e == 2 else [(q - 1, 2), (5, q // 4)])
        else:
            local = [(_primitive_root(q, p), q // p * (p - 1))]
        for g, order in local:
            # lift: g mod q, 1 mod N/q
            r = N // q
            x = (g * r * pow(r, -1, q) + q * pow(q, -1, r)) % N if r > 1 else g % N
            gens.append((x, order))
    return gens


class DirichletCharacter:
    """A Dirichlet character mod N, by its values zeta_lambda^e_i on Sage's
    generators of (Z/N)^* (lambda the exponent of the group)."""

    def __init__(self, group, exps):
        self._G = group
        self._e = tuple(int(x) % group._lam for x in exps)

    def parent(self):
        return self._G

    def modulus(self):
        return self._G._N

    def _sagebrush_chi(self):
        return [self._G._lam, [g for g, _ in self._G._gens], list(self._e)]

    def order(self):
        lam = self._G._lam
        g = lam
        for e in self._e:
            g = _gcd(g, e)
        return lam // g

    def conductor(self):
        if self.order() == 1:
            return 1
        return _mf.dims(self._G._N, 2, self)["conductor"]

    def is_trivial(self):
        return self.order() == 1

    def _log(self, a):
        """The exponents of a in the generators."""
        N = self._G._N
        a %= N
        if _gcd(a, N) != 1:
            return None
        out = []
        for (g, order), (p, e) in zip(self._G._gens, self._G._gen_primes):
            q = p ** e
            # the component of a at the prime power q of this generator
            if p == 2 and e >= 3 and g % q == q - 1:
                out.append(0 if a % 4 == 1 else 1)
                continue
            target = a % q
            if p == 2 and e >= 3:
                target = target if target % 4 == 1 else (-target) % q
            x, k = 1, 0
            gq = g % q
            while x != target:
                x = x * gq % q
                k += 1
                if k > order:
                    raise ValueError("discrete log failed")
            out.append(k)
        return out

    def __call__(self, a):
        k = self._log(int(a))
        if k is None:
            return 0
        lam = self._G._lam
        j = sum(ei * x for ei, x in zip(self._e, k)) % lam if lam else 0
        if self._G._zeta_order() <= 2:
            return 1 if j == 0 else -1
        return _Cyc.zeta_power(lam, j)

    def is_even(self):
        return repr(self(-1)) == "1"

    def is_odd(self):
        return not self.is_even()

    def __mul__(self, other):
        return DirichletCharacter(self._G, [a + b for a, b in zip(self._e, other._e)])

    def __pow__(self, n):
        return DirichletCharacter(self._G, [a * int(n) for a in self._e])

    def __invert__(self):
        return self ** -1

    def __eq__(self, other):
        return isinstance(other, DirichletCharacter) and other._G == self._G and other._e == self._e

    def __hash__(self):
        return hash(("chi", self._G._N, self._e))

    def _values_repr(self, m=None):
        """The values on the generators, in Q(zeta_m) (the group's field
        by default)."""
        lam = self._G._lam
        m = self._G._zeta_order() if m is None else m
        return [repr(_Cyc.zeta_power(m, e * m // lam)) if m > 2 else repr((-1) ** (e * 2 // lam) if lam > 1 else 1)
                for e in self._e]

    def __repr__(self):
        vals = self._values_repr()
        maps = ", ".join("%d |--> %s" % (g, v) for (g, _), v in zip(self._G._gens, vals))
        return "Dirichlet character modulo %d of conductor %d mapping %s" % (self._G._N, self.conductor(), maps)


class DirichletGroup:
    """The Dirichlet characters mod N with values in Q(zeta_lambda)."""

    def __init__(self, N):
        self._N = N = int(N)
        self._gens = _unit_gens(N) if N > 2 else []
        self._gen_primes = []
        for p, e in _factor(N):
            k = 0 if (p == 2 and e == 1) else (1 if (p != 2 or e == 2) else 2)
            self._gen_primes += [(p, e)] * k
        lam = 1
        for _, o in self._gens:
            lam = _lcm(lam, o)
        self._lam = lam

    def _zeta_order(self):
        return self._lam if self._lam > 2 or self._N <= 2 else 2

    def __repr__(self):
        return "Group of Dirichlet characters modulo %d with values in %s" % (
            self._N, "Cyclotomic Field of order %d and degree %d" % (self._zeta_order(), _phi(self._zeta_order())))

    def __eq__(self, other):
        return isinstance(other, DirichletGroup) and other._N == self._N

    def __hash__(self):
        return hash(("DirichletGroup", self._N))

    def modulus(self):
        return self._N

    def order(self):
        return _phi(self._N)

    def __len__(self):
        return self.order()

    def ngens(self):
        return len(self._gens)

    def gen(self, i=0):
        e = [0] * len(self._gens)
        e[i] = self._lam // self._gens[i][1]
        return DirichletCharacter(self, e)

    def gens(self):
        return tuple(self.gen(i) for i in range(len(self._gens)))

    def __iter__(self):
        # the first generator varies fastest, as Sage lists them
        orders = [o for _, o in self._gens]
        idx = [0] * len(orders)
        while True:
            yield DirichletCharacter(self, [i * (self._lam // o) for i, o in zip(idx, orders)])
            d = 0
            while d < len(idx):
                idx[d] += 1
                if idx[d] < orders[d]:
                    break
                idx[d] = 0
                d += 1
            if d == len(idx):
                return

    def list(self):
        return list(self)

    def __getitem__(self, i):
        return self.list()[i]

    def galois_orbits(self, reps_only=False):
        """Orbits under Galois conjugation (chi -> chi^a, a prime to the
        order); the order of the orbits may differ from Sage's."""
        seen, out = set(), []
        for chi in self:
            if chi._e in seen:
                continue
            m = chi.order()
            orbit = [chi ** a for a in range(1, m + 1) if _gcd(a, m) == 1]
            for c in orbit:
                seen.add(c._e)
            out.append(chi if reps_only else orbit)
        return out


# ------------------------------------------------------------------ spaces

def _group_and_char(group):
    if isinstance(group, DirichletCharacter):
        return group.modulus(), group
    if isinstance(group, Gamma0):
        return group.level(), None
    return int(group), None


def _char_part(chi):
    """', character [..]' text and the base field's order m."""
    m = _field_order(chi)
    vals = chi._values_repr(m if m > 2 else 2) if chi is not None else []
    return vals, m


class ModularSymbols:
    """Modular symbols for Gamma_0(N) of weight k, possibly with a
    character, and sign 0, 1 or -1."""

    def __init__(self, group=1, weight=2, sign=0, base_ring=None):
        self._N, self._chi = _group_and_char(group)
        self._k = int(weight)
        self._sign = int(sign)
        if self._sign not in (-1, 0, 1):
            raise ValueError("sign must be -1, 0 or 1")
        if self._chi is not None and self._chi.order() == 1:
            self._chi = None
        self._dim = None
        self._polys = {}

    def level(self):
        return self._N

    def weight(self):
        return self._k

    def sign(self):
        return self._sign

    def character(self):
        return self._chi

    def _m(self):
        return self._chi.order() if self._chi is not None else 1

    def base_ring(self):
        return _BaseRing(_field_order(self._chi))

    def dimension(self):
        if self._dim is None:
            self._dim = len(self._hecke(2)) - 1
        return self._dim

    def rank(self):
        return self.dimension()

    def _hecke(self, q):
        q = int(q)
        if q not in self._polys:
            r = _mf.charpoly(self._N, self._k, q, self._chi, self._sign)
            if r["status"] != "proven":
                raise ArithmeticError("the engine could not prove the charpoly of T_%d: %s" % (q, r["checks"]))
            self._polys[q] = r["coeffs"]
            self._dim = r["dim"]
        return self._polys[q]

    def hecke_polynomial(self, n, var="x"):
        """The characteristic polynomial of T_n (U_n if n | N), n prime:
        exact and proven."""
        from sage_all import is_prime
        if not is_prime(int(n)):
            raise NotImplementedError("hecke_polynomial is available for primes n")
        m = self._m()
        c = self._hecke(n)
        return Polynomial([row if m > 2 else row[0] for row in c], var, m, _field_order(self._chi))

    def hecke_operator(self, n):
        return HeckeOperator(self, int(n))

    T = hecke_operator

    def __repr__(self):
        if self._chi is None:
            return "Modular Symbols space of dimension %d for Gamma_0(%d) of weight %d with sign %d over Rational Field" % (
                self.dimension(), self._N, self._k, self._sign)
        vals, m = _char_part(self._chi)
        return "Modular Symbols space of dimension %d and level %d, weight %d, character [%s], sign %d, over %s" % (
            self.dimension(), self._N, self._k, ", ".join(vals), self._sign, _ring_name(m))


class _BaseRing:
    def __init__(self, m):
        self._m = m

    def __repr__(self):
        return _ring_name(self._m)


class HeckeOperator:
    def __init__(self, M, n):
        self._M = M
        self._n = n

    def charpoly(self, var="x"):
        return self._M.hecke_polynomial(self._n, var)

    characteristic_polynomial = charpoly

    def parent(self):
        return self._M

    def matrix(self):
        raise NotImplementedError("Hecke matrices are not exposed by the engine yet; use charpoly()")

    def __repr__(self):
        return "Hecke operator T_%d on %r" % (self._n, self._M)


class ModularForms:
    """M_k(Gamma_0(N), chi); its dimension and cuspidal and new subspaces."""

    def __init__(self, group=1, weight=2, base_ring=None):
        self._N, self._chi = _group_and_char(group)
        self._k = int(weight)
        if self._chi is not None and self._chi.order() == 1:
            self._chi = None
        self._d = None

    def _dims(self):
        if self._d is None:
            self._d = _mf.dims(self._N, self._k, self._chi)
        return self._d

    def level(self):
        return self._N

    def weight(self):
        return self._k

    def character(self):
        return self._chi

    def dimension(self):
        d = self._dims()
        return d["cusp"] + d["eisenstein"]

    def cuspidal_subspace(self):
        return _Subspace(self, "Cuspidal subspace", self._dims()["cusp"])

    def eisenstein_subspace(self):
        return _Subspace(self, "Eisenstein subspace", self._dims()["eisenstein"])

    def new_subspace(self):
        return _Subspace(self, "Modular Forms subspace", self._dims()["new"])

    def _ambient_repr(self):
        if self._chi is None:
            return "Modular Forms space of dimension %d for %s of weight %d over Rational Field" % (
                self.dimension(), _group_name(self._N), self._k)
        vals, m = _char_part(self._chi)
        return "Modular Forms space of dimension %d, character [%s] and weight %d over %s" % (
            self.dimension(), ", ".join(vals), self._k, _ring_name(m))

    def __repr__(self):
        return self._ambient_repr()


class _Subspace:
    def __init__(self, ambient, kind, dim):
        self._A = ambient
        self._kind = kind
        self._dim = dim

    def dimension(self):
        return self._dim

    def ambient(self):
        return self._A

    def new_subspace(self):
        return _Subspace(self._A, "Modular Forms subspace", self._A._dims()["new"])

    def __repr__(self):
        return "%s of dimension %d of %s" % (self._kind, self._dim, self._A._ambient_repr())


def CuspForms(group=1, weight=2, base_ring=None):
    return ModularForms(group, weight).cuspidal_subspace()


# ------------------------------------------------------------------ elliptic curves

_CREMONA = None


def _cremona():
    """Cremona's curves of conductor < 1000 (label -> (ainvs, rank,
    torsion)) and the reverse map."""
    global _CREMONA
    if _CREMONA is None:
        from _cremona_small import DATA
        by_label, by_ainvs = {}, {}
        for line in DATA.split("\n"):
            if not line:
                continue
            label, a, r, t = line.split(" ")
            ainvs = tuple(int(x) for x in a.split(","))
            by_label[label] = (ainvs, int(r), int(t))
            by_ainvs.setdefault(ainvs, label)
        _CREMONA = (by_label, by_ainvs)
    return _CREMONA


def _legendre(a, p):
    a %= p
    if a == 0:
        return 0
    return 1 if pow(a, (p - 1) // 2, p) == 1 else -1


class EllipticCurve_rational_field:
    """y^2 + a1 xy + a3 y = x^3 + a2 x^2 + a4 x + a6 over QQ.  a_p at good
    primes comes from the engine; at bad primes a_p = p - #{affine points
    mod p} (1, -1 or 0 on a model minimal at p, as Cremona's are)."""

    def __init__(self, ainvs, label=None):
        self._a = tuple(int(x) for x in ainvs)
        self._label = label

    def a_invariants(self):
        return self._a

    ainvs = a_invariants

    def b_invariants(self):
        a1, a2, a3, a4, a6 = self._a
        b2 = a1 * a1 + 4 * a2
        b4 = 2 * a4 + a1 * a3
        b6 = a3 * a3 + 4 * a6
        b8 = a1 * a1 * a6 + 4 * a2 * a6 - a1 * a3 * a4 + a2 * a3 * a3 - a4 * a4
        return (b2, b4, b6, b8)

    def c_invariants(self):
        b2, b4, b6, b8 = self.b_invariants()
        return (b2 * b2 - 24 * b4, -b2 ** 3 + 36 * b2 * b4 - 216 * b6)

    def discriminant(self):
        b2, b4, b6, b8 = self.b_invariants()
        return -b2 * b2 * b8 - 8 * b4 ** 3 - 27 * b6 * b6 + 9 * b2 * b4 * b6

    def j_invariant(self):
        from sage_all import QQ
        c4, _ = self.c_invariants()
        return QQ(c4 ** 3, self.discriminant())

    def _cremona_entry(self):
        if self._label is not None:
            return self._label
        if self._a in _cremona()[1]:
            return _cremona()[1][self._a]
        return None

    def cremona_label(self):
        lab = self._cremona_entry()
        if lab is None:
            raise LookupError("this curve is not in sagebrush's table (Cremona's curves of conductor < 1000)")
        return lab

    label = cremona_label

    def conductor(self):
        lab = self._cremona_entry()
        if lab is None:
            raise NotImplementedError("the conductor is known for Cremona's curves of conductor < 1000 (Tate's algorithm is not implemented yet)")
        return int(_re.match(r"\d+", lab).group(0))

    def rank(self):
        lab = self._cremona_entry()
        if lab is None:
            raise NotImplementedError("the rank is known for Cremona's curves of conductor < 1000")
        return _cremona()[0][lab][1]

    def torsion_order(self):
        lab = self._cremona_entry()
        if lab is None:
            raise NotImplementedError("the torsion order is known for Cremona's curves of conductor < 1000")
        return _cremona()[0][lab][2]

    def _ap_bad(self, p):
        a1, a2, a3, a4, a6 = self._a
        if p == 2:
            n = sum(1 for x in range(2) for y in range(2)
                    if (y * y + a1 * x * y + a3 * y - x ** 3 - a2 * x * x - a4 * x - a6) % 2 == 0)
            return p - n
        # (2y + a1 x + a3)^2 = 4(x^3 + a2 x^2 + a4 x + a6) + (a1 x + a3)^2
        n = 0
        for x in range(p):
            d = 4 * (x ** 3 + a2 * x * x + a4 * x + a6) + (a1 * x + a3) ** 2
            n += 1 + _legendre(d, p)
        return p - n

    def ap(self, p):
        p = int(p)
        r = _ap.ap(self._a, p)
        return self._ap_bad(p) if r is None else r

    def aplist(self, n, python_ints=False):
        """[a_p for the primes p < n]."""
        n = int(n)
        if n <= 2:
            return []
        return [self._ap_bad(p) if a is None else a for p, a in _ap.aplist(self._a, n - 1)]

    def anlist(self, n):
        """[0, a_1, ..., a_n]."""
        n = int(n)
        a = [0] * (n + 1)
        if n >= 1:
            a[1] = 1
        disc = self.discriminant()
        aps = dict(zip([p for p, _ in _ap.aplist(self._a, n)], self.aplist(n + 1))) if n >= 2 else {}
        for p, apv in aps.items():
            good = disc % p != 0
            # a_{p^k}
            pk, prev, cur = p, 1, apv
            while pk <= n:
                a[pk] = cur
                prev, cur = cur, (apv * cur - p * prev) if good else apv * cur
                pk *= p
        # multiplicativity
        for m in range(2, n + 1):
            if a[m] != 0 or m in aps:
                continue
            q, k = None, m
            for p in aps:
                if k % p == 0:
                    q = p
                    break
            if q is None:
                continue
            pk = 1
            while k % q == 0:
                k //= q
                pk *= q
            if k > 1:
                a[m] = a[pk] * a[k]
        return a

    def an(self, n):
        return self.anlist(int(n))[int(n)]

    def sato_tate_moments(self, n, kmax=4):
        """(number of good primes p <= n, [mean (a_p^2/p)^k, k = 1..kmax]);
        a sagebrush extension (1, 2, 5, 14, ... for non-CM curves)."""
        return _ap.moments(self._a, int(n), int(kmax))

    def __eq__(self, other):
        return isinstance(other, EllipticCurve_rational_field) and other._a == self._a

    def __hash__(self):
        return hash(("EllipticCurve", self._a))

    def __repr__(self):
        a1, a2, a3, a4, a6 = self._a

        def term(c, mono):
            if c == 0:
                return ""
            s = (" + " if c > 0 else " - ") + ("" if abs(c) == 1 else "%d*" % abs(c))
            return s + mono

        lhs = "y^2" + term(a1, "x*y") + term(a3, "y")
        rhs = _poly_repr([a6, a4, a2, 1], "x")
        return "Elliptic Curve defined by %s = %s over Rational Field" % (lhs, rhs)


def EllipticCurve(x, y=None):
    """EllipticCurve([a1, a2, a3, a4, a6]), EllipticCurve([a4, a6]) or a
    Cremona label of conductor < 1000 ('389a1', '11a')."""
    if y is not None:
        x = [x, y]
    if isinstance(x, str):
        lab = x.strip()
        if _re.fullmatch(r"\d+[a-z]+", lab):
            lab += "1"
        by_label = _cremona()[0]
        if lab not in by_label:
            raise ValueError("unknown Cremona label %r (sagebrush knows conductors < 1000)" % x)
        return EllipticCurve_rational_field(by_label[lab][0], lab)
    a = [int(t) for t in x]
    if len(a) == 2:
        a = [0, 0, 0, a[0], a[1]]
    if len(a) != 5:
        raise ValueError("an elliptic curve is [a1, a2, a3, a4, a6] or [a4, a6]")
    E = EllipticCurve_rational_field(a)
    if E.discriminant() == 0:
        raise ArithmeticError("invariants %s define a singular curve" % (tuple(a),))
    return E
