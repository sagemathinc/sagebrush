"""Subfields and common fields of finite fields, shared by the Sage and
Magma front ends (design: plan-finite-fields F1, plan-ff1-shared-core).

Every field here is a lib/_sage_ff.py field defined by its Conway polynomial
(a prime field, or FiniteField_ext with the Conway modulus), so GF(p^m) lies
in GF(p^n) for m | n with its generator a sent to g^((p^n - 1)/(p^m - 1)),
the embeddings Magma uses and Sage uses for its prefix fields (GF(4) and
GF(16), z2 |--> z4^2 + z4).

Work is counted in prime-field coefficient operations (cops), a product in
GF(p^n) costing M(n) = 2 n^2 w(p).  A public operation has ONE budget of
WORK, a one-element list, from which all its deterministic work (generator
images, embeddings, descents) is reserved before any of it is done or any
common field is made; a cold Conway search for the common field is charged
to what is left.  Embedding and descent are for fields of at most EMBED_MAX
elements (the common field too); past them, and past the budget, the
caller's refuse() is raised, in its front end's words.  The images of
generators are kept in ONE bounded LRU cache, IMAGES, for every front end.

    sage: import _sage_ffsub as S
    sage: F, K = GF(4), GF(16)
    sage: S.up(F.gen(), K, [S.WORK], ValueError)
    z4^2 + z4
    sage: S.down(K.gen() ** 5, F, [S.WORK], ValueError)
    z2
    sage: S.cover([GF(4), GF(8)], ValueError)
    6
"""

import collections as _collections
import math as _math

import _sage_ff as _sff

WORK = 10 ** 7
EMBED_MAX = 2 ** 20
IMAGES = _collections.OrderedDict()  # (p, m, n) -> image of GF(p^m)'s generator in GF(p^n)
IMAGES_MAX = 64                      # entries, of at most 20 coefficients each (1280 in all)


def pnq(K):
    """(p, n, q) of the finite field K."""
    return int(K.characteristic()), int(K.degree()), int(K.order())


def is_element(x):
    """Whether x is an element of a lib/_sage_ff.py finite field."""
    if isinstance(x, _sff.FiniteFieldElement):
        return True
    return isinstance(x, _sff.IntegerMod) and getattr(x.parent(), "_prime", False)


def prime_value(x):
    """The integer value of x in its field's prime field, if x lies there,
    else None: its coefficients past the constant all zero (the power
    basis; the same test as x^p = x, without the power).  No budget and no
    size bound: O(n) for a field of degree n (at most GF's 1024 bits).
    Both front ends' one prime-field test (astra on 67c8dc48)."""
    if pnq(x.parent())[1] == 1:
        return int(x)
    v = x.list()
    return None if any(int(c) for c in v[1:]) else int(v[0])


