# Provenance of sagebrush-lfun

`sagebrush-lfun` is written from published mathematics only. No code from PARI/GP, lcalc, Sage, mpmath,
FLINT/Arb, Boost, GSL, Cephes or any other library is copied, translated or shared. PARI/GP, Sage and
mpmath were only ever run, as oracles, to produce the reference values in `tests/`.

**Gamma (`src/gamma.rs`).** These are the formulas it uses:

- $\ln\Gamma(z)$: Stirling's series with ten terms, Abramowitz and Stegun, *Handbook of Mathematical
  Functions*, 6.1.40, after shifting $\operatorname{Re} z$ up with $\Gamma(z+1) = z\Gamma(z)$ (6.1.15).
- $\Gamma(a, z)$ for small $|z|$: $\Gamma(a) - \gamma(a, z)$, with
  $\gamma(a, z) = z^a e^{-z} \sum_k z^k / (a)_{k+1}$ (A&S 6.5.4 and 6.5.29).
- Near a pole $a = -m$ of $\Gamma(a)$, the pole and the $k = m$ term of
  $\gamma(a, z) = z^a \sum_k (-z)^k / (k!\,(a+k))$ cancel. The closed form for what is left is derived in
  the module. It uses $\Gamma(-m+\varepsilon) = \Gamma(1+\varepsilon) / (\varepsilon \prod_{j=1}^m (\varepsilon - j))$
  and the series for $\ln\Gamma(1+\varepsilon)$ in $\zeta(k)$ (A&S 6.1.33). The values of $\zeta(2), \dots, \zeta(12)$
  are the standard ones (A&S table 23.3).
- $\Gamma(a, z)$ otherwise: Legendre's continued fraction (A&S 6.5.31), evaluated by the modified Lentz
  method (Press, Teukolsky, Vetterling and Flannery, *Numerical Recipes*, 3rd ed., section 5.2).
- Where the series hands over to the continued fraction ($|z| = |a|$) was measured against mpmath on
  the rays the L-series uses. The measurements are recorded in the module.

**The coefficients (`src/an.rs`).** $a_n$ comes from $a_p$ by multiplicativity and the Hecke
recursion at good primes, with $a_{p^k} = a_p^k$ at bad ones (Silverman, *The Arithmetic of Elliptic
Curves*, 2nd ed., V.2 and C.16). The $a_p$ come from `sagebrush-ap`.

**The L-series (`src/lseries.rs`).** It uses the approximate functional equation for $\Lambda(s) = Q^s
\Gamma(s) L(E, s)$, with the path of the Mellin integral turned onto a ray, an idea from M. Rubinstein,
"Computational methods and experiments in analytic number theory" (2005), section 3.2. The formula
is derived in the module from $\Lambda(s) = \int_0^\infty \phi(x) x^{s-1}\,dx$ and
$\phi(1/x) = \varepsilon x^2 \phi(x)$. The root number is found by requiring the result not to depend on the
ray.

**Testing.**

- `tests/gamma_reference.txt` holds mpmath 1.3.0's $\ln\Gamma$ and $\Gamma(a, z)$ at 40 digits, from
  `gen/gamma_reference.py`.
- `tests/lfun_reference.txt` holds PARI/GP's `lfun` at 38 digits, run through Sage 10.10 by
  `gen/lfun_reference.sage`. It covers fourteen curves: ranks 0 to 5, with and without CM, conductors 11
  to 22,329,098, at $|\operatorname{Im} s|$ up to 1000.
- `tests/an_reference.txt` holds Sage 10.10's `anlist`, from `gen/an_reference.sage`.

Anyone can run all three scripts again.
