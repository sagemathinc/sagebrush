# Sagebrush–Magma/FLINT speed scoreboard

## Verdict

All 19 measured answer signatures agreed.
Sagebrush is within 10x of the faster available Magma/FLINT reference on 9/19 comparable points; 10 point(s) exceed that gap.
3 point(s) failed or timed out and are listed before the timing table.

## Correctness findings

None. Every measured Sagebrush signature matched each available Magma/FLINT signature.

## User-important gaps above 10x

- **linear algebra over Fp — solve (p=65537) (n=400):** 5125.1x gap; Sagebrush 54.233 s, best reference FLINT 0.0106 s.
- **linear algebra over Q — solve (n=80):** 11.7x gap; Sagebrush 0.0389 s, best reference FLINT 0.0033 s.
- **linear algebra over Fp — rank (p=65537) (n=400):** 5140.4x gap; Sagebrush 54.221 s, best reference FLINT 0.0105 s.
- **linear algebra over Fp — determinant (p=65537) (n=400):** 5075.5x gap; Sagebrush 54.274 s, best reference FLINT 0.0107 s.
- **polynomials over Fp — gcd (p=65537) (n=5000):** 4097.8x gap; Sagebrush 11.744 s, best reference FLINT 0.0029 s.
- **linear algebra over Z — rank (n=250):** 666.7x gap; Sagebrush 3.020 s, best reference FLINT 0.0045 s.
- **linear algebra over Z — Hermite form (n=100):** 178.3x gap; Sagebrush 6.991 s, best reference FLINT 0.0392 s.
- **linear algebra over Q — rank (n=100):** 78.4x gap; Sagebrush 0.0638 s, best reference FLINT 0.000813 s.
- **polynomials over Fp — multiply (p=65537) (n=20000):** 10852.4x gap; Sagebrush 38.887 s, best reference FLINT 0.0036 s.
- **polynomials over Fp — factor x^n-1 (p=65537) (n=500):** 18.0x gap; Sagebrush 4.907 s, best reference FLINT 0.2731 s.

## Failures and timeouts

- **poly_z_factor n=240 (check failed):** `sagebrush timeout`
- **mat_z_smith n=60 (check failed):** `sagebrush timeout`
- **mat_fp_charpoly n=400 (check failed):** `sagebrush timeout`

## Raw named numbers

Ratio is Sagebrush time divided by the faster available Magma/FLINT time. Each time is the arithmetic mean of the named repeat count.

