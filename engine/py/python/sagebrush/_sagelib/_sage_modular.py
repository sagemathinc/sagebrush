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
        if m <= 2:
            from _sage_poly import PolynomialRing, ZZ
            return PolynomialRing(ZZ, var)([row[0] for row in c])
        return Polynomial(c, var, m, _field_order(self._chi))

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

    def newforms(self, names=None):
        return Newforms(self._chi or self._N, self._k, names=names)

    def newform_orbits(self, prec=100):
        return newform_orbits(self._chi or self._N, self._k, prec)

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

    def newforms(self, names=None):
        return self._A.newforms(names)

    def newform_orbits(self, prec=100):
        return self._A.newform_orbits(prec)

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

    # ---- local and global arithmetic (lib/_sage_ec.py)
    def _ld(self):
        if getattr(self, "_local", None) is None:
            import _sage_ec as _ec
            self._local = _ec.local_data(self.minimal_model()._a if not self._is_minimal() else self._a)
        return self._local

    def _is_minimal(self):
        if getattr(self, "_minimal", None) is None:
            import _sage_ec as _ec
            self._minimal = _ec.minimal_model(self._a) == self._a
        return self._minimal

    def minimal_model(self):
        """A global minimal model (reduced: a1, a3 in {0, 1}, a2 in {-1, 0, 1})."""
        import _sage_ec as _ec
        m = _ec.minimal_model(self._a)
        return self if m == self._a else EllipticCurve_rational_field(m)

    global_minimal_model = minimal_model

    def is_minimal(self):
        return self._is_minimal()

    def conductor(self):
        """The conductor, by Tate's algorithm at the primes dividing the discriminant."""
        lab = self._cremona_entry()
        if lab is not None:
            return int(_re.match(r"\d+", lab).group(0))
        N = 1
        for p, (kod, f, c) in self._ld().items():
            N *= p ** f
        return N

    def bad_primes(self):
        return sorted(p for p, (kod, f, c) in self._ld().items() if f > 0)

    def kodaira_symbol(self, p):
        """The Kodaira symbol of the reduction at p ('I0', 'I5', 'I2*', 'IV*', ...)."""
        return self._ld().get(int(p), ("I0", 0, 1))[0]

    def tamagawa_number(self, p):
        return self._ld().get(int(p), ("I0", 0, 1))[2]

    def tamagawa_numbers(self):
        return [self.tamagawa_number(p) for p in self.bad_primes()]

    def tamagawa_product(self):
        r = 1
        for c in self.tamagawa_numbers():
            r *= c
        return r

    def minimal_discriminant(self):
        return self.minimal_model().discriminant()

    def real_components(self):
        return 2 if self.discriminant() > 0 else 1

    def period_lattice(self):
        return _PeriodLattice(self)

    def _ldata(self):
        if getattr(self, "_lseries_data", None) is None:
            import _sage_ec as _ec
            N = self.conductor()
            self._lseries_data = _ec._LData(self.minimal_model().anlist(_ec.terms_needed(N)), N)
        return self._lseries_data

    def root_number(self):
        """The global root number w (the sign of the functional equation), +1 or -1."""
        import _sage_ec as _ec
        return _ec.root_number(self._ldata())

    def analytic_rank(self, proof=False, leading_coefficient=False):
        """The order of vanishing of L(E,s) at s = 1: the first r of the parity
        of the root number with L^(r)(E,1) numerically nonzero (as in Sage).

        With proof=True only ranks 0 and 1 are returned (then nothing has to
        vanish: w = -1 forces L(E,1) = 0); for r >= 2 it raises, since showing
        that L^(k)(E,1) is exactly 0 for k < r is a separate problem (possible
        for r = 2, 3 via modular symbols and Gross-Zagier, not implemented
        here, and open for every curve when r >= 4).
        With leading_coefficient=True, returns (r, L^(r)(E,1)), as Sage does."""
        import _sage_ec as _ec
        ld = self._ldata()
        r, v = _ec.analytic_rank_numerical(ld, _ec.root_number(ld))
        if proof and r >= 2:
            raise NotImplementedError(
                "analytic rank %d is only numerical: L^(k)(E,1) for k < %d are merely small "
                "(use proof=False)" % (r, r))
        if leading_coefficient:
            from sage_all import RR
            return r, RR(v)
        return r

    def _proven_analytic_rank(self):
        """The analytic rank if it is 0 or 1 (then equal to the rank, by
        Gross-Zagier and Kolyvagin), else None."""
        try:
            return self.analytic_rank(proof=True)
        except NotImplementedError:
            return None

    def lseries(self):
        return _LSeries(self)

    def sha(self):
        return _Sha(self)

    # ---- rational points (lib/_sage_ec.py)
    def __call__(self, *args):
        """E(0) is the identity; E(x, y), E([x, y]) or E([x, y, z]) a point."""
        if len(args) == 1 and not isinstance(args[0], (list, tuple)) and args[0] == 0:
            return EllipticCurvePoint(self, None)
        if len(args) == 1:
            args = tuple(args[0])
        from fractions import Fraction
        def fr(t):
            try:
                return Fraction(int(t.numerator()), int(t.denominator()))
            except AttributeError:
                return Fraction(t)
        if len(args) == 3:
            x, y, z = (fr(t) for t in args)
            if z == 0:
                return EllipticCurvePoint(self, None)
            args = (x / z, y / z)
        x, y = (fr(t) for t in args)
        import _sage_ec as _ec
        if not _ec.on_curve(self._a, (x, y)):
            raise TypeError("coordinates %s do not define a point on %r" % ([x, y], self))
        return EllipticCurvePoint(self, (x, y))

    point = __call__

    def lift_x(self, x, all=False):
        import _sage_ec as _ec
        from fractions import Fraction
        try:
            xf = Fraction(int(x.numerator()), int(x.denominator()))
        except AttributeError:
            xf = Fraction(x)
        pts = [EllipticCurvePoint(self, P) for P in _ec.lift_x(self._a, xf)]
        if all:
            return pts
        if not pts:
            raise ValueError("no point with x-coordinate %s on %r" % (x, self))
        return pts[-1]

    def torsion_points(self):
        """The points of finite order (found by Nagell-Lutz-sized search)."""
        import _sage_ec as _ec
        out = [EllipticCurvePoint(self, None)]
        T = self.torsion_order()
        if T > 1:
            seen = set()
            H = 2.0
            while len(out) < T and H < 60:
                for P in _ec.point_search(self._a, H):
                    if P not in seen and _ec.point_order(self._a, P):
                        seen.add(P)
                        out.append(EllipticCurvePoint(self, P))
                H += 2
        return sorted(out, key=lambda Q: (Q._P is not None, Q._P or ()))

    def point_search(self, height_limit, verbose=False):
        """Points with naive height log max(|r|, s^2) <= height_limit (x = r/s^2), as Sage."""
        import _sage_ec as _ec
        return [EllipticCurvePoint(self, P) for P in _ec.point_search(self._a, float(height_limit))]

    def _bad(self):
        import _sage_ec as _ec
        return [p for p, _ in _ec._factor_int(self.minimal_model().discriminant())]

    def height_pairing_matrix(self, points):
        import _sage_ec as _ec
        from sage_all import matrix, RR
        m = self.minimal_model()
        ps = [m._to_min(P) for P in points]
        bad = self._bad()
        r = len(ps)
        M = [[_ec.canonical_height(m._a, ps[i], bad) if i == j else _ec.height_pairing(m._a, ps[i], ps[j], bad) for j in range(r)] for i in range(r)]
        return _RealMatrix(M)

    def regulator_of_points(self, points):
        import _sage_ec as _ec
        from sage_all import RR
        m = self.minimal_model()
        return RR(_ec.regulator(m._a, [m._to_min(P) for P in points], self._bad()))

    def _to_min(self, P):
        """The point P (on self or on a curve with the same c4, c6) moved to this model."""
        if isinstance(P, EllipticCurvePoint):
            if P._E._a == self._a:
                return P._P
            return P._E._move_to(P._P, self)
        return P

    def _move_to(self, P, other):
        """Move a point of self to the isomorphic model other: x = u^2 x' + r,
        y = u^3 y' + s u^2 x' + t, with u from the c-invariants."""
        if P is None:
            return None
        from fractions import Fraction as Fr
        import math
        import _sage_ec as _ec

        def root(q, k):
            """the exact positive k-th root of a positive Fraction"""
            def iroot(n):
                r = round(n ** (1.0 / k))
                for c in (r - 1, r, r + 1):
                    if c >= 0 and c ** k == n:
                        return c
                lo, hi = 0, 1
                while hi ** k <= n:
                    hi *= 2
                while hi - lo > 1:
                    mid = (lo + hi) // 2
                    if mid ** k <= n:
                        lo = mid
                    else:
                        hi = mid
                if lo ** k != n:
                    raise ArithmeticError("not an exact power")
                return lo
            return Fr(iroot(q.numerator), iroot(q.denominator))
        c4, c6 = self.c_invariants()
        d4, d6 = other.c_invariants()
        if c4 and c6:
            u2 = Fr(c6 * d4, c4 * d6)
        elif c6 == 0:
            u2 = root(Fr(c4, d4), 2)
        else:
            q = Fr(c6, d6)
            u2 = root(q, 3) if q > 0 else -root(-q, 3)
        u = root(u2, 2)
        a1, a2, a3, a4, a6 = self._a
        b1, b2_, b3, b4_, b6_ = other._a
        s_ = (u * b1 - a1) / 2
        r = (u * u * b2_ - a2 + s_ * a1 + s_ * s_) / 3
        t = (u ** 3 * b3 - a3 - r * a1) / 2
        x, y = P
        Q = ((x - r) / (u * u), (y - s_ * (x - r) - t) / u ** 3)
        if not _ec.on_curve(other._a, Q):
            raise ArithmeticError("could not move the point to the other model")
        return Q

    def gens(self, height_limit=None):
        """Generators of E(Q) modulo torsion, for analytic rank 0 or 1: the
        non-torsion point of least canonical height among the points of naive
        height at most height_limit (default 9) on the minimal model, checked
        to be saturated at the primes up to 13 where the reduction test applies."""
        import _sage_ec as _ec
        r = self._proven_analytic_rank()
        if r is None:
            raise NotImplementedError("gens() for analytic rank %d is not implemented yet" % self.analytic_rank())
        if r == 0:
            return []
        m = self.minimal_model()
        aps = _ap.aplist(m._a, 1000)
        g = _ec.search_generator(m._a, aps, self._bad(), float(height_limit or 9.0))
        if g is None:
            raise NotImplementedError("no point of infinite order of naive height <= %s found; descent is needed" % (height_limit or 9.0))
        P = g[0]
        if m is not self and m._a != self._a:
            P = m._move_to(P, self)
        return [EllipticCurvePoint(self, P)]

    def regulator(self):
        gs = self.gens()
        from sage_all import RR
        return RR(1) if not gs else self.regulator_of_points(gs)

    def rank(self, only_use_mwrank=True, proof=None):
        """The rank of E(Q): from Cremona's table (conductor < 1000), else the
        analytic rank when it is 0 or 1 (equal to the rank by Gross-Zagier and
        Kolyvagin), else 2-isogeny descent when its bounds meet.  With
        proof=False, falls back to the numerical analytic rank (assuming the
        Birch and Swinnerton-Dyer rank conjecture) when these do not decide."""
        lab = self._cremona_entry()
        if lab is not None:
            return _cremona()[0][lab][1]
        r = self._proven_analytic_rank()
        if r is not None:
            return r
        try:
            lo, hi = self.rank_bounds()
        except NotImplementedError:
            lo, hi = 0, None
        if lo == hi:
            return lo
        if proof is False:
            r = self.analytic_rank(proof=False)
            if r >= lo and (hi is None or r <= hi):
                return r
        bounds = "rank bounds %d <= r <= %d" % (lo, hi) if hi is not None else "no rank bounds"
        raise NotImplementedError("%s: general 2-descent is not implemented yet (proof=False uses the analytic rank)" % bounds)

    def two_descent_by_two_isogeny(self, search_bound=60):
        """Descent via 2-isogeny (needs a rational 2-torsion point): (lower, upper)
        bounds for the rank, from the images found and the Selmer groups."""
        import _sage_ec as _ec
        d = _ec.two_isogeny_descent(self.minimal_model()._a, search_bound)
        if d is None:
            raise ValueError("descent by 2-isogeny needs a rational point of order 2")
        self._descent = d
        return d["rank_bounds"]

    def rank_bounds(self):
        """(lower, upper) bounds for the rank (2-isogeny descent; lower bound
        also from the analytic rank when it is 0 or 1)."""
        r = self._proven_analytic_rank()
        if r is not None:
            return (r, r)
        if self.torsion_order() % 2 == 0:
            return self.two_descent_by_two_isogeny()
        raise NotImplementedError("general 2-descent (no rational 2-torsion) is not implemented yet")


    def torsion_order(self):
        """#E(Q)_tors (bounded by #E(F_p), then found by Nagell-Lutz)."""
        if getattr(self, "_tors", None) is None:
            import _sage_ec as _ec
            self._tors = _ec.torsion_order(self._a, _ap.aplist(self._a, 200))
        return self._tors

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


