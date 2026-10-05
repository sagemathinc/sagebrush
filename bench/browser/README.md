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
- **sagebrush is faster** at startup (~8×, 0.4 s vs 3.1 s), pure Python
  (up to ~12×) and converting to Python objects (`tolist`).
- With the Rust/WebAssembly SIMD kernels ([kernels/](../../kernels)),
  **sagebrush is faster at matmul** (300×300: 3.5 ms vs 25 ms, 7×), `det`
  (1000×1000: 124 ms vs 184 ms) and `inv`; Pyodide's BLAS is scalar.
- **They are even** on `sort` and `solve`.
- **sagebrush is within ~1.3–3×** on random numbers, `sin`, `cumsum`,
  `histogram`, `fft` and boolean masks.
- **NumPy compiled to WebAssembly is ahead** on:
  - the eigenvalue problems and SVD (3–5×), which still run in JavaScript;
  - `exp`, `rfft`, `polyfit` and broadcasting (3–6×);
  - elementwise arithmetic on large arrays (`a*2+1`: ~10×). Here every
    result is a fresh 8 MB typed array for the garbage collector to manage,
    where WebAssembly reuses `malloc`'d memory.

**Next:** move the inner loops of `eigh`/`eig`/`svd` (Householder
reductions, QR sweeps) and of the FFT into the same Rust kernels, and
elementwise loops on pooled memory.
