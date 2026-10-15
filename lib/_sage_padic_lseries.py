"""p-adic L-series of elliptic curves over Q, as Sage's E.padic_lseries(p):
the ordinary and multiplicative cases (supersingular primes: not yet).

The layer follows W. Stein and C. Wuthrich, "Algorithms for the arithmetic
of elliptic curves using Iwasawa theory", Math. Comp. 82 (2013),
1757-1792, section 3 (and Mazur, Tate and Teitelbaum, Invent. Math. 84
(1986), I.10-14).  Sage serves only as a black-box oracle.

* The measure on Z_p^*:
      mu(a + p^k Z_p) = alpha^-k [a/p^k]^+ - alpha^-(k+1) [a/p^(k-1)]^+
  for good reduction, alpha^-k [a/p^k]^+ for multiplicative reduction
  (alpha = a_p = +-1), with [r]^+ = lambda^+(r)/Omega_E the exact modular
  symbols of E.modular_symbol() (lib/_sage_modular.py, engine
  modsym/ec_map.rs) and alpha the unit root of x^2 - a_p x + p.
* The series: L_p(E, T) is the limit of the Riemann sums
      P_n(T) = sum_(a=1)^(p-1) sum_(j=0)^(p^(n-1)-1)
               mu(omega(a) (1+p)^j + p^n Z_p) (1+T)^j
  (omega the Teichmuller character, T = (1+p)^(s-1) - 1).
* The precision: with c such that p^c [a/p^k]^+ is integral for all a, k
  (pAdicLseriesOrdinary._c: proven from the cycle lattice of the
  modular symbol map, then raised to ord_p #E(Q)_tors as Sage does), the
  coefficient of T^j (j >= 1) of P_n is known to absolute precision
  e_(n-1,j) - c, e_(n-1,j) = min_(1<=i<=j) ord_p binomial(p^(n-1), i)
  (Stein-Wuthrich, Proposition 3.5), and the series is cut at the first j
  with e_(n-1,j) = 0.  The constant term, the same for every n (ibid.),
  is reported to absolute precision n + 2 - c, and the coefficients lie
  in Qp(p, n + 4 - c), as Sage reports them.  Trailing coefficients whose
  measure values are all 0 at that field's precision are left out, as
  Sage leaves them out.
* p = 2 and supersingular primes: NotImplementedError for now.
"""

from fractions import Fraction as _F


def _sa():
    import sage_all
    return sage_all


def _is_prime(n):
    return n > 1 and all(n % d for d in range(2, int(n ** 0.5) + 1))


def _vp(x, p):
    """ord_p of a nonzero int or Fraction."""
    x = _F(x)
    v = 0
    a, b = x.numerator, x.denominator
    while a % p == 0:
        a //= p
        v += 1
    while b % p == 0:
        b //= p
        v -= 1
    return v


def _integer(v):
    """v as an int when it is an integer (an int, an integral float or
    rational, as Sage converts them); TypeError otherwise, never a
    truncation (int(1.9) would be 1)."""
    if isinstance(v, bool):
        return int(v)
    if isinstance(v, int):
        return int(v)
    if isinstance(v, float):
        if v.is_integer():
            return int(v)
        raise TypeError("Attempt to coerce non-integral RealNumber to Integer")
    try:
        q = _F(v)
    except (TypeError, ValueError):
        raise TypeError("unable to convert %r to an integer" % (v,))
    if q.denominator != 1:
        raise TypeError("no conversion of this rational to integer")
    return int(q.numerator)


def _binomial(n, k):
    from math import comb
    return comb(n, k)


