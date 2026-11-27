"""Methods of the spaces of modular forms and of newforms that load on first
use (lib/_sage_modular.py's _QSpace and Newform resolve their names here):
the Hecke bound, the echelon and integral q-expansion bases, the Eisenstein
series, the cuspidal and Eisenstein submodules; a newform's coefficients,
character, CM and Atkin-Lehner eigenvalues.  Values as Sage 10.10 gives
them, observed as a black box."""
from fractions import Fraction as _Fr
from math import gcd as _gcd

from _sage_modular import (_Basis, _series, _rref_exact, _sturm_bound, _divisors, _factor, _bernoulli,
                           _Subspace, ModularFormElement, DirichletGroup, _nonneg, _NONTRIVIAL)


def _sigma(n, k):
    return sum(d ** k for d in _divisors(n))


def _real_characters(N):
    """The nontrivial characters psi mod N with cond(psi)^2 | N, in Sage's
    DirichletGroup order; NotImplementedError if one is not real (its
    Eisenstein series have coefficients in a cyclotomic field)."""
    G = DirichletGroup(N)
    triv = G[0]
    out = []
    for c in G:
        if c == triv or N % (int(c.conductor()) ** 2):
            continue
        if int(c.order()) != 2:
            raise NotImplementedError("Eisenstein series with coefficients in a cyclotomic field (characters of order > 2 mod %d) are not supported yet" % N)
        out.append(c)
    return out


