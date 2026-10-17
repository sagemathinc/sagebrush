<!-- description: Sagebrush's Python against Pyodide (CPython compiled to WebAssembly) in the same browser: how much each downloads, how fast each starts, and how fast each runs a few workloads, measured the same way, with what Sagebrush does not claim. -->
<!-- disclosure: Written by Claude Opus 5.5, an AI model made by Anthropic, from measurements of the Sagebrush project, led by William Stein (SageMath, Inc.). -->
# Sagebrush and Pyodide, measured

> Measured on Oct 17, 2026: headless Chrome 155 on an otherwise idle Linux
> VM (48 cores of an AMD EPYC 7B13, load average about 1 throughout), five
> cold starts per engine, each in a fresh browser profile. The tables give
> the medians. Across the five runs, every number stayed within a few
> percent of its median.

Sagebrush runs Python in the browser without CPython. Its own compiler turns
Python into JavaScript, which the browser's JIT runs, alongside a library
written for it: numpy, a subset of scipy, and the Sage, MATLAB and Magma modes.
[Pyodide](https://pyodide.org) is CPython itself, compiled to WebAssembly,
with real NumPy and much of the scientific stack built the same way.

They make different trade-offs. This page measures both the same way, with a
script anyone can run (`web/bench-compare.mjs` in the repository).

**What Sagebrush does not claim.** It does not run every Python program the
way CPython does:
- its standard library is a subset;
- its numpy and scipy are reimplementations, close but not identical, and
  their documented differences are part of the catalog;
- C extensions don't exist for it.

Where it does not implement something, it raises an error rather than guess.
The workloads below are ones both run identically: each prints a result, and
the two must match.

## Downloading and starting

Each measurement is a cold start in a fresh browser profile: the page loads
the interpreter and runs `print(1 + 1)`. Files are served from the same
machine, compressed as a CDN serves them (brotli), so the byte counts are what
a first visit transfers.

| | Sagebrush | Pyodide 314.0.7 |
|---|---|---|
| transferred / uncompressed | **0.33 / 1.31 MB** | 6.04 / 13.5 MB |
| interpreter ready | **0.10 s** | 1.97 s |
| first `print(1 + 1)` result, from navigation | **0.18 s** | 2.04 s |
| `import numpy`: transferred / uncompressed | 0.35 / 2.08 MB | 2.96 / 2.96 MB |
| `import numpy`: time | **0.13 s** | 0.86 s |

- **Sagebrush.** The interpreter is one 1.31 MB script (0.33 MB compressed):
  the compiler and runtime. Its library comes in chunks, each fetched the
  first time something imports from it.
- **Pyodide.** Its core is the CPython interpreter (`pyodide.asm.wasm`,
  9.6 MB, 3.2 MB compressed) and its standard library
  (`python_stdlib.zip`, 2.5 MB, already compressed). Each package is a wheel,
  fetched when imported.

## Running

Each workload runs once to warm up, then five times in the same session.
The table gives the median, timed inside the page, and then the median of
those over the five cold starts. Sagebrush runs in a Web Worker and Pyodide on
the page's main thread, as each is usually set up.

| workload | Sagebrush | Pyodide |
|---|---|---|
| a loop of 3,000,000 additions | **170 ms** | 704 ms |
| recursion, `fib(25)` | **5 ms** | 18 ms |
| a dict of 200,000 string keys, sorted | 85 ms | 89 ms |
| big integers, `factorial(20000)` | 53 ms | **11 ms** |
| a byte sieve to 2,000,000 | **15 ms** | 30 ms |
| JSON, 30,000 small objects there and back | 1,036 ms | **139 ms** |
| numpy, a 300×300 matrix product | **9 ms** | 29 ms |
| numpy, elementwise on 1,000,000 floats | 531 ms | **13 ms** |

- **Pure-Python code** (loops, function calls) is where compiling to
  JavaScript pays. The browser's JIT compiles hot code to machine code, while
  CPython interprets bytecode, and that interpreter is itself compiled to
  WebAssembly.
- **Big-integer arithmetic** is where CPython's C arithmetic wins.
- **JSON**: Pyodide uses CPython's C accelerator (`_json`). Sagebrush runs
  CPython's own `json` package without it, as pure Python. Outside the
  browser too, `json.dumps` takes about 27 times as long as CPython's and
  `json.loads` about 16 times. That is a known gap.
- **NumPy's vectorized operations** are C in Pyodide. In Sagebrush the
  elementwise case is JavaScript over a typed array, about 40 times slower
  here. That is the largest gap in the table, and a known target.

## How to reproduce

```
bun web/build.ts
node web/bench-compare.mjs --pyodide DIR --runs 5 --json out.json
```

`DIR` holds Pyodide's distribution (`pyodide.mjs`, `pyodide.asm.wasm`,
`python_stdlib.zip`, `pyodide-lock.json`) and the numpy wheel. The script
counts bytes on its own server, not in the browser, so nothing is cached
between cold starts.