def padic_lseries(E, p, normalize=None, implementation="eclib", precision=None):
    """The p-adic L-series of E (see E.padic_lseries).

    The options are Sage's.  implementation 'eclib' (the default: the
    modular symbols are eclib's, see E.modular_symbol()); 'sage', 'num' and
    'pollackstevens' raise NotImplementedError ('pollackstevens' without a
    precision ValueError first, as in Sage).  normalize None or 'L_ratio'
    (the same normalization); 'period' and 'none' raise
    NotImplementedError.  precision is only used by 'pollackstevens', so
    it is ignored otherwise, as in Sage.  p must be a prime: an integral
    float or rational is taken as that integer, anything else is not a
    prime.

    EXAMPLES::

        sage: EllipticCurve('14a1').padic_lseries(7).series(2)
        O(7^4) + (4 + O(7))*T + (2 + O(7))*T^2 + (5 + O(7))*T^3 + (1 + O(7))*T^4 + O(T^5)
        sage: EllipticCurve('11a1').padic_lseries(4)
        Traceback (most recent call last):
        ...
        ArithmeticError: p must be prime
        sage: EllipticCurve('50a1').padic_lseries(5)
        Traceback (most recent call last):
        ...
        NotImplementedError: p (=5) must be a prime of semi-stable reduction
        sage: EllipticCurve('11a1').padic_lseries(3.9)
        Traceback (most recent call last):
        ...
        ArithmeticError: p must be prime
        sage: EllipticCurve('11a1').padic_lseries(3, normalize='bogus')
        Traceback (most recent call last):
        ...
        ValueError: normalize should be one of 'L_ratio', 'period' or 'none'
    """
    if not isinstance(implementation, str) or implementation not in ("sage", "eclib", "num", "pollackstevens"):
        raise ValueError("Implementation should be one of  'sage', 'eclib', 'num' or 'pollackstevens'")
    if implementation == "pollackstevens" and precision is None:
        raise ValueError("Must specify precision when using 'pollackstevens'")
    if implementation != "eclib":
        raise NotImplementedError("implementation=%r is not available in sagebrush yet (the modular symbols are eclib's: implementation='eclib')" % (implementation,))
    if normalize is not None and (not isinstance(normalize, str) or normalize not in ("L_ratio", "period", "none")):
        raise ValueError("normalize should be one of 'L_ratio', 'period' or 'none'")
    if normalize in ("period", "none"):
        raise NotImplementedError("normalize=%r is not available in sagebrush yet (only 'L_ratio')" % (normalize,))
    if isinstance(p, str):
        raise TypeError("p must be an integer, not a string")
    try:
        p = _integer(p)
    except TypeError:
        raise ArithmeticError("p must be prime")
    if not _is_prime(p):
        raise ArithmeticError("p must be prime")
    Em = E.minimal_model()
    N = int(Em.conductor())
    if p == 2:
        raise NotImplementedError("2-adic L-series are not available in sagebrush yet")
    if N % (p * p) == 0:
        raise NotImplementedError("p (=%d) must be a prime of semi-stable reduction" % p)
    ap = int(Em.ap(p))
    if N % p != 0 and ap % p == 0:
        return pAdicLseriesSupersingular(E, p)
    return pAdicLseriesOrdinary(E, p)


