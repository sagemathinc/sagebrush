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
| `render.ts`, `pages.ts` | HTML for every page, used by the Worker for stored spaces and by the browser for computed ones |
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
node scripts/build-atlas.mjs ~/data/atlas-web/spaces.jsonl ~/data/atlas-web/lmfdb_wt2_le1000.json   # -> web/dist/atlas/data
node scripts/build-cli.mjs && bun web/build.ts                                                        # copies it to web/site/public
```

The first step takes about 47 CPU-minutes (3 minutes on 16 threads). The
optional second argument of `build-atlas.mjs` is the LMFDB slice (`{lmfdb:
{label: [dim, trace_ap]}, iso: {label: class}}`, from `atlas/`'s M0 tables)
to compare with; the build fails if a Cremona curve has no matching newform.

## Testing

```sh
node web/atlas/serve.mjs &              # http://localhost:8766/atlas/, like the Worker
node web/atlas/test-atlas.mjs           # headless Chromium; SB_URL=https://sagebrush.space for production
```
