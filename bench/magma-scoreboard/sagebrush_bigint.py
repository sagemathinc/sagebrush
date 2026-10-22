"""User-facing Sagebrush CLI bigint cases (runs under build/cli/pyjs.cjs)."""

import math
import sys
import time

case_id, bits, repeats = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
MOD = 1000000007
a = (1 << bits) - (1 << (bits // 3)) + 123456789
b = (1 << (bits - 1)) + (1 << (bits // 2)) + 987654321

t0 = time.perf_counter()
for _ in range(repeats):
    if case_id == "bigint_mul":
        answer = a * b
    elif case_id == "bigint_gcd":
        answer = math.gcd(a * 1000003, b * 1000003)
    else:
        raise ValueError(case_id)
seconds = (time.perf_counter() - t0) / repeats
signature = "%d:%d" % (answer.bit_length(), answer % MOD)
print("RESULT|%.9f|%s" % (seconds, signature))
