"""sagebrush.poly.mul (the engine's poly_mul: Kronecker substitution on one
NTT product, admitted before any allocation) against Python's exact integer
arithmetic, on many shapes: tiny, square, unbalanced, huge and negative
coefficients, cancellation, zero factors; and sagebrush.poly.qmul (qpoly_mul,
over QQ: the common denominators, the product and each coefficient's
reduction in the engine) against Fraction arithmetic.  Both call through
sagebrush._engine.call_hex, checked against call().  Past the caps the engine refuses,
naming the cap: the quadratic shape (many one-digit coefficients times one
huge one) is refused before any allocation.  Runs on CPython and in pyjs:

    python engine/py/test_poly_mul.py
    node dist/src/cli.js engine/py/test_poly_mul.py
"""
import random

import sagebrush.poly as P


def reference(a, b):
    # (the test's own schoolbook product, the reference; trailing zeros dropped)
    if not a or not b:
        return []
    c = [0] * (len(a) + len(b) - 1)
    for i, x in enumerate(a):
        for j, y in enumerate(b):
            c[i + j] += x * y
    while c and c[-1] == 0:
        c.pop()
    return c


def qcoef(r, nbits, dbits):
    from fractions import Fraction
    d = r.getrandbits(dbits) + 1 if dbits else 1
    return Fraction(coef(r, nbits), d)


def coef(r, bits):
    x = r.getrandbits(bits) if bits else 0
    return -x if r.random() < 0.5 else x


def qclear_checks(r):
    """sagebrush.poly.qclear (the engine's qpoly_clear): (d, the integers of
    d f) with d the lcm of the nonzero coefficients' denominators as given,
    one integer per coefficient, in order, trailing zeros kept; against
    Fraction arithmetic.  Coefficients of any type but exactly int and
    Fraction (and Sage's own Integer, Rational and the int a Rational's
    numerator() returns) are refused before any of
    their properties, formatting or the engine's bridge is reached."""
    from fractions import Fraction
    from math import lcm
    from sagebrush import _engine as E

    def ref(c):
        d = 1
        for x in c:
            if x:
                d = lcm(d, Fraction(x).denominator)
        return d, [int(Fraction(x) * d) for x in c]
    n = 0
    shapes = [[], [0], [0, 0, 0], [5], [Fraction(-3, 7)], [Fraction(1, 2), Fraction(1, 3), Fraction(1, 6)],
              [Fraction(1, 2), 0, 0], [3, -2, 1], [Fraction(2 ** 200 + 1, 3 ** 90), -(2 ** 150), Fraction(1, 2 ** 70), 0]]
    for la, nb, db in [(10, 8, 8), (100, 63, 20), (300, 30, 3)]:
        shapes.append([qcoef(r, nb, db) for _ in range(la)])
    for c in shapes:
        assert P.qclear(c) == ref(c), c[:5]
        n += 1
    # (Fractions are always in lowest terms here; zero is 0, whose
    # denominator takes no part)
    assert P.qclear([0, Fraction(1, 3)]) == (3, [0, 1])
    # (exact types only: subclasses whose numerator, denominator, format or
    # __class__ are spoofed are refused before any of those runs, and before
    # the bridge is called; bool is refused too)
    touched = []

    class I1(int):
        def __format__(self, spec):
            touched.append("format")
            return "0"

    class I2(int):
        __class__ = property(lambda self: int)

    class F1(Fraction):
        @property
        def numerator(self):
            touched.append("numerator")
            return 1

    class F2(Fraction):
        @property
        def denominator(self):
            touched.append("denominator")
            return 1

    class F3(Fraction):
        def __format__(self, spec):
            touched.append("format")
            return "0"

    class F4(Fraction):
        __class__ = property(lambda self: Fraction)

    class F5(Fraction):
        def __getattribute__(self, attr):
            touched.append(attr)
            return Fraction.__getattribute__(self, attr)
    # (rejected classes whose metaclass hooks hashing and attribute reads:
    # the dispatch compares the class by identity only, and the refusal
    # reads nothing of it)
    def meta(base):
        class Meta(base):
            def __hash__(cls):
                touched.append("hash")
                return base.__hash__(cls)

            def __eq__(cls, other):
                touched.append("eq")
                return base.__eq__(cls, other)

            def __getattribute__(cls, attr):
                touched.append("get:" + attr)
                return base.__getattribute__(cls, attr)
        return Meta

    # (and a metaclass that claims to equal int and hashes as int: by
    # identity it is still not int)
    class Claims(type):
        def __hash__(cls):
            return hash(int)

        def __eq__(cls, other):
            return other is int or type.__eq__(cls, other)

    M4 = Claims("M4", (int,), {})

    M1 = meta(type)("M1", (), {})
    M2 = meta(type)("M2", (int,), {})
    M3 = meta(type(Fraction))("M3", (Fraction,), {})
    bads = [I1(3), I2(3), F1(1, 2), F2(1, 2), F3(1, 2), F4(1, 2), F5(1, 2), M1(), M2(3), M3(1, 2), M4(7), True, 1.5, "1", None]
    del touched[:]
    name = "_sbengine" if hasattr(E, "_sbengine") else "_native"
    real = getattr(E, name)
    calls = []

    class Spy:
        def call(self, text):
            calls.append(text)
            return '{"ok":{"d":"1","c":""}}'
    setattr(E, name, Spy())
    try:
        for bad in bads:
            try:
                P.qclear([1, bad])
            except TypeError as e:
                assert "qclear" in str(e), e
            else:
                raise AssertionError("accepted %r" % (bad,))
            n += 1
    finally:
        setattr(E, name, real)
    assert calls == [] and touched == [], (calls, touched)
    # (Sage's own Integer and Rational, and the int numerator() returns, are
    # accepted)
    try:
        import sagebrush.sage as S
    except ImportError:
        import sage_all as S
    q = S.QQ(5) / 7
    assert P.qclear([S.Integer(3), q, q.numerator()]) == (7, [21, 5, 35])
    return n