class pAdicLseriesOrdinary:
    """The p-adic L-series of an elliptic curve over Q at a prime of good
    ordinary or multiplicative reduction.

    EXAMPLES::

        sage: L = EllipticCurve('11a1').padic_lseries(5); L
        5-adic L-series of Elliptic Curve defined by y^2 + y = x^3 - x^2 - 10*x - 20 over Rational Field
        sage: L.series(4)
        5 + 4*5^2 + 4*5^3 + O(5^5) + (4*5 + O(5^2))*T + (5 + O(5^2))*T^2 + (4*5 + O(5^2))*T^3 + (3*5 + O(5^2))*T^4 + O(T^5)
    """

    def __init__(self, E, p):
        self._E = E
        self._Em = E.minimal_model()
        self._p = p
        self._N = int(self._Em.conductor())
        self._ap = int(self._Em.ap(p))
        self._good = self._N % p != 0
        self._ms = self._Em.modular_symbol()
        self._cbound = None

    def __repr__(self):
        return "%d-adic L-series of %r" % (self._p, self._E)

    def prime(self):
        """p.

        EXAMPLES::

            sage: EllipticCurve('11a1').padic_lseries(5).prime()
            5
        """
        return _sa().Integer(self._p)

    def elliptic_curve(self):
        """The curve.

        EXAMPLES::

            sage: EllipticCurve('11a1').padic_lseries(5).elliptic_curve()
            Elliptic Curve defined by y^2 + y = x^3 - x^2 - 10*x - 20 over Rational Field
        """
        return self._E

    def is_ordinary(self):
        """Whether p is ordinary for E (good reduction, a_p prime to p;
        multiplicative primes count as ordinary).

        EXAMPLES::

            sage: EllipticCurve('11a1').padic_lseries(5).is_ordinary()
            True
        """
        return True

    def is_supersingular(self):
        """Whether p is supersingular for E.

        EXAMPLES::

            sage: EllipticCurve('11a1').padic_lseries(5).is_supersingular()
            False
        """
        return False

    def teichmuller(self, prec):
        """The Teichmuller lifts of 0, 1, ..., p - 1 modulo p^prec, as
        integers.

        EXAMPLES::

            sage: EllipticCurve('11a1').padic_lseries(5).teichmuller(5)
            [0, 1, 2057, 1068, 3124]
        """
        from _padic import Padic
        prec = _integer(prec)
        if prec < 0:
            raise ValueError("prec_cap must be nonnegative")
        if prec == 0:
            raise ValueError("not enough precision to determine Teichmuller representative")
        return [_sa().Integer(Padic.teichmuller(self._p, a, prec)) for a in range(self._p)]

    def _alpha_int(self, prec):
        """alpha modulo p^prec, an int: the unit root of x^2 - a_p x + p
        (Hensel, from a_p mod p), or a_p for multiplicative reduction."""
        p, m = self._p, self._p ** prec
        if not self._good:
            return self._ap % m
        x = self._ap % p
        k = 1
        while k < prec:
            k = min(2 * k, prec)
            mk = p ** k
            f = (x * x - self._ap * x + p) % mk
            df = (2 * x - self._ap) % mk
            x = (x - f * pow(df, -1, mk)) % mk
        return x % m

    def alpha(self, prec=20):
        """The root alpha of x^2 - a_p x + p that is a p-adic unit (a_p for
        multiplicative reduction), to precision prec.

        EXAMPLES::

            sage: EllipticCurve('11a1').padic_lseries(5).alpha(10)
            1 + 4*5 + 3*5^2 + 2*5^3 + 4*5^4 + 4*5^5 + 4*5^6 + 3*5^7 + 2*5^8 + 3*5^9 + O(5^10)
        """
        prec = _integer(prec)
        if prec < 0:
            raise ValueError("prec_cap must be nonnegative")
        if prec == 0:
            return _sa().Zp(self._p, 1)(0, 0)
        return _sa().Zp(self._p, prec)(self._alpha_int(prec), prec)

    def modular_symbol(self, r, sign=+1, quadratic_twist=+1):
        """The modular symbol of E at r (E.modular_symbol()'s, Sage's
        normalization).

        EXAMPLES::

            sage: EllipticCurve('11a1').padic_lseries(5).modular_symbol(1/5)
            6/5
        """
        if sign != 1 or quadratic_twist != 1:
            raise NotImplementedError("modular symbols of sign -1 or twisted are not available in sagebrush yet")
        return self._ms(r)

    def _plus(self, cusps):
        """Stein-Wuthrich's [a/b]^+ for the cusps (a, b), as Fractions."""
        scale, zero = self._ms._normalization()
        _, vals = self._ms._raw(cusps)
        return [scale * (v - zero) for v in vals]

    def _c(self):
        """A bound c with p^c [a/p^k]^+ integral at p for every a and k >= 0
        (so p^c P_n(T) is integral for every n: Stein-Wuthrich, Lemma 3.6),
        raised to ord_p #E(Q)_tors where that is larger, as Sage reports.

        The paths {0, a/p^k} are closed on X_0(N) when p does not divide N
        (a/p^k is Gamma0(N)-equivalent to 0), and so are {1/p, a/p^k} for
        k >= 1 when p || N (one cusp class): so [a/p^k]^+ lies in [0]^+ or
        [1/p]^+ plus the image of H_1(X_0(N), Z), which the engine gives
        exactly (engine/modsym/src/cycles.rs)."""
        if self._cbound is None:
            p = self._p
            scale, zero = self._ms._normalization()
            cusps = [(0, 1)] if self._good else [(0, 1), (1, p)]
            _, vals = self._ms._raw(cusps)
            gens = [scale * (v - zero) for v in vals] + [scale * self._ms._cycles]
            c = max([0] + [-_vp(x, p) for x in gens if x])
            self._cbound = max(c, _vp(int(self._Em.torsion_order()), p))
        return self._cbound

    def measure(self, a, n, prec, quadratic_twist=+1, sign=+1):
        """mu(a + p^n Z_p), in Qp(p, prec) (alpha to precision prec), for
        integers a, n >= 1 and prec >= 1 (a non-integral a raises TypeError:
        Sage reads a rational a as the cusp a/p^n, which is not a measure).

        EXAMPLES::

            sage: EllipticCurve('11a1').padic_lseries(5).measure(2, 2, 5)
            2*5 + 4*5^2 + 3*5^3 + O(5^4)
        """
        if sign != 1 or quadratic_twist != 1:
            raise NotImplementedError("twisted or sign -1 measures are not available in sagebrush yet")
        sa = _sa()
        p, n, prec = self._p, _integer(n), _integer(prec)
        if n < 1:
            raise ValueError("n (=%s) must be a positive integer" % n)
        if prec < 1:
            raise ValueError("prec (=%s) must be a positive integer" % prec)
        K = sa.Qp(p, prec)
        al = K(self.alpha(prec))
        a = _integer(a)
        if self._good:
            A, B = self._plus([(a, p ** n), (a, p ** (n - 1))])
            # (paper's [r]^+ times the number of components: Sage's measure)
            cinf = self._ms._components()
            return K(A * cinf) * al ** (-n) - K(B * cinf) * al ** (-(n + 1))
        A, = self._plus([(a, p ** n)])
        return K(A * self._ms._components()) * al ** (-n)

    def _riemann(self, n, nterms):
        """The coefficients of P_n(T) up to T^(nterms-1), as (S_j ints mod
        p^K, K, the common rational scale): the true coefficient is
        scale * T_j with T_j = alpha^-n U_j - alpha^-(n+1) V_j, U_j and V_j
        integers (sums of the map's integer values) and alpha a p-adic unit,
        so T_j is a p-adic integer and S_j = T_j mod p^K.  Hence
        scale * S_j = the coefficient + O(p^(K + v)), v = ord_p(scale), and
        series() reports precisions at most n + 2 - c: K is chosen with
        K + v >= n + 2 - c (and K >= n + 6), so the reduction never limits
        them (a bound read off the actual scale, not assumed)."""
        from _padic import Padic
        p = self._p
        scale, zero = self._ms._normalization()
        v = _vp(scale, p) if scale else 0
        K = max(n + 6, n + 2 - self._c() - v)
        m = p ** K
        pn, pn1 = p ** n, p ** (n - 1)
        teich = [Padic.teichmuller(p, a, n) for a in range(p)]
        gamma = 1 + p
        xs = []
        g = 1
        for j in range(pn1):
            for a in range(1, p):
                xs.append(teich[a] * g % pn)
            g = g * gamma % pn
        cusps = [(x, pn) for x in xs]
        if self._good:
            cusps += [(x % pn1, pn1) for x in xs]
        _, vals = self._ms._raw(cusps)
        ainv = pow(self._alpha_int(K), -1, m)
        an, an1 = pow(ainv, n, m), pow(ainv, n + 1, m)
        nx = len(xs)
        # each coefficient from the symbols at p^n and at p^(n-1); it is
        # None (an exact zero, as Sage has it) when every measure value of
        # every j >= i is 0 at the relative precision n + 4 - c of the
        # coefficient field, which happens only for a tail of them
        u, v = [], []
        top = -1
        W = n + 4 - self._c()
        for j in range(pn1):
            t0, t1 = j * (p - 1), (j + 1) * (p - 1)
            a = [vals[t] - zero for t in range(t0, t1)]
            b = [vals[nx + t] - zero for t in range(t0, t1)] if self._good else [0] * len(a)
            if any(self._mu_nonzero(x, y, n, W) for x, y in zip(a, b)):
                top = j
            u.append(sum(a))
            v.append(sum(b))
        S = []
        for i in range(nterms):
            U = sum(_binomial(j, i) * u[j] for j in range(i, pn1))
            V = sum(_binomial(j, i) * v[j] for j in range(i, pn1))
            S.append(None if i > top else (an * U - an1 * V) % m)
        return S, K, scale

    def _mu_nonzero(self, a, b, n, W):
        """Whether alpha^-n a - alpha^-(n+1) b (a, b integers in the map's
        units) is nonzero at relative precision W of its terms."""
        if a == 0 and b == 0:
            return False
        if not self._good:
            return True
        p = self._p
        vmin = min(_vp(x, p) for x in (a, b) if x)
        k = W + vmin
        if k <= 0:
            return False
        m = p ** k
        ainv = pow(self._alpha_int(k), -1, m)
        return (pow(ainv, n, m) * a - pow(ainv, n + 1, m) * b) % m != 0

    def series(self, n=2, quadratic_twist=+1, prec=5, eta=0):
        """The p-adic L-series L_p(E, T) to the n-th approximation, as a
        power series in T over Qp: the Riemann sum P_n(T) of Stein and
        Wuthrich (Math. Comp. 82 (2013), section 3), each coefficient to
        the precision their Proposition 3.5 proves.

        EXAMPLES::

            sage: L = EllipticCurve('11a1').padic_lseries(3)
            sage: L.series(3)
            2 + 3 + 3^2 + 2*3^3 + O(3^5) + (1 + 3 + O(3^2))*T + (1 + 2*3 + O(3^2))*T^2 + O(3)*T^3 + O(3)*T^4 + O(T^5)
            sage: EllipticCurve('389a1').padic_lseries(5).series(2)
            O(5^4) + O(5)*T + (4 + O(5))*T^2 + (2 + O(5))*T^3 + (3 + O(5))*T^4 + O(T^5)
        """
        if quadratic_twist != 1 or eta != 0:
            raise NotImplementedError("twisted p-adic L-series (quadratic_twist, eta) are not available in sagebrush yet")
        sa = _sa()
        if isinstance(prec, float):
            raise TypeError("%r cannot be interpreted as an integer" % (prec,))
        p, n, prec = self._p, _integer(n), _integer(prec)
        if n < 1:
            raise ValueError("n (=%s) must be a positive integer" % n)
        if prec < 1:
            raise ValueError("Insufficient precision (%s)" % prec)
        c = self._c()
        # e_(n-1,j) and where the series stops (the first j with e = 0)
        pn1 = p ** (n - 1)
        es = [None]
        e = None
        for j in range(1, prec):
            b = _vp(_binomial(pn1, j), p)
            e = b if e is None else min(e, b)
            if e == 0:
                break
            es.append(e)
        nterms = len(es)
        S, K, scale = self._riemann(n, nterms)
        # (_riemann's K is enough: K + ord_p(scale) >= n + 2 - c, the
        # largest absolute precision below)
        assert scale == 0 or K + _vp(scale, p) >= n + 2 - c
        R = sa.Qp(p, n + 4 - c)
        # trailing coefficients that are exact zeros are dropped (Sage does
        # not show them as O(p^k)*T^j); the others carry their precision
        # even when their value is zero
        last = nterms - 1
        while last > 0 and S[last] is None:
            last -= 1
        coeffs = []
        for j in range(last + 1):
            absprec = (n + 2 - c) if j == 0 else (es[j] - c)
            val = 0 if S[j] is None else _F(S[j]) * scale
            coeffs.append(R(val, absprec))
        PS = sa.PowerSeriesRing(R, "T", default_prec=prec)
        return PS(coeffs, nterms)

    power_series = series

    def order_of_vanishing(self):
        """The order of vanishing of L_p(E, T) at T = 0, proven: it is at
        least the rank r of E(Q) (Kato's divisibility of L_p(E, T) by the
        characteristic series f_E(T), Kato, Asterisque 295 (2004), Thm 17.4,
        whose order at T = 0 is at least r by Schneider and Perrin-Riou: see
        Stein and Wuthrich, Math. Comp. 82 (2013), Thms 6.1, 7.3 and 7.4),
        and at most r once the coefficient of T^r of some approximation
        P_n(T) is nonzero at its proven precision.  The rank is E.rank()'s
        (proven, or NotImplementedError).  If that coefficient stays 0 at the
        precisions tried, NotImplementedError: the order would exceed the
        rank only if Sha(E/Q)[p^oo] were infinite or the p-adic height
        pairing degenerate.  Good ordinary primes only, as in Sage.

        EXAMPLES::

            sage: EllipticCurve('11a1').padic_lseries(3).order_of_vanishing()
            0
            sage: EllipticCurve('37a1').padic_lseries(5).order_of_vanishing()
            1
            sage: EllipticCurve('389a1').padic_lseries(3).order_of_vanishing()
            2
        """
        if not self._good:
            raise ValueError("prime must be of good reduction")
        p = self._p
        r = int(self._Em.rank())
        n = 2
        while (p - 1) * p ** (n - 1) <= 200000:
            cs = self.series(n, prec=r + 1).list()
            for i, x in enumerate(cs[:r + 1]):
                if not x.is_zero():
                    if i < r:
                        raise ArithmeticError("the coefficient of T^%d of the %d-adic L-series is nonzero but the rank is %d (Kato's theorem)" % (i, p, r))
                    return _sa().Integer(r)
            n += 1
        raise NotImplementedError("the coefficient of T^%d of the %d-adic L-series is 0 to the precision reached (n = %d); the order of vanishing exceeds the rank %d only if Sha(E/Q)[%d^oo] is infinite or the %d-adic height pairing is degenerate" % (r, p, n - 1, r, p, p))


