"""The drivers' shared protocol (CPython drivers; the Magma, Rust and pyjs
drivers follow the same rules in their own languages).

A driver is invoked as `DRIVER CASE N MODE K` and prints one line.  K is the
number of input variants (seeded inputs of the same shape; variant 0 is the
row's reference input, the old scoreboard's):

- MODE `inputs`: print `INPUTS|hash`, the hash of the K variants' operand
  hashes, so the drivers' separate input generators can be checked against
  each other (test_inputs.py);
- MODE `once`: build variant 0, run the operation once, and print
  `RESULT|seconds|signature` (the correctness pass);
- MODE `time` (or `time-fresh`): print
  `TIME|median|signature|min|max|reps|samples`, seconds per operation.
  Every variant is built and run once first (untimed: the warm-up, and the
  answers the signature covers); the timed repetitions then cycle through
  the variants, never one input repeated.  Repetitions are calibrated until
  one sample takes at least TARGET seconds, then SAMPLES samples are taken
  (3 when a single operation takes over 2 s).  With `time-fresh` every
  repetition gets a freshly built input outside the timed region, for
  operations whose objects cache answers.  The signature is `K:hash`, the
  hash of the K variants' signatures joined by ";" (combined_signature).

Input construction, signature conversion and process startup are never
timed.
"""

from __future__ import annotations

import time

MOD = 1000000007
TARGET = 0.2
SAMPLES = 5
MAX_REPS = 1 << 24


def ihash(xs):
    """The hash of a sequence of integers (the same in every driver)."""
    h = 17
    for x in xs:
        h = (h * 1000003 + int(x) % MOD) % MOD
    return h


def rat_hash(a, b):
    """A rational a/b as a residue modulo MOD."""
    return (int(a) % MOD) * pow(int(b) % MOD, MOD - 2, MOD) % MOD


def combined_signature(sigs):
    """The K variants' signatures as one: K and the hash of their bytes."""
    return "%d:%d" % (len(sigs), ihash(";".join(sigs).encode()))


class Rotation:
    """The timed repetitions' inputs: variant i mod K for the i-th
    repetition, prebuilt (or, fresh, built anew outside the timer)."""

    def __init__(self, prepare, k, fresh):
        self.prepare, self.k, self.fresh, self.i = prepare, k, fresh, 0
        self.ops = None if fresh else [prepare(v) for v in range(k)]

    def run(self, reps):
        total = 0.0
        for _ in range(reps):
            v = self.i % self.k
            self.i += 1
            op = self.prepare(v) if self.fresh else self.ops[v]
            t0 = time.perf_counter()
            op()
            total += time.perf_counter() - t0
        return total


def measure(rot, warm):
    """(median, minimum, maximum, reps, samples) in seconds per operation;
    `warm` is the untimed first pass's total over the K variants."""
    per = warm / rot.k
    k = (
        1
        if per >= TARGET
        else max(1, min(MAX_REPS, int(TARGET * 1.2 / per) + 1 if per > 0 else rot.k))
    )
    elapsed = rot.run(k) if per < TARGET else per
    while elapsed < TARGET and k < MAX_REPS:
        if elapsed <= 0:
            k *= 2
        else:
            k = max(k * 2, min(k * 16, int(k * TARGET * 1.2 / elapsed) + 1))
        elapsed = rot.run(k)
    count = SAMPLES if elapsed / k <= 2.0 else 3
    samples = sorted(rot.run(k) / k for _ in range(count))
    return samples[len(samples) // 2], samples[0], samples[-1], k, count


def main(argv, prepare, signature, operands_hash):
    """Run one driver invocation: argv = [CASE, N, MODE, K]; prepare(v) ->
    operation for variant v (and sets the operands operands_hash() reads);
    signature(answer) -> str."""
    mode = argv[3]
    k = int(argv[4]) if len(argv) > 4 else 1
    if k < 1:
        raise SystemExit("K must be at least 1")
    if mode == "inputs":
        hs = []
        for v in range(k):
            prepare(v)
            hs.append(operands_hash())
        print("INPUTS|%d" % ihash(hs))
        return
    if mode == "once":
        op = prepare(0)
        t0 = time.perf_counter()
        answer = op()
        seconds = time.perf_counter() - t0
        print("RESULT|%.9f|%s" % (seconds, signature(answer)))
        return
    if mode not in ("time", "time-fresh"):
        raise SystemExit("unknown mode " + mode)
    rot = Rotation(prepare, k, mode == "time-fresh")
    sigs, warm = [], 0.0
    for v in range(k):
        op = prepare(v) if rot.fresh else rot.ops[v]
        t0 = time.perf_counter()
        answer = op()
        warm += time.perf_counter() - t0
        sigs.append(signature(answer))
    med, lo, hi, reps, count = measure(rot, warm)
    print(
        "TIME|%.9g|%s|%.9g|%.9g|%d|%d"
        % (med, combined_signature(sigs), lo, hi, reps, count)
    )