class _PeriodLattice:
    def __init__(self, E):
        self._E = E

    def omega(self, prec=None):
        """The real period of a global minimal model times the number of
        components of E(R) (Cremona's Omega in the BSD formula)."""
        import _sage_ec as _ec
        from sage_all import RR
        return RR(_ec.real_period(self._E.minimal_model()._a))

    def __repr__(self):
        return "Period lattice associated to %r" % (self._E,)


class _LSeries:
    def __init__(self, E):
        self._E = E

    def __repr__(self):
        return "Complex L-series of the %r" % (self._E,)

    def __call__(self, s):
        """L(E, s), at s = 1 only for now."""
        import _sage_ec as _ec
        from sage_all import RR
        if s != 1:
            raise NotImplementedError("L(E, s) is implemented at s = 1 only")
        ld = self._E._ldata()
        return RR(_ec.L1(ld, _ec.root_number(ld)))

    def L_ratio(self):
        """L(E,1)/Omega_E as an exact rational: computed to about 15 digits
        and recognized with denominator dividing 2 #E(Q)_tors^2 (Manin-Drinfeld,
        for an optimal curve with Manin constant 1 the denominator divides
        2 #E(Q)_tors)."""
        import _sage_ec as _ec
        from sage_all import QQ
        E = self._E
        ld = E._ldata()
        w = _ec.root_number(ld)
        if w == -1:
            return QQ(0)
        T = E.torsion_order()
        D = 2 * T * T
        x = _ec.L1(ld, w) / _ec.real_period(E.minimal_model()._a)
        q = _ec.recognize(x, [d for d in range(1, D + 1) if D % d == 0])
        if q is None:
            raise ArithmeticError("L(E,1)/Omega = %r is not a rational with denominator dividing %d" % (x, D))
        return QQ(q.numerator, q.denominator)


