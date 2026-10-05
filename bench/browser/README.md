# sagebrush vs Pyodide, in the browser

`run.mjs` runs one program, `cases.py`, in headless Chromium under:

- **sagebrush:** the notebook page from `web/dist`, in a Web Worker;
- **Pyodide 314.0.7 / NumPy 2.4.6:** loaded from the jsDelivr CDN, on the
  same machine and in the same browser (the engine behind JupyterLite).

Each case is the best of several runs, timed inside the runtime with
`time.perf_counter`. Startup is from navigation until `import numpy` has
run, with a cold cache.

```sh
bun web/build.ts
(cd web/dist && python3 -m http.server 8765) &
(cd bench/browser && python3 -m http.server 8766) &
node bench/browser/run.mjs        # prints a markdown table; also last-results.md
```

## Results (2026-10-05, Chromium 149, x86-64)

See `last-results.md` for the latest run.

**Summary:**
- **sagebrush is faster** at startup (~8×, 0.4 s vs 3.2 s), pure Python
  (up to ~11×) and converting to Python objects (`tolist`).
- With the Rust/WebAssembly kernels ([kernels/](../../kernels)),
  **sagebrush is faster at:**
  - dense linear algebra: matmul 300×300 (3.5 vs 25 ms, 7×), `det`
    1000×1000 (123 vs 187 ms), `inv`, `eigh`, `svd` and `eig`;
  - sorting: `sort` 10^6 (27 vs 129 ms, 4.8×) and `argsort` (2.2×);
  - random numbers: `rand` (8.1 vs 16.7 ms) and `randn` (24 vs 39 ms).
- **They are even** on `exp`, and close on `solve`, `mean+std`, `cumsum` and
  `histogram`.
- **sagebrush is within ~1.5–2.5×** on `sin`, `sqrt`, the FFT, boolean
  masks and `unique`.
- **NumPy compiled to WebAssembly is ahead** on:
  - `polyfit` (3.8×): `lstsq` forms Q and U explicitly where LAPACK's
    `gelsd` does not;
  - elementwise arithmetic and broadcasting on large arrays (`a*2+1`:
    5.5×). Here each result is a fresh 8 MB typed array, and Chromium
    spends ~4 ms in page faults on its first write. Temporaries inside an
    expression are reused (`a*2+1` allocates once), but the result itself
    cannot be.

**Next:** `lstsq` without explicit Q and U, and the cost of allocating
results: in Chromium, writing a fresh 8 MB typed array costs ~4 ms of page
faults the first time (0.7 ms into an existing one). `bench/browser/cell.mjs`
runs one Python cell, or a JavaScript snippet in a worker, in headless
Chromium.
