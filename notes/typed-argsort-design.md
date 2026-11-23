# Typed-buffer numeric argsort fallback

## Contract and scope

When the optional wasm sorting kernel cannot grow its linear memory, numeric
argsort must still return an int64 index array using the host's available
memory. Preserve the existing stable ordering, NaNs last, signed zeros equal,
axis shapes, offsets, and negative/zero strides. Complex ordering stays as it
is today. No element or browser-byte cap changes belong to this work.

Done means: a forced wasm-grow failure computes correctly; JavaScript fallback
never constructs a boxed index array or invokes a typed-array comparator sort;
independent permutation/order/stability certificates and NumPy agree; memory
admission and interrupt controls pass; exact-head review clears the change.

## Sources and order of work

1. Freeze a seeded corpus and an independent checker before changing the route.
   Use NumPy's public stable argsort as a black-box oracle, never its source.
2. Implement iterative bottom-up merging of typed index buffers, with arithmetic
   endpoints (no signed 32-bit shifts) and interrupt polling. Keep the existing
   packed-integer/native and wasm fast paths where safe.
3. Switch numeric real/complex fallback indices, and catch only recognized wasm
   growth failures. Preserve all other errors as terminal.
4. Run corpus, forced-routing, negative certificates, mutation, memory and timing
   controls; send an evidence packet for exact-head review.

References read: [NumPy argsort documentation](https://numpy.org/doc/stable/reference/generated/numpy.argsort.html),
[V8 stable-sort documentation](https://v8.dev/features/stable-sort), and
[V8 typed-array sort implementation](https://chromium.googlesource.com/v8/v8.git/+/refs/tags/14.2.199/src/builtins/typed-array-sort.tq).
The last shows comparator sorting still needs boxed work arrays: changing the
receiver to Uint32Array and calling `.sort(compare)` is not sufficient. No
NumPy/Sage/FLINT implementation source was read.

## Memory ledger and risks

The current numeric preflight allows, per element, two input-width copies,
the result width, and 40 bytes of sort work. A 1-D failed wasm attempt already
owns contiguous values (8 bytes) and int64 output (8); reuse those for the
fallback. Its merge scratch needs 4 bytes per index while the existing element
cap is inclusive 2^32 (largest index 2^32-1). General rows need values (8, or 16
for complex), indices and merge scratch (4 each), plus the existing output and
axis-restoration copies. Allocate only after preflight. Document actual measured
typed-buffer totals, including the failed route, before handoff.

Main risks: signed-zero tie drift, NaN stability, odd merge tails, empty axes,
wide index arithmetic, a hidden boxed comparator sort, accidentally swallowing
interrupt/internal failures, and native engine scratch surviving a failed grow.
Large physical allocations are not needed for correctness: inject small grow
limits and allocation spies; label the largest real run actually performed.

## Measurements

Benchmark five families at five sizes spanning more than two decades, min of
three, with input/output hashes and independent certificates. Compare NumPy
stable argsort and the existing boxed JavaScript fallback; report versions and
shared-host caveats. There is no promised speed ratio: the goal is removal of
the boxed-index size limit without changing results or imposing a new cap.

## As built

The new merge routine is shared by numeric real and complex sorting. It uses
one Uint32 scratch buffer per row, with a Uint32 index buffer for general rows
and the existing int64 output itself for a 1-D argsort. Failed wasm attempts
retain and reuse their host value/output buffers. Existing packed-integer and
wasm fast paths are unchanged; string sorting is not changed.

The forced-grow allocation spy measures exactly 20*n host bytes for a contiguous
1-D float64 input: 8*n values + 8*n output + 4*n merge scratch. The existing
64*n preflight admits at the boundary and refuses one byte below it before any
allocation or wasm grow. A copied noncontiguous input can add 8*n. An unsuccessful
packed-integer attempt can transiently add another 8*n. General real rows use
8*r values + 4*r indices + 4*r scratch, plus the full output and possible axis
restoration copy. Complex rows use 16*r values + 4*r indices + 4*r scratch plus
the corresponding full outputs. All remain below the unchanged operation-wide
preflight. The optional wasm memory is pre-existing; a rejected grow leaves it
unchanged. Real allocation failure and non-growth errors are never retried.

Validation: 25 frozen benchmark cases agree with NumPy stable argsort and pass
independent permutation/order/stability certificates; broken certificates are
rejected. Odd merge tails, 0/1 lengths, views, zero/negative strides, axes,
wide integer values, booleans and complex NaNs pass. Forced JS routing rejects
boxed/native comparator sorts. A grow refusal reaches fallback; a different
error propagates. An injected third interrupt poll stops during merging, not
just initialization, without modifying the input. Three compiled mutants
(merge direction, missing final copy, swallowed unrelated error) fail tests;
restored tests pass. Existing wasm/JS bit-parity, scratch-admission tests and
the real 20-million-element forced-grow test pass. No multi-GiB array run or
quiet-machine performance claim is made. See the baseline/results tables.
