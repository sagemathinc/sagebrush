import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// scripts/ci-paths.mjs, replayed on file lists (CI_PATHS_FILES): which suites
// a pull request's changes select.
const script = join(__dirname, "..", "..", "scripts", "ci-paths.mjs");
const dir = mkdtempSync(join(tmpdir(), "ci-paths-"));

function classify(files: string[]): Record<string, string> {
  const list = join(dir, "files.txt");
  writeFileSync(list, files.join("\n") + "\n");
  const r = spawnSync(process.execPath, [script], {
    encoding: "utf8",
    env: { ...process.env, CI_PATHS_FILES: list, GITHUB_EVENT_NAME: "pull_request", GITHUB_REF: "refs/pull/1/merge" },
  });
  assert.equal(r.status, 0, r.stderr);
  return Object.fromEntries(r.stdout.trim().split("\n").map((l) => l.split("=") as [string, string]));
}

const suites = (o: Record<string, string>) => ({ node: o.node, web: o.web, modes: o.modes, engine_smoke: o.engine_smoke, docs_only: o.docs_only });

// PR #46 (92fed5d2...1cdb39ce): Rust, the rebuilt engine artifacts and two
// fixture directories; before this change it ran no node or web suite
const pr46 = [
  "cdn/sagebrush-engine.mjs",
  "engine/classgroup/src/api.rs",
  "engine/galois/src/lib.rs",
  "engine/hmf/src/defnew.rs",
  "engine/hmf/src/fpoly.rs",
  "engine/hmf/src/gpoly.rs",
  "engine/hmf/src/newspace.rs",
  "engine/hmf/tests/factor_refusal.rs",
  "engine/modsym/src/orbits.rs",
  "engine/mpoly/src/factor.rs",
  "engine/poly/Cargo.toml",
  "engine/poly/src/budget.rs",
  "engine/poly/src/lib.rs",
  "engine/poly/src/lll.rs",
  "engine/poly/src/nf.rs",
  "engine/poly/src/tests.rs",
  "engine/poly/src/vanhoeij.rs",
  "engine/poly/tests/interrupt.rs",
  "engine/sym/src/qpoly.rs",
  "engine/sym/src/ratint.rs",
  "engine/sym/src/rewrite.rs",
  "engine/web/src/lib.rs",
  "magma-tests/test_factor_lattice.m",
  "magma-tests/test_factor_lattice.out",
  "sage-tests/test_factor_lattice.out",
  "sage-tests/test_factor_lattice.sage",
  "wasm/sagebrush-engine.wasm"
];

test("committed engine artifacts select the runtime suites", () => {
  assert.deepEqual(suites(classify(["wasm/sagebrush-engine.wasm"])), { node: "true", web: "true", modes: "true", engine_smoke: "true", docs_only: "false" });
  assert.deepEqual(suites(classify(["cdn/sagebrush-engine.mjs"])), { node: "true", web: "true", modes: "true", engine_smoke: "false", docs_only: "false" });
  assert.deepEqual(suites(classify(["lib/_sage_ffmat.py", "wasm/sagebrush-engine.wasm"])), { node: "true", web: "true", modes: "true", engine_smoke: "true", docs_only: "false" });
  assert.equal(pr46.length, 27);
  assert.deepEqual(suites(classify(pr46)), { node: "true", web: "true", modes: "true", engine_smoke: "true", docs_only: "false" });
});

test("Rust-only engine changes and prose stay narrow", () => {
  assert.deepEqual(suites(classify(["engine/poly/src/lib.rs"])), { node: "false", web: "false", modes: "false", engine_smoke: "true", docs_only: "false" });
  assert.deepEqual(suites(classify(["design/notes.md", "README.md"])), { node: "false", web: "false", modes: "false", engine_smoke: "false", docs_only: "true" });
});

test("an unknown path triggers the fast suite even beside known ones", () => {
  assert.deepEqual(suites(classify(["engine/poly/src/lib.rs", "somewhere/new.txt"])), { node: "true", web: "true", modes: "true", engine_smoke: "true", docs_only: "false" });
  assert.deepEqual(suites(classify(["design/notes.md", "somewhere/new.txt"])), { node: "true", web: "true", modes: "true", engine_smoke: "true", docs_only: "false" });
});

test("optional packages alone select no default suite; with a core change they do", () => {
  const none = { node: "false", web: "false", modes: "false", engine_smoke: "false", docs_only: "false" };
  assert.deepEqual(suites(classify(["optional/hello/py/hello/__init__.py", "optional/hello/sagebrush.json"])), none);
  assert.equal(classify(["optional/pandas/py/pandas/frame.py"]).optional_only, "true");
  assert.deepEqual(suites(classify([".github/workflows/optional.yml"])), none);
  // (the shared tooling is a script like any other, and a core change beside a package's runs the suites)
  assert.equal(suites(classify(["scripts/optional-packages.mjs"])).node, "true");
  assert.equal(suites(classify(["optional/hello/sagebrush.json", "src/pkgset.ts"])).node, "true");
});

