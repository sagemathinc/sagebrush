# Exact Hecke charpolys over $\mathbb{Z}[\zeta_m]$, weight $k$ with character

`engine/modsym/src/general_exact.rs` computes the characteristic polynomial of $T_q$ (or $U_q$ when $q\mid N$) on $\mathbb{M}_k(\Gamma_0(N),\varepsilon)^{\pm}$ exactly:

```rust
general_exact::exact_charpoly(n, k, &eps, sign, q) -> Result<ExactGeneral, String>
```

The coefficients lie in $\mathbb{Z}[\zeta_m]$ with $m=\operatorname{ord}\varepsilon$. `coeffs[j][i]` is the coefficient of $\zeta_m^i$ in the coefficient of $x^j$. This is the power basis of Sage's `CyclotomicField(m)`, so it agrees with Sage digit for digit.

## Validation

`examples/sage/general_exact.sage` generates Sage's exact charpolys and `examples/general_exact_vs_sage.rs` compares them.

- **Grid: 1830 of 1830 agree.** It covers $N\le30$, $2\le k\le6$ with $Nk\le120$, one character from every Galois orbit, signs $+1$/$-1$/$0$, and $q\in\{2,3\}$, so it includes $U_2$ and $U_3$.
- **Larger cases: 9 of 9 agree.** One core, AMD EPYC 7B13:

| $N$ | $k$ | sign | ord $\varepsilon$ | $q$ | dim | largest coefficient | bound | primes × embeddings | Sage | ours |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 24 | 1 | 1 | 2 | 3 | 48 bits | 50 bits | 2 × 1 | 0.03 s | 0.001 s |
| 50 | 12 | 1 | 1 | 3 | 85 | 785 bits | 920 bits | 30 × 1 | 1.29 s | 0.118 s |
| 91 | 2 | 0 | 6 | 2 | 20 | 18 bits | 40 bits | 2 × 2 | 0.06 s | 0.001 s |
| 200 | 4 | 1 | 2 | 3 | 92 | 214 bits | 359 bits | 12 × 1 | 0.42 s | 0.035 s |
| 131 | 3 | 1 | 2 | 2 | 22 | 25 bits | 56 bits | 2 × 1 | 0.02 s | 0.002 s |
| 61 | 6 | 0 | 10 | 2 | 54 | 135 bits | 203 bits | 7 × 4 | 15.0 s | 0.021 s |
| 151 | 2 | 1 | 15 | 2 | 14 | 11 bits | 30 bits | 1 × 8 | 0.06 s | 0.001 s |
| 105 | 2 | 1 | 12 | 2 | 16 | 14 bits | 32 bits | 2 × 4 | 0.03 s | 0.003 s |
| 37 | 10 | 1 | 9 | 2 | 29 | 135 bits | 169 bits | 6 × 6 | 41.5 s | 0.024 s |

Here "bound" is the proven coefficient bound that decides how many primes are used. Sage computes `ModularSymbols(eps,k,sign).hecke_matrix(q).charpoly()`, including building the space.

## The choices, and why

### 1. All $\varphi(m)$ embeddings at each prime, not one embedding at each of many primes

At a prime $\ell\equiv1 \pmod m$ there are $\varphi(m)$ ring maps $\mathbb{Z}[\zeta_m]\to\mathbb{F}_\ell$, given by $\zeta_m\mapsto z^j$ for units $j$. Computing under map $j$ is the same as computing with the Galois-conjugate character $\varepsilon^j$. With all of them, a Vandermonde solve modulo $\ell$ recovers every power-basis coordinate mod $\ell$. The CRT then lifts plain integers, exactly as in weight 2.

The alternative is one embedding per prime, i.e. one degree-1 prime $\mathfrak{l}$ at a time. It needs the same number of charpolys for the same number of bits: the norm of $\prod\mathfrak{l}_i$ has to reach $B^{\varphi(m)}$. On top of that, the lift is then a lattice-reduction (LLL) problem in dimension $\varphi(m)$, with slack. So there is no gain, only extra complexity.

