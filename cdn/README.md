# Single-file ES modules for browsers and chat artifacts

Published to npm as **`sagebrush-web`** and served by jsdelivr (`/npm/` is
the only jsdelivr path Claude's artifact sandbox allows; `/gh/<repo>@<commit>/cdn/`
also works elsewhere):

```js
const sb = await import("https://cdn.jsdelivr.net/npm/sagebrush-web@0.3/sagebrush-engine.mjs");
const py = await import("https://cdn.jsdelivr.net/npm/sagebrush-web@0.3/pyparse.mjs");
sb.charpoly({ n: 1, k: 12, q: 2, sign: 1 });   // proven, over Z[zeta_m]
py.parse("x = [1, 2 3]\n");                     // throws CPython's SyntaxError
```

| File | Raw | Gzipped (as served) | What |
|---|---|---|---|
| `sagebrush-engine.mjs` | 2.0 MB | 1.5 MB | the Rust engines (`engine/web`, wasm32), gzipped and inlined as base64 (decompressed with `DecompressionStream`): the same `wasm/sagebrush-engine.wasm` as the notebook and CLI |
| `pyparse.mjs` | 217 KB | 33 KB | CPython 3.14's parser (`pyparse/`) |

Why this shape: in the October 2026 smoke test, Claude's artifact sandbox
blocked `fetch()` to every CDN and `import()` from esm.sh, but allowed
`import()` from cdn.jsdelivr.net and `<script>` from cdnjs.  ChatGPT allowed
more.  WebAssembly from inline bytes worked in both; cross-origin isolation
(WASM threads) in neither.  So the engines are single-threaded and ship
inside the JS module.  Rebuild with `node cdn/build.mjs` (after `node scripts/build-engine.mjs`);
CI checks the engine with `node cdn/build.mjs --check`, and a `v*` release
rebuilds both modules before publishing.  Licensing:
see `NOTICE.md` (Sagebrush's own code is MIT OR Apache-2.0; the pyparse parts
derived from CPython are PSF-2.0).
