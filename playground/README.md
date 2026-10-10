# Playground: trying the engine interactively

There are three ways in. All of them were checked on 2026-10-04.

## 1. Sage plus Sagebrush in one session (best for comparing)

Open a terminal in CoCalc (for example, create `~/sagebrush/play.term`), then run:

```sh
sage
```

```python
sage: load('~/sagebrush/playground/sage_bridge.py')   # imports sagebrush.mf and defines chi(eps)
sage: G = DirichletGroup(13); eps = G.galois_orbits()[2][0]; eps.order()
6
sage: mf.dims(13, 2, chi=chi(eps))
{'order': 6, 'conductor': 13, 'cusp': 1, 'eisenstein': 2, 'modsym': 4, 'new': 1}
sage: mf.charpoly(13, 2, 2, chi=chi(eps))        # exact over Z[zeta_6]; coeffs[j][i] = coeff of zeta^i in x^j
sage: ModularSymbols(eps, 2, 0).hecke_polynomial(2)   # Sage, for comparison
sage: r = mf.newforms(37, 4, bound=8)           # orbits + trace forms, LMFDB order
sage: [f['traces'] for f in r['newforms']]
[[4, -6, -11, 6, -29, -27, -32, -90], [5, 4, 13, 18, 11, 9, 24, 30]]
sage: [[t.trace() for t in f.q_expansion(9).list()[1:]] for f in Newforms(37, 4, names='a')]
[[4, -6, -11, 6, -29, -27, -32, -90], [5, 4, 13, 18, 11, 9, 24, 30]]
```

This works because Sage and the engine's virtualenv run the same Python (3.14). The bridge only adds the venv's site-packages to `sys.path`. The same `load(...)` line also works in a Sage worksheet or Jupyter notebook with the SageMath kernel.

A quick sweep against Sage:

```python
sage: for e in [o[0] for o in DirichletGroup(45).galois_orbits() if o[0](-1) == 1]:
....:     print(e.order(), sorted(mf.newspace(45, 2, chi=chi(e))['orbit_dims']),
....:           sorted(f.hecke_eigenvalue_field().absolute_degree() for f in Newforms(e, 2, names='a')))
```

## 2. Plain Python or IPython (no Sage)

```sh
cd ~/sagebrush/engine && .venv/bin/ipython
```

```python
from sagebrush import mf, modsym, ap
mf.characters(13)                       # Galois-orbit representatives, each with a ready-made 'chi'
mf.newforms(227, 2, chi=[c for c in mf.characters(227) if c['order'] == 113][0]['chi'], bound=20)  # 227.2.c, dim 2016
mf.charpoly(1, 24, 2, sign=1)           # T_2 on M_24(1)^+, exact
c = [c for c in mf.characters(400) if c['order'] == 4 and c['even']][0]
mf.charpoly_mod(400, 4, 3, chi=c['chi'])    # one prime, any size
modsym.charpoly_exact(389, 2)           # the weight-2 engine
ap.aplist([0, 0, 1, -1, 0], 100)        # a_p of 37a
```

Characters are given as `chi=(order, gens, vals)`, meaning $\chi(\text{gens}_i)=\zeta_{\text{order}}^{\text{vals}_i}$. That is LMFDB's `char_values` without the leading $N$; `chi=None` is the trivial character. Every function takes `threads=` (0 means all cores) and releases the GIL. `help(mf)` and `help(mf.newforms)` document the rest.

For notebooks there is also a Jupyter kernel, **"Python (sagebrush)"**, for that venv (no Sage).

## 3. Rust directly

`engine/modsym/examples/scratch.rs` is a small program to edit:

```sh
cd ~/sagebrush/engine
CARGO_TARGET_DIR=/tmp/engtarget cargo run --release --example scratch
```

The full validation runs are also examples:

| Command (in `~/sagebrush/engine`, with `CARGO_TARGET_DIR=/tmp/engtarget cargo run --release --example ...`) | What it checks |
|---|---|
| `general_vs_sage` | dimensions and $T_q$ charpolys mod $\ell$ vs Sage (1452 spaces) |
| `general_exact_vs_sage -- ~/data/sage/general_exact_big.jsonl --table` | exact charpolys vs Sage, with timings |
| `dims_vs_sage -- ~/data/sage/dims_ref.jsonl` | Cohen–Oesterlé and Eisenstein dimension formulas |
| `newspaces_vs_lmfdb -- 200 63.2.e 238.2.b` (with `-p sagebrush-oracle`: it factors with FLINT) | orbit dimensions vs LMFDB; omit the labels to run all |
| `traces_vs_lmfdb -- 1000 200 28.2.e 210.2.a` (`-p sagebrush-oracle`) | trace forms and labels vs LMFDB |

Environment variables `NEWSPACE_DEBUG=1` and `TRACES_DEBUG=1` print the choice of Hecke operator and the reason a prime $\ell$ was rejected.

## Code tour