def mn(p, n):
    """M(n): the cops of one product in GF(p^n)."""
    return 2 * n * n * (-(-p.bit_length() // 30)) ** 2


def m(K):
    p, n, _ = pnq(K)
    return mn(p, n)


def charge(budget, cops, refuse):
    """Takes cops from budget (a one-element list), or raises refuse()
    first."""
    if cops > budget[0]:
        raise refuse()
    budget[0] -= cops


def conway_ok(K):
    """Whether K is defined by its Conway polynomial (every field GF makes
    without a modulus; a prime field trivially)."""
    p, n, _ = pnq(K)
    return n == 1 or getattr(K, "_f", None) == _sff._CONWAY.get((p, n))


def cover(Ks, refuse):
    """The degree L of the smallest field containing the fields Ks (one
    characteristic), checked without making it or anything else: refuse()
    when two of them are not prime fields and that field would have more
    than EMBED_MAX elements (L log2 p <= 20 before p^L is computed).  One
    extension with prime fields: its degree, any size."""
    ext = {id(K): K for K in Ks if pnq(K)[1] > 1}
    if len(ext) < 2:
        return max(pnq(K)[1] for K in Ks)
    if not all(conway_ok(K) for K in ext.values()):
        raise refuse()
    L, p = 1, pnq(Ks[0])[0]
    for K in ext.values():
        n = pnq(K)[1]
        L = L * n // _math.gcd(L, n)
        if L * (p.bit_length() - 1) > 20:
            raise refuse()
    if p ** L > EMBED_MAX:
        raise refuse()
    return L


def up_cost(S, p, n, seen, hits=None):
    """The cops of putting an element of S (deg S | n) into GF(p^n): its
    Horner work, m M(n) + m n, and the image of S's generator unless cached
    or already counted in seen (one per (p, m, n)); an element of the prime
    field, n.  Read-only: a cached image counted free is only recorded in
    hits, for keep() once every refusal point has passed."""
    return degree_cost(pnq(S)[1], p, n, seen, hits)


def degree_cost(sn, p, n, seen, hits=None):
    """up_cost for a subfield given by its degree sn alone."""
    if sn == n:
        return 0
    if sn == 1:
        return n
    c = sn * (mn(p, n) + n)
    key = (p, sn, n)
    if key in IMAGES:
        if hits is not None:
            hits.add(key)
    elif key not in seen:
        seen.add(key)
        c += 2 * ((p ** n - 1) // (p ** sn - 1)).bit_length() * mn(p, n)
    return c


def keep(hits):
    """The cached images an admitted operation counted free, made the most
    recent (after its last refusal point, before its work), so that no image
    it makes evicts them before they are used."""
    for key in hits:
        if key in IMAGES:
            IMAGES.move_to_end(key)


def image(S, U):
    """The image in U of the generator of its subfield S (deg S | deg U):
    g^((q_U - 1)/(q_S - 1)), kept in the bounded LRU cache IMAGES as its
    coefficients, parent-neutral (every Conway GF(p^n), however named, has
    the same basis), and made an element of U on each use: at most 20
    coefficients copied, a bounded constant within the Horner charge's
    m n term (astra CORR-FFSHARED-1).  (Its cost was reserved by the
    caller, up_cost.)"""
    p, un, uq = pnq(U)
    _, sn, sq = pnq(S)
    key = (p, sn, un)
    c = IMAGES.get(key)
    if c is not None:
        IMAGES.move_to_end(key)
        return U._make(list(c))
    img = U.gen() ** ((uq - 1) // (sq - 1))
    IMAGES[key] = tuple(int(v) for v in img.list())
    if len(IMAGES) > IMAGES_MAX:
        IMAGES.popitem(last=False)
    return img


def embeddable(S, U):
    """Whether F1 embeds S in U: deg S | deg U, both Conway, U of at most
    EMBED_MAX elements (or S the prime field)."""
    _, sn, _ = pnq(S)
    _, un, uq = pnq(U)
    if sn == 1:
        return True
    return uq <= EMBED_MAX and un % sn == 0 and conway_ok(S) and conway_ok(U)


def up(x, U, budget, refuse):
    """x, an element of a subfield S of U (Conway-compatible, deg S | deg U),
    as an element of U: Horner in the image of S's generator.  Its whole
    cost (up_cost) is taken from budget before the image or the element is
    made."""
    if x.parent() is U:
        return x
    S = x.parent()
    if not embeddable(S, U):
        raise refuse()
    p, un, _ = pnq(U)
    charge(budget, up_cost(S, p, un, set()), refuse)
    if pnq(S)[1] == 1:
        return U(int(x))
    img = image(S, U)
    r = U(0)
    for v in reversed([int(v) for v in x.list()]):
        r = r * img + v
    return r


def reserve(counts, Ks, refuse):
    """What putting counts[id(K)] elements of each field K of Ks into the
    smallest field containing all of Ks costs, computed without touching
    anything: (L, cops, hits); their Horner work, each image once, free when
    cached (recorded in hits)."""
    L = cover(Ks, refuse)
    p, seen, hits, cost = pnq(Ks[0])[0], set(), set(), 0
    for K in Ks:
        k = counts.get(id(K), 0)
        if k:
            first = up_cost(K, p, L, seen, hits)  # (one element, and the image if new)
            cost += first + (k - 1) * up_cost(K, p, L, {(p, pnq(K)[1], L)})
    return L, cost, hits


def common_field(Ks, L, budget, refuse, prefix=None):
    """The field of degree L over Ks's prime field: one of Ks, or GF(p^L)
    made (its cold Conway search within what budget has left), the prefix
    field of that prefix (z when None)."""
    U = next((K for K in Ks if pnq(K)[1] == L), None)
    if U is None:
        p = pnq(Ks[0])[0]
        try:
            _sff._conway(p, L, budget)
        except _sff.ConwayBudgetExceeded:
            raise refuse()
        U = _sff.GF(p ** L) if prefix is None else _sff.GF(p ** L, prefix=prefix)
    return U


def admit(counts, Ks, budget, refuse, prefix=None):
    """Admits putting counts[id(K)] elements of each field K of Ks into
    their smallest common field, from budget, before anything is made: the
    work reserved first, then the common field's cold Conway search with
    what is left, then the cached images counted free made the most recent.
    Returns that field and the prepaid budget for up(); refuse()s with the
    image cache untouched."""
    L, cost, hits = reserve(counts, Ks, refuse)
    charge(budget, cost, refuse)
    U = common_field(Ks, L, budget, refuse, prefix)
    keep(hits)
    return U, [cost]


def promote(xs, refuse):
    """xs (finite fields' elements of one characteristic, and integers) with
    their finite fields' elements put into the smallest field containing
    them all, and that field: under one budget of WORK, admitted whole
    first (admit), then the prepaid work."""
    Ks, counts = {}, {}
    for x in xs:
        if is_element(x):
            Ks.setdefault(id(x.parent()), x.parent())
            counts[id(x.parent())] = counts.get(id(x.parent()), 0) + 1
    U, paid = admit(counts, list(Ks.values()), [WORK], refuse)
    return [up(x, U, paid, refuse) if is_element(x) else x for x in xs], U


def dlog_cost(W):
    """D(q, n) of the plan (2A): the cops of the discrete log in W's
    multiplicative group (Pohlig-Hellman, baby-step giant-step on each
    prime-power part), from the factors of N = q - 1, with 2^11 for their
    trial factoring (N <= 2^20)."""
    N = pnq(W)[2] - 1
    b = N.bit_length()
    s = 2 * b
    for r, e in _sff._factor_int(N):
        s += 6 * b + e * (8 * b + 2 * (_math.isqrt(r - 1) + 2))
    return m(W) * s + 2 ** 11


def descendable(W, S):
    """Whether F1 descends from W to its subfield S: deg S | deg W, both
    Conway, W of at most EMBED_MAX elements."""
    _, wn, wq = pnq(W)
    sn = pnq(S)[1]
    return wq <= EMBED_MAX and wn % sn == 0 and conway_ok(S) and conway_ok(W)


def down(x, S, budget, refuse):
    """x, an element of a field W over S (Conway-compatible, deg S | deg W),
    as an element of S, or None when it isn't one: for S prime by x^p = x;
    else by the discrete log k of x to W's generator (D(q, n) +
    2 bits(p^m) M(m), charged before it), x lying in S when
    (q_W - 1)/(q_S - 1) divides k."""
    W = x.parent()
    if W is S:
        return x
    if not descendable(W, S):
        raise refuse()
    if not x:
        return S(0)
    p, sn, sq = pnq(S)
    _, _, wq = pnq(W)
    if sn == 1:
        charge(budget, 2 * p.bit_length() * m(W), refuse)
        v = prime_value(x)
        return None if v is None else S(v)
    charge(budget, dlog_cost(W) + 2 * sq.bit_length() * m(S), refuse)
    k = _sff._dlog(x, W.gen(), None, wq - 1, lambda u, v: u * v, W.one())
    e = (wq - 1) // (sq - 1)
    if k is None or k % e:
        return None
    return S.gen() ** (k // e)


def in_sub(x, S, budget, refuse):
    """Whether x, an element of a field W over S, lies in S: x^(q_S) = x,
    2 bits(q_S) M(n) cops (cheaper than the descent, by value)."""
    W = x.parent()
    if not descendable(W, S):
        raise refuse()
    sq = pnq(S)[2]
    charge(budget, 2 * sq.bit_length() * m(W), refuse)
    return x ** sq == x


def into_cost_n(U, W, k, seen, hits, refuse):
    """An upper bound on the cops of putting k elements of the field W into
    U, up (embedding) or down (descent, a zero's charged too), refused here
    past F1's bounds as up() and down() would be: for admission from counts
    alone."""
    p, wn, _ = pnq(W)
    up_, un, _ = pnq(U)
    if W is U or p != up_ or wn == 1 or un == 1:
        return 0
    if un % wn == 0:
        if not embeddable(W, U):
            raise refuse()
        return up_cost(W, p, un, seen, hits) + (k - 1) * up_cost(W, p, un, {(p, wn, un)})
    if wn % un == 0:
        if not descendable(W, U):
            raise refuse()
        return k * (dlog_cost(W) + 2 * pnq(U)[2].bit_length() * m(U))
    return 0


def into_cost(U, x, seen, hits, refuse):
    """The cops of putting the one element x into U (as into_cost_n, but a
    zero's descent free)."""
    if not is_element(x) or x.parent() is U:
        return 0
    W = x.parent()
    p, wn, _ = pnq(W)
    up_, un, _ = pnq(U)
    if p != up_ or wn == 1 or un == 1:
        return 0
    if un % wn == 0:
        if not embeddable(W, U):
            raise refuse()
        return up_cost(W, p, un, seen, hits)
    if wn % un == 0:
        if not descendable(W, U):
            raise refuse()
        return 0 if not x else dlog_cost(W) + 2 * pnq(U)[2].bit_length() * m(U)
    return 0


def conjugates(S, U, budget, refuse):
    """The roots in U of the defining (Conway) polynomial of its subfield S
    (deg S | deg U): the image of S's generator (image) and its Frobenius
    conjugates, sorted by the integer representations of their negatives
    (as Sage 10.9 lists the embeddings of S into U, black-box: the identity
    in characteristic 2; astra CORR-PR53-3); its cost, the image's if not cached and
    deg S - 1 powers x^p, charged before any of it."""
    p, un, _ = pnq(U)
    sn = pnq(S)[1]
    if sn == 1:
        return [U(1)]
    if not embeddable(S, U):
        raise refuse()
    key = (p, sn, un)
    cost = (sn - 1) * 2 * p.bit_length() * mn(p, un)
    if key not in IMAGES:
        cost += 2 * ((p ** un - 1) // (p ** sn - 1)).bit_length() * mn(p, un)
    charge(budget, cost, refuse)
    roots, c = [], image(S, U)
    for _ in range(sn):
        roots.append(c)
        c = c ** p
    return sorted(roots, key=lambda r: (-r).to_integer())


def subfields_admit(K, degrees, budget, refuse):
    """Admits enumerating the subfields of K of the given degrees (each
    dividing deg K) with their embeddings, from budget, before any field,
    map or result is made or any cache touched (daybreak2 LIMIT-PR53-1):
    first K itself (Conway, of at most EMBED_MAX elements: refuse()
    otherwise, whatever the degrees), then the degrees (their Conway
    polynomials already known, as every Conway field's subfields' are:
    refuse() otherwise, so no search is ever started here), then the
    aggregate work, each proper subfield's generator put into K (up_cost:
    its Horner work and its image unless cached, counted once per degree),
    reserved as a whole.  The cached images counted free are then made the
    most recent.  Returns the prepaid budget for the up() calls; refuse()s
    with every cache unchanged."""
    p, n, q = pnq(K)
    if q > EMBED_MAX or not conway_ok(K):
        raise refuse()
    if any(d < 1 or n % d for d in degrees):
        raise refuse()
    proper = sorted(set(d for d in degrees if 1 < d < n))
    if any((p, d) not in _sff._CONWAY for d in proper):
        raise refuse()
    seen, hits = set(), set()
    cost = sum(degree_cost(d, p, n, seen, hits) for d in proper)
    charge(budget, cost, refuse)
    keep(hits)
    return [cost]


def apply(x, U, img, budget, refuse):
    """The image in U of x, an element of a field S, under the map sending
    S's generator to img (a root in U of S's defining polynomial): Horner,
    deg S (M(n) + n) cops, charged first."""
    S = x.parent()
    p, un, _ = pnq(U)
    sn = pnq(S)[1]
    if sn == 1:
        return U(int(x))
    charge(budget, sn * (mn(p, un) + un), refuse)
    r = U(0)
    for v in reversed([int(v) for v in x.list()]):
        r = r * img + v
    return r


# Traces, norms, minimal and characteristic polynomials and roots
# (plan-finite-fields F2), for both front ends: each computes its whole
# cost first, in closed form from p, n (and m, k), and charges it to the
# caller's budget before the first power; past it the caller's refuse().
# Over the prime field these work in every field GF makes (no 2^20 bound);
# relative to a proper subfield they descend by F1's down(), so they are
# bounded as it is (overfield of at most EMBED_MAX elements).  Results are
# neutral: prime-field values as ints, polynomials as coefficient lists
# (constant first), which each front end turns into its own objects.

ROOT_BITS = 1024  # Root/nth_root exponents of more bits are refused (Magma takes them)


def w(p):
    """The word factor of the plan's cost model: ceil(bits(p) / 30)^2."""
    return (-(-p.bit_length() // 30)) ** 2


def pow_cost(e, M):
    """The cops of x^e (e >= 1) with products of M cops: square and
    multiply, at most 2 (bits(e) - 1) products, 2 at least."""
    return 2 * max(1, e.bit_length() - 1) * M


def _prime_int(x):
    """The int value of x, an element of a prime field or of an extension
    lying in its prime field (a trace, a norm, a coefficient)."""
    v = prime_value(x)
    if v is None:
        raise ArithmeticError("not in the prime field")  # (never, for these results)
    return v


def trace_cost(K):
    """Of the absolute trace in K = GF(p^n): n - 1 Frobenius powers x^p and
    as many sums of n coefficients."""
    p, n, _ = pnq(K)
    return 0 if n == 1 else (n - 1) * (pow_cost(p, mn(p, n)) + n * w(p))


def trace(x, budget, refuse):
    """Tr(x) = x + x^p + ... + x^(p^(n-1)), the trace of x to the prime
    field, as an int.

        sage: import _sage_ffsub as S
        sage: k.<a> = GF(9); S.trace(a, [S.WORK], ValueError)
        1
    """
    K = x.parent()
    p, n, _ = pnq(K)
    if n == 1:
        return int(x)
    charge(budget, trace_cost(K), refuse)
    s = y = x
    for _ in range(n - 1):
        y = y ** p
        s = s + y
    return _prime_int(s)


def norm_cost(K):
    """Of the absolute norm: one power x^((q - 1)/(p - 1))."""
    p, n, q = pnq(K)
    return 0 if n == 1 else pow_cost((q - 1) // (p - 1), mn(p, n))


def norm(x, budget, refuse):
    """N(x) = x^((q - 1)/(p - 1)), the norm of x to the prime field, as an
    int."""
    K = x.parent()
    p, n, q = pnq(K)
    if n == 1:
        return int(x)
    charge(budget, norm_cost(K), refuse)
    return _prime_int(x ** ((q - 1) // (p - 1)))


def _orbit(x, step, limit):
    """x, x^step, x^(step^2), ... up to (not including) the first repeat,
    at most limit of them."""
    out, y = [x], x
    for _ in range(limit - 1):
        y = y ** step
        if y == x:
            break
        out.append(y)
    return out


def _from_roots(roots, one):
    """The coefficients (constant first) of the product of X - r over roots,
    each step a product by a linear factor."""
    c = [one]
    for r in roots:
        c = [-r * c[0]] + [c[i - 1] - r * c[i] for i in range(1, len(c))] + [c[-1]]
    return c


def minpoly_cost(K):
    """Of the absolute minimal polynomial in GF(p^n): the orbit of x under
    Frobenius (n - 1 powers x^p), the product of up to n linear factors
    (n^2 products and sums), and the n + 1 coefficients' prime-field values."""
    p, n, _ = pnq(K)
    return 0 if n == 1 else (n - 1) * pow_cost(p, mn(p, n)) + n * n * (mn(p, n) + n * w(p)) + (n + 1) * n * w(p)


def minpoly(x, budget, refuse):
    """The minimal polynomial of x over the prime field, its coefficients
    as ints mod p (constant first): the product of X - c over the distinct
    conjugates c of x.

        sage: import _sage_ffsub as S
        sage: F.<z> = GF(3^4); S.minpoly(z^5, [S.WORK], ValueError)
        [2, 0, 2, 0, 1]
    """
    K = x.parent()
    p, n, _ = pnq(K)
    if n == 1:
        return [(-int(x)) % p, 1]
    charge(budget, minpoly_cost(K), refuse)
    return [_prime_int(c) for c in _from_roots(_orbit(x, p, n), K.one())]


def _poly_pow(c, e, mul, add, zero):
    """The coefficients of the polynomial c^e (e >= 1), by repeated products."""
    r = c
    for _ in range(e - 1):
        out = [zero] * (len(r) + len(c) - 1)
        for i, u in enumerate(r):
            for j, v in enumerate(c):
                out[i + j] = add(out[i + j], mul(u, v))
        r = out
    return r


def charpoly_cost(K):
    """Of the absolute characteristic polynomial: the minimal polynomial's,
    then its power of degree n over GF(p) (at most n products of
    polynomials of degree at most n: n^3 prime-field products and sums)."""
    p, n, _ = pnq(K)
    return minpoly_cost(K) + 2 * n ** 3 * w(p)


def charpoly(x, budget, refuse):
    """The characteristic polynomial of x over the prime field (degree n,
    the minimal polynomial's power), coefficients as ints mod p."""
    K = x.parent()
    p, n, _ = pnq(K)
    if n == 1:
        return [(-int(x)) % p, 1]
    charge(budget, charpoly_cost(K), refuse)
    f = [_prime_int(c) for c in _from_roots(_orbit(x, p, n), K.one())]
    return _poly_pow(f, n // (len(f) - 1), lambda u, v: u * v % p, lambda u, v: (u + v) % p, 0)


def is_subfield(F, K):
    """Whether the finite field F is a subfield of K, as both front ends
    see their fields: one characteristic, deg F | deg K."""
    pf, mf, _ = pnq(F)
    pk, nk, _ = pnq(K)
    return pf == pk and nk % mf == 0


def _down_cost(K, F):
    """An upper bound on one down() from K to its proper subfield F."""
    return dlog_cost(K) + 2 * pnq(F)[2].bit_length() * m(F)


def relative_cost(what, K, F):
    """The closed-form cops of a relative Trace, Norm, MinimalPolynomial or
    CharacteristicPolynomial ('trace', 'norm', 'minpoly', 'charpoly') of an
    element of K over its proper subfield F (1 < deg F < deg K, K of at
    most EMBED_MAX elements): its powers in K, its products, and one
    descent per coefficient, r + 1 of them for a polynomial of degree at most
    r = deg K / deg F (F1's down())."""
    p, n, q = pnq(K)
    mm, qf = pnq(F)[1], pnq(F)[2]
    r, M = n // mm, mn(p, n)
    if what == "trace":
        return (r - 1) * (pow_cost(qf, M) + n * w(p)) + _down_cost(K, F)
    if what == "norm":
        return pow_cost((q - 1) // (qf - 1), M) + _down_cost(K, F)
    c = (r - 1) * pow_cost(qf, M) + r * r * (M + n * w(p)) + (r + 1) * _down_cost(K, F)
    if what == "charpoly":
        c += 2 * r ** 3 * (mn(p, mm) + mm * w(p))
    return c


def relative(what, x, F, budget, refuse):
    """The relative Trace, Norm (elements of F), MinimalPolynomial or
    CharacteristicPolynomial (coefficient lists over F, constant first) of
    x over F, a subfield of x's field K (is_subfield(F, K), checked by the
    caller): over the prime field the absolute ones (as elements of F);
    over K itself x, x and X - x; else, for K of at most EMBED_MAX elements
    (Conway, as F1), the sum, power or product over the orbit of x under
    x -> x^(q_F), its coefficients descended to F, the whole cost
    (relative_cost) charged first.  refuse() past the bounds.

        sage: import _sage_ffsub as S
        sage: F, K = GF(4), GF(16)
        sage: S.relative('minpoly', K.gen(), F, [S.WORK], ValueError)
        [z2, 1, 1]
    """
    K = x.parent()
    p, n, _ = pnq(K)
    mm = pnq(F)[1]
    if mm == 1:
        if what == "trace":
            return F(trace(x, budget, refuse))
        if what == "norm":
            return F(norm(x, budget, refuse))
        f = (minpoly if what == "minpoly" else charpoly)(x, budget, refuse)
        return [F(c) for c in f]
    if mm == n:
        return x if what in ("trace", "norm") else [-x, K.one()]
    if not descendable(K, F):
        raise refuse()
    charge(budget, relative_cost(what, K, F), refuse)
    qf = pnq(F)[2]
    # (the descents' share of what was charged, prepaid to down())
    sub = [(1 if what in ("trace", "norm") else n // mm + 1) * _down_cost(K, F)]
    if what == "trace":
        s = y = x
        for _ in range(n // mm - 1):
            y = y ** qf
            s = s + y
        return down(s, F, sub, refuse)
    if what == "norm":
        return down(x ** ((pnq(K)[2] - 1) // (qf - 1)), F, sub, refuse)
    f = [down(c, F, sub, refuse) for c in _from_roots(_orbit(x, qf, n // mm), K.one())]
    if what == "charpoly":
        f = _poly_pow(f, (n // mm) // (len(f) - 1), lambda u, v: u * v, lambda u, v: u + v, F(0))
    return f


def root(x, k, budget, refuse_bits, refuse):
    """The k-th roots of x (k >= 1, checked by the caller) as far as they
    are determined: ("unique", r) when x has exactly one (x = 0, or
    gcd(k, q - 1) = 1: r = x^(k^-1 mod (q - 1))); ("none", None) when it
    has none (x^((q - 1)/g) != 1, g = gcd(k, q - 1)); ("many", None) when it
    has several, whose choice is the front end's (Magma's and Sage's
    differ).  refuse_bits() for k of more than ROOT_BITS bits, before any
    arithmetic on k; then the Euclidean step and one power are charged
    before either.

        sage: import _sage_ffsub as S
        sage: S.root(GF(13)(8), 5, [S.WORK], ValueError, ValueError)
        ('unique', 8)
    """
    if k.bit_length() > ROOT_BITS:
        raise refuse_bits()
    K = x.parent()
    p, n, q = pnq(K)
    b = k.bit_length() + q.bit_length()
    charge(budget, b * (-(-b // 30)) ** 2 + pow_cost(q, mn(p, n) if n > 1 else w(p)), refuse)
    if not x:
        return ("unique", x)
    g = _math.gcd(k % (q - 1), q - 1)
    if g == 1:
        return ("unique", x ** pow(k % (q - 1), -1, q - 1) if q > 2 else x)
    if x ** ((q - 1) // g) != K.one():
        return ("none", None)
    return ("many", None)