test("the growth gate's own inputs are never docs-only (plan-growth-budget-r5 §1.5)", () => {
  for (const f of ["budgets.json", ".growth/2026-10-24-x.json", ".github/workflows/optional.yml", "scripts/size-measure.mjs", "heap-budget.json", "core-api-surface.json", "pnpm-lock.yaml"]) {
    assert.equal(classify([f]).size_inputs, "true", f);
  }
  assert.equal(classify(["design/board.md", "README.md"]).size_inputs, "false");
  // (a change to optional.yml alone selects no suite, but the checks job runs for it)
  assert.equal(classify([".github/workflows/optional.yml"]).node, "false");
});

test("engine-cpython runs on pull requests that touch the CPython package's inputs (#113 -> #132)", () => {
  const cp = (files: string[]) => classify(files).engine_cpython;
  for (const f of ["lib/_sage_nf.py", "engine/py/test_audit.py", "engine/classgroup/src/proof.rs", "engine/py/python/sagebrush/nf.py", "sage-tests/test_numberfield.sage", "test/limit-sites.json", "scripts/sync-python-package.sh", "engine/Cargo.lock", ".github/workflows/ci.yml", "somewhere/new.txt"])
    assert.equal(cp([f]), "true", f);
  // every other file the job runs or its tests read, each of which is a
  // known path that would otherwise select false (#133's review: astra2
  // CORR-PR133-1, daybreak2 CI-PATH-PR133-1, TEST-PR133-1): the job's setup
  // script, test_workspace_tools.py's schema and normPath, test_audit.py's
  // modsym fixture, and a root Cargo manifest (none today; the rule is
  // tested here, since engine/Cargo.lock is engine/'s)
  for (const f of ["scripts/ci-cpus.sh", "scripts/clippy/clippy-summary.py", "scripts/clippy/fixtures/expected.tsv", "web/workspace/schema.json", "web/workspace/paths.ts", "engine/modsym/examples/sage/eisenstein_new_dims.jsonl", "Cargo.lock", "Cargo.toml"])
    assert.equal(cp([f]), "true", f);
  for (const f of ["web/board/test-merge.mjs", "web/workspace/api.ts", "scripts/build-cli.mjs", "design/notes.md", "README.md", "app/src/main.ts", "src/runtime/progress.ts", "test/progress.test.ts", "wasm/sagebrush-engine.wasm", "cdn/sagebrush-engine.mjs"])
    assert.equal(cp([f]), "false", f);
  // the full tier always runs it
  const list = join(dir, "files.txt");
  writeFileSync(list, "README.md\n");
  const r = spawnSync(process.execPath, [script], { encoding: "utf8", env: { ...process.env, CI_PATHS_FILES: list, GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_REF: "refs/heads/x" } });
  assert.match(r.stdout, /^engine_cpython=true$/m);
});

// (plan-size-gate-dispatch-range r2): a dispatch or a schedule has no file list, yet its growth gate always
// runs on the measurement: size_inputs is true, so the gate can never take its docs-only exit there
test("a dispatch and a schedule always select the growth gate's inputs (size_inputs)", () => {
  const dir = mkdtempSync(join(tmpdir(), "ci-paths-size-"));
  const list = join(dir, "files.txt");
  writeFileSync(list, "README.md\n");
  for (const event of ["workflow_dispatch", "schedule"]) {
    const r = spawnSync(process.execPath, [script], { encoding: "utf8", env: { ...process.env, CI_PATHS_FILES: list, GITHUB_EVENT_NAME: event, GITHUB_REF: "refs/heads/x" } });
    assert.match(r.stdout, /^size_inputs=true$/m, event);
  }
  assert.equal(classify(["README.md"]).size_inputs, "false");
});

