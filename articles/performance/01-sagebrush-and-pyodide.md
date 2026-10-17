<!-- description: Sagebrush's Python against Pyodide (CPython compiled to WebAssembly) in the same browser: how much each downloads, how fast each starts, and how fast each runs a few workloads, measured the same way, with what Sagebrush does not claim. -->
<!-- disclosure: Written by Claude Opus 5.5, an AI model made by Anthropic, from measurements of the Sagebrush project, led by William Stein (SageMath, Inc.). -->
# Sagebrush and Pyodide, measured

> Measured on Oct 17, 2026: headless Chrome 155 on an otherwise idle Linux
> VM (48 cores of an AMD EPYC 7B13; load average 3.7 at the start and 1.9 at the end).
> Sagebrush 0.5.0 at commit 8e623937 (build de4ad3da624041bf); Pyodide
> 314.0.7 (CPython 3.14.2). Five cold starts per engine. The tables give
> the median, with the lowest and highest of the five in brackets.

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

Operations it does not support are intended to raise an error rather than
return a guess. The workloads below are ones both engines run the same way.
Every execution of each one, in every cold start of both engines, had to
print the same result, or the measurement would have failed.

## How it was measured

These are not full notebook visits. Each engine runs in a minimal page that
starts its interpreter and nothing else: Sagebrush's notebook worker without
the notebook around it, and Pyodide on the page's main thread, following its
quickstart.
- Each cold start is a fresh browser profile, so the browser has nothing
  cached.
- All files come from one local server, which compresses them as a CDN would
  (brotli). One discarded priming session per engine ran first, so the
  compressed copies already existed. After that the two engines alternated.
- The byte counts are the response bodies the server sent: compressed where
  the file type allows, without HTTP overhead.
- The times are local and end to end. The time to the first result counts
  from navigation and includes the measuring script's polling. A visit over
  a real network would add the transfer time of those bytes.

## Downloading and starting

Each cold start loads the interpreter and runs `print(1 + 1)`.

| | Sagebrush | Pyodide 314.0.7 |
|---|---|---|
| transferred / uncompressed | **0.33 / 1.32 MB** | 6.04 / 13.5 MB |
| interpreter ready | **100 ms** (98–103) | 1,945 ms (1,910–1,973) |
| first `print(1 + 1)` result, from navigation | **179 ms** (178–183) | 2,012 ms (1,974–2,038) |
| `import numpy`: transferred / uncompressed | 0.33 / 2.00 MB | 2.96 / 2.96 MB |
| `import numpy`: time | **132 ms** (130–134) | 850 ms (845–873) |

- **Sagebrush.** The interpreter is one 1.32 MB script (0.33 MB compressed):
  the compiler and runtime. Its library comes in chunks, each fetched the
  first time something imports from it.
- **Pyodide.** Its core is the CPython interpreter (`pyodide.asm.wasm`,
  9.6 MB, 3.2 MB compressed) and its standard library
  (`python_stdlib.zip`, 2.5 MB, already compressed). Each package is a wheel,
  fetched when imported.

## Running

Each workload runs once to warm up, then five times in the same session.
For each cold start the script takes the median of the five timed runs,
timed inside the page. The table gives the median of those over the five
cold starts, and their range.

| workload | Sagebrush | Pyodide |
|---|---|---|
| the sum of 3,000,000 squares, in a loop | **170 ms** (169–175) | 725 ms (661–776) |
| recursion, `fib(25)` | **5 ms** (5–6) | 18 ms (18–20) |
| a dict of 200,000 string keys, sorted | 85 ms (84–86) | 88 ms (87–91) |
| big integers, `factorial(20000)` | 52 ms (52–53) | **11 ms** (11–11) |
| a byte sieve to 2,000,000 | **15 ms** (15–15) | 29 ms (26–30) |
| JSON, 30,000 small objects there and back | 1,031 ms (1,027–1,050) | **139 ms** (138–143) |
| numpy, a 300×300 matrix product | **8 ms** (8–9) | 29 ms (29–30) |
| numpy, elementwise on 1,000,000 floats | 536 ms (525–541) | **13 ms** (13–13) |

These explanations are architectural context for these workloads, not
separate measurements:
- **Pure-Python code** (loops, function calls) is where compiling to
  JavaScript pays. The browser's JIT compiles hot code to machine code, while
  CPython interprets bytecode, and that interpreter is itself compiled to
  WebAssembly.
- **Big-integer arithmetic** is where CPython's C arithmetic wins.
- **JSON**: Pyodide uses CPython's C accelerator (`_json`). Sagebrush runs
  CPython's own `json` package without it, as pure Python. That is a known
  gap.
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
exits with an error if any execution printed something different, and
`node web/bench-compare.mjs --check FILE.json` checks a saved run again. The raw
data of the run above, with every cold start's and every timed run's time
and output, is
[`articles/performance/data/sagebrush-pyodide-2026-10-17.json`](https://github.com/sagemathinc/sagebrush/blob/master/articles/performance/data/sagebrush-pyodide-2026-10-17.json).
