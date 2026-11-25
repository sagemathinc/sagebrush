import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prSample, SLOW, sampleSkip, slowSkip } from "./slow-tests";

// scripts/ci-paths.mjs, replayed on file lists (CI_PATHS_FILES): which suites
// a pull request's changes select.
const script = join(__dirname, "..", "..", "scripts", "ci-paths.mjs");
// (the refs of the run these tests are in never reach the script: a pull request into a track/* branch would make
// every replay build the modules, scripts/pin-policy.mjs)
for (const name of ["GITHUB_BASE_REF", "GITHUB_HEAD_REF", "GITHUB_REF_NAME"]) delete process.env[name];
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

// (the CI capacity ruling, Nov 22 2026, item 2: prose no code reads is docs-only, and the site's articles and blog are
// web's, not the unknown-path fallback that ran the engine's jobs too)
const prose = ["DEVELOPMENT.md", "DOCTESTS.md", "NUMPY.md", "PLAN.md", "PLOTTING.md", "PRODUCT.md", "SECURITY-MODEL.md"];
test("prose no code reads is docs-only: the other top-level pages, docs/'s pages, the friction notes", () => {
  const docs = { node: "false", web: "false", modes: "false", engine_smoke: "false", docs_only: "true" };
  for (const f of [...prose, "docs/agent-readable-code.md", "notes/friction/2026-11-19-cli-markov.md", "notes/friction/x/evidence.json", "notes/friction/x/a.tar.gz"])
    assert.deepEqual(suites(classify([f])), docs, f);
  assert.deepEqual(suites(classify(["SECURITY-MODEL.md", "notes/friction/x/REPORT.md", "design/a.md"])), docs);
  assert.equal(classify(["notes/friction/x.md"]).wasm_build, "false");
  // (and what code reads is not: NOTICE.md (the notices' and imports' scripts, the packages), docs/schemas/
  // (lib/sagebrush/records.py, test/records.test.ts), a file under docs/ that isn't a page, a new top-level page)
  for (const f of ["NOTICE.md", "docs/schemas/record.json", "docs/schemas/a.md", "docs/x.json", "NEW.md"])
    assert.equal(classify([f]).docs_only, "false", f);
  assert.equal(classify(["docs/schemas/record.json"]).node, "true");
  // (prose beside code is code's)
  assert.equal(classify(["PLAN.md", "src/emit.ts"]).docs_only, "false");
  assert.equal(classify(["PLAN.md", "src/emit.ts"]).node, "true");
});

test("prose classified docs-only is read by no code: no tracked file names one as a path", () => {
  const root = join(__dirname, "..", "..");
  // The public-text baseline lists prose paths as hygiene debt, not as build or runtime inputs.
  const grep = (pattern: string) => {
    const r = spawnSync("git", ["grep", "-nIE", pattern, "--", ":!design/", ":!notes/", ":!docs/*.md", ":!*.md", ":!test/ci-paths.test.ts", ":!scripts/public-text-allowlist.json"], { cwd: root, encoding: "utf8" });
    assert.ok(r.status === 0 || r.status === 1, r.stderr);
    return r.stdout.trim();
  };
  // (a page's name as a string, as reading it would need: `join(root, "PLAN.md")`, `"../NUMPY.md"`)
  const names = prose.map((f) => f.replace(".", "\\.")).join("|");
  assert.equal(grep(`["'\`/](${names})["'\`]`), "", "a top-level page named as a path");
  // (docs/'s pages by name; the folder itself only as web/docs/, the site's, whose build reads its own)
  const pages = spawnSync("git", ["ls-files", "docs/*.md"], { cwd: root, encoding: "utf8" }).stdout.split("\n").filter((f) => /^docs\/[^/]+\.md$/.test(f));
  assert.ok(pages.length > 0);
  assert.equal(grep(`(${pages.map((f) => f.replace(/[.]/g, "\\.")).join("|")})`), "", "a docs/ page named as a path");
  // (the notes: by their folder, or the repository's notes/ joined)
  assert.equal(grep(`["'\`](\\.\\./)*notes/friction|join\\((root|ROOT|repo|repoRoot)[^)]*["'\`]notes["'\`]`), "", "the notes named as a path");
  // (the control: NOTICE.md, which scripts read, is found)
  assert.notEqual(grep(`["'\`/]NOTICE\\.md["'\`]`), "");
});

