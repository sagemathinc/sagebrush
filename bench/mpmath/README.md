# mpmath on pyjs

mpmath 1.3.0 (pure Python, the copy installed for CPython 3.14) runs unchanged on the pyjs spike: the compiler from `src/` targeting Node, which uses the pyparse front end.

## Does it import?

Yes. Getting there required these runtime additions (commits `77f8fa2` through `649d867`):
- **New types:** `complex` with `cmath`, and `X | Y` unions.
- **Vendored from CPython:**
  - `operator`, `copy`, `copyreg`, `functools`, `reprlib`;
  - `abc` with `_py_abc` and `_weakrefset`;
  - `numbers`, `fractions`, `colorsys`, `json`, `pickle`.
- **Written for pyjs:** small `warnings`, `_thread`, `codecs`, `traceback` and `tempfile` modules.
- **Two import-system fixes:**
  - A submodule that its package's `__init__` had already imported was executed a second time.
  - `__import__` did not accept keyword arguments.

`import mpmath` takes 1.08 s under pyjs, against 0.24 s under CPython. pyjs has no bytecode cache, so all of mpmath is compiled on every start.

## Does its test suite run?

**Yes: all 339 tests in `mpmath/tests` pass**, run with `bench/mpmath/compare.py`. The script runs the same files, plus a tiny `pytest` shim, under both interpreters. CPython fails 1 test in `test_convert` (`test_compatibility`); pyjs passes it.

Bugs found in pyjs while making the suite pass, all now fixed:
- **Dict keys across types:** a key equal to a number but of another type missed in dicts (mpmath's `_cache[k-1]` with an `mpf` key).
- **Huge ints:** `mpf * 2**2000` raised OverflowError instead of trying `mpf.__rmul__`.
- **`math.ceil`/`math.floor`:** on huge floats they returned inexact ints.
- **`cmath`:** I replaced the textbook formulas with CPython's algorithms (error now ≤ 1–3 ulp, measured on 22,000 cases), and an infinite result from a finite argument now raises OverflowError.
- **`hash()`:** results above 2**53 were rounded, and `sys.hash_info.modulus` was inexact.
- **`type(name, bases, ns)`:** classes got `__module__ = "__main__"`, which broke pickling of `mpf`.
- **`re`:** escapes inside a character class (`[\+\-]`) were mistranslated, and `\z` was missing.

## How does it compare to CPython in performance?

Measured on the same machine with Node 26 and CPython 3.14, without gmpy (both use pure-Python integers).

**Test suite:** the time spent inside the tests is 34.6 s on CPython and 146.6 s on pyjs, so **pyjs is 4.2× slower overall**. Per module the ratio ranges from 1.4× (`test_convert`) to 24× (`test_trig`, where the times are milliseconds).

**Benchmarks** (`bench/mpmath/perf.py`, best of up to 3 runs, seconds):

| Benchmark | CPython | pyjs | pyjs / CPython |
|---|---:|---:|---:|
| arith loop, dps=15 (60k ops) | 0.065 | 0.178 | 2.7× |
| complex loop, dps=15 (20k ops) | 0.035 | 0.078 | 2.2× |
| `fp.sin`/`fp.exp` loop (20k) | 0.0066 | 0.037 | 5.6× |
| exp+log+sin, dps=1000 | 0.0003 | 0.0018 | 6× |
| pi, 10k digits | 0.0017 | 0.0036 | 2.1× |
| pi, 100k digits | 0.030 | 0.062 | 2.1× |
| sqrt(2), 100k digits | 0.0022 | 0.012 | 5.6× |
| exp(1), 10k digits | 0.0016 | 0.0030 | 1.9× |
| zeta(3), 1000 digits | 0.0028 | 0.0061 | 2.2× |
| gamma(1/3), 1000 digits | 0.65 | 1.10 | 1.7× |
| quad exp(-x²) over ℝ, dps=50 | 0.039 | 0.19 | 4.9× |
| zetazero(100) | 0.105 | 0.79 | 7.5× |
| hyp2f1, dps=30 (200 calls) | 0.014 | 0.078 | 5.6× |
| 30×30 Hilbert inverse, dps=30 | 0.098 | 0.41 | 4.2× |

Every result agrees with CPython to the digits printed, except the `fp` (double precision) loop. That differs in the 16th digit because JS `Math.sin` and `Math.exp` are not glibc's libm.

**Reading the numbers**
- **Big-integer kernels** (pi, exp(1), zeta(3), gamma) are 1.7–2.2× slower: this is V8 BigInt against CPython's int.
- **Interpreter-heavy code** (many small mpf operations, attribute access, tuples) is 4–8× slower. This is the pyjs spike's generic object and call paths, not the arithmetic.
- **Optimizations to try next:**
  - a bytecode or compile cache, which saves about 0.8 s of import;
  - faster `isinstance` and attribute paths for classes with `__slots__`;
  - tuple unpacking of mpf's `_mpf_` tuples;
  - `math` and `fp` call overhead.

## Reproduce

```
python3 bench/mpmath/compare.py -j 6          # tests under both, table + /tmp/mpmath-compare.json
cd /tmp/mpmath-compare                         # created by compare.py
python3 perf.py; node --stack-size=8000 ~/sagebrush/dist/src/cli.js perf.py
```
