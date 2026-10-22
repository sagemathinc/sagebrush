# Sagebrush–Magma/FLINT speed scoreboard

## Verdict

All 58 measured answer signatures agreed.
Sagebrush is within 10x of the faster available Magma/FLINT reference on 31/56 comparable points; 25 point(s) exceed that gap.
2 point(s) have no resolved reference time and therefore no numeric ratio.

## Correctness findings

None. Every measured Sagebrush signature matched each available Magma/FLINT signature.

## User-important gaps above 10x

- **linear algebra over Fp — solve (p=65537) (n=160):** 5420.3x gap; Sagebrush 3.975 s, best reference FLINT 0.000733 s.
- **linear algebra over Fp — solve (p=65537) (n=60):** 1997.3x gap; Sagebrush 0.2048 s, best reference FLINT 0.000103 s.
- **linear algebra over Q — solve (n=15):** 13.6x gap; Sagebrush 0.00079 s, best reference FLINT 5.83e-05 s.
- **linear algebra over Q — solve (n=35):** 10.5x gap; Sagebrush 0.0063 s, best reference FLINT 0.000595 s.
- **linear algebra over Fp — rank (p=65537) (n=160):** 5596.0x gap; Sagebrush 3.950 s, best reference FLINT 0.000706 s.
- **linear algebra over Fp — determinant (p=65537) (n=160):** 5526.6x gap; Sagebrush 3.867 s, best reference FLINT 0.0007 s.
- **linear algebra over Fp — rank (p=65537) (n=60):** 4162.2x gap; Sagebrush 0.1927 s, best reference FLINT 4.63e-05 s.
- **linear algebra over Fp — determinant (p=65537) (n=60):** 3882.9x gap; Sagebrush 0.1948 s, best reference FLINT 5.02e-05 s.
- **polynomials over Fp — gcd (p=65537) (n=300):** 1851.2x gap; Sagebrush 0.0472 s, best reference FLINT 2.55e-05 s.
- **polynomials over Fp — gcd (p=65537) (n=1000):** 1772.3x gap; Sagebrush 0.4956 s, best reference FLINT 0.00028 s.
- **linear algebra over Fp — characteristic polynomial (p=65537) (n=160):** 1184.0x gap; Sagebrush 5.920 s, best reference Magma 0.0050 s.
- **linear algebra over Fp — characteristic polynomial (p=65537) (n=60):** 947.3x gap; Sagebrush 0.2717 s, best reference FLINT 0.000287 s.
- **linear algebra over Z — Smith form (n=24):** 251.5x gap; Sagebrush 0.1428 s, best reference FLINT 0.000568 s.
- **linear algebra over Z — rank (n=100):** 201.6x gap; Sagebrush 0.1008 s, best reference FLINT 0.0005 s.
- **linear algebra over Z — Smith form (n=12):** 94.7x gap; Sagebrush 0.0070 s, best reference FLINT 7.41e-05 s.
- **linear algebra over Z — rank (n=50):** 87.2x gap; Sagebrush 0.0079 s, best reference FLINT 9.07e-05 s.
- **linear algebra over Q — rank (n=50):** 45.5x gap; Sagebrush 0.0071 s, best reference FLINT 0.000155 s.
- **linear algebra over Q — rank (n=20):** 23.2x gap; Sagebrush 0.000598 s, best reference FLINT 2.58e-05 s.
- **linear algebra over Z — Hermite form (n=45):** 19.0x gap; Sagebrush 0.1123 s, best reference FLINT 0.0059 s.
- **linear algebra over Z — Hermite form (n=20):** 14.1x gap; Sagebrush 0.0040 s, best reference FLINT 0.000283 s.
- **polynomials over Fp — multiply (p=65537) (n=5000):** 4116.0x gap; Sagebrush 2.323 s, best reference FLINT 0.000564 s.
- **polynomials over Fp — multiply (p=65537) (n=1000):** 1443.1x gap; Sagebrush 0.0914 s, best reference FLINT 6.33e-05 s.
- **polynomials over Z — multiply (n=1000):** 10.6x gap; Sagebrush 0.0012 s, best reference FLINT 0.000117 s.
- **polynomials over Z — factor x^n-1 (n=120):** 4720.8x gap; Sagebrush 0.4721 s, best reference Magma 0.0001 s.
- **polynomials over Z — factor x^n-1 (n=60):** 189.4x gap; Sagebrush 0.0095 s, best reference Magma 5e-05 s.

