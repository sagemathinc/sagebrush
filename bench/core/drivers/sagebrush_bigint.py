"""User-facing Sagebrush CLI bigint cases (runs under build/cli/pyjs.cjs, the
WebAssembly engine).  The protocol is common.py's, repeated here because
the CLI runs this file alone: `CASE BITS MODE K`, variant v adding v 1000003
and v 998244353 to the two operands."""

import math
import sys
import time

case_id, bits, mode = sys.argv[1], int(sys.argv[2]), sys.argv[3]
K = int(sys.argv[4]) if len(sys.argv) > 4 else 1
MOD = 1000000007
TARGET = 0.2


def ihash(xs):
    h = 17
    for x in xs:
        h = (h * 1000003 + int(x) % MOD) % MOD
    return h


def operands(v):
    a = (1 << bits) - (1 << (bits // 3)) + 123456789 + v * 1000003
    b = (1 << (bits - 1)) + (1 << (bits // 2)) + 987654321 + v * 998244353
    return a, b


def make(v):
    a, b = operands(v)
    if case_id == "bigint_mul":
        return lambda: a * b
    if case_id == "bigint_gcd":
        return lambda: math.gcd(a * 1000003, b * 1000003)
    raise ValueError(case_id)


def signature(answer):
    return "%d:%d" % (answer.bit_length(), answer % MOD)


OPS = [make(v) for v in range(K)]
STATE = [0]


def granularity(tries=2000):
    best, last = None, time.perf_counter()
    for _ in range(tries):
        now = time.perf_counter()
        d = now - last
        if d > 0 and (best is None or d < best):
            best = d
        last = now
    return best or 1e-9


def offset(seed, j, k):
    """common.py's offset (the same schedule)."""
    if k == 1:
        return 0
    return ((seed * 1000003) % (k - 1) + j * (1 if k > 2 else 0)) % k


def whole(reps, k):
    """common.py's whole."""
    return -(-reps // k) * k


def floats(xs):
    return ",".join(repr(float(x)) for x in xs)


def run(k):
    total = 0.0
    for _ in range(k):
        op = OPS[STATE[0] % K]
        STATE[0] += 1
        t0 = time.perf_counter()
        op()
        total += time.perf_counter() - t0
    return total


if mode == "inputs":
    print("INPUTS|%d" % ihash(ihash(operands(v)) for v in range(K)))
elif mode == "once":
    t0 = time.perf_counter()
    answer = OPS[0]()
    print("RESULT|%.9f|%s" % (time.perf_counter() - t0, signature(answer)))
elif mode in ("time", "time-fresh"):
    sigs, warm = [], 0.0
    for v in range(K):
        t0 = time.perf_counter()
        answer = OPS[v]()
        warm += time.perf_counter() - t0
        sigs.append(signature(answer))
    # (protocol 5, as common.py: per-op at or above max(1 ms, 1000 g), else
    # batched from seeded offsets; a TIMING record before the TIME line)
    import os

    per = warm / K
    seed = int(os.environ.get("BENCH_SEED", "0"))
    forced = os.environ.get("BENCH_TIMING", "auto")
    g = granularity()
    threshold = max(1e-3, 1000 * g)
    head = '"granularity":%r,"threshold":%r,"seed":%d,"k":%d' % (g, threshold, seed, K)
    if forced == "per-op" or (forced == "auto" and per >= threshold):
        count = 5 if per <= 2.0 else 3
        per_variant = [[] for _ in range(K)]
        for r in range(count):
            start = offset(seed, r, K)
            for i in range(K):
                v = (start + i) % K
                t0 = time.perf_counter()
                OPS[v]()
                per_variant[v].append(time.perf_counter() - t0)
        samples = sorted(sum(s[r] for s in per_variant) / K for r in range(count))
        k = K
        rows = ",".join("[%s]" % floats(s) for s in per_variant)
        print('TIMING|{%s,"mode":"per-op","samples":[%s]}' % (head, rows))
    else:
        # (whole rotations, as common.py's calibrate)
        if per >= TARGET:
            k, t = K, warm
        else:
            k = whole(max(1, int(TARGET * 1.2 / per) + 1) if per > 0 else K, K)
            t = run(k)
        while t < TARGET and k < 1 << 24:
            k = whole(
                k * 2
                if t <= 0
                else max(k * 2, min(k * 16, int(k * TARGET * 1.2 / t) + 1)),
                K,
            )
            t = run(k)
        count = 5 if t / k <= 2.0 else 3
        batches, offsets = [], []
        for j in range(count):
            STATE[0] = offset(seed, j, K)
            offsets.append(STATE[0])
            batches.append(run(k) / k)
        samples = sorted(batches)
        print(
            'TIMING|{%s,"mode":"batched","reps":%d,"batches":[%s],"offsets":[%s]}'
            % (head, k, floats(batches), ",".join(str(o) for o in offsets))
        )
    sig = "%d:%d" % (K, ihash(";".join(sigs).encode()))
    print(
        "TIME|%.9g|%s|%.9g|%.9g|%d|%d"
        % (samples[len(samples) // 2], sig, samples[0], samples[-1], k, count)
    )
else:
    raise SystemExit("unknown mode " + mode)
