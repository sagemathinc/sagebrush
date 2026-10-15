# Special functions

lib/_special.py is the numerical core of Sagebrush's special functions.
MATLAB's functions (lib/_matlab_special.py) use it, and so will Sagebrush's
scipy.special and Sage. It is plain Python with numpy and math, in double
precision, with no MATLAB types:

- every function works elementwise on scalars or numpy arrays (broadcast),
  and returns a float or complex (an array for array input);
- `PoleError` (a `ValueError`) is raised at a pole; `NotCovered` (both a
  `ValueError` and a `NotImplementedError`, so that Sage mode can tell "not
  available yet" from "invalid") where the function has a value that
  Sagebrush does not compute; and `ValueError` where it has none. It never
  guesses. A NaN argument gives NaN; an infinite one gives the limit a
  docstring states, or a refusal. The MATLAB wrappers turn a pole into
  MATLAB's Inf, and anything else into an error;
- each docstring gives the method's source (a section of the NIST Digital
  Library of Mathematical Functions, DLMF, or a paper), the domain, and the
  largest error found against mpmath, including where the error grows.

## Functions

| Function | Method (DLMF) |
|---|---|
| `loggamma(z)` | principal branch, as in scipy.special.loggamma: Stirling 5.11.1, recurrence 5.5.1, reflection 5.5.3 with a log sin(πz) that is analytic in the upper half plane, the series 5.7.3 near the zeros at 1 and 2 |
| `gamma(z)` | the math library for real x, exp(loggamma) for complex z |
| `psi(z)`, `polygamma(n, z)` | 5.11.2 and 5.15.9 asymptotics, recurrences 5.5.2 and 5.15.5, reflections 5.5.4 and 5.15.6 (cot's derivatives as a polynomial in cot for real z, as a q-series for complex z), the series 5.7.4 about 1 |
| `zeta(s)`, `hurwitz_zeta(s, a)` | Euler-Maclaurin 25.2.9 / 25.11.5, functional equation 25.4.2, Bernoulli polynomials 25.11.14 (exact rationals) at the integers s <= 0 |
| `beta(a, b)`, `betaln(a, b)` | 5.12.1, with Stirling's series' large terms combined analytically for large arguments; for a large negative argument each Gamma of a negative argument reflected (5.5.3), so that B is a beta of positive arguments times sines, with the rounding errors of a + b, 1 - a, 1 - b and 1 - a - b carried exactly (TwoSum) into log B's derivatives and the sine's addition formula |
| `faddeeva(z)`, `erf`, `erfc`, `erfi`, `erfcx` | w(z) by the trapezoidal rule on 7.7.2 with the pole's residue added (Im z < 6), Laplace's continued fraction 7.9.3 beyond; 7.2.3, 7.4.3, the Taylor series 7.6.1; e^(-z^2) with its exponent y^2 - x^2 and phase -2xy exact (Dekker's product) |
| `erfinv(y)`, `erfcinv(q)` | Halley's iteration on erf, and Newton's on log erfc = log erfcx - x^2, which reaches the smallest subnormal q |
| `exp_integral_e1(z)`, `exp_integral_ei(x)` | the series 6.6.1 and 6.6.2, the continued fraction 6.9.1, the asymptotic series 6.12.1 and 6.12.2, a Taylor series about Ei's zero (6.13.1) |
| `lambert_w(z, k)` | every branch, with DLMF 4.13's branches and cuts (4.13.2, 4.13.3: the real values of W_-1 are W_-1(x + 0i), and W_1(x - 0i) gives them too); Halley's iteration from the series in (e z + 1)^(1/2) about the branch point (4.13.9_1, whose coefficients are computed by exact series reversion and summed directly near -1/e) or the asymptotic series (4.13.10, 4.13.11); on a cut the sign of a zero imaginary part picks the side (scipy.special.lambertw agrees except at W_-1(x - 0i) on (-1/e, 0), where it gives the real value) |
| `polylog(s, z)`, `dilog(z)` | integer orders -20 <= s <= 100: the series 25.12.10, the expansion in log z (25.12.12, and its limit at integers, where two poles cancel into H_(n-1) - log(-log z)), the inversion 25.12.13 (with 25.11.14's Bernoulli polynomials at integers), and for s <= 0 the Eulerian polynomials (26.14.4, 26.14.6) |
| `ellipk(m)`, `ellipe(m)` | m <= 1: K by the AGM (19.8.5); E by the series 19.5.2 (m <= 1/2) and 19.12.2 (in 1 - m), and 19.7.2's imaginary-modulus transformation for m < 0, since 19.8.6's AGM sum cancels |
| `ellipj(u, m)` | finite real u, 0 <= m <= 1: the AGM with phases (22.20), after reducing u by the periods to [0, K/2] (Table 22.4.3's translations by K and 2K, so that cn keeps its relative accuracy next to its zeros; beyond 8K in exact integer fixed point, with K to some 130 bits more than log2(\|u\|/K)); the Maclaurin series 22.10.1-22.10.3 below 1e-3; the ascending Landen transformation (22.7) for m > 0.9 |
| `gammainc(a, x)`, `gammaincc(a, x)`, `gammainc_scaled(a, x, upper)` | the regularized P and Q, real a, x >= 0, in Gautschi's regions (ACM TOMS 5, 1979): the series 8.7.1 for P above a = x + 1/4, below it Q by Legendre's continued fraction 8.9.2 (modified Lentz) for x > 1.5 and by 8.7.1's series for gamma, with 1 - x^a/Gamma(a+1) by expm1, for x <= 1.5; for a >= 12 near x (\|eta\| <= 0.6) Temme's uniform expansion 8.12.3-8.12.4, its coefficients' Taylor series in eta computed exactly by scripts/gen-gammainc-temme.py (c_k = (c_(k-1)' + gamma_k eta/(lambda - 1))/eta, gamma_k from 1/Gamma*); the prefactor x^a e^-x/Gamma(a+1) in Temme's form, through lambda - 1 - log lambda, for a >= 1; the scaled forms (MATLAB's 'scaledlower', 'scaledupper') of the smaller of P and Q within each method (the series' sum, a times the continued fraction, Temme's expansion with erfcx), so that they survive where P or Q underflows |
| `legendre_p(n, x)`, `assoc_legendre_p(n, m, x)`, `legendre_all(n, x, normalization)` | integer degree and order, real x in [-1, 1]: the degree recurrence 14.10.3 with exact coefficients from the diagonal (14.7.8), and next to +-1 (n^2 (1 - |x|)/2 <= 1) the terminating hypergeometric series 14.3.1 with 14.9.3 and 14.7.17; the scale kept as an exact power of 2 and the factorial ratios as exact integers |

The phase conventions of the Legendre functions:
- `assoc_legendre_p` and `legendre_all(..., "unnorm")` are the Ferrers functions of DLMF 14.7.8, P_n^m(x) = (-1)^m (1 - x^2)^(m/2) d^m P_n/dx^m. They include the Condon-Shortley phase (-1)^m, as MATLAB's 'unnorm' does.
- `"sch"` (Schmidt seminormalized, (-1)^m sqrt(2 (n-m)!/(n+m)!) P_n^m for m > 0) and `"norm"` (fully normalized, (-1)^m sqrt((n + 1/2)(n-m)!/(n+m)!) P_n^m) multiply by (-1)^m again, so they have no phase, as MATLAB's do.

The trapezoidal rule for w(z) is derived in its comment: summing
π cot(π(t/h - d)) f(t) round the nodes gives the rule plus the residue at
t = z, and the nodes are placed so that Re z is midway between two.

## Accuracy and tests

test/special_mpmath_gen.py writes test/special-mpmath.json (1765 cases,
mpmath at 40 digits). test/special.test.ts checks every case in Sagebrush,
where math.erf, lgamma and gamma are fdlibm's and musl's rather than glibc's.
Its tolerances are a little above the largest errors measured there. Most
functions are within a few units in the last place. The larger errors
follow the functions' own condition numbers or the method's: for complex s,
zeta's and hurwitz_zeta's absolute error grows with |Im s| (about
8 |Im s| eps of max(1, |zeta|), from the rounding of the phases Im s log k),
the real erfi's and erfcx's with x^2 (the rounding of e^(x^2)'s exponent;
for complex z e^(-z^2) is exact, and the error functions are within 1e-15
for |z| up to 1e9), E1's and Ei's with |x|, and the incomplete gamma
functions' with the size of their exponent (about 4e-15 max(1, |log
value|), the rounding of log x^a e^-x / Gamma(a+1)); beta's grows with
|betaln| likewise (7e-15 max(1, |betaln|) for negative arguments).
scripts/special-edge-sweep.py --oracle compares every function's values at
the ends of the doubles with mpmath's.
matlab-tests/test_special.m checks the MATLAB functions against GNU Octave,
to 10 digits, on the examples from their documentation pages and more.

## Not yet

- The incomplete beta functions, the unregularized and log-scale incomplete
  gamma functions, and the incomplete gamma functions of negative or
  complex arguments (NotCovered).
- Incomplete elliptic integrals, Carlson's integrals, complex arguments
  of the elliptic functions, and Legendre functions of non-integer degree
  or order or of the second kind.
- Bessel and Airy functions, after Amos's papers (ACM TOMS 644).
- polylog of non-integer order, and of orders below -20 or above 100.
- Complex beta, complex erfinv, hurwitz_zeta for complex a (the summation
  cancels catastrophically, and DLMF 25.11.5 is stated for real a) or
  non-integer Re s <= -1, polygamma for n > 100, |Im s| > 1e5 for zeta:
  NotCovered.
