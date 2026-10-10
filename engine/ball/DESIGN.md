# sagebrush-ball: rigorous ball arithmetic

## Why

Three open findings from the second review (R2-EC-F2, R2-EC-F3, R2-CLG-F2)
have one cause. Results reported as certified are computed in IEEE doubles
with fixed safety margins (`1e-9`, `1e-12`, "an allowance for libm"). A
margin is an assumption, not an enclosure. `engine/sym/src/interval.rs` is
the same: f64 endpoints, with libm assumed accurate to `1e-14`. This crate
replaces the assumptions with enclosures.

## What "rigorous" means here

A `Ball` is a midpoint `m * 2^e` (exact: `m` a BigInt, `e` an i64) and a
radius `r` (a `Mag`, an upper bound kept as a mantissa below 2^32 and an
exponent). It stands for the real interval `[m 2^e - r, m 2^e + r]`.
Every operation returns a ball that contains `f(x)` for **every** `x` in the
input balls:

- Rounding the midpoint to the working precision adds the rounding error to
  the radius.
- Every radius operation rounds **up**.
- No floating-point arithmetic is used anywhere in a result's computation.
  f64 appears only in conversions for display, which are marked as such.
- Elementary and special functions evaluate `f` at the exact midpoint with
  ball arithmetic (so rounding errors are tracked automatically), add a
  proven truncation bound (for example a Taylor tail), and add
  `r * sup |f'|` over the input ball for propagation.

## Stages

1. **Core**: `Mag`, `Ball`, exact conversions, `+ - * /`, `sqrt`, `exp`,
   `log`, `sin`, `cos`, `atan`, the constants `pi`, `log 2`, Euler's
   `gamma` and Catalan's `G`, and certified comparisons (`Some(Ordering)`
   only when the balls decide it).
2. **Special functions and complex balls**: `E_1`, `Li_2`, `Ti_2`, complex
   balls (`exp`, `log`, `sqrt`), real and complex AGM, Carlson `R_F`.
3. **Class-group certificate** (`engine/classgroup/src/nf/grh.rs`,
   `certify.rs`): `ell`, the witness's `LDL^T` sign test, `log_hr_lower`
   and `regulator_bounds` computed with balls. `certified: true` then means
   enclosed, under GRH. Closes R2-CLG-F2.
4. **Elliptic curves**: the L-series sums at `s = 1` (rank 0 and 1
   certificates), periods, canonical heights, the regulator and the index
   bound, in Rust on balls, exposed through `sagebrush_web::call` and used by
   `lib/_sage_ec.py`. Closes R2-EC-F2 and R2-EC-F3.

## Testing

- **Oracle**: Arb (via python-flint) at high precision, as an independent
  check only; no Arb code is used (Arb is LGPL). `oracle/make_fixture.py`
  writes inputs and tight Arb balls to a fixture. Every Sagebrush ball must
  contain Arb's ball.
- **Identities** on random dyadic and rational inputs at many precisions:
  `exp(log x)` contains `x`, `sin^2 + cos^2` contains 1, `tan(atan x)`
  contains `x`.
- **Extremes**: scales from `2^-2000` to `2^2000`, cancellation
  (`(1 + t) - 1`), huge arguments of `sin`, inputs with wide radii.
- **Tightness**: results at precision `p` from exact inputs are within a few
  ulps of `2^-p` relative, so that certificates actually decide.
- Tests also run in debug (overflow checks), as CI does.
