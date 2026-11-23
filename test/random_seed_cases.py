# random.Random's seeds (lib/random.py _seed_value, src/runtime/modules.ts MT.seed) and randbytes, as CPython's:
# a str, bytes or bytearray seeds by int.from_bytes(a + sha512(a)) (version 2) or by the older string hash (version
# 1); a float by its exact hash, cast to unsigned; other types refused. Every line is CPython 3.14.10's
# (test/random_seed_cases.out, python3 -I).
import random


def t(label, f):
    try:
        print(label, repr(f()))
    except Exception as e:
        print(label, type(e).__name__ + ":", str(e).replace("\n", " "))


def stream(seed, *args):
    r = random.Random()
    r.seed(seed, *args)
    return [r.getrandbits(32) for _ in range(3)] + [r.random()]


for s in ("text", "", "é", "a" * 1000, b"text", b"", b"\x00\xff", bytearray(b"text"), bytearray()):
    t("v2 " + repr(s)[:24], lambda: stream(s))
    t("init " + repr(s)[:24], lambda: random.Random(s).random())
for s in ("text", "", "é", b"text", b"\xff"):
    t("v1 " + repr(s), lambda: stream(s, 1))
t("v1 bytearray (v2's rule)", lambda: stream(bytearray(b"text"), 1))
for s in (0, 1, -1, 2**64 + 5, -(2**100), True, 1.5, -1.5, 0.1, -0.0, 1e300, float("inf")):  # (a NaN hashes by identity since 3.10: no fixed stream)
    t("num " + repr(s), lambda: stream(s))
for s in ((1, 2), [1], {1: 2}, 1j, object):
    t("refused " + type(s).__name__, lambda: random.Random(s))
t("refused by seed", lambda: random.Random().seed((1,)))
random.seed("module")
t("module seed str", lambda: [random.random(), random.getrandbits(8)])
random.seed("module", version=1)
t("module seed v1", lambda: random.random())


class Sub(random.Random):
    def seed(self, a=None, version=2):
        super().seed(42)


t("subclass seed runs from __init__", lambda: Sub("ignored").random())
for n in (0, 1, 2, 9, 17, 100):
    r = random.Random(9)
    t(f"randbytes({n})", lambda: (r.randbytes(n).hex(), r.getrandbits(32)))
t("randbytes(1.0)", lambda: random.Random(1).randbytes(1.0))
random.seed(3)
t("module randbytes", lambda: random.randbytes(5).hex())
