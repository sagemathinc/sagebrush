# Test vectors for src/runtime/fma.ts (test/fma.test.ts): math.fma, correctly rounded (CPython 3.13 and later),
# for fma, and an exact Fraction rounded to float32 for fmaf. Random operands over wide exponent ranges, heavy
# cancellation, exact halfway constructions, subnormal and overflowing results, complex-multiply shapes, and
# special values. One line per case: "kind x y z expected", each value as float.hex() (kind d, s: fma; f: fmaf).
import math, random, struct, sys
from fractions import Fraction

rnd = random.Random(int(sys.argv[2]) if len(sys.argv) > 2 else 1)
N = int(sys.argv[1]) if len(sys.argv) > 1 else 200000

def f32(v):
    try:
        return struct.unpack("<f", struct.pack("<f", v))[0]
    except OverflowError:
        # (struct refuses values past FLT_MAX; those within half an ulp round to it, the rest to inf)
        return math.copysign(3.4028234663852886e38 if abs(v) < 2.0 ** 128 - 2.0 ** 103 else math.inf, v)

def h(v):
    return v.hex() if math.isfinite(v) else repr(v)

def round_f32(fr):
    # the float32 nearest to the Fraction fr, ties to even, with overflow to inf
    if fr == 0:
        return 0.0
    c = f32(float(fr)) if abs(float(fr)) < 3.5e38 else math.copysign(math.inf, fr)
    if math.isinf(c):
        return c
    best = None
    bits = struct.unpack("<I", struct.pack("<f", c))[0]
    cands = []
    for d in (-2, -1, 0, 1, 2):
        b = bits + d
        if 0 <= b < 0xFFFFFFFF:
            v = struct.unpack("<f", struct.pack("<I", b & 0xFFFFFFFF))[0]
            if math.isfinite(v):
                cands.append((abs(Fraction(v) - fr), (b & 1), v))
    cands.sort(key=lambda t: (t[0], t[1]))
    v = cands[0][2]
    if abs(fr) >= Fraction(2) ** 128 - Fraction(2) ** 103:  # past the overflow threshold
        return math.copysign(math.inf, fr)
    return v

def rdouble(lo, hi):
    return math.ldexp(rnd.uniform(1, 2), rnd.randint(lo, hi)) * rnd.choice((1, -1))

out = []
def fma_ref(x, y, z):
    try:
        return math.fma(x, y, z)
    except OverflowError:
        return math.inf if Fraction(x) * Fraction(y) + Fraction(z) > 0 else -math.inf
    except ValueError:
        return math.nan

def emit_d(x, y, z, kind="d"):
    out.append("%s %s %s %s %s" % (kind, h(x), h(y), h(z), h(fma_ref(x, y, z))))

def emit_f(x, y, z):
    x, y, z = f32(x), f32(y), f32(z)
    if not all(math.isfinite(v) for v in (x, y, z)):
        return
    r = Fraction(x) * Fraction(y) + Fraction(z)
    e = round_f32(r)
    if e == 0 and r == 0:
        e = x * y + z  # (the sign of an exact zero, as C)
    out.append("f %s %s %s %s" % (h(x), h(y), h(z), h(e)))

for i in range(N):
    k = i % 10
    if k == 0:  # random, moderate exponents
        emit_d(rdouble(-60, 60), rdouble(-60, 60), rdouble(-120, 120))
    elif k == 1:  # cancellation: z near -x*y
        x, y = rdouble(-30, 30), rdouble(-30, 30)
        z = -(x * y) * (1 + rnd.choice((0, 2 ** -52, -(2 ** -52), 2 ** -30)))
        emit_d(x, y, z)
    elif k == 2:  # exact halfway constructions: short x, y; z = -(x*y) rounded + half an ulp pattern
        x = rnd.randint(1, 2 ** 27) * 2.0 ** rnd.randint(-40, 0)
        y = rnd.randint(1, 2 ** 27) * 2.0 ** rnd.randint(-40, 0)
        p = x * y
        u = math.ulp(p)
        z = rnd.choice((u / 2, -u / 2, u, 3 * u / 2, u / 4)) * rnd.choice((1, -1)) + rnd.choice((0.0, -p, p))
        emit_d(x, y, z)
    elif k == 3:  # extreme exponents and subnormal results
        emit_d(rdouble(-560, -500), rdouble(-560, -500), rdouble(-1074, -1000))
    elif k == 4:  # huge / overflow
        emit_d(rdouble(500, 520), rdouble(490, 512), rdouble(1000, 1023))
    elif k == 5:  # mixed wide
        emit_d(rdouble(-1000, 1000), rdouble(-20, 20), rdouble(-1000, 1000))
    elif k == 6:  # complex-multiply shapes: fma(ar, br, -(ai*bi))
        ar, br, ai, bi = (rdouble(-10, 10) for _ in range(4))
        emit_d(ar, br, -(ai * bi))
    elif k == 7:  # float32 random
        emit_f(rdouble(-20, 20), rdouble(-20, 20), rdouble(-40, 40))
    elif k == 8:  # float32 cancellation and complex64 shapes
        x, y = f32(rdouble(-10, 10)), f32(rdouble(-10, 10))
        emit_f(x, y, f32(-(x * y) * (1 + rnd.choice((0, 2 ** -23, -(2 ** -23), 2 ** -12)))))
        ai, bi = f32(rdouble(-10, 10)), f32(rdouble(-10, 10))
        emit_f(x, y, -f32(ai * bi))
    else:  # float32 tiny / huge ranges
        emit_f(rdouble(-75, -60), rdouble(-75, -60), rdouble(-149, -120))
        emit_f(rdouble(60, 64), rdouble(60, 64), rdouble(100, 127))