class _Sha:
    def __init__(self, E):
        self._E = E

    def __repr__(self):
        return "Tate-Shafarevich group for the %r" % (self._E,)

    def an(self):
        """The analytic order of Sha, from the Birch and Swinnerton-Dyer
        formula: exact in analytic rank 0 (L(E,1)/Omega via L_ratio)."""
        from sage_all import QQ, Integer
        E = self._E
        r = E.analytic_rank()
        from fractions import Fraction
        T = E.torsion_order()
        if r == 1:
            # L'(E,1) = Omega Reg #Sha prod c_p / #E(Q)_tors^2, with Reg the
            # height of a generator (E.gens(), point search)
            import _sage_ec as _ec
            P = E.gens()[0]
            h = float(P.height())
            Lp = _ec.L1_derivative(E._ldata())
            om = _ec.real_period(E.minimal_model()._a)
            x = Lp * T * T / (om * h * E.tamagawa_product())
            n = round(x)
            if n < 1 or abs(x - n) > 1e-6 * max(1, n):
                raise ArithmeticError("Sha_an = %r is not an integer: is %r a generator?" % (x, P))
            return Integer(n)
        if r != 0:
            raise NotImplementedError("Sha.an() in analytic rank %d is not implemented" % r)
        q = E.lseries().L_ratio()
        s = Fraction(int(q.numerator()), int(q.denominator())) * T * T / E.tamagawa_product()
        return Integer(s.numerator) if s.denominator == 1 else QQ(s.numerator, s.denominator)


