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
- `lib/contextlib.py`: CPython 3.14's `Lib/contextlib.py`, changed (the PSF License's clause 3
  on derivative works): `_collections_abc._check_methods` is copied into it, and
  `suppress()` handles exception groups only when the builtins have
  `BaseExceptionGroup`, which Sagebrush does not yet.
- `lib/_collections_abc.py`: CPython 3.14's `Lib/_collections_abc.py`,
  changed (the PSF License's clause 3 on derivative works): the types of an
  async generator and of a frame's locals, which Sagebrush does not have, are
  placeholder classes. `lib/collections/__init__.py` makes it
  `collections.abc`, as CPython's does, and its `Counter` (with the
  pure-Python `_count_elements`), `ChainMap`, `UserDict`, `UserList` and
  `UserString` are CPython 3.14's (`UserString.maketrans` a
  `staticmethod`).
- `lib/importlib/__init__.py`: CPython 3.14's `Lib/importlib/__init__.py`'s
  `import_module`, `invalidate_caches` and `reload`'s argument checks, with
  `_bootstrap._sanity_check` and `_bootstrap._resolve_name`, ported over
  Sagebrush's own import system; `lib/importlib/metadata/__init__.py`:
  CPython 3.14's `PackageNotFoundError`, `version()` and name normalization,
  over Sagebrush's package registry.
- `lib/_pytime.py`: CPython 3.14's `time` module, a C module there
  (`Modules/timemodule.c` and the struct sequence of `Objects/structseq.c`:
  `struct_time`, `gmtime`, `localtime`, `mktime`, `asctime`, `ctime`,
  `strftime`'s argument checks, `sleep`'s, and `init_timezone`), ported to
  Python over Sagebrush's clocks and the host's time zone (the builtin module
  `time` is made from it). Its `strftime`
  writes what glibc 2.39's does in the C locale, matched by comparison with
  CPython on glibc (no glibc code is used).
- `lib/_pydatetime.py`: CPython 3.14's `Lib/_pydatetime.py`, changed (the PSF
  License's clause 3 on derivative works): its messages, `IsoCalendarDate`'s
  repr and `datetime`'s repr are the C `_datetime` module's, each change marked
  "Sagebrush: as C _datetime". `lib/datetime.py` is CPython 3.14's, unchanged.
- `lib/_string.py`: CPython 3.14's `_string` module, a C module there
  (`Objects/stringlib/unicode_format.h`: `MarkupIterator_next`,
  `parse_field`, `field_name_split`, `FieldNameIterator_next`), ported to
  Python, for `lib/string/__init__.py` (CPython 3.14's, unchanged).
- `lib/pprint.py`: CPython 3.14's `Lib/pprint.py`, changed: without a
  `dataclasses` module no object is a dataclass.
- `lib/pickle.py`: CPython 3.14's `Lib/pickle.py`, changed: protocol 4's
  `STACK_GLOBAL` memoizes the module name by module (and, in `builtins`, by
  function or type), as CPython's identity of those strings, which
  Sagebrush's strings do not have, makes it (`_save_module_name`); its
  exceptions are `lib/_pickle.py`'s, as CPython's are its accelerator's.
- `lib/textwrap.py`: CPython 3.14's `Lib/textwrap.py`, changed: `wrap()`
  (and so `fill()` and `shorten()`) refuses text with characters beyond
  U+FFFF, which Sagebrush's strings count as two.
- `pyparse/`: the Python 3.14 parser, generated from CPython's
  `Grammar/python.gram`, `Grammar/Tokens` and `Parser/Python.asdl`
  (vendored in `pyparse/vendor/cpython`), with TypeScript ports of parts of
  CPython's `Parser/` directory, and a Unicode character-name table generated
  from Python's `unicodedata`.
- `src/runtime/casefold-data.ts`: a table of Python 3.14's `str.casefold()`
  (the Unicode 16.0.0 full case folding of `CaseFolding.txt`), generated from
  CPython's own `str.casefold` by `scripts/gen-casefold.py`.
- `src/runtime/ops.ts`, `intTrueDiv`: int / int follows the scheme of
  CPython's `long_true_divide` (`Objects/longobject.c`): the shift, the two
  extra bits and the sticky bit, a single round to even at the result's
  precision (subnormals included), then exact scaling.
- `src/runtime/re.ts`, `translate` and `fixFlags`: the parse errors of
  CPython 3.14's `Lib/re/_parser.py` (`_parse_flags`, group references,
  repeats, `fix_flags`, with their messages and positions) ported, and
  `PatternError` as `Lib/re/_constants.py`'s; `src/runtime/re-shape.ts`
  follows the repeat and look-around semantics of `Modules/_sre/sre_lib.h`
  (`MAX_UNTIL`, `MIN_UNTIL`, `ASSERT`, `SUCCESS`'s `must_advance`) and the
  widths of `_parser.py`'s `getwidth` (no code of them is used there).
- `lib/collections/__init__.py`, `deque`: its iterators, mutation count
  and searches follow CPython 3.14's `Modules/_collectionsmodule.c`
  (`dequeiter_next`, `dequereviter_next`, `deque->state`, `deque_count`,
  `deque_contains`, `deque_index`, `deque_remove`); `src/runtime/types.ts`,
  `map`'s and `zip`'s strict, and `src/runtime/builtins.ts`, `min` and
  `max`, follow `Python/bltinmodule.c` (`map_next`, `zip_next`, `min_max`)
  (no code of them is used).
- `src/runtime/index.ts`, `syntaxErrorLines`: a SyntaxError's location lines
  (the file and line, the stripped line, carets from `offset` to `end_offset`)
  are ported from CPython 3.14's `Lib/traceback.py`
  (`TracebackException._format_syntax_error`).
- `src/runtime/pygamma.ts`: `math.gamma` and `math.lgamma`, ported from
  CPython 3.14's `Modules/mathmodule.c` (`m_tgamma`, `m_lgamma`, `m_sinpi`,
  `lanczos_sum` and their Lanczos coefficients).
