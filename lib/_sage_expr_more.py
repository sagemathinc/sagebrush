"""The exact sign of a constant relation, loaded only when the engine and the
double enclosure cannot decide it (lib/_sage_expr.py _exact_sign): its
algebraic number under a degree cap, after factors proven 0 are pruned."""

from _sage_expr import Expression, _rat_s


_EXACT_SIGN_MAX_DEGREE = 32
_CAPPED = "capped"


def _exact_degree_bound(e):
    """An upper bound for the degree over QQ of a constant built from
    rationals, I, sums, products, rational powers and abs, from its tree
    (abs(z) has degree at most 2*deg(z)^2), or None for any other node; it
    stops past 2^20."""
    from fractions import Fraction
    import operator as o
    from _sage_poly import QQ
    stack, total = [e], 1
    while stack:
        x = stack.pop()
        try:
            Fraction(QQ(x))
            continue
        except (TypeError, ValueError, ArithmeticError, NotImplementedError):
            pass
        if str(x) == "I":
            total *= 2
            continue
        op = x.operator()
        args = x.operands()
        if op is o.pow and len(args) == 2:
            try:
                q = Fraction(QQ(args[1]))
            except (TypeError, ValueError, ArithmeticError, NotImplementedError):
                return None
            total *= q.denominator
            stack.append(args[0])
        elif op in (o.add, o.mul):
            stack.extend(args)
        elif x._op()[0] == "fun:abs" and len(args) == 1:
            b = _exact_degree_bound(args[0])
            if b is None:
                return None
            total *= 2 * b * b
        else:
            return None
        if total > 1 << 20:
            break
    return total


def _prune_zero(e):
    """e with each product holding a factor proven exactly 0 (an algebraic
    factor under the degree cap) replaced by 0, and such zero terms dropped
    from sums: d*(sqrt(5) + ... + sqrt(19)) with d a denesting identity's
    difference is 0 without building the large field, as Sage proves it."""
    import operator as o
    op = e.operator()
    if op is o.mul:
        fs = e.operands()
        for f in fs:
            if not f.variables() and _exact_sign_capped(f) == 0:
                return Expression(_rat_s(0))
        return e
    if op is o.add:
        ts = [_prune_zero(t) for t in e.operands()]
        r = Expression(_rat_s(0))
        for t in ts:
            r = r + t
        return r
    return e


def _exact_sign(d):
    """The sign of a constant made of rationals, I, sums, products, rational
    powers and abs, decided exactly: 0, 1, -1, or "c" (not real); None when it
    cannot be decided (another kind of constant, or past the degree cap), as
    Sage leaves an unprovable relation False.  Products with a factor proven 0
    are pruned first (_prune_zero)."""
    if len(d._s) > 4000:
        return None
    try:
        d = _prune_zero(d)
    except (TypeError, ValueError, ArithmeticError, NotImplementedError, AttributeError, RecursionError):
        pass
    r = _exact_sign_capped(d)
    return None if r == _CAPPED else r


def _exact_sign_capped(d):
    """The sign of a constant made of rationals, I, sums, products, rational
    powers and abs, decided exactly as an algebraic number: 0, 1, -1, or
    "c" (not real); _CAPPED when its degree is past _EXACT_SIGN_MAX_DEGREE
    (refused from the expression tree's bound, before any field is built, or
    by the algebraic numbers' own degree check, under that cap); None for
    any other constant.  (bool(q*sqrt(2) < p) was False for p^2 - 2*q^2 = 1
    with p, q near 10^7: the double enclosure of the difference held 0;
    bool(8*4^(1/4)*sqrt(2) == 16) was False.)"""
    if len(d._s) > 4000:
        return None
    import _sage_qqbar
    old = _sage_qqbar._degree_cap
    # (a stricter cap already set stays)
    cap = _EXACT_SIGN_MAX_DEGREE if old is None else min(old, _EXACT_SIGN_MAX_DEGREE)
    try:
        bound = _exact_degree_bound(d)
    except (TypeError, ValueError, ArithmeticError, NotImplementedError, AttributeError, RecursionError):
        bound = None
    if bound is not None and bound > cap:
        return _CAPPED
    _sage_qqbar._degree_cap = cap
    try:
        a = _sage_qqbar._convert(d)
        if a == 0:
            return 0
        if a.imag() != 0:
            return "c"
        return 1 if a > 0 else -1
    except NotImplementedError as e:
        return _CAPPED if "more than %d" % cap in str(e) else None
    except (TypeError, ValueError, ArithmeticError, MemoryError):
        return None
    finally:
        _sage_qqbar._degree_cap = old
