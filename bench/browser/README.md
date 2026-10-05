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
  (2–10×) and converting to Python objects (`tolist`).
- **They are even** on `sort` and matmul.
- **sagebrush is within ~1.3–3×** on random numbers, `sin`, `cumsum`,
  `histogram`, `fft` and boolean masks.
- **NumPy compiled to WebAssembly is ahead** on:
  - dense linear algebra (LAPACK; 3–5×);
  - `exp`, `rfft`, `polyfit` and broadcasting (3–6×);
  - elementwise arithmetic on large arrays (`a*2+1`: ~10×). Here every
    result is a fresh 8 MB typed array for the garbage collector to manage,
    where WebAssembly reuses `malloc`'d memory.

**What closes the rest:** SIMD kernels in WebAssembly (`f64x2`) for
`gemm`, LU, triangular solves and elementwise loops, operating on our own
typed arrays. This would also make linear algebra faster than Pyodide's,
which is scalar.
