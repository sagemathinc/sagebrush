# The Sagebrush Atlas (sagebrush.space/atlas)

An LMFDB-style site for Galois orbits of newforms, the browser front of
[the atlas](../../design/lmfdb-for-agents.md). It stores weight 2 with level N ≤ 1000
and weights 4–12 with Nk² ≤ 4000 (trivial character): 1,490 newspaces and
7,961 orbits, computed and proven by the modular symbols engine. All
5,951 weight-2 orbits agree with the LMFDB in label, dimension and tr a_p for
p < 1000. Any other space is computed in the browser by the same engine
(WebAssembly), and any stored space can be recomputed there and compared.

| file | |
|---|---|
| `model.ts` | the data model (a newspace is the engine's `dims` + `newforms` replies), labels, derived invariants (Atkin–Lehner signs, sign, CM, quadratic fields) and the comparison of a recomputed space with a stored one |
| `render.ts`, `pages.ts` | HTML for every page, math typeset by KaTeX, used by the Worker for stored spaces (and kept in the edge cache) and by the browser for computed ones |
| `plot.ts` | the Sato–Tate histogram and the cost of `aplist` |
| `fit-cost.py` | fits the cost model (below) |
| `server.ts` | the routes: pages, `.json`, search, label jumps; used by `web/site/src/index.ts` (the Worker) and `serve.mjs` |
| `client.ts` → `atlas.js` | in the page: computing on demand, Recompute, Sato–Tate to 10⁶, WebMCP tools |
| `engine-worker.ts` → `atlas-engine.js` | a Web Worker running `/sagebrush-engine.wasm` |
| `llms.txt` | URLs and data formats, for agents |

## Building the data

The data (about 50 MB of JSON) is not in git; it is rebuilt from the engine:

```sh
cd engine
cargo run --release -p sagebrush-web --example atlas -- 1-1000:2,1-250:4,1-111:6,1-62:8,1-40:10,1-27:12 1000 16 > ~/data/atlas-web/spaces.jsonl
cd ..
node scripts/build-atlas.mjs ~/data/atlas-web/spaces.jsonl ~/data/atlas-web/lmfdb_wt2_le1000.json ~/data/atlas-web/timing/cost-model.json   # -> web/dist/atlas/data
node scripts/build-cli.mjs && bun web/build.ts                                                        # copies it to web/site/public
```

The first step takes about 9 CPU-minutes (70 s on 8 threads). The
optional second argument of `build-atlas.mjs` is the LMFDB slice (`{lmfdb:
{label: [dim, trace_ap]}, iso: {label: class}}`, from `atlas/`'s M0 tables)
to compare with; the build fails if a Cremona curve has no matching newform.

## Testing

```sh
node web/atlas/serve.mjs &              # http://localhost:8766/atlas/, like the Worker
node web/atlas/test-atlas.mjs           # headless Chromium; SB_URL=https://sagebrush.space for production
```

## The cost model

Before computing a space the engine predicts its time and peak memory in
WebAssembly (`estimate_newforms`, `engine/modsym/src/estimate.rs`; in Sage
mode `sagebrush.mf.estimate(N, k, bound)`, in the page the WebMCP tool
`atlas_estimate`). It costs microseconds: it computes the levels M | N and
their dimensions, the number of CRT primes for the characteristic polynomial
and for the traces (the computation's own bounds), and the Heilbronn matrices
for T_p, p ≤ B, and adds one term per stage with constants fitted to
measurements. The site shows the prediction before computing, on the
Recompute button, and asks before anything over two minutes; /atlas/about
plots predicted against measured.

To refit (after changing the engine):

```sh
T=~/data/atlas-web/timing
cd engine && cargo build --release -p sagebrush-web --example atlas
# predictions' terms, for the stored spaces and the other sets (valid: larger levels and weights; bounds: B = 100, 300, 3000)
ATLAS_ESTIMATE=1 ./target/release/examples/atlas 1-1000:2,1-250:4,1-111:6,1-62:8,1-40:10,1-27:12 1000 8 > $T/est-stored.jsonl
# measurements: a fresh WebAssembly instance per space (wasm-measure.mjs), likewise -> $T/wasm-{stored,valid,bounds}.jsonl
python3 web/atlas/fit-cost.py $T --write    # prints the accuracy, writes the constants into estimate.rs
node scripts/build-engine.mjs
```

On 2026-10-05: stored spaces 93% within a factor 2 of the prediction (69%
within 1.5); 34 larger spaces (levels 1000–6000, weights to 36) kept out of
the fit 85% (68%). The misses are the search for T at highly composite
levels: at 3105 every operator built from 12 or fewer primes repeats an
eigenvalue, so each CRT prime computes 16 Hecke matrices at 16 levels
(486 s against 31 predicted). Natively that is 129 s: 41 s of CRT and 80 s
factoring the degree-116 characteristic polynomial. Trying the large
random-coefficient operators on 8 primes first was measured and is slower
(over 4 minutes): large coefficients mean more CRT primes and a harder
factorization. The fixes are a faster factorization and fewer Hecke
operators per prime. Peak memory is within a
factor 2 for 97% (at most a few MB for stored spaces). `aplist` for p < X costs 0.008 + 3.2e-8 X log X seconds for every
curve (within 3% for X ≥ 10^5) and about 12 bytes per unit of X.

Building the model found two engine bottlenecks, now fixed: Dirichlet
conductors were computed by scanning every unit (O(N^2) per level, twice per
space), and the traces generated Merel's Heilbronn matrices, O(p^2 log p)
each, and kept all of them (67 MB for B = 1000); Cremona's, O(p log p), are
used for p not dividing N. The stored spaces now take 547 s instead of 2870,
bit-identical.
