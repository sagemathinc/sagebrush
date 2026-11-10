"""The conformance list of the native context and number types (design/mpmath-core.md 4.6 and 6.1): the same rows in
CPython (mpmath 1.3.0, MPMATH_NOGMPY=1: the python backend) and in Sagebrush on either backend, compared line by line.

    MPMATH_NOGMPY=1 python3 conformance.py gen > ref.txt
    SAGEBRUSH_MPMATH_BACKEND=sagebrush node dist/src/cli.js conformance.py gen > got.txt
    python3 conformance.py diff ref.txt got.txt

Pickles both ways:
    python3 conformance.py dump > cpython.pickles; node ... conformance.py load cpython.pickles   (and the reverse)

Each line is a row's name and its result: exact values as canonical text (tuples.canon's form), exceptions as their
type and message.  Rows: the public surface of the context and of mpf/mpc; construction; every arithmetic dunder
against mpf, mpc, int, float, complex and foreign operands; comparisons; hashing against int, float and Fraction;
str/repr; precision and rounding read at each operation; the constants' memo after mixed calls in one session
(python's request); R1 (x._mpf_ is x._mpf_, type(x.man) is int) on the big form, after materialization and after a
pickle round trip; copy-boundary rows (mantissas at 2^53, 2^64, 2^96 +- 1, both signs, aliased operands); and a
lifetime loop of LIFETIME operations at dps 30, reported as its count and a digest, never a time.
"""
import hashlib
import pickle
import sys
from fractions import Fraction

LIFETIME = 2000000


def canon(v):
    if isinstance(v, bool) or v is None:
        return repr(v)
    if isinstance(v, int):
        return "%x" % v if v >= 0 else "-%x" % -v
    if isinstance(v, float):
        return "float(%s)" % v.hex()
    if isinstance(v, complex):
        return "complex(%s,%s)" % (v.real.hex(), v.imag.hex())
    if isinstance(v, tuple):
        return "(" + ",".join(canon(x) for x in v) + ")"
    if isinstance(v, list):
        return "[" + ",".join(canon(x) for x in v) + "]"
    if isinstance(v, str):
        return repr(v)
    if v is NotImplemented:
        return "NotImplemented"
    if hasattr(v, "_mpf_"):
        return type(v).__name__ + canon(v._mpf_)
    if hasattr(v, "_mpc_"):
        return type(v).__name__ + canon(v._mpc_)
    return type(v).__name__ + ":" + repr(v)


TRACE = __import__("os").environ.get("CONF_TRACE")


def row(out, name, f):
    if TRACE:
        print(name, file=sys.stderr, flush=True)
    try:
        r = canon(f())
    except Exception as e:
        r = "%s: %s" % (type(e).__name__, e)
    out.append("%s\t%s" % (name, r))


def values(mp):
    """the operands: inline and big mantissas (both signs, the 2^53/2^64/2^96 edges), specials, an mpc, foreign types"""
    mpf, mpc = mp.mpf, mp.mpc
    xs = {
        "one": mpf(1), "third": mpf(1) / 3, "neg": -mpf(2) / 7, "zero": mpf(0), "tiny": mpf(2) ** -1000,
        "huge": mpf(2) ** 1000 * 3, "inf": mp.inf, "ninf": -mp.inf, "nan": mp.nan,
    }
    for b in (53, 64, 96):
        for d in (-1, 0, 1):
            for s in (1, -1):
                xs["e%d%+d%s" % (b, d, "+" if s > 0 else "-")] = mp.make_mpf(mp.mpf(s * ((1 << b) + d))._mpf_)
    others = {
        "int7": 7, "intbig": 3 ** 100, "negint": -5, "float": 0.1, "complex": 1.5 - 2j, "mpc": mpc(1, -2) / 3,
        "fraction": Fraction(1, 3), "str": "1.5", "none": None,
    }
    return xs, others


DUNDERS = ["__add__", "__radd__", "__sub__", "__rsub__", "__mul__", "__rmul__", "__truediv__", "__rtruediv__",
           "__pow__", "__rpow__", "__mod__", "__rmod__", "__eq__", "__ne__", "__lt__", "__le__", "__gt__", "__ge__"]