def zdivrem_checks(r):
    """sagebrush.poly.zdivrem (the engine's zpoly_divrem): Sage's rule in
    Z[x], against ZZ[t].quo_rem in real Sage (the 26 hand-picked cases of the
    engine's oracle, recorded); and the exact-type pins of qclear at this
    entry: bool, int subclasses spoofing __index__, __int__, __format__ or
    __class__, and classes whose metaclass hooks __hash__, __eq__ or
    __getattribute__ (or claims to be int) are refused before any hook runs
    or the engine's bridge is reached."""
    from fractions import Fraction
    from sagebrush import _engine as E
    n = 0
    oracle = [
        ([0, 1], [1, 2], [], [0, 1]),
        ([1, 0, 3], [1, 2], [0, 1], [1, -1, 1]),
        ([0, 0, -3], [1, 2], [1, -2], [-1, 0, 1]),
        ([5, 7, 9], [1, 2], [1, 4], [4, 1, 1]),
        ([5, -7, 9], [-1, -2], [6, -5], [11, 0, -1]),
        ([5, 7, -9], [3, -2], [2, 4], [-1, -1, -1]),
        ([1, 1, 1, 1], [1, 3], [], [1, 1, 1, 1]),
        ([2, 4, 6, 8], [2, 4], [1, 0, 2], [0, 0, 2]),
        ([1, 2, 3, 4, 5], [1, 0, 3], [0, 1, 1], [1, 1, 2, 1, 2]),
        ([-1, -2, -3, -4, -5], [1, 0, 3], [0, -2, -2], [-1, 0, -1, 2, 1]),
        ([7, 0, 0, 0, 2], [0, 0, 5], [], [7, 0, 0, 0, 2]),
        ([7, 0, 0, 0, 6], [0, 0, 5], [0, 0, 1], [7, 0, 0, 0, 1]),
        ([7, 0, 0, 0, -6], [0, 0, 5], [0, 0, -2], [7, 0, 0, 0, 4]),
        ([7, 0, 0, 0, -5], [0, 0, 5], [0, 0, -1], [7]),
        ([7, 0, 0, 0, -4], [0, 0, 5], [], [7, 0, 0, 0, -4]),
        ([3, 4], [5], [], [3, 4]),
        ([3, -4, 10], [-5], [0, 0, -2], [3, -4]),
        ([3, -4, 10], [-3], [-1, 1, -4], [0, -1, -2]),
        ([1, 2], [1, 2, 3], [], [1, 2]),
        ([0], [1, 2], [], []),
        ([4, 5, 6, 7], [1, 1], [6, -1, 7], [-2]),
        ([4, 5, 6, 7], [1, -1], [-18, -13, -7], [22]),
        ([10, -20, 30, -40, 50], [7, -3, 4], [-15, -1, 12], [115, -58, 3, 0, 2]),
        ([1, 0, 0, 0, 0, 0, 1], [1, 1, 2], [], [1, 0, 0, 0, 0, 0, 1]),
        ([-9, 8, -7, 6, -5, 4], [2, -3], [-2, 1, -2, 0, -2], [-5, 0, 0, 0, -1, -2]),
        ([6, 0, 0, 4], [0, 3], [0, 0, 1], [6, 0, 0, 1]),
    ]
    for a, b, q, rr in oracle:
        assert P.zdivrem(a, b) == (q, rr), (a, b, P.zdivrem(a, b), q, rr)
        n += 1
    try:
        P.zdivrem([1, 2], [0, 0])
    except Exception as e:
        assert "division by zero polynomial" in str(e), e
    else:
        raise AssertionError("a zero divisor was accepted")
    touched = []

    class I1(int):
        def __index__(self):
            touched.append("index")
            return 0

    class I2(int):
        def __int__(self):
            touched.append("int")
            return 0

    class I3(int):
        def __format__(self, spec):
            touched.append("format")
            return "0"

    class I4(int):
        __class__ = property(lambda self: int)

    def meta(base):
        class Meta(base):
            def __hash__(cls):
                touched.append("hash")
                return base.__hash__(cls)

            def __eq__(cls, other):
                touched.append("eq")
                return base.__eq__(cls, other)

            def __getattribute__(cls, attr):
                touched.append("get:" + attr)
                return base.__getattribute__(cls, attr)
        return Meta

    class Claims(type):
        def __hash__(cls):
            return hash(int)

        def __eq__(cls, other):
            return other is int or type.__eq__(cls, other)

    M1 = meta(type)("M1", (int,), {})
    M2 = Claims("M2", (int,), {})
    bads = [I1(3), I2(3), I3(3), I4(3), M1(3), M2(7), True, Fraction(1, 2), 1.5, "1", None]
    del touched[:]
    name = "_sbengine" if hasattr(E, "_sbengine") else "_native"
    real = getattr(E, name)
    calls = []

    class Spy:
        def call(self, text):
            calls.append(text)
            return '{"ok":{"q":"","r":""}}'
    setattr(E, name, Spy())
    try:
        for bad in bads:
            for args in (([1, bad], [1, 1]), ([1, 1], [bad, 1])):
                try:
                    P.zdivrem(*args)
                except TypeError as e:
                    assert "zdivrem" in str(e), e
                else:
                    raise AssertionError("accepted %r" % (bad,))
                n += 1
    finally:
        setattr(E, name, real)
    assert calls == [] and touched == [], (calls, touched)
    return n


