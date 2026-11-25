# Where things are in Sagebrush

A map for finding code, kept short. Every path below exists (`scripts/test-index-md.mjs` checks this). For how to build and test, see [DEVELOPMENT.md](DEVELOPMENT.md); for what Sagebrush is, [PRODUCT.md](PRODUCT.md).

## The engine: mathematics in Rust

- `engine/`: the Rust workspace, one crate per area. `engine/Cargo.toml` lists them all.
  - `engine/bigint/`: big integers.
  - `engine/arith/`: exact arithmetic: word-size moduli, NTTs, polynomials over Z/n, Z and Q, dense matrices.
  - `engine/poly/`: factoring polynomials over Z (Zassenhaus, van Hoeij).
  - `engine/mpoly/`: sparse multivariate polynomials (Groebner bases build on these).
  - `engine/sym/`: symbolic expressions: simplification, printing, LaTeX, calculus.
  - `engine/nd/`: numerics: dense column-major kernels (the numpy and MATLAB side).
  - `engine/mp/`: multiprecision floats and elementary functions (mpmath's arithmetic).
  - `engine/glibm/`: glibc's log and pow, ported bit for bit (shared by the wasm modules that need CPython's float bits).
  - `engine/ball/`: ball arithmetic for certified results.
  - Number theory:
    - `engine/primes/`, `engine/ap/` (traces of Frobenius), `engine/lfun/` (L-functions), `engine/modsym/` (modular symbols);
    - `engine/galois/` (Galois groups), `engine/classgroup/`, `engine/hmf/` (Hilbert modular forms), `engine/group/` (permutation groups).
  - `engine/raster/`: PNG output.
  - Running safely: `engine/interrupt/` (Ctrl-C), `engine/ledger/` (memory accounting).
  - `engine/oracle/` and `engine/flint/`: tests and timings against FLINT, as a reference only, never a dependency.
- Bindings:
  - `engine/web/`: WebAssembly, for the browser;
  - `engine/node/`: the Node addon;
  - `engine/py/`: the Python wheel, `pip install sagebrush`;
  - `engine/py-mcp/`: the MCP server package.
- `kernels/`: further Rust kernels built for the page.

## Running Python, Sage, Magma and MATLAB

- `pyparse/`: Python 3.14's parser, generated in TypeScript from CPython's own grammar.
- `src/`: the compiler and runtime ("pyjs"): Python to JavaScript, the CLI, the Jupyter kernel and boards.
  - `src/compile.ts`, `src/cli.ts`, `src/kernel.ts`.
  - The other syntaxes are translated here too: `src/magma.ts`, `src/matlab.ts`.
- `lib/`: the Python library the runtime imports: the standard library, numpy and scipy, matplotlib and plotly, and the modes.
  - Sage: `lib/sage_all.py`.
  - Magma: `lib/_magma.py`.
  - MATLAB: `lib/_matlab.py` and the other `lib/_matlab_*.py`.
- `catalog/`: every function each mode offers, with its signature and docs (what `sb --search` and agents read).

## The web app (sagebrush.space)

- `web/`: the browser build. `web/README.md` describes it, and `web/build.ts` builds it.
  - `web/notebook/`: the notebook page.
  - `web/board/`: boards.
  - `web/latex/`: the LaTeX editor.
  - `web/workspace/`: files, the workspace and the account menu.
  - `web/agents/`: the Agents page.
  - `web/docs/`: the docs pages.
  - `web/sync/`: sync.
  - `web/share/`: sharing.
  - `web/cloud/`: the cloud servers (Workers).
- `app/`: the desktop app (Tauri), with `app/src-tauri/` in Rust.

## Design, articles and tests

- `design/`: design notes, one per feature.
- `articles/`: the articles on sagebrush.space.
- `test/`: TypeScript tests.
  - `sage-tests/`, `magma-tests/`, `matlab-tests/`, `numpy-tests/`, `scipy-tests/`: each mode's conformance tests.
- `scripts/`: build, CI and release scripts.
