# Numbl's MATLAB test scripts (a compatibility corpus)

The test scripts of [numbl](https://github.com/flatironinstitute/numbl) (Flatiron Institute's MATLAB in the browser), vendored **unchanged** from `numbl_test_scripts/` at commit **e2396e2fc0769f91bac9f3d93f92683f27039e63** (2026-10-30). numbl is under the Apache License 2.0: `LICENSE` here is its license file, unchanged. numbl has no NOTICE file. This directory is used only by tests; nothing in it is distributed in any package (NOTICE.md, "Used only by tests and benchmarks").

Each script checks itself (`assert(...)`, then `disp('SUCCESS')`). The `%!numbl:` lines are comments, to MATLAB and to Sagebrush.

## What is here, and what was left out
- **`numbl_test_scripts/`:** numbl's tree, with each script's helper files (local functions, `@class/` and `+package/` directories, the `builtins/test_unzip_fixture.zip` fixture) where they were.
- **`scripts.txt`:** every vendored test script (953), found by numbl's own rule: a `.m` file containing `SUCCESS`, outside `@class/`, `+package/` and `wasm/` directories.
- **`expected-pass.txt`:** the scripts of `scripts.txt` that pass in Sagebrush's MATLAB mode today (the ratchet's baseline).
- **`not-matlab.txt`:** the scripts of `scripts.txt` that the ratchet runs but never pins (see "Not MATLAB" below).

Left out, each for one reason:

| left out | why |
|---|---|
| `jit/` (44 scripts) | numbl's JIT compiler, not MATLAB semantics |
| `gpu/` (6 scripts) | numbl's GPU backend (gpuArray) |
| `file_io/` (8 scripts) | host file I/O, out of the corpus' scope |
| `functions/js_user_functions/` (10 scripts, and their `.js`/`.c` helpers) | numbl's JavaScript/WebAssembly user-function extension, not MATLAB (e.g. `exist` returning 3 for a numbl JS function) |
| `builtins/test_isnumbl.m` | numbl's own `isnumbl` builtin |
| `addpath/test_no_bleed.m` | vacuous: each `error(...)` is inside a `try` whose `catch` swallows it, so it can never fail |
| `run_all.sh`, `build_native.sh`, `build_wasm.sh`, `.browser-skip` | numbl's tooling, not tests (never run) |

The corpus was assessed before it was vendored (Nov 4, 2026): in a sample of 30, 13 scripts probe real MATLAB semantics, 11 are ordinary and 5 are trivial; 25 say they were verified against MATLAB R2025b. Where a script and MATLAB's documentation disagree, the documentation wins (e.g. `reduction/test_diff_scalar_shape.m`'s comment says 0×1 and its assert says 0×0).

## Not MATLAB
These are vendored and run unchanged, but they are not held against Sagebrush: `not-matlab.txt` lists them, and the ratchet refuses them in `expected-pass.txt`. Sagebrush passing or failing one is not a MATLAB-compatibility result.

| script | why |
|---|---|
| `functions/test_ans.m`, `control_flow/for_loop_nested_funcall.m`, `control_flow/test_elseif_char_condition.m`, `functions/test_no_output_function.m`, `indexing/cell_member_chain_assign.m` | **Not valid MATLAB.** Each puts its local functions first and its script code after them. A file whose first code is `function` is a function file, and in a script MATLAB requires the local functions at the end ("Add Functions to Scripts"). Sagebrush runs them anyway (a leniency) and Octave rejects them; neither result says anything about MATLAB. |
| `arithmetic/test_power_inf_exponent.m` | **Asserts against MATLAB's documentation.** It asserts `1 .^ Inf` and `1 ^ Inf` are NaN. MathWorks' `power` page ("IEEE Compliance") lists the only cases where MATLAB departs from IEEE-754, `power(1,NaN)` and `power(NaN,0)` (both NaN); `1^Inf` isn't one, so it is IEEE's 1, as in Sagebrush and Octave. |

## The ratchet
`python3 scripts/numbl-ratchet.py` (after `pnpm run build && node scripts/build-cli.mjs`) runs every script of `scripts.txt` through the CLI's MATLAB mode. Each script runs in a copy of this tree, from its own directory, with a throwaway TMPDIR and HOME and a 60 s timeout.
- **Pass rule:** the script's last non-empty output line is exactly `SUCCESS` (numbl's rule), after setting aside the CLI's figure epilogue (the lines it prints for open figures after a script ends).
- **Red** when:
  - a script of `expected-pass.txt` fails (a regression);
  - a script of `scripts.txt` gets no result (dropped from the run);
  - numbl's discovery rule finds a different set than `scripts.txt` (a script lost or added);
  - `expected-pass.txt` names a script outside `scripts.txt`;
  - or `not-matlab.txt` names a script outside `scripts.txt`, or one that `expected-pass.txt` pins.
- **A newly passing script** is printed as `NEW PASS`: add it to `expected-pass.txt` (`--write-expected` rewrites the list from a run; use it after a reviewed fix, never to hide a regression).
- **Where it runs:** on CI's full tier only: master pushes, the nightly schedule and a dispatch. Its hook is `scripts/test-numbl-corpus.mjs` (`// ci: web-runner-sync`, a full-tier-only job), never a pull request's fast tier. A pull request's node tests run `test/numbl-ratchet.test.ts`: it keeps the hook in that job and runs the ratchet's own tests (`scripts/test-numbl-ratchet.py`, with a fake CLI, no corpus run).

## Updating
To move to a newer numbl:
1. Re-vendor from a pinned commit with the same exclusions, and update the pin above.
2. Regenerate `scripts.txt` from the tree, and `expected-pass.txt` from a run.
3. Review the diff of both lists.