def qdivrem_checks(r):
    """sagebrush.poly.qdivrem (the engine's qpoly_divrem): exact division in
    Q[x] against a Fraction schoolbook (here only), results in lowest terms;
    a zero divisor in any spelling refused; and qclear's exact-type pins at
    this entry (bool, int and Fraction subclasses spoofing their accessors,
    __format__ or __class__, and metaclasses hooking __hash__, __eq__ or
    __getattribute__ or claiming to be int), refused before any hook runs or
    the engine's bridge is reached."""
    from fractions import Fraction
    from sagebrush import _engine as E

    def school(a, b):
        a, b = [Fraction(x) for x in a], [Fraction(x) for x in b]
        while a and a[-1] == 0:
            a.pop()
        while b and b[-1] == 0:
            b.pop()
        rr = list(a)
        q = [Fraction(0)] * max(len(rr) - len(b) + 1, 0)
        for i in range(len(q) - 1, -1, -1):
            c = rr[i + len(b) - 1] / b[-1]
            q[i] = c
            for j, x in enumerate(b):
                rr[i + j] -= c * x
        rr = rr[:len(b) - 1] if len(rr) >= len(b) else rr
        while q and q[-1] == 0:
            q.pop()
        while rr and rr[-1] == 0:
            rr.pop()
        return q, rr
    n = 0
    for _ in range(90):
        a = [Fraction(r.randint(-99, 99), r.randint(1, 9)) for _ in range(r.randint(0, 9))]
        b = [Fraction(r.randint(-99, 99), r.randint(1, 9)) for _ in range(r.randint(1, 5))]
        if b[-1] == 0:
            b[-1] = Fraction(3, 2)
        assert P.qdivrem(a, b) == school(a, b), (a, b)
        n += 1
    assert P.qdivrem([1, 0, 0, 1], [1, 2]) == ([Fraction(1, 8), Fraction(-1, 4), Fraction(1, 2)], [Fraction(7, 8)])
    for b in ([0], [Fraction(0, 5), 0], []):
        try:
            P.qdivrem([1, 2], b)
        except Exception as e:
            assert "division by zero polynomial" in str(e), e
        else:
            raise AssertionError("a zero divisor was accepted: %r" % (b,))
        n += 1
    touched = []

    class I1(int):
        def __index__(self):
            touched.append("index")
            return 0

    class F1(Fraction):
        @property
        def numerator(self):
            touched.append("numerator")
            return 1

    class F2(Fraction):
        def __format__(self, spec):
            touched.append("format")
            return "0"

    class F3(Fraction):
        __class__ = property(lambda self: Fraction)

    def meta(base):
        class Meta(base):
            def __hash__(cls):
                touched.append("hash")
                return base.__hash__(cls)

            def __eq__(cls, other):
                touched.append("eq")
                return base.__eq__(cls, other)

            def __getattribute__(cls, attr):
                touched.append("get:" + attr)
                return base.__getattribute__(cls, attr)
        return Meta

    class Claims(type):
        def __hash__(cls):
            return hash(int)

        def __eq__(cls, other):
            return other is int or type.__eq__(cls, other)

    M1 = meta(type)("M1", (int,), {})
    M2 = meta(type(Fraction))("M2", (Fraction,), {})
    M3 = Claims("M3", (int,), {})
    bads = [I1(3), F1(1, 2), F2(1, 2), F3(1, 2), M1(3), M2(1, 2), M3(7), True, 1.5, "1", None]
    del touched[:]
    name = "_sbengine" if hasattr(E, "_sbengine") else "_native"
    real = getattr(E, name)
    calls = []

    class Spy:
        def call(self, text):
            calls.append(text)
            return '{"ok":{"q":"","r":""}}'
    setattr(E, name, Spy())
    try:
        for bad in bads:
            for args in (([1, bad], [1, 1]), ([1, 1], [bad, 1])):
                try:
                    P.qdivrem(*args)
                except TypeError as e:
                    assert "qdivrem" in str(e), e
                else:
                    raise AssertionError("accepted %r" % (bad,))
                n += 1
    finally:
        setattr(E, name, real)
    assert calls == [] and touched == [], (calls, touched)
    # (Sage's own Integer and Rational, and the int numerator() returns, are
    # accepted)
    try:
        import sagebrush.sage as S
    except ImportError:
        import sage_all as S
    q = S.QQ(5) / 7
    assert P.qdivrem([S.Integer(3), q, q.numerator()], [q]) == ([Fraction(21, 5), 1, 7], [])
    return n


