<!-- description: Sagebrush's Python against Pyodide (CPython compiled to WebAssembly) in the same browser: how much each downloads, how fast each starts, and how fast each runs a few workloads, measured the same way, with what Sagebrush does not claim. -->
<!-- disclosure: Written by Claude Opus 5.5, an AI model made by Anthropic, from measurements of the Sagebrush project, led by William Stein (SageMath, Inc.). -->
# Sagebrush and Pyodide, measured

> Measured on Oct 18, 2026: headless Chrome 155 on a quiet Linux VM (48
> cores of an AMD EPYC 7B13; one-minute load average at most 1.1 throughout).
> Sagebrush 0.5.0 at commit 8d3a5295 (build 4e24e8e68b5d5ada); Pyodide
> 314.0.7 (CPython 3.14.2). Five cold starts per engine. The tables give the
> median, with the lowest and highest of the five in brackets.

Sagebrush runs Python in the browser without CPython. Its own compiler turns
Python into JavaScript, which the browser's JIT runs, alongside a library
written for it: numpy, a subset of scipy, and the Sage, MATLAB and Magma modes.
[Pyodide](https://pyodide.org) is CPython itself, compiled to WebAssembly,
with real NumPy and much of the scientific stack built the same way.

They make different trade-offs. This page measures both the same way, with a
script anyone can run (`web/bench-compare.mjs` in the repository).

**In the browser, Sagebrush is small and starts fast.** A cold start
transfers 0.38 MB against Pyodide's 6.04 MB and prints its first result
155 ms after navigation, against 2,008 ms. `import numpy` then takes 149 ms
against 886 ms. Running speed depends on the workload; the tables below
include rows chosen because Sagebrush's design should be weakest there, and
how much memory each engine holds over a session.

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
| transferred / uncompressed | **0.38 / 1.46 MB** | 6.04 / 13.5 MB |
| interpreter ready | **107 ms** (104–108) | 1,945 ms (1,931–1,991) |
| first `print(1 + 1)` result, from navigation | **155 ms** (153–206) | 2,008 ms (1,974–2,045) |
| `import numpy`: transferred / uncompressed | **0.34 / 2.05 MB** | 2.96 / 2.96 MB |
| `import numpy`: time | **149 ms** (145–152) | 886 ms (881–904) |

- **Sagebrush.** The interpreter is one 1.46 MB script (0.38 MB compressed):
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
cold starts, and their range. Between workloads the script forces a garbage
collection and reads the memory (see Memory, below).

The two multiplication rows time one product, `c = a * b`, and print its
bit length and its remainder modulo 1,000,003. Before the warm-up, an
untimed setup step builds the operands, two integers of about $10^6$ (or
$10^7$) decimal digits, from hex strings. That setup step's output is
checked as well.

| workload | Sagebrush | Pyodide |
|---|---|---|
| the sum of 3,000,000 squares, in a loop | **172 ms** (172–182) | 731 ms (669–795) |
| recursion, `fib(25)` | **6 ms** (6–6) | 18 ms (17–20) |
| a dict of 200,000 string keys, sorted | **80 ms** (78–81) | 91 ms (87–100) |
| big integers, `factorial(20000)` | **5 ms** (5–5) | 11 ms (11–12) |
| big integers, one multiplication of two $10^6$-digit numbers | **34 ms** (34–34) | 709 ms (707–718) |
| big integers, one multiplication of two $10^7$-digit numbers | **381 ms** (377–381) | 28,098 ms (28,027–28,126) |
| a byte sieve to 2,000,000 | **17 ms** (16–17) | 29 ms (26–30) |
| JSON, 30,000 small objects there and back | 143 ms (140–147) | 142 ms (141–149) |
| numpy, a 300×300 matrix product | **13 ms** (12–13) | 29 ms (29–30) |
| numpy, elementwise on 1,000,000 floats | 540 ms (537–549) | **13 ms** (13–13) |

These explanations are architectural context for these workloads, not
separate measurements:
- **Pure-Python code** (loops, function calls) is where compiling to
  JavaScript pays. The browser's JIT compiles hot code to machine code, while
  CPython interprets bytecode, and that interpreter is itself compiled to
  WebAssembly.
- **Big integers.** Sagebrush's `int` is JavaScript's `BigInt` once a
  value outgrows a double's exact integers. The two engines multiply
  large integers with different algorithms, so the gap grows with size.
  - **CPython** (`Objects/longobject.c`) multiplies by schoolbook up to 70
    of its 30-bit digits (about 630 decimal digits), and by Karatsuba
    above that. Karatsuba is $O(n^{\log_2 3}) \approx O(n^{1.585})$.
    CPython has nothing faster.
  - **V8's BigInt** (`src/bigint/` in V8's sources) also starts with
    schoolbook and Karatsuba. It switches to Toom–Cook 3-way,
    $O(n^{\log_3 5}) \approx O(n^{1.465})$, once the smaller operand
    reaches 210 of its 64-bit digits (about 4,000 decimal digits). It
    switches to Schönhage–Strassen FFT multiplication,
    $O(n \log n \log \log n)$, at 720 digits (about 14,000 decimal
    digits). The thresholds are in `bigint-inl.h`; the dispatch is
    `MultiplyLarge` in `bigint-internal.cc`.
  - So multiplying two $10^7$-digit numbers takes 381 ms in Sagebrush
    against 28.1 s in Pyodide, about 74 times less; at $10^6$ digits the
    ratio is about 21. For scale, outside the browser, native CPython 3.14.8
    took 22.1 s for that product on one of these VMs, and Node 26 took
    355 ms.
  - `factorial(20000)` is a product of many small factors, so it depends
    on how they are grouped as much as on the multiplication. Both engines
    use CPython's algorithm, a balanced product of the odd parts and then
    a shift, so that the multiplications are of numbers of similar size.
  - **A caveat on phones:** V8 compiles the Toom–Cook and FFT algorithms
    only where its build flag `v8_advanced_bigint_algorithms` is on, and it
    defaults to off on Android (`gni/v8.gni`) to save binary size. In Chrome
    on Android, Sagebrush's large products are therefore Karatsuba, like
    CPython's, and the $10^7$-digit row does not carry over.
