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
| `beta(a, b)`, `betaln(a, b)` | 5.12.1, with Stirling's series' large terms combined analytically for large arguments |
| `faddeeva(z)`, `erf`, `erfc`, `erfi`, `erfcx` | w(z) by the trapezoidal rule on 7.7.2 with the pole's residue added (Im z < 6), Laplace's continued fraction 7.9.3 beyond; 7.2.3, 7.4.3, the Taylor series 7.6.1 |
| `erfinv(y)`, `erfcinv(q)` | Halley's iteration on erf, and Newton's on log erfc = log erfcx - x^2, which reaches the smallest subnormal q |
| `exp_integral_e1(z)`, `exp_integral_ei(x)` | the series 6.6.1 and 6.6.2, the continued fraction 6.9.1, the asymptotic series 6.12.1 and 6.12.2, a Taylor series about Ei's zero (6.13.1) |

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
the error functions' with |z|^2, and E1's and Ei's with |x|.
matlab-tests/test_special.m checks the MATLAB functions against GNU Octave,
to 10 digits, on the examples from their documentation pages and more.

## Not yet

- The incomplete gamma and beta functions (unregularized, regularized and
  log-scale; the upper incomplete gamma for a <= 0). They wait for the
  DiDonato-Morris and Temme papers.
- Elliptic integrals and functions, and Legendre functions (DLMF 19, 22,
  14). The phase convention (Condon-Shortley) will be stated for each
  normalization.
- Bessel and Airy functions, after Amos's papers (ACM TOMS 644).
- polylog, dilog and lambert_w.
- Complex beta, complex erfinv, hurwitz_zeta for complex a (the summation
  cancels catastrophically, and DLMF 25.11.5 is stated for real a) or
  non-integer Re s <= -1, polygamma for n > 100, |Im s| > 1e5 for zeta:
  NotCovered.
