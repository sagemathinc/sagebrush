# format_float_positional and format_float_scientific on random doubles
# (any exponent, subnormals too, and ties), by precision, unique, trim,
# min_digits and fractional; and arrays of them by floatmode.
import random
import struct
import numpy as np

rng = random.Random(4)


def rand_double():
    k = rng.random()
    if k < 0.1:
        # a tie at some precision: a multiple of a power of 2 near 1
        return rng.randrange(1, 4096) / 2 ** rng.randrange(1, 14) * rng.choice([1, -1])
    if k < 0.2:
        return float(rng.randrange(-10 ** 6, 10 ** 6)) / 10 ** rng.randrange(0, 8)
    bits = rng.getrandbits(64)
    x = struct.unpack("<d", struct.pack("<Q", bits))[0]
    return x if x == x and abs(x) != float("inf") else 1.5


f, s = np.format_float_positional, np.format_float_scientific
out = []
for i in range(1500):
    x = rand_double()
    p = rng.choice([None, 0, 1, 2, 3, 5, 8, 12, 17, 25])
    unique = p is None or rng.random() < 0.6
    trim = rng.choice("k.0-")
    md = rng.choice([None, 0, 1, 3]) if p is None or rng.random() < 0.5 else None
    if md is not None and p is not None and md > p:
        md = p
    sign = rng.random() < 0.3
    pl, pr = rng.choice([None, None, 2, 6]), rng.choice([None, None, 0, 3, 8])
    try:
        a = f(x, precision=p, unique=unique, trim=trim, min_digits=md, fractional=rng.random() < 0.8, sign=sign,
              pad_left=pl, pad_right=pr) if abs(x) < 1e30 else "skip"
    except ValueError as e:
        a = "ValueError"
    b = s(x, precision=p, unique=unique, trim=trim, min_digits=md, exp_digits=rng.choice([None, 1, 3, 7]), sign=sign, pad_left=pl)
    out.append("%r %r %r %s %r: %s | %s" % (x, p, unique, trim, md, a, b))
print("\n".join(out))
for mode in ["fixed", "unique", "maxprec", "maxprec_equal"]:
    for prec in [0, 3, 8]:
        np.set_printoptions(floatmode=mode, precision=prec)
        for i in range(20):
            n = rng.randrange(1, 6)
            print(mode, prec, np.array([rand_double() * 10 ** rng.randrange(-12, 12) for _ in range(n)]))
np.set_printoptions(floatmode="maxprec", precision=8)
