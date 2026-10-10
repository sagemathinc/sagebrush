# Licensing notice for sagebrush

This package (`dist/sagebrush.cjs` and `bin/sagebrush.cjs`) bundles:

1. **The pyjs compiler and runtime** (TypeScript from
   github.com/sagemathinc/sagebrush, `src/`). Copyright (c) 2026
   SageMath, Inc. Licensed under the MIT license or the Apache License
   2.0, at your option (`LICENSE-MIT`, `LICENSE-APACHE`). Parts derived
   from NumPy (BSD 3-Clause), Arm Optimized Routines (MIT) and fdlibm keep
   their notices, in `THIRD-PARTY-NOTICES.txt`.

2. **pyparse**, a Python 3.14 parser generated from CPython's
   `Grammar/python.gram`, `Grammar/Tokens` and `Parser/Python.asdl`, with
   TypeScript ports of parts of CPython's `Parser/` directory, and a
   Unicode character-name table generated from Python's `unicodedata`.
   Derived from CPython, Copyright (c) 2001 Python Software Foundation;
   distributed under the PSF License Agreement (`LICENSE-CPython.txt`).

3. **Python standard-library modules copied unchanged from CPython 3.14**
   (embedded as source): `operator`, `copy`, `copyreg`, `functools`,
   `reprlib`, `abc`, `_py_abc`, `_weakrefset`, `numbers`, `fractions`,
   `colorsys`, `json`, `pickle`, `_compat_pickle`. Copyright (c) 2001
   Python Software Foundation; PSF License Agreement
   (`LICENSE-CPython.txt`).

4. Other embedded Python modules (`collections`, `io`, `unittest`,
   `warnings`, `posixpath`, …) written for this project: the same terms as
   (1).

5. **Sagebrush's engines** (Rust compiled to WebAssembly, embedded), with
   the Rust crates they link: the same terms as (1) for Sagebrush's code;
   each crate's license and license text are in `THIRD-PARTY-NOTICES.txt`.
   The a_p engine ports the genus-1 strategy of Andrew V. Sutherland's
   smalljac, with his permission.

6. **John Cremona's elliptic curves** of conductor below 1000 (embedded as
   `_cremona_small.py`), from ecdata, under the Artistic License 2.0
   (`LICENSE-Artistic-2.0.txt`).
