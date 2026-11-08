"""Late module-global attribute-read microbenchmark.

Run with a Sagebrush CLI. There is deliberately no timing gate: compare exact
builds and alternate their order. A regression makes both after rows roughly
twice the before row when the three setattr calls normalize json's module
object from V8 fast properties to dictionary properties.
"""

import json
import sys
import time

N = int(sys.argv[1]) if len(sys.argv) > 1 else 500_000


def read_before(n):
    for _ in range(n):
        json.dumps
        json.loads


# A distinct compiled attribute site, first executed after the mutation.
def read_fresh(n):
    for _ in range(n):
        json.dumps
        json.loads


def best_ns(f):
    samples = []
    for _ in range(9):
        start = time.perf_counter()
        f(N)
        samples.append((time.perf_counter() - start) * 1e9 / N)
    return min(samples)


print("visible module names:", len(vars(json)))
print("before:           %.1f ns/iteration" % best_ns(read_before))
for i in range(3):
    setattr(json, "late_global_" + str(i), i)
print("same site after:  %.1f ns/iteration" % best_ns(read_before))
print("fresh site after: %.1f ns/iteration" % best_ns(read_fresh))
