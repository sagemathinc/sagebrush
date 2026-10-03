# Modular symbols of weight $k$ with character

`engine/modsym/src/general.rs` computes the spaces $\mathbb{M}_k(\Gamma_0(N),\varepsilon)^{\pm}$ of modular symbols for:

- any weight $k\ge 2$;
- any Dirichlet character $\varepsilon$ mod $N$;
- sign $+1$, $-1$ or $0$.

It also computes the Hecke operators $T_q$ on these spaces, and $U_q$ when $q\mid N$. Everything is computed over a prime field $\mathbb{F}_\ell$ with $\ell\equiv 1 \pmod{\operatorname{ord}\varepsilon}$, so the character takes values in $\mathbb{F}_\ell$. By default $\ell$ is the largest such prime below $2^{31}$.

## Method

Manin symbols are $[X^iY^{k-2-i},(c,d)]$ for $0\le i\le k-2$ and $(c:d)\in\mathbb{P}^1(\mathbb{Z}/N)$. Every relation and Hecke operator uses one right action:
$$[P,(u,v)]\cdot\begin{pmatrix}a&b\\c&d\end{pmatrix}=[P(aX+bY,\,cX+dY),\,(au+cv,\,bu+dv)].$$

The relations are:

| Relation | Formula | How it is handled |
|---|---|---|
| $S$ | $x+x\sigma=0$ with $\sigma=\left(\begin{smallmatrix}0&-1\\1&0\end{smallmatrix}\right)$ | Two-term: union-find whose edges carry weights in $\mathbb{F}_\ell^\times$ |
| Star, if the sign $s\ne0$ | $x=s\,x\eta$ with $\eta=\left(\begin{smallmatrix}-1&0\\0&1\end{smallmatrix}\right)$ | Same union-find |
| Character | $[P,(\lambda c,\lambda d)]=\varepsilon(\lambda)[P,(c,d)]$ | The normalizer in $\mathbb{P}^1$ now also returns the scalar $\lambda$ (`p1::normalize_with_scalar`) |
| Stabilizer | A symbol fixed by a unit $\lambda\equiv1 \pmod{\operatorname{lcm}(N/(u,N),N/(v,N))}$ with $\varepsilon(\lambda)\neq1$ is $0$ | Killed directly |
| $T$ | $x+x\tau+x\tau^2=0$ with $\tau=\left(\begin{smallmatrix}0&-1\\1&-1\end{smallmatrix}\right)$ | Sparse rows on the surviving generators, eliminated by the weight-2 `sparse_echelon` |

When the union-find meets an inconsistent cycle, the whole class is zero. This happens, for example, when $\varepsilon(-1)\ne(-1)^k$.

The Hecke operator $T_p$ is the sum of $x\cdot h$ over Merel's matrices $\left(\begin{smallmatrix}a&b\\c&d\end{smallmatrix}\right)$ with $ad-bc=p$, $a>b\ge0$ and $d>c\ge0$. For $p\mid N$, dropping the terms whose bottom row leaves $\mathbb{P}^1(\mathbb{Z}/N)$ gives $U_p$. The matrix is assembled exactly as in weight 2: parallel images, then the dual basis in blocks of 64 columns. Characteristic polynomials use the existing AVX2 `linalg::charpoly`.

## Validation against Sage 10.9

`examples/sage/general.sage` generates the reference data. It covers:

- $1\le N\le 40$ and $2\le k\le 6$ with $Nk\le160$;
- one character from every Galois orbit, with the right parity;
- signs $+1$, $-1$ and $0$.

For each space it records `ModularSymbols(eps, k, sign)`'s dimension and the characteristic polynomials of $T_2$, $T_3$ and $T_5$. These are $U_q$ when $q\mid N$. The coefficients are in $\mathbb{Q}(\zeta_m)$ and are mapped to $\mathbb{F}_\ell$ by $\zeta_m\mapsto\zeta_\ell^{e/m}$, where the character values are given as powers of a fixed $\zeta_e$. `examples/general_vs_sage.rs` then compares:

> **1452 spaces agree, 0 differ** (all dimensions and all 4,000+ charpolys).

The direction of the character relation matters. With $\varepsilon$ replaced by $\varepsilon^{-1}$ in the relation, 664 of the 1452 spaces disagree. So the comparison really tests the convention, which turns out to be Sage's.

`cargo test -p sagebrush-modsym` adds four tests that need no Sage:

- trivial character, weight 2, sign $+1$ matches the weight-2 engine (dimension and $T_q$ charpoly) for every $N<60$;
- $\mathbb{M}_{12}(1)^+$: $T_2$ has charpoly $(x+24)(x-2049)$, i.e. eigenvalues $\tau(2)$ and $1+2^{11}$;
- $T_2T_3=T_3T_2$ with a character of order 3 mod 13;
- Merel's matrices match a brute-force enumeration.

## Speed

`examples/general_time.rs` times one core (`RAYON_NUM_THREADS=1`) on an AMD EPYC 7B13. Sage runs on the same machine.

| $N$ | $k$ | sign | ord $\varepsilon$ | dim | Sage: space | Sage: $T_2$ + charpoly | ours: space | ours: $T_2$ + charpoly mod $\ell$ |
|---|---|---|---|---|---|---|---|---|
| 1009 | 2 | 1 | 1 | 84 | 52 ms | 22 ms | 1.2 ms | 3.1 ms |
| 50 | 12 | 1 | 1 | 85 | 1033 ms | 239 ms | 2.5 ms | 3.6 ms |
| 91 | 2 | 0 | 6 | 20 | 24 ms | 36 ms | 0.2 ms | 0.4 ms |
| 200 | 4 | 1 | 2 | 92 | 290 ms | 86 ms | 1.7 ms | 3.4 ms |
| 131 | 3 | 1 | 2 | 22 | 23 ms | 1.9 ms | 0.3 ms | 0.5 ms |
| 61 | 6 | 0 | 10 | 54 | 14,412 ms | 1,102 ms | 0.4 ms | 1.8 ms |
| 400 | 4 | 1 | 4 | 182 | 8,384 ms | 14,849 ms | 4.0 ms | 12 ms |
| 151 | 2 | 1 | 15 | 14 | 27 ms | 21 ms | 0.2 ms | 0.3 ms |

The "ours: space" column is after the $\tau$-orbit change described in `general-exact.md`. It made $N=50$, $k=12$ 12× faster to build, from 30 ms to 2.5 ms.

The comparison is not like-for-like. Sage computes over $\mathbb{Q}(\zeta_m)$ exactly, while these timings are for a single prime $\ell$. Still, building the space is 30–5000× faster. Sage's cost is dominated by linear algebra over cyclotomic fields, and that also bounds its Hecke operators. Our cost per prime is unchanged from weight 2.

## Not done yet

- **Exact results.** Now done; see `general-exact.md`.
- **Cuspidal and new subspaces** for $k>2$ or $\varepsilon\ne1$. They need the boundary map with character (Stein, *Modular Forms: A Computational Approach*, §8.4) and degeneracy maps; newform orbits are then as in weight 2.
- Python, WASM and CLI bindings.