- **JSON**: Pyodide uses CPython's C accelerator, `_json`. Sagebrush now
  has its own `_json` (`src/runtime/json.ts`) under CPython's `json`
  package: the same scanner, encoder and string scanning, written for its
  runtime. The two engines now take about the same time; without it, in
  the previous version of this page, Sagebrush took 1,031 ms.
- **NumPy.** In Pyodide, NumPy's operations are C compiled to WebAssembly.
  - In Sagebrush, the matrix product calls a WebAssembly SIMD kernel
    written in Rust (`dgemm` in `kernels/src/lib.rs`), which does the same
    floating-point operations, in the same order, as its JavaScript
    fallback.
  - Elementwise arithmetic and most ufuncs are JavaScript loops over typed
    arrays; only `exp` and `log` have WebAssembly SIMD kernels.
  - The elementwise row, `np.sum(np.sin(x) * x + x ** 2)` on 1,000,000
    floats, is about 40 times slower here than in Pyodide, the largest gap
    in the table. It is not the cost of dispatch. Timed one operation at a
    time in Node on the same kind of VM:
    - `x * x`, `x + x` and `np.sum` take 0.8–1.9 ms, as fast as a plain
      JavaScript loop over the array (0.9–4.2 ms).
    - `np.sin` takes 357 ms, against 9.7 ms for a loop of `Math.sin`.
      Sagebrush's `sin` is correctly rounded, so that its results agree
      with the C library that CPython and NumPy call wherever that library
      is correctly rounded. It is computed in double-double arithmetic, in
      JavaScript.
    - `x ** 2` takes 106 ms. It goes through a port of glibc's `pow`,
      while NumPy computes a square as `x * x`.
  - Both are known and fixable without giving up the results: a square is
    exactly `x * x`, and a correctly rounded `sin` can be fast if it is
    compiled to WebAssembly, as `exp` and `log` already are.

## Where Sagebrush's design is weakest

These rows were chosen because they work against compiling Python to
JavaScript.

| workload | Sagebrush | Pyodide |
|---|---|---|
| 2,000 distinct small functions, each built with `exec()` and called once | 417 ms (402–424) | **128 ms** (127–130) |
| one call site over objects of 50 classes with different layouts | 116 ms (114–118) | **72 ms** (71–74) |
| the same loop over objects of one class (the control) | **13 ms** (13–13) | 50 ms (50–53) |

- **`exec()` and `compile()`.** CPython compiles a small function to
  bytecode in microseconds. Sagebrush parses it, compiles it to JavaScript,
  and then V8 parses and compiles that JavaScript too, about 0.2 ms per
  function here. Code that generates and runs many small programs pays this
  each time. Pyodide is about 3 times faster on this row.
- **Megamorphic code.** V8 makes attribute loads and method calls fast by
  caching, at each place in the code, the object layouts it has seen. When
  one place sees objects of 50 different layouts, those caches give up
  ("megamorphic"), and each access becomes a slower generic lookup.
  CPython's dictionary-based lookup does not depend as much on how many
  classes pass through. Pyodide is about 1.6 times faster here, while on the
  same loop over one class Sagebrush is almost 4 times faster.

