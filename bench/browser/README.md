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
- **sagebrush is faster** at startup (~8×, 0.4 s vs 3.0 s), pure Python
  (up to ~11×) and converting to Python objects (`tolist`).
- With the Rust/WebAssembly SIMD kernels ([kernels/](../../kernels)),
  **sagebrush is faster at dense linear algebra:** matmul 300×300 (3.6 ms
  vs 25 ms, 7×), `det` 1000×1000 (122 vs 187 ms), `inv`, `eigh` (11.7 vs
  14.5 ms), `svd` (24 vs 28 ms) and `eig` (6.7 vs 9.3 ms). `solve` is
  close (2.5 vs 1.7 ms).
- **They are even** on `sort`.
- **sagebrush is within ~1.3–3×** on random numbers, `sin`, `cumsum`,
  `histogram`, the FFT (`fft` 2^16 3.3 vs 2.0 ms, `rfft` 10^6 25 vs 15 ms,
  from 87 ms before the kernels) and boolean masks.
- **NumPy compiled to WebAssembly is ahead** on:
  - `exp`, `polyfit` and broadcasting (3–6×). `lstsq` (and so `polyfit`)
    forms Q and U explicitly where LAPACK's `gelsd` does not.
  - elementwise arithmetic on large arrays (`a*2+1`: ~7×). Here every
    result is a fresh 8 MB typed array for the garbage collector to manage,
    where WebAssembly reuses `malloc`'d memory.

**Next:** `lstsq` without explicit Q and U, elementwise loops on pooled
memory, `exp` and friends in the kernels.
