import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
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
