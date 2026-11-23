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
  Before the TIME line comes `TIMING|json` (protocol 5), the samples a
  sweep pairs across candidates:
  - the timer's granularity g, measured, and the per-op threshold
    max(1 ms, 1000 g);
  - per-op mode, when one operation (from the untimed first pass) takes at
    least the threshold: R full rotations, each operation timed alone, in
    rotation order from a seeded offset, so samples[v] holds variant v's R
    times, never back to back;
  - batched mode, below it: the rotation batches above, batch j starting at
    the seeded offset o_j (the same for every candidate's batch j), with
    each batch's seconds per operation.
  The seed is BENCH_SEED (0 when unset).  BENCH_TIMING=per-op|batched
  forces a mode (tests).
  With BENCH_VTIME=1 (the calibrated targets only), the record also has
  `vtime`: each variant timed on its own, {v, seconds, min, max, reps,
  samples} per variant (protocol 5's per-variant pass).  A variant whose
  single operation takes at least TARGET reuses its per-op samples;
  otherwise its repetitions are calibrated to at least TARGET seconds and
  VSAMPLES samples are taken, seconds per operation, the median kept.

Input construction, signature conversion and process startup are never
timed.
"""

from __future__ import annotations

import time

MOD = 1000000007
TARGET = 0.2
SAMPLES = 5
VSAMPLES = 3
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


def calibrate(rot, warm):
    """The repetitions per sample: until one sample takes at least TARGET
    seconds; `warm` is the untimed first pass's total over the K variants."""
    per = warm / rot.k
    if per >= TARGET:
        return 1, per
    k = max(1, min(MAX_REPS, int(TARGET * 1.2 / per) + 1 if per > 0 else rot.k))
    elapsed = rot.run(k)
    while elapsed < TARGET and k < MAX_REPS:
        if elapsed <= 0:
            k *= 2
        else:
            k = max(k * 2, min(k * 16, int(k * TARGET * 1.2 / elapsed) + 1))
        elapsed = rot.run(k)
    return k, elapsed


PER_OP_FLOOR = 1e-3
TIMING_LIMIT = 1 << 16  # (the TIMING line's JSON, bytes: run.py's bound too)


def granularity(tries=2000):
    """The smallest positive step perf_counter() shows (seconds)."""
    best, last = None, time.perf_counter()
    for _ in range(tries):
        now = time.perf_counter()
        d = now - last
        if d > 0 and (best is None or d < best):
            best = d
        last = now
    return best or 1e-9


def offset(seed, j, k):
    """Batch or rotation j's starting variant (the same for every candidate
    of a sweep: a function of the seed, j and K only)."""
    return (seed * 1000003 + j * 7919) % k


def per_op(prepare, k, fresh, ops, rotations, seed):
    """samples[v]: variant v's times, each operation timed alone, rotation r
    starting at offset(seed, r, k)."""
    samples = [[] for _ in range(k)]
    for r in range(rotations):
        start = offset(seed, r, k)
        for i in range(k):
            v = (start + i) % k
            op = prepare(v) if fresh else ops[v]
            t0 = time.perf_counter()
            op()
            samples[v].append(time.perf_counter() - t0)
    return samples


class One(Rotation):
    """One variant's repetitions alone (the per-variant pass)."""

    def __init__(self, prepare, v, fresh, op):
        self.prepare, self.k, self.fresh, self.i = prepare, 1, fresh, 0
        self.v = v
        self.ops = None if fresh else [op]

    def run(self, reps):
        total = 0.0
        for _ in range(reps):
            op = self.prepare(self.v) if self.fresh else self.ops[0]
            t0 = time.perf_counter()
            op()
            total += time.perf_counter() - t0
        return total


def vtimes(prepare, k, fresh, ops, per_op_samples):
    """Each variant timed on its own: [{v, seconds, min, max, reps,
    samples}] (see the module docstring)."""
    out = []
    for v in range(k):
        s = per_op_samples[v] if per_op_samples else None
        if s and min(s) >= TARGET:
            xs, reps = sorted(s), 1
        else:
            one = One(prepare, v, fresh, None if fresh else ops[v])
            t0 = time.perf_counter()
            (prepare(v) if fresh else ops[v])()
            warm = time.perf_counter() - t0
            reps, _ = calibrate(one, warm)
            xs = sorted(one.run(reps) / reps for _ in range(VSAMPLES))
        out.append(
            {
                "v": v,
                "seconds": xs[len(xs) // 2],
                "min": xs[0],
                "max": xs[-1],
                "reps": reps,
                "samples": len(xs),
            }
        )
    return out


def timing_line(record):
    import json

    text = json.dumps(record, separators=(",", ":"), sort_keys=True)
    if len(text) > TIMING_LIMIT:
        raise SystemExit("TIMING record over its bound")
    return "TIMING|" + text


def measure_batched(rot, warm, seed):
    """calibrate, then each batch j started at offset(seed, j): (median, min,
    max, reps, count, the batches' seconds per operation, their offsets)."""
    k, elapsed = calibrate(rot, warm)
    count = SAMPLES if elapsed / k <= 2.0 else 3
    batches, offsets = [], []
    for j in range(count):
        rot.i = offset(seed, j, rot.k)
        offsets.append(rot.i)
        batches.append(rot.run(k) / k)
    s = sorted(batches)
    return s[len(s) // 2], s[0], s[-1], k, count, batches, offsets


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
    import os

    rot = Rotation(prepare, k, mode == "time-fresh")
    sigs, warm = [], 0.0
    for v in range(k):
        op = prepare(v) if rot.fresh else rot.ops[v]
        t0 = time.perf_counter()
        answer = op()
        warm += time.perf_counter() - t0
        sigs.append(signature(answer))
    seed = int(os.environ.get("BENCH_SEED", "0"))
    g = granularity()
    threshold = max(PER_OP_FLOOR, 1000 * g)
    forced = os.environ.get("BENCH_TIMING", "auto")
    record = {"granularity": g, "threshold": threshold, "seed": seed, "k": k}
    if forced == "per-op" or (forced == "auto" and warm / k >= threshold):
        rotations = SAMPLES if warm / k <= 2.0 else 3
        samples = per_op(prepare, k, rot.fresh, rot.ops, rotations, seed)
        means = sorted(sum(s[r] for s in samples) / k for r in range(rotations))
        med, lo, hi, reps, count = (
            means[len(means) // 2],
            means[0],
            means[-1],
            k,
            rotations,
        )
        record.update(mode="per-op", samples=samples)
    else:
        samples = None
        med, lo, hi, reps, count, batches, offsets = measure_batched(rot, warm, seed)
        record.update(mode="batched", reps=reps, batches=batches, offsets=offsets)
    if os.environ.get("BENCH_VTIME") == "1":
        record["vtime"] = vtimes(prepare, k, rot.fresh, rot.ops, samples)
    print(timing_line(record))
    print(
        "TIME|%.9g|%s|%.9g|%.9g|%d|%d"
        % (med, combined_signature(sigs), lo, hi, reps, count)
    )
