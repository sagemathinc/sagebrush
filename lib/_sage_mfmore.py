"""Methods of the spaces of modular forms and of newforms that load on first
use (lib/_sage_modular.py's _QSpace and Newform resolve their names here):
the Hecke bound, the echelon and integral q-expansion bases, the Eisenstein
series, the cuspidal and Eisenstein submodules; a newform's coefficients,
character, CM and Atkin-Lehner eigenvalues.  Values as Sage 10.10 gives
them, observed as a black box."""
from fractions import Fraction as _Fr
from math import gcd as _gcd

from _sage_modular import (_Basis, _series, _sturm_bound, _divisors, _factor, _bernoulli,
                           _Subspace, ModularFormElement, DirichletGroup, _nonneg, _NONTRIVIAL)


# ---- admission, as lib/_sage_modsym.py's (its _Charge, one ledger): each
# entry point runs inside a charge (joining the caller's when there is one)
# and reserves each list of coefficients before it is built, at a bound on
# its bits, settling to its size after (growth past the bound admitted,
# refused past the allowance)

def _work(what):
    import _sage_modsym as ms
    return ms._Charging(ms._CUR[0] or ms._Charge(what))


def _note(ch, step, nbytes):
    """Record a reservation under its step's name on a charge that keeps a
    list ch.steps (the doctests' checks); nothing otherwise."""
    steps = getattr(ch, "steps", None)
    if steps is not None:
        steps.append((step, nbytes))
    return nbytes


def _take_step(ch, step, nbytes):
    # (what the charge took, not what was asked: its growth across the take)
    before = ch.used
    ch.take(nbytes)
    return _note(ch, step, ch.used - before)


def _rows_reserve(ch, rows, cols, bits):
    """Reserve rows x cols rational coefficients of at most bits bits."""
    import _sage_modsym as ms
    return ms._reserve(ch, rows * cols, bits)


def _rows_settle(ch, reserved, rows):
    import _sage_modsym as ms
    d = reserved - sum(ms._row_bytes(r) for r in rows)
    if d >= 0:
        ch.give(d)
    else:
        ch.take(-d)


def _basis_bits(k, prec):
    # (the echelon q-expansion rows come from the space's basis machinery:
    # no a priori bound on their heights; this one, which Deligne's bound
    # d(n) n^((k-1)/2) and a generous denominator allowance give, is an
    # estimate, settled by admission to the rows' real size)
    return (k + 1) * max(prec, 2).bit_length() + 256


def _prec(prec):
    """prec as Sage normalizes it: 6 by default, an integer (Sage's
    TypeError for 2.5 or 5/2), at least 0."""
    if prec is None:
        return 6
    from sage_all import ZZ
    prec = int(ZZ(prec))
    if prec < 0:
        raise ValueError("prec (=%d) must be at least 0" % prec)
    return prec


def _zz_series(coeffs, prec):
    from sage_all import ZZ
    from _sage_series import PowerSeriesRing, Series
    v = next((i for i, x in enumerate(coeffs[:prec]) if x), prec)
    return Series(PowerSeriesRing(ZZ, "q"), v, [ZZ(x) for x in coeffs[v:prec]], prec)


# the integral bases computed, by space: (prec, rows); as in Sage, a request
# at a lower precision truncates the stored basis (even where that loses rank)
_QINT = {}


def _sigma(n, k):
    return sum(d ** k for d in _divisors(n))


def _hadamard_bits(rows):
    """Bits bounding every minor of the integer matrix rows (Hadamard: the
    product of the rows' Euclidean norms), hence the entries of its kernel
    basis and of its Hermite normal form."""
    total = 0
    for r in rows:
        total += (sum(int(x) * int(x) for x in r).bit_length() + 1) // 2
    return total + 1


def _bits_of(r):
    import _sage_modsym as ms
    return ms._maxbits(r)


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


def _zero_subspace(A, kind):
    """The zero subspace of A, printed as a subspace of that kind: no parts,
    so no basis rows (the cuspidal part of an Eisenstein subspace, or the
    reverse)."""
    Z = _Subspace(A, kind, 0)
    Z._parts = lambda: []
    return Z


