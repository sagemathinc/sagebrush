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
        """The Frobenius phi on the Dieudonne module D_p(E), in the basis
        omega, eta = x omega: phi^2 - (a_p/p) phi + 1/p = 0 (phi = F/p, F the
        p-power Frobenius of Kedlaya's algorithm), for p >= 5.

        F is computed modulo p^(prec+1) by Kedlaya's algorithm ([K] =
        Kedlaya, J. Ramanujan Math. Soc. 16 (2001), arXiv math/0105031):
        with Y = y + (a1 x + a3)/2, Y^2 = Q(x) = x^3 + (b2/4) x^2 + (b4/2) x +
        b6/4, and omega = dx/(2Y), so the matrix on omega, eta is the one on
        [K]'s basis dx/Y, x dx/Y ([K] section 3: H^1(A; K)^-).  Precision:

        - the Frobenius lift ([K] section 3): 1/Y^sigma = Y^-p sum_k
          binom(-1/2, k) p^k E^k Y^-2pk, p E = Q(x^p) - Q(x)^p; with the
          factor p of F(x^i dx/Y) = p x^(pi+p-1) dx/Y^sigma, the term k is
          divisible by p^(k+1) ([H] = Harrison, arXiv:1006.4206, Lemma 3.4,
          eq. (2));
        - reducing S dx/Y^m to the basis loses at most floor(log_p(m - 2))
          digits ([H] Lemma 3.3(i): [K] Lemma 2 with log_p(2m - 1) for
          Y^(2m+1), as corrected), and the final S dx/Y with deg S = D at most
          floor(log_p(2D - 1)) ([H] Lemma 3.3(ii), [K] Lemma 3 as in its
          errata); here D <= p + 2, so at most 1;
        - hence a term k contributes modulo p^(k + 1 - L), L <= 2 +
          floor(log_p(3k)), and the series stops at the first K with
          K - floor(log_p(3(K + 1))) >= N (N = prec + 1); the arithmetic is
          exact in Z/p^W, W = N + 3 + floor(log_p(3K)) (the divisions by
          2k - 1 and 2m - 1 as in [K] section 4).

        Two checks raise an error, never a value: the next two omitted terms
        must vanish modulo p^N, and the characteristic polynomial of F must
        be x^2 - a_p x + p modulo p^N ([K] section 3: F's eigenvalues are
        those of Frobenius).  The entries are given as Sage gives them (to
        absolute precision prec, the one of valuation -1 to prec - 1).

        EXAMPLES::

            sage: L = EllipticCurve('14a1').padic_lseries(5)
            sage: phi = L.frobenius(5); phi
            [                  2 + 5^2 + 5^4 + O(5^5)    3*5^-1 + 3 + 5 + 4*5^2 + 5^3 + O(5^4)]
            [      3 + 3*5^2 + 4*5^3 + 3*5^4 + O(5^5) 3 + 4*5 + 3*5^2 + 4*5^3 + 3*5^4 + O(5^5)]
            sage: -phi^2
            [5^-1 + O(5^4)        O(5^4)]
            [       O(5^5) 5^-1 + O(5^4)]

        The determinant of phi is 1/p for every curve, model and basis.
        The cup product on H^1 is alternating and non-degenerate, with values
        in H^2, where F acts as p. So <F u, F v> = p <u, v>, and on a
        2-dimensional space <F u, F v> = det(F) <u, v>. Hence det F = p and
        det phi = p / p^2 = 1/p. ([K] section 3 also gives x^2 - a_p x + p
        as the characteristic polynomial of F, which is checked here modulo
        p^(prec + 1).) The matrix is computed afresh on every call::

            sage: L = EllipticCurve('36a1').padic_lseries(5)
            sage: L.frobenius(2).det()
            5^-1 + O(5)
            sage: phi = L.frobenius(6); phi.det(), phi.trace()  # sagebrush only (Sage after frobenius(2) on y^2 = x^3 + 1: TypeError, or a determinant other than 1/p)
            (5^-1 + O(5^5), O(5^6))

        An entry that is zero gets the absolute precision the bound proves.
        Sage sometimes claims one more digit for it (O(5^7) here)::

            sage: EllipticCurve('27a1').padic_lseries(5).frobenius(6)[0, 0]  # sagebrush only (Sage: O(5^7))
            O(5^6)

        With prec = 1 the matrix agrees with the one for prec = 2. Sage's
        frobenius(1) does not: its first entry is O(5), against 2 + O(5^2)::

            sage: EllipticCurve('14a1').padic_lseries(5).frobenius(1)  # sagebrush only (Sage: [O(5), 3*5^-1 + O(5^0); O(5), 2 + O(5)])
            [       2 + O(5) 3*5^-1 + O(5^0)]
            [       3 + O(5)        3 + O(5)]

        There is no default limit on the work: a large prime or precision
        runs until it is done or stopped (Stop interrupts it at every stage,
        and sagebrush.progress shows the stage).  A context that wants a
        limit sets padic.kedlaya_work, in the units of _kd_cost (about 25
        microseconds each in the CLI).  Memory is guarded (SagebrushMemoryError):
        a precision whose working modulus alone can't fit this process is
        refused at once, and one estimated to need more than a quarter of it
        before any work::

            sage: try:  # sagebrush only
            ....:     EllipticCurve('14a1').padic_lseries(5).frobenius(10^100)
            ....: except MemoryError as e:
            ....:     print(type(e).__name__, e.need_bytes > e.limit_bytes)
            SagebrushMemoryError True
        """
        sa = _sa()
        if algorithm not in ("mw", "approx"):
            raise ValueError("Unknown algorithm %s." % algorithm)
        if algorithm == "approx":
            raise NotImplementedError("algorithm='approx' (Bernardi and Perrin-Riou) is not available in sagebrush yet")
        p = self._p
        prec = _integer(prec)
        if prec < 1:
            raise ValueError("prec (=%s) must be a positive integer" % prec)
        if p == 3:
            raise NotImplementedError("the Frobenius matrix at p = 3 is not available in sagebrush yet (Sage refuses it too)")
        a1, a2, a3, a4, a6 = [_F(int(x)) if not isinstance(x, _F) else x for x in self._E.a_invariants()]
        Qc = [(a3 * a3 + 4 * a6) / 4, (2 * a4 + a1 * a3) / 2, (a1 * a1 + 4 * a2) / 4, _F(1)]
        N = prec + 1
        from sagebrush import progress
        with progress.call("padic_lseries.frobenius") as call:
            rec = _KdProgress(call)
            rec.stage(0, 1)
            K, W = _kd_preflight(p, N, prec, Qc)
            rec.tick(1)
            M = _kd_frobenius_matrix(Qc, p, N, K, W, rec)
        tr = M[0][0] + M[1][1]
        det = M[0][0] * M[1][1] - M[0][1] * M[1][0]
        if (tr - self._ap) % p ** N or (det - p) % p ** N:
            raise ArithmeticError("internal error: the Frobenius matrix modulo %d^%d does not have characteristic polynomial x^2 - %d x + %d" % (p, N, self._ap, p))
        K = sa.Qp(p, prec)
        entries = []
        for i in range(2):
            for j in range(2):
                ap_ = prec - 1 if (i, j) == (0, 1) else prec
                entries.append(K(_F(M[i][j], p), absprec=ap_))
        return sa.matrix(K, 2, 2, entries)

    def order_of_vanishing(self):
        """Not available at supersingular primes (as in Sage)."""
        raise NotImplementedError("the order of vanishing at a supersingular prime is not available")