Links are to commit [`4fa6559`](https://github.com/sagemathinc/sagebrush/tree/4fa6559266fc5b5c715b27653b3c7cbb31bd70bf/engine/modsym/src). The new code since weight 2 is about 2400 lines in `engine/modsym/src/`.

**Modular symbols with weight and character** (`general.rs`)
- [The convention constant `CONV`](https://github.com/sagemathinc/sagebrush/blob/4fa6559266fc5b5c715b27653b3c7cbb31bd70bf/engine/modsym/src/general.rs#L27-L30): $[P,(\lambda c,\lambda d)]=\varepsilon(\lambda)[P,(c,d)]$, fixed by the Sage comparison.
- [`p1::normalize_with_scalar`](https://github.com/sagemathinc/sagebrush/blob/4fa6559266fc5b5c715b27653b3c7cbb31bd70bf/engine/modsym/src/p1.rs#L62): Sage's $\mathbb{P}^1(\mathbb{Z}/N)$ normalization, also returning the unit $\lambda$.
- [`transform`](https://github.com/sagemathinc/sagebrush/blob/4fa6559266fc5b5c715b27653b3c7cbb31bd70bf/engine/modsym/src/general.rs#L158): $X^iY^{k-2-i}\mapsto(aX+bY)^i(cX+dY)^{k-2-i}$ modulo $\ell$.
- [`heilbronn_merel`](https://github.com/sagemathinc/sagebrush/blob/4fa6559266fc5b5c715b27653b3c7cbb31bd70bf/engine/modsym/src/general.rs#L190): Merel's matrices, enumerated as in Sage.
- [`GeneralSpace::new_mod`](https://github.com/sagemathinc/sagebrush/blob/4fa6559266fc5b5c715b27653b3c7cbb31bd70bf/engine/modsym/src/general.rs#L263), the heart of it:
  - [stabilizer kills](https://github.com/sagemathinc/sagebrush/blob/4fa6559266fc5b5c715b27653b3c7cbb31bd70bf/engine/modsym/src/general.rs#L287-L305);
  - the [weighted union-find](https://github.com/sagemathinc/sagebrush/blob/4fa6559266fc5b5c715b27653b3c7cbb31bd70bf/engine/modsym/src/general.rs#L311-L327), whose edges carry $\mathbb{F}_\ell^\times$ weights; an inconsistent cycle kills its class;
  - [$S$ and star relations](https://github.com/sagemathinc/sagebrush/blob/4fa6559266fc5b5c715b27653b3c7cbb31bd70bf/engine/modsym/src/general.rs#L335-L359);
  - the [$\tau$-orbit trick](https://github.com/sagemathinc/sagebrush/blob/4fa6559266fc5b5c715b27653b3c7cbb31bd70bf/engine/modsym/src/general.rs#L389-L405), one 3-term row per $\tau$-orbit, which made the build 12× faster;
  - [sparse elimination](https://github.com/sagemathinc/sagebrush/blob/4fa6559266fc5b5c715b27653b3c7cbb31bd70bf/engine/modsym/src/general.rs#L433).
- [`hecke_image`](https://github.com/sagemathinc/sagebrush/blob/4fa6559266fc5b5c715b27653b3c7cbb31bd70bf/engine/modsym/src/general.rs#L458): $T_p$ of one Manin symbol. Terms leaving $\mathbb{P}^1(\mathbb{Z}/N)$ are dropped, which gives $U_p$ when $p\mid N$.

**Exact charpolys over $\mathbb{Z}[\zeta_m]$** (`general_exact.rs`)
- [`powerful_to_power_norm`](https://github.com/sagemathinc/sagebrush/blob/4fa6559266fc5b5c715b27653b3c7cbb31bd70bf/engine/modsym/src/general_exact.rs#L114) and [`embedding_bounds`](https://github.com/sagemathinc/sagebrush/blob/4fa6559266fc5b5c715b27653b3c7cbb31bd70bf/engine/modsym/src/general_exact.rs#L171): the proven coefficient bound via the powerful basis. Worth a careful look; see `results/general-exact.md` §2.
- [`exact_charpoly`](https://github.com/sagemathinc/sagebrush/blob/4fa6559266fc5b5c715b27653b3c7cbb31bd70bf/engine/modsym/src/general_exact.rs#L185): all $\varphi(m)$ embeddings per prime, a Vandermonde solve, and [the sign-$\pm1$ dimension certificate](https://github.com/sagemathinc/sagebrush/blob/4fa6559266fc5b5c715b27653b3c7cbb31bd70bf/engine/modsym/src/general_exact.rs#L249).
- [`crt`](https://github.com/sagemathinc/sagebrush/blob/4fa6559266fc5b5c715b27653b3c7cbb31bd70bf/engine/modsym/src/general_exact.rs#L302): Garner, with `u64` digits and one BigUint pass per coordinate.

**Dimensions and characters**
- [`dim_cusp_forms`](https://github.com/sagemathinc/sagebrush/blob/4fa6559266fc5b5c715b27653b3c7cbb31bd70bf/engine/modsym/src/dims.rs#L47) (Cohen–Oesterlé) and [`dim_eisenstein`](https://github.com/sagemathinc/sagebrush/blob/4fa6559266fc5b5c715b27653b3c7cbb31bd70bf/engine/modsym/src/dims.rs#L77) (regular cusps, with the one-line derivation in the comment).
- [`DirichletGroup::new`](https://github.com/sagemathinc/sagebrush/blob/4fa6559266fc5b5c715b27653b3c7cbb31bd70bf/engine/modsym/src/dirichlet.rs#L30) and [`Character::from_generators`](https://github.com/sagemathinc/sagebrush/blob/4fa6559266fc5b5c715b27653b3c7cbb31bd70bf/engine/modsym/src/dirichlet.rs#L146), which reads LMFDB's `char_values`.

**Newform orbits** (`newspace.rs`)
- [`eisenstein_series`](https://github.com/sagemathinc/sagebrush/blob/4fa6559266fc5b5c715b27653b3c7cbb31bd70bf/engine/modsym/src/newspace.rs#L147): all $E_k^{\psi,\varphi,t}$, with the count checked against `dim_eisenstein`.
- [`new_poly_mod`](https://github.com/sagemathinc/sagebrush/blob/4fa6559266fc5b5c715b27653b3c7cbb31bd70bf/engine/modsym/src/newspace.rs#L202): charpoly, then [saturating away Eisenstein roots](https://github.com/sagemathinc/sagebrush/blob/4fa6559266fc5b5c715b27653b3c7cbb31bd70bf/engine/modsym/src/newspace.rs#L226), then old forms divided out, then the [new/old separation test](https://github.com/sagemathinc/sagebrush/blob/4fa6559266fc5b5c715b27653b3c7cbb31bd70bf/engine/modsym/src/newspace.rs#L254).
- [`hecke_primes`](https://github.com/sagemathinc/sagebrush/blob/4fa6559266fc5b5c715b27653b3c7cbb31bd70bf/engine/modsym/src/newspace.rs#L260) and [the escalating choice of $T$](https://github.com/sagemathinc/sagebrush/blob/4fa6559266fc5b5c715b27653b3c7cbb31bd70bf/engine/modsym/src/newspace.rs#L329) (CM forms and inner twists).
- [`newspace_orbits`](https://github.com/sagemathinc/sagebrush/blob/4fa6559266fc5b5c715b27653b3c7cbb31bd70bf/engine/modsym/src/newspace.rs#L299): [the $\mathbb{M}^+$ dimension certificate](https://github.com/sagemathinc/sagebrush/blob/4fa6559266fc5b5c715b27653b3c7cbb31bd70bf/engine/modsym/src/newspace.rs#L347), [Deligne bound](https://github.com/sagemathinc/sagebrush/blob/4fa6559266fc5b5c715b27653b3c7cbb31bd70bf/engine/modsym/src/newspace.rs#L412), CRT, then [factor over Q](https://github.com/sagemathinc/sagebrush/blob/4fa6559266fc5b5c715b27653b3c7cbb31bd70bf/engine/modsym/src/newspace.rs#L435).

**Trace forms** (`traces.rs`)
- [`traces_mod`](https://github.com/sagemathinc/sagebrush/blob/4fa6559266fc5b5c715b27653b3c7cbb31bd70bf/engine/modsym/src/traces.rs#L107), including [the Hankel Gram matrix](https://github.com/sagemathinc/sagebrush/blob/4fa6559266fc5b5c715b27653b3c7cbb31bd70bf/engine/modsym/src/traces.rs#L147) that picks the one Manin symbol, [all primes in parallel from that symbol's Heilbronn images](https://github.com/sagemathinc/sagebrush/blob/4fa6559266fc5b5c715b27653b3c7cbb31bd70bf/engine/modsym/src/traces.rs#L203), [the Hecke recursion modulo $u_j$](https://github.com/sagemathinc/sagebrush/blob/4fa6559266fc5b5c715b27653b3c7cbb31bd70bf/engine/modsym/src/traces.rs#L231), and [power sums](https://github.com/sagemathinc/sagebrush/blob/4fa6559266fc5b5c715b27653b3c7cbb31bd70bf/engine/modsym/src/traces.rs#L79).

**Python bindings:** [`engine/py/src/lib.rs`](https://github.com/sagemathinc/sagebrush/blob/main/engine/py/src/lib.rs) (pyo3) and [`engine/py/python/sagebrush/mf.py`](https://github.com/sagemathinc/sagebrush/blob/main/engine/py/python/sagebrush/mf.py). Factoring in `mf.newspace` goes through python-flint, passed in as a callback, so the extension itself stays MIT.

The write-ups that explain the mathematics: `results/general.md`, `results/general-exact.md`, `results/newspaces.md`.