class QSpaceMethods:
    """The spaces' methods loaded on first use (copied onto _QSpace by
    _sage_modular._load_mfmore; not instantiated).

    Admission: each entry point reserves its coefficients before it builds
    them; with too little memory it is refused, and works again with more::

        sage: import sys  # sagebrush only
        sage: old = getattr(sys, "_sagebrush_heap_limit", None); sys._sagebrush_heap_limit = 4 * 200000  # sagebrush only
        sage: for f in (lambda: ModularForms(11, 2).q_echelon_basis(5000), lambda: ModularForms(144, 2).eisenstein_series(),  # sagebrush only
        ....:           lambda: Newforms(11, names='a')[0].qexp(10**6)):
        ....:     try:
        ....:         f()
        ....:     except MemoryError as e:
        ....:         print(type(e).__name__, e.need_bytes > e.limit_bytes)
        SagebrushMemoryError True
        SagebrushMemoryError True
        SagebrushMemoryError True
        sage: M = ModularForms(11, 2); built = []; rows = M._qrows  # sagebrush only
        sage: M._qrows = lambda p: (built.append(p), rows(p))[1]  # sagebrush only
        sage: try:  # sagebrush only
        ....:     M._echelon_rows(5000)
        ....: except MemoryError as e:
        ....:     print(e.what.split(" of ")[0], built)
        The echelon q-expansion basis []
        sage: sys._sagebrush_heap_limit = old  # sagebrush only
        sage: len(ModularForms(11, 2).q_echelon_basis(8)), len(ModularForms(144, 2).eisenstein_series()), Newforms(11, names='a')[0].qexp(4)  # sagebrush only
        (2, 23, q - 2*q^2 - q^3 + O(q^4))

    The basis rows' producer charges the same ledger: an allowance enough
    for the rows' estimate but not for the engine's traces is refused
    before the engine is asked for them, and caches nothing; the same call
    works with the allowance restored; a cached basis charges the copies it
    hands out; and a basis is published only once its storage is admitted
    (here the allowance is spent as its echelon form starts, so the
    elimination's first reservation is refused, and then just after it)::

        sage: import _sage_modular as sm, _sage_modsym as ms  # sagebrush only
        sage: S = CuspForms(11, 2); P = 3000; S.dimension()  # sagebrush only
        1
        sage: for c in (sm._QBASIS, sm._NEWROWS):  # sagebrush only
        ....:     for key in [key for key in c if key[:2] == (11, 2)]:
        ....:         del c[key]
        sage: import _sage_mfmore as mm; est = P * (ms._SLOT + ms._FRAC + (mm._basis_bits(2, P) + 7) // 8 + 8)  # sagebrush only
        sage: asked = []; engine = sm._mf  # sagebrush only
        sage: class Spy:  # sagebrush only
        ....:     def __getattr__(self, name):
        ....:         if name == "newforms":
        ....:             asked.append(name)
        ....:         return getattr(engine, name)
        sage: sm._mf = Spy(); sys._sagebrush_heap_limit = 4 * (est + P * ms._SLOT)  # sagebrush only
        sage: try:  # sagebrush only
        ....:     S.q_echelon_basis(P)
        ....: except MemoryError as e:
        ....:     print(type(e).__name__, asked, [key for key in sm._QBASIS if key[:2] == (11, 2)], (11, 2) in sm._NEWROWS)
        SagebrushMemoryError [] [] False
        sage: sys._sagebrush_heap_limit = old  # sagebrush only
        sage: len(S.q_echelon_basis(P)), asked[:1], (11, 2, 'cusp') in sm._QBASIS  # sagebrush only
        (1, ['newforms'], True)
        sage: sm._mf = engine  # sagebrush only
        sage: ch = ms._Charge("A check")  # sagebrush only
        sage: with ms._Charging(ch):  # sagebrush only
        ....:     _ = sm._qbasis(11, 2, "cusp", P)
        sage: ch.used >= P * ms._SLOT  # sagebrush only
        True
        sage: sys._sagebrush_heap_limit = 4 * P * ms._SLOT // 2  # sagebrush only
        sage: try:  # sagebrush only
        ....:     sm._qbasis(11, 2, "cusp", P)
        ....: except MemoryError as e:
        ....:     print(type(e).__name__)
        SagebrushMemoryError
        sage: sys._sagebrush_heap_limit = old  # sagebrush only
        sage: del sm._QBASIS[(11, 2, 'cusp')]; real = ms._echelon  # sagebrush only
        sage: def spent(rows, n, before):  # sagebrush only
        ....:     if before:
        ....:         ms._CUR[0].limit = ms._CUR[0].used
        ....:     out = real(rows, n)
        ....:     ms._CUR[0].limit = ms._CUR[0].used
        ....:     return out
        sage: for before in (True, False):  # sagebrush only
        ....:     ms._echelon = lambda rows, n: spent(rows, n, before)
        ....:     try:
        ....:         sm._qbasis(11, 2, "cusp", P)
        ....:     except MemoryError as e:
        ....:         print(type(e).__name__, (11, 2, 'cusp') in sm._QBASIS)
        SagebrushMemoryError False
        SagebrushMemoryError False
        sage: ms._echelon = real  # sagebrush only

    Each reservation, by its step, at least the floor of its stated bound
    (entries times the slot, the Fraction and the bound's bytes): the basis
    rows at >= 256 bits, the Eisenstein rows likewise, a newform's
    coefficients at (k + 1) log2(prec) / 2 bits; the echelon form's
    elimination charges as it goes; q_integral_basis reserves its kernel and
    its Hermite form at Hadamard's bound on their minors (with their working
    copies, half as much again); Hadamard's bound is the product of the rows' norms::

        sage: import _sage_modsym as ms, _sage_mfmore as mm  # sagebrush only
        sage: def steps(f):  # sagebrush only
        ....:     ch = ms._Charge("A check"); ch.steps = []
        ....:     with ms._Charging(ch):
        ....:         f()
        ....:     return {s: max(b for t, b in ch.steps if t == s) for s, _ in ch.steps}
        sage: unit = ms._SLOT + ms._FRAC + 8  # sagebrush only
        sage: s = steps(lambda: ModularForms(11, 2).q_echelon_basis(40))  # sagebrush only
        sage: s["rows"] >= 2 * 40 * (unit + 32), s["echelon"] >= 2 * 40 * ms._SLOT  # sagebrush only
        (True, True)
        sage: s = steps(lambda: ModularForms(144, 2).eisenstein_series())  # sagebrush only
        sage: s["eisenstein rows"] >= ModularForms(144, 2).eisenstein_subspace().dimension() * 51 * (unit + 32)  # sagebrush only
        True
        sage: s = steps(lambda: Newforms(11, names='a')[0].qexp(1000))  # sagebrush only
        sage: s["coefficients"] >= 1000 * (unit + (3 * 10 // 2 + 2) // 8)  # sagebrush only
        True
        sage: s = steps(lambda: ModularForms(35, 2).q_integral_basis(8))  # sagebrush only
        sage: floor = lambda E, H: 3 * E * (ms._SLOT + ms._INT + (H + 7) // 8 + 8) // 2  # sagebrush only
        sage: [s[t] >= floor(*s[t + " bound"]) and s[t + " bound"][1] > 1 for t in ("kernel", "hermite")]  # sagebrush only
        [True, True]
        sage: mm._hadamard_bits([[3, 4]]), mm._hadamard_bits([[3, 4], [0, 8]])  # sagebrush only
        (4, 8)
    """

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
            sage: ModularForms(DirichletGroup(4).0, 3).hecke_bound()  # sagebrush only (Sage: 7)
            Traceback (most recent call last):
            ...
            NotImplementedError: hecke_bound of a space with a nontrivial character is not supported yet
        """
        A = self._amb()
        if A._chi is not None and not A._chi.is_trivial():
            raise NotImplementedError("hecke_bound of a space with a nontrivial character is not supported yet")
        s = self.sturm_bound()
        if self.dimension() == 0:
            # (a zero ambient space: one less; a zero subspace: the Sturm bound)
            return s - 1 if self.is_ambient() else s
        if self._all_cusp():
            return s
        A = self._amb()
        return s + 2 * A.eisenstein_subspace().dimension() + 4

    def _echelon_rows(self, prec):
        work = max(prec, self.sturm_bound() + 2)
        A = self._amb()
        d = self.dimension()
        import _sage_modsym as ms
        with _work("The echelon q-expansion basis of %r to precision %d" % (self, work)) as ch:
            # (the basis rows: at an estimate, settled by admission; their echelon
            # form: by _sage_modsym's integer elimination, each row reserved at
            # a sound bound before it is computed)
            res = _note(ch, "rows", _rows_reserve(ch, d, work, _basis_bits(A._k, work)))
            q = self._qrows(work)
            _rows_settle(ch, res, q)
            before = ch.used
            rows = ms._echelon(q, work)[0] if q else []
            _note(ch, "echelon", ch.used - before)
        return rows, work

    def q_echelon_basis(self, prec=None):
        """The q-expansions of the reduced echelon basis of the whole space
        (not part by part), to precision prec (6 by default).

        EXAMPLES::

            sage: list(ModularForms(11, 2).q_echelon_basis(6))
            [1 + 12*q^2 + 12*q^3 + 12*q^4 + 12*q^5 + O(q^6), q - 2*q^2 - q^3 + 2*q^4 + q^5 + O(q^6)]
        """
        prec = _prec(prec)
        with _work("The echelon q-expansion basis of %r to precision %d" % (self, prec)) as ch:
            rows, _ = self._echelon_rows(prec)
            # (the series: prec coefficients of each row, reserved first)
            res = _rows_reserve(ch, len(rows), prec, max((_bits_of(r) for r in rows), default=0))
            out = _Basis(_series(r[:prec], prec) for r in rows)
            _rows_settle(ch, res, [r[:prec] for r in rows])
        return out

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
        """The q-expansions to precision prec (6 by default), over ZZ, of the
        basis in Hermite normal form of the integral vectors in the span of
        the space's q-expansions truncated at prec, padded with zeros to the
        dimension. From the Sturm bound on these are the forms with integral
        coefficients. As in Sage, a basis computed at a higher precision is
        truncated instead, even where that loses rank.

        EXAMPLES::

            sage: list(CuspForms(37, 2).q_integral_basis(6))
            [q + q^3 - 2*q^4 + O(q^6), q^2 + 2*q^3 - 2*q^4 + q^5 + O(q^6)]
            sage: S = CuspForms(61, 2); list(S.q_integral_basis(6))
            [q - q^5 + O(q^6), q^2 - 2*q^5 + O(q^6), q^3 + q^5 + O(q^6), q^4 + 2*q^5 + O(q^6)]
            sage: _ = S.q_integral_basis(20); list(S.q_integral_basis(6))
            [q + q^4 + q^5 + O(q^6), q^2 - 2*q^5 + O(q^6), q^3 + q^4 + 3*q^5 + O(q^6), 2*q^4 + 4*q^5 + O(q^6)]
            sage: T = CuspForms(73, 2); _ = T.q_integral_basis(30); list(T.q_integral_basis(4))
            [q + q^3 + O(q^4), q^2 + q^3 + O(q^4), 2*q^3 + O(q^4), O(q^4), O(q^4)]
            sage: list(CuspForms(73, 2).q_integral_basis(4))  # the same space, so the same stored basis
            [q + q^3 + O(q^4), q^2 + q^3 + O(q^4), 2*q^3 + O(q^4), O(q^4), O(q^4)]
            sage: b = CuspForms(11, 2).q_integral_basis(5); b[0].parent(), b[0][1].parent()
            (Power Series Ring in q over Integer Ring, Integer Ring)
            sage: CuspForms(11, 2).q_integral_basis(0)[0].parent()
            Power Series Ring in q over Integer Ring
            sage: CuspForms(11, 2).q_integral_basis(-1)
            Traceback (most recent call last):
            ...
            ValueError: prec (=-1) must be at least 0
            sage: CuspForms(11, 2).q_integral_basis(5/2)
            Traceback (most recent call last):
            ...
            TypeError: no conversion of this rational to integer
        """
        prec = _prec(prec)
        with _work("The integral q-expansion basis of %r to precision %d" % (self, prec)) as ch:
            return self._q_integral(prec, ch)

    def _q_integral(self, prec, ch):
        import _sage_modsym as ms
        A = self._amb()
        key = (A._N, A._k, repr(A._chi), tuple(self._parts()), self.dimension())
        have = _QINT.get(key)
        if have is not None and have[0] >= prec:
            # (the copies handed out are this computation's)
            ch.take(len(have[1]) * prec * ms._SLOT)
            out = [r[:prec] for r in have[1]]
        else:
            out = self._q_integral_rows(prec, ch)
            # (kept: admitted before it is published)
            ch.take(sum(ms._row_bytes(r) for r in out))
            _QINT[key] = (prec, out)
        res = _rows_reserve(ch, len(out), prec, max((_bits_of(r) for r in out), default=0))
        series = _Basis(_zz_series(r, prec) for r in out)
        _rows_settle(ch, res, out)
        return series

    def _q_integral_rows(self, prec, ch):
        from sage_all import matrix, ZZ
        from math import lcm
        import _sage_modsym as ms
        E, work = self._echelon_rows(prec)
        # (the echelon rows truncated at prec: still reduced, the nonzero
        # ones a basis of the truncated span)
        R = [r[:prec] for r in E if any(r[:prec])]
        d = len(R)
        pad = [[0] * prec for _ in range(len(E) - d)]
        if not d:
            return pad
        n = prec
        piv = [next(j for j, x in enumerate(r) if x) for r in R]
        others = [j for j in range(n) if j not in set(piv)]
        den = 1
        for r in R:
            for x in r:
                den = lcm(den, _Fr(x).denominator)
        # c in Z^d with sum c_i R_i integral: (c, y) [M; den I] = 0, M_ij = den R_i[others_j]
        m = len(others)
        rb = max((_bits_of(r) for r in R), default=0)
        if den == 1 or not m:
            gens = [[int(i == j) for j in range(d)] for i in range(d)]
        else:
            # (the integer system, reserved before it is built: d + m rows of
            # m entries of at most bits(den) + bits(R) bits; Sage mode's ZZ
            # matrices admit their own storage)
            res = ms._reserve(ch, (d + m) * m, den.bit_length() + rb, frac=False)
            rows = [[int(den * R[i][j]) for j in others] for i in range(d)] + [[den * int(a == b) for b in range(m)] for a in range(m)]
            ms._settle(ch, res, [x for r in rows for x in r])
            # (the kernel's basis and its working copies: at most d + m rows of
            # d + m entries, each a minor of the system, within Hadamard's bound)
            E, H = (d + m) * (d + m), _hadamard_bits(rows)
            _note(ch, "kernel bound", (E, H))
            _take_step(ch, "kernel", 3 * ms._reserve(ch, E, H, frac=False) // 2)
            K = matrix(ZZ, rows).left_kernel().basis_matrix()
            res = ms._reserve(ch, K.nrows() * d, max((abs(int(x)).bit_length() for x in K.list()), default=0), frac=False)
            gens = [[int(x) for x in list(K.row(i))[:d]] for i in range(K.nrows())]
            ms._settle(ch, res, [x for g in gens for x in g])
        vecs = []
        for c in gens:
            # (a sum of d products: the bits of all its terms)
            res = ms._reserve(ch, n, ms._sum_bits([(abs(x).bit_length(), rb) for x in c if x], d), frac=False)
            v = [sum(c[i] * R[i][j] for i in range(d)) for j in range(n)]
            v = [int(x) for x in v]
            ms._settle(ch, res, v)
            vecs.append(v)
        # (the Hermite form and its working copies: entries within Hadamard's bound)
        E, H = len(vecs) * n, _hadamard_bits(vecs)
        _note(ch, "hermite bound", (E, H))
        _take_step(ch, "hermite", 3 * ms._reserve(ch, E, H, frac=False) // 2)
        H = matrix(ZZ, vecs).echelon_form()
        res = ms._reserve(ch, H.nrows() * prec, max((abs(int(x)).bit_length() for x in H.list()), default=0), frac=False)
        out = [[int(x) for x in H.row(i)] for i in range(H.nrows()) if any(H.row(i))]
        ms._settle(ch, res, [x for r in out for x in r])
        return out + pad

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
        prec = E.sturm_bound() + 2
        out = []
        with _work("The Eisenstein series of %r" % (A,)) as ch:
            # (the space's rows the coordinates are solved against, and each
            # series' prec coefficients: |a_n| <= sigma_(k-1)(n) <= n^k, the
            # constant term -B_k / 2k or (t - 1)/24)
            res = _note(ch, "eisenstein rows", _rows_reserve(ch, E.dimension(), prec, _basis_bits(k, prec)))
            for psi, t in pairs:
                r = _rows_reserve(ch, 1, prec, k * prec.bit_length() + abs(_bernoulli(k).numerator).bit_length() + abs(_bernoulli(k).denominator).bit_length() + 2 * k.bit_length() + 8)
                coords = E._coords_of(lambda p, psi=psi, t=t: _eis_series(N, k, psi, t, p))
                _rows_settle(ch, r, [coords])
                out.append(ModularFormElement(E, coords))
            _rows_settle(ch, res, [])
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
            return _zero_subspace(self._A, "Cuspidal subspace")
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
            return _zero_subspace(self._A, "Eisenstein subspace")
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
        chi = self._o._chi
        return chi if chi is not None else DirichletGroup(self.level())[0]

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
        k, p = self.weight(), int(prec)
        # (prec coefficients reserved before they are computed, at Deligne's
        # bound |a_n| <= d(n) n^((k-1)/2), d(n) <= n)
        with _work("The q-expansion of a newform of level %d to precision %d" % (self.level(), p)) as ch:
            res = _note(ch, "coefficients", _rows_reserve(ch, 1, max(p, 1), (k + 1) * max(p, 2).bit_length() // 2 + 2))
            s = self.q_expansion(prec)
            _rows_settle(ch, res, [[0] * max(p - 1, 0)])
        return s

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
        if self._o._chi is not None:
            # (Sage's refusal: the eigenvalue needs a square root it cannot take)
            raise ValueError("Unable to compute square root. Try specifying an embedding into a larger ring")
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