def _m_log(x):
    import math
    return math.log(x)


class _RealMatrix:
    """A small matrix of real numbers, printed as Sage prints matrices over RR."""

    def __init__(self, rows):
        self._rows = [list(map(float, r)) for r in rows]

    def __repr__(self):
        from sage_all import RR
        cells = [[repr(RR(x)) for x in r] for r in self._rows]
        w = [max(len(cells[i][j]) for i in range(len(cells))) for j in range(len(cells[0]))] if cells else []
        return "\n".join("[" + " ".join(c.rjust(w[j]) for j, c in enumerate(r)) + "]" for r in cells)

    def __getitem__(self, ij):
        from sage_all import RR
        i, j = ij
        return RR(self._rows[i][j])

    def nrows(self):
        return len(self._rows)

    def det(self):
        import _sage_ec as _ec
        from sage_all import RR
        M = [r[:] for r in self._rows]
        n = len(M)
        d = 1.0
        for i in range(n):
            piv = max(range(i, n), key=lambda k: abs(M[k][i]))
            if M[piv][i] == 0:
                return RR(0)
            if piv != i:
                M[i], M[piv] = M[piv], M[i]
                d = -d
            d *= M[i][i]
            for k in range(i + 1, n):
                f = M[k][i] / M[i][i]
                for j in range(i, n):
                    M[k][j] -= f * M[i][j]
        return RR(d)

    determinant = det