class pAdicLseriesSupersingular(pAdicLseriesOrdinary):
    """The p-adic L-series of an elliptic curve over Q at a prime p >= 3 of
    good supersingular reduction (p | a_p, so a_p = 0 for p >= 5 and a_p
    = 0 or +-3 for p = 3): L_alpha(E, T), alpha the root of x^2 - a_p x + p
    named alpha (both roots have valuation 1/2; Sage's choice), with
    coefficients in the Eisenstein extension Qp(alpha) (lib/_sage_padic_ext.py).

    The precision.  The measure, its Riemann sums P_n(T) and Stein and
    Wuthrich's Lemma 3.2, Corollary 3.3, Lemma 3.4 and Proposition 3.5
    (Math. Comp. 82 (2013), section 3) hold for this measure as for an
    ordinary one: they use only the distribution property and coefficients
    in the ring of integers of a finite extension of Qp.  So a_(n+1,0) =
    a_(n,0) (the constant term is exact) and ord_p(a_(m+1,j) - a_(m,j)) >=
    e_(m-1,j) - max(c_m, c_(m+1)).  What changes is that the c_m are not
    bounded: mu(b + p^m Zp) = alpha^-m [b/p^m]^+ - alpha^-(m+1) [b/p^(m-1)]^+
    (times the number of real components, a unit for p odd), so with p^c
    [r]^+ integral (c as for the ordinary series, from [0]^+ and the cycle
    lattice) every coefficient of P_m, a sum of such values times
    binomials, has ord_p >= -(m+1)/2 - c: c_m <= (m+1)/2 + c.  And
    e_(m,j) >= e_(m-1,j) + 1 (v_p(binomial(p^m, i)) = m - v_p(i) for
    1 <= i <= p^m, Kummer).  So e_(m-1,j) - (m+2)/2 - c increases with m,
    and summing the differences from m = n on gives, for j >= 1,

        ord_p(a_j - a_(n,j)) >= e_(n-1,j) - (n+2)/2 - c,

    that is 2 e_(n-1,j) - n - 2 - 2c in powers of alpha.  The coefficients
    are reported to that precision, or to Sage's smaller one where Sage
    reports less (cap - n - 1, cap the precision cap of Sage's coefficient
    field Qp(p, ceil((n+2)/2))(alpha); 2n - 4 for the constant term), as
    Sage reports them.

    EXAMPLES::

        sage: L = EllipticCurve('11a1').padic_lseries(19); L
        19-adic L-series of Elliptic Curve defined by y^2 + y = x^3 - x^2 - 10*x - 20 over Rational Field
        sage: L.is_supersingular(), L.alpha(5)
        (True, alpha + O(alpha^11))
    """

    def is_ordinary(self):
        """False.

        EXAMPLES::

            sage: EllipticCurve('11a1').padic_lseries(19).is_ordinary()
            False
        """
        return False

    def is_supersingular(self):
        """True.

        EXAMPLES::

            sage: EllipticCurve('11a1').padic_lseries(19).is_supersingular()
            True
        """
        return True

    def _field(self, prec):
        """Qp(p, prec)(alpha), alpha^2 - a_p alpha + p = 0."""
        import _sage_padic_ext
        return _sage_padic_ext._extension(_sa().Qp(self._p, prec), -self._ap, self._p, "alpha", "x")

    def alpha(self, prec=20):
        """alpha, a root of x^2 - a_p x + p, in Qp(p, prec)(alpha).

        EXAMPLES::

            sage: EllipticCurve('11a1').padic_lseries(19).alpha(5)
            alpha + O(alpha^11)
        """
        prec = _integer(prec)
        if prec < 1:
            raise ValueError("prec_cap must be positive")
        return self._field(prec).gen()

    def _value(self, F, U, V, n, absprec=None):
        """The element alpha^-n U - alpha^-(n+1) V (U, V rationals) of F,
        exactly, then to absolute precision absprec (relative cap if
        None)."""
        import _sage_padic_ext as X
        E = F._E
        ia, ib = E.inverse(0, 1)
        a, b = 1, 0
        for _ in range(n):
            a, b = E.mul(a, b, ia, ib)
        # alpha^-n (U - V alpha^-1)
        va, vb = E.mul(ia, ib, _F(V), 0)
        x, y = E.mul(a, b, _F(U) - va, -vb)
        if x == 0 and y == 0 and absprec is not None:
            # a zero known to absprec, not an exact zero (Sage: O(alpha^2))
            return F._element(X._Val(absprec, 0, 0, 0))
        return F._element(X._make(E, x, y, absprec, F._prec))

    def measure(self, a, n, prec, quadratic_twist=+1, sign=+1):
        """mu(a + p^n Z_p) in Qp(p, prec)(alpha), for integers a, n >= 1 and
        prec >= 1, to the relative precision cap (it is exact).

        EXAMPLES::

            sage: EllipticCurve('11a1').padic_lseries(19).measure(1, 2, 5)
            6*alpha^-3 + 3*alpha^-2 + 6*alpha^-1 + 4 + 6*alpha + 4*alpha^2 + 6*alpha^3 + 4*alpha^4 + 6*alpha^5 + 4*alpha^6 + O(alpha^7)
            sage: EllipticCurve('37a1').padic_lseries(3).measure(2, 3, 4)
            2*alpha^-4 + 2*alpha^-3 + alpha^-2 + O(alpha^4)
        """
        if sign != 1 or quadratic_twist != 1:
            raise NotImplementedError("twisted or sign -1 measures are not available in sagebrush yet")
        p, n, prec = self._p, _integer(n), _integer(prec)
        if n < 1:
            raise ValueError("n (=%s) must be a positive integer" % n)
        if prec < 1:
            raise ValueError("prec (=%s) must be a positive integer" % prec)
        a = _integer(a)
        A, B = self._plus([(a, p ** n), (a, p ** (n - 1))])
        # (times the number of real components, as Sage's measure, here as
        # for ordinary primes; its supersingular series leaves it out)
        cinf = self._ms._components()
        return self._value(self._field(prec), A * cinf, B * cinf, n)

    def _sums(self, n, nterms):
        """(U_j, V_j) for j < nterms: P_n's coefficient of T^j is
        alpha^-n U_j - alpha^-(n+1) V_j (rationals, Sage's normalization)."""
        from _padic import Padic
        p = self._p
        scale, zero = self._ms._normalization()
        # (Sage's supersingular series uses Stein and Wuthrich's [r]^+, with
        # no factor for the real components, unlike its ordinary one: 37a1
        # at p = 17)
        cinf = 1
        pn, pn1 = p ** n, p ** (n - 1)
        teich = [Padic.teichmuller(p, a, n) for a in range(p)]
        xs, g = [], 1
        for j in range(pn1):
            for a in range(1, p):
                xs.append(teich[a] * g % pn)
            g = g * (1 + p) % pn
        cusps = [(x, pn) for x in xs] + [(x % pn1, pn1) for x in xs]
        _, vals = self._ms._raw(cusps)
        nx = len(xs)
        u, v = [], []
        for j in range(pn1):
            t0, t1 = j * (p - 1), (j + 1) * (p - 1)
            u.append(sum(vals[t] - zero for t in range(t0, t1)))
            v.append(sum(vals[nx + t] - zero for t in range(t0, t1)))
        out = []
        for i in range(nterms):
            U = sum(_binomial(j, i) * u[j] for j in range(i, pn1))
            V = sum(_binomial(j, i) * v[j] for j in range(i, pn1))
            out.append((scale * cinf * U, scale * cinf * V))
        return out

    def series(self, n=3, quadratic_twist=+1, prec=5, eta=0):
        """L_alpha(E, T) to the n-th approximation P_n(T), each coefficient
        to the precision proven in the class docstring (or Sage's smaller
        one).

        EXAMPLES::

            sage: L = EllipticCurve('11a1').padic_lseries(19)
            sage: L.series(3)
            4*alpha^-2 + 11*alpha^-1 + 8 + 12*alpha + O(alpha^2) + (4*alpha^-2 + O(alpha^-1))*T + (4*alpha^-2 + O(alpha^-1))*T^2 + (O(alpha^-1))*T^3 + (13*alpha^-2 + O(alpha^-1))*T^4 + O(T^5)

        With prec=1, the exact constant term alone, to the relative cap of
        Qp(19, 20)(alpha)::

            sage: L.series(2, prec=1).list()[0].precision_absolute()
            38

        Coefficients that are zero to their precision are kept, trailing
        ones too, so approximations for different n agree to their common
        precision.  (Sage drops trailing ones, which then read as exact
        zeros, though the coefficient of T below is nonzero.  A series all
        of whose coefficients are zero to their precision prints as O(T^n),
        as Sage prints such series over Qp; its list() keeps them.)::

            sage: L = EllipticCurve('37a1').padic_lseries(3)
            sage: s2, s4 = L.series(2, prec=5), L.series(4, prec=5)
            sage: s2
            O(T^3)
            sage: s2.list()  # sagebrush only
            [O(alpha^0), O(alpha^-2), O(alpha^-2)]
            sage: s4[1]
            alpha^-2 + O(alpha^0)
            sage: all((s2[j] - s4[j]).is_zero() for j in range(3))  # sagebrush only
            True

        Series compare at their common precision.  The coefficient of T^4
        of the n = 3 series is O(alpha^-3), which contains 1 (Sage drops it
        and answers False)::

            sage: s3 = L.series(3, prec=5); T = s3.parent().gen()
            sage: s3 == s3, s3 == s3 + 1
            (True, False)
            sage: s3[4], s3 == s3 + T^4  # sagebrush only
            (O(alpha^-3), True)
        """
        if quadratic_twist != 1 or eta != 0:
            raise NotImplementedError("twisted p-adic L-series (quadratic_twist, eta) are not available in sagebrush yet")
        sa = _sa()
        n, prec = self._check_n_prec(n, prec)
        F, nterms, rows = self._coefficients(n, prec)
        if prec == 1:
            # the constant term alone: it is exact (a_(n+1,0) = a_(n,0)), so
            # it is given to the relative cap of Qp(p, 20)(alpha), as Sage
            (U, V, _), = rows
            x = self._value(F, U, V, n)
            return sa.PowerSeriesRing(F, "T", default_prec=1)([] if x.is_zero() else [x], 1)
        coeffs = [self._value(F, U, V, n, k) for U, V, k in rows]
        # every coefficient is kept with its precision, O(alpha^k) included,
        # trailing ones too (Sage drops trailing ones, which then read as
        # exact zeros: 37a1 at p = 3, n = 2)
        PS = sa.PowerSeriesRing(F, "T", default_prec=prec)
        return PS(coeffs, nterms)

    def _check_n_prec(self, n, prec):
        if isinstance(prec, float):
            raise TypeError("%r cannot be interpreted as an integer" % (prec,))
        n, prec = _integer(n), _integer(prec)
        if n < 2:
            raise ValueError("n (=%s) must be at least 2 at a supersingular prime" % n)
        if prec < 1:
            raise ValueError("Insufficient precision (%s)" % prec)
        return n, prec

    def _coefficients(self, n, prec):
        """(F, nterms, rows): P_n's coefficient of T^j is alpha^-n U_j -
        alpha^-(n+1) V_j (exact rationals), proven to absolute alpha-adic
        precision k_j (the class docstring's bound, or Sage's smaller one);
        rows = [(U_j, V_j, k_j)], F the coefficient field.  With prec = 1
        only the constant term, exact (k_0 = None), in Qp(p, 20)(alpha)."""
        p = self._p
        if prec == 1:
            (U, V), = self._sums(n, 1)
            return self._field(20), 1, [(U, V, None)]
        c = self._c()
        pn1 = p ** (n - 1)
        es = [None]
        e = None
        for j in range(1, prec):
            b = _vp(_binomial(pn1, j), p)
            e = b if e is None else min(e, b)
            if e == 0:
                break
            es.append(e)
        nterms = len(es)
        F = self._field(-(-(n + 2) // 2))
        cap = int(F.precision_cap())
        rows = []
        for j, (U, V) in enumerate(self._sums(n, nterms)):
            if j == 0:
                k = min(2 * n - 4, cap - n - 1)
            else:
                k = min(2 * es[j] - n - 2 - 2 * c, cap - n - 1)
            rows.append((U, V, k))
        return F, nterms, rows

    def _pair(self, F, U, V, n):
        """(g, h), rationals with alpha^-n U - alpha^-(n+1) V = g + h alpha."""
        E = F._E
        ia, ib = E.inverse(0, 1)
        a, b = 1, 0
        for _ in range(n):
            a, b = E.mul(a, b, ia, ib)
        va, vb = E.mul(ia, ib, _F(V), 0)
        g, h = E.mul(a, b, _F(U) - va, -vb)
        return _F(g), _F(h)

    power_series = series

    def Dp_valued_series(self, n=3, quadratic_twist=+1, prec=5):
        """The D_p-valued series: v with (1 - phi)^-2 L_p(E, T) = v[0] omega
        + v[1] phi(omega) in the Dieudonne module D_p(E) (Stein and
        Wuthrich, Math. Comp. 82 (2013), 3.5; Sage's normalization).

        With L_alpha(E, T) = G(T) + alpha H(T), L_p(E, T) = (G + a_p H) omega
        - p H phi(omega).  On the basis {omega, phi(omega)} the normalized
        Frobenius phi acts by Phi = [[0, -1/p], [1, a_p/p]], the companion
        matrix of its characteristic polynomial X^2 - (a_p/p) X + 1/p, so

            v = (1 - Phi)^-2 (G + a_p H, -p H),

        an exact rational map (det(1 - Phi) = (p + 1 - a_p)/p, a unit over
        p): no Frobenius matrix is needed.  Precision: a coefficient of
        L_alpha known modulo alpha^k (the bound of series()) is c + delta
        with c exact (the Riemann sum, g + h alpha with rationals g, h) and
        delta in alpha^k O = Z_p alpha^k + Z_p alpha^(k+1); the map is
        linear, so each coordinate of v is known to the least valuation of
        that coordinate of the images of alpha^k and alpha^(k+1).  This is
        sharp coordinate by coordinate (with a_p = 0 it is p^ceil(k/2) for G
        and p^floor(k/2) for H).  The constant terms are exact (a_(n+1,0) =
        a_(n,0)), and (1 - phi)^-2 L_p(E, 0) is a rational multiple of omega
        (interpolation): its phi(omega) coordinate is exactly 0, which is
        checked (an error is raised otherwise).

        EXAMPLES::

            sage: L = EllipticCurve('14a1').padic_lseries(5)
            sage: v = L.Dp_valued_series(3); v[0]
            1 + 4*5 + O(5^2) + (4 + O(5))*T + (1 + O(5))*T^2 + (4 + O(5))*T^3 + (2 + O(5))*T^4 + O(T^5)
            sage: v.parent()
            Ambient free module of rank 2 over the principal ideal domain Power Series Ring in T over 5-adic Field with capped relative precision 3

        Sage prints more digits in the second component than L_alpha's
        precision determines: the coefficients of T, T^2, T^3 of L_alpha are
        known modulo alpha^-1, which leaves the phi(omega) coordinate known
        modulo 5 only (Sage: O(5^2), 4*5 + O(5^2), 2*5 + O(5^2); its
        alpha-adic coefficients read inexact-zero coordinates as exact
        zeros).  The values agree to the proven precision::

            sage: v[1]  # sagebrush only (Sage: O(5^3) + O(5^2)*T + (4*5 + O(5^2))*T^2 + (2*5 + O(5^2))*T^3 + (2 + 3*5 + O(5^2))*T^4 + O(T^5))
            O(5^3) + O(5)*T + O(5)*T^2 + O(5)*T^3 + (2 + O(5))*T^4 + O(T^5)

        With n = 4 Sage prints the second constant term as 5^2 + O(5^3).
        That contradicts its n = 3 value O(5^3) above, and the exact value,
        0 (the phi(omega) coordinate of (1 - phi)^-2 L_p(E, 0)); Sagebrush
        gives the proven O(5^2)::

            sage: L.Dp_valued_series(4)[1][0]  # sagebrush only (Sage: 5^2 + O(5^3))
            O(5^2)
        """
        if quadratic_twist != 1:
            raise NotImplementedError("the D_p-valued series of a quadratic twist is not available in sagebrush yet")
        sa = _sa()
        n, prec = self._check_n_prec(n, prec)
        p, ap = self._p, self._ap
        F, nterms, rows = self._coefficients(n, prec)
        # (1 - Phi)^-2, exactly
        a, b, c, d = _F(1), _F(1, p), _F(-1), 1 - _F(ap, p)   # 1 - Phi
        det = a * d - b * c
        i00, i01, i10, i11 = d / det, -b / det, -c / det, a / det
        M = (i00 * i00 + i01 * i10, i00 * i01 + i01 * i11,
             i10 * i00 + i11 * i10, i10 * i01 + i11 * i11)

        def image(g, h):
            # (g + h alpha) -> the coordinates of (1 - phi)^-2 of its L_p
            x, y = g + ap * h, -p * h
            return M[0] * x + M[1] * y, M[2] * x + M[3] * y

        E = F._E
        K = sa.Qp(p, 20 if prec == 1 else -(-(n + 2) // 2))
        v1, v2 = [], []
        for j, (U, V, k) in enumerate(rows):
            e1, e2 = image(*self._pair(F, U, V, n))
            if j == 0 and e2 != 0:
                raise ArithmeticError("internal error: the phi(omega) coordinate of (1 - phi)^-2 L_p(E, 0) is %s, not 0" % e2)
            if k is None:
                v1.append(K(e1))
                v2.append(K(e2))
                continue
            # the error lies in alpha^k O = Z_p alpha^k + Z_p alpha^(k+1);
            # each coordinate is known to the least valuation of the images
            # of those two generators (sharp, coordinate by coordinate)
            gens = [image(*map(_F, E.shift(1, 0, k))), image(*map(_F, E.shift(1, 0, k + 1)))]
            k1 = min(_vp(t[0], p) for t in gens if t[0])
            k2 = min(_vp(t[1], p) for t in gens if t[1])
            v1.append(K(e1, absprec=k1))
            v2.append(K(e2, absprec=k2))
        PS = sa.PowerSeriesRing(K, "T", default_prec=prec)
        return sa.vector(PS, [PS(v1, nterms), PS(v2, nterms)])

    def frobenius(self, prec=20, algorithm="mw"):
        """Not available yet (Kedlaya's algorithm)."""
        raise NotImplementedError("the Frobenius matrix on de Rham cohomology (Kedlaya's algorithm) is not available in sagebrush yet")

    def order_of_vanishing(self):
        """Not available at supersingular primes (as in Sage)."""
        raise NotImplementedError("the order of vanishing at a supersingular prime is not available")
