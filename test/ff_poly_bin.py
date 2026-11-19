"""GF(p)[x] through the engine's binary entry point (SBW1; engine/web
bin_ops.rs): the same answers as the JSON requests and as the Python
paths, results that keep their words until a coefficient is asked for, the
JSON fallback when the engine predates the entry point, the error records,
and the reply reader's refusal of every truncated or padded reply.  Shared by the CPython package and pyjs.

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

# error records: the code picks the exception, the text is the engine's
for code, exc in [(6, ValueError), (7, ValueError), (8, RuntimeError)]:
    text = b"a fixed text"
    rec = b"SBW1er" + code.to_bytes(2, "little") + (12).to_bytes(8, "little") + len(text).to_bytes(2, "little") + text
    try:
        FF._sbw1_reply(rec)
        raise AssertionError("no error")
    except exc as e:
        assert str(e) == "a fixed text", e


def refused(r):
    try:
        FF._sbw1_reply(r)
    except RuntimeError:
        return True
    except ValueError:
        return False
    return False


for bad in [b"", b"SBW2ok\0\0\0\0", b"SBW1xx"]:
    assert refused(bad), bad
# a real reply (a product's words, and divrem's two results): every
# truncation and any trailing byte is refused, the whole reply parsed
R = PolynomialRing(GF(101), "x")
f, g = rand(R, 40), rand(R, 30)
for op, polys in [("nmod_poly_mul", (f, g)), ("nmod_poly_divrem", (f, g))]:
    o = op.encode()
    parts = [b"SBW1", len(o).to_bytes(4, "little"), o, (3).to_bytes(4, "little"), FF._sbw1_u641(FF._array.array("Q", (101,)))]
    parts.extend(FF._sbw1_u641(FF._words(h)) for h in polys)
    rep = EN.call_bin(b"".join(parts))
    whole = FF._sbw1_reply(rep)
    assert len(whole) == (1 if op == "nmod_poly_mul" else 2)
    for cut in range(len(rep)):
        assert refused(rep[:cut]), (op, cut)
    for junk in (b"\0", b"JUNK"):
        assert refused(rep + junk), (op, junk)
# an ok reply declaring a U641 word with its 8 bytes missing; an empty
# result followed by junk; a declared length past the bytes present
one = b"U641" + (1).to_bytes(8, "little")
assert refused(b"SBW1ok" + (1).to_bytes(4, "little") + (20).to_bytes(4, "little") + one)
assert refused(b"SBW1ok" + (1).to_bytes(4, "little") + (12).to_bytes(4, "little") + one)
empty = b"U641" + (0).to_bytes(8, "little")
assert FF._sbw1_reply(b"SBW1ok" + (1).to_bytes(4, "little") + (12).to_bytes(4, "little") + empty)[0].tolist() == []
assert refused(b"SBW1ok" + (1).to_bytes(4, "little") + (12).to_bytes(4, "little") + empty + b"JUNK")
assert refused(b"SBW1ok" + (9).to_bytes(4, "little"))
# an error record must be exactly its declared text
er = b"SBW1er" + (6).to_bytes(2, "little") + (0).to_bytes(8, "little") + (3).to_bytes(2, "little") + b"abc"
assert not refused(er)
assert refused(er[:-1]) and refused(er + b"x")
print("ok ff_poly_bin: %d cases" % checked)
