# random.getrandbits (src/runtime/modules.ts MT.getrandbits): the same bits as CPython's Mersenne Twister for every k,
# the stream in step after a large call, and CPython's errors for a bad k. Every line is CPython 3.14.10's
# (test/getrandbits_cases.out, python3 -I).
import hashlib
import random

for seed in (0, 1, 109, 2**70 + 3, -5):
    r = random.Random(seed)
    h = hashlib.sha256()
    for k in list(range(0, 130)) + [255, 256, 257, 1000, 4096, 65535, 65536, 65537, 100003, 2**20]:
        h.update(hex(r.getrandbits(k)).encode())
    h.update(repr(r.random()).encode())
    print(seed, h.hexdigest()[:16])
x = random.Random(109).getrandbits(2**20)
print(x.bit_length(), hex(x)[:20], hex(x)[-12:])
r = random.Random(3)
for k in (-1, -2**70, 2.5, "3", 2**64, 2**100, True):
    try:
        print(repr(k), r.getrandbits(k) if k is True else type(r.getrandbits(k)).__name__)
    except Exception as e:
        print(repr(k), type(e).__name__, e)