## Memory

The two engines manage memory in different ways, and it shows over a
session.
- **Sagebrush's** Python objects live in the JavaScript heap of its Web
  Worker. V8's garbage collector frees what is no longer reachable and gives
  the freed pages back.
- **Pyodide's** CPython lives inside one WebAssembly memory, a single block
  that can grow and never shrinks. CPython frees an object as soon as its
  last reference goes, and reuses that space for later objects. But the
  block itself stays at the largest size it ever reached, for as long as
  the page is open.

**How it was measured.** The numbers are the private memory (USS, pages no
other process shares) of the page's renderer process. That process holds
the page, Sagebrush's worker, both JavaScript heaps and Pyodide's
WebAssembly memory. The browser's other processes hold about the same for
both engines and are not counted.
- The script reads `/proc` every 50 ms during each workload's setup and
  warm-up run, which do the same work as a timed run, and takes the peak
  of those readings.
- It does not sample while a workload is timed: reading a process's memory
  map holds a lock that slows that process's own allocations. With
  sampling on, Sagebrush's allocation-heavy rows took 12–16% longer.
- After each workload's five timed runs it forces a garbage collection
  (CDP's `HeapProfiler.collectGarbage`) and reads again. Pyodide's memory
  can still grow during the timed runs, so its reading after them can be a
  little above its warm-up peak.
- The workloads run in one session, in the order of the table, and their
  variables stay alive, as in a notebook. So each "after" reading includes
  the data every earlier workload left behind.

| the page's renderer, private memory (MB) | Sagebrush | Pyodide [its WebAssembly memory] |
|---|---|---|
| after `print(1 + 1)` | **27** (27–28) | 79 (78–79) [31] |
| after `import numpy` | **38** (38–39) | 116 (116–116) [45] |
| one multiplication of two $10^7$-digit numbers: peak | 394 (393–394) | **194** (193–194) |
| the same, after a collection | **78** (77–78) | 195 (194–195) [136] |
| JSON, 30,000 small objects: peak | **180** (179–181) | 195 (195–196) |
| the same, after a collection | **113** (113–113) | 195 (195–196) [136] |
| numpy elementwise: peak | **161** (159–161) | 221 (221–221) |
| the same, after a collection | **124** (124–125) | 221 (220–221) [163] |
| after the last workload, then 30 s idle | **141** (140–142) | 220 (220–220) [163] |
| every global deleted, `gc.collect()`, a collection | **76** (76–77) | 220 (220–220) [163] |

- **Peaks.** V8 lets garbage pile up between collections, so Sagebrush's
  peaks can be higher: 394 MB while multiplying two $10^7$-digit numbers,
  against Pyodide's 194 MB.
- **After a collection,** Sagebrush gives most of it back: 78 MB after that
  multiplication. Pyodide's footprint only ratchets up. Its WebAssembly
  memory was 45 MB after `import numpy`, 79 MB after the dict, 136 MB after
  the multiplication and 163 MB after the elementwise row, and it never
  went down.
- **At the end,** with every workload's variables deleted and collected,
  Sagebrush's page is at 76 MB and Pyodide's at 220 MB. CPython has freed
  those objects, but the WebAssembly memory still holds its 163 MB peak.
  For a long-running notebook, this means one large computation leaves a
  Pyodide tab at its high-water mark until the page is reloaded.
- The full timeline, one sample per 250 ms with each phase marked, is in
  the raw data below.

## How to reproduce

```
node scripts/build-cli.mjs
bun web/build.ts
node web/bench-compare.mjs --pyodide DIR --runs 5 --json out.json
```

`DIR` holds Pyodide's distribution (`pyodide.mjs`, `pyodide.asm.wasm`,
`python_stdlib.zip`, `pyodide-lock.json`) and the numpy wheel. The script
exits with an error if any execution printed something different, and
`node web/bench-compare.mjs --check FILE.json` checks a saved run again. The
memory measurements need Linux, since they read `/proc`. The raw data of the
run above, with every cold start's and every timed run's time and output,
every memory reading, and each session's memory timeline, is
[`articles/performance/data/sagebrush-pyodide-2026-10-18.json`](https://github.com/sagemathinc/sagebrush/blob/master/articles/performance/data/sagebrush-pyodide-2026-10-18.json).
The previous run, before the multiplication rows, the product trees and
Sagebrush's `_json`, is
[`sagebrush-pyodide-2026-10-17.json`](https://github.com/sagemathinc/sagebrush/blob/master/articles/performance/data/sagebrush-pyodide-2026-10-17.json).