def call_hex_checks(r):
    """sagebrush._engine.call_hex, the lean text lane poly.mul and qmul use:
    the same values as call() for ok replies (the empty one included) and
    the same exceptions for every error class; a reply that isn't exactly
    an ok envelope of hex tokens goes through json; fields are validated."""
    from sagebrush import _engine as E
    n = 0
    # (ok replies: parity with call(), the empty product included)
    for la, lb in [(1, 1), (3, 3), (16, 16), (40, 7), (0, 3)]:
        a, b = P._hex([coef(r, 70) for _ in range(la)]), P._hex([coef(r, 70) for _ in range(lb)])
        assert E.call_hex("poly_mul", a, b) == E.call("poly_mul", a=a, b=b), (la, lb)
        n += 1
    assert E.call_hex("poly_mul", "0", "5") == "" == E.call("poly_mul", a="0", b="5")
    qa, qb = "1/2,-3,5/7", "-2/3,4"
    assert E.call_hex("qpoly_mul", qa, qb) == E.call("qpoly_mul", a=qa, b=qb)
    # (errors: the same class and text as call(): a refusal, a malformed
    # token, an unknown op)
    def raised(f):
        try:
            f()
        except Exception as e:
            return type(e), str(e)
        raise AssertionError("no error")
    big = ",".join(["1"] * (1 << 16))
    huge = "f" * 150000
    for fn, a, b in [("poly_mul", big, huge), ("poly_mul", "01", "1"), ("qpoly_mul", "1/0", "1"), ("poly_mul_x", "1", "1")]:
        assert raised(lambda: E.call_hex(fn, a, b)) == raised(lambda: E.call(fn, a=a, b=b)), (fn, a[:20], b[:20])
        n += 1
    # (the bridge's replies replaced, through the same bridge entry: an
    # internal error, a Stop, and envelopes the strict slice must refuse)
    name = "_sbengine" if hasattr(E, "_sbengine") else "_native"
    real = getattr(E, name)

    class Stub:
        def __init__(self, reply):
            self.reply = reply

        def call(self, text):
            if isinstance(self.reply, BaseException):
                raise self.reply
            return self.reply
    try:
        for text in ['{"error":"x: internal error","internal":true}', '{"error":"a refusal"}']:
            setattr(E, name, Stub(text))
            assert raised(lambda: E.call_hex("poly_mul", "1", "1")) == raised(lambda: E.reply(text)), text
        setattr(E, name, Stub(KeyboardInterrupt()))
        try:
            E.call_hex("poly_mul", "1", "1")
        except KeyboardInterrupt:
            pass
        else:
            raise AssertionError("a Stop was swallowed")
        # (not exactly {"ok":"<hex>"}: decoded by json, same value as reply())
        for text in ['{"ok":"1,2","x":1}', '{"ok":"1,\\u0032"}', '{"ok":"1,2"} ', '{"ok":"A"}', '{"ok": "1,2"}']:
            setattr(E, name, Stub(text))
            assert E.call_hex("poly_mul", "1", "1") == E.reply(text), text
            n += 1
        for text in ['{"ok":"}', '{"ok":"1,2"}x', '{"ok":"1,2"']:
            setattr(E, name, Stub(text))
            assert raised(lambda: E.call_hex("poly_mul", "1", "1")) == raised(lambda: E.reply(text)), text
            n += 1
    finally:
        setattr(E, name, real)
    # (the fields and the op name validated before anything is sent)
    for fn, a, b in [("poly_mul", "1", '1"'), ("poly_mul", "1", "1;2"), ("poly_mul", "1", "A"), ("poly_mul", 1, "1"),
                     ("poly_mul", "1", b"1"), ('poly_mul","x', "1", "1"), ("", "1", "1"), ("factor", "1", "1")]:
        try:
            E.call_hex(fn, a, b)
        except ValueError as e:
            assert "call_hex" in str(e), e
        else:
            raise AssertionError("accepted %r %r %r" % (fn, a, b))
        n += 1

    # (exact types only: a str subclass whose translate hides JSON syntax, one
    # that spoofs __eq__/__hash__ to match a cached op name, ones that also
    # claim str through a __class__ property or a __getattribute__ override
    # (as fn, a and b), and
    # str-subclass fields, are refused before the bridge is called; an
    # unhashable op name is a ValueError too)
    class Evil(str):
        def translate(self, table):
            return ""

    class Spoof(str):
        # (equal to and hashing as "poly_mul", already in the op-name cache)
        def __eq__(self, other):
            return other == "poly_mul"

        def __hash__(self):
            return hash("poly_mul")
    class Masked(str):
        # (claims to be str through __class__, and hides its contents from
        # translate: only type() sees through it)
        __class__ = property(lambda self: str)

        def translate(self, table):
            return ""

    class Shadow(str):
        # (answers every attribute lookup itself: __class__ is str, translate
        # hides the contents)
        def __getattribute__(self, attr):
            if attr == "__class__":
                return str
            if attr == "translate":
                return lambda table: ""
            return str.__getattribute__(self, attr)

    # (the real name cached first; on CPython the spoof is then "in" the cache)
    E.call_hex("poly_mul", "1", "1")
    assert "poly_mul" in E._HEX_OPS
    calls = []

    class Spy:
        def call(self, text):
            calls.append(text)
            return '{"ok":""}'
    setattr(E, name, Spy())
    try:
        for fn, a, b in [(Evil('poly_mul","x'), "1", "1"), (Evil("poly_mul"), "1", "1"), (Spoof('poly_mul","x'), "1", "1"), (Masked('poly_mul","x'), "1", "1"),
                         ("poly_mul", Masked('1","x":"'), "1"), ("poly_mul", "1", Masked('1","x":"')),
                         (Shadow('poly_mul","x'), "1", "1"), ("poly_mul", Shadow('1","x":"'), "1"), ("poly_mul", "1", Shadow('1","x":"')),
                         ("poly_mul", Evil('1","x":"'), "1"),
                         ("poly_mul", "1", Evil("1")), (["poly_mul"], "1", "1"), ({}, "1", "1"), (None, "1", "1")]:
            try:
                E.call_hex(fn, a, b)
            except ValueError as e:
                assert "call_hex" in str(e), e
            else:
                raise AssertionError("accepted %r %r %r" % (fn, a, b))
            n += 1
        assert calls == [], calls
    finally:
        setattr(E, name, real)
    return n