- `src/runtime/builtins.ts`, `sum`: the compensated float and complex paths
  of CPython's `builtin_sum_impl` (`Python/bltinmodule.c`; Neumaier's
  algorithm).
- `src/runtime/modules.ts`, `math.fsum`, `math.remainder`, `math.isclose`,
  `math.modf` and `math.fmod`: ported from CPython 3.14's
  `Modules/mathmodule.c` (`math_fsum_impl` with Shewchuk's partials and its
  half-even correction, `m_remainder`, `math_isclose_impl`,
  `math_modf_impl`, `math_fmod_impl`); `src/runtime/ops.ts`, `floatDivmod`:
  `_float_div_mod` (`Objects/floatobject.c`).
- `src/runtime/modules.ts`, `math.factorial`, `math.comb`, `math.perm` and
  `math.prod`: ported from CPython 3.14's `Modules/mathmodule.c`
  (`math_factorial` with `factorial_odd_part`, `factorial_partial_product`
  and `count_set_bits`; the argument checks of `math_comb_impl` and
  `math_perm_impl` and `perm_comb`'s recursive split; `math_prod_impl`'s
  exact-int path, here a balanced product).
- `src/runtime/complex.ts`, the `cmath` module: ported from CPython 3.14's
  `Modules/cmathmodule.c` (each function's special-value table, its
  large-argument formulas and its errno: `cmath_sqrt_impl`, `c_log`,
  `cmath_exp_impl`, the trigonometric, hyperbolic and inverse functions,
  `cmath_rect_impl`, `cmath_polar_impl`), with `_Py_c_quot` and `_Py_c_abs`
  (`Objects/complexobject.c`). The `**` of complex numbers is ported from
  `complex_pow`, `c_powi`, `c_powu` and `_Py_c_pow` there, with
  `_Py_c_prod`'s Annex G recovery and `_Py_ADJUST_ERANGE2`'s errno rules
  (`Include/internal/pycore_pymath.h`).
- `src/unparse.ts`: an expression as text, ported from CPython 3.14's
  `Python/ast_unparse.c` (its precedence levels and the spelling of each
  node), for the annotations of `from __future__ import annotations`.

### NumPy (BSD 3-Clause)

