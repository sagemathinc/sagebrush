#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gateInputs } from "./size-measure.mjs";
import { headers } from "./web-tests.mjs";
import { BUILD_INPUT_PATHS } from "./build-inputs.mjs";
import { listExamples, select as selectExamples, shardCount } from "./examples-lib.mjs";
import { onTrack, runRefs } from "./pin-policy.mjs";

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
const matches = (patterns) => files.some((file) => patterns.some((pattern) => pattern.test(file)));
const every = (patterns) => files.length > 0 && files.every((file) => patterns.some((pattern) => pattern.test(file)));

// The two tiers (CI speed plan option 2, William, Nov 2 2026): a pull request runs the fast tier, unless it has the
// `full-ci` label or changes a path where a bug loses data or trust: sync, sharing and security (CSP, HTML
// sanitizing), and data loss (save, Trash, export, purge). Then it runs the full suite, as every master or track/**
// integration push, the nightly schedule and a dispatch do. A save or Trash change inside web/index.html is not seen here: its author adds
// the label.  (test/ci-paths.test.ts has a case for each path class)
const fullTierPaths = [
  // sync and its journals and merges
  /^web\/sync\//, /^web\/sync-protocol\//, /^web\/journal\//, /^web\/workspace\/[^/]*sync[^/]*$/,
  /^web\/notebook\/(?:sync-rows|journal|journal-rows|db-merge3|p2c-merge|merge3)[^/]*$/, /^web\/board\/(?:syncdb|journal|merge)\.ts$/,
  // sharing and security
  /^web\/share\//, /^web\/share-client\//, /^web\/csp(?:-policy)?\.m?ts$/, /^web\/safe-html\.ts$/,
  // (the account at the top right, which reads the share dialog's first check: the share dialog's suite, below)
  /^web\/workspace\/account\.ts$/,
  // (the hosted service's sharing and remotes, MS-RSL: their suites run only in web-sync's full-tier shards)
  /^web\/cloud\/share\//, /^web\/cloud\/remote\//,
  // data loss: save, Trash, export, purge, and the workspace's store and its migrations
  /^web\/workspace\/[^/]*(?:trash|export|purge|save)[^/]*$/, /^web\/workspace\/export\//,
  /^web\/workspace\/(?:db|migrate|migrator|file-bytes)\.ts$/,
  // (the workspace's API: Trash's remove, restore and move, and emptying it)
  /^web\/workspace\/api\.ts$/, /^web\/board\/export\.ts$/, /^web\/latex\/save\.ts$/,
  /^scripts\/check-export-size\.mjs$/,
  // (sources whose tests run only in the full tier: the service worker and its test hook (web-sync.2's PWA and
  // offline pages), the dependency files and the site preview (web-sync.4))
  /^web\/sw\.js$/, /^web\/sw-hook\.mts$/, /^web\/deps\/(?:file-deps|deps-client)\.ts$/, /^web\/site\/src\/preview\.ts$/,
  // (the Miniflare dispatch helper: its direct consumers, test-sync and test-share among them, run only in web-sync.1
  // and web-sync.2)
  /^web\/miniflare-dispatch\.mjs$/,
  // (a document's checkpoints, the client's side (BH-0b-2): sync, whose suite runs only in web-sync.1)
  /^web\/workspace\/checkpoint(?:-types)?\.ts$/,
  // (the LaTeX group's absolute ceiling and its lazy chunks' caps, checked only in web-artifacts (scripts/test-latex-group-budget.mjs): the
  // inputs of sagebrush-latex.js and its worker, as the build's metafile lists them (build/latex-metafile.json):
  // web/latex's own sources (not its suites), core/ and engine/, web/workspace/paths.ts; and the group's measure.
  // That suite checks every input of the two bundles is matched here)
  /^web\/latex\/(?!test-)[^/]+\.(?:ts|mts|js|mjs)$/, /^web\/latex\/(?:core|engine)\//, /^web\/workspace\/paths\.ts$/, /^scripts\/latex-group\.mjs$/,
  // (and the LaTeX editor's example list, web/examples/legacy.ts (#543). The build fills it from the corpus's LaTeX
  // examples, but a change to one of them selects that example, not the full tier: its own run checks it)
  /^web\/examples\/legacy\.ts$/,
  // (and the lazy chunks' inputs outside web/latex, each chunk under its own cap in the same check: the agent
  // pairing's modules (its doc-protocol.ts is above, with sync), the mode registry, which verbs.ts reads, and the view
  // chunk's kept views (view-state.ts, design/view-state.md); and an entry's page address, which the pairing adds to
  // its answers (entry-url.ts, with the code page's languages and address))
  /^web\/workspace\/(?:agent-ui|agent-pair|agent-made-tex|pair-link|notebook-edit|notebook-form|agent-grant|agent-schema|verbs|verbs-page|branch-rules|git-branch|view-state|entry-url)\.ts$/, /^src\/modes\.ts$/,
  /^web\/code\/(?:langs|url)\.ts$/,
  // (and what makes those bundles from them, which no metafile lists: the build and its helpers and the dependencies;
  // @sagebrush's ruling, Nov 4. Not .github/workflows/ci.yml, which pins bun and node but changes in about one pull
  // request in six: a bun or node bump carries the full-ci label instead)
  /^web\/build(?:-[^/]+)?\.(?:ts|mts|mjs)$/, /^package\.json$/, /^pnpm-lock\.yaml$/,
];
// A changed suite runs on its own pull request (#565: web/sw.js and test-sw-read-stall.mjs, `ci: web-sync.2`, ran
// neither): its `// ci:` header names its job, read as scripts/web-tests.mjs reads it, from the checkout (or
// CI_PATHS_ROOT, for the tests).  A suite of a job only the full tier runs selects the full tier; a web-browser
// suite selects its group, and a web-runner, export or lookalike suite its job.  (a deleted suite runs nowhere)
const fullOnlyJobs = ["web-sync", "web-sync-ops", "web-runner-sync", "web-artifacts"];
const suitePaths = [/^web\/(?:.*\/)?test-[^/]*\.mjs$/, /^scripts\/test-[^/]*\.mjs$/];
const suiteRoot = process.env.CI_PATHS_ROOT ?? ".";
// Some wheel tests also run through the CLI in checks. Derive those inputs
// from the workflow so a test-only change cannot skip its own checks run.
const changedPythonTests = files.filter((file) => /^engine\/py\/test_[^/]*\.py$/.test(file));
let checksPythonTest = false;
if (changedPythonTests.length) {
  const workflow = readFileSync(join(suiteRoot, ".github/workflows/ci.yml"), "utf8");
  const checks = workflow.split("\n  checks:\n")[1]?.split(/\n  [a-z][a-z0-9-]*:\n/)[0];
  if (checks === undefined) throw new Error("ci-paths: cannot find the checks job");
  const code = checks.split("\n").map((line) => line.split("#")[0])
    // Wrappers and continued commands still invoke their test. Prefer an extra
    // checks run to silently skipping one; exclude only explicit prose output.
    .filter((line) => !/^\s*(?:-\s+run:\s*)?(?:echo|printf)\b/.test(line)).join("\n");
  const invoked = new Set([...code.matchAll(/\bengine\/py\/test_[A-Za-z0-9_.-]+\.py\b/g)].map((m) => m[0]));
  checksPythonTest = changedPythonTests.some((file) => invoked.has(file));
}
const suiteTargets = files.filter((file) => suitePaths.some((pattern) => pattern.test(file))).flatMap((file) => {
  let text;
  try {
    text = readFileSync(join(suiteRoot, file), "utf8");
  } catch {
    return [];
  }
  return headers(file, text).filter((h) => h.kind === "run").map((h) => h.target);
});
const suiteJobs = new Set(suiteTargets.map((target) => target.split(/[./]/)[0]));
const suiteGroups = new Set(suiteTargets.filter((target) => target.startsWith("web-browser/")).map((target) => target.slice("web-browser/".length).split(".")[0]));
const labels = (process.env.CI_PR_LABELS ?? "").split(",").map((label) => label.trim());
const fullTier = event === "pull_request" &&
  (labels.includes("full-ci") || matches(fullTierPaths) || fullOnlyJobs.some((job) => suiteJobs.has(job)));
