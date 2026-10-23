# Optional packages

The design is plan-modular-packages-r4 (approved Oct 23 2026). Optional packages are Python packages kept outside the core, under `optional/<name>/`.

**They never change the core.**
- Nothing here is an input of the build id, the browser worker's manifest or the CLI bundle.
- A change only under `optional/` runs none of the default CI suites (`scripts/ci-paths.mjs`).
- `scripts/size-budget.mjs` fails a core build that grows, or that contains an optional package.

**They are published as package sets.** A set is content-addressed: its id is the SHA-256 of its index, and the index pins every chunk and file. A notebook pins the set it runs with.

**Hosts.** Every host checks every byte against those pins before using it (`src/pkgset.ts`):
- the browser worker (`web/pkgset-browser.ts`, and the service worker's rule in `web/sw.js`);
- the CLI (`sagebrush --pkgset ID|FILE`, `src/pkgcache.ts`);
- the grader's Dynamic Worker child (`installPackageSet` + `premountPackages`).

## A package

```
optional/<name>/
  sagebrush.json      name "@sagebrush/<name>", version, kind "optional", modes,
                      python {root, modules}, requires (exact ids), private_prefix,
                      provides (optional), oracle (optional), files (every shipped file -> SHA-256)
  py/...              the shipped files (python.root)
  tests/test_*.py     programs whose printed output is checked (tests/test_*.out, or the oracle)
  known.json          accepted differences from the oracle, each with a reason
  contract-declarations.json   reviewed exceptions to the contract lint, one exact line each
  README.md
```

## The contract

Optional packages are **reviewed first-party code**. `scripts/optional-packages.mjs check` is a contract lint, not a sandbox.

**A package may use:**
- the public names in `core-api-surface.json` (modules, their names and their public types' members, with the level each appeared at);
- the documented protocols (`_repr_html_`, `__array__`, the number and sequence dunders, …);
- its own names.

**Banned whatever their arguments:**
- reflection and dynamic import (`importlib`, `__import__`, `builtins`, `eval`/`exec`/`compile`, `getattr`/`setattr`/`hasattr`/`vars`/`dir`, `__dict__`, `sys.modules`), and aliases of them;
- private core names;
- changing core modules or types.

A package-private attribute on anything but `self`/`cls` starts with the package's `private_prefix`.

A reviewed exception is one entry in `contract-declarations.json`: `{file, line, construct, target, reason}`, plus, for a dynamic access, `access` (the core name it reaches) and `call` (the parameter names it passes). A declared access counts as a use of `access`, at the level of the parameters in `call`. Without `call`, it takes that name's highest parameter level.

**The lint computes the package's `core_req`:** the highest level its uses need, including the levels of the parameters its calls pass. An older engine refuses a set that needs more.

## Commands

```
node scripts/optional-packages.mjs check [NAME...]
node scripts/optional-packages.mjs build --out DIR [--pre] [--costs FILE] [NAME...]   # prints the set id
node scripts/optional-packages.mjs test --pkgset DIR/pkgset/<id>.json [NAME...]
node build/cli/pyjs.cjs --pkgset DIR/pkgset/<id>.json -c "import hello; print(hello.greet())"
```

The tier is `.github/workflows/optional.yml`. A core change that adds to the public surface records it with `node scripts/core-api-surface.mjs --update`, which raises the level, and sets `CORE_API_LEVEL` in `src/pkgset.ts` to match.