def gen():
    import mpmath
    from mpmath import mp
    from mpmath import libmp as _lm

    out = []
    print("# %s mpmath %s backend %s" % (sys.version.split()[0], mpmath.__version__, mpmath.libmp.BACKEND))
    # the public surface (names only: values are compared by the other rows)
    for name, obj in (("mp", mp), ("mpf", mp.mpf), ("mpc", mp.mpc)):
        row(out, "surface %s" % name, lambda o=obj: sorted(n for n in dir(o) if not n.startswith("_") or n in DUNDERS))
    for prec in (53, 113):
        mp.prec = prec
        xs, others = values(mp)
        # construction
        for name, src in (("int", 12345678901234567890123), ("float", 0.1), ("str", "0.1"), ("strexp", "1.25e-300"),
                          ("fraction", Fraction(22, 7)), ("tuple", (0, 3, -1, 2)), ("mpc", 3 + 4j), ("bool", True)):
            row(out, "%d new mpf(%s)" % (prec, name), lambda s=src: mp.mpf(s))
        row(out, "%d new mpc(1,2)" % prec, lambda: mp.mpc(1, 2))
        # attributes and conversions
        for xn, x in xs.items():
            for attr in ("man", "exp", "bc", "real", "imag"):
                row(out, "%d %s.%s" % (prec, xn, attr), lambda x=x, a=attr: getattr(x, a))
            for fname, f in (("int", int), ("float", float), ("complex", complex), ("bool", bool), ("str", str),
                             ("repr", repr), ("abs", abs), ("neg", lambda v: -v), ("pos", lambda v: +v),
                             ("conjugate", lambda v: v.conjugate()), ("hash", hash)):
                row(out, "%d %s %s" % (prec, fname, xn), lambda x=x, f=f: f(x))
        # every dunder against every operand, both rounding directions read from the context
        names = list(xs)
        for rnd in ("n", "f", "u"):
            mp._prec_rounding[1] = rnd
            for an in names[::2]:
                a = xs[an]
                for bn, b in list(xs.items())[::3] + list(others.items()):
                    for d in DUNDERS:
                        row(out, "%d%s %s.%s(%s)" % (prec, rnd, an, d, bn), lambda a=a, d=d, b=b: getattr(a, d)(b))
            mp._prec_rounding[1] = "n"
        # hashing agrees with equal int, float and Fraction values
        for v in (mp.mpf(3), mp.mpf(0.5), mp.mpf(-2) ** 70, mp.mpf(1) / 4):
            row(out, "%d hash-eq %s" % (prec, canon(v)), lambda v=v: [hash(v) == hash(int(v)) if v == int(v) else None,
                                                                     hash(v) == hash(float(v)),
                                                                     hash(v) == hash(Fraction(*v.as_integer_ratio()))
                                                                     if hasattr(v, "as_integer_ratio") else None])
    mp.prec = 53
    # copy boundaries: aliased operands and in-place forms on the big form
    for b in (53, 64, 96):
        for d in (-1, 0, 1):
            x = mp.make_mpf(mp.mpf((1 << b) + d)._mpf_)
            row(out, "alias %d%+d x*x" % (b, d), lambda x=x: x * x)

            def iadd(x=x):
                y = x
                y += y
                return y, x
            row(out, "alias %d%+d x+=x" % (b, d), iadd)
    # the constants' memo, in one session after mixed calls (python's request): mpf_pi/mpf_e/mpf_ln2 at several precisions
    mp.dps = 50
    _ = mp.exp(1) + mp.log(3) + mp.pi * 2
    for p in (53, 113, 300, 1000, 120):
        for cname in ("mpf_pi", "mpf_e", "mpf_ln2"):
            row(out, "memo %s %d" % (cname, p), lambda c=cname, p=p: getattr(_lm, c)(p))
    mp.dps = 15
    # R1: the big form's tuple is made once and kept; its mantissa is a Python int; and after a pickle round trip
    def r1():
        x = mp.mpf(3) ** 50 / 7
        y = pickle.loads(pickle.dumps(x))
        return [x._mpf_ is x._mpf_, type(x.man) is int, y._mpf_ is y._mpf_, type(y.man) is int, y == x]
    row(out, "R1", r1)
    # the lifetime loop: many operations at dps 30, count and digest
    mp.dps = 30
    def lifetime():
        # (the logistic map x <- r x (1 - x): bounded in (0, 1), every result a full-precision big form)
        h, x, r, one, t, n = hashlib.sha256(), mp.pi / 7, mp.mpf(37) / 10, mp.mpf(1), mp.mpf(0), 0
        for i in range(LIFETIME // 4):
            x = r * x * (one - x)
            t = t + x
            n += 4
            if i % 50000 == 0:
                h.update(canon(x).encode())
        h.update(canon(t).encode())
        return [n, h.hexdigest()]
    row(out, "lifetime", lifetime)
    mp.dps = 15
    for line in out:
        print(line)


def pickles():
    from mpmath import mp
    mp.prec = 113
    xs, _ = values(mp)
    vs = list(xs.items()) + [("mpc", mp.mpc(1, -2) / 3)]
    return vs


def dump():
    for name, v in pickles():
        for proto in (2, 4):
            print("%s\t%d\t%s" % (name, proto, pickle.dumps(v, protocol=proto).hex()))


def load(path):
    for line in open(path).read().splitlines():
        name, proto, hx = line.split("\t")
        try:
            r = canon(pickle.loads(bytes.fromhex(hx)))
        except Exception as e:
            r = "%s: %s" % (type(e).__name__, e)
        print("%s\t%s\t%s" % (name, proto, r))


def expected_loads():
    """what a load must give: each pickled value's own canonical text, from this interpreter"""
    for name, v in pickles():
        for proto in (2, 4):
            print("%s\t%d\t%s" % (name, proto, canon(v)))


def diff(a, b, show=20):
    la = [l for l in open(a).read().splitlines() if not l.startswith("#")]
    lb = [l for l in open(b).read().splitlines() if not l.startswith("#")]
    bad = [(x, y) for x, y in zip(la, lb) if x != y]
    for x, y in bad[:show]:
        print("REF", x[:400])
        print("GOT", y[:400])
    print("rows %d / %d, mismatches %d" % (len(la), len(lb), len(bad) + abs(len(la) - len(lb))))
    return 1 if bad or len(la) != len(lb) else 0


if __name__ == "__main__":
    a = sys.argv[1:]
    if a[:1] == ["gen"]:
        gen()
    elif a[:1] == ["dump"]:
        dump()
    elif a[:1] == ["load"]:
        load(a[1])
    elif a[:1] == ["expect"]:
        expected_loads()
    elif a[:1] == ["diff"]:
        sys.exit(diff(a[1], a[2]))
    else:
        print(__doc__)
        sys.exit(2)