# ------------------------------------------------------------------ Kedlaya's algorithm (g = 1)
# The matrix of the p-power Frobenius on H^1(A; K)^-, basis dx/y, x dx/y,
# for y^2 = Q(x), Q monic cubic squarefree mod p, p >= 5.  [K] = K. Kedlaya,
# J. Ramanujan Math. Soc. 16 (2001), arXiv math/0105031, sections 3-4;
# [H] = M. Harrison, arXiv:1006.4206, Lemmas 3.3-3.4 (the corrected forms of
# [K]'s Lemmas 2 and 3, as in [K]'s 2003 errata).
#
# No default limit (cliff audit rank 14, plan-kedlaya-optin r6): the opt-in
# work limit padic.kedlaya_work, and the memory guard, which always applies:
# _kd_preflight refuses, before the working modulus is made, a call whose
# modulus alone exceeds this process's memory (_capacity.heap_figure()), and
# one whose ledger, an upper bound on its peak (_kd_ledger), exceeds a
# quarter of it.

def _kd_cost(p, N):
    """The estimated work of _kd_frobenius_matrix(Q, p, N) for a dense Q
    (the worst case: zero coefficients are skipped), in the units of the
    limit padic.kedlaya_work, about 25 microseconds each in the CLI:
    p^2 (K + 2)^2 (1 + W log2(p) / 1024), K and W from _kd_plan_fast.  The
    series has about k p live terms at step k, each combined with about p
    digits of E, so about p^2 K^2 products of W log2(p)-bit numbers; K + 2
    counts the check of the next two terms, and the bit size the cost of one
    product.  Fitted on 27a1's dense model y^2 + y = x^3 + 3 x^2 + 3 x - 6
    at p = 5 ... 197 and prec 3 ... 200 (2.2 to 2.6 10^-5 s per unit); it
    also gives the 88 s of p = 197, prec 8 and the 147 s of 14a1 at p = 5,
    prec 408 measured in review.  Since K >= N, p^2 (N + 2)^2 is at most
    this (the preflight's shortcut under a finite limit)."""
    K, W = _kd_plan_fast(p, N)
    return p * p * (K + 2) ** 2 * (1024 + W * p.bit_length()) // 1024


