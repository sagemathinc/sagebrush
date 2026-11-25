// ci: checks.3 order=62
// The desktop app's build under PR CI light (CI job cuts, cut 4b, William Nov 24 2026).  A light pull request builds
// the app (app.yml's page and app jobs) only when it changes app/, wasm/pins.json or app.yml: scripts/ci-paths.mjs
// app_build.  Every merge group, push, dispatch and schedule builds it, and so does a pull request with light off or
// the full-ci label.  app-ci, the required check, passes a skipped build only on a pull request whose app_build is
// false, and only when both page and app were skipped.  Its shell runs here for each case.  Control: app-ci with the
// skip accepted on any event must fail a case (ci-paths' rule is held by the rows of part 1: light off, full-ci, every
// other event, and both kinds of change).
//
//   node scripts/test-app-light.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const yml = readFileSync(join(root, ".github", "workflows", "app.yml"), "utf8");
const dir = mkdtempSync(join(tmpdir(), "app-light-"));
let n = 0;

// 1. ci-paths: app_build per event, switch and files
function paths(event, files, env = {}) {
  const list = join(dir, "files.txt");
  writeFileSync(list, files.join("\n") + "\n");
  const r = spawnSync(process.execPath, [join(root, "scripts", "ci-paths.mjs")], { cwd: root, encoding: "utf8",
    env: { PATH: process.env.PATH, CI_PATHS_FILES: list, GITHUB_EVENT_NAME: event,
      GITHUB_REF: event === "pull_request" ? "refs/pull/1/merge" : event === "merge_group" ? "refs/heads/gh-readonly-queue/master/pr-1-x" : "refs/heads/master",
      GITHUB_BASE_REF: event === "pull_request" ? "master" : "", CI_PR_LABELS: "", ...env } });
  assert.equal(r.status, 0, r.stderr);
  return Object.fromEntries(r.stdout.trim().split("\n").map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
}
const LIGHT = { CI_PR_LIGHT: "true" };
for (const files of [["app/src-tauri/src/lib.rs"], ["wasm/pins.json"], [".github/workflows/app.yml"], ["web/index.html", "app/selftest/run.mjs"]])
  assert.equal(paths("pull_request", files, LIGHT).app_build, "true", `light, changes the app: ${files}`), n++;
for (const files of [["web/index.html"], ["src/compile.ts"], ["lib/_sage_matrix.py"], ["design/x.md"]])
  assert.equal(paths("pull_request", files, LIGHT).app_build, "false", `light, no app change: ${files}`), n++;
for (const files of [["web/index.html"], ["src/compile.ts"]]) {
  assert.equal(paths("pull_request", files).app_build, "true", `light off: ${files}`);
  assert.equal(paths("pull_request", files, { ...LIGHT, CI_PR_LABELS: "full-ci" }).app_build, "true", `full-ci: ${files}`);
  for (const event of ["merge_group", "push", "workflow_dispatch", "schedule"]) assert.equal(paths(event, files, LIGHT).app_build, "true", `${event}: ${files}`);
  n += 6;
}

// 2. app.yml's wiring: the paths step reads the checked-in switch as ci.yml does, wasm-changes exports app_build, and
// page (then app, which needs page) skips on app_build false
const block = (name) => { const s = yml.split(`\n  ${name}:\n`)[1]; return s.split(/\n  [a-z][a-z0-9-]*:\n/)[0]; };
assert.match(block("wasm-changes"), /\n      app_build: \$\{\{ steps\.paths\.outputs\.app_build \}\}\n/);
assert.match(block("wasm-changes"), /\n        run: CI_PR_LIGHT="\$\(head -n 1 \.github\/pr-ci-light 2>\/dev\/null \| tr -d ' \\t\\r'\)" node scripts\/ci-paths\.mjs >> "\$GITHUB_OUTPUT"\n/);
assert.match(block("page"), /\n    if: .*&& needs\.wasm-changes\.outputs\.app_build != 'false' \}\}\n/);
assert.match(block("app"), /needs\.page\.result == 'success'/);
assert.match(block("app-ci"), /\n          APP_BUILD: \$\{\{ needs\.wasm-changes\.outputs\.app_build \}\}\n/);
n += 5;

// 3. app-ci's own shell, per case: [event, app_build, wasm-changes, page, app, wasm-modules] -> passes?
const script = /\n        run: \|\n((?:          .*\n|\n)+)/.exec(block("app-ci"))[1].replace(/^          /gm, "");
function appCi(script, [EVENT, APP_BUILD, WASM_CHANGES, PAGE, APP, WASM]) {
  return spawnSync("bash", ["-e", "-c", script], { encoding: "utf8", env: { PATH: process.env.PATH, EVENT, APP_BUILD, WASM_CHANGES, PAGE, APP, WASM } }).status === 0;
}
const CASES = [
  [["pull_request", "false", "success", "skipped", "skipped", "skipped"], true, "light PR, no app change: the skipped build passes"],
  [["pull_request", "true", "success", "success", "success", "skipped"], true, "PR building the app, green"],
  [["pull_request", "true", "success", "skipped", "skipped", "skipped"], false, "PR that should build, skipped"],
  [["pull_request", "false", "success", "success", "failure", "skipped"], false, "app_build false but the build ran and failed"],
  [["pull_request", "false", "success", "skipped", "success", "skipped"], false, "only page skipped"],
  [["pull_request", "false", "failure", "skipped", "skipped", "skipped"], false, "wasm-changes failed"],
  [["pull_request", "false", "success", "skipped", "skipped", "failure"], false, "wasm-modules failed"],
  [["merge_group", "false", "success", "skipped", "skipped", "skipped"], false, "a merge group never skips"],
  [["merge_group", "true", "success", "success", "success", "success"], true, "merge group, green"],
  [["push", "", "skipped", "success", "success", "skipped"], true, "master push, green"],
  [["push", "", "skipped", "skipped", "skipped", "skipped"], false, "a push never skips"],
];
for (const [c, want, what] of CASES) assert.equal(appCi(script, c), want, what), n++;

// 4. controls: each must be caught
const lenient = script.replace('if [ "$EVENT" = pull_request ] && [ "$APP_BUILD" = false ]', 'if [ "$APP_BUILD" = false ] || [ "$EVENT" = merge_group ] || [ "$EVENT" = push ]');
assert.notEqual(lenient, script, "control applied");
assert.ok(CASES.some(([c, want]) => appCi(lenient, c) !== want), "control: the skip accepted on any event is caught");
const cp = readFileSync(join(root, "scripts", "ci-paths.mjs"), "utf8");
assert.ok(cp.includes("outputs.app_build = !prLight || matches(appBuildPaths);"), "ci-paths' app_build rule");
n += 3;
rmSync(dir, { recursive: true, force: true });
console.log(`app light: ${n} checks pass`);
