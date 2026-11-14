# Provenance of sagebrush-primes

`sagebrush-primes` is written from published mathematics only. No code from PARI/GP, FLINT, Sage, mpmath,
Boost, GSL, Cephes, primecount or any other library is copied, translated or shared.

**The logarithmic integral (`src/li.rs`).** It uses these formulas:

- the series for $\mathrm{Ei}$: Abramowitz and Stegun, *Handbook of Mathematical Functions*, 5.1.10;
- the continued fraction for $E_1$: A&S 5.1.22, in the even form given in Press, Teukolsky, Vetterling and
  Flannery, *Numerical Recipes*, 3rd ed., section 6.3, evaluated by the modified Lentz method;
- the asymptotic expansion of $\mathrm{li}$: A&S 5.1.51.

The Chebyshev coefficients in `src/li_cheb.rs` are fitted by `gen/li_cheb.py`. It interpolates
$f(L) = L e^{-L}\mathrm{Ei}(L)$ at Chebyshev nodes, with values from mpmath 1.3.0 at 60 digits, and anyone can
run it again.

**Testing.** mpmath was run as an oracle: `tests/li_reference.txt` holds its values of $\mathrm{li}(x)$ at about
850 exact doubles, to 30 digits.