// CORR-PR133-2 (astra2): with git's rename detection, diff --name-only names
// only a rename's destination, so a file moved out of a selecting path
// selected nothing.  A real repository: engine/py/needed.py moved to
// web/needed.py, classified from git itself (a push event).
test("a rename is classified by both of its names, from a real git history", () => {
  const repo = mkdtempSync(join(tmpdir(), "ci-paths-git-"));
  const git = (...a: string[]) => {
    const r = spawnSync("git", a, { cwd: repo, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  git("init", "-q");
  mkdirSync(join(repo, "engine", "py"), { recursive: true });
  mkdirSync(join(repo, "web"));
  writeFileSync(join(repo, "engine", "py", "needed.py"), "x = 1\n".repeat(50));
  writeFileSync(join(repo, "web", "page.ts"), "export const a = 1;\n".repeat(50));
  git("add", "-A");
  git("commit", "-q", "-m", "one");
  const before = git("rev-parse", "HEAD");
  const classifyGit = () => {
    const r = spawnSync(process.execPath, [script], { cwd: repo, encoding: "utf8", env: { ...process.env, CI_PATHS_FILES: "", GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/heads/x", GITHUB_SHA: git("rev-parse", "HEAD"), GITHUB_EVENT_BEFORE: before } });
    assert.equal(r.status, 0, r.stderr);
    return Object.fromEntries(r.stdout.trim().split("\n").map((l) => l.split("=") as [string, string]));
  };
  git("mv", "engine/py/needed.py", "web/needed.py");
  git("commit", "-q", "-m", "two");
  // (git itself sees a rename here)
  assert.match(git("diff", "--name-status", "-M", before, "HEAD"), /^R\d+\s+engine\/py\/needed\.py\s+web\/needed\.py$/m);
  let o = classifyGit();
  assert.equal(o.files, "2");
  assert.equal(o.engine_cpython, "true");
  // a rename within web/ selects no CPython run (both names are web's)
  git("reset", "-q", "--hard", before);
  git("mv", "web/page.ts", "web/page2.ts");
  git("commit", "-q", "-m", "three");
  o = classifyGit();
  assert.equal(o.files, "2");
  assert.equal(o.engine_cpython, "false");
});


// The WebKit job (plan-kedlaya-webkit-ci r4): its conservative inputs on a
// pull request (astra2's classes: the compiler, capacity and limits, an
// arithmetic dependency and anything Kedlaya imports, the build and its
// dependency inputs, the test and its helpers, the classifier and the
// workflow), a path outside every known one (the fallback), never a master
// push, and always the nightly schedule and a dispatch, which have no file list.
test("the WebKit job: its inputs on pull requests, never master pushes, always nightly and dispatch", () => {
  const wk = (files: string[]) => classify(files).webkit;
  for (const f of ["src/compile.ts", "src/runtime/object.ts", "src/runtime/js-engine.ts", "lib/_sage_padic_lseries.py", "lib/_capacity.py", "lib/_limits.py", "lib/fractions.py", "lib/sage_all.py", "lib/sagebrush/progress.py", "lib/json/__init__.py", "wasm/sagebrush-engine.wasm", "web/worker.ts", "web/build.ts", "web/lib-lazy.ts", "web/lib-chunks.mts", "web/runner/index.html", "web/test-kedlaya-worker.mjs", "web/test-port.mjs", "test/kedlaya.test.ts", "scripts/build-cli.mjs", "scripts/ci-paths.mjs", "package.json", "pnpm-lock.yaml", "tsconfig.json", ".github/workflows/ci.yml", "an/unknown/path.txt"])
    assert.equal(wk([f]), "true", f);
  for (const f of ["README.md", "design/runner.md", "web/board/test-merge.mjs", "engine/classgroup/src/api.rs", "app/src/main.ts", "sage-tests/test_numberfield.sage", ".github/workflows/optional.yml"])
    assert.equal(wk([f]), "false", f);
  const run = (event: string, ref: string, files: string) => {
    const list = join(dir, "files.txt");
    writeFileSync(list, files);
    const r = spawnSync(process.execPath, [script], { encoding: "utf8", env: { ...process.env, CI_PATHS_FILES: list, GITHUB_EVENT_NAME: event, GITHUB_REF: ref } });
    assert.equal(r.status, 0, r.stderr);
    return /^webkit=(\w+)$/m.exec(r.stdout)?.[1];
  };
  assert.equal(run("push", "refs/heads/master", "lib/_sage_padic_lseries.py\n"), "false");
  assert.equal(run("schedule", "refs/heads/master", ""), "true");
  assert.equal(run("workflow_dispatch", "refs/heads/master", ""), "true");
});

test("the limits census runs on engine-only, lib and src changes even when the node suites are skipped (#155 -> #156)", () => {
  // #155's files: an engine-only change, whose node suites (which hold
  // test/limits.test.ts) were path-skipped; it merged and turned master red
  const pr155 = ["engine/hmf/Cargo.toml", "engine/hmf/src/eigen.rs", "engine/hmf/tests/eigen_stop.rs"];
  const o = classify(pr155);
  assert.equal(o.node, "false");
  assert.equal(o.census, "true");
  for (const f of ["lib/_magma.py", "src/runtime/ops.ts", "web/workspace/sync-ledger.ts", "test/limit-sites.json", "test/limit-sites-baseline.txt", "test/limit_sites.py", "test/limits.test.ts",
    "test/limit-sweep/manifest.json", "test/limit-sweep/batches.json", "test/limit_sweep.py", "test/limit_sweep_cases.py"])
    assert.equal(classify([f]).census, "true", f);
  // the unsafe boundary's inputs select it too (scripts/unsafe-inventory.mjs runs in the census job)
  for (const f of ["scripts/unsafe-inventory.mjs", "test/unsafe-allow-inventory.json", ".cargo/config.toml", "engine/.cargo/config.toml", ".github/workflows/pypi.yml", "web/package.json"])
    assert.equal(classify([f]).census, "true", f);
  // and not for files the census does not read
  for (const f of ["design/plan.md", "app/src/main.ts", "optional/x/README.md"])
    assert.equal(classify([f]).census, "false", f);
});

test("every file the limits census scans selects the census job (scripts/ci-paths.mjs's censusPaths and test/limit_sites.py agree)", () => {
  // the census's own file list (limit_sites.tracked(): lib/*.py, engine/**/*.rs,
  // src/**/*.ts and its WEB set), so a file added to the scanner cannot be
  // skipped by a pull request's path filter (astra2 and daybreak2, #160)
  const root = join(__dirname, "..", "..");
  const r = spawnSync("python3", ["-c", "import sys; sys.path.insert(0, 'test'); import limit_sites as L; print(chr(10).join(L.tracked())); print('WEB=' + ','.join(sorted(L.WEB)))"], { cwd: root, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.trim().split("\n");
  const web = lines.pop()!.slice(4).split(",").filter(Boolean);
  const scanned = lines.filter(Boolean);
  assert.ok(scanned.length > 100, `${scanned.length} scanned files`);
  // each kind of scanned file by one representative, and every file outside the three
  // directory rules (the WEB set, and anything a future rule adds) one by one
  const kinds = new Map<string, string>();
  const others: string[] = [];
  for (const f of scanned) {
    const k = /^lib\/[^/]+\.py$/.test(f) ? "lib" : f.startsWith("engine/") && f.endsWith(".rs") ? "engine" : f.startsWith("src/") && f.endsWith(".ts") ? "src" : null;
    if (k) {
      if (!kinds.has(k)) kinds.set(k, f);
    } else others.push(f);
  }
  assert.deepEqual([...kinds.keys()].sort(), ["engine", "lib", "src"]);
  for (const f of [...kinds.values(), ...others, ...web]) assert.equal(classify([f]).census, "true", f);
  assert.ok(web.includes("web/workspace/sync-ledger.ts"), web.join(","));
});

test("the unsafe boundary's routes: every build input the scanner reads selects census (one shared list), and only compiler-affecting inputs select the sweep (#234 r2 U3)", () => {
  // the known-path representatives both reviews named, outside engine/ and scripts/
  const buildInputs = ["app/src-tauri/Cargo.toml", "app/strip-appimage.sh", "conformance/diff1.sh", "cdn/publish.sh", "web/run-tests.sh",
    "test/helper.sh", "web/rust-toolchain.toml", "web/helper.rs", "bench/bigint/src/main.rs", ".cargo/config.toml", "x/.cargo/config"];
  for (const f of buildInputs) assert.equal(classify([f]).census, "true", f);
  // a rename lists both names (--no-renames), so a build input renamed out of a selecting path still selects
  assert.equal(classify(["engine/a/build.rs", "docs/build.rs.txt"]).census, "true");
  // a brand-new path of a build-input kind selects census by its kind, not by a known directory
  for (const f of ["newtool/run.sh", "newcrate/Cargo.toml", "newdir/lib.rs"]) assert.equal(classify([f]).census, "true", f);
  // the compiler sweep: engine/ (sources, manifests, the lockfile, build scripts and their inputs), cargo
  // configs and toolchain files anywhere, its own tooling and job; never a plain script or workflow edit,
  // never the unknown-path fallback
  for (const f of ["engine/modsym/src/lib.rs", "engine/Cargo.lock", "engine/flint/build.rs", "engine/x/data/t.txt", ".cargo/config.toml",
    "web/rust-toolchain.toml", "scripts/unsafe-sweep.sh", "scripts/unsafe-inventory.mjs", "scripts/build-inputs.mjs", "test/unsafe-allow-inventory.json", ".github/workflows/ci.yml"])
    assert.equal(classify([f]).unsafe_sweep, "true", f);
  for (const f of ["scripts/build-cli.mjs", "web/run-tests.sh", ".github/workflows/pypi.yml", "app/src-tauri/Cargo.toml", "newdir/unknown.xyz", "design/plan.md"])
    assert.equal(classify([f]).unsafe_sweep, "false", f);
});