class EllipticCurvePoint:
    """A rational point on an elliptic curve over QQ (None = the point at infinity)."""

    def __init__(self, E, P):
        self._E = E
        self._P = P

    def curve(self):
        return self._E

    def _new(self, P):
        return EllipticCurvePoint(self._E, P)

    def __add__(self, other):
        import _sage_ec as _ec
        return self._new(_ec.add(self._E._a, self._P, other._P))

    def __neg__(self):
        import _sage_ec as _ec
        return self._new(_ec.neg(self._E._a, self._P))

    def __sub__(self, other):
        return self + (-other)

    def __mul__(self, n):
        import _sage_ec as _ec
        return self._new(_ec.mul(self._E._a, int(n), self._P))

    __rmul__ = __mul__

    def __eq__(self, other):
        if isinstance(other, int) and other == 0:
            return self._P is None
        return isinstance(other, EllipticCurvePoint) and other._E == self._E and other._P == self._P

    def __hash__(self):
        return hash(("pt", self._E._a, self._P))

    def is_zero(self):
        return self._P is None

    def _coord(self, t):
        from sage_all import QQ
        return QQ(t.numerator, t.denominator)

    def xy(self):
        if self._P is None:
            raise ZeroDivisionError("the point at infinity has no affine coordinates")
        return (self._coord(self._P[0]), self._coord(self._P[1]))

    def __getitem__(self, i):
        if self._P is None:
            return [self._coord(0), self._coord(1), self._coord(0)][i]
        return [self._coord(self._P[0]), self._coord(self._P[1]), self._coord(1)][i]

    def __repr__(self):
        if self._P is None:
            return "(0 : 1 : 0)"
        x, y = self.xy()
        return "(%s : %s : 1)" % (x, y)

    def order(self):
        import _sage_ec as _ec
        from sage_all import Integer
        if self._P is None:
            return Integer(1)
        n = _ec.point_order(self._E._a, self._P)
        if n == 0:
            from sage_all import oo
            return oo
        return Integer(n)

    additive_order = order

    def has_finite_order(self):
        import _sage_ec as _ec
        return self._P is None or _ec.point_order(self._E._a, self._P) != 0

    def height(self):
        """The canonical (Neron-Tate) height, normalized as in Sage and Cremona's tables."""
        import _sage_ec as _ec
        from sage_all import RR
        m = self._E.minimal_model()
        return RR(_ec.canonical_height(m._a, m._to_min(self), self._E._bad()))


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


# ------------------------------------------------------------------ newforms