const integrationPush = event === "push" &&
  (ref === "refs/heads/master" || ref.startsWith("refs/heads/track/"));
const full = event === "workflow_dispatch" || event === "schedule" ||
  integrationPush || fullTier;
// The long tier (the test audit's option (a), decided Nov 17 2026): the second, slower passes of suites the full tier
// already runs once (the engine's full passes off master and engine-building pull requests, mpmath's Python backend,
// the share dialog's part 2, the Numbl corpus, the agents artifacts' LaTeX-off and LaTeX-test builds, the slow node
// tests, and the export's and lookalike report's controls).  The nightly schedule, and a dispatch that asks for it (its
// `long` input, as before a release); never a pull request, a label, a master push or a plain dispatch.
const long = event === "schedule" || (event === "workflow_dispatch" && process.env.CI_LONG === "true");

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
// The engine artifacts (wasm/pins.json names the modules) are what the runtime loads (src/runtime/
// engine.ts, the CDN module): a change to them is a runtime change, tested
// by the node, web and mode suites as well as the engine's.  Rust-only
// engine/ changes that leave them alone cannot change runtime behaviour.
const runtimePaths = [
  /^src\//, /^lib\//, /^test\//, /^target\//, /^conformance\//,
  /^catalog\//, /^scripts\/(?!ci-paths\.mjs$)/, /^wasm\//, /^cdn\//,
  // (Rill's recorded R outputs and their provenance: read by the node tests, design/rill.md §7.5)
  /^rill-tests\//,
  // (Sprig's recorded Mathics3 outputs, their provenance and the value checkers' controls: read by the node tests,
  // design/sprig-mvp.md §7.5; the corpus replay gets its own job when S1 brings it)
  /^sprig-tests\//,
];
// (the app's engine subprocess, app/engine/, is the page's worker on a pipe: its suite, web/test-app-engine.mjs, runs
// in checks; app/ is otherwise the app workflow's alone)
const webPaths = [/^web\//, /^examples\//, /^packages\/sagebrush-board\//, /^app\/engine\//];
const modePaths = [
  /^sage-tests\//, /^magma-tests\//, /^matlab-tests\//,
  /^numpy-tests\//, /^scipy-tests\//, /^pypi-tests\//, /^bench\/mpmath\//,
];
const enginePaths = [
  /^engine\//, /^wasm\//, /^Cargo(?:\.lock|\.toml)$/,
  /^scripts\/build-engine\.mjs$/, /^scripts\/build-nd\.mjs$/, /^scripts\/build-raster\.mjs$/, /^scripts\/build-mp\.mjs$/,
];
// What the modules' bytes, their pins and their handling depend on (design/wasm-artifacts.md section 4): a change
// here builds the four modules once (the wasm-modules job), and every job that reads wasm/ installs that run's
// artifact instead of fetching the published modules, whose pins this change may not have published yet.
const wasmBuildPaths = [
  ...enginePaths,
  /^scripts\/wasm-(?:modules|fetch|pins|artifact|publish)\.mjs$/, /^scripts\/install-engine-wasm\.mjs$/,
  /^\.github\/actions\/wasm-modules\//, /^\.github\/workflows\/ci\.yml$/,
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
  // (the page's own modules that test_pairing.py's remote tests run under bun: the page tunnel's end-to-end case
  // (web/notebook/test-pair-runner.mjs) and the terminal page (engine/py/remote_terminal_page.mjs), and what they import)
  /^web\/notebook\/(?:pair-tunnel|remote-client|remote-kernel|remote-terminal)\.js$/, /^web\/notebook\/test-pair-runner\.mjs$/,
  /^src\/wave-policy\.ts$/,
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
  // (which browsers run code in the sandboxed runner, and the headers that let Firefox load it: its Firefox leg,
  // web/share/test-runner-engines.mjs)
  /^web\/notebook\/runner-(?:browser|worker)\.js$/, /^web\/csp(?:-policy)?\.m?ts$/, /^web\/share\/test-runner-engines\.mjs$/,
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
// (the CPython package's own Python, its sources under engine/py/python/ and its tests engine/py/test_*.py, is
// built and run by engine-cpython (cpythonPaths), plus checks when named there:
// a change to only those compiles nothing the engine's Rust,
// wasm, NEON or interrupt jobs build or run, so it doesn't select them.  The files stay known paths (enginePaths),
// never the fallback; anything else under engine/ (Rust, manifests, build.rs, the pyo3 crate's engine/py/src)
// still selects them.  #862 changed only those and ran engine-rust for 624 s.)
const enginePythonOnlyPaths = [/^engine\/py\/python\//, /^engine\/py\/test_[^/]*\.py$/];
const engineChange = files.some((file) => enginePaths.some((p) => p.test(file)) && !enginePythonOnlyPaths.some((p) => p.test(file)));
const appOnly = !full && every(appPaths);
const optionalOnly = !full && every(optionalPaths);

// Unknown paths deliberately fall back to the fast suite, file by file: an
// unknown path beside known ones still triggers it.  Skips are allowed only
// for the two narrow, audited classes above.
// (the examples gallery: examples/ and its fixture corpus; which examples run is examples-lib.mjs select)
const examplesPaths = [/^examples\//, /^test\/fixtures\/examples\//];
const knownPaths = [...examplesPaths, ...docsPaths, ...workflowOrBuildPaths, ...runtimePaths, ...webPaths, ...modePaths, ...enginePaths, ...appPaths, ...optionalPaths];
const fallback = files.some((file) => !knownPaths.some((pattern) => pattern.test(file)));
const node = full || workflowOrBuild || runtime || webChange || checksPythonTest || fallback;
const web = full || workflowOrBuild || runtime || webChange || fallback;
const modes = full || workflowOrBuild || runtime || modeChange || fallback;
const engineSmoke = full || workflowOrBuild || engineChange || fallback;
// (every run that isn't a pull request builds: a master push publishes its own build, a track/** push uses its
// same-run artifact without publishing, and a
// push whose run GitHub replaced by a newer one never ran, so a later push's own file list can miss an engine change;
// a dispatch and the schedule have no file list)
// (and a pull request into a track always builds: a track's pin lags its engine until the track's pull into master
// (scripts/pin-policy.mjs), so the published modules its pins name may not be its engine)
const wasmBuild = event !== "pull_request" || fallback || onTrack(runRefs(process.env)) || files.some((file) => wasmBuildPaths.some((p) => p.test(file)));
const engineCpython = full || workflowOrBuild || matches(cpythonPaths) || fallback;
const webkit = event === "workflow_dispatch" || event === "schedule" ||
  (event === "pull_request" && (fullTier || matches(webkitPaths) || fallback));
// The limits census (test/limit_sites.py --check, also asserted by
// test/limits.test.ts) scans lib/, engine/ and src/.  Its own light job runs
// whenever they, its registry, baseline or tool change, even when the node
// suites are path-skipped: #155, an engine-only change, merged past the
// census with node-tests skipped and turned master red (fixed by #156).
// (test/ci-paths.test.ts checks that every file test/limit_sites.py scans,
// its WEB set included, selects this job, and the files the job reads)
const censusPaths = [
  /^engine\//, /^lib\//, /^src\//, /^web\/workspace\/sync-ledger\.ts$/, /^web\/notebook\/text-overlap\.ts$/, /^web\/stall-fetch\.js$/,
  /^test\/limit-sites\.json$/, /^test\/limit-sites-baseline\.txt$/, /^test\/limit_sites\.py$/, /^test\/limits\.test\.ts$/,
  // (the baseline sweep's files and tooling, which the census's check reads: plan-limit-sites-sweep-r3)
  /^test\/limit-sweep\//, /^test\/limit_sweep\.py$/, /^test\/limit_sweep_cases\.py$/,
  // (the unsafe boundary's check, C-2c-ii scope r4 section 1.3: every build input it scans, from the one
  // list scripts/unsafe-inventory.mjs uses too, and its inventory)
  ...BUILD_INPUT_PATHS, /^test\/unsafe-allow-inventory\.json$/,
  // (the rich-output sink census, OUT-ISO phase 1: every web source it scans, its registry, tool and suite)
  /^web\/.*\.(js|mjs|ts|mts|html)$/, /^test\/rich-sinks\.json$/, /^test\/rich_sinks\.py$/, /^scripts\/test-rich-sinks\.mjs$/,
  // (the temp-dir census: the web/ tests it scans (above), its tool and suite)
  /^scripts\/temp-dirs\.mjs$/, /^scripts\/test-temp-dirs\.mjs$/,
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
// The engine's full passes (engine-node, engine-language, engine-modes: the Node, language and mode suites again, on the
// engine built in this run): every master or track/** integration push, a pull request whose changes rebuild the engine (wasm_build), and the
// long tier.  Another pull request's engine is byte-identical to the published pin its ordinary suites already ran on,
// so the pass would repeat them.  engine-wasm, which they need, still runs where it did (engine_smoke: the engine's
// changes, the full tier and a pull request touching the engine's runtime, src/runtime/); a pull request's passes only
// where it runs (the CPython package's own Python sets wasm_build, but builds no engine engine-wasm would test).
const engineRuntime = full || matches([/^src\/runtime\//]);
const engineFull = long || integrationPush || (event === "pull_request" && wasmBuild && (engineSmoke || engineRuntime));

// The web jobs by area (CI speed plan option 7): a pull request whose web changes are all inside one area's
// directories runs that area's suites, not every web job.  Anything else under web/ (web/index.html, the build, the
// worker, the shims, the runner, ...) is the core every page depends on: it runs them all, as do the full tier, a
// workflow or build change, the runtime (src/, lib/, the engine artifacts, ...) and an unknown path.  The runtime
// alone skips the export and lookalike jobs, which test the workspace's files, not what the engine computes.
// (the corpus's boards are the board page's examples; its notebooks and LaTeX documents are inlined in the notebook
// page and the LaTeX editor, web/examples/legacy.ts, so they are the core, until the old menus go: U7 PR 6)
const webAreas = {
  board: [/^web\/board\//, /^web\/graph\//, /^web\/board-[^/]+$/, /^examples\/board\//, /^packages\/sagebrush-board\//],
  shell: [/^web\/shell\//],
  workspace: [/^web\/workspace\//],
  // (the engine and its suite: checks only, no browser group)
  "app-engine": [/^app\/engine\//, /^web\/test-app-engine\.mjs$/],
};
const webFiles = files.filter((file) => webPaths.some((pattern) => pattern.test(file)));
const inArea = (area) => webFiles.some((file) => webAreas[area].some((pattern) => pattern.test(file)));
const webCore = webFiles.some((file) => !Object.values(webAreas).some((patterns) => patterns.some((pattern) => pattern.test(file))));
const allWeb = full || workflowOrBuild || fallback || webCore;
const webRuntime = allWeb || runtime;
// (a source another area's group tests, beside its own area's: test-latex-page opens a .tex from the board's
// newLatexHere, #566)
const groupSources = { latex: [/^web\/board\/page\.ts$/] };
const testedBy = (group) => matches(groupSources[group]);
const webGroups = [
  ["notebook", webRuntime || suiteGroups.has("notebook")],
  // (background loading's page test, about 2 min: its own group beside notebook's, selected as notebook is, so the
  // notebook group stays inside PR CI's 10 min (#862's run: notebook 632 s, 114 s of it this test))
  ["preload", webRuntime || suiteGroups.has("preload")],
  // (the LaTeX editor's page and agent tools, on a build with the editor on loopback hosts: web/latex/ is the core)
  ["latex", webRuntime || suiteGroups.has("latex") || testedBy("latex")],
  ["board-a", webRuntime || inArea("board") || suiteGroups.has("board-a")],
  ["board-b", webRuntime || inArea("board") || suiteGroups.has("board-b")],
  ["board-c", webRuntime || inArea("board") || suiteGroups.has("board-c")],
  // (board-unit also runs the export's measure and reminder units)
  ["board-unit", webRuntime || inArea("board") || inArea("workspace") || suiteGroups.has("board-unit")],
  ["terminal", webRuntime || inArea("shell") || suiteGroups.has("terminal")],
  ["remote-preview", webRuntime || suiteGroups.has("remote-preview")],
].filter(([, selected]) => web && selected).map(([group]) => group);
const webMatrix = webGroups.flatMap((group) => {
  const total = group === "notebook" ? 3 : group === "remote-preview" ? 2 : 1;
  return Array.from({ length: total }, (_, i) => ({
    name: total === 1 ? group : `${group}-${i + 1}-of-${total}`,
    group,
    shard: i + 1,
    total,
  }));
});
// (web-runner: the runner, the workspace, the board frame and the notebook's merges)
const webRunner = web && (webRuntime || inArea("board") || inArea("workspace") || suiteJobs.has("web-runner"));
const webWorkspace = web && (allWeb || inArea("workspace"));
const webExport = webWorkspace || (web && suiteJobs.has("web-export"));
const webLookalike = webWorkspace || (web && suiteJobs.has("web-lookalike"));
// The share dialog's browser suite (web-sync.3, about 8.5 min alone, its own web-sync shard): in the full tier, but on a
// pull request only when it changes sharing (web/share/, web/share-client/, web/cloud/share/, the suites among them) or the
// account at the top right (web/workspace/account.ts, which reads the same first check as Share), or has the full-ci
// label; a master push, the schedule and a dispatch always run it (grader's web-sync CI-time plan, Nov 9: PR CI <= 10 min)
const webShare = full && (event !== "pull_request" || labels.includes("full-ci") || matches([/^web\/share\//, /^web\/share-client\//, /^web\/cloud\/share\//, /^web\/workspace\/account\.ts$/]));

// The slow node tests (test/slow-tests.ts: skipped in place unless SAGEBRUSH_SLOW_TESTS=1; William, Nov 4, his pick
// of option B), and the GF(p) echelon admission's memory cases (test/ffmat-echelon-admission.test.ts): the long tier
// only (the test audit's option (a), decided Nov 17 2026).  Neither the full-ci label nor a change to what one of them
// tests turns them on for a pull request; their fixed pull-request samples run there.
const slowTests = long;
// (the value of SAGEBRUSH_SLOW_TESTS in node-tests: "1" every slow test; test/slow-tests.ts)
const slowScope = long ? "1" : "";

// The examples gallery: the full tier, a dispatch and a schedule run every example; a pull request the ones
// its changes select (the trigger table in scripts/examples-lib.mjs). (CI_EXAMPLES_ROOT: another corpus, for
// test/ci-paths.test.ts. fileURLToPath, not .pathname: a checkout path with a space read as an empty corpus)
const exampleSelection = selectExamples(files, listExamples(process.env.CI_EXAMPLES_ROOT || fileURLToPath(new URL("../examples", import.meta.url))), { all: full }).ids;
const outputs = {
  full,
  docs_only: docsOnly,
  app_only: appOnly,
  optional_only: optionalOnly,
  node,
  web,
  modes,
  engine_smoke: engineSmoke || engineRuntime || engineFull,
  engine_full: engineFull,
  long,
  // (mpmath's suite: the core backend always; the Python backend, a rollback path, the long tier's)
  mpmath_backends: JSON.stringify(long ? ["sagebrush", "python"] : ["sagebrush"]),
  // (web-sync's shards: the share dialog's part 2, its big listing and upload leaks, the long tier's)
  web_sync_shards: JSON.stringify(["core", "client", "moves", "pwa", "share-dialog", ...(long ? ["share-dialog-2"] : [])]),
  wasm_build: wasmBuild,
  engine_cpython: engineCpython,
  webkit,
  web_groups: JSON.stringify(webGroups),
  web_matrix: JSON.stringify(webMatrix),
  web_runner: webRunner,
  web_export: webExport,
  web_lookalike: webLookalike,
  web_share: webShare,
  census,
  unsafe_sweep: unsafeSweep,
  slow_tests: slowTests,
  slow_scope: slowScope,
  // (the size comparison's own inputs: never docs-only)
  // (a dispatch or a schedule has no file list: its gate always runs on the measurement, never docs-only)
  // (on a track the engine ships as built, not as pinned (scripts/pin-policy.mjs), so an engine source moves the
  // measured bytes there and is a gate input too)
  size_inputs: event === "workflow_dispatch" || event === "schedule" || gateInputs(files).length > 0 ||
    (onTrack(runRefs(process.env)) && files.some((file) => enginePaths.some((p) => p.test(file)))),
  files: files.length,
  // (the examples job: the ids it runs and its shard matrix, at most 16 examples a shard (SHARD_MAX); plan U7 section 2)
  examples_ids: JSON.stringify(exampleSelection),
  examples_matrix: JSON.stringify(Array.from({ length: shardCount(exampleSelection.length) }, (_, i) => i + 1)),
};
for (const [key, value] of Object.entries(outputs)) console.log(`${key}=${value}`);
console.error(`ci paths (${event}, ${files.length} files): ${JSON.stringify(outputs)}`);
