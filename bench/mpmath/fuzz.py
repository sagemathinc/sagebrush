"""The differential fuzzer of the multiprecision core (design/mpmath-core.md 6.1, point 3).

The same seeded cases run in two interpreters and their lines are compared:

    MPMATH_NOGMPY=1 python3 fuzz.py gen --seed 1 --n 10000 > ref.txt       (CPython, mpmath 1.3.0's python backend)
    SAGEBRUSH_MPMATH_BACKEND=sagebrush node dist/src/cli.js fuzz.py gen --seed 1 --n 10000 > got.txt
    python3 fuzz.py diff ref.txt got.txt

Each line is a case's index, the case, and its result: the canonical text of
its exact value (tuples.canon's form, never printed digits) or its exception's
type and message.  The cases come from a splitmix64 stream, not the random
module, so both interpreters make the same ones.  The first line records the
interpreter, mpmath's version and its backend; diff compares the cases only.
"""
import sys

M64 = (1 << 64) - 1


class Rng:
    """splitmix64: the same stream in every interpreter."""

    def __init__(self, seed):
        self.s = seed & M64

    def u64(self):
        self.s = (self.s + 0x9E3779B97F4A7C15) & M64
        z = self.s
        z = ((z ^ (z >> 30)) * 0xBF58476D1CE4E5B9) & M64
        z = ((z ^ (z >> 27)) * 0x94D049BB133111EB) & M64
        return z ^ (z >> 31)

    def below(self, n):
        return self.u64() % n

    def bits(self, k):
        x = 0
        for _ in range((k + 63) // 64):
            x = (x << 64) | self.u64()
        return x >> (-k % 64)

    def pick(self, xs):
        return xs[self.below(len(xs))]


RNDS = "nfcdu"
# (and perfect squares: the core sizes series by int(prec**0.5), which a pow one ulp low would cut by one)
PRECS = [2, 3, 53, 54, 113, 1000, 64, 100, 144, 256, 1024]
# (the edges: the hybrid number's 2^53, the kernel fast path's 2^64, three limbs' 2^96 and
# 2^128; the multiplication's Karatsuba threshold, 32 limbs, one below and one above)
EDGE_BITS = [53, 64, 96, 128, 31 * 64, 32 * 64, 33 * 64]
# (exponents at the i64 promotion's edges and past 2^53, where the binding sends limbs)
EDGE_EXPS = [2**52 - 1, 2**52, 2**52 + 1, 2**53 - 1, 2**53, 2**53 + 1, 2**63 - 1, 2**63, -(2**63), -(2**63) - 1]


def mantissa(r):
    k = r.below(10)
    if k == 0:
        # (an edge: 2^b - 1, 2^b, 2^b + 1)
        return (1 << r.pick(EDGE_BITS)) + r.below(3) - 1
    if k == 1:
        # (an exact tie at a rounding bit: a 1 followed by zeros below a random cut)
        b = 2 + r.below(200)
        return (r.bits(b) | 1) << (1 + r.below(64))
    if k <= 5:
        return r.bits(1 + r.below(64)) or 1
    if k <= 8:
        return r.bits(1 + r.below(400)) or 1
    return r.bits(1 + r.below(3000)) or 1


def exponent(r, edges=True):
    k = r.below(12)
    if k == 0 and edges:
        return r.pick(EDGE_EXPS)
    if k == 1 and edges:
        return r.bits(r.below(70)) * (1 if r.below(2) else -1)
    return r.below(401) - 200


def mpf_tuple(r, libmp, edges=True):
    """an operand; edges: exponents at the promotion edges too (for the arithmetic only: an elementary
    function of a number near 2^(2^63) would need that many bits of pi or ln 2)"""
    k = r.below(40)
    if k == 0:
        return r.pick([libmp.fzero, libmp.fnzero, libmp.finf, libmp.fninf, libmp.fnan, libmp.fone, libmp.fnone])
    man = mantissa(r) if edges else r.bits(1 + r.below(300)) or 1
    return libmp.from_man_exp(man if r.below(2) else -man, exponent(r, edges) if edges else r.below(81) - 60)


def near(r, libmp, t):
    """t moved by a few ulps: a - b with a close to b (cancellation)."""
    if t[2] is None or not t[1]:
        return t
    s, man, exp, bc = t
    d = r.below(5) - 2
    return libmp.from_man_exp((-1 if s else 1) * man + d, exp)


def prec_of(r, big):
    if r.below(8) == 0:
        return 2 + r.below(big)
    return r.pick(PRECS)


def canon(v):
    if isinstance(v, tuple):
        if len(v) == 4 and all(isinstance(x, int) for x in v):
            return "(%d,%x,%d,%d)" % v
        return "(" + ",".join(canon(x) for x in v) + ")"
    if isinstance(v, bool):
        return repr(v)
    if isinstance(v, int):
        return "%x" % v if v >= 0 else "-%x" % -v
    if hasattr(v, "_mpf_"):
        return "mpf" + canon(v._mpf_)
    if hasattr(v, "_mpc_"):
        return "mpc" + canon(v._mpc_)
    return type(v).__name__ + ":" + repr(v)


def gen(seed, n):
    import mpmath
    from mpmath import libmp
    from mpmath.libmp import libmpf, libelefun, libmpc, libintmath

    r = Rng(seed)
    mp = mpmath.mp
    ops = []

    def binary(name, f, big=10000):
        def run():
            a = mpf_tuple(r, libmp)
            b = near(r, libmp, a) if r.below(6) == 0 else mpf_tuple(r, libmp)
            p, rnd = prec_of(r, big), r.pick(RNDS)
            return "%s %s %s %d %s" % (name, canon(a), canon(b), p, rnd), lambda: f(a, b, p, rnd)
        ops.append(run)

    def unary(name, f, big=2000, edges=False):
        def run():
            a = mpf_tuple(r, libmp, edges)
            p, rnd = prec_of(r, big), r.pick(RNDS)
            return "%s %s %d %s" % (name, canon(a), p, rnd), lambda: f(a, p, rnd)
        ops.append(run)

    binary("mpf_add", libmpf.mpf_add)
    binary("mpf_sub", libmpf.mpf_sub)
    binary("mpf_mul", libmpf.mpf_mul)
    binary("mpf_div", libmpf.mpf_div)
    def power():
        a, b = mpf_tuple(r, libmp, False), mpf_tuple(r, libmp, False)
        if b[2] is not None and b[1] and b[2] + b[3] > 12:
            b = libmp.from_man_exp(b[1] >> max(0, b[3] - 8), r.below(5) - 4)
        p, rnd = prec_of(r, 600), r.pick(RNDS)
        return "mpf_pow %s %s %d %s" % (canon(a), canon(b), p, rnd), lambda: libelefun.mpf_pow(a, b, p, rnd)
    ops.append(power)
    unary("mpf_sqrt", libmpf.mpf_sqrt, 10000, True)
    unary("mpf_exp", libelefun.mpf_exp)
    unary("mpf_log", libelefun.mpf_log)
    unary("mpf_cos", libelefun.mpf_cos)
    unary("mpf_sin", libelefun.mpf_sin)

    def normalize():
        man = mantissa(r)
        e, p, rnd = exponent(r), prec_of(r, 10000), r.pick(RNDS)
        s = r.below(2)
        return "normalize %d %x %d %d %s" % (s, man, e, p, rnd), lambda: libmpf.normalize(s, man, e, man.bit_length(), p, rnd)
    ops.append(normalize)

    def from_man_exp():
        man = mantissa(r) * (1 if r.below(2) else -1)
        e, p, rnd = exponent(r), prec_of(r, 10000), r.pick(RNDS)
        return "from_man_exp %s %d %d %s" % (canon(man), e, p, rnd), lambda: libmpf.from_man_exp(man, e, p, rnd)
    ops.append(from_man_exp)

    for name, f in (("mpc_exp", libmpc.mpc_exp), ("mpc_sqrt", libmpc.mpc_sqrt)):
        def run(name=name, f=f):
            z = (mpf_tuple(r, libmp, False), mpf_tuple(r, libmp, False))
            p, rnd = prec_of(r, 1000), r.pick(RNDS)
            return "%s %s %d %s" % (name, canon(z), p, rnd), lambda: f(z, p, rnd)
        ops.append(run)

    def intmath():
        name = r.pick(["bitcount", "isqrt", "sqrtrem"])
        x = mantissa(r)
        if name != "bitcount" and r.below(2):
            # (a perfect square k^2, or k^2 +- 1: isqrt's float start, int(x**0.5), exact there)
            k = r.bits(1 + r.below(60)) or 1
            x = k * k + r.below(3) - 1 or 1
        return "%s %x" % (name, x), lambda: getattr(libintmath, name)(x)
    ops.append(intmath)

    # the kernel fast path's carry: two mantissas in [2^63, 2^64) at the same exponent, added or subtracted
    def carry():
        e = r.below(201) - 100
        a = libmp.from_man_exp(((1 << 63) | r.bits(63)) * (1 if r.below(2) else -1), e)
        b = libmp.from_man_exp(((1 << 63) | r.bits(63)) * (1 if r.below(2) else -1), e)
        name, f = r.pick([("mpf_add", libmpf.mpf_add), ("mpf_sub", libmpf.mpf_sub)])
        p, rnd = r.pick([0, 53, 64, 65, 128]), r.pick(RNDS)
        return "%s %s %s %d %s" % (name, canon(a), canon(b), p, rnd), lambda: f(a, b, p, rnd)
    ops.append(carry)

    # the kernel fast path's own carry (the typed + and -, both operands inline, below 2^53): a mantissa whose low
    # bits are all ones, shifted 11 to 52 bits past the other, so the low 64-bit word of the aligned sum carries
    def kernel_carry():
        off, e = 11 + r.below(42), r.below(201) - 100
        a = libmp.from_man_exp(((1 << 53) - 1) ^ (r.bits(8) << 45), e + off)
        b = libmp.from_man_exp((1 << 52) | r.bits(52) | 1, e)
        p, rnd, op = r.pick([53, 64, 113, 128]), r.pick(RNDS), r.pick(["+", "-"])

        def run():
            mp._prec_rounding[0], mp._prec_rounding[1] = p, rnd
            try:
                x, y = mp.make_mpf(a), mp.make_mpf(b)
                return x + y if op == "+" else x - (-y)
            finally:
                mp._prec_rounding[0], mp._prec_rounding[1] = 53, "n"
        return "mpf%skernel %s %s %d %s" % (op, canon(a), canon(b), p, rnd), run
    ops.append(kernel_carry)

    def ifac():
        k = r.below(400)
        return "ifac %d" % k, lambda: libintmath.ifac(k)
    ops.append(ifac)

    # the type-level arithmetic the native context takes over: x op y at the context's precision and rounding
    def typed():
        a, b = mpf_tuple(r, libmp), mpf_tuple(r, libmp)
        p, rnd = prec_of(r, 3000), r.pick(RNDS)
        op = r.pick(["+", "-", "*", "/"])

        def run():
            mp._prec_rounding[0], mp._prec_rounding[1] = p, rnd
            x, y = mp.make_mpf(a), mp.make_mpf(b)
            try:
                return {"+": lambda: x + y, "-": lambda: x - y, "*": lambda: x * y, "/": lambda: x / y}[op]()
            finally:
                mp._prec_rounding[0], mp._prec_rounding[1] = 53, "n"
        return "mpf%s %s %s %d %s" % (op, canon(a), canon(b), p, rnd), run
    ops.append(typed)
    ops.append(typed)

    print("# %s mpmath %s backend %s seed %d n %d" % (sys.version.split()[0], mpmath.__version__, libmp.BACKEND, seed, n))
    for i in range(n):
        desc, f = r.pick(ops)()
        try:
            out = canon(f())
        except Exception as e:
            out = "%s: %s" % (type(e).__name__, e)
        print("%d\t%s\t%s" % (i, desc, out))
        if i % 50 == 49:
            sys.stdout.flush()  # (so a run that hangs still shows the cases before it)


def diff(a, b, show=20):
    la = [l for l in open(a).read().splitlines() if not l.startswith("#")]
    lb = [l for l in open(b).read().splitlines() if not l.startswith("#")]
    bad = [(x, y) for x, y in zip(la, lb) if x != y]
    for x, y in bad[:show]:
        print("REF", x[:600])
        print("GOT", y[:600])
    print("cases %d / %d, mismatches %d" % (len(la), len(lb), len(bad) + abs(len(la) - len(lb))))
    return 1 if bad or len(la) != len(lb) else 0


if __name__ == "__main__":
    a = sys.argv[1:]
    if a[:1] == ["gen"]:
        kw = dict(zip(a[1::2], a[2::2]))
        gen(int(kw.get("--seed", "1")), int(kw.get("--n", "10000")))
    elif a[:1] == ["diff"]:
        sys.exit(diff(a[1], a[2]))
    else:
        print(__doc__)
        sys.exit(2)