test("the site's articles and blog are web's core: the web jobs and checks, not the engine's", () => {
  for (const f of ["articles/architecture/index.md", "articles/groebner/a.board.json", "blog/sagebrush.md", "blog/sagebrush.png"]) {
    const o = classify([f]);
    assert.deepEqual(suites(o), { node: "true", web: "true", modes: "false", engine_smoke: "false", docs_only: "false" }, f);
    assert.deepEqual([o.wasm_build, o.engine_full, o.engine_cpython, o.unsafe_sweep], ["false", "false", "false", "false"], f);
    assert.deepEqual(JSON.parse(o.web_groups).length, 10, f);
  }
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

test("the size comparison's own inputs are never docs-only", () => {
  for (const f of [".github/workflows/optional.yml", "scripts/size-measure.mjs", "heap-budget.json", "core-api-surface.json", "pnpm-lock.yaml"]) {
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
  // (no module is built from it, and the CLI the examples run doesn't run it: no modules' build, no examples; the CI
  // capacity ruling, Nov 22 2026, item 2.  Its pyo3 crate's Rust, engine/py/src/, still builds them)
  for (const f of ["engine/py/python/sagebrush/mcp_server.py", "engine/py/test_mcp.py"]) {
    const r = classify([f]);
    assert.deepEqual([r.wasm_build, r.examples_matrix], ["false", "[]"], f);
  }
  assert.equal(classify(["engine/py/src/lib.rs"]).wasm_build, "true");
  assert.notEqual(classify(["engine/py/src/lib.rs"]).examples_matrix, "[]");
  assert.equal(classify(["engine/py/python/sagebrush/cli.py"], "full-ci").examples_matrix === "[]", false);
});

test("Python tests invoked by checks select node, derived from this checkout's workflow", () => {
  const root = mkdtempSync(join(dir, "python-checks-"));
  mkdirSync(join(root, ".github", "workflows"), { recursive: true });
  const workflow = join(root, ".github", "workflows", "ci.yml");
  writeFileSync(workflow, `jobs:
  checks:
    steps:
      - run: |
          node dist/src/cli.js engine/py/test_matrix_checks.py
          python3 engine/py/test_other_checks.py
          timeout 600 node dist/src/cli.js engine/py/test_a.py
          uv run python engine/py/test_b.py
          node dist/src/cli.js \\
            engine/py/test_continued.py
          # node dist/src/cli.js engine/py/test_commented.py
          echo engine/py/test_mentioned.py
          printf '%s' engine/py/test_printed.py
  engine-cpython:
    steps:
      - run: python3 engine/py/test_remote_pair.py
`);
  const env = { CI_PATHS_ROOT: root };
  for (const path of ["engine/py/test_matrix_checks.py", "engine/py/test_other_checks.py", "engine/py/test_a.py", "engine/py/test_b.py", "engine/py/test_continued.py"]) {
    const result = classify([path], "", env);
    assert.equal(result.node, "true", path);
    assert.equal(result.engine_cpython, "true", path);
    assert.equal(result.engine_smoke, "false", path);
    assert.equal(result.web, "false", path);
  }
  for (const path of ["engine/py/test_remote_pair.py", "engine/py/test_commented.py", "engine/py/test_mentioned.py", "engine/py/test_printed.py", "engine/py/test_matrix_checks.py.bak"])
    assert.equal(classify([path], "", env).node, "false", path);
  // A new command needs no matching classifier edit or hard-coded filename.
  writeFileSync(workflow, `jobs:\n  checks:\n    steps:\n      - run: node dist/src/cli.js engine/py/test_future.py\n  other:\n    steps: []\n`);
  assert.equal(classify(["engine/py/test_future.py"], "", env).node, "true");
  assert.equal(classify(["engine/py/test_matrix_checks.py"], "", env).node, "false");
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
  for (const f of ["src/compile.ts", "web/latex/editor.ts", "web/latex/style.ts", "web/latex/test-latex-webkit-wrap.mjs", "src/runtime/object.ts", "src/runtime/js-engine.ts", "lib/_sage_padic_lseries.py", "lib/_capacity.py", "lib/_limits.py", "lib/fractions.py", "lib/sage_all.py", "lib/sagebrush/progress.py", "lib/json/__init__.py", "wasm/sagebrush-engine.wasm", "web/worker.ts", "web/build.ts", "web/lib-lazy.ts", "web/lib-chunks.mts", "web/runner/index.html", "web/test-kedlaya-worker.mjs", "web/test-port.mjs", "test/kedlaya.test.ts", "scripts/build-cli.mjs", "scripts/sandbox-env.mjs", "scripts/ci-paths.mjs", "package.json", "pnpm-lock.yaml", "tsconfig.json", ".github/workflows/ci.yml", "web/shell/panel.ts", "web/shell/panel.css", "web/shell/test-panel-pages-copy.mjs", "an/unknown/path.txt"])
    assert.equal(wk([f]), "true", f);
  for (const f of ["README.md", "web/latex/test-latex-page.mjs", "design/runner.md", "web/board/test-merge.mjs", "web/shell/panel-render.ts", "web/shell/test-panel-page.mjs", "engine/classgroup/src/api.rs", "app/src/main.ts", "sage-tests/test_numberfield.sage", ".github/workflows/optional.yml"])
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

test("the engine's full passes: master and track pushes, a pull request that rebuilds the engine, and the long tier; not another pull request, a label or a plain dispatch", () => {
  // (a pull request whose changes rebuild the engine (wasm_build): its fresh engine may differ from the published pin)
  for (const f of ["engine/poly/src/lib.rs", "wasm/pins.json", "Cargo.lock", "scripts/build-mp.mjs", ".github/actions/wasm-modules/action.yml", ".github/workflows/ci.yml"]) {
    const o = classify([f]);
    assert.equal(o.wasm_build, "true", f);
    assert.equal(o.engine_full, "true", f);
    assert.equal(o.engine_smoke, "true", f);
  }
  // (the engine's runtime: engine-wasm's smoke test still, but its fresh engine is the pin's bytes: no full pass)
  for (const f of ["src/runtime/ops.ts", "src/runtime/object.ts"]) {
    const o = classify([f]);
    assert.equal(o.engine_full, "false", f);
    assert.equal(o.engine_smoke, "true", f);
  }
  for (const f of ["src/compile.ts", "web/x.ts", "lib/fractions.py", "README.md", "web/sync/doc.ts"])
    assert.equal(classify([f]).engine_full, "false", f);
  // (wasm_build without engine-wasm, which the passes need: the modules' fetcher)
  for (const f of ["scripts/wasm-fetch.mjs"]) {
    const o = classify([f]);
    assert.deepEqual([o.wasm_build, o.engine_smoke, o.engine_full], ["true", "false", "false"], f);
  }
  // (and neither: the CPython package's own Python, in no module (the CI capacity ruling, Nov 22 2026, item 2))
  for (const f of ["engine/py/python/sagebrush/cli.py", "engine/py/test_mcp.py"]) {
    const o = classify([f]);
    assert.deepEqual([o.wasm_build, o.engine_smoke, o.engine_full], ["false", "false", "false"], f);
  }
  // (the full-ci label: the full tier, not the engine's passes)
  const labelled = classify(["lib/_matlab.py"], "full-ci");
  assert.equal(labelled.full, "true");
  assert.equal(labelled.engine_full, "false");
  const run = (event: string, ref: string, files: string, env: Record<string, string> = {}) => {
    const list = join(dir, "files.txt");
    writeFileSync(list, files);
    const r = spawnSync(process.execPath, [script], { encoding: "utf8", env: { ...process.env, CI_PATHS_FILES: list, GITHUB_EVENT_NAME: event, GITHUB_REF: ref, CI_LONG: "", ...env } });
    assert.equal(r.status, 0, r.stderr);
    return Object.fromEntries(r.stdout.trim().split("\n").map((line) => line.split("=") as [string, string]));
  };
  assert.equal(run("push", "refs/heads/master", "README.md\n").engine_full, "true");
  const trackEngine = run("push", "refs/heads/track/math", "engine/poly/src/lib.rs\n");
  assert.equal(trackEngine.full, "true");
  assert.equal(trackEngine.engine_full, "true");
  assert.equal(run("schedule", "refs/heads/master", "").engine_full, "true");
  assert.equal(run("workflow_dispatch", "refs/heads/master", "", { CI_LONG: "true" }).engine_full, "true");
  assert.equal(run("workflow_dispatch", "refs/heads/master", "").engine_full, "false");
  assert.equal(run("workflow_dispatch", "refs/heads/master", "", { CI_LONG: "false" }).engine_full, "false");
});

test("track pushes have master integration parity, including after a superseded engine push", () => {
  const run = (ref: string, files: string) => {
    const list = join(dir, "files.txt");
    writeFileSync(list, files);
    const r = spawnSync(process.execPath, [script], { encoding: "utf8", env: {
      ...process.env, CI_PATHS_FILES: list, GITHUB_EVENT_NAME: "push", GITHUB_REF: ref, CI_LONG: "",
    } });
    assert.equal(r.status, 0, r.stderr);
    return Object.fromEntries(r.stdout.trim().split("\n").map((line) => line.split("=") as [string, string]));
  };
  for (const files of ["engine/poly/src/lib.rs\n", "README.md\n", "src/runtime/ops.ts\n"]) {
    const master = run("refs/heads/master", files);
    const track = run("refs/heads/track/math", files);
    for (const key of ["full", "engine_full", "web_runner", "wasm_build", "docs_only", "long"])
      assert.equal(track[key], master[key], `${files.trim()}: ${key}`);
    // (the one difference: on a track an engine source moves the shipped bytes, so it is a size input there)
    assert.equal(track.size_inputs, files.startsWith("engine/") ? "true" : master.size_inputs, `${files.trim()}: size_inputs`);
    assert.equal(track.full, "true", files.trim());
    assert.equal(track.engine_full, "true", files.trim());
    assert.equal(track.long, "false", files.trim());
  }
  // Replay only the current, docs-only follow-up after an engine push whose queued run was superseded. It must not
  // need the earlier path list: all non-PR runs build wasm, and track integration remains master-like and full.
  const followup = run("refs/heads/track/math", "design/tracks.md\n");
  assert.equal(followup.full, "true");
  assert.equal(followup.engine_full, "true");
  assert.equal(followup.size_inputs, "false");
  assert.equal(followup.web_runner, "true");
  assert.equal(followup.wasm_build, "true");
  assert.equal(followup.docs_only, "false");
  assert.equal(followup.long, "false");
});

test("the long tier: the nightly schedule and a dispatch with long set; never a pull request (any label or path), a master push or a plain dispatch", () => {
  const run = (event: string, ref: string, files: string, env: Record<string, string> = {}) => {
    const list = join(dir, "files.txt");
    writeFileSync(list, files);
    const r = spawnSync(process.execPath, [script], { encoding: "utf8", env: { ...process.env, CI_PATHS_FILES: list, GITHUB_EVENT_NAME: event, GITHUB_REF: ref, CI_PR_LABELS: "", CI_LONG: "", ...env } });
    assert.equal(r.status, 0, r.stderr);
    return Object.fromEntries(r.stdout.trim().split("\n").map((l) => l.split("=") as [string, string]));
  };
  const longRuns = [run("schedule", "refs/heads/master", ""), run("workflow_dispatch", "refs/heads/master", "", { CI_LONG: "true" })];
  const notLong = [
    run("workflow_dispatch", "refs/heads/master", ""),
    run("workflow_dispatch", "refs/heads/master", "", { CI_LONG: "false" }),
    run("push", "refs/heads/master", "README.md\n"),
    run("pull_request", "refs/pull/1/merge", "web/sync/doc.ts\n", { CI_PR_LABELS: "full-ci" }),
    // (a pull request touching what a slow test or a long job tests: still not long)
    run("pull_request", "refs/pull/1/merge", "test/kedlaya.test.ts\nbench/mpmath/suite.py\nscripts/test-numbl-corpus.mjs\nweb/share/test-share-dialog.mjs\n", { CI_LONG: "true" }),
  ];
  for (const o of longRuns) {
    assert.equal(o.long, "true");
    assert.deepEqual(JSON.parse(o.mpmath_backends), ["sagebrush", "python"]);
    assert.deepEqual(JSON.parse(o.web_sync_shards), ["core", "client", "pwa", "lti", "lti-b", "share-dialog-2"]);
    assert.equal(o.slow_tests, "true");
    assert.equal(o.slow_scope, "1");
  }
  for (const o of notLong) {
    assert.equal(o.long, "false", JSON.stringify(o));
    assert.deepEqual(JSON.parse(o.mpmath_backends), ["sagebrush"]);
    assert.deepEqual(JSON.parse(o.web_sync_shards), ["core", "client", "pwa", "lti", "lti-b"]);
    assert.equal(o.slow_tests, "false");
    assert.equal(o.slow_scope, "");
  }
});

test("ci.yml: the long tier's jobs and steps run only where the changes job says long", () => {
  const yml = readFileSync(join(__dirname, "..", "..", ".github", "workflows", "ci.yml"), "utf8");
  // (the dispatch's input, and the changes job reading it)
  assert.match(yml, /^ {2}workflow_dispatch:\n {4}inputs:\n {6}long:\n(?: {8}.*\n)*? {8}type: boolean\n {8}default: false$/m);
  assert.match(yml, /^ {10}CI_LONG: \$\{\{ inputs\.long \}\}$/m);
  for (const o of ["long", "mpmath_backends", "web_sync_shards"])
    assert.match(yml, new RegExp(`^ {6}${o}: \\$\\{\\{ steps\\.paths\\.outputs\\.${o} \\}\\}$`, "m"), o);
  // (the matrices read from the changes job)
  assert.match(yml, /^ {8}backend: \$\{\{ fromJSON\(needs\.changes\.outputs\.mpmath_backends\) \}\}$/m);
  assert.match(yml, /^ {8}shard: \$\{\{ fromJSON\(needs\.changes\.outputs\.web_sync_shards\) \}\}$/m);
  // (the long steps: the Numbl corpus, and the artifacts' LaTeX-off and LaTeX-test builds)
  const step = (name: string) => {
    const at = yml.indexOf(`- name: ${name}\n`);
    assert.ok(at > 0, name);
    // (to the next step, or the comment before it)
    const ends = ["\n      - ", "\n      # "].map((x) => yml.indexOf(x, at + 1)).filter((x) => x > 0);
    return yml.slice(at, ends.length ? Math.min(...ends) : undefined);
  };
  const numbl = step("the Numbl corpus");
  assert.match(numbl, /if: needs\.changes\.outputs\.long == 'true'/);
  assert.match(numbl, /web-tests\.mjs run web-runner-sync\.2/);
  const art = step("the agents chat's artifacts, without LaTeX and with its test build");
  assert.match(art, /if: needs\.changes\.outputs\.long == 'true'/);
  assert.match(art, /SAGEBRUSH_LATEX_PREVIEW=0 bun web\/build\.ts\n\s+node scripts\/web-tests\.mjs run web-artifacts\.3\n/);
  assert.match(art, /SAGEBRUSH_LATEX_PREVIEW=test bun web\/build\.ts\n\s+node scripts\/web-tests\.mjs run web-artifacts\.2/);
  // (the ordinary artifacts step: the default build and .1 only)
  const plain = step("the agents chat's artifacts");
  assert.doesNotMatch(plain, /web-artifacts\.[23]|SAGEBRUSH_LATEX_PREVIEW/);
  assert.match(step("the documents' sync"), /web-tests\.mjs run web-runner-sync\.1(?![0-9])/);
  assert.doesNotMatch(step("the documents' sync"), /web-runner-sync\.2|web-tests\.mjs run web-runner-sync(?![.])/);
  // (the controls: long-only jobs the final gate waits for; nightly.yml is gone, so they never run twice)
  for (const job of ["export-controls", "lookalike-controls"]) {
    const at = yml.indexOf(`\n  ${job}:\n`);
    assert.ok(at > 0, job);
    const head = yml.slice(at, yml.indexOf("steps:", at));
    assert.match(head, /needs\.changes\.outputs\.long == 'true'/, job);
    assert.match(yml, new RegExp(`\\$\\{\\{ needs\\.${job}\\.result \\}\\}`), job);
  }
  assert.equal(existsSync(join(__dirname, "..", "..", ".github", "workflows", "nightly.yml")), false);
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
    "web/cloud/mirror/account.ts", "web/cloud/lti/launch.ts", "web/cloud/support/support.ts", "web/workspace/agent-chat/mirror-format.ts",
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
    assert.deepEqual([o.node, o.web, o.modes, o.webkit], ["true", "true", "true", "true"], f);
    // (the engine's full passes: a pull request's only when it rebuilds the engine, never for the full tier alone)
    assert.equal(o.engine_full, o.wasm_build, f);
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
  const ALL = ["notebook", "preload", "latex", "board-a", "board-b", "board-c", "board-unit", "terminal", "remote-preview", "space"];
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
  // a space in 3D (web/space): its group alone (its page loads nothing of the others')
  for (const f of ["web/space/src/main.js", "web/space/test-walk.mjs", "web/space/examples/intro.space.json"]) {
    assert.deepEqual(pick([f]), { groups: ["space"], runner: "false", export: "false", lookalike: "false" }, f);
  }
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
  for (const f of ["ci-paths.mjs", "examples-lib.mjs", "size-measure.mjs", "build-inputs.mjs", "web-tests.mjs", "pin-policy.mjs"]) cpSync(join(__dirname, "..", "..", "scripts", f), join(top, "scripts", f));
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
  // (the web-browser jobs: every selected group in exactly one of at most four jobs, the CI capacity ruling, Nov 22 2026;
  // latex alone, on its own build; notebook alone, the longest group; terminal last in its job, since it rebuilds web/dist)
  const matrix = JSON.parse(classify(["web/index.html"]).web_matrix);
  assert.deepEqual(matrix, [
    { name: "board", groups: "board-a board-b board-c board-unit preload" },
    { name: "notebook", groups: "notebook space" },
    { name: "remote-terminal", groups: "remote-preview terminal" },
    { name: "latex", groups: "latex" },
  ]);
  const all = JSON.parse(classify(["web/index.html"]).web_groups);
  assert.deepEqual(matrix.flatMap((x: { groups: string }) => x.groups.split(" ")).sort(), [...all].sort(), "every selected group in exactly one job");
  // (a change that selects some groups runs only the jobs that hold them, each with only those)
  assert.deepEqual(JSON.parse(classify(["web/board/frame.ts"]).web_matrix), [{ name: "board", groups: "board-a board-b board-c board-unit" }]);
  assert.deepEqual(JSON.parse(classify(["web/shell/test-cross.mjs"], "", at).web_matrix), [{ name: "notebook", groups: "notebook" }, { name: "remote-terminal", groups: "terminal" }]);
  assert.deepEqual(JSON.parse(classify(["web/board/page.ts"]).web_matrix).map((x: { name: string }) => x.name), ["board", "latex"]);
  // (ci.yml runs each job's groups in a loop that keeps going after a failure, and fails the step if any failed)
  const yml = readFileSync(join(__dirname, "..", "..", ".github", "workflows", "ci.yml"), "utf8");
  const browser = yml.slice(yml.indexOf("\n  web-browser:\n"), yml.indexOf("\n  conformance:\n"));
  assert.ok(browser.includes("for GROUP in $WEB_GROUPS; do") && !/^ +GROUPS:/m.test(browser) && browser.includes('[ -z "$failed" ] || { echo "::error::failed groups:$failed"; exit 1; }'));
  assert.ok(!/--shard "\$\{\{ matrix\.shard \}\}/.test(browser), "no group is sharded any more");
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
  for (const f of ["web/share/files.ts", "web/share/test-share-dialog.mjs", "web/share-client/upload.ts", "web/cloud/share/server.ts", "web/cloud/share/test-share-dialog.mjs", "web/workspace/account.ts"]) assert.equal(classify([f]).web_share, "true", f);
  // (the hosted remotes: the full tier, but no share dialog)
  assert.equal(classify(["web/cloud/remote/relay.ts"]).full, "true");
  assert.equal(classify(["web/cloud/remote/relay.ts"]).web_share, "false");
  assert.equal(classify(["web/cloud/support/test-support.mjs"]).full, "true");
  assert.equal(classify(["web/cloud/support/test-support.mjs"]).web_share, "false");
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

test("slow_tests and slow_scope: the slow node tests (test/slow-tests.ts) run in the long tier only; no pull request (label or paths) and no master push turns them on", () => {
  for (const f of ["tsconfig.json", "package.json", "test/kedlaya.test.ts", "test/local-gateway.test.ts", "wasm/sagebrush-engine.wasm",
    "lib/_zoneinfo.py", "test/magma-examples.test.ts", "catalog/magma/integers.json", "test/ff-limits.test.ts", "test/limits.test.ts",
    "test/slow-tests.ts", "scripts/arraybuffer-sites.mjs", "test/arraybuffer-sites.json", "test/arraybuffer-sites-parity.test.ts",
    "test/ffmat-echelon-admission.test.ts", "lib/_matlab.py"]) {
    const o = classify([f]);
    assert.equal(o.slow_tests, "false", f);
    assert.equal(o.slow_scope, "", f);
  }
  assert.equal(classify(["test/kedlaya.test.ts"], "full-ci").slow_tests, "false");
  const push = classify(["lib/_sage_padic_lseries.py"], "", { GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/heads/master" });
  assert.equal(push.full, "true");
  assert.equal(push.slow_tests, "false");
  assert.equal(classify([], "", { GITHUB_EVENT_NAME: "workflow_dispatch", CI_LONG: "" }).slow_tests, "false");
  assert.equal(classify([], "", { GITHUB_EVENT_NAME: "workflow_dispatch", CI_LONG: "true" }).slow_scope, "1");
  assert.equal(classify([], "", { GITHUB_EVENT_NAME: "schedule", CI_LONG: "" }).slow_scope, "1");
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
    // (the event alone turns nothing on: CI's long tier sets SAGEBRUSH_SLOW_TESTS=1, and a plain dispatch isn't long)
    [{ GITHUB_EVENT_NAME: "schedule" }, false],
    [{ GITHUB_EVENT_NAME: "workflow_dispatch" }, false],
    [{ GITHUB_EVENT_NAME: "schedule", SAGEBRUSH_SLOW_TESTS: "1" }, true],
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
    [{ GITHUB_EVENT_NAME: "schedule" }, false],
    [{ GITHUB_EVENT_NAME: "workflow_dispatch" }, false],
  ];
  for (const [extra, runs] of modes) {
    const env: Record<string, string | undefined> = { ...process.env, SAGEBRUSH_SLOW_TESTS: undefined, GITHUB_EVENT_NAME: undefined, ...extra };
    for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
    const r = spawnSync(process.execPath, ["-e", `const s = require(${JSON.stringify(mod)}); const k = s.slowSkipFor("arraybuffer"); console.log(JSON.stringify([k === false, typeof k]))`], { env, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), [runs, runs ? "boolean" : "string"], JSON.stringify(extra));
  }
});

test("the GF(p) echelon admission's memory cases follow the slow tests (the long tier), not a master push or the full tier", () => {
  const src = readFileSync(join(__dirname, "..", "..", "test", "ffmat-echelon-admission.test.ts"), "utf8");
  assert.match(src, /^import \{ SLOW \} from "\.\/slow-tests";$/m);
  assert.match(src, /^const FULL = SLOW \|\| process\.env\.SAGEBRUSH_FULL === "1";$/m);
  assert.doesNotMatch(src, /GITHUB_REF|GITHUB_EVENT_NAME/);
});

test("wasm_build: a pull request into a track always builds the modules; a track's pull into master builds only for its inputs", () => {
  // (a track's pin lags its engine until its pull into master, scripts/pin-policy.mjs)
  for (const files of [["README.md"], ["lib/sagebrush/linalg.py"], ["bench/core/run.py"]])
    assert.equal(classify(files, "", { GITHUB_BASE_REF: "track/math", GITHUB_HEAD_REF: "r6" }).wasm_build, "true", files.join());
  assert.equal(classify(["README.md"], "", { GITHUB_BASE_REF: "master", GITHUB_HEAD_REF: "track/math" }).wasm_build, "false");
  assert.equal(classify(["README.md"], "", { GITHUB_BASE_REF: "trackmath", GITHUB_HEAD_REF: "x" }).wasm_build, "false");
});

test("size_inputs: on a track an engine source is a gate input (the engine ships as built); elsewhere it is not", () => {
  // (a track's pull request with only an engine change was once measured as docs-only: no base record, an empty gate)
  const size = (files: string[], env: Record<string, string>) => classify(files, "", env).size_inputs;
  const intoTrack = { GITHUB_BASE_REF: "track/math", GITHUB_HEAD_REF: "r6" };
  for (const f of ["engine/arith/src/zmat.rs", "engine/poly/src/modp.rs", "wasm/pins.json", "Cargo.lock", "scripts/build-engine.mjs"])
    assert.equal(size([f], intoTrack), "true", f);
  assert.equal(size(["engine/arith/src/zmat.rs"], { GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/heads/track/math" }), "true");
  for (const f of ["README.md", "bench/core/run.py", "lib/sagebrush/linalg.py"]) assert.equal(size([f], intoTrack), "false", f);
  // (on master, and on a track's pull into master, an engine source moves no shipped bytes until its pin does)
  assert.equal(size(["engine/arith/src/zmat.rs"], { GITHUB_BASE_REF: "master", GITHUB_HEAD_REF: "x" }), "false");
  assert.equal(size(["engine/arith/src/zmat.rs"], { GITHUB_BASE_REF: "master", GITHUB_HEAD_REF: "track/math" }), "false");
  assert.equal(size(["engine/arith/src/zmat.rs"], { GITHUB_BASE_REF: "trackmath", GITHUB_HEAD_REF: "x" }), "false");
});

test("wasm_build: what the modules are built from or handled by builds them on a pull request; every other event builds", () => {
  const build = (files: string[], env: Record<string, string> = {}) => classify(files, "", env).wasm_build;
  for (const f of ["engine/poly/src/lib.rs", "wasm/pins.json", "Cargo.lock", "scripts/build-mp.mjs", "scripts/build-raster.mjs",
    "scripts/wasm-fetch.mjs", "scripts/wasm-artifact.mjs", "scripts/wasm-publish.mjs", ".github/actions/wasm-modules/action.yml",
    ".github/workflows/ci.yml"]) {
    assert.equal(build([f]), "true", f);
  }
  for (const f of ["lib/_sage_ffmat.py", "web/notebook/index.ts", "design/notes.md", "src/runtime/engine.ts"]) assert.equal(build([f]), "false", f);
  // (a master or track push publishes its own build, and a push whose run was replaced can hide an engine change
  // from the next)
  assert.equal(build(["lib/_sage_ffmat.py"], { GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/heads/master" }), "true");
  assert.equal(build(["lib/_sage_ffmat.py"], { GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/heads/track/math" }), "true");
  assert.equal(build([], { GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_REF: "refs/heads/master" }), "true");
  assert.equal(build([], { GITHUB_EVENT_NAME: "schedule", GITHUB_REF: "refs/heads/master" }), "true");
});

test("a master push the merge queue already tested (CI_QUEUE_TESTED): every test selection is off; only the modules' build stays", () => {
  const push = { GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/heads/master" };
  for (const files of [["src/compile.ts"], ["web/notebook/x.ts", "engine/poly/src/lib.rs", "magma-tests/x.m"]]) {
    const o = classify(files, "", { ...push, CI_QUEUE_TESTED: "true" });
    assert.equal(o.queue_tested, "true");
    // (the matrices' contents, read only by jobs now off, and the counts aren't selections; app_build is app.yml's,
    // which a queue-tested push doesn't change)
    const kept = new Set(["wasm_build", "queue_tested", "mpmath_backends", "web_sync_shards", "files", "app_build"]);
    for (const [k, v] of Object.entries(o)) if (!kept.has(k)) assert.ok(v === "false" || v === "[]" || v === "", `${files.join()}: ${k}=${v}`);
    assert.equal(o.wasm_build, "true");
    // (without it, or not "true", the same push runs the full tier)
    for (const t of [undefined, "false", "1", "TRUE"]) {
      const f = classify(files, "", t === undefined ? push : { ...push, CI_QUEUE_TESTED: t });
      assert.deepEqual([f.queue_tested, f.full, f.node, f.engine_full], ["false", "true", "true", "true"], String(t));
    }
  }
  // (only a master push: a track push, the queue's own run, a pull request ignore it)
  assert.equal(classify(["src/x.ts"], "", { GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/heads/track/math", CI_QUEUE_TESTED: "true" }).full, "true");
  assert.equal(classify(["src/x.ts"], "", { CI_QUEUE_TESTED: "true" }).queue_tested, "false");
});

test("latex_budget: a pull request changing the LaTeX group's inputs keeps web-artifacts, light or not; nothing else does", () => {
  for (const files of [["web/latex/split.ts"], ["scripts/latex-group.mjs"], ["web/workspace/paths.ts"], ["web/build.ts"]]) {
    assert.equal(classify(files).latex_budget, "true", files.join());
    assert.equal(classify(files, "", { CI_PR_LIGHT: "true" }).latex_budget, "true", files.join());
  }
  for (const files of [["web/latex/test-latex-units.mjs"], ["web/board/x.ts"], ["design/x.md"]]) assert.equal(classify(files).latex_budget, "false", files.join());
  assert.equal(classify(["web/latex/split.ts"], "", { GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/heads/master" }).latex_budget, "false");
});

test("PR CI light (CI_PR_LIGHT exactly \"true\"): a pull request keeps only checks' and the size gate's inputs and the modules' build", () => {
  const files = ["src/compile.ts", "web/notebook/x.ts", "engine/poly/src/lib.rs", "magma-tests/x.m"];
  const off = classify(files);
  const on = classify(files, "", { CI_PR_LIGHT: "true" });
  assert.equal(on.pr_light, "true");
  assert.equal(off.pr_light, "false");
  // (on: every selection off but the size inputs, which run checks, size-base and the measured gate, and the build)
  const kept = new Set(["size_inputs", "wasm_build", "pr_light", "queue_tested", "mpmath_backends", "web_sync_shards", "files", "docs_only", "app_only", "optional_only", "long"]);
  for (const [k, v] of Object.entries(on)) if (!kept.has(k)) assert.ok(v === "false" || v === "[]" || v === "", `${k}=${v}`);
  assert.deepEqual([on.size_inputs, on.wasm_build], ["true", off.wasm_build]);
  // (off: unset, "false", "1" or "TRUE" are no switch)
  for (const v of ["false", "1", "TRUE", ""]) assert.deepEqual(classify(files, "", { CI_PR_LIGHT: v }), off, String(v));
  // (a full-ci label, a queue group or a push ignores it)
  assert.equal(classify(files, "full-ci", { CI_PR_LIGHT: "true" }).full, "true");
  assert.equal(classify(files, "", { CI_PR_LIGHT: "true", GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/heads/master" }).full, "true");
  // (a docs-only change runs no checks either way)
  assert.equal(classify(["design/x.md"], "", { CI_PR_LIGHT: "true" }).size_inputs, classify(["design/x.md"]).size_inputs);
});

test("app_build: a light pull request builds the desktop app only when it changes app/, the pins or app.yml; everything else always", () => {
  assert.equal(classify(["web/index.html"], "", { CI_PR_LIGHT: "true" }).app_build, "false");
  assert.equal(classify(["app/src-tauri/src/lib.rs"], "", { CI_PR_LIGHT: "true" }).app_build, "true");
  assert.equal(classify(["web/index.html"]).app_build, "true");
  assert.equal(classify(["web/index.html"], "full-ci", { CI_PR_LIGHT: "true" }).app_build, "true");
  assert.equal(classify(["web/index.html"], "", { CI_PR_LIGHT: "true", GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/heads/master" }).app_build, "true");
});