## Raw named numbers

Ratio is Sagebrush time divided by the faster available Magma/FLINT time. Each time is the arithmetic mean of the named repeat count.

| Category | Case | Size | Repeats | Sagebrush (s) | Magma (s) | FLINT 3.6 (s) | Best | Ratio | Verdict |
|---|---|---:|---:|---:|---:|---:|---|---:|---|
| big integers | bigint_mul — integer multiply | 65536 | 100 | 0.000137 | 0.0001 | 0.000113 | Magma | 1.371x | within 1.37x of best reference |
| big integers | bigint_mul — integer multiply | 262144 | 30 | 0.0012 | 0.0010 | 0.000881 | FLINT | 1.410x | within 1.41x of best reference |
| big integers | bigint_mul — integer multiply | 1048576 | 1 | — | — | — | — | — | pending VM |
| big integers | bigint_gcd — integer gcd | 65536 | 100 | 0.0012 | 0.0004 | 0.000168 | FLINT | 6.877x | within 6.9x of best reference |
| big integers | bigint_gcd — integer gcd | 262144 | 30 | 0.0073 | 0.0020 | 0.0013 | FLINT | 5.416x | within 5.4x of best reference |
| big integers | bigint_gcd — integer gcd | 1048576 | 1 | — | — | — | — | — | pending VM |
| polynomials over Z | poly_z_mul — multiply | 1000 | 20 | 0.0012 | 0.0005 | 0.000117 | FLINT | 10.621x | 10.6x gap |
| polynomials over Z | poly_z_mul — multiply | 5000 | 10 | 0.0066 | 0.0030 | 0.0011 | FLINT | 6.248x | within 6.2x of best reference |
| polynomials over Z | poly_z_mul — multiply | 20000 | 1 | — | — | — | — | — | pending VM |
| polynomials over Z | poly_z_gcd — gcd | 300 | 20 | 0.0018 | 0.0010 | 0.000193 | FLINT | 9.198x | within 9.2x of best reference |
| polynomials over Z | poly_z_gcd — gcd | 1000 | 10 | 0.0064 | 0.0080 | 0.0033 | FLINT | 1.912x | within 1.91x of best reference |
| polynomials over Z | poly_z_gcd — gcd | 5000 | 1 | — | — | — | — | — | pending VM |
| polynomials over Z | poly_z_factor — factor x^n-1 | 60 | 1000 | 0.0095 | 5e-05 | 0.0025 | Magma | 189.371x | 189.4x gap |
| polynomials over Z | poly_z_factor — factor x^n-1 | 120 | 100 | 0.4721 | 0.0001 | 0.0117 | Magma | 4720.776x | 4720.8x gap |
| polynomials over Z | poly_z_factor — factor x^n-1 | 240 | 1 | — | — | — | — | — | pending VM |
| polynomials over Z | poly_z_factor_product — factor product of irreducible quadratics | 8 | 10 | 0.000855 | 0.0010 | 0.000371 | FLINT | 2.306x | within 2.31x of best reference |
| polynomials over Z | poly_z_factor_product — factor product of irreducible quadratics | 16 | 3 | 0.0039 | <0.01 | 0.0014 | FLINT | 2.727x | within 2.73x of best reference |
| polynomials over Z | poly_z_factor_product — factor product of irreducible quadratics | 32 | 1 | — | — | — | — | — | pending VM |
| polynomials over Fp | poly_fp_mul — multiply (p=65537) | 1000 | 10 | 0.0914 | <0.01 | 6.33e-05 | FLINT | 1443.146x | 1443.1x gap |
| polynomials over Fp | poly_fp_mul — multiply (p=65537) | 5000 | 10 | 2.323 | 0.0010 | 0.000564 | FLINT | 4115.963x | 4116.0x gap |
| polynomials over Fp | poly_fp_mul — multiply (p=65537) | 20000 | 1 | — | — | — | — | — | pending VM |
| polynomials over Fp | poly_fp_gcd — gcd (p=65537) | 300 | 100 | 0.0472 | 0.0001 | 2.55e-05 | FLINT | 1851.246x | 1851.2x gap |
| polynomials over Fp | poly_fp_gcd — gcd (p=65537) | 1000 | 20 | 0.4956 | 0.0005 | 0.00028 | FLINT | 1772.311x | 1772.3x gap |
| polynomials over Fp | poly_fp_gcd — gcd (p=65537) | 5000 | 1 | — | — | — | — | — | pending VM |
| polynomials over Fp | poly_fp_factor — factor x^n-1 (p=65537) | 60 | 10 | 0.0026 | 0.0010 | 0.00071 | FLINT | 3.596x | within 3.6x of best reference |
| polynomials over Fp | poly_fp_factor — factor x^n-1 (p=65537) | 120 | 5 | 0.0095 | 0.0020 | 0.0021 | Magma | 4.770x | within 4.8x of best reference |
| polynomials over Fp | poly_fp_factor — factor x^n-1 (p=65537) | 500 | 1 | — | — | — | — | — | pending VM |
| linear algebra over Z | mat_z_det — determinant | 30 | 10 | 0.000542 | 0.0010 | 0.000279 | FLINT | 1.943x | within 1.94x of best reference |
| linear algebra over Z | mat_z_det — determinant | 70 | 3 | 0.0054 | 0.0033 | 0.0025 | FLINT | 2.207x | within 2.21x of best reference |
| linear algebra over Z | mat_z_det — determinant | 150 | 1 | — | — | — | — | — | pending VM |
| linear algebra over Z | mat_z_rank — rank | 50 | 10 | 0.0079 | 0.0010 | 9.07e-05 | FLINT | 87.208x | 87.2x gap |
| linear algebra over Z | mat_z_rank — rank | 100 | 3 | 0.1008 | <0.01 | 0.0005 | FLINT | 201.576x | 201.6x gap |
| linear algebra over Z | mat_z_rank — rank | 250 | 1 | — | — | — | — | — | pending VM |
| linear algebra over Z | mat_z_hnf — Hermite form | 20 | 10 | 0.0040 | <0.01 | 0.000283 | FLINT | 14.129x | 14.1x gap |
| linear algebra over Z | mat_z_hnf — Hermite form | 45 | 5 | 0.1123 | 0.0060 | 0.0059 | FLINT | 19.002x | 19.0x gap |
| linear algebra over Z | mat_z_hnf — Hermite form | 100 | 1 | — | — | — | — | — | pending VM |
| linear algebra over Z | mat_z_smith — Smith form | 12 | 100 | 0.0070 | 0.0002 | 7.41e-05 | FLINT | 94.680x | 94.7x gap |
| linear algebra over Z | mat_z_smith — Smith form | 24 | 5 | 0.1428 | 0.0020 | 0.000568 | FLINT | 251.524x | 251.5x gap |
| linear algebra over Z | mat_z_smith — Smith form | 60 | 1 | — | — | — | — | — | pending VM |
| linear algebra over Z | mat_z_charpoly — characteristic polynomial | 30 | 10 | 0.0016 | 0.0020 | 0.000809 | FLINT | 2.019x | within 2.02x of best reference |
| linear algebra over Z | mat_z_charpoly — characteristic polynomial | 60 | 5 | 0.0137 | 0.0180 | 0.0093 | FLINT | 1.471x | within 1.47x of best reference |
| linear algebra over Z | mat_z_charpoly — characteristic polynomial | 120 | 1 | — | — | — | — | — | pending VM |
| linear algebra over Fp | mat_fp_det — determinant (p=65537) | 60 | 10 | 0.1948 | 0.0010 | 5.02e-05 | FLINT | 3882.904x | 3882.9x gap |
| linear algebra over Fp | mat_fp_det — determinant (p=65537) | 160 | 2 | 3.867 | <0.01 | 0.0007 | FLINT | 5526.617x | 5526.6x gap |
| linear algebra over Fp | mat_fp_det — determinant (p=65537) | 400 | 1 | — | — | — | — | — | pending VM |
| linear algebra over Fp | mat_fp_rank — rank (p=65537) | 60 | 10 | 0.1927 | 0.0010 | 4.63e-05 | FLINT | 4162.172x | 4162.2x gap |
| linear algebra over Fp | mat_fp_rank — rank (p=65537) | 160 | 2 | 3.950 | <0.01 | 0.000706 | FLINT | 5596.014x | 5596.0x gap |
| linear algebra over Fp | mat_fp_rank — rank (p=65537) | 400 | 1 | — | — | — | — | — | pending VM |
| linear algebra over Fp | mat_fp_solve — solve (p=65537) | 60 | 10 | 0.2048 | <0.01 | 0.000103 | FLINT | 1997.268x | 1997.3x gap |
| linear algebra over Fp | mat_fp_solve — solve (p=65537) | 160 | 2 | 3.975 | <0.01 | 0.000733 | FLINT | 5420.296x | 5420.3x gap |
| linear algebra over Fp | mat_fp_solve — solve (p=65537) | 400 | 1 | — | — | — | — | — | pending VM |
| linear algebra over Fp | mat_fp_charpoly — characteristic polynomial (p=65537) | 60 | 10 | 0.2717 | <0.01 | 0.000287 | FLINT | 947.251x | 947.3x gap |
| linear algebra over Fp | mat_fp_charpoly — characteristic polynomial (p=65537) | 160 | 2 | 5.920 | 0.0050 | 0.0053 | Magma | 1184.008x | 1184.0x gap |
| linear algebra over Fp | mat_fp_charpoly — characteristic polynomial (p=65537) | 400 | 1 | — | — | — | — | — | pending VM |
| linear algebra over Q | mat_q_det — determinant | 15 | 10 | 0.000232 | <0.01 | 6.8e-05 | FLINT | 3.417x | within 3.4x of best reference |
| linear algebra over Q | mat_q_det — determinant | 35 | 5 | 0.0013 | 0.0020 | 0.000432 | FLINT | 3.057x | within 3.1x of best reference |
| linear algebra over Q | mat_q_det — determinant | 80 | 1 | — | — | — | — | — | pending VM |
| linear algebra over Q | mat_q_rank — rank | 20 | 10 | 0.000598 | <0.01 | 2.58e-05 | FLINT | 23.178x | 23.2x gap |
| linear algebra over Q | mat_q_rank — rank | 50 | 5 | 0.0071 | <0.01 | 0.000155 | FLINT | 45.520x | 45.5x gap |
| linear algebra over Q | mat_q_rank — rank | 100 | 1 | — | — | — | — | — | pending VM |
| linear algebra over Q | mat_q_solve — solve | 15 | 100 | 0.00079 | 0.0002 | 5.83e-05 | FLINT | 13.558x | 13.6x gap |
| linear algebra over Q | mat_q_solve — solve | 35 | 5 | 0.0063 | <0.01 | 0.000595 | FLINT | 10.547x | 10.5x gap |
| linear algebra over Q | mat_q_solve — solve | 80 | 1 | — | — | — | — | — | pending VM |
| linear algebra over Q | mat_q_charpoly — characteristic polynomial | 15 | 10 | 0.000644 | <0.01 | 0.000106 | FLINT | 6.066x | within 6.1x of best reference |
| linear algebra over Q | mat_q_charpoly — characteristic polynomial | 35 | 5 | 0.0048 | 0.0040 | 0.0011 | FLINT | 4.325x | within 4.3x of best reference |
| linear algebra over Q | mat_q_charpoly — characteristic polynomial | 80 | 1 | — | — | — | — | — | pending VM |
| Groebner bases | groebner_cyclic — cyclic over GF(32003) | 5 | 20 | 5.97e-05 | <0.01 | N/A | — | — | reference timer resolution |
| Groebner bases | groebner_cyclic — cyclic over GF(32003) | 6 | 20 | 0.000348 | <0.01 | N/A | — | — | reference timer resolution |
| Groebner bases | groebner_cyclic — cyclic over GF(32003) | 7 | 1 | — | — | N/A | — | — | pending VM |
| Groebner bases | groebner_katsura — Katsura over GF(32003) | 6 | 20 | 0.00023 | 0.0005 | N/A | Magma | 0.460x | within 1x of best reference |
| Groebner bases | groebner_katsura — Katsura over GF(32003) | 7 | 10 | 0.0018 | 0.0020 | N/A | Magma | 0.885x | within 1x of best reference |
| Groebner bases | groebner_katsura — Katsura over GF(32003) | 9 | 1 | — | — | N/A | — | — | pending VM |
| number fields | class_group — imaginary quadratic class group | 12 | 1 | 0.0829 | 0.0100 | N/A | Magma | 8.287x | within 8.3x of best reference |
| number fields | class_group — imaginary quadratic class group | 24 | 1 | 0.1691 | 0.6600 | N/A | Magma | 0.256x | within 1x of best reference |
| number fields | class_group — imaginary quadratic class group | 40 | 1 | — | — | N/A | — | — | pending VM |
| number fields | galois_group — Galois group of x^n-x-1 | 3 | 1 | 0.000928 | 0.0800 | N/A | Magma | 0.012x | within 1x of best reference |
| number fields | galois_group — Galois group of x^n-x-1 | 5 | 1 | 0.0014 | 0.0900 | N/A | Magma | 0.015x | within 1x of best reference |
| number fields | galois_group — Galois group of x^n-x-1 | 7 | 1 | — | — | N/A | — | — | pending VM |
| modular forms | modsym_charpoly — exact T2 modular-symbol charpoly | 389 | 1 | 0.0011 | 0.0200 | N/A | Magma | 0.055x | within 1x of best reference |
| modular forms | modsym_charpoly — exact T2 modular-symbol charpoly | 1009 | 1 | 0.0048 | 0.0500 | N/A | Magma | 0.096x | within 1x of best reference |
| modular forms | modsym_charpoly — exact T2 modular-symbol charpoly | 5003 | 1 | — | — | N/A | — | — | pending VM |
| modular forms | newforms — weight-2 newform decomposition | 37 | 1 | 0.0013 | 0.0300 | N/A | Magma | 0.044x | within 1x of best reference |
| modular forms | newforms — weight-2 newform decomposition | 389 | 1 | 0.0154 | 0.0400 | N/A | Magma | 0.385x | within 1x of best reference |
| modular forms | newforms — weight-2 newform decomposition | 997 | 1 | — | — | N/A | — | — | pending VM |
| elliptic curves | ec_aplist — Frobenius traces for 5077a1 | 1000 | 2 | 0.0052 | 0.0250 | N/A | Magma | 0.207x | within 1x of best reference |
| elliptic curves | ec_aplist — Frobenius traces for 5077a1 | 10000 | 1 | 0.0084 | 0.1100 | N/A | Magma | 0.077x | within 1x of best reference |
| elliptic curves | ec_aplist — Frobenius traces for 5077a1 | 100000 | 1 | — | — | N/A | — | — | pending VM |

## Method

- Each point ran alone; no benchmark subprocesses overlapped.
- Before timing a point, Sagebrush, Magma, and (where it exposes the operation) FLINT evaluated it once and compact deterministic answer signatures were compared. A mismatch suppresses timing.
- Each subprocess had a 60 s timeout. Thread-related environment variables were fixed at 1.
- Total child CPU used by this run: 215.7 s; elapsed wall time: 215.6 s.
- Host: `cocalc-project`. Sagebrush git revision: `2b894d2c16e27daa5bde7f7284cdab6f29848798`.
- Magma was used only through `/usr/local/bin/magma` (V2.18-5). FLINT uses the existing bench-only `sagebrush-flint` Rust oracle where it exposes the operation and the public `python-flint` 0.9.0 binding for the remaining FLINT 3.6.0 operations. Neither oracle is linked into shipped Sagebrush.
- Timings exclude input construction, answer-signature conversion, and process startup: each engine reports elapsed time around only the operation loop. Magma 2.18-5 reports hundredths of a second.
- The large size in every family is deliberately marked `pending VM` in the local profile.

Inputs and exact commands are documented in [README.md](README.md); structured case sizes are in [cases.json](cases.json).
