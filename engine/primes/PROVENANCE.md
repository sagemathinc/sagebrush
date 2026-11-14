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

**The prime sieve (`src/sieve.rs`).** A segmented sieve of Eratosthenes over the odd numbers, as in
Bays and Hudson, "The segmented sieve of Eratosthenes and primes in arithmetic progressions to $10^{12}$",
*BIT* 17 (1977).

**The prime counting function (`src/prime_pi.rs`).** It uses the combinatorial method of Lagarias, Miller and
Odlyzko, "Computing $\pi(x)$: the Meissel-Lehmer method", *Math. Comp.* 44 (1985), with
$\pi(x) = \varphi(x, a) + a - 1 - P_2(x, a)$ and the special leaves found with a segmented sieve and a binary
indexed tree, as in Deléglise and Rivat, "Computing $\pi(x)$: the Meissel, Lehmer, Lagarias, Miller, Odlyzko
method", *Math. Comp.* 65 (1996). The tree over 64-bit words follows Oliveira e Silva, "Computing $\pi(x)$:
the combinatorial method", *Revista do DETUA* 4 (2006). The tuning ($y = \alpha x^{1/3}$ with
$\alpha = (\log_{10} x)^2 / 24$) is ours, set by timing.

**The zeros of zeta (`src/zeta.rs`).** It uses:
- $\theta(t)$ from Stirling's series for $\log\Gamma$ (Abramowitz and Stegun 6.1.40–6.1.41);
- $Z(t)$ by Euler–Maclaurin summation below $t = 2000$ (Edwards, *Riemann's Zeta Function*, 1974, section 6.4), and by the Riemann–Siegel formula with the corrections $C_0, \dots, C_4$ above (Edwards, chapter 7; Gabcke, Göttingen 1979);
- the zeros found by Gram blocks under Rosser's rule (Rosser, Yohe and Schoenfeld, 1969), which holds below Gram point 13,999,525 (Brent, van de Lune, te Riele and Winter, *Math. Comp.* 39, 1982).

The Chebyshev coefficients in `src/zeta_rs_cheb.rs` are fitted by `gen/zeta_rs_cheb.py`. It interpolates $C_0, \dots, C_4$, written in terms of the derivatives of $\Psi(p) = \cos(2\pi(p^2 - p - 1/16)) / \cos(2\pi p)$, with values from mpmath 1.3.0 at 100 digits, and anyone can run it again. `tests/zeta_reference.txt` holds mpmath's `zetazero(n)` for 426 values of $n$ up to $10^7$ (`gen/zeta_reference.py`).

**Testing.** `tests/prime_pi.rs` checks $\pi(10^k)$ for $k \le 16$ against OEIS A006880 (the values up to
$10^{13}$ in every run, the rest with `--ignored`) and checks $\pi(x)$ at other $x$ against a direct count of
the sieve's primes.

mpmath was run as an oracle: `tests/li_reference.txt` holds its values of $\mathrm{li}(x)$ at about
850 exact doubles, to 30 digits.
