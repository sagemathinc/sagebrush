#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gateInputs } from "./size-measure.mjs";
import { headers } from "./web-tests.mjs";
import { BUILD_INPUT_PATHS } from "./build-inputs.mjs";
import { listExamples, select as selectExamples, shardCount } from "./examples-lib.mjs";

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
// sanitizing), and data loss (save, Trash, export, purge).  Then it runs the full suite, as every master push, the
// nightly schedule and a dispatch do.  A save or Trash change inside web/index.html is not seen here: its author adds
// the label.  (test/ci-paths.test.ts has a case for each path class)
const fullTierPaths = [
  // sync and its journals and merges
  /^web\/sync\//, /^web\/sync-protocol\//, /^web\/journal\//, /^web\/workspace\/[^/]*sync[^/]*$/,
  /^web\/notebook\/(?:sync-rows|journal|journal-rows|db-merge3|p2c-merge|merge3)[^/]*$/, /^web\/board\/(?:syncdb|journal|merge)\.ts$/,
  // sharing and security
  /^web\/share\//, /^web\/share-client\//, /^web\/csp(?:-policy)?\.m?ts$/, /^web\/safe-html\.ts$/,
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
  // chunk's kept views (view-state.ts, design/view-state.md))
  /^web\/workspace\/(?:agent-ui|agent-pair|pair-link|notebook-edit|agent-grant|agent-schema|verbs|verbs-page|branch-rules|git-branch|view-state)\.ts$/, /^src\/modes\.ts$/,
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
const full = event === "workflow_dispatch" || event === "schedule" ||
  (event === "push" && ref === "refs/heads/master") || fullTier;

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
const webPaths = [/^web\//, /^examples\//, /^packages\/sagebrush-board\//];
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
// built and run by engine-cpython alone (cpythonPaths): a change to only those compiles nothing the engine's Rust,
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
const node = full || workflowOrBuild || runtime || webChange || fallback;
const web = full || workflowOrBuild || runtime || webChange || fallback;
const modes = full || workflowOrBuild || runtime || modeChange || fallback;
const engineSmoke = full || workflowOrBuild || engineChange || fallback;
// (every run that isn't a pull request builds: a master push publishes its own build (wasm-publish), and a push whose
// run GitHub replaced by a newer one never ran, so a later push's own file list can miss an engine change; a dispatch
// and the schedule have no file list)
const wasmBuild = event !== "pull_request" || fallback || files.some((file) => wasmBuildPaths.some((p) => p.test(file)));
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
// The engine's full tier (engine-node, engine-language, engine-modes): master pushes, the nightly schedule and a
// dispatch, and a pull request that touches the engine's runtime (src/runtime/), whose Magma, MATLAB and engine tests
// otherwise first ran on master (@sagebrush, Oct 30).  Those jobs need engine-wasm, which engine_smoke selects.
const engineFull = full || matches([/^src\/runtime\//]);

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
// (web-runner: the runner, the workspace, the board frame and the notebook's merges)
const webRunner = web && (webRuntime || inArea("board") || inArea("workspace") || suiteJobs.has("web-runner"));
const webWorkspace = web && (allWeb || inArea("workspace"));
const webExport = webWorkspace || (web && suiteJobs.has("web-export"));
const webLookalike = webWorkspace || (web && suiteJobs.has("web-lookalike"));
// The share dialog's browser suite (web-sync.3, about 8.5 min alone, its own web-sync shard): in the full tier, but on a
// pull request only when it changes sharing (web/share/, web/share-client/, web/cloud/share/, the suites among them) or has the full-ci
// label; a master push, the schedule and a dispatch always run it (grader's web-sync CI-time plan, Nov 9: PR CI <= 10 min)
const webShare = full && (event !== "pull_request" || labels.includes("full-ci") || matches([/^web\/share\//, /^web\/share-client\//, /^web\/cloud\/share\//]));

// The slow node tests (test/slow-tests.ts: skipped in place unless SAGEBRUSH_SLOW_TESTS=1; William, Nov 4, his pick
// of option B): they run nightly and on a dispatch (test/slow-tests.ts reads the event itself), with the full-ci label,
// and on a pull request that changes what one of them tests.  Not on a master push, whose CI is to stay within 15
// minutes: the nightly run is their master check.  (test/ci-paths.test.ts has a case for each path class)
// tsc 7's parity with the arraybuffer census (test/arraybuffer-sites-parity.test.ts) and the census's train-16
// (test/arraybuffer-sites.test.ts): a change to the census's scripts and tables runs those two alone (slow_scope
// "arraybuffer"), not every slow test, since a routine re-binding of the table is common and touches nothing else
const arraybufferSlowPaths = [/^scripts\/arraybuffer-sites[^/]*\.mjs$/, /^test\/arraybuffer-sites[^/]*\.(?:json|test\.ts)$/];
const slowTestPaths = [
  // the same two, for the TypeScript and tsc 7 versions and the compiler options, which reach every slow test too
  /^tsconfig[^/]*\.json$/, /^package\.json$/, /^pnpm-lock\.yaml$/,
  // the whole kedlaya grid (test/kedlaya.test.ts, kedlaya_cases.py full)
  /^lib\/_sage_padic_lseries\.py$/, /^test\/kedlaya[^/]*$/,
  // the local gateway's 10,000-record cap (test/local-gateway.test.ts L29a)
  /^src\/local-gateway\.ts$/, /^test\/local-gateway\.test\.ts$/,
  // the nmod ops' peaks in wasm (test/nmod-fp-wasm.test.ts): the engine artifact and the nmod kernels
  /^wasm\/sagebrush-engine\.wasm$/, /^engine\/web\/src\/nmod[^/]*\.rs$/, /^engine\/arith\/src\/nmod[^/]*\.rs$/,
  /^engine\/bigint\/src\/nmod\.rs$/, /^test\/nmod-fp-wasm\.test\.ts$/,
  // the two zoneinfo sweeps over every zone (test/stdlib-zoneinfo.test.ts)
  /^lib\/zoneinfo\//, /^lib\/_zoneinfo\.py$/, /^lib\/_tzrules\.py$/, /^lib\/tzdata\//, /^tzdata\//,
  /^test\/zoneinfo_sweep_cases\.py$/, /^test\/stdlib-zoneinfo\.test\.ts$/,
  // every Magma index example (test/magma-examples.test.ts; a pull request runs a fixed sample): the examples, their
  // Magma 2.18 table and the suite
  /^lib\/_magma_docsearch\.py$/, /^test\/magma-examples\.(?:json|test\.ts)$/,
  // catalog gate 3 for every Magma example (test/magma-catalog.test.ts; a pull request runs a fixed sample)
  /^catalog\/magma\//, /^test\/magma-catalog\.test\.ts$/,
  // the finite-field limits' ceiling and GF(2^18) pair (test/ff-limits.test.ts), and plan-c0's unlimited completion
  // (test/limits.test.ts): their suites (a pull request runs the rest of each)
  /^test\/ff-limits\.test\.ts$/, /^test\/limits\.test\.ts$/,
  // and the list itself
  /^test\/slow-tests\.ts$/,
];
const slowAll = event === "workflow_dispatch" || event === "schedule" ||
  (event === "pull_request" && (labels.includes("full-ci") || matches(slowTestPaths)));
const slowArraybuffer = event === "pull_request" && matches(arraybufferSlowPaths);
const slowTests = slowAll || slowArraybuffer;
// (the value of SAGEBRUSH_SLOW_TESTS in node-tests: "1" every slow test, a group's name its tests alone; test/slow-tests.ts)
const slowScope = slowAll ? "1" : slowArraybuffer ? "arraybuffer" : "";

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
  engine_smoke: engineSmoke || engineFull,
  engine_full: engineFull,
  wasm_build: wasmBuild,
  engine_cpython: engineCpython,
  webkit,
  web_groups: JSON.stringify(webGroups),
  web_runner: webRunner,
  web_export: webExport,
  web_lookalike: webLookalike,
  web_share: webShare,
  census,
  unsafe_sweep: unsafeSweep,
  slow_tests: slowTests,
  slow_scope: slowScope,
  // (the growth gate's own inputs: never docs-only, plan-growth-budget-r5 §1.5)
  // (a dispatch or a schedule has no file list: its gate always runs on the measurement, never docs-only)
  size_inputs: event === "workflow_dispatch" || event === "schedule" || gateInputs(files).length > 0,
  files: files.length,
  // (the examples job: the ids it runs and its shard matrix, at most 16 examples a shard (SHARD_MAX); plan U7 section 2)
  examples_ids: JSON.stringify(exampleSelection),
  examples_matrix: JSON.stringify(Array.from({ length: shardCount(exampleSelection.length) }, (_, i) => i + 1)),
};
for (const [key, value] of Object.entries(outputs)) console.log(`${key}=${value}`);
console.error(`ci paths (${event}, ${files.length} files): ${JSON.stringify(outputs)}`);