def main():
    r = random.Random(1234)
    shapes = [(1, 1, 1, 1), (3, 8, 3, 8), (1, 8, 40, 8), (7, 64, 5, 63), (40, 65, 41, 1), (120, 64, 90, 200),
              (500, 8, 4, 64), (8, 4096, 8, 4096), (2, 20000, 3, 9), (600, 1, 700, 2)]
    n = 0
    for la, ba, lb, bb in shapes:
        for _ in range(3):
            a = [coef(r, ba) for _ in range(la)]
            b = [coef(r, bb) for _ in range(lb)]
            assert P.mul(a, b) == reference(a, b), (la, ba, lb, bb)
            n += 1
    edge = [([], [1, 2]), ([0, 0], [1, 2]), ([1, 1], [1, -1]), ([-1, -2, -3], [-4, -5]),
            ([2 ** 64 - 1], [2 ** 64 - 1]), ([-(2 ** 63)], [2 ** 63]), ([0, 0, 5], [0, 3]), ([1] * 33, [-1] * 31)]
    for a, b in edge:
        assert P.mul(a, b) == reference(a, b), (a, b)
        n += 1
    # the quadratic shape: refused, naming the cap, before any allocation
    try:
        P.mul([1] * (1 << 16), [(1 << 600000) - 1])
    except ValueError as e:
        assert "the product's bits" in str(e) and "a smaller product per call" in str(e), e
    else:
        raise AssertionError("a 2^25-bit-plus product was admitted")
    # over QQ: qmul against Fraction arithmetic, lowest terms and int for an
    # integral coefficient (as Fraction's own arithmetic normalizes)
    from fractions import Fraction

    def qnorm(c):
        return [int(x) if x.denominator == 1 else x for x in map(Fraction, c)]
    qshapes = [(1, 1, 1, 1, 1, 1), (3, 8, 2, 5, 8, 3), (20, 64, 70, 30, 40, 1), (7, 200, 100, 9, 1, 130),
               (60, 1, 2, 60, 1, 2), (5, 300, 300, 5, 300, 300)]
    for la, na, da, lb, nb, db in qshapes:
        for _ in range(3):
            a = [qcoef(r, na, da) for _ in range(la)]
            b = [qcoef(r, nb, db) for _ in range(lb)]
            got = P.qmul(a, b)
            assert got == qnorm(reference(a, b)), (la, na, da, lb, nb, db)
            assert all(type(x) is int or x.denominator > 1 for x in got)
            n += 1
    for a, b in [([], [Fraction(1, 2)]), ([0, 0], [Fraction(1, 3)]), ([Fraction(1, 2)] * 40, [Fraction(-1, 2)] * 30),
                 ([Fraction(1, 3), Fraction(2, 3)], [3, -3]), ([Fraction(-7, 2 ** 70)], [2 ** 70]), ([1, 2, 3], [4, 5])]:
        assert P.qmul(a, b) == qnorm(reference(a, b)), (a, b)
        n += 1
    # many distinct coprime denominators: refused by the lcm's metered work,
    # naming it
    try:
        P.qmul([Fraction(1, (1 << 62) + 2 * i + 1) for i in range(20000)], [Fraction(1, 3)])
    except ValueError as e:
        assert "the denominators' lcm needs more than" in str(e), e
    else:
        raise AssertionError("20000 coprime denominators were admitted")
    # Sage mode's products go through it (ZZ[x] by poly_mul, QQ[x] by qpoly_mul)
    try:
        import sagebrush.sage as S
    except ImportError:
        import sage_all as S
    R = S.PolynomialRing(S.QQ, "x")
    x = R.gen()
    f = (x + Fraction(1, 2)) * (x - Fraction(1, 3)) * (3 * x + 1)
    assert list(f) == [Fraction(-1, 6), Fraction(-1, 3), Fraction(3, 2), 3], list(f)
    n += qclear_checks(r)
    n += call_hex_checks(r)
    n += zdivrem_checks(r)
    n += qdivrem_checks(r)
    print("poly_mul against exact products: %d cases ok" % n)


if __name__ == "__main__":
    main()
