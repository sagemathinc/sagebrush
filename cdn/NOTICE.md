# Licensing notice for sagebrush-web

This package bundles three components.

1. **Sagebrush engines** (`sagebrush-engine.mjs`: Rust code from
   github.com/sagemathinc/sagebrush compiled to WebAssembly).
   Copyright (c) 2026 SageMath, Inc. Licensed under the MIT license or the
   Apache License 2.0, at your option (`LICENSE-MIT`, `LICENSE-APACHE`).
   The Rust crates it links are listed, with their licenses and license
   texts, in `THIRD-PARTY-NOTICES.txt`.

   The a_p engine is a port of the genus-1 strategy of Andrew V. Sutherland's
   smalljac, used with his permission (see `engine/ap/PROVENANCE.md` in the
   repository).

2. **pyparse** (`pyparse.mjs`): a Python 3.14 parser generated from CPython's
   `Grammar/python.gram`, `Grammar/Tokens` and `Parser/Python.asdl`, with
   TypeScript ports of parts of CPython's `Parser/` directory. These
   portions are derived from CPython, Copyright (c) 2001 Python Software
   Foundation, and are distributed under the PSF License Agreement; see
   `LICENSE-CPython.txt`. The Unicode character-name table, when used, is
   generated from Python's `unicodedata`.

3. Generated glue code: the same terms as (1).
