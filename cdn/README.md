# Single-file ES modules for browsers and chat artifacts

Published to npm as **`sagebrush-web`** and served by jsdelivr (`/npm/` is
the only jsdelivr path Claude's artifact sandbox allows; `/gh/<repo>@<commit>/cdn/`
also works elsewhere):

```js
const sb = await import("https://cdn.jsdelivr.net/npm/sagebrush-web@0.1.0/sagebrush-engine.mjs");
const py = await import("https://cdn.jsdelivr.net/npm/sagebrush-web@0.1.0/pyparse.mjs");
sb.charpoly({ n: 1, k: 12, q: 2, sign: 1 });   // proven, over Z[zeta_m]
py.parse("x = [1, 2 3]\n");                     // throws CPython's SyntaxError
```

| File | Raw | Gzipped (as served) | What |
|---|---|---|---|
| `sagebrush-engine.mjs` | 549 KB | 208 KB | the Rust engines (`engine/web`, wasm32) inlined as base64 |
| `pyparse.mjs` | 227 KB | 33 KB | CPython 3.14's parser (`pyparse/`) |

Why this shape: in the October 2026 smoke test, Claude's artifact sandbox
blocked `fetch()` to every CDN and `import()` from esm.sh, but allowed
`import()` from cdn.jsdelivr.net and `<script>` from cdnjs.  ChatGPT allowed
more.  WebAssembly from inline bytes worked in both; cross-origin isolation
(WASM threads) in neither.  So the engines are single-threaded and ship
inside the JS module.  Rebuild with `node cdn/build.mjs`; publish with
`bash cdn/publish.sh` (bump `version` in package.json first).  Licensing:
see `NOTICE.md` (no license for Sagebrush's own code yet; the pyparse parts
derived from CPython are PSF-2.0).
