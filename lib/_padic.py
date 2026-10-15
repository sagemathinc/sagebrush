"""p-adic numbers with capped relative precision: the arithmetic shared by
Sage mode (lib/_sage_padic.py) and, later, Magma mode.  No parents and no
printing here, only values and their precision.

An element is p^v u + O(p^(v + r)):
  * r >= 1, 0 < u < p^r, p not dividing u: a nonzero element known to
    relative precision r (absolute precision v + r);
  * r = 0, u = 0: an inexact zero O(p^v), known to be 0 modulo p^v;
  * r = None: the exact zero (v = None, u = 0).
Every operation takes `cap`, the relative precision cap of its result's
ring, and returns every p-adic digit its inputs determine, up to the cap
(stated at each function); the few places where Sage reports fewer digits
than are determined are matched and say so.
"""

from fractions import Fraction as _F

__all__ = ["Padic", "PrecisionError", "NotASquare"]


class PrecisionError(ArithmeticError):
    """Not enough precision to answer (as Sage's PrecisionError)."""


class NotASquare(ValueError):
    """The element is not a square in Z_p (or Q_p)."""


def _vp(n, p):
    """(v, m) with n = p^v m, p not dividing m (n a nonzero int)."""
    v = 0
    while n % p == 0:
        n //= p
        v += 1
    return v, n