`lib/numpy/__init__.py` (`poly1d.__str__` and `_raise_power`, from
`numpy/lib/_polynomial_impl.py`), `src/runtime/numpy.ts` (array printing;
complex powers, `cmul`, `cdiv` and `cpow`, from `npy_cpow` in
`numpy/_core/src/npymath/npy_math_complex.c.src`; the complex reciprocal,
`crecip`, from `numpy/_core/src/umath/loops.c.src`; and the `**` operator's
routes, `fastScalarPower`, from `fast_scalar_power` in
`numpy/_core/src/multiarray/number.c`; `arange`'s length and values, from
`_calc_length` and `PyArray_ArangeObj` in `numpy/_core/src/multiarray/ctors.c`
and the `@NAME@_fill` loops of `numpy/_core/src/multiarray/arraytypes.c.src`;
`linspace`'s arithmetic, from `numpy/_core/function_base.py`; and the
size in an array's MemoryError, from `_ArrayMemoryError._size_to_string` in
`numpy/_core/_exceptions.py`), `src/runtime/numpy_random.ts`,
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

### SciPy (BSD 3-Clause)

`lib/_matlab_ode.py` (ode45 and ode23) takes its step size control from
SciPy's `scipy/integrate/_ivp/rk.py` and `common.py` (1.18): the starting
step (`select_initial_step`, after Hairer, Norsett and Wanner) and the
step size factors (0.9, at least 0.2, at most 10, no growth after a
rejected step).

`lib/scipy/integrate.py` follows SciPy's `scipy/integrate`: `solve_ivp` and
its explicit Runge-Kutta solvers (`_ivp/ivp.py`, `rk.py`, `common.py`,
`base.py`: the step-size control, initial step, error norms, dense output
and event handling), DOP853's coefficients (`_ivp/dop853_coefficients.py`,
Hairer's), and the argument handling of `quad`, `nquad`, `odeint`,
`trapezoid`, `cumulative_trapezoid` and `simpson`.

`lib/scipy/special.py` follows SciPy 1.18's `scipy/special`: the argument
handling of `comb`, `perm` and `factorial` and the formula of `polygamma`
(`_basic.py`), `logsumexp`, `softmax` and `log_softmax` (`_logsumexp.py`),
and the formulas of `log_ndtr` (`_faddeeva.cxx`); its ufuncs' type
resolution, poles and domains follow SciPy's behaviour. Two of its
functions are ported from xsf, SciPy's special-function library (below).

`quad` in `lib/scipy/integrate.py` is a code translation, not only an
implementation of the published algorithm: `_qags`, `_qk21`, `_qk15i`,
`_qpsrt` and `_qelg` translate QUADPACK's Fortran routines dqagse/dqagie,
dqk21, dqk15i, dqpsrt and dqelg (R. Piessens, E. de Doncker-Kapenga,
C. Ueberhuber and D. Kahaner, 1983), keeping their routine structure,
1-based work arrays, control flow, constants and error counters, so that
values, error estimates and evaluation counts are SciPy's. QUADPACK is in
the public domain. SciPy 1.18's `scipy/integrate/__quadpack.c` is a C
translation of the same Fortran code, under SciPy's BSD license below;
Sagebrush's translation was checked against it, and its argument handling
and messages follow SciPy's `_quadpack_py.py`.

```
Copyright (c) 2001-2002 Enthought, Inc. 2003, SciPy Developers.
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions
are met:

1. Redistributions of source code must retain the above copyright
   notice, this list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above
   copyright notice, this list of conditions and the following
   disclaimer in the documentation and/or other materials provided
   with the distribution.

3. Neither the name of the copyright holder nor the names of its
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

### xsf (BSD 3-Clause, SciPy's special-function library)

`lib/scipy/special.py` ports two functions of xsf
(github.com/scipy/xsf, commit b6cb4259): `binom`'s algorithm
(`include/xsf/binom.h`) and the integer-degree Legendre polynomial,
`eval_legendre_l` (`include/xsf/orthogonal_eval.h`).

```
BSD 3-Clause License

Copyright (c) 2024, SciPy

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

3. Neither the name of the copyright holder nor the names of its
   contributors may be used to endorse or promote products derived from
   this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

### matplotlib (matplotlib License, PSF-based)