def _qexp(coeffs, prec):
    """sum coeffs[n-1] q^n + O(q^prec), as Sage prints a power series."""
    terms = []
    for n in range(1, prec):
        a = coeffs[n - 1] if n - 1 < len(coeffs) else 0
        if a == 0:
            continue
        mono = "q" if n == 1 else "q^%d" % n
        coef = "" if abs(a) == 1 else "%d*" % abs(a)
        terms.append((a < 0, coef + mono))
    s = ""
    for i, (neg, t) in enumerate(terms):
        s += ("-" if neg else "") + t if i == 0 else (" - " if neg else " + ") + t
    return (s + " + " if s else "") + "O(q^%d)" % prec


class NewformOrbit:
    """A Galois orbit of newforms (LMFDB's newform orbit): its label,
    dimension over QQ, trace form and the characteristic polynomial over QQ
    of the Hecke operator T that separates the orbits (a sagebrush
    extension; Sage itself has no such object)."""

    def __init__(self, N, k, chi, data, T):
        self._N, self._k, self._chi = N, k, chi
        self._letter = data["letter"]
        self._dim = data["dim"]
        self._traces = data["traces"]
        self._charpoly = data["charpoly"]
        self._T = T

    def label(self):
        """LMFDB's label N.k.a.x (for the trivial character)."""
        return "%d.%d.a.%s" % (self._N, self._k, self._letter) if self._chi is None else None

    def level(self):
        return self._N

    def weight(self):
        return self._k

    def dimension(self):
        return self._dim

    def traces(self, n=None):
        """[tr a_1, ..., tr a_n] (traces down to QQ of the coefficients)."""
        return self._traces[: n or len(self._traces)]

    def trace_form(self, prec=6):
        return _qexp(self._traces, prec)

    def hecke_operator(self):
        """T as [(q, r)]: T = sum r T_q."""
        return list(self._T)

    def charpoly(self, var="x"):
        """The characteristic polynomial of T on this orbit (irreducible over QQ)."""
        from _sage_poly import PolynomialRing, ZZ
        return PolynomialRing(ZZ, var)(self._charpoly)

    def __repr__(self):
        name = self.label() or "Newform orbit %d.%d.%s" % (self._N, self._k, self._letter)
        return "%s (dimension %d): %s" % (name, self._dim, self.trace_form())


def newform_orbits(group=1, weight=2, prec=100):
    """The Galois orbits of newforms in S_k^new(N, [chi]), in LMFDB order
    (dimension, then trace form), with their trace forms to q^prec:
    computed (and proven) by the Sagebrush engine."""
    N, chi = _group_and_char(group)
    if chi is not None and chi.order() == 1:
        chi = None
    d = _mf.newforms(N, int(weight), chi=chi, bound=int(prec))
    return [NewformOrbit(N, int(weight), chi, o, d["T"]) for o in d["newforms"]]


class Newform:
    """A newform with rational coefficients, as Sage's Newform prints it."""

    def __init__(self, orbit):
        self._o = orbit

    def level(self):
        return self._o._N

    def weight(self):
        return self._o._k

    def coefficients(self, n=None):
        """[a_1, ..., a_n] (or the list for n a list of indices)."""
        if isinstance(n, (list, tuple)):
            return [self[i] for i in n]
        return list(self._o._traces[: (n if n is not None else 20)])

    def __getitem__(self, n):
        if n == 0:
            return 0
        o = self._o
        if n > len(o._traces):
            more = newform_orbits(o._chi or o._N, o._k, prec=max(2 * n, 100))
            self._o = o = [m for m in more if m._letter == o._letter][0]
        return o._traces[n - 1]

    def q_expansion(self, prec=6):
        return _qexp(self._o._traces, prec)

    def hecke_eigenvalue_field(self):
        from _sage_poly import QQ
        return QQ

    def label(self):
        return self._o.label()

    def __repr__(self):
        return self.q_expansion(6)


def Newforms(group, weight=2, base_ring=None, names=None):
    """The newforms of weight k on Gamma_0(N) (or with a character), as Sage's
    Newforms, when they all have rational coefficients; otherwise use
    newform_orbits(N, k), which describes every Galois orbit."""
    orbits = newform_orbits(group, weight, prec=20)
    if any(o.dimension() != 1 for o in orbits):
        raise NotImplementedError("newforms with non-rational coefficients: sagebrush describes them by newform_orbits(%s, %s) (label, dimension, trace form)" % (group, weight))
    return [Newform(o) for o in orbits]
