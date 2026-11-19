"""GF(p)[x] through the engine's binary entry point (SBW1; engine/web
bin_ops.rs): the same answers as the JSON requests and as the Python
paths, results that keep their words until a coefficient is asked for, the
JSON fallback when the engine predates the entry point, and the error
records.  Shared by the CPython package and pyjs.

    python3 test/ff_poly_bin.py        (CPython, the package installed)
"""
try:
    from sage_all import *  # pyjs
except ImportError:
    import sagebrush  # noqa: F401
    from sagebrush.sage import *  # noqa: F401,F403
import _sage_ff as FF
import sagebrush._engine as EN
import random as _random  # (after the star import: Sage has its own random)

rnd = _random.Random(20261119)


def lazy(f):
    """Whether f's coefficient objects are still unmade."""
    try:
        object.__getattribute__(f, "_c")
        return False
    except AttributeError:
        return True


def rand(R, n):
    p = R.base_ring().characteristic()
    return R([rnd.randrange(p) for _ in range(n - 1)] + [rnd.randrange(1, p)])


def json_only(fn):
    """fn() with the binary entry point unavailable (the JSON path)."""
    saved = EN.call_bin
    EN.call_bin = lambda r: None
    try:
        return fn()
    finally:
        EN.call_bin = saved


assert EN.call_bin(b"") is not None, "this engine has no binary entry point"
checked = 0
for p in [3, 65537, 4294967291, 9223372036854775783]:
    R = PolynomialRing(GF(p), "x")
    for la, lb in [(17, 16), (300, 120), (1500, 1100)]:
        f, g = rand(R, la), rand(R, lb)
        fg = f * g
        assert lazy(fg) and fg.degree() == la + lb - 2 and lazy(fg), "a lazy product"
        q, r = fg.quo_rem(g)
        assert lazy(q) and lazy(r)
        d = f.gcd(g)
        assert lazy(d)
        # the same as the JSON requests ...
        jp = json_only(lambda: f * g)
        jq, jr = json_only(lambda: fg.quo_rem(g))
        jd = json_only(lambda: f.gcd(g))
        assert not lazy(jp)
        assert (fg, q, r, d) == (jp, jq, jr, jd), (p, la, lb)
        # ... and as arithmetic: q g + r = f g, deg r < deg g, d | f and g
        assert q == f and r == 0 and (fg - q * g) == r
        assert f % d == 0 and g % d == 0 and d.is_monic()
        # a chain stays lazy, and materializes on demand
        h = fg * g
        assert lazy(h) and h.list()[-1] == h.leading_coefficient() and not lazy(h)
        checked += 1
    if p < 2 ** 32:
        x = R.gen()
        for f in [x ** 60 - 1, (x ** 3 + 2 * x + 1) ** 4 * (x ** 5 - x + 1), rand(R, 40)]:
            F = f.factor()
            J = json_only(lambda: f.factor())
            assert list(F) == list(J), (p, f)
            back = F.unit()
            for g, e in F:
                back *= g ** e
            assert back == f, (p, f)
            checked += 1

# error records: the code picks the exception, the text is the engine's
for code, exc in [(6, ValueError), (7, ValueError), (8, RuntimeError)]:
    text = b"a fixed text"
    rec = b"SBW1er" + code.to_bytes(2, "little") + (12).to_bytes(8, "little") + len(text).to_bytes(2, "little") + text
    try:
        FF._sbw1_reply(rec)
        raise AssertionError("no error")
    except exc as e:
        assert str(e) == "a fixed text", e
for bad in [b"", b"SBW2ok\0\0\0\0", b"SBW1xx"]:
    try:
        FF._sbw1_reply(bad)
        raise AssertionError("accepted %r" % bad)
    except RuntimeError:
        pass
print("ok ff_poly_bin: %d cases" % checked)