def _kd_ilog(n, p):
    """floor(log_p n) for n >= 1."""
    k = 0
    while n >= p:
        n //= p
        k += 1
    return k


def _kd_mod(q, P):
    q = _F(q)
    return q.numerator * pow(q.denominator, -1, P) % P


def _kd_pmul(a, b, P):
    out = [0] * (len(a) + len(b) - 1) if a and b else []
    for i, x in enumerate(a):
        if x:
            for j, y in enumerate(b):
                out[i + j] = (out[i + j] + x * y) % P
    return out


def _kd_trim(a):
    while a and a[-1] == 0:
        a.pop()
    return a


def _kd_divmod_Q(t, Q, P):
    """(R, S) with t = R Q + S, deg S < 3 (Q monic cubic)."""
    t = list(t)
    n = len(t) - 1
    if n < 3:
        return [], t + [0] * (3 - len(t))
    R = [0] * (n - 2)
    for d in range(n, 2, -1):
        c = t[d] % P
        if c:
            R[d - 3] = c
            for i in range(4):
                t[d - 3 + i] = (t[d - 3 + i] - c * Q[i]) % P
    return R, [t[0] % P, t[1] % P, t[2] % P]


def _kd_pdiv(c, d, p, P):
    """c / d mod P for an integer d, d = p^v u: the representative of c
    divided by p^v (Kedlaya [K] section 4: "any polynomial which, multiplied
    by d, equals c"; the discrepancy below the working precision does not
    reach the result, [K] Lemma 2 / [H] Lemma 3.3)."""
    v = 0
    while d % p == 0:
        d //= p
        v += 1
    return (c % P) // p ** v * pow(d, -1, P) % P


def _kd_frobenius_matrix(Qc, p, N, K=None, W=None, rec=None):
    """[[a, b], [c, d]] mod p^N: F(dx/y) = a dx/y + c x dx/y and
    F(x dx/y) = b dx/y + d x dx/y (columns are images), for y^2 = Q(x),
    Qc = [q0, q1, q2, 1] rationals (p-integral); K, W from _kd_plan_fast by
    default.  The next two omitted terms are computed too and must
    contribute 0 modulo p^N (as the plan's bound says), else an error is
    raised, never a value.  The two calls run one after the other; only M
    is kept during the second (the ledger's U)."""
    if K is None:
        K, W = _kd_plan_fast(p, N)
    rec = rec or _KD_NO_PROGRESS
    M = _kd_frobenius(Qc, p, N, K, W, 0, rec, 1)
    # the next two omitted terms must contribute 0 modulo p^N (the
    # truncation bound of the plan, checked)
    T = _kd_frobenius(Qc, p, N, K + 2, W + 3, K + 1, rec, 6)
    if any(x % p ** N for row in T for x in row):
        raise ArithmeticError("internal error: the omitted terms of the Frobenius series are not 0 modulo p^%d" % N)
    return M


def _kd_plan(p, N):
    """(K, W): the series terms k <= K and the working modulus p^W, for
    the matrix modulo p^N (p >= 5), by the definition (one k at a time:
    the reference for _kd_plan_fast, which computes the same).

    The term k of 1/y^sigma = y^-p sum_k binom(-1/2, k) p^k E^k y^-2pk
    ([K] section 3) is divisible by p^k, and F(x^i dx/y) = p x^(p i + p - 1)
    dx / y^sigma adds a factor p ([H] Lemma 3.4 eq. (2), k = 0), so the
    term's forms, S(x) dx/y^m with m <= p(2k + 1), are divisible by
    p^(k+1).  Reducing them to the basis loses at most floor(log_p(m - 2))
    digits ([H] Lemma 3.3(i), the corrected [K] Lemma 2) plus, for the final
    S(x) dx/y with deg S = D <= p + 2, floor(log_p(2D - 1)) <= 1 ([H] Lemma
    3.3(ii), d = 3).  So the term contributes modulo p^(k + 1 - L(k)) with
    L(k) <= 2 + floor(log_p(3k)) (p(2k + 1) <= 3pk), and k + 1 - L(k) >=
    h(k) = k - 1 - floor(log_p(3k)), which never decreases with k.  K is
    the first k with h(k + 1) >= N: every omitted term is 0 modulo p^N.
    The included terms lose at most 2 + floor(log_p(3K)) digits to the
    divisions, so W = N + 3 + floor(log_p(3K)) keeps the result exact
    modulo p^N."""
    if p < 5:
        raise NotImplementedError("p >= 5 only")
    K = 1
    while (K + 1) - 1 - _kd_ilog(3 * (K + 1), p) < N:
        K += 1
    W = N + 3 + _kd_ilog(3 * K, p)
    return K, W


