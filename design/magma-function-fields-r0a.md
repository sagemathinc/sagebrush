# Magma rational function fields: R0a

R0a is the bounded first slice of the approved function-fields roadmap.  It
adds one-variable rational function fields over `Q`, `Z` (arithmetic in
`Q(x)` with integer-presentation metadata), and admitted prime fields
`GF(p)`.  Algebraic function fields, extension constant fields and
multivariate rational fields remain later reviewed stages.

## Public contract

- `FunctionField(k)`, `RationalFunctionField(k)`, and
  `FieldOfFractions(k[t])` share one canonical parent for a mathematical
  base.  Renaming any alias renames every field generator, but never the
  source polynomial ring.
- The Magma types are `FldFunRat` and `FldFunRatUElt`.  Coercion, arithmetic,
  comparison, numerator/denominator, degree, evaluation and differentiation
  use normalized fractions.
- A `Z[u]` presentation retains `BaseRing`/`CoefficientRing = Integer Ring`,
  returns the source `Z[u]` from `IntegerRing`, and refuses `BaseField`, even
  though its arithmetic backend is `Q(u)`.
- `SquarefreePartialFractionDecomposition` and
  `PartialFractionDecomposition` reproduce the Chapter 39 Magma examples,
  including denominator clearing back into `Z[x]`.

## Admission table

Every public arithmetic operation owns one non-resetting work/live ledger.
All degree, bit and output envelopes are checked before the corresponding
normalization, gcd, factorization or result allocation.

| quantity | cap |
|---|---:|
| aggregate scalar work | `2^26` |
| aggregate live size-dependent memory | 16 MiB |
| input fractions / dense coefficients | 1024 / 32768 |
| Q input/result x-degree | 512 / 1024 |
| GF(p) input/result x-degree | 2048 / 4096 |
| one Q coefficient / total Q input bits | `2^16` / `2^23` bits |
| absolute exponent | 4096, also subject to the result envelope |
| partial-fraction factors/output terms | 1024 / 4096 |
| parent/source discovery | 64 strong parent LRU entries (4 MiB); at most 64 weak source-ring entries |

The normalization charge is `8*(D+1)^3*C`, with the roadmap's
`C_Q(B)=(1+ceil(B/30))^2` (and its prime-field analogue).  Therefore the aggregate work
cap is intentionally stricter than the standalone degree cap for some
inputs: with unit-size rational coefficients, degree 127 is admitted exactly
at `2^26` and degree 128 is refused before normalization.  Tests pin this intersection of
the limits, the coefficient and exponent boundaries, and post-refusal cache
and name atomicity.  `test/function-field-alloc-sites.json` registers every
new R0 iteration/materialization site as a change detector.  Direct live
spies pin every result family one byte below and exactly at its preflight
envelope; the source-ring discovery table is both weak-valued and bounded.

## Clean-room oracle provenance

`magma-tests/test_function_fields.m` and its `.out` were generated on
2026-10-22 with `/usr/local/bin/magma`, Magma V2.18-5, used only as a
black-box printing and answer oracle.  The exact error-order fixture is
`magma-tests/test_stdin_function_fields_errors.*`.  No Magma source was
read.

SageMath 10.9.post1 was used independently as a black-box answer oracle with
the documented `FunctionField` API.  For both `Q(x)` and `GF(5)(t)`, it
confirmed the normalized numerator/denominator, quotient-rule derivative,
and reconstruction identity used by the tests:

```text
Rational function field in x over Rational Field
(x^2 + 1)/(x - 1)
x^2 + 1
x - 1
(x^2 - 2*x - 1)/(x^2 - 2*x + 1)
True
Rational function field in t over Finite Field of size 5
(t + 1)/(t^2 + 1)
t + 1
t^2 + 1
(4*t^2 + 3*t + 1)/(t^4 + 2*t^2 + 1)
True
```

The Sage invocation was `sage -c` using only public constructors and element
methods; no Sage source was read or copied.

## Calibration

The committed wasm and CDN module are rebuilt with this PR even though R0a's
adapter itself runs in the compiled Python/TypeScript runtime and therefore
owns no wasm-linear-memory allocation.  `function-fields-wasm.test.ts`
instantiates the real rebuilt artifact, retains a near-4 MiB reply through
the shared ABI, and checks the roadmap's wasm partition:

| measurement | bytes |
|---|---:|
| resident wasm linear memory `R` | 1,638,400 |
| linear memory after the retained reply | 14,286,848 |
| measured peak after the next call | 14,286,848 |

Thus `R` is below 12 MiB and the measured peak is below 64 MiB.  The rebuilt
wasm SHA-256 is
`6079bda5d7814c975178620eaabeff4ecfb5c9f9094f5387de8e2d054c79bdac`;
`node cdn/build.mjs --check` verifies that the committed CDN module embeds it.

The real compiled CLI separately retains a 4 MiB value, fills and churns the
64-entry parent LRU while keeping every weak identity live, performs the
largest admitted normalization (degree 127), refuses degree 128, then makes
a clean call.  On this project host it took 3.09 s and peaked at 284,600 KiB
RSS.  A one-line baseline was 277,552 KiB and retaining the 4 MiB value alone
was 283,088 KiB, so the measured cache-and-call increment over the retained
case was 1,512 KiB.  V8's resident runtime is not wasm linear memory; both
paths nevertheless use the same R0a acceptance caps.