def _eis_series(N, k, psi, t, prec):
    """a_0 .. a_(prec-1) of Sage's normalized Eisenstein series E_k^(psi, psi)(q^t)
    (psi real; for psi trivial and k = 2, E_2(q) - t E_2(q^t))."""
    a = [_Fr(0)] * prec
    if psi is None:
        if k == 2:
            a[0] = _Fr(t - 1, 24)
            for n in range(1, prec):
                a[n] = _Fr(_sigma(n, 1) - (t * _sigma(n // t, 1) if n % t == 0 else 0))
        else:
            a[0] = -_bernoulli(k) / (2 * k)
            for m in range(1, (prec - 1) // t + 1):
                a[t * m] = _Fr(_sigma(m, k - 1))
        return a
    # (psi's primitive character: its values mod the conductor f, read at a
    # representative prime to N)
    f = int(psi.conductor())
    chi = [0] * f
    for r in range(f):
        if _gcd(r, f) == 1:
            n = r
            while _gcd(n, N) != 1:
                n += f
            chi[r] = int(str(psi(n)))
    for m in range(1, (prec - 1) // t + 1):
        a[t * m] = _Fr(sum(chi[(m // d) % f] * chi[d % f] * d ** (k - 1) for d in _divisors(m)))
    return a


def _squarefree(n):
    return all(e == 1 for _, e in _factor(n)) if n > 1 else n == 1


def _fundamental(D):
    """Whether D < 0 is a fundamental discriminant."""
    if D % 4 == 1:
        return _squarefree(-D)
    if D % 4 == 0:
        m = D // 4
        return m % 4 in (2, 3) and _squarefree(-m)
    return False


def _kronecker(D, p):
    """The Kronecker symbol (D / p), p prime."""
    if p == 2:
        return 0 if D % 2 == 0 else (1 if D % 8 in (1, 7) else -1)
    r = pow(D % p, (p - 1) // 2, p)
    return 0 if r == 0 else (1 if r == 1 else -1)


def _primes_upto(B):
    sieve = bytearray([1]) * (B + 1)
    out = []
    for i in range(2, B + 1):
        if sieve[i]:
            out.append(i)
            sieve[i * i::i] = bytearray(len(range(i * i, B + 1, i)))
    return out


class QSpaceMethods:
    """The spaces' methods loaded on first use (copied onto _QSpace by
    _sage_modular._load_mfmore; not instantiated)."""

    def _all_cusp(self):
        return all(p.startswith("cusp") for p in self._parts())

    def hecke_bound(self):
        """A bound B such that T_1, ..., T_B generate the Hecke algebra, as
        Sage gives it: the Sturm bound for a cuspidal space, the Sturm bound
        plus 2 dim E + 4 for one with Eisenstein series (E the ambient
        Eisenstein subspace), one less than the Sturm bound for a zero space.

        EXAMPLES::

            sage: CuspForms(11, 2).hecke_bound(), ModularForms(11, 2).hecke_bound(), ModularForms(24, 4).hecke_bound()
            (3, 9, 37)
        """
        s = self.sturm_bound()
        if self.dimension() == 0:
            return s - 1
        if self._all_cusp():
            return s
        A = self._amb()
        return s + 2 * A.eisenstein_subspace().dimension() + 4

    def _echelon_rows(self, prec):
        work = max(prec, self.sturm_bound() + 2)
        rows = _rref_exact(self._qrows(work))
        return rows, work

    def q_echelon_basis(self, prec=None):
        """The q-expansions of the reduced echelon basis of the whole space
        (not part by part), to precision prec (6 by default).

        EXAMPLES::

            sage: list(ModularForms(11, 2).q_echelon_basis(6))
            [1 + 12*q^2 + 12*q^3 + 12*q^4 + 12*q^5 + O(q^6), q - 2*q^2 - q^3 + 2*q^4 + q^5 + O(q^6)]
        """
        prec = 6 if prec is None else int(prec)
        rows, _ = self._echelon_rows(prec)
        return _Basis(_series(r[:prec], prec) for r in rows)

    def echelon_basis(self):
        """The reduced echelon basis of the whole space, as modular forms.

        EXAMPLES::

            sage: list(ModularForms(1, 12).echelon_basis())
            [1 + 196560*q^2 + 16773120*q^3 + 398034000*q^4 + 4629381120*q^5 + O(q^6), q - 24*q^2 + 252*q^3 - 1472*q^4 + 4830*q^5 + O(q^6)]
        """
        rows, work = self._echelon_rows(6)
        out = []
        for r in rows:
            coords = self._coords_of(lambda p, r=r: list(r[:p]) + [_Fr(0)] * max(0, p - len(r)))
            out.append(ModularFormElement(self, coords))
        return _Basis(out)

    def q_integral_basis(self, prec=None):
        """The q-expansions of the basis, in Hermite normal form, of the forms
        in the space with integral coefficients (to the Sturm bound, which
        integrality there implies for all), to precision prec (6 by default).

        EXAMPLES::

            sage: list(CuspForms(37, 2).q_integral_basis(6))
            [q + q^3 - 2*q^4 + O(q^6), q^2 + 2*q^3 - 2*q^4 + q^5 + O(q^6)]
        """
        from sage_all import matrix, ZZ
        from math import lcm
        prec = 6 if prec is None else int(prec)
        R, work = self._echelon_rows(prec)
        d = len(R)
        if not d:
            return _Basis([])
        n = len(R[0])
        piv = [next(j for j, x in enumerate(r) if x) for r in R]
        others = [j for j in range(n) if j not in set(piv)]
        den = 1
        for r in R:
            for x in r:
                den = lcm(den, _Fr(x).denominator)
        # c in Z^d with sum c_i R_i integral: (c, y) [M; den I] = 0, M_ij = den R_i[others_j]
        m = len(others)
        if den == 1 or not m:
            gens = [[int(i == j) for j in range(d)] for i in range(d)]
        else:
            rows = [[int(den * R[i][j]) for j in others] for i in range(d)] + [[den * int(a == b) for b in range(m)] for a in range(m)]
            K = matrix(ZZ, rows).left_kernel().basis_matrix()
            gens = [[int(x) for x in list(K.row(i))[:d]] for i in range(K.nrows())]
        vecs = []
        for c in gens:
            v = [sum(c[i] * R[i][j] for i in range(d)) for j in range(n)]
            vecs.append([int(x) for x in v])
        H = matrix(ZZ, vecs).echelon_form()
        out = [[_Fr(int(x)) for x in H.row(i)] for i in range(H.nrows()) if any(H.row(i))]
        return _Basis(_series(r[:prec], prec) for r in out)

    def eisenstein_series(self):
        """Sage's Eisenstein series of the space: for the nontrivial (real)
        characters psi with cond(psi)^2 | N, in reverse DirichletGroup order,
        E_k^(psi, psi)(q^t) for t | N / cond(psi)^2 in decreasing order; then
        for the trivial character E_k(q^t) (E_2(q) - t E_2(q^t) in weight 2,
        t > 1) for t | N in increasing order; each with a_t = 1.

        EXAMPLES::

            sage: list(ModularForms(11, 2).eisenstein_series())
            [5/12 + q + 3*q^2 + 4*q^3 + 7*q^4 + 6*q^5 + O(q^6)]
            sage: list(ModularForms(9, 2).eisenstein_series())
            [q - 3*q^2 + 7*q^4 - 6*q^5 + O(q^6), 1/12 + q + 3*q^2 + q^3 + 7*q^4 + 6*q^5 + O(q^6), 1/3 + q + 3*q^2 + 4*q^3 + 7*q^4 + 6*q^5 + O(q^6)]
            sage: ModularForms(25, 2).eisenstein_series()  # sagebrush only (Sage: series over QQ(zeta4))
            Traceback (most recent call last):
            ...
            NotImplementedError: Eisenstein series with coefficients in a cyclotomic field (characters of order > 2 mod 25) are not supported yet
        """
        A = self._amb()
        A._check_trivial()
        N, k = A._N, A._k
        if k % 2:
            return _Basis([])
        pairs = []
        for psi in reversed(_real_characters(N)):
            f = int(psi.conductor())
            pairs += [(psi, t) for t in reversed(_divisors(N // (f * f)))]
        pairs += [(None, t) for t in _divisors(N) if k > 2 or t > 1]
        E = A.eisenstein_subspace()
        out = []
        for psi, t in pairs:
            coords = E._coords_of(lambda p, psi=psi, t=t: _eis_series(N, k, psi, t, p))
            out.append(ModularFormElement(E, coords))
        return _Basis(out)

    def cuspidal_submodule(self):
        """The cuspidal subspace (the space itself when it is cuspidal).

        EXAMPLES::

            sage: ModularForms(11, 2).cuspidal_submodule().dimension(), CuspForms(37, 2).cuspidal_submodule().dimension()
            (1, 2)
        """
        if self.is_ambient():
            return self.cuspidal_subspace()
        if self._all_cusp():
            return self
        if self._kind == "Eisenstein subspace":
            return _Subspace(self._A, "Cuspidal subspace", 0)
        raise NotImplementedError("the cuspidal part of %s is not supported yet" % self)

    def eisenstein_submodule(self):
        """The Eisenstein subspace (the space itself when it is one).

        EXAMPLES::

            sage: ModularForms(24, 4).eisenstein_submodule().dimension()
            8
        """
        if self.is_ambient():
            return self.eisenstein_subspace()
        if all(p.startswith("eis") for p in self._parts()):
            return self
        if self._kind == "Cuspidal subspace":
            return _Subspace(self._A, "Eisenstein subspace", 0)
        raise NotImplementedError("the Eisenstein part of %s is not supported yet" % self)


class NewformMethods:
    """Newform's methods loaded on first use (copied onto Newform by
    _sage_modular._load_mfmore; not instantiated)."""

    def coefficient(self, n):
        """The coefficient a_n, n >= 1.

        EXAMPLES::

            sage: f = Newforms(11, names='a')[0]; f.coefficient(7), [f.coefficient(n) for n in range(1, 6)]
            (-2, [1, -2, -1, 2, 1])
        """
        n = int(n)
        if n < 1:
            raise IndexError("n must be a positive integer")
        return self[n]

    def character(self):
        """The character: trivial, for a newform on Gamma0(N).

        EXAMPLES::

            sage: Newforms(11, names='a')[0].character()
            Dirichlet character modulo 11 of conductor 1 mapping 2 |--> 1
        """
        return DirichletGroup(self.level())[0]

    def padded_list(self, n):
        """[a_0, a_1, ..., a_(n-1)] (a_0 = 0).

        EXAMPLES::

            sage: Newforms(11, names='a')[0].padded_list(6)
            [0, 1, -2, -1, 2, 1]
        """
        n = int(n)
        if n <= 0:
            return []
        return [0] + list(self.coefficients(n - 1)) if n > 1 else [0]

    def qexp(self, prec=6):
        """The q-expansion to precision prec (q_expansion).

        EXAMPLES::

            sage: Newforms(11, names='a')[0].qexp(6)
            q - 2*q^2 - q^3 + 2*q^4 + q^5 + O(q^6)
        """
        return self.q_expansion(prec)

    def _cm_disc(self):
        # the fundamental discriminant D < 0 with |D| | N for which f is its
        # own twist by chi_D: a_p = 0 at every prime p, chi_D(p) = -1, up to
        # the Sturm bound of level N D^2 (twisting raises the level to at
        # most that); None for none
        if getattr(self, "_cmd", 0) != 0:
            return self._cmd
        N, k = self.level(), self.weight()
        found = None
        for a in _divisors(N):
            D = -a
            if not _fundamental(D):
                continue
            B = _sturm_bound(N * D * D, k)
            coeffs = self.coefficients(B)
            ok = True
            for p in _primes_upto(B):
                if N % p and _kronecker(D, p) == -1 and coeffs[p - 1] != 0:
                    ok = False
                    break
            if ok:
                found = D
                break
        self._cmd = found
        return found

    def has_cm(self):
        """Whether f has complex multiplication.

        EXAMPLES::

            sage: Newforms(11, names='a')[0].has_cm(), Newforms(27, names='b')[0].has_cm()
            (False, True)
        """
        return self._cm_disc() is not None

    def cm_discriminant(self):
        """The discriminant of the CM field (ValueError if there is none).

        EXAMPLES::

            sage: Newforms(27, names='b')[0].cm_discriminant()
            -3
        """
        D = self._cm_disc()
        if D is None:
            raise ValueError("Not a CM form")
        from sage_all import Integer
        return Integer(D)

    def atkin_lehner_eigenvalue(self, d=None):
        """The eigenvalue of W_d, d | N (N by default): the product over
        p | d of eps_p = -a_p / p^(k/2 - 1), for p exactly dividing N.

        EXAMPLES::

            sage: Newforms(11, names='a')[0].atkin_lehner_eigenvalue(), Newforms(37, names='c')[0].atkin_lehner_eigenvalue()
            (-1, 1)
            sage: Newforms(27, names='b')[0].atkin_lehner_eigenvalue()  # sagebrush only
            Traceback (most recent call last):
            ...
            NotImplementedError: Atkin-Lehner eigenvalues at p with p^2 | N (here p = 3) are not supported yet
        """
        from sage_all import Integer
        N, k = self.level(), self.weight()
        d = N if d is None else int(d)
        if d <= 0 or N % d:
            raise ValueError("d should divide N")
        eps = 1
        for p, _ in _factor(d):
            if (N // p) % p == 0:
                raise NotImplementedError("Atkin-Lehner eigenvalues at p with p^2 | N (here p = %d) are not supported yet" % p)
            a = _Fr(str(self[p]))
            eps *= -a / _Fr(p) ** (k // 2 - 1)
        return Integer(int(eps))