def _kd_plan_fast(p, N):
    """_kd_plan(p, N), in O(log N) steps: h(k) = k - 1 - floor(log_p(3k))
    never decreases, so the first k >= 1 with h(k + 1) >= N is found by
    doubling and then bisection."""
    if p < 5:
        raise NotImplementedError("p >= 5 only")

    def h(k):
        return k - 1 - _kd_ilog(3 * k, p)

    hi = 1
    while h(hi + 1) < N:
        hi *= 2
    lo = hi // 2          # h(lo + 1) < N when lo >= 1 (lo = 0: none tested)
    while hi - lo > 1:
        mid = (lo + hi) // 2
        if h(mid + 1) < N:
            lo = mid
        else:
            hi = mid
    K = hi
    return K, N + 3 + _kd_ilog(3 * K, p)


def _kd_modulus(p, W):
    """(p^W, p^(W + 1)): the working moduli, made here and nowhere else (a
    test replaces this function to show that a refusal comes before them)."""
    P = p ** W
    return P, P * p


class _KdProgress:
    """frobenius()'s progress: 11 stages, each with its own done and total
    (plan-kedlaya-optin r6 section 4); a stage change is written at once."""

    STAGES = ("plan", "setup: Q^p", "setup: digits", "series", "reduce dx/y", "reduce x dx/y",
              "check: setup Q^p", "check: setup digits", "check: series", "check: reduce dx/y",
              "check: reduce x dx/y")

    def __init__(self, call):
        self._call = call

    def stage(self, index, total):
        self._call.update(stage=self.STAGES[index], stage_index=index, stage_count=len(self.STAGES),
                          done=0, total=total)
        self._call.flush()

    def tick(self, done):
        self._call.update(done=done)


class _KdNoProgress:
    def stage(self, index, total):
        pass

    def tick(self, done):
        pass


_KD_NO_PROGRESS = _KdNoProgress()

# tests only: called as _kd_hook(point, values) at the ledger's within-phase
# peaks ("digits", "series", "reduce", "forms", "exact"), to compare live
# storage with the ledger's terms
_kd_hook = None


def _kd_frobenius(Qc, p, N, K, W, terms_from=0, rec=_KD_NO_PROGRESS, base=1):
    """The matrix modulo p^N from the series terms terms_from <= k <= K, at
    working modulus p^W (terms_from > 0: the contribution of those terms
    alone, for the truncation check); its progress in stages base to
    base + 4.  Four phases, each a function, so each one's temporaries are
    gone when the next starts (the ledger charges exactly that)."""
    P, Q, Qd, S, digits = _kd_setup(Qc, p, W, rec, base)
    B = _kd_series(digits, Q, p, P, K, terms_from, rec, base + 2)
    del digits
    c0 = _kd_reduce(B, Q, Qd, S, p, P, N, 0, rec, base + 3)
    c1 = _kd_reduce(B, Q, Qd, S, p, P, N, 1, rec, base + 4)
    return [[c0[0], c1[0]], [c0[1], c1[1]]]


