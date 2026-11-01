#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { gateInputs } from "./size-measure.mjs";
import { BUILD_INPUT_PATHS } from "./build-inputs.mjs";

const event = process.env.GITHUB_EVENT_NAME ?? "local";
const ref = process.env.GITHUB_REF ?? "";
const head = process.env.GITHUB_SHA || "HEAD";

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function hasCommit(commit) {
  try {
    execFileSync("git", ["cat-file", "-e", `${commit}^{commit}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// (--no-renames: a rename is its deletion and its addition, so both names
// are classified; git's rename detection would report only the new one, and
// a file moved out of a selecting path, engine/py/x.py -> web/x.py, would
// select nothing)
function changedFiles() {
  if (event === "workflow_dispatch" || event === "schedule") return [];
  if (event === "pull_request") {
    const base = `origin/${process.env.GITHUB_BASE_REF}`;
    const mergeBase = git("merge-base", base, head);
    return git("diff", "--name-only", "--no-renames", `${mergeBase}...${head}`).split("\n").filter(Boolean);
  }
  if (event === "push") {
    const before = process.env.GITHUB_EVENT_BEFORE ?? "";
    if (/^[0]+$/.test(before) || !before) {
      return git("show", "--pretty=", "--name-only", "--no-renames", head).split("\n").filter(Boolean);
    }
    // A rebased/force-pushed branch can name an unreachable old SHA in
    // `before`.  Compare the whole branch with master rather than failing or
    // accidentally certifying a partial path set.
    if (!hasCommit(before)) {
      const mergeBase = git("merge-base", "origin/master", head);
      return git("diff", "--name-only", "--no-renames", `${mergeBase}...${head}`).split("\n").filter(Boolean);
    }
    return git("diff", "--name-only", "--no-renames", before, head).split("\n").filter(Boolean);
  }
  return git("show", "--pretty=", "--name-only", "--no-renames", head).split("\n").filter(Boolean);
}

// (tests replay a file list through the classifier: one path a line)
const files = process.env.CI_PATHS_FILES
  ? readFileSync(process.env.CI_PATHS_FILES, "utf8").split("\n").filter(Boolean)
  : changedFiles();
const full = event === "workflow_dispatch" || event === "schedule" ||
  (event === "push" && ref === "refs/heads/master");
const matches = (patterns) => files.some((file) => patterns.some((pattern) => pattern.test(file)));
const every = (patterns) => files.length > 0 && files.every((file) => patterns.some((pattern) => pattern.test(file)));

// Only these paths are certified as prose-only.  In particular, examples/*.md
// is executable board input and must not be treated as documentation.
const docsPaths = [
  /^design\//,
  /^README(?:\.[^/]*)?$/,
  /^CONTRIBUTING(?:\.[^/]*)?$/,
  /^SECURITY(?:\.[^/]*)?$/,
  /^LICENSE(?:[-.][^/]*)?$/,
];
const docsOnly = !full && every(docsPaths);

const workflowOrBuildPaths = [
  /^\.github\/workflows\/ci\.yml$/,
  /^scripts\/ci-paths\.mjs$/,
  /^package\.json$/,
  /^pnpm-lock\.yaml$/,
  /^tsconfig(?:\.[^/]*)?\.json$/,
];
// The committed engine artifacts are what the runtime loads (src/runtime/
// engine.ts, the CDN module): a change to them is a runtime change, tested
// by the node, web and mode suites as well as the engine's.  Rust-only
// engine/ changes that leave them alone cannot change runtime behaviour.
const runtimePaths = [
  /^src\//, /^lib\//, /^test\//, /^target\//, /^conformance\//,
  /^catalog\//, /^scripts\/(?!ci-paths\.mjs$)/, /^wasm\//, /^cdn\//,
];
const webPaths = [/^web\//, /^examples\//, /^packages\/sagebrush-board\//];
const modePaths = [
  /^sage-tests\//, /^magma-tests\//, /^matlab-tests\//,
  /^numpy-tests\//, /^scipy-tests\//, /^pypi-tests\//, /^bench\/mpmath\//,
];
const enginePaths = [
  /^engine\//, /^wasm\//, /^Cargo(?:\.lock|\.toml)$/,
  /^scripts\/build-engine\.mjs$/,
];
// The CPython package's inputs: what its wheel builds (engine/, and a root
// Cargo manifest if one is ever added), what it ships (lib/, through
// scripts/sync-python-package.sh into engine/py/python), what the job runs
// (scripts/ci-cpus.sh) and what its tests read (engine/py/test_*.py and
// engine/modsym/examples, sage-tests/, and test_workspace_tools.py's
// web/workspace/schema.json and paths.ts), and the limits registry the
// defaults are classified in.  engine-cpython is the one job that runs the
// package's own tests, so a pull request touching these runs it (#113
// changed a default, passed pull-request CI, and failed master's).  A new
// file the job reads belongs here, with a case in test/ci-paths.test.ts.
const cpythonPaths = [
  /^engine\//, /^lib\//, /^sage-tests\//, /^Cargo(?:\.lock|\.toml)$/,
  /^scripts\/sync-python-package\.sh$/, /^scripts\/ci-cpus\.sh$/, /^test\/limit-sites\.json$/, /^scripts\/clippy\//,
  /^web\/workspace\/schema\.json$/, /^web\/workspace\/paths\.ts$/,
];
// The WebKit job's inputs (plan-kedlaya-webkit-ci r4: detection, the
// production refusal and Stop of Kedlaya's Frobenius matrix in Playwright's
// WebKit worker), conservatively: the compiler and runtime (src/), the whole
// Python library (lib/: _sage_padic_lseries's imports reach sage_all, which
// imports the library), the engine artifacts it loads, the worker and how it
// is built (its library chunks, shims, runner frames), the build and its
// dependency inputs, the test and its helpers, and this classifier and the
// workflow themselves.  Pull requests only: master pushes don't run it; the
// nightly schedule and a dispatch always do.  A file outside every known
// path selects it too (the fallback below).
const webkitPaths = [
  /^src\//, /^lib\//, /^wasm\//, /^cdn\//,
  /^web\/worker\.ts$/, /^web\/build\.ts$/, /^web\/lib-[^/]+$/, /^web\/shims\//, /^web\/runner\//, /^web\/replay-env\.ts$/,
  /^web\/test-kedlaya-worker\.mjs$/, /^web\/test-port\.mjs$/, /^test\/kedlaya[^/]*$/,
  /^scripts\/build-cli\.mjs$/, /^scripts\/sandbox-env\.mjs$/, /^scripts\/ci-paths\.mjs$/, /^package\.json$/, /^pnpm-lock\.yaml$/, /^tsconfig(?:\.[^/]*)?\.json$/,
  /^\.github\/workflows\/ci\.yml$/,
  // (the terminal panel's long-line pages, copied as one line in WebKit: board's B-LL-4)
  /^web\/shell\/panel\.(?:ts|css)$/, /^web\/shell\/test-panel-pages-copy\.mjs$/,
];
const appPaths = [/^app\//, /^\.github\/workflows\/app\.yml$/];
// Optional packages (optional/<name>/, plan-modular-packages-r4 §7): their
// own tier, .github/workflows/optional.yml; a change to them alone runs no
// default suite (they are outside every core input: the build id, the
// worker's manifest and the CLI bundle).  The shared tooling
// (scripts/optional-packages.mjs) is a runtime path like any script.
const optionalPaths = [/^optional\//, /^\.github\/workflows\/optional\.yml$/];
const workflowOrBuild = matches(workflowOrBuildPaths);
const runtime = matches(runtimePaths);
const webChange = matches(webPaths);
const modeChange = matches(modePaths);
const engineChange = matches(enginePaths);
const appOnly = !full && every(appPaths);
const optionalOnly = !full && every(optionalPaths);

// Unknown paths deliberately fall back to the fast suite, file by file: an
// unknown path beside known ones still triggers it.  Skips are allowed only
// for the two narrow, audited classes above.
const knownPaths = [...docsPaths, ...workflowOrBuildPaths, ...runtimePaths, ...webPaths, ...modePaths, ...enginePaths, ...appPaths, ...optionalPaths];
const fallback = files.some((file) => !knownPaths.some((pattern) => pattern.test(file)));
const node = full || workflowOrBuild || runtime || webChange || fallback;
const web = full || workflowOrBuild || runtime || webChange || fallback;
const modes = full || workflowOrBuild || runtime || modeChange || fallback;
const engineSmoke = full || workflowOrBuild || engineChange || fallback;
const engineCpython = full || workflowOrBuild || matches(cpythonPaths) || fallback;
const webkit = event === "workflow_dispatch" || event === "schedule" ||
  (event === "pull_request" && (matches(webkitPaths) || fallback));
// The limits census (test/limit_sites.py --check, also asserted by
// test/limits.test.ts) scans lib/, engine/ and src/.  Its own light job runs
// whenever they, its registry, baseline or tool change, even when the node
// suites are path-skipped: #155, an engine-only change, merged past the
// census with node-tests skipped and turned master red (fixed by #156).
// (test/ci-paths.test.ts checks that every file test/limit_sites.py scans,
// its WEB set included, selects this job, and the files the job reads)
const censusPaths = [
  /^engine\//, /^lib\//, /^src\//, /^web\/workspace\/sync-ledger\.ts$/, /^web\/notebook\/text-overlap\.ts$/,
  /^test\/limit-sites\.json$/, /^test\/limit-sites-baseline\.txt$/, /^test\/limit_sites\.py$/, /^test\/limits\.test\.ts$/,
  // (the baseline sweep's files and tooling, which the census's check reads: plan-limit-sites-sweep-r3)
  /^test\/limit-sweep\//, /^test\/limit_sweep\.py$/, /^test\/limit_sweep_cases\.py$/,
  // (the unsafe boundary's check, C-2c-ii scope r4 section 1.3: every build input it scans, from the one
  // list scripts/unsafe-inventory.mjs uses too, and its inventory)
  ...BUILD_INPUT_PATHS, /^test\/unsafe-allow-inventory\.json$/,
];
const census = full || workflowOrBuild || matches(censusPaths) || fallback;
// The unsafe boundary's compiler sweep (engine-unsafe-sweep, #234 r2): only inputs that can change what the
// engine compiles, or the sweep's own tooling and job (daybreak2: never the unknown-path fallback, never every
// script or workflow, which the cheap census covers).  Every file under engine/ (sources, manifests, the
// lockfile, build scripts and the data they may read), cargo configs and toolchain files anywhere.
const unsafeSweepPaths = [
  /^engine\//, /(^|\/)\.cargo\//, /(^|\/)rust-toolchain(\.toml)?$/,
  /^scripts\/unsafe-sweep\.sh$/, /^scripts\/unsafe-inventory\.mjs$/, /^scripts\/build-inputs\.mjs$/, /^scripts\/toml-json\.py$/, /^test\/unsafe-allow-inventory\.json$/,
  /^\.github\/workflows\/ci\.yml$/,
];
const unsafeSweep = full || matches(unsafeSweepPaths);
// The engine's full tier (engine-node, engine-language, engine-modes): master pushes, the nightly schedule and a
// dispatch, and a pull request that touches the engine's runtime (src/runtime/), whose Magma, MATLAB and engine tests
// otherwise first ran on master (@sagebrush, Oct 30).  Those jobs need engine-wasm, which engine_smoke selects.
const engineFull = full || matches([/^src\/runtime\//]);

const outputs = {
  full,
  docs_only: docsOnly,
  app_only: appOnly,
  optional_only: optionalOnly,
  node,
  web,
  modes,
  engine_smoke: engineSmoke || engineFull,
  engine_full: engineFull,
  engine_cpython: engineCpython,
  webkit,
  census,
  unsafe_sweep: unsafeSweep,
  // (the growth gate's own inputs: never docs-only, plan-growth-budget-r5 §1.5)
  // (a dispatch or a schedule has no file list: its gate always runs on the measurement, never docs-only)
  size_inputs: event === "workflow_dispatch" || event === "schedule" || gateInputs(files).length > 0,
  files: files.length,
};
for (const [key, value] of Object.entries(outputs)) console.log(`${key}=${value}`);
console.error(`ci paths (${event}, ${files.length} files): ${JSON.stringify(outputs)}`);