| Category | Case | Size | Repeats | Sagebrush (s) | Magma (s) | FLINT 3.6 (s) | Best | Ratio | Verdict |
|---|---|---:|---:|---:|---:|---:|---|---:|---|
| big integers | bigint_mul — integer multiply | 1048576 | 1 | 0.0060 | pending (not on host) | 0.0044 | FLINT | 1.384x | within 1.38x of best reference |
| big integers | bigint_gcd — integer gcd | 1048576 | 1 | 0.0370 | pending (not on host) | 0.0090 | FLINT | 4.099x | within 4.1x of best reference |
| polynomials over Z | poly_z_mul — multiply | 20000 | 1 | 0.0313 | pending (not on host) | 0.0053 | FLINT | 5.875x | within 5.9x of best reference |
| polynomials over Z | poly_z_gcd — gcd | 5000 | 1 | 0.1440 | pending (not on host) | 0.0295 | FLINT | 4.886x | within 4.9x of best reference |
| polynomials over Z | poly_z_factor — factor x^n-1 | 240 | 1 | — | pending (not on host) | — | — | — | check failed |
| polynomials over Z | poly_z_factor_product — factor product of irreducible quadratics | 32 | 1 | 0.0299 | pending (not on host) | 0.0060 | FLINT | 4.980x | within 5.0x of best reference |
| polynomials over Fp | poly_fp_mul — multiply (p=65537) | 20000 | 1 | 38.887 | pending (not on host) | 0.0036 | FLINT | 10852.385x | 10852.4x gap |
| polynomials over Fp | poly_fp_gcd — gcd (p=65537) | 5000 | 1 | 11.744 | pending (not on host) | 0.0029 | FLINT | 4097.776x | 4097.8x gap |
| polynomials over Fp | poly_fp_factor — factor x^n-1 (p=65537) | 500 | 1 | 4.907 | pending (not on host) | 0.2731 | FLINT | 17.967x | 18.0x gap |
| linear algebra over Z | mat_z_det — determinant | 150 | 1 | 0.0345 | pending (not on host) | 0.0188 | FLINT | 1.835x | within 1.83x of best reference |
| linear algebra over Z | mat_z_rank — rank | 250 | 1 | 3.020 | pending (not on host) | 0.0045 | FLINT | 666.746x | 666.7x gap |
| linear algebra over Z | mat_z_hnf — Hermite form | 100 | 1 | 6.991 | pending (not on host) | 0.0392 | FLINT | 178.250x | 178.3x gap |
| linear algebra over Z | mat_z_smith — Smith form | 60 | 1 | — | pending (not on host) | — | — | — | check failed |
| linear algebra over Z | mat_z_charpoly — characteristic polynomial | 120 | 1 | 0.1816 | pending (not on host) | 0.1122 | FLINT | 1.618x | within 1.62x of best reference |
| linear algebra over Fp | mat_fp_det — determinant (p=65537) | 400 | 1 | 54.274 | pending (not on host) | 0.0107 | FLINT | 5075.538x | 5075.5x gap |
| linear algebra over Fp | mat_fp_rank — rank (p=65537) | 400 | 1 | 54.221 | pending (not on host) | 0.0105 | FLINT | 5140.393x | 5140.4x gap |
| linear algebra over Fp | mat_fp_solve — solve (p=65537) | 400 | 1 | 54.233 | pending (not on host) | 0.0106 | FLINT | 5125.052x | 5125.1x gap |
| linear algebra over Fp | mat_fp_charpoly — characteristic polynomial (p=65537) | 400 | 1 | — | pending (not on host) | — | — | — | check failed |
| linear algebra over Q | mat_q_det — determinant | 80 | 1 | 0.0086 | pending (not on host) | 0.0034 | FLINT | 2.510x | within 2.51x of best reference |
| linear algebra over Q | mat_q_rank — rank | 100 | 1 | 0.0638 | pending (not on host) | 0.000813 | FLINT | 78.391x | 78.4x gap |
| linear algebra over Q | mat_q_solve — solve | 80 | 1 | 0.0389 | pending (not on host) | 0.0033 | FLINT | 11.653x | 11.7x gap |
| linear algebra over Q | mat_q_charpoly — characteristic polynomial | 80 | 1 | 0.0432 | pending (not on host) | 0.0185 | FLINT | 2.332x | within 2.33x of best reference |
| Groebner bases | groebner_cyclic — cyclic over GF(32003) | 7 | 1 | — | pending (not on host) | N/A | — | — | pending reference |
| Groebner bases | groebner_katsura — Katsura over GF(32003) | 9 | 1 | — | pending (not on host) | N/A | — | — | pending reference |
| number fields | class_group — imaginary quadratic class group | 40 | 1 | — | pending (not on host) | N/A | — | — | pending reference |
| number fields | galois_group — Galois group of x^n-x-1 | 7 | 1 | — | pending (not on host) | N/A | — | — | pending reference |
| modular forms | modsym_charpoly — exact T2 modular-symbol charpoly | 5003 | 1 | — | pending (not on host) | N/A | — | — | pending reference |
| modular forms | newforms — weight-2 newform decomposition | 997 | 1 | — | pending (not on host) | N/A | — | — | pending reference |
| elliptic curves | ec_aplist — Frobenius traces for 5077a1 | 100000 | 1 | — | pending (not on host) | N/A | — | — | pending reference |

## Method

- Each point ran alone; no benchmark subprocesses overlapped.
- Before timing a point, Sagebrush and FLINT evaluated it once and compact deterministic answer signatures were compared. A mismatch suppresses timing; operations without a FLINT oracle were not timed.
- Each subprocess had a 60 s timeout. Thread-related environment variables were fixed at 1.
- Total child CPU used by this run: 648.5 s; elapsed wall time: 648.4 s.
- Host: `sagebrush-vm1`. Sagebrush git revision: `f21a67ff1134dc3163dfea30c15a25e4dd279f29`.
- Magma is not installed on this host; its cells remain pending. FLINT uses the public `python-flint` 0.9.0 binding backed by FLINT 3.6.0. FLINT is not linked into shipped Sagebrush.
- Timings exclude input construction, answer-signature conversion, and process startup: each engine reports elapsed time around only the operation loop.
- This VM profile contains only the large size from each family. Operations without a same-host FLINT oracle remain `pending reference` when Magma is unavailable.

Inputs and exact commands are documented in [README.md](README.md); structured case sizes are in [cases.json](cases.json).