A prime is accepted only if all $\varphi(m)$ conjugates give the same dimension.

### 2. A proven bound in the right basis

Every eigenvalue of $T_q$ is either:
- Eisenstein, with $|\lambda|\le1+q^{k-1}$; there are at most $\#$cusps of $\Gamma_0(N)$ of these;
- or cuspidal, with $|\lambda|\le2q^{(k-1)/2}$ (Deligne).

The same holds for $U_q$ when $q\mid N$. So each complex embedding of the coefficient of $x^{d-j}$ is bounded by the coefficient $A_j$ of
$$(1+(1+q^{k-1})x)^{n_E}\,(1+\lceil 2q^{(k-1)/2}\rceil x)^{d-n_E}.$$
This is computed exactly with `BigUint`. Because $1+q^{k-1}\ge2q^{(k-1)/2}$ by AM-GM, everything stays an integer.

Turning embedding bounds into coordinate bounds is where the basis matters. In the **powerful basis**, the tensor product of the power bases of $\mathbb{Z}[\zeta_{p^r}]$ over $p^r\,\|\,m$, the trace-form Gram matrix is a Kronecker product of blocks $p^{r-1}(pI-J)$. Its inverse has diagonal $\prod_{p^r\|m} 2/p^r$. Cauchy–Schwarz then gives
$$a_t^2\le(G^{-1})_{tt}\sum_\sigma|\sigma(a)|^2\le\prod_{p\mid m}2(1-\tfrac1p)\,A^2\le 2^{\#\{\text{odd }p\mid m\}}A^2 .$$
The power basis can be badly conditioned when $m$ has several odd primes; $\Phi_{105}$ has a coefficient $-2$, for example. So the code computes the exact integer row-sum norm $\|C\|$ of the powerful-to-power change of basis and requires
$$L^2>4\,\|C\|^2\,2^{\omega_{\rm odd}(m)}\,\max_j A_j^2,$$
compared exactly as integers, where $L$ is the product of the primes used. No floating point is involved.

The bound runs 2–145 bits above the true size in the table. The worst cases are $N=200$, $k=4$ (145 bits) and $N=50$, $k=12$ (135 bits), which cost about 5 and 4 extra primes. A sum-of-squares refinement like the weight-2 one would recover most of that.

### 3. Dimension: certified by formula

$\dim_{\mathbb{F}_\ell}\ge\dim_{\mathbb{Q}(\zeta_m)}$, with equality for all but finitely many $\ell$. When they are equal, the localized presentation module has no $\mathfrak{l}$-torsion. The $\mathbb{F}_\ell$ charpoly is then the reduction of the true one, since $\ell$ is odd and the sign projection is defined integrally. So everything rests on knowing the true dimension.

`dims.rs` supplies it without using modular symbols:

- **Cusp forms.** $\dim S_k(N,\varepsilon)$ by Cohen–Oesterlé. The two character sums over $x^2+1\equiv0$ and $x^2+x+1\equiv0 \pmod N$ are computed in floating point; the result must be within $10^{-6}$ of a nonnegative integer, or the code panics.
- **Eisenstein series.** $\dim E_k(N,\varepsilon)$ is the number of $\varepsilon$-regular cusps, minus 1 when $k=2$ and $\varepsilon=1$. A cusp with denominator $c\mid N$ is fixed by $\gamma\in\Gamma_0(N)$ with $d\equiv1 \pmod{N/\gcd(c,N/c)}$. On the boundary symbols at that cusp, the stabilizer acts unipotently twisted by $\varepsilon(d)$, so the cusp contributes one dimension exactly when $\operatorname{cond}(\varepsilon)\mid N/\gcd(c,N/c)$. The count factors over the primes dividing $N$.
- **Sign 0.** $\dim\mathbb{M}_k=2\dim S_k+\dim E_k$, by Eichler–Shimura.
- **Sign $\pm1$.** No formula for the split is needed. $\mathbb{M}=\mathbb{M}^+\oplus\mathbb{M}^-$ and each $\mathbb{F}_\ell$-dimension can only be too large. So at the first prime where $\dim_\ell\mathbb{M}^\pm+\dim_\ell\mathbb{M}^\mp$ equals the sign-0 formula, both are certified. That costs one extra space construction at one prime.

Every later prime and conjugate must hit the certified dimension exactly; anything else is rejected. Results now carry `status: "proven"` and say in `checks` how the dimension was certified.

Validation (`examples/dims_vs_sage.rs`, with reference data from `examples/sage/dims.sage`):

- **Against Sage's formulas.** Conductor, $\dim S_k$ and $\dim E_k$ agree with Sage's `CuspForms`/`EisensteinForms` on **7931 of 7931** pairs. These are $N\le150$, $2\le k\le12$ with $Nk\le1200$, one character from every Galois orbit, with the right parity.
- **Against our own presentations.** $2S+E$ agrees with the mod-$\ell$ presentations on **4898 of 4898** spaces ($Nk\le600$), both for sign 0 and as $\dim\mathbb{M}^++\dim\mathbb{M}^-$. This is the independent check: the presentation and the formulas share no code.
- **Unit tests.** $\dim S_2(N)=$ genus of $X_0(N)$ for all $N<300$, and $\dim S_k(1)$ for $k\le26$.
- **End to end.** All 1839 exact charpolys compared with Sage now come out `proven` and identical.

### 4. Rust-specific choices

- **Modulus size.** $\ell<2^{31}$, so products fit in `u64` and the hot loop uses `a * b % p` instead of `u128`. `new_mod` rejects $\ell\ge2^{31}$, because otherwise the `u64` product could silently wrap in a release build; Rust only panics on integer overflow in debug builds. The AVX2 charpoly kernel needs the same bound.
- **CRT in the mixed radix (Garner).** Digits are computed in `u64`, and there is one Horner pass in `BigUint` per coordinate, run in parallel over coordinates. `num-bigint` (MIT) is much slower than GMP or FLINT. Garner keeps the big-integer work to $O(r)$ word-by-bigint steps per coordinate. FLINT's `fmpz_multi_CRT` would be faster but is LGPL, so it stays out of the MIT core.
- **Exact bounds.** `BigUint` for the bound and `i128` for $\Phi_m$ and $\|C\|$. A float `log2` like weight 2's `bound_bits` would be fine in practice, but an integer comparison removes the question.
- **Determinism.** Results do not depend on the thread count. Primes are taken in a fixed descending order of $\ell\equiv1 \pmod m$, there are no `HashMap`s (Rust randomizes their iteration order per process), and `par::map_slice` preserves order.
- **Memory.** A batch is at most 8 primes, run in parallel together with all their conjugates. Each job holds one `GeneralSpace` and drops it after its charpoly, so peak memory is about the number of threads times one space, not $8\varphi(m)$ spaces.
- **No panics on bad input.** A non-prime $q$, an inconsistent character, or running out of primes all return `Err`, so batch jobs keep going. The same policy applies everywhere else in the engine, and it is what makes this usable from WASM and Python.

### 5. A free speedup found on the way: one $\tau$-orbit representative

Profiling showed space construction dominating at high weight: 32 ms of 37 ms at $N=50$, $k=12$, mostly fill-in while eliminating redundant 3-term rows. Since $\tau^3=1$, the relations at $g$, $g\tau$ and $g\tau^2$ span the same space over all $P$. So rows are generated only at one point per $\tau$-orbit of $\mathbb{P}^1(\mathbb{Z}/N)$. That gives 3× fewer rows and a 12× faster build, from 32 ms to 2.6 ms. The exact $N=50$, $k=12$ case went from 0.91 s to 0.12 s. All 3282 Sage comparisons still agree.

## Next

1. **Reuse across primes.** The union-find graph and the $\tau$-orbits do not depend on $\ell$, and generically neither does the elimination pattern; only the weights do. Building them once would cut the per-prime cost again.
2. **Cuspidal and new subspaces** and newform orbits for $k>2$ or $\varepsilon\ne1$, then the atlas.