`lib/_graphics.py` follows matplotlib's code (3.11) so that the axes'
ticks and limits match matplotlib's: `mpl_ticks` is `MaxNLocator`'s tick
placement as `AutoLocator` uses it (`scale_range`, `_Edge_integer`, the
staircase of steps 1, 2, 2.5, 5, 10), `_mpl_nonsingular` is
`matplotlib.transforms.nonsingular`, and `lib/matplotlib/pyplot.py`'s
`_tick_bins` is `Axis.get_tick_space`. The changes made to matplotlib's code
(clause 3 below): it is rewritten in plain Python without NumPy, for one
axis at a time, without the locator's other options (`integer`,
`symmetric`, `prune`, other steps) and without its classic or
round-numbers modes. The named colors of `lib/matplotlib/colors.py`
(`CSS4_COLORS`) are the CSS Color Module's, as matplotlib lists them.
`lib/matplotlib/_names.py` lists the public names of matplotlib 3.11's
`Axes`, `Figure` and `pyplot` (written by `test/mpl_names_gen.py`), so that
an AttributeError can say which of them Sagebrush does not have yet.
`lib/matplotlib/_rckeys.py` is data from matplotlib 3.11.1: the name and
default value of each of its 339 rc parameters, as
`matplotlib.rcParamsDefault` gives them (from matplotlib's
`lib/matplotlib/mpl-data/matplotlibrc` and `lib/matplotlib/rcsetup.py`),
written by `test/mpl_rckeys_gen.py`; no code is copied.
`lib/matplotlib/style/_library.py` is data from matplotlib 3.11.1: the rc
settings of its style files, as `matplotlib.style.library` reads them,
written by `test/mpl_styles_gen.py`; no code is copied. Each is
`lib/matplotlib/mpl-data/stylelib/<name>.mplstyle` at matplotlib's tag
v3.11.1, distributed under the matplotlib License below (matplotlib's
`LICENSE/` directory has no other licence for these files; its
`LICENSE_SOLARIZED` covers `Solarize_Light2`, which Sagebrush does not
ship). Their own attributions, kept in `_library.py` (`HEADERS`):
`bmh.mplstyle` ("Author: Cameron Davidson-Pilon, original styles from
Bayesian Methods for Hackers"), `fivethirtyeight.mplstyle` ("Author:
Cameron Davidson-Pilon, replicated styles from FiveThirtyEight.com"),
`ggplot.mplstyle` ("from https://everyhue.me/posts/sane-color-scheme-for-matplotlib/"),
`classic.mplstyle` ("Classic matplotlib plotting style as of v1.5"), and
the sixteen `seaborn-v0_8*.mplstyle` files ("Seaborn common parameters",
"Seaborn deep palette", "Seaborn notebook context" and the like: the
seaborn styles matplotlib ships, which it renamed `seaborn-v0_8-*` in 3.6).

Copyright (c) 2012- Matplotlib Development Team; All Rights Reserved

```
License agreement for matplotlib versions 1.3.0 and later
=========================================================

1. This LICENSE AGREEMENT is between the Matplotlib Development Team
("MDT"), and the Individual or Organization ("Licensee") accessing and
otherwise using matplotlib software in source or binary form and its
associated documentation.

2. Subject to the terms and conditions of this License Agreement, MDT
hereby grants Licensee a nonexclusive, royalty-free, world-wide license
to reproduce, analyze, test, perform and/or display publicly, prepare
derivative works, distribute, and otherwise use matplotlib
alone or in any derivative version, provided, however, that MDT's
License Agreement and MDT's notice of copyright, i.e., "Copyright (c)
2012- Matplotlib Development Team; All Rights Reserved" are retained in
matplotlib  alone or in any derivative version prepared by
Licensee.

3. In the event Licensee prepares a derivative work that is based on or
incorporates matplotlib or any part thereof, and wants to
make the derivative work available to others as provided herein, then
Licensee hereby agrees to include in any such work a brief summary of
the changes made to matplotlib .

4. MDT is making matplotlib available to Licensee on an "AS
IS" basis.  MDT MAKES NO REPRESENTATIONS OR WARRANTIES, EXPRESS OR
IMPLIED.  BY WAY OF EXAMPLE, BUT NOT LIMITATION, MDT MAKES NO AND
DISCLAIMS ANY REPRESENTATION OR WARRANTY OF MERCHANTABILITY OR FITNESS
FOR ANY PARTICULAR PURPOSE OR THAT THE USE OF MATPLOTLIB
WILL NOT INFRINGE ANY THIRD PARTY RIGHTS.

5. MDT SHALL NOT BE LIABLE TO LICENSEE OR ANY OTHER USERS OF MATPLOTLIB
 FOR ANY INCIDENTAL, SPECIAL, OR CONSEQUENTIAL DAMAGES OR
LOSS AS A RESULT OF MODIFYING, DISTRIBUTING, OR OTHERWISE USING
MATPLOTLIB , OR ANY DERIVATIVE THEREOF, EVEN IF ADVISED OF
THE POSSIBILITY THEREOF.

6. This License Agreement will automatically terminate upon a material
breach of its terms and conditions.

7. Nothing in this License Agreement shall be deemed to create any
relationship of agency, partnership, or joint venture between MDT and
Licensee.  This License Agreement does not grant permission to use MDT
trademarks or trade name in a trademark sense to endorse or promote
products or services of Licensee, or any third party.

8. By copying, installing or otherwise using matplotlib ,
Licensee agrees to be bound by the terms and conditions of this License
Agreement.
```

### Dragon4 (MIT, Ryan Juckett's, as NumPy has it)

`src/runtime/numpy.ts` (`dragon4Positional`, `dragon4Scientific` and their
digit rules, and `shortestF32`, a float32's shortest digits by Dragon4's
unique mode) follows NumPy's `numpy/_core/src/multiarray/dragon4.c`: the
formatting of `FormatPositional` and `FormatScientific` (NumPy's rewrite,
BSD 3-Clause as above) and the digits `Dragon4` produces (cutoffs,
`min_digits`, rounding half to even, carries), which is Ryan Juckett's
Dragon4 as modified in NumPy, used under the MIT license with his
permission:

```
Copyright (c) 2014 Ryan Juckett

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to
deal in the Software without restriction, including without limitation the
rights to use, copy, modify, merge, publish, distribute, sublicense, and/or
sell copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS
IN THE SOFTWARE.
```

### Arm Optimized Routines (MIT, as glibc's exp, log, pow and powf)

`src/runtime/libm.ts`, `src/runtime/exp_data.ts`, `src/runtime/log_data.ts`,
`src/runtime/pow_data.ts` and `kernels/src/libm.rs` port the exp, log and pow
of Arm's Optimized Routines (as used by glibc), with their tables, and
`src/runtime/libm.ts` its powf (`math/powf.c`, with the tables of
`math/powf_log2_data.c` and `math/exp2f_data.c`). Optimized Routines is licensed
"MIT OR Apache-2.0 WITH LLVM-exception"; Sagebrush uses it under MIT.

```
Copyright (c) 2017-2026 Arm Limited.

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

### fdlibm (log1p, and the elementary functions of fdlibm.ts)

`src/runtime/libm.ts` and `kernels/src/libm.rs` port fdlibm's log1p (as in
glibc's `sysdeps/ieee754/dbl-64/s_log1p.c`). `src/runtime/fdlibm.ts` ports
fdlibm's sin, cos, tan, asin, acos, atan, atan2, exp, expm1, log, log2, log10,
log1p, sinh, cosh, tanh, asinh, acosh, atanh and hypot (most through the Rust
libm crate and musl, below).

```
Copyright (C) 1993 by Sun Microsystems, Inc. All rights reserved.

Developed at SunPro, a Sun Microsystems, Inc. business.
Permission to use, copy, modify, and distribute this
software is freely granted, provided that this notice
is preserved.
```

### The Rust libm crate, musl and CORE-MATH (MIT)

`src/runtime/fdlibm.ts` is ported line by line from the Rust libm crate 0.2.16
("available for use under the MIT license"), whose functions come from musl
libc and FreeBSD's msun (fdlibm, above) and, for cbrt, from the CORE-MATH
project (MIT). `bench/libm-oracle` compiles the crate to check the port.

```
Copyright (c) 2018 Jorge Aparicio
Copyright © 2005-2020 Rich Felker, et al. (musl libc)
Copyright (c) 2021-2022 Alexei Sibidanov (CORE-MATH's cbrt)

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

musl's notice for its math library: "Much of the math library code
(src/math/* and src/complex/*) is Copyright © 1993,2004 Sun Microsystems or
Copyright © 2003-2011 David Schultz or Copyright © 2003-2009 Steven G. Kargl or
Copyright © 2003-2009 Bruce D. Evans or Copyright © 2008 Stephen L. Moshier or
Copyright © 2017-2018 Arm Limited and labelled as such in comments in the
individual source files. All have been licensed under extremely permissive
terms."

### marimo (Apache-2.0)

`src/dataflow.ts`, which finds the names a notebook cell defines and
references, is a port of marimo's `ScopedVisitor` (`marimo/_ast/visitor.py`,
github.com/marimo-team/marimo) to TypeScript, so that the reactive notebook
has marimo's semantics. `test/marimo_oracle.py` runs marimo itself to check
the port. `src/notebook-graph.ts` and `src/notebook-reactive.ts` follow
marimo's dependency graph and runtime (`marimo/_runtime/dataflow`,
`runtime.py`), `test/marimo_graph_oracle.py` checking the graph; and
`web/notebook/marimo.js` reads and writes marimo's notebook format, checked
by `test/marimo_format_oracle.py`. marimo is under the Apache License, Version 2.0
([LICENSE-APACHE](LICENSE-APACHE)).

```
Copyright 2026 Marimo. All rights reserved.
```

### DejaVu Sans (Bitstream Vera and Arev font licenses)

The PNG module (engine/raster, wasm/sagebrush-raster.wasm) draws text with
glyph outlines, advances and kerning taken from DejaVu Sans and DejaVu Sans
Bold 2.35 (as matplotlib ships them), for Latin-1, Greek and some common
symbols: engine/raster/glyphs-dejavu-sans.bin and
glyphs-dejavu-sans-bold.bin, written by engine/raster/gen_glyphs.py.  They
are a subset in a format of Sagebrush's own, not a font, and are not named
Bitstream, Vera or Arev.  The fonts' copyright and license (their name
table's license text, unchanged):

```
Fonts are (c) Bitstream (see below). DejaVu changes are in public domain. Glyphs imported from Arev fonts are (c) Tavmjung Bah (see below)

Bitstream Vera Fonts Copyright
------------------------------

Copyright (c) 2003 by Bitstream, Inc. All Rights Reserved. Bitstream Vera is
a trademark of Bitstream, Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of the fonts accompanying this license ("Fonts") and associated
documentation files (the "Font Software"), to reproduce and distribute the
Font Software, including without limitation the rights to use, copy, merge,
publish, distribute, and/or sell copies of the Font Software, and to permit
persons to whom the Font Software is furnished to do so, subject to the
following conditions:

The above copyright and trademark notices and this permission notice shall
be included in all copies of one or more of the Font Software typefaces.

The Font Software may be modified, altered, or added to, and in particular
the designs of glyphs or characters in the Fonts may be modified and
additional glyphs or characters may be added to the Fonts, only if the fonts
are renamed to names not containing either the words "Bitstream" or the word
"Vera".

This License becomes null and void to the extent applicable to Fonts or Font
Software that has been modified and is distributed under the "Bitstream
Vera" names.

The Font Software may be sold as part of a larger software package but no
copy of one or more of the Font Software typefaces may be sold by itself.

THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT OF COPYRIGHT, PATENT,
TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL BITSTREAM OR THE GNOME
FOUNDATION BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, INCLUDING
ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL DAMAGES,
WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF
THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM OTHER DEALINGS IN THE
FONT SOFTWARE.

Except as contained in this notice, the names of Gnome, the Gnome
Foundation, and Bitstream Inc., shall not be used in advertising or
otherwise to promote the sale, use or other dealings in this Font Software
without prior written authorization from the Gnome Foundation or Bitstream
Inc., respectively. For further information, contact: fonts at gnome dot
org.

Arev Fonts Copyright
------------------------------

Copyright (c) 2006 by Tavmjong Bah. All Rights Reserved.

Permission is hereby granted, free of charge, to any person obtaining
a copy of the fonts accompanying this license ("Fonts") and
associated documentation files (the "Font Software"), to reproduce
and distribute the modifications to the Bitstream Vera Font Software,
including without limitation the rights to use, copy, merge, publish,
distribute, and/or sell copies of the Font Software, and to permit
persons to whom the Font Software is furnished to do so, subject to
the following conditions:

The above copyright and trademark notices and this permission notice
shall be included in all copies of one or more of the Font Software
typefaces.

The Font Software may be modified, altered, or added to, and in
particular the designs of glyphs or characters in the Fonts may be
modified and additional glyphs or characters may be added to the
Fonts, only if the fonts are renamed to names not containing either
the words "Tavmjong Bah" or the word "Arev".

This License becomes null and void to the extent applicable to Fonts
or Font Software that has been modified and is distributed under the
"Tavmjong Bah Arev" names.

The Font Software may be sold as part of a larger software package but
no copy of one or more of the Font Software typefaces may be sold by
itself.

THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT
OF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL
TAVMJONG BAH BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL
DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM
OTHER DEALINGS IN THE FONT SOFTWARE.

Except as contained in this notice, the name of Tavmjong Bah shall not
be used in advertising or otherwise to promote the sale, use or other
dealings in this Font Software without prior written authorization
from Tavmjong Bah. For further information, contact: tavmjong @ free
. fr.
```

### smalljac (used with the author's permission)

The a_p engine (`engine/ap`) follows the genus-1 strategy of Andrew V.
Sutherland's smalljac (with Kiran Kedlaya). On 2026-10-02 Andrew Sutherland
gave explicit permission for this port to be licensed however Sagebrush
chooses; see [engine/ap/PROVENANCE.md](engine/ap/PROVENANCE.md).

### PSAGE (used with the author's permission)

Parts of PSAGE (https://github.com/williamstein/psage, distributed under the
GNU GPL, version 3 or later) may be ported to Sagebrush with the copyright
holder's permission. William Stein is the sole author and copyright holder
of the files below; on 2026-10-14 he gave permission for them to be ported to
Sagebrush and licensed under MIT OR Apache-2.0:

- every file in `psage/modform/hilbert/sqrt5` (Hilbert modular forms over
  $\mathbb{Q}(\sqrt{5})$; see [engine/hmf/PROVENANCE.md](engine/hmf/PROVENANCE.md));
- in `psage/modform/rational` ($p$-adic $L$-series of elliptic curves and
  modular symbols): `modular_symbol_map.pyx`/`.pxd`, `newforms.py`,
  `padic_elliptic_lseries_fast.pyx`, `special.py`, `special_fast.pyx`,
  `unfiled.py`.

`psage/modform/rational/padic_lseries.py` credits Jennifer Balakrishnan with
its first version, so it is not covered: it is not ported unless she also
gives permission. Nothing else in PSAGE is covered.

## Python packages from PyPI (unchanged, pinned)

<!-- pypi-packages: generated by scripts/pypi-import.mjs; do not edit -->

### sortedcontainers 2.4.0 (Apache-2.0), from PyPI

`packages/pypi-sortedcontainers/py/` is the Python source of sortedcontainers 2.4.0's wheel, unchanged:
https://files.pythonhosted.org/packages/32/46/9cb0e58b2deb7f82b84065f37f3bffeb12413f947f9388e4cac22c4621ce/sortedcontainers-2.4.0-py2.py3-none-any.whl
(SHA-256 a163dcaede0f1c021485e957a39245190e74249897e2ae4b2aa38595db237ee0). Its license:

    Copyright 2014-2019 Grant Jenks

    Licensed under the Apache License, Version 2.0 (the "License");
    you may not use this file except in compliance with the License.
    You may obtain a copy of the License at

        http://www.apache.org/licenses/LICENSE-2.0

    Unless required by applicable law or agreed to in writing, software
    distributed under the License is distributed on an "AS IS" BASIS,
    WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
    See the License for the specific language governing permissions and
    limitations under the License.

The Apache License 2.0's full text is LICENSE-APACHE, in the repository and in each package
that carries this code.

<!-- /pypi-packages -->

## Time zone data

<!-- tzdata: generated by scripts/tzdata-import.mjs; do not edit -->

### tzdata 2026.5 (Apache-2.0), from PyPI

`tzdata/zoneinfo/` holds the zone files of tzdata 2026.5's wheel, unchanged (the IANA time
zone database, compiled; the data itself is in the public domain), which a browser reads for
its local time:
https://files.pythonhosted.org/packages/94/21/1e5995a1c920cce14e4bffae20c665ec10e7ed03ab25e006cd741092b718/tzdata-2026.5-py2.py3-none-any.whl
(SHA-256 b683bd1b6659ddcd810ff02ad09ba821d4bf1065072805063eb35c49617905ac). Its packaging's license is the Apache License 2.0
(tzdata/LICENSE, and LICENSE-APACHE in the repository and in each package that carries the files).

<!-- /tzdata -->

## Data

- `packages/cremona-small/py/_cremona_small.py`: elliptic curves of conductor below 1000 from John
  Cremona's ecdata (github.com/JohnCremona/ecdata), Artistic License 2.0
  ([LICENSE-Artistic-2.0.txt](LICENSE-Artistic-2.0.txt), ecdata's own
  LICENSE file). It is in the Python package and the `sagebrush` npm
  package, whose license metadata say so.

- `lib/_matlab_turbo.py`: Google's Turbo colormap table (Anton Mikhailov,
  Google LLC, 2019), Apache License 2.0
  ([LICENSE-APACHE](LICENSE-APACHE)), the table as published and as
  matplotlib ships it.

## Used only by tests and benchmarks (not distributed in any package)

- `upstream/micropython/`: MicroPython's test suite (MIT; its `LICENSE`).
- `conformance/upstream/`: the test suites of CPython, PyPy, GraalPy,
  IronPython and RustPython, each under its own license (the `LICENSE` file
  in its directory).
- `bench/pyperformance/`: from pyperformance (MIT;
  `LICENSE.pyperformance`).
- `scripts/vendor/acorn-8.19.0/`: acorn 8.19.0's `dist/acorn.js`, unchanged
  (MIT; its `LICENSE`). Publisher tooling only: `scripts/js-module-check.mjs`
  parses js packages with it before they are published.
- `test/vendor/just-bash-3.6.0/`: just-bash 3.6.0's CommonJS bundle,
  unchanged (Copyright 2025 Vercel Inc., Apache-2.0; its `LICENSE`), with the
  notices of the npm packages it inlines, all MIT, ISC or BSD-3-Clause
  (`THIRD-PARTY-NOTICES.txt` there). For `test/bash-oracle.test.ts` only.
- `engine/hmf/tests/fixtures/lmfdb-*.txt`: numbers (dimensions of spaces and
  of Galois orbits of Hilbert modular newforms over $\mathbb{Q}(\sqrt 5)$,
  Hecke eigenvalues of the rational ones, the exact Hecke eigenvalues (in
  their coefficient fields) of every newform orbit of level norm at most
  500, rational or not, characteristic polynomials of Hecke operators
  computed from the eigenvalues, and the class groups, narrow class groups,
  regulators and fundamental units of the real quadratic fields of
  discriminant at most 5000) from The LMFDB
  Collaboration, *The L-functions and modular forms database*,
  https://www.lmfdb.org, licensed under the Creative Commons
  Attribution-ShareAlike 4.0 International License
  (https://creativecommons.org/licenses/by-sa/4.0/; lmfdb.org/license).
  Generated by `engine/hmf/tests/fixtures/lmfdb.py`, which records the
  queries and the date in each file. Test fixtures only.
- `bench/bigint/`: a benchmark that links GMP (through `rug`) and malachite,
  both LGPL, as yardsticks for the permissive big-integer libraries. It is
  not part of any package.
- `engine/flint/`: Sagebrush's own bindings to FLINT, which is LGPL-3.0 or
  later, and `engine/oracle/`, the tests and benchmarks that use them (those
  behind `bench/linalg/` among them). No library or package links FLINT;
  `scripts/third-party-notices.mjs` fails if one would.

## In each package

Each distributed package carries its own notices: the Python package
(`engine/py`), `sagebrush` (`packages/sagebrush`) and `sagebrush-web` (`cdn`)
each have a `THIRD-PARTY-NOTICES.txt`, generated by
`scripts/third-party-notices.mjs` (checked in CI), with the derived code and
data they bundle and every Rust crate compiled into their engines, with its
license text.  The notebook page's (`sagebrush`'s file, which the web site,
the desktop app and `sagebrush notebook` serve at `/THIRD-PARTY-NOTICES.txt`)
also lists the npm packages in its bundles (`web/js-dependencies.json`,
from the bundler) with their license files, and KaTeX's fonts, which are
under the SIL Open Font License 1.1 ([LICENSES/OFL-1.1.txt](LICENSES/OFL-1.1.txt)),
not KaTeX's MIT license.  The standalone executables print all of it with
`sagebrush --licenses`, and the release archives hold the same files.

The desktop app's native code (`app/src-tauri`: Tauri, Wry, Tao, their
plugins and platform bindings, 400-odd crates) has its own,
`app/THIRD-PARTY-NOTICES-native.txt`, shipped beside the page's in the app.
Five of those crates (cssparser, cssparser-macros, dtoa-short, option-ext and
selectors, through Tauri) are under the Mozilla Public License 2.0, a file-level
copyleft: they are used unmodified, and their source is on crates.io. The
generator accepts MPL-2.0 for the app only (decided: fine for the app, as are
the AppImage's LGPL system libraries; README.md's table says which
distribution contains what). The app uses the platform's web
view; the Linux AppImage also bundles the build system's shared libraries
(GTK, WebKitGTK, ..., LGPL), which that file does not list.