def _kd_setup(Qc, p, W, rec, base):
    """(P, Q, Qd, S, digits): the modulus P = p^W, Q and Q' mod P, S with
    R Q + S Q' = 1, and the Q-adic digits e_l of E = (Q(x^p) - Q(x)^p) / p
    (degree <= 3p - 1: the x^3p terms cancel), E = sum_l e_l Q^l, deg e_l
    <= 2."""
    P, P1 = _kd_modulus(p, W)
    Q = [_kd_mod(c, P) for c in Qc]
    Qd = [Q[1], 2 * Q[2] % P, 3 % P]
    S = _kd_bezout(Q, Qd, p, P)[1]
    Q1 = [_kd_mod(c, P1) for c in Qc]
    Qxp = [0] * (3 * p + 1)
    for i, c in enumerate(Q1):
        Qxp[i * p] = c
    rec.stage(base, p)
    Qp_ = [1]
    for i in range(p):
        Qp_ = _kd_pmul(Qp_, Q1, P1)
        rec.tick(i + 1)
    diff = [(a - b) % P1 for a, b in zip(Qxp, Qp_)]
    if any(x % p for x in diff):
        raise ArithmeticError("internal error: Q(x^p) - Q(x)^p is not divisible by p")
    E = _kd_trim([x // p % P for x in diff])
    rec.stage(base + 1, -(-len(E) // 3))
    digits = []
    rest = E
    while rest:
        rest, d = _kd_divmod_Q(rest, Q, P)
        digits.append(d)
        rest = _kd_trim(list(rest))
        rec.tick(len(digits))
        if _kd_hook:
            _kd_hook("digits", {"P": P, "Q": Q, "Qd": Qd, "S": S, "digits": digits, "rest": rest})
    return P, Q, Qd, S, digits


def _kd_series(digits, Q, p, P, K, terms_from, rec, stage):
    """B: the series 1/y^sigma = y^-p sum_j B_j(x) T^j, T = y^-2, deg B_j
    <= 2, from the terms terms_from <= k <= K: term k = binom(-1/2, k)
    (p E T^p)^k, built term by term; p E T^p = sum_l p e_l Q^l T^p = sum_l
    p e_l T^(p - l) (Q = y^2 = 1/T)."""
    rec.stage(stage, K)
    B = {}
    cur = {0: [1, 0, 0]}
    c = _F(1)
    for k in range(K + 1):
        if k:
            nxt = {}
            for j, A in cur.items():
                for l, e in enumerate(digits):
                    prod = _kd_pmul(A, e, P)                 # degree <= 4
                    m = j + p - l
                    Rq, Sr = _kd_divmod_Q(prod, Q, P)
                    nxt[m] = _kd_padd(nxt.get(m, [0, 0, 0]), [p * x % P for x in Sr], P)
                    if _kd_trim(list(Rq)):
                        nxt[m - 1] = _kd_padd(nxt.get(m - 1, [0, 0, 0]), [p * x % P for x in Rq], P)
            cur = nxt
            c = c * (_F(-1, 2) - (k - 1)) / k
            rec.tick(k)
            if _kd_hook:
                _kd_hook("series", {"k": k, "B": B, "cur": cur, "nxt": nxt, "c": c, "digits": digits})
        if k >= terms_from:
            ck = _kd_mod(c, P)
            for j, A in cur.items():
                B[j] = _kd_padd(B.get(j, [0, 0, 0]), [ck * x % P for x in A], P)
    return B


def _kd_reduce(B, Q, Qd, S, p, P, N, i, rec, stage):
    """[G0, G1] mod p^N: F(x^i dx/y) = p x^(p i + p - 1) dx / y^sigma =
    sum_j p x^(p i + p - 1) B_j(x) dx / y^(p + 2 j) in the basis dx/y,
    x dx/y.  By descending s = p + 2j, the x-degree is brought below 3 with
    Q = y^2 (the quotient moves to s - 2), down to s = 1 (the G part); the
    term of B_j is added at its offset p i + p - 1 into the carried
    polynomial (no padded copy of each term)."""
    shift = p * i + p - 1
    forms = {}
    G = []
    top = p + 2 * max(B) if B else 1
    rec.stage(stage, top - 1)
    if _kd_hook:
        _kd_hook("reduce", {"i": i, "B": B})
    carry = []
    for s in range(top, 0, -2):
        A = B.get((s - p) // 2) if s >= p else None
        if A is not None:
            n = shift + len(A)
            poly = carry + [0] * (n - len(carry)) if len(carry) < n else carry
            for t, x in enumerate(A):
                poly[shift + t] = (poly[shift + t] + p * x) % P
        else:
            poly = carry
        if s == 1:
            G = poly
            break
        Rq, Sr = _kd_divmod_Q(poly, Q, P)
        forms[s] = Sr
        carry = _kd_trim(list(Rq))
        rec.tick(top - s)
    # [K] section 3: T dx/y^s, T = A Q + B Q', is cohomologous to
    # (A + 2 B'/(s - 2)) dx/y^(s - 2)
    for s in range(top, 2, -2):
        T = forms.get(s)
        if T is None or not any(T):
            continue
        Bp = _kd_divmod_Q(_kd_pmul(T, S, P), Q, P)[1]           # T S mod Q
        num = _kd_psub(T, _kd_pmul(Bp, Qd, P), P)               # T - B Q' = A Q
        A, _ = _kd_divmod_Q(num + [0] * max(0, 4 - len(num)), Q, P)
        Bd = [Bp[1], 2 * Bp[2] % P]
        red = _kd_padd(A, [_kd_pdiv(2 * x, s - 2, p, P) for x in Bd], P)
        if s - 2 == 1:
            G = _kd_padd(G, red, P)
        else:
            forms[s - 2] = _kd_padd(forms.get(s - 2, [0, 0, 0]), red, P)
    if _kd_hook:
        _kd_hook("forms", {"i": i, "forms": forms, "G": G})
    # [K] section 3: (S Q' + 2 S' Q) dx/y is exact; S = x^(m-2) gives
    # degree m with leading coefficient 2m - 1 (Q monic, g = 1)
    G = _kd_trim(list(G))
    while len(G) > 2:
        m = len(G) - 1
        lc = G[m]
        if lc:
            rel = _kd_padd([0] * (m - 2) + Qd, [0] * (m - 3) + [2 * (m - 2) * x % P for x in Q], P)
            f = _kd_pdiv(lc, 2 * m - 1, p, P)
            G = _kd_psub(G, [f * x % P for x in rel], P)
            if _kd_hook:
                _kd_hook("exact", {"i": i, "forms": forms, "G": G, "rel": rel})
        G = _kd_trim(G[:m])
    G = G + [0] * (2 - len(G))
    return [G[0] % p ** N, G[1] % p ** N]


def _kd_padd(a, b, P):
    n = max(len(a), len(b))
    return [((a[i] if i < len(a) else 0) + (b[i] if i < len(b) else 0)) % P for i in range(n)]


def _kd_psub(a, b, P):
    n = max(len(a), len(b))
    return [((a[i] if i < len(a) else 0) - (b[i] if i < len(b) else 0)) % P for i in range(n)]


def _kd_bezout(Q, Qd, p, P):
    """R, S with R Q + S Q' = 1 mod P (deg R <= 1, deg S <= 2), by solving
    the 5x5 linear system mod P (its determinant is the resultant of Q and
    Q', a unit since Q is squarefree mod p)."""
    # unknowns r0, r1, s0, s1, s2; coefficients of x^0..x^4
    rows = []
    for d in range(5):
        row = [Q[d] if d < 4 else 0, Q[d - 1] if 1 <= d <= 4 else 0,
               Qd[d] if d < 3 else 0, Qd[d - 1] if 1 <= d <= 3 else 0, Qd[d - 2] if 2 <= d <= 4 else 0]
        rows.append([x % P for x in row] + [1 if d == 0 else 0])
    n = 5
    for col in range(n):
        piv = None
        for r in range(col, n):
            if rows[r][col] % p:
                piv = r
                break
        if piv is None:
            raise ArithmeticError("Q is not squarefree modulo p")
        rows[col], rows[piv] = rows[piv], rows[col]
        inv = pow(rows[col][col], -1, P)
        rows[col] = [x * inv % P for x in rows[col]]
        for r in range(n):
            if r != col and rows[r][col]:
                f = rows[r][col]
                rows[r] = [(x - f * y) % P for x, y in zip(rows[r], rows[col])]
    sol = [rows[r][n] for r in range(n)]
    return sol[:2], sol[2:]


# ------------------------------------------------------------------ the preflight and its ledger

def _kd_engine():
    """The runtime whose object sizes the ledger uses: "cpython", or pyjs's
    JavaScript engine from the runtime's own detection (_sbengine.js_engine
    and js_host), as _kd_label names it.  A test replaces it."""
    try:
        import _sbengine
    except ImportError:
        return "cpython"
    return _kd_label(str(_sbengine.js_engine()), str(_sbengine.js_host()))


def _kd_label(engine, host):
    """The ledger's name for a JavaScript engine on a host: "v8" (Node, Deno,
    Chromium), "jsc" for JavaScriptCore under Bun, and "jsc (WebKit)" for
    JavaScriptCore in a browser, for which no table can be certified
    (plan-kedlaya-webkit-ci r4), so it is refused, like "spidermonkey" and "unknown"."""
    if engine == "jsc" and host != "bun":
        return "jsc (WebKit)"
    return engine


def _kd_r(x, g):
    return -(-x // g) * g


class _KdCPython:
    """CPython 3.12 to 3.14, 64-bit: getsizeof plus pymalloc's 16-byte
    granularity, each an upper bound (plan-kedlaya-optin r6 section 2).  No
    code allowance: CPython compiles the module when it is imported, before
    any call."""

    CODE = 0

    @staticmethod
    def I(bits):
        return _kd_r(32 + 4 * -(-bits // 30), 16)

    @staticmethod
    def Ls(n):
        # (list growth n + (n >> 3) + 6, to a multiple of 4: at most n + n/8 + 9 slots; 16 the GC header)
        return _kd_r(56 + 16 + 8 * (n + n // 8 + 9), 16)

    @staticmethod
    def D(n):
        # (a compact dict sized from the power of two at or above 3n/2: at
        # most 8 bytes an index slot and 24 an entry, the headers, and the
        # old table during a resize)
        return _kd_r(104 + 32 * (3 * n + 2), 16)


def _kd_pow2(n):
    c = 1
    while c < n:
        c *= 2
    return c


class _KdV8:
    """pyjs under V8 (Node, Deno, Chromium): an int a BigInt (header, length,
    64-bit digits), a list a JSArray and its FixedArray (capacity at most
    1.5 n + 16 after appends), a dict a PyDict and its OrderedHashMap of
    capacity 2c (and the old table during a rehash)."""

    # the first call in a session compiles the _kd_ functions: their bytecode
    # and feedback stay in the old space, measured at most 0.97 MiB retained
    # after a first call (Node 26, p = 5 ... 401), the same at every p and N;
    # charged on every call (a per-session cost: conservative after the first)
    CODE = 3 << 19

    @staticmethod
    def I(bits):
        return _kd_r(16 + 8 * -(-bits // 64), 8)

    @staticmethod
    def Ls(n):
        return _kd_r(32 + 16 + 8 * (3 * n // 2 + 16), 8)

    @staticmethod
    def D(n):
        c = _kd_pow2(n)
        return _kd_r(96 + 2 * (24 + 8 * (3 * 2 * c + c)), 8)


class _KdJSC:
    """pyjs under JavaScriptCore (Bun only; WebKit's is refused): an
    upper bound over its layouts, as measured under Bun 1.3 at each layout
    step (test/kedlaya_jsc.mjs): a JSBigInt cell (header, length, 64-bit
    digits) rounded up to JSC's size classes, which step by at most 1.4
    (32, 48, ... 80, 112, 160, 224, 256, 320 bytes measured); a JSArray and
    its butterfly (2n + 16 slots: any growth up to doubling, a size class
    included); a PyDict's Map, 64 bytes a slot of a capacity growing by
    powers of 4 from 16 (and the old table, a quarter of it, during a
    rehash), plus 1.5 KiB."""

    # the first call's code blocks are cells of JSC's heap: 1.9 MB measured
    # under Bun 1.3.14 at p = 101 (test/kedlaya_jsc.mjs's cold call); charged
    # on every call, as V8's
    CODE = 5 << 19

    @staticmethod
    def I(bits):
        return _kd_r(7 * (16 + 8 * -(-bits // 64)) // 5 + 16, 16)

    @staticmethod
    def Ls(n):
        return _kd_r(16 + 8 + 8 * (2 * n + 16), 8)

    @staticmethod
    def D(n):
        c = 16
        while c < n:
            c *= 4
        return 1536 + 64 * (c + c // 4)


_KD_TABLES = {"cpython": _KdCPython, "v8": _KdV8, "jsc": _KdJSC}


def _kd_sizes(p, K, W):
    """(b, b1, bb, J, F): the bits of a residue mod P = p^W and mod P1 =
    p^(W + 1), of a product before its reduction, and the most entries of
    B, cur and nxt (keys in [0, K p]) and of forms (weights p + 2 K p down
    to 3)."""
    bl = p.bit_length()
    b = W * bl
    b1 = b + bl
    return b, b1, 2 * b1 + 4, K * p + 1, K * p + (p - 1) // 2


def _kd_phases(p, K, W, L, a, t):
    """The live set of each phase of one _kd_frobenius(.., K, W) call with L
    digits and inputs of at most a bits, under the object sizes t, as
    {phase: [(term, bytes)]}: setup "S", series "T", one reduction "R"
    (plan-kedlaya-optin r6 section 2).  Each term is an upper bound on the
    bytes of what it names."""
    I, Ls, D = t.I, t.Ls, t.D
    b, b1, bb, J, F = _kd_sizes(p, K, W)
    T3 = Ls(3) + 3 * I(b)
    entry = I(64) + T3
    # (always kept: P, Q, Qd and S, and the inputs and their conversions)
    C = [("P Q Qd S", I(b) + 3 * Ls(4) + 10 * I(b)), ("inputs", 8 * I(a) + 4 * 64 + 5 * I(a))]
    dig = ("digits", Ls(L) + L * T3)
    return {
        "S": C + [("P1 Q1 R", I(b1) + Ls(4) + 4 * I(b1) + Ls(2) + 2 * I(b)),
                  ("bezout", 5 * Ls(6) + 30 * I(b) + Ls(5)),
                  ("Qxp diff E", 3 * (Ls(3 * p + 1) + (3 * p + 1) * I(b1))),
                  ("Qp_", 3 * (Ls(3 * p + 4) + (3 * p + 4) * I(bb))),
                  ("digit loop", 3 * (Ls(3 * p) + 3 * p * I(b))),
                  dig],
        "T": C + [dig,
                  ("B cur nxt", 3 * (D(J) + J * entry)),
                  ("products", 8 * Ls(5) + 24 * I(bb)),
                  ("c", 2 * I(2 * K * (2 * K).bit_length()) + 64),
                  ("ck", I(b))],
        "R": C + [("B", D(J) + J * entry),
                  ("forms", D(F) + F * entry),
                  ("carry poly", 4 * (Ls(3 * p + 5) + (3 * p + 5) * I(b))),
                  ("section 3 step", 6 * Ls(6) + 30 * I(bb)),
                  ("exact-form loop", 6 * (Ls(3 * p + 5) + (3 * p + 5) * I(bb)))],
    }


def _kd_peak(p, K, W, L, a, t):
    """An upper bound on the peak bytes of one _kd_frobenius(.., K, W) call:
    the most of its phases' live sets, plus 2 KiB of frames and small
    objects."""
    return max(sum(n for _, n in terms) for terms in _kd_phases(p, K, W, L, a, t).values()) + 2048


def _kd_ledger(p, N, K, W, L, a, t):
    """U: an upper bound on the peak bytes of _kd_frobenius_matrix(.., N, K,
    W): the two calls one after the other, the second (the check of the
    next two terms) with M kept, the result's entries, and the runtime's
    allowance for the code a first call compiles (t.CODE)."""
    bM = W * p.bit_length()
    return max(_kd_peak(p, K, W, L, a, t), _kd_peak(p, K + 2, W + 3, L, a, t) + 4 * t.I(bM)) + 4 * (t.I(bM) + 256) + t.CODE


def _kd_memory(what, need, limit, allowance_for):
    """D1's memory refusal; capacity (D0) is only an observation."""
    import _capacity, _memguard
    e = _memguard.memory_guard(what, need, limit, allowance_for)
    e.capacity = _capacity.capacity()
    return e


def _kd_min_bytes(p, N):
    """The bytes any runtime needs for the working modulus p^W alone, W >=
    N + 3: it has at least (N + 3) floor(log2 p) + 1 bits."""
    return -(-(N + 3) * (p.bit_length() - 1) // 8)


def _kd_preflight(p, N, prec, Qc):
    """(K, W) for frobenius() at p and N = prec + 1, after its admission, in
    order and before the working modulus is made (plan-kedlaya-optin r6
    section 3): (1) the modulus p^W alone, W >= N + 3, needs at least
    ceil((N + 3) floor(log2 p) / 8) bytes in any runtime: more than this
    process's total is impossible; (2) K and W; (3) a finite
    padic.kedlaya_work; (4) the ledger's U, an upper estimate, against a
    quarter of the total."""
    import _capacity
    total = _capacity.heap_figure()
    need = _kd_min_bytes(p, N)
    what = "the Frobenius matrix at p = %d to precision %d" % (p, prec)
    if need > total:
        raise _kd_memory("At the least, %s (just its working modulus p^(prec + 4))" % what, need, total,
                         "this whole process")
    K, W = _kd_plan_fast(p, N)
    import _limits
    limit = _limits.finalize()["padic.kedlaya_work"]
    if limit != _limits.UNLIMITED:
        lower = p * p * (N + 2) ** 2
        work = lower if lower > limit else _kd_cost(p, N)
        if work > limit:
            raise NotImplementedError("%s is beyond the limit padic.kedlaya_work (estimated work %d > %d)" % (what, work, limit))
    a = max(max(abs(c.numerator).bit_length(), c.denominator.bit_length()) for c in map(_F, Qc))
    _kd_admit(p, N, K, W, a, _kd_engine(), what, total)
    return K, W


def _kd_admit(p, N, K, W, a, engine, what, total):
    """Step 4 of the preflight: refuse when the ledger's U, with the digit
    count charged as its proven bound L = p (the digits do not exist yet),
    exceeds a quarter of the total; and on a JavaScript engine whose object
    sizes are not established, at once.  Returns U."""
    t = _KD_TABLES.get(engine)
    if t is None:
        # (no need is known: not a memory refusal)
        raise NotImplementedError("%s: the memory estimate for this computation isn't established for this "
                                  "JavaScript engine (%s); the native package computes it" % (what, engine))
    U = _kd_ledger(p, N, K, W, p, a, t)
    cap = total // 4
    if U > cap:
        raise _kd_memory("By an upper estimate, %s" % what, U, cap, "one computation")
    return U
