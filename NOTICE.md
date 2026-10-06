# Sagebrush: licensing notice

Copyright (c) 2026 SageMath, Inc.

Sagebrush is licensed under either of

- the Apache License, Version 2.0 ([LICENSE-APACHE](LICENSE-APACHE)), or
- the MIT license ([LICENSE-MIT](LICENSE-MIT)),

at your option. Unless you explicitly state otherwise, any contribution
intentionally submitted for inclusion in Sagebrush, as defined in the
Apache-2.0 license, is dual licensed as above, without any additional terms
or conditions.

Some parts are derived from other permissively licensed projects. Their
notices follow and must be kept with the parts named. Nothing in Sagebrush
is derived from GPL software: PARI, Sage, Magma and FLINT are used only from
the outside, as oracles in tests and as benchmarks.

## Code derived from other projects

### CPython (PSF License Agreement)

Copyright (c) 2001 Python Software Foundation. See
[cdn/LICENSE-CPython.txt](cdn/LICENSE-CPython.txt).

- `lib/`: standard-library modules copied unchanged from CPython 3.14, each
  marked "Copied unchanged from CPython 3.14" in its first line.
- `pyparse/`: the Python 3.14 parser, generated from CPython's
  `Grammar/python.gram`, `Grammar/Tokens` and `Parser/Python.asdl`
  (vendored in `pyparse/vendor/cpython`), with TypeScript ports of parts of
  CPython's `Parser/` directory, and a Unicode character-name table generated
  from Python's `unicodedata`.

### NumPy (BSD 3-Clause)

`src/runtime/numpy.ts` (array printing), `src/runtime/numpy_random.ts`,
`src/runtime/ziggurat_data.ts` and `kernels/src/random.rs` (MT19937 with
NumPy's seeding, PCG64 with SeedSequence, and the distributions) follow
NumPy's code so that their output and random streams match NumPy's
exactly. NumPy's random module is dual licensed by its authors under the
University of Illinois/NCSA Open Source License and the BSD 3-Clause
license. The MT19937 and PCG64 generators are by Makoto Matsumoto and
Takuji Nishimura (BSD) and Melissa O'Neill (MIT OR Apache-2.0).

```
Copyright (c) 2005-2025, NumPy Developers.
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are
met:

    * Redistributions of source code must retain the above copyright
       notice, this list of conditions and the following disclaimer.

    * Redistributions in binary form must reproduce the above
       copyright notice, this list of conditions and the following
       disclaimer in the documentation and/or other materials provided
       with the distribution.

    * Neither the name of the NumPy Developers nor the names of any
       contributors may be used to endorse or promote products derived
       from this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
"AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

### Arm Optimized Routines (MIT, as glibc's exp and log)

`src/runtime/libm.ts`, `src/runtime/exp_data.ts`, `src/runtime/log_data.ts`
and `kernels/src/libm.rs` port the exp and log of Arm's Optimized Routines
(as used by glibc), with their tables. Optimized Routines is licensed
"MIT OR Apache-2.0 WITH LLVM-exception"; Sagebrush uses it under MIT.

```
Copyright (c) 2018-2025 Arm Limited.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### fdlibm (log1p)

`src/runtime/libm.ts` and `kernels/src/libm.rs` port fdlibm's log1p (as in
glibc's `sysdeps/ieee754/dbl-64/s_log1p.c`).

```
Copyright (C) 1993 by Sun Microsystems, Inc. All rights reserved.

Developed at SunPro, a Sun Microsystems, Inc. business.
Permission to use, copy, modify, and distribute this
software is freely granted, provided that this notice
is preserved.
```

### smalljac (used with the author's permission)

The a_p engine (`engine/ap`) follows the genus-1 strategy of Andrew V.
Sutherland's smalljac (with Kiran Kedlaya). On 2026-10-02 Andrew Sutherland
gave explicit permission for this port to be licensed however Sagebrush
chooses; see [engine/ap/PROVENANCE.md](engine/ap/PROVENANCE.md).

## Data

- `lib/_cremona_small.py`: elliptic curves of conductor below 1000 from John
  Cremona's ecdata (github.com/JohnCremona/ecdata), Artistic License 2.0.

## Used only by tests and benchmarks (not distributed in any package)

- `upstream/micropython/`: MicroPython's test suite (MIT; its `LICENSE`).
- `conformance/upstream/`: the test suites of CPython, PyPy, GraalPy,
  IronPython and RustPython, each under its own license (the `LICENSE` file
  in its directory).
- `bench/pyperformance/`: from pyperformance (MIT;
  `LICENSE.pyperformance`).
- `bench/bigint/`: a benchmark that links GMP (through `rug`) and malachite,
  both LGPL, as yardsticks for the permissive big-integer libraries. It is
  not part of any package.
- `engine/flint/`: Sagebrush's own bindings to FLINT, which is LGPL-3.0 or
  later. Only tests and examples link FLINT, as a reference; no library or
  package does.
