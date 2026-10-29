# Developing Sagebrush: build everything, run every test

From a clean checkout, two commands:

```sh
scripts/build-all.sh    # everything: the engine, the CLI, the notebook, the Node addon, the Python wheel, the desktop app
scripts/test-all.sh     # every Linux job of CI, read from .github/workflows/ci.yml itself
```

Both are short scripts you can read. `test-all.sh` doesn't keep its own list of tests: it runs ci.yml's jobs
(scripts/ci-local.py), so it follows CI, and it refuses a workflow construct it doesn't model rather than guess. The timings below were measured on a 16-core x86_64 Ubuntu 24.04 VM from a fresh
clone (October 28, 2026).

## Prerequisites (Linux; Ubuntu 24.04 shown)

CI's versions, which some checks need exactly:

| tool | version | why this one | install |
|---|---|---|---|
| Rust | via rustup | `engine/rust-toolchain.toml` pins the engine's toolchain (1.99.1, with `wasm32-unknown-unknown`); rustup installs it on first use | `curl https://sh.rustup.rs -sSf \| sh` |
| Node.js | **24.21.0** | `heap-budget.json` records V8's load heap, which differs between Node versions | [nodejs.org](https://nodejs.org/dist/v24.21.0/), or `fnm install 24.21.0` |
| pnpm | 11 | the lock file is pnpm's (`npm ci` doesn't apply) | `npm install -g pnpm@11` |
| bun | **1.4.4** | `size-budget.json` records exact bytes, and bun's output differs between releases | `curl -fsSL https://bun.sh/install \| bash -s bun-v1.4.4` |
| Deno | 2.x | a few tests and the conformance suite run under Deno too | `curl -fsSL https://deno.land/install.sh \| sh` |
| uv | any recent | makes the Python 3.14 venv (`engine/.venv`) both scripts use | `curl -LsSf https://astral.sh/uv/install.sh \| sh` |
| Python | 3.14 (CI's); the package itself needs 3.10+ | installed by uv: `uv python install 3.14` | |
| Google Chrome | stable, as `google-chrome` | the browser tests drive it headless | [google.com/chrome](https://www.google.com/chrome/) |
| the Tauri 2 CLI | `^2` | the desktop app (`tauri build`) | `npm install -g @tauri-apps/cli@^2` |
| WebKitGTK and friends | Ubuntu's | the desktop app on Linux, as `.github/workflows/app.yml` installs | `sudo apt-get install libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf` |

maturin (the Python wheel's builder) and PyYAML (for `ci-local.py`) are installed into `engine/.venv` by the
scripts; nothing is installed into your system Python.

## Build everything

```sh
scripts/build-all.sh             # about 6.5 min here (pnpm's store and cargo's registry already downloaded)
scripts/build-all.sh --no-app    # without the desktop app (no Tauri CLI or WebKitGTK needed)
scripts/build-all.sh --no-engine # keep the committed wasm/sagebrush-engine.wasm
```

It runs these steps, in this order, and prints each one's time:

| step | command | output | time (warm) |
|---|---|---|---|
| dependencies | `pnpm install --frozen-lockfile` | `node_modules/` | 1 s |
| the engine | `node scripts/build-engine.mjs` (paths mapped, below) | `wasm/sagebrush-engine.wasm` | 35 s |
| TypeScript | `pnpm run build` | `dist/` | 2 s |
| the CLI | `node scripts/build-cli.mjs` | `build/cli/pyjs.cjs` | 1 s |
| the notebook page | `bun web/build.ts` | `web/dist/` | 17 s |
| the CLI again | `node scripts/build-cli.mjs` (it embeds the page's assets) | `build/cli/` | 1 s |
| the board package | `bun build.mjs` in `packages/sagebrush-board` | `packages/sagebrush-board/` | 0 s |
| the Node addon | `engine/node/build.sh` | `engine/node/sagebrush.node` | 21 s |
| Python 3.14 and maturin | `uv venv` and `uv pip install maturin` | `engine/.venv/` | 0 s |
| the Python wheel | `maturin build --release` in `engine/py` | `engine/py/dist/*.whl` | 120 s |
| the MCP package | `uv build engine/py-mcp` | `engine/py-mcp/dist/` | 1 s |
| the app's page | `node app/build-frontend.mjs` | `app/dist/` | 0 s |
| the desktop app | `tauri build` in `app/src-tauri` | `.deb`, `.rpm` and AppImage in `app/src-tauri/target/release/bundle/` | 191 s |

Notes:

- **The engine and the committed `wasm/sagebrush-engine.wasm`.** Building the engine writes over the committed
  module, and with the pinned toolchain it's byte-identical to it. The module embeds its crates' source paths
  (`$CARGO_HOME/registry/...`), so `build-all.sh` maps yours to CI's (`--remap-path-prefix=...=/home/runner/.cargo`,
  as the README shows). Without that, a plain `node scripts/build-engine.mjs` differs by a few bytes: the same
  engine, but `git diff` shows it. `git checkout -- wasm/` puts the committed one back. CI's `engine-wasm` job
  checks that a fresh build equals the committed module (an error on master, a warning on a pull request).
  `test-all.sh` runs that job as CI does, without the mapping, so locally it only warns.
- **The atlas data** (`web/dist/atlas/data`, about 50 MB of JSON) isn't built by default: `bun web/build.ts` says
  it's missing. It's rebuilt from the engine as [web/atlas/README.md](web/atlas/README.md) describes, and needs the
  LMFDB slice it compares against.
- **The cloud site** (sagebrush.space's Worker) is built and deployed from the cloud repository, not here.
- **Other platforms.** On macOS and Windows the app and the wheels build the same way (Tauri's and maturin's own
  prerequisites); CI builds them in `app.yml` and `pypi.yml`.

## Run every test

```sh
scripts/test-all.sh                  # every Linux job; about 3.5 hours here, one job at a time
scripts/test-all.sh --list           # the jobs and their matrices, and what only CI can run
scripts/test-all.sh --only checks    # one job, or a comma-separated list
scripts/test-all.sh --keep-going     # report every failing job, not just the first
```

Each job starts from a fresh checkout's generated state, as on CI: `build/cli`, `web/dist` and `engine/py/dist` are
removed before it, and it runs its own build lines. That costs a few minutes over the whole run, and it's needed: a
CLI built while `web/dist` exists carries the page, and a bundle that carries its page runs `sagebrush board open`
as an installed CLI does, with its engine from sagebrush.space rather than your checkout. `web/test-board-open.mjs`
would then wait for an engine that was never deployed. Each job keeps CI's time limits: the job's `timeout-minutes`
is one budget for all its steps, even past a step marked continue-on-error. What a step leaves running carries on
into the job's later steps, as on CI, and is ended (found by ancestry) before the next job. If something won't end,
the whole run stops there, even with `--keep-going`, and leaves everything as it is for inspection. At the end, the
committed engine is put back only over this run's own engine-wasm build; any other change to it is left and reported.
One known difference from CI: when a step runs past its own `timeout-minutes`, everything still running under the
run is ended, including what earlier steps of the same job left in the background; on CI only that step's
processes go. A later `continue-on-error` step that relied on such a background process won't have it here.

`build-all.sh` first isn't needed: each job builds what it needs, as in CI. The jobs, in the order they run, with
their times here:

| job | what it runs | time |
|---|---|---|
| `changes` | the tier a change needs; core imports no server code | 0.0 min |
| `census` | the limits census and the limits sweep's manifest | 0.3 min |
| `node-tests` (8 shards) | the Node tests (`dist/test`, `target`) | 24.0 min |
| `language-node` (6 shards) | the Magma and MATLAB case tests under Node | 23.2 min |
| `checks` | security, bundles, generated files and web assets; the size record; the npm package metrics; Mermaid | 3.9 min |
| `web-sync` | sharing, sync, the engines and the PWA, in Chrome | 22.2 min |
| `web-runner` | the runner, the workspace and the board frame, in Chrome | 11.8 min (8 cores; below) |
| `interrupt-matrix` | Stop and Ctrl-C across hosts and modes (CI's set) | 6.5 min |
| `web-browser` (5 groups) | the notebook's and the boards' browser suites | 40.6 min |
| `conformance` (Node, Deno, Bun) | the catalog's examples and coverage | 1.5 min |
| `modes` (4 groups) | the Sage, Magma and MATLAB, numeric and other modes | 7.3 min |
| `engine-rust` | `cargo test` over the engine's workspace | 5.6 min |
| `engine-unsafe-sweep` | the unsafe boundary's compiler sweep | 0.4 min |
| `engine-wasm` | a fresh WebAssembly engine, built and smoke-tested | 1.3 min |
| `engine-node` (8 shards) | the Node tests on that fresh engine | 24.8 min |
| `engine-language` (6 shards) | the Magma and MATLAB tests on it | 24.2 min |
| `engine-modes` | Sage, calculus, Magma and MATLAB on it | 4.2 min |
| `engine-cpython` | the CPython extension, audit regressions, MCP and Sage | 4.3 min (warm; below) |

The engine jobs run last: `engine-wasm` builds a fresh engine, and the `engine-*` jobs after it test that engine,
as in CI. The committed engine is restored at the end.

The times were measured on the 16-core VM, except `web-runner`'s, which was measured alone on an 8-core VM. In the
full run its step stopped at a failure (since fixed: the first paragraph of this section), so the time there
didn't cover the whole step.

Each job keeps CI's `timeout-minutes`. The first `engine-cpython` builds the CPython extension with
`maturin build --release` from cold (CI restores a Rust cache), and that can take it past its 15 min limit.
Run `scripts/test-all.sh --only engine-cpython` again: with the build warm it takes about 4 minutes here. Running
`scripts/build-all.sh` first does the same: its wheel build uses the same cargo target and profile, so it leaves
engine-cpython's warm. `--only engine-node` (or any `engine-*` job without `engine-wasm`) tests the engine already
in `wasm/`, not a fresh one.

**What only CI runs:**

- `size-base` and `size-gate`: the growth gate, which needs the base's size record from GitHub;
- `ci`: the aggregate of the others;
- `webkit`: it installs Playwright's WebKit with `sudo apt`. Run it with `scripts/test-all.sh --webkit` where that's fine;
- the other workflows:
  - `app.yml`: the desktop app on macOS, Windows and Linux, with its self-test;
  - `pypi.yml`: the wheels on five platforms, and Python 3.10 and 3.11;
  - `release.yml`;
  - and those for the npm packages.

## Faster loops

A full run is for before a pull request. While working:

```sh
pnpm install --frozen-lockfile && pnpm run build   # the TypeScript
node --test dist/test/<name>.test.js               # one Node test file
node scripts/build-cli.mjs && bun web/build.ts     # the CLI and the notebook page
python3 web/serve.py 8765                          # serve web/dist on http://127.0.0.1:8765/
(cd engine && cargo test -p sagebrush-<crate>)     # one engine crate
scripts/test-all.sh --only checks                  # the bundle, size and generated-file checks
```
