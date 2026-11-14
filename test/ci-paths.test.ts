import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prSample, SLOW, sampleSkip, slowSkip } from "./slow-tests";

// scripts/ci-paths.mjs, replayed on file lists (CI_PATHS_FILES): which suites
// a pull request's changes select.
const script = join(__dirname, "..", "..", "scripts", "ci-paths.mjs");
const dir = mkdtempSync(join(tmpdir(), "ci-paths-"));

function classify(files: string[], labels = "", env: Record<string, string> = {}): Record<string, string> {
  const list = join(dir, "files.txt");
  writeFileSync(list, files.join("\n") + "\n");
  const r = spawnSync(process.execPath, [script], {
    encoding: "utf8",
    env: { ...process.env, CI_PATHS_FILES: list, GITHUB_EVENT_NAME: "pull_request", GITHUB_REF: "refs/pull/1/merge", CI_PR_LABELS: labels, ...env },
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

test("the CPython package's own Python selects engine-cpython, not the engine's Rust jobs (#862's 624 s engine-rust)", () => {
  const o = (files: string[]) => { const r = classify(files); return { engine_smoke: r.engine_smoke, engine_cpython: r.engine_cpython, node: r.node }; };
  // (its sources and its tests: engine-cpython only, and no fallback)
  for (const f of ["engine/py/python/sagebrush/cli.py", "engine/py/python/sagebrush/remote/pair.py", "engine/py/test_remote_pair.py"])
    assert.deepEqual(o([f]), { engine_smoke: "false", engine_cpython: "true", node: "false" }, f);
  // (#862 exactly: those, and web notebook files)
  const pr862 = ["engine/py/python/sagebrush/remote/enroll.py", "engine/py/python/sagebrush/remote/pair.py", "engine/py/test_remote_pair.py",
    "web/notebook/remote-terminal-view.ts", "web/notebook/test-remote-terminal.mjs", "web/test-remote-terminal-page.mjs"];
  assert.equal(classify(pr862).engine_smoke, "false");
  assert.equal(classify(pr862).engine_cpython, "true");
  // (anything the engine compiles still selects them, alone or beside the package's Python)
  for (const f of ["engine/py/src/lib.rs", "engine/py/Cargo.toml", "engine/hmf/src/definite.rs", "engine/hmf/build.rs", "Cargo.lock", "Cargo.toml"])
    assert.equal(classify([f]).engine_smoke, "true", f);
  assert.equal(classify(["engine/py/python/sagebrush/cli.py", "engine/py/src/lib.rs"]).engine_smoke, "true");
  // (a Python file elsewhere under engine/ is not the package's: still the engine's)
  assert.equal(classify(["engine/modsym/examples/gen.py"]).engine_smoke, "true");
  // (and the full tier still runs everything)
  assert.equal(classify(["engine/py/python/sagebrush/cli.py"], "full-ci").engine_smoke, "true");
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
  // the page's modules the remote tests run under bun (test-pair-runner.mjs, remote_terminal_page.mjs), and what
  // they import
  for (const f of ["web/notebook/pair-tunnel.js", "web/notebook/remote-client.js", "web/notebook/remote-kernel.js", "web/notebook/remote-terminal.js", "web/notebook/test-pair-runner.mjs", "src/wave-policy.ts"])
    assert.equal(cp([f]), "true", f);
  for (const f of ["scripts/ci-cpus.sh", "scripts/clippy/clippy-summary.py", "scripts/clippy/fixtures/expected.tsv", "web/workspace/schema.json", "web/workspace/paths.ts", "engine/modsym/examples/sage/eisenstein_new_dims.jsonl", "Cargo.lock", "Cargo.toml"])
    assert.equal(cp([f]), "true", f);
  for (const f of ["web/board/test-merge.mjs", "web/workspace/browser.ts", "scripts/build-cli.mjs", "design/notes.md", "README.md", "app/src/main.ts", "src/runtime/progress.ts", "test/progress.test.ts", "wasm/sagebrush-engine.wasm", "cdn/sagebrush-engine.mjs"])
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
  for (const f of ["src/compile.ts", "src/runtime/object.ts", "src/runtime/js-engine.ts", "lib/_sage_padic_lseries.py", "lib/_capacity.py", "lib/_limits.py", "lib/fractions.py", "lib/sage_all.py", "lib/sagebrush/progress.py", "lib/json/__init__.py", "wasm/sagebrush-engine.wasm", "web/worker.ts", "web/build.ts", "web/lib-lazy.ts", "web/lib-chunks.mts", "web/runner/index.html", "web/test-kedlaya-worker.mjs", "web/test-port.mjs", "test/kedlaya.test.ts", "scripts/build-cli.mjs", "scripts/sandbox-env.mjs", "scripts/ci-paths.mjs", "package.json", "pnpm-lock.yaml", "tsconfig.json", ".github/workflows/ci.yml", "web/shell/panel.ts", "web/shell/panel.css", "web/shell/test-panel-pages-copy.mjs", "an/unknown/path.txt"])
    assert.equal(wk([f]), "true", f);
  for (const f of ["README.md", "design/runner.md", "web/board/test-merge.mjs", "web/shell/panel-render.ts", "web/shell/test-panel-page.mjs", "engine/classgroup/src/api.rs", "app/src/main.ts", "sage-tests/test_numberfield.sage", ".github/workflows/optional.yml"])
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

test("the engine's full tier: a pull request touching src/runtime/ selects it (and engine-wasm, its need); other paths don't; master, nightly and dispatch always", () => {
  for (const f of ["src/runtime/ops.ts", "src/runtime/object.ts"]) {
    const o = classify([f]);
    assert.equal(o.engine_full, "true", f);
    assert.equal(o.engine_smoke, "true", f);
  }
  for (const f of ["src/compile.ts", "web/x.ts", "lib/fractions.py", "engine/poly/src/lib.rs", "README.md"])
    assert.equal(classify([f]).engine_full, "false", f);
  const run = (event: string, ref: string, files: string) => {
    const list = join(dir, "files.txt");
    writeFileSync(list, files);
    const r = spawnSync(process.execPath, [script], { encoding: "utf8", env: { ...process.env, CI_PATHS_FILES: list, GITHUB_EVENT_NAME: event, GITHUB_REF: ref } });
    assert.equal(r.status, 0, r.stderr);
    return /^engine_full=(\w+)$/m.exec(r.stdout)?.[1];
  };
  assert.equal(run("push", "refs/heads/master", "README.md\n"), "true");
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
  // the temp-dir census's tool and suite too (scripts/test-temp-dirs.mjs runs in the census job)
  for (const f of ["scripts/temp-dirs.mjs", "scripts/test-temp-dirs.mjs"]) assert.equal(classify([f]).census, "true", f);
  // and not for files the census does not read
  for (const f of ["design/plan.md", "app/src/main.ts", "optional/x/README.md"])
    assert.equal(classify([f]).census, "false", f);
});

test("the app's engine subprocess (app/engine/) selects the checks job, where its suite runs, and no browser group", () => {
  for (const f of ["app/engine/serve.mjs", "app/engine/frames.mjs", "web/test-app-engine.mjs"]) {
    const o = classify([f]);
    assert.equal(o.web, "true", f);
    assert.equal(o.web_groups ?? "[]", "[]", f);
  }
  // (the rest of app/ is still the app workflow's alone)
  assert.equal(classify(["app/src-tauri/src/lib.rs"]).web, "false");
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

test("the full tier on a pull request: the full-ci label, or a sync, sharing, security or data-loss path (CI speed plan option 2)", () => {
  // one path of each class selects the full tier, and with it every suite, the WebKit job included
  for (const f of [
    "web/sync/doc.ts", "web/sync-protocol/doc-protocol.ts", "web/journal/store.js", "web/workspace/sync-outbox.ts",
    "web/workspace/doc-sync.ts", "web/notebook/sync-rows.js", "web/notebook/db-merge3.ts", "web/board/syncdb.ts",
    "web/share/files.ts", "web/share-client/upload.ts", "web/csp.ts", "web/csp-policy.mts", "web/safe-html.ts",
    "web/cloud/share/server.ts", "web/cloud/share/migrations/0009_remotes.sql", "web/cloud/remote/relay.ts",
    "web/workspace/export/run.ts", "web/workspace/db.ts", "web/workspace/api.ts", "web/workspace/migrate.ts", "web/board/export.ts",
    "web/latex/save.ts", "scripts/check-export-size.mjs",
    // (the LaTeX group's inputs: its ceiling is checked only in the full tier's web-artifacts)
    "web/latex/page.ts", "web/latex/engine/render.mjs", "web/latex/core/machine.mjs", "web/workspace/paths.ts", "scripts/latex-group.mjs",
    // (the lazy chunks' inputs outside web/latex: the agent pairing's modules)
    "web/workspace/agent-ui.ts", "web/workspace/agent-pair.ts", "web/workspace/verbs.ts", "web/workspace/notebook-edit.ts",
    "web/workspace/pair-link.ts", "web/workspace/agent-grant.ts", "web/workspace/agent-schema.ts", "src/modes.ts",
    // (what makes those bundles: the build and its helpers, and the dependencies)
    "web/build.ts", "web/build-articles.ts", "web/build-package-dir.mjs", "package.json", "pnpm-lock.yaml",
    // (the Miniflare dispatch helper: its consumers run only in web-sync.1 and web-sync.2)
    "web/miniflare-dispatch.mjs",
    // (a document's checkpoints, the client's side: its suite runs only in web-sync.1)
    "web/workspace/checkpoint.ts", "web/workspace/checkpoint-types.ts",
  ]) {
    const o = classify([f]);
    assert.equal(o.full, "true", f);
    assert.deepEqual([o.node, o.web, o.modes, o.webkit, o.engine_full], ["true", "true", "true", "true", "true"], f);
  }
  // the label alone, beside other labels, even on a prose-only change
  const labelled = classify(["README.md"], "documentation,full-ci");
  assert.equal(labelled.full, "true");
  assert.equal(labelled.docs_only, "false");
  // the fast tier: other web code, other labels, and the one big page (its author labels a save or Trash change)
  for (const f of ["web/index.html", "web/workspace/browser.ts", "web/notebook/test-start-all.mjs", "web/board/frame.ts", "web/latex/test-latex-page.mjs", "web/latex/README.md", ".github/workflows/ci.yml", "web/miniflare-dispatch.md", "web/workspace/checkpoints.ts"]) {
    assert.equal(classify([f]).full, "false", f);
  }
  assert.equal(classify(["web/index.html"], "bug,full-ci-later").full, "false");
});

test("the web jobs by area (CI speed plan option 7): a change inside one area runs that area's suites", () => {
  const ALL = ["notebook", "preload", "latex", "board-a", "board-b", "board-c", "board-unit", "terminal", "remote-preview"];
  const pick = (files: string[]) => {
    const o = classify(files);
    return { groups: JSON.parse(o.web_groups), runner: o.web_runner, export: o.web_export, lookalike: o.web_lookalike };
  };
  // the board: its browser groups and web-runner (the board frame); no export, lookalike, terminal or notebook
  for (const f of ["web/board/frame.ts", "web/graph/spring.ts", "examples/board/hello/gallery-hello.board.json", "packages/sagebrush-board/test.mjs"]) {
    assert.deepEqual(pick([f]), { groups: ["board-a", "board-b", "board-c", "board-unit"], runner: "true", export: "false", lookalike: "false" }, f);
  }
  // (the corpus's notebooks and LaTeX documents are in the notebook page and the LaTeX editor: every web group)
  for (const f of ["examples/notebook/welcome/main.ipynb", "examples/latex/article/article.tex"]) assert.deepEqual(pick([f]).groups, ALL, f);
  // the terminal panel: its group alone
  assert.deepEqual(pick(["web/shell/panel.ts"]), { groups: ["terminal"], runner: "false", export: "false", lookalike: "false" });
  // the workspace: web-runner, the export and lookalike jobs, and board-unit (the export's measure and reminder units)
  assert.deepEqual(pick(["web/workspace/browser.ts"]), { groups: ["board-unit"], runner: "true", export: "true", lookalike: "true" });
  // two areas: their union
  assert.deepEqual(pick(["web/shell/panel.ts", "web/workspace/browser.ts"]).groups, ["board-unit", "terminal"]);
  // the core page and any other web file: everything
  for (const f of ["web/index.html", "web/build.ts", "web/worker.ts", "web/notebook/kernel.ts", "web/board/frame.ts\nweb/index.html"]) {
    assert.deepEqual(pick(f.split("\n")), { groups: ALL, runner: "true", export: "true", lookalike: "true" }, f);
  }
  // the runtime (a library module): every browser group and web-runner, but not the workspace's export and lookalike
  assert.deepEqual(pick(["lib/scipy/special.py"]), { groups: ALL, runner: "true", export: "false", lookalike: "false" });
  // the full tier: everything; prose: nothing
  assert.deepEqual(pick(["web/shell/panel.ts"].concat(["web/sync/doc.ts"])), { groups: ALL, runner: "true", export: "true", lookalike: "true" });
  assert.deepEqual(pick(["README.md"]), { groups: [], runner: "false", export: "false", lookalike: "false" });
});

// The examples job (plan U7 section 2): its ids and shard matrix, here on the fixture corpus
test("examples: a change selects its examples; the engines select notebooks, boards and executable latex; the full tier all", () => {
  const root = join(__dirname, "..", "..", "test", "fixtures", "examples");
  const run = (files: string[], labels = "") => {
    const list = join(dir, "examples-files.txt");
    writeFileSync(list, files.join("\n") + "\n");
    const r = spawnSync(process.execPath, [script], {
      encoding: "utf8",
      env: { ...process.env, CI_PATHS_FILES: list, CI_EXAMPLES_ROOT: root, GITHUB_EVENT_NAME: "pull_request", GITHUB_REF: "refs/pull/1/merge", CI_PR_LABELS: labels },
    });
    assert.equal(r.status, 0, r.stderr);
    const o = Object.fromEntries(r.stdout.trim().split("\n").map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
    return { ids: JSON.parse(o.examples_ids), matrix: JSON.parse(o.examples_matrix), tiers: [o.modes, o.engine_smoke, o.census, o.full] };
  };
  assert.deepEqual(run(["README.md"]), { ids: [], matrix: [], tiers: ["false", "false", "false", "false"] });
  // (the fixture corpus is a known path too: none of the corpus's examples, and not the fallback's engine smoke and census)
  assert.deepEqual(run(["test/fixtures/examples/notebook/hello-python/main.ipynb"]), { ids: [], matrix: [], tiers: ["true", "false", "false", "false"] }, "the fixtures are not the corpus's paths");
  assert.deepEqual(run(["examples/latex/article/main.tex"]), { ids: ["latex/article"], matrix: [1], tiers: ["false", "false", "false", "false"] });
  // (an examples-only change is a known path: that example alone, and not the unknown-path fallback's every job, which
  // would turn on modes, the engine smoke and the census; examples/ is a web path on master, so node and web run)
  assert.deepEqual(run(["examples/notebook/hello-python/main.ipynb"]), { ids: ["notebook/hello-python"], matrix: [1], tiers: ["false", "false", "false", "false"] });
  assert.deepEqual(run(["src/compile.ts"]).ids, ["board/hello", "notebook/hello-python", "notebook/sage-basics"]);
  // (a LaTeX suite selects the latex examples; a web/latex source is a full-tier change on master, so every example)
  assert.deepEqual(run(["web/latex/test-latex-page.mjs"]).ids, ["latex/article"]);
  assert.deepEqual(run(["web/latex/engine/expand.ts"]).ids, ["board/hello", "latex/article", "notebook/hello-python", "notebook/sage-basics"]);
  assert.deepEqual(run(["README.md"], "full-ci").ids, ["board/hello", "latex/article", "notebook/hello-python", "notebook/sage-basics"]);
});

// (the corpus is found by its real path: a checkout whose path has a space, read as a URL's percent-encoded
// pathname, found no corpus and skipped both examples jobs; grader B1)
test("examples: ci-paths finds the corpus beside it in a checkout whose path has a space", () => {
  const top = mkdtempSync(join(tmpdir(), "ci paths "));
  mkdirSync(join(top, "scripts"));
  for (const f of ["ci-paths.mjs", "examples-lib.mjs", "size-measure.mjs", "build-inputs.mjs", "web-tests.mjs"]) cpSync(join(__dirname, "..", "..", "scripts", f), join(top, "scripts", f));
  cpSync(join(__dirname, "..", "..", "test", "fixtures", "examples"), join(top, "examples"), { recursive: true });
  const list = join(top, "files.txt");
  writeFileSync(list, "examples/latex/article/main.tex\n");
  const env: NodeJS.ProcessEnv = { ...process.env, CI_PATHS_FILES: list, GITHUB_EVENT_NAME: "pull_request", GITHUB_REF: "refs/pull/1/merge", CI_PR_LABELS: "" };
  delete env.CI_EXAMPLES_ROOT;
  const r = spawnSync(process.execPath, [join(top, "scripts", "ci-paths.mjs")], { encoding: "utf8", env });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^examples_ids=\["latex\/article"\]$/m);
  assert.match(r.stdout, /^examples_matrix=\[1\]$/m);
});


// (a job reading an output the changes job doesn't export gets '': the examples jobs once ran on it, one dying on
// fromJSON('') and the census passing with nothing run; grader, #538)
test("ci.yml: every needs.changes.outputs.X a job reads is among the changes job's outputs", () => {
  const yml = readFileSync(join(__dirname, "..", "..", ".github", "workflows", "ci.yml"), "utf8");
  const job = yml.slice(yml.indexOf("\n  changes:\n"));
  const block = job.slice(job.indexOf("\n    outputs:\n"), job.indexOf("\n    steps:\n"));
  const exported = new Set([...block.matchAll(/^      ([a-z_]+): /gm)].map((m) => m[1]));
  // (the examples jobs and their two outputs come with William's patch, /scratch/sagebrush-reviews/examples-ci-jobs:
  // agents never push workflow files; until then no job reads them, and this holds either way)
  const read = new Set([...yml.matchAll(/needs\.changes\.outputs\.([a-z_]+)/g)].map((m) => m[1]));
  assert.deepEqual([...read].filter((k) => !exported.has(k)), []);
});

test("a changed suite runs on its own pull request: its `// ci:` job, and the full tier for a full-tier-only job (#565)", () => {
  // #565's pair: the service worker and a new web-sync.2 suite (the suite is not on master: a checkout of its own)
  const root = mkdtempSync(join(dir, "root-"));
  mkdirSync(join(root, "web", "shell"), { recursive: true });
  writeFileSync(join(root, "web", "test-sw-read-stall.mjs"), "// ci: web-sync.2 order=70 chrome\n// (the stalled read)\n");
  writeFileSync(join(root, "web", "shell", "test-cross.mjs"), "// ci: web-browser/notebook order=10 chrome\n");
  const at = { CI_PATHS_ROOT: root };
  for (const files of [["web/sw.js", "web/test-sw-read-stall.mjs"], ["web/test-sw-read-stall.mjs"], ["web/sw.js"]]) {
    const o = classify(files, "", at);
    assert.deepEqual([o.full, o.web], ["true", "true"], files.join(" "));
  }
  // each full-tier-only job, by a suite of it from this checkout
  for (const f of ["web/test-pwa.mjs", "web/workspace/test-workspace-sync-ops.mjs", "web/workspace/test-doc-sync.mjs", "web/agents/test-agents-layout.mjs"]) {
    assert.equal(classify([f]).full, "true", f);
  }
  // a fast-tier suite stays fast and selects its own group, beside its area's (a terminal-area file in notebook's group)
  const o = classify(["web/shell/test-cross.mjs"], "", at);
  assert.equal(o.full, "false");
  assert.deepEqual(JSON.parse(o.web_groups), ["notebook", "terminal"]);
  assert.equal(classify(["web/board/test-ink.mjs"]).full, "false");
  // a source another area's suite tests: the board's page selects latex (test-latex-page's newLatexHere, #566)
  assert.deepEqual(JSON.parse(classify(["web/board/page.ts"]).web_groups), ["latex", "board-a", "board-b", "board-c", "board-unit"]);
  assert.deepEqual(JSON.parse(classify(["web/board/frame.ts"]).web_groups), ["board-a", "board-b", "board-c", "board-unit"]);
  // a deleted suite (not in the checkout) runs nowhere
  assert.equal(classify(["web/gone/test-gone.mjs"], "", at).full, "false");
});

test("the full-tier-only jobs ci-paths promotes for are the jobs ci.yml gates on the full tier", () => {
  const source = readFileSync(script, "utf8");
  const listed = JSON.parse(/const fullOnlyJobs = (\[[^\]]*\]);/.exec(source)![1]);
  const workflow = readFileSync(join(__dirname, "..", "..", ".github", "workflows", "ci.yml"), "utf8");
  const gated: string[] = [];
  let job = "";
  for (const line of workflow.split("\n")) {
    const m = /^  ([a-z0-9-]+):$/.exec(line);
    if (m) job = m[1];
    else if (/^    if:.*needs\.changes\.outputs\.full == 'true'/.test(line)) gated.push(job);
  }
  assert.deepEqual([...listed].sort(), gated.sort());
});

test("web_share: the share dialog's shard runs on a pull request that changes sharing or has the full-ci label, and always on master, the schedule and a dispatch", () => {
  for (const f of ["web/share/files.ts", "web/share/test-share-dialog.mjs", "web/share-client/upload.ts", "web/cloud/share/server.ts", "web/cloud/share/test-share-dialog.mjs"]) assert.equal(classify([f]).web_share, "true", f);
  // (the hosted remotes: the full tier, but no share dialog)
  assert.equal(classify(["web/cloud/remote/relay.ts"]).full, "true");
  assert.equal(classify(["web/cloud/remote/relay.ts"]).web_share, "false");
  // (the licence files alone: neither)
  assert.equal(classify(["web/cloud/README.md"]).web_share, "false");
  // (the full tier for another reason: no share dialog on the pull request)
  for (const f of ["web/sync/doc.ts", "web/build.ts", "web/workspace/agent-ui.ts"]) {
    assert.equal(classify([f]).full, "true", f);
    assert.equal(classify([f]).web_share, "false", f);
  }
  assert.equal(classify(["web/sync/doc.ts"], "full-ci").web_share, "true");
  // (the fast tier: never)
  assert.equal(classify(["web/index.html"]).web_share, "false");
  for (const [event, ref] of [["push", "refs/heads/master"], ["schedule", "refs/heads/master"], ["workflow_dispatch", "refs/heads/x"]]) {
    const list = join(mkdtempSync(join(tmpdir(), "ci-paths-")), "files");
    writeFileSync(list, "README.md\n");
    const r = spawnSync(process.execPath, [script], { encoding: "utf8", env: { ...process.env, CI_PATHS_FILES: list, GITHUB_EVENT_NAME: event, GITHUB_REF: ref } });
    assert.match(r.stdout, /^web_share=true$/m, event);
  }
});

test("slow_tests: the slow node tests (test/slow-tests.ts) run for the full-ci label, a dispatch, the schedule and the paths they test, not on a master push or another change", () => {
  for (const f of ["tsconfig.json", "package.json", "pnpm-lock.yaml", "scripts/arraybuffer-sites.mjs", "scripts/arraybuffer-sites-parity.mjs",
    "test/arraybuffer-sites.json", "test/arraybuffer-sites-parity.test.ts", "test/arraybuffer-sites.test.ts",
    "lib/_sage_padic_lseries.py", "test/kedlaya_cases.py", "test/kedlaya.test.ts", "src/local-gateway.ts", "test/local-gateway.test.ts",
    "wasm/sagebrush-engine.wasm", "engine/web/src/nmod_ops.rs", "engine/arith/src/nmod_mat.rs", "engine/bigint/src/nmod.rs", "test/nmod-fp-wasm.test.ts",
    "lib/zoneinfo/_zoneinfo.py", "lib/_zoneinfo.py", "lib/_tzrules.py", "lib/tzdata/__init__.py", "tzdata/zoneinfo/Europe/London",
    "test/zoneinfo_sweep_cases.py", "test/stdlib-zoneinfo.test.ts", "test/slow-tests.ts",
    "lib/_magma_docsearch.py", "test/magma-examples.json", "test/magma-examples.test.ts", "catalog/magma/integers.json", "test/magma-catalog.test.ts",
    "test/ff-limits.test.ts", "test/limits.test.ts"])
    assert.equal(classify([f]).slow_tests, "true", f);
  for (const f of ["src/runtime/numpy.ts", "lib/_matlab.py", "web/index.html", "README.md", "test/kernels.test.ts", "engine/web/src/lib.rs",
    "src/magma.ts", "lib/_magma.py", "catalog/python/bisect.json", "test/magma-compare.test.ts"])
    assert.equal(classify([f]).slow_tests, "false", f);
  assert.equal(classify(["lib/_matlab.py"], "full-ci").slow_tests, "true");
  assert.equal(classify(["lib/_matlab.py"], "", { GITHUB_EVENT_NAME: "schedule" }).slow_tests, "true");
  assert.equal(classify(["lib/_matlab.py"], "", { GITHUB_EVENT_NAME: "workflow_dispatch" }).slow_tests, "true");
  // (a master push runs the full tier, but not the slow tests: the nightly run is their master check)
  const push = classify(["lib/_sage_padic_lseries.py"], "", { GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/heads/master" });
  assert.equal(push.full, "true");
  assert.equal(push.slow_tests, "false");
});

test("slow_scope: the census's scripts and tables turn on the arraybuffer slow tests alone; every other slow trigger, all of them", () => {
  for (const f of ["scripts/arraybuffer-sites.mjs", "scripts/arraybuffer-sites-parity.mjs", "scripts/arraybuffer-sites-check.mjs",
    "test/arraybuffer-sites.json", "test/arraybuffer-sites.base.json", "test/arraybuffer-sites-parity.test.ts", "test/arraybuffer-sites.test.ts"]) {
    const o = classify([f]);
    assert.equal(o.slow_tests, "true", f);
    assert.equal(o.slow_scope, "arraybuffer", f);
  }
  // (the compiler and its options reach every slow test: all of them, as before)
  for (const f of ["tsconfig.json", "package.json", "pnpm-lock.yaml", "test/slow-tests.ts", "test/kedlaya.test.ts", "lib/_zoneinfo.py"])
    assert.equal(classify([f]).slow_scope, "1", f);
  // (an arraybuffer path with another slow trigger: all of them)
  assert.equal(classify(["test/arraybuffer-sites.json", "test/kedlaya.test.ts"]).slow_scope, "1");
  assert.equal(classify(["test/arraybuffer-sites.json", "src/runtime/ops.ts"]).slow_scope, "arraybuffer");
  assert.equal(classify(["test/arraybuffer-sites.json"], "full-ci").slow_scope, "1");
  assert.equal(classify(["lib/_matlab.py"], "", { GITHUB_EVENT_NAME: "schedule" }).slow_scope, "1");
  assert.equal(classify(["lib/_matlab.py"], "", { GITHUB_EVENT_NAME: "workflow_dispatch" }).slow_scope, "1");
  assert.equal(classify(["src/runtime/ops.ts"]).slow_scope, "");
  // (a master push: none, as before)
  const push = classify(["test/arraybuffer-sites.json"], "", { GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/heads/master" });
  assert.equal(push.slow_tests, "false");
  assert.equal(push.slow_scope, "");
});

test("ci.yml: node-tests sets SAGEBRUSH_SLOW_TESTS to the changes job's slow_scope", () => {
  const yml = readFileSync(join(__dirname, "..", "..", ".github", "workflows", "ci.yml"), "utf8");
  assert.match(yml, /^ {6}slow_scope: \$\{\{ steps\.paths\.outputs\.slow_scope \}\}$/m);
  assert.match(yml, /^ {10}SAGEBRUSH_SLOW_TESTS: \$\{\{ needs\.changes\.outputs\.slow_scope \}\}$/m);
});

test("Rill's recorded outputs select the node suite, which checks their provenance (design/rill.md §7.5)", () => {
  // (runtime paths, not an unknown path: the engine's smoke test isn't selected)
  assert.deepEqual(suites(classify(["rill-tests/arith/test_1.out.json", "rill-tests/PROVENANCE.json"])), { node: "true", web: "true", modes: "true", engine_smoke: "false", docs_only: "false" });

test("Sprig's recorded outputs and checker controls select the node suite, which checks them (design/sprig-mvp.md §7.5)", () => {
  assert.deepEqual(suites(classify(["sprig-tests/calc/test_1.out.json", "sprig-tests/PROVENANCE.json", "sprig-tests/checker-controls.json"])), { node: "true", web: "true", modes: "true", engine_smoke: "false", docs_only: "false" });
});
});

// test/slow-tests.ts, whose skips and sample decide what a pull request runs of the slow suites (#924)
test("prSample: n distinct items spread over the list in its order, the first included; the whole list when it has n or fewer", () => {
  const xs = Array.from({ length: 10 }, (_, i) => i);
  assert.deepEqual(prSample(xs, 3), [0, 3, 6]);
  assert.deepEqual(prSample(xs, 4), [0, 2, 5, 7]);
  assert.deepEqual(prSample(xs, 10), xs);
  assert.deepEqual(prSample(xs, 12), xs);
  assert.deepEqual(prSample([], 3), []);
  // (as the Magma examples use it: 158 sorted names, a sample of 12)
  const names = Array.from({ length: 158 }, (_, i) => `ex${String(i).padStart(3, "0")}`);
  const s = prSample(names, 12);
  assert.equal(s.length, 12);
  assert.equal(new Set(s).size, 12);
  assert.deepEqual(s, [...s].sort());
  assert.equal(s[0], names[0]);
  assert.deepEqual(s.map((x) => names.indexOf(x)), [0, 13, 26, 39, 52, 65, 79, 92, 105, 118, 131, 144]);
  assert.deepEqual(prSample(names, 12), s, "the same sample on every call");
});

test("slowSkip and sampleSkip: in every mode exactly one of a slow set and its sample runs", () => {
  // (this process's mode)
  assert.equal(slowSkip === false, SLOW);
  assert.equal(sampleSkip === false, !SLOW);
  // (each mode, in a fresh process: the module reads the environment once)
  const mod = join(__dirname, "slow-tests.js");
  const modes: [Record<string, string>, boolean][] = [
    [{}, false],
    [{ GITHUB_EVENT_NAME: "pull_request" }, false],
    [{ SAGEBRUSH_SLOW_TESTS: "0" }, false],
    [{ SAGEBRUSH_SLOW_TESTS: "1" }, true],
    [{ GITHUB_EVENT_NAME: "schedule" }, true],
    [{ GITHUB_EVENT_NAME: "workflow_dispatch" }, true],
    // (a group alone: not "slow tests on", so every other slow set is skipped and its sample runs)
    [{ SAGEBRUSH_SLOW_TESTS: "arraybuffer" }, false],
  ];
  for (const [extra, slow] of modes) {
    const env: Record<string, string | undefined> = { ...process.env, SAGEBRUSH_SLOW_TESTS: undefined, GITHUB_EVENT_NAME: undefined, ...extra };
    for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
    const r = spawnSync(process.execPath, ["-e", `const s = require(${JSON.stringify(mod)}); console.log(JSON.stringify([s.SLOW, s.slowSkip === false, s.sampleSkip === false, typeof s.slowSkip, typeof s.sampleSkip]))`], { env, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), [slow, slow, !slow, slow ? "boolean" : "string", slow ? "string" : "boolean"], JSON.stringify(extra));
  }
});

test("slowSkipFor: a group's slow tests run where every slow test does, and where its group alone is named", () => {
  const mod = join(__dirname, "slow-tests.js");
  const modes: [Record<string, string>, boolean][] = [
    [{}, false],
    [{ SAGEBRUSH_SLOW_TESTS: "0" }, false],
    [{ SAGEBRUSH_SLOW_TESTS: "kedlaya" }, false],
    [{ SAGEBRUSH_SLOW_TESTS: "arraybuffer" }, true],
    [{ SAGEBRUSH_SLOW_TESTS: "1" }, true],
    [{ GITHUB_EVENT_NAME: "schedule" }, true],
    [{ GITHUB_EVENT_NAME: "workflow_dispatch" }, true],
  ];
  for (const [extra, runs] of modes) {
    const env: Record<string, string | undefined> = { ...process.env, SAGEBRUSH_SLOW_TESTS: undefined, GITHUB_EVENT_NAME: undefined, ...extra };
    for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
    const r = spawnSync(process.execPath, ["-e", `const s = require(${JSON.stringify(mod)}); const k = s.slowSkipFor("arraybuffer"); console.log(JSON.stringify([k === false, typeof k]))`], { env, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), [runs, runs ? "boolean" : "string"], JSON.stringify(extra));
  }
});

test("wasm_build: what the modules are built from or handled by builds them on a pull request; every other event builds", () => {
  const build = (files: string[], env: Record<string, string> = {}) => classify(files, "", env).wasm_build;
  for (const f of ["engine/poly/src/lib.rs", "wasm/pins.json", "Cargo.lock", "scripts/build-mp.mjs", "scripts/build-raster.mjs",
    "scripts/wasm-fetch.mjs", "scripts/wasm-artifact.mjs", "scripts/wasm-publish.mjs", ".github/actions/wasm-modules/action.yml",
    ".github/workflows/ci.yml"]) {
    assert.equal(build([f]), "true", f);
  }
  for (const f of ["lib/_sage_ffmat.py", "web/notebook/index.ts", "design/notes.md", "src/runtime/engine.ts"]) assert.equal(build([f]), "false", f);
  // (a master push publishes its own build, and a push whose run was replaced can hide an engine change from the next)
  assert.equal(build(["lib/_sage_ffmat.py"], { GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/heads/master" }), "true");
  assert.equal(build([], { GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_REF: "refs/heads/master" }), "true");
  assert.equal(build([], { GITHUB_EVENT_NAME: "schedule", GITHUB_REF: "refs/heads/master" }), "true");
});