# near-ties: the double (or, for fmaf, float32) sum lands exactly on a halfway point while the exact value is a
# hair off it, so a second rounding goes the wrong way unless corrected. x*y = h * (1 + 2**-m) * (1 - 2**-m) =
# h * (1 - 2**-2m), with h (half) half a unit in the last place of z, z's last bit odd or even, either sign and side,
# and z a power of two (where the gap below is half the gap above)
for i in range(max(1, N // 20)):
    k = rnd.randint(-200, 200)
    sgn, side = rnd.choice((1, -1)), rnd.choice((1, -1))
    mant = rnd.randint(0, 2 ** 52 - 1) | rnd.choice((0, 1))
    z = math.ldexp(1 + mant * 2.0 ** -52, k) * sgn
    if rnd.random() < 0.25:
        z = math.ldexp(1.0, k) * sgn
    below = side < 0 and z == math.ldexp(1.0, k) * sgn
    half = math.ldexp(1.0, k - (54 if below else 53))
    emit_d(half * (1 + 2.0 ** -52) * side * sgn, 1 - 2.0 ** -52, z)
    emit_d(half * (1 - 2.0 ** -52) * side * sgn, 1 + 2.0 ** -52, z)
    emit_d(half * side * sgn, 1.0, z)
    mf = rnd.randint(0, 2 ** 23 - 1) | rnd.choice((0, 1))
    kf = rnd.randint(-60, 60)
    zf = math.ldexp(1 + mf * 2.0 ** -23, kf) * sgn
    if rnd.random() < 0.25:
        zf = math.ldexp(1.0, kf) * sgn
    belowf = side < 0 and zf == math.ldexp(1.0, kf) * sgn
    hf = math.ldexp(1.0, kf - (25 if belowf else 24))
    emit_f(hf * (1 + 2.0 ** -23) * side * sgn, 1 - 2.0 ** -23, zf)
    emit_f(hf * (1 - 2.0 ** -23) * side * sgn, 1 + 2.0 ** -23, zf)
    # (the same in float32's subnormal range: z an odd or even multiple of 2**-149, x*y = 2**-150 * (1 - 2**-46))
    zs = rnd.randint(1, 2 ** 23 - 1) * 2.0 ** -149 * sgn
    emit_f(2.0 ** -75 * (1 + 2.0 ** -23) * side * sgn, 2.0 ** -75 * (1 - 2.0 ** -23), zs)
    emit_f(2.0 ** -75 * (1 - 2.0 ** -23) * side * sgn, 2.0 ** -75 * (1 + 2.0 ** -23), zs)
# special values
for x, y, z in [(0.0, 1.0, -0.0), (-0.0, 1.0, 0.0), (-0.0, 1.0, -0.0), (math.inf, 0.0, 1.0), (math.inf, 1.0, -math.inf), (math.nan, 1.0, 1.0),
                (1.0, 1.0, math.inf), (2.0 ** -1074, 0.5, 0.0), (2.0 ** -1074, 2.0 ** -1, 2.0 ** -1074), (1.7976931348623157e308, 2.0, -1.7976931348623157e308),
                (1 + 2 ** -52, 1 - 2 ** -52, -1.0), (2.0 ** -537, 2.0 ** -537, 2.0 ** -1074)]:
    emit_d(x, y, z, "s")
print("\n".join(out))