class Padic:
    """p^v u + O(p^(v + r)) (see the module docstring)."""

    __slots__ = ("p", "v", "u", "r")

    def __init__(self, p, v, u, r):
        self.p, self.v, self.u, self.r = p, v, u, r

    # -------------------------------------------------------- construction
    @staticmethod
    def exact_zero(p):
        return Padic(p, None, 0, None)

    @staticmethod
    def inexact_zero(p, absprec):
        return Padic(p, absprec, 0, 0)

    @staticmethod
    def from_abs(p, n, v0, absprec, cap):
        """p^v0 n + O(p^absprec) for an int n (absprec > v0 or not),
        normalized, with relative precision at most cap."""
        if absprec <= v0:
            return Padic.inexact_zero(p, absprec)
        m = p ** (absprec - v0)
        n %= m
        if n == 0:
            return Padic.inexact_zero(p, absprec)
        k, u = _vp(n, p)
        v = v0 + k
        r = min(absprec - v, cap)
        return Padic(p, v, u % p ** r, r)

    @staticmethod
    def from_rational(p, x, cap, absprec=None, relprec=None):
        """x (int or Fraction) to relative precision min(cap, relprec) and
        absolute precision at most absprec; 0 is the exact zero unless an
        absolute precision is given (then O(p^absprec))."""
        x = _F(x)
        if x == 0:
            if absprec is not None:
                return Padic.inexact_zero(p, absprec)
            return Padic.exact_zero(p)
        vn, n = _vp(x.numerator, p)
        vd, d = _vp(x.denominator, p)
        v = vn - vd
        r = cap if relprec is None else min(cap, relprec)
        if absprec is not None:
            r = min(r, absprec - v)
        if r <= 0:
            return Padic.inexact_zero(p, v + r if absprec is None else min(absprec, v + r))
        m = p ** r
        return Padic(p, v, n * pow(d, -1, m) % m, r)

    # ------------------------------------------------------------ queries
    def is_exact_zero(self):
        return self.r is None

    def is_zero(self):
        """Exact or inexact zero."""
        return self.r is None or self.r == 0

    def absprec(self):
        """The absolute precision, None for the exact zero (+infinity)."""
        return None if self.r is None else self.v + self.r

    def valuation(self):
        """v (for an inexact zero O(p^n), n), None for the exact zero."""
        return self.v

    def lift(self):
        """p^v u as an int (v >= 0) or Fraction; 0 for zeros."""
        if self.is_zero():
            return 0
        if self.v >= 0:
            return self.u * self.p ** self.v
        return _F(self.u, self.p ** -self.v)

    def digits(self):
        """[(exponent, digit)] of p^v u in base p (digits 0..p-1), from p^v
        up to the absolute precision (all r of them)."""
        if self.is_zero():
            return []
        out, u = [], self.u
        for k in range(self.r):
            out.append((self.v + k, u % self.p))
            u //= self.p
        return out

    def balanced_digits(self):
        """As digits, with digits in (-p/2, p/2] (Sage's print_pos=False)."""
        if self.is_zero():
            return []
        p, out, u = self.p, [], self.u
        for k in range(self.r):
            d = u % p
            if d > p // 2:
                d -= p
            out.append((self.v + k, d))
            u = (u - d) // p
        return out

    def residue(self, k):
        """The int self mod p^k (0 <= it < p^k), for v >= 0."""
        if self.r is not None and self.v is not None and self.v < 0:
            raise ValueError("element must have nonnegative valuation in order to compute residue")
        a = self.absprec()
        if a is not None and a < k:
            raise PrecisionError("not enough precision known in order to compute residue")
        if self.is_zero():
            return 0
        return self.u * self.p ** self.v % self.p ** k

    # --------------------------------------------------------- arithmetic
    def _vr(self):
        """(valuation, relprec) with an inexact zero as (absprec, 0)."""
        return self.v, self.r

    def recap(self, cap):
        """The same element with relative precision at most cap."""
        if self.r is None or self.r <= cap:
            return self
        return Padic(self.p, self.v, self.u % self.p ** cap, cap)

    def add_bigoh(self, n):
        """self + O(p^n)."""
        a = self.absprec()
        if a is not None and a <= n:
            return self
        if self.r is None or n <= self.v:
            return Padic.inexact_zero(self.p, n)
        r = n - self.v
        return Padic(self.p, self.v, self.u % self.p ** r, r)

    def neg(self):
        if self.is_zero():
            return self
        m = self.p ** self.r
        return Padic(self.p, self.v, (m - self.u) % m, self.r)

    def add(self, o, cap):
        """The absolute precision is min of the two; the relative one, what
        remains of it after cancellation, at most cap."""
        if self.r is None:
            return o.recap(cap)
        if o.r is None:
            return self.recap(cap)
        p = self.p
        A = min(self.absprec(), o.absprec())
        m = min(self.v, o.v)
        n = self.u * p ** (self.v - m) + o.u * p ** (o.v - m)
        return Padic.from_abs(p, n, m, A, cap)

    def sub(self, o, cap):
        return self.add(o.neg(), cap)

    def mul(self, o, cap):
        """Valuations add; the relative precision is the smaller one."""
        if self.r is None or o.r is None:
            return Padic.exact_zero(self.p)
        v = self.v + o.v
        r = min(self.r, o.r, cap)
        if r == 0:
            return Padic.inexact_zero(self.p, v)
        return Padic(self.p, v, self.u * o.u % self.p ** r, r)

    def inverse(self, cap):
        """1/self: valuation negated, the same relative precision."""
        if self.r is None:
            raise ZeroDivisionError("cannot divide by zero")
        if self.r == 0:
            raise PrecisionError("cannot divide by something indistinguishable from zero")
        r = min(self.r, cap)
        return Padic(self.p, -self.v, pow(self.u, -1, self.p ** r), r)

    def div(self, o, cap):
        return self.mul(o.inverse(cap), cap)

    def pow(self, n, cap):
        """self^n for an int n.  For a unit u known modulo p^r, u^n is
        known modulo p^(r + g): g = v_p(n) (as (1 + p^r e)^n = 1 + n p^r e
        + ...), and for p = 2, r = 1 and n even g = v_2(n) + 1 (the square
        of 1 + 2e is 1 + 8(e(e + 1)/2)).  n = 0 gives 1 to precision cap."""
        p = self.p
        if n == 0:
            return Padic(p, 0, 1 % p ** cap, cap) if cap > 0 else Padic.inexact_zero(p, 0)
        if self.r is None:
            if n < 0:
                raise ZeroDivisionError("cannot divide by zero")
            return self
        if self.r == 0:
            if n < 0:
                raise PrecisionError("cannot divide by something indistinguishable from zero")
            return Padic.inexact_zero(p, self.v * n)
        k = abs(n)
        g = _vp(k, p)[0]
        if p == 2 and self.r == 1 and k % 2 == 0:
            g += 1
        r = min(self.r + g, cap)
        x = Padic(p, self.v * k, pow(self.u, k, p ** r), r)
        return x if n > 0 else x.inverse(cap)

    def eq(self, o):
        """Equal to the smaller precision: the difference is zero."""
        return self.sub(o, 1 << 30).is_zero()

    def cmp_key(self):
        """Sage's order on p-adics: by valuation, then by the unit's lift."""
        if self.is_zero():
            return (float("inf"), 0)
        return (self.v, self.u)

    # ------------------------------------------------------- functions
    def teichmuller(p, a, prec):
        """The (p-1)-st root of unity congruent to the int a mod p (0 for
        a = 0 mod p), modulo p^prec, as an int: a^(p^k) converges, one
        digit per step (p = 2: 1 for odd a)."""
        a %= p
        if a == 0:
            return 0
        if p == 2:
            return 1
        m = p ** prec
        w = a
        for _ in range(prec):
            w = pow(w, p, m)
        return w

    teichmuller = staticmethod(teichmuller)

    def log(self, cap, p_branch=None):
        """The p-adic logarithm.  For a unit u known modulo p^r, log u is
        known modulo p^r: log u = log(u / w), w the root of unity congruent
        to u (log w = 0; for p = 2, w = +-1 with u/w = 1 mod 4), and
        log(1 + z) = sum (-1)^(k+1) z^k / k is summed exactly modulo p^r
        while k v(z) - v_p(k) < r (it only grows from there).  A nonunit
        p^v u needs log p = p_branch (a Padic): v p_branch + log u."""
        p = self.p
        if self.is_zero():
            raise ValueError("logarithm is not defined at zero")
        if self.v != 0 and p_branch is None:
            raise ValueError("you must specify a branch of the logarithm for non-units")
        A = self.r
        m = p ** A
        if p == 2:
            w = 1 if self.u % 4 == 1 else -1
        else:
            w = Padic.teichmuller(p, self.u, A)
        z = (self.u * pow(w, -1, m) - 1) % m
        total = 0
        if z:
            s, wz = _vp(z, p)
            k = 1
            # v(z^k / k) = k s - v_p(k) >= k s - floor(log_p k), which does
            # not decrease with k (s >= 1, and s >= 2 for p = 2): stop once
            # that bound reaches A
            while k * s - _log_floor(k, p) < A:
                vk, ku = _vp(k, p)
                e = k * s - vk
                if e < A:
                    t = p ** e * pow(wz, k, m) * pow(ku, -1, m)
                    total = (total + t) % m if k % 2 == 1 else (total - t) % m
                k += 1
        lu = Padic.from_abs(p, total, 0, A, cap)
        if self.v == 0:
            return lu
        vb = p_branch.mul(Padic.from_rational(p, self.v, cap), cap)
        return vb.add(lu, cap)

    def exp(self, cap):
        """exp(x) for v(x) >= 1 (p = 2: >= 2): known to the absolute
        precision of x, at most cap (exp(x + d) = exp(x) exp(d)); the series
        sum x^k / k! is summed exactly while k v(x) - v_p(k!) can be below
        it."""
        p = self.p
        if self.r is None:
            return Padic(p, 0, 1 % p ** cap, cap)
        A = self.absprec()
        need = 2 if p == 2 else 1
        if self.v < need:
            raise ValueError("Exponential does not converge for that input.")
        A = min(A, cap)
        m = p ** A
        if self.r == 0:
            return Padic.from_abs(p, 1, 0, A, cap)
        s, wx = self.v, self.u
        total, fu, fv = 1, 1, 0  # k! = p^fv fu
        k = 0
        while True:
            k += 1
            vk, ku = _vp(k, p)
            fv += vk
            fu = fu * ku % m
            e = k * s - fv
            # v_p(k!) <= (k - 1)/(p - 1): the terms from here on have
            # valuation at least k s - (k - 1)/(p - 1), increasing
            if k * s - (k - 1) / (p - 1) >= A:
                break
            if e < A:
                total = (total + p ** e * pow(wx, k, m) * pow(fu, -1, m)) % m
        return Padic.from_abs(p, total, 0, A, cap)

    def sqrt(self, cap):
        """The square root whose reduction mod p lies in [0, p/2) (for
        p = 2: congruent to 1 mod 4), as Sage chooses.  p odd: relative
        precision r (Hensel); p = 2: r - 1 for r >= 4, and for r = 3 one
        digit, as Sage reports (r < 3 cannot decide).  Raises NotASquare,
        or PrecisionError when the precision cannot decide."""
        p = self.p
        if self.r is None:
            return self
        if self.r == 0:
            raise PrecisionError("not enough precision to be sure that this element has a square root")
        if self.v % 2:
            raise NotASquare("element is not a square")
        u, r = self.u, self.r
        if p == 2:
            if r < 3:
                raise PrecisionError("not enough precision to be sure that this element has a square root")
            if u % 8 != 1:
                raise NotASquare("element is not a square")
            rr = 1 if r == 3 else r - 1
            # x^2 = u mod 2^k (k >= 3) lifts to x or x + 2^(k-1) mod 2^(k+1)
            x = 1
            for k in range(3, r):
                if (x * x - u) % 2 ** (k + 1):
                    x += 2 ** (k - 1)
            # x is determined mod 2^(r-1) up to sign: the one = 1 mod 4
            if x % 4 != 1:
                x = -x
            rr = min(rr, cap)
            return Padic(p, self.v // 2, x % 2 ** rr, rr)
        if pow(u % p, (p - 1) // 2, p) != 1:
            raise NotASquare("element is not a square")
        x0 = next(a for a in range(1, (p + 1) // 2) if a * a % p == u % p)
        # Hensel: x <- x - (x^2 - u)/(2x), doubling the precision
        x, k = x0, 1
        while k < r:
            k = min(2 * k, r)
            m = p ** k
            x = (x - (x * x - u) * pow(2 * x, -1, m)) % m
        rr = min(r, cap)
        return Padic(p, self.v // 2, x % p ** rr, rr)

    def is_square(self):
        try:
            self.sqrt(1 << 30)
            return True
        except NotASquare:
            return False


def _log_floor(k, p):
    """floor(log_p k) for k >= 1."""
    e = 0
    while k >= p:
        k //= p
        e += 1
    return e
