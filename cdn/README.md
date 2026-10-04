# Single-file ES modules for browsers and chat artifacts

Served by jsdelivr straight from this repository:

```js
const sb = await import("https://cdn.jsdelivr.net/gh/sagemathinc/sagebrush@<commit>/cdn/sagebrush-engine.mjs");
const py = await import("https://cdn.jsdelivr.net/gh/sagemathinc/sagebrush@<commit>/cdn/pyparse.mjs");
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
inside the JS module.  Rebuild with `node cdn/build.mjs`.
