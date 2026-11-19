// ci: checks.6 order=35
// Track branches receive full integration checks but never the bucket credential. Unpublished base pins are rebuilt
// from their source and verified, while desktop track runs consume only their same-run artifact.
import { readFileSync } from "node:fs";

const ci = readFileSync(".github/workflows/ci.yml", "utf8");
const app = readFileSync(".github/workflows/app.yml", "utf8");
let passed = 0;

function check(condition, message) {
  if (!condition) throw new Error(`test-wasm-publish-workflow: ${message}`);
  passed++;
}

for (const [name, workflow] of [["ci", ci], ["app", app]]) {
  check(/push:\n\s+branches: \[master, "track\/\*\*"\]/.test(workflow), `${name} push trigger must include master and track/** only`);
  check(workflow.includes("permissions:\n  contents: read"), `${name} must default to contents: read`);
}
check(ci.includes("cancel-in-progress: ${{ github.ref != 'refs/heads/master' && !startsWith(github.ref, 'refs/heads/track/') }}"),
  "started master and track integration runs must finish");

const start = ci.indexOf("\n  wasm-publish:\n");
const end = ci.indexOf("\n  engine-wasm:\n", start);
check(start >= 0 && end > start, "cannot isolate the wasm-publish job");
const job = ci.slice(start, end);
check(job.includes("github.ref == 'refs/heads/master'"), "publisher must require master exactly");
check(job.includes("(github.event_name == 'push' || github.event_name == 'workflow_dispatch')"),
  "publisher must accept master pushes and explicit master repair dispatches");
check(!job.includes("refs/heads/track/"), "no track ref may ever publish");
check(!job.includes("github.event_name == 'pull_request'"), "pull requests must never publish");
check(job.includes("environment: wasm-publish"), "publisher must keep credentials in the protected environment");
check(job.includes("group: wasm-publish"), "publisher must retain its global serialization");
check(job.includes("cancel-in-progress: false"), "a started publisher must never be cancelled");

const sizeStart = ci.indexOf("\n  size-base:\n");
const sizeEnd = ci.indexOf("\n  size-gate:\n", sizeStart);
check(sizeStart >= 0 && sizeEnd > sizeStart, "cannot isolate the size-base job");
const size = ci.slice(sizeStart, sizeEnd);
check((size.match(/"\$GITHUB_WORKSPACE\/scripts\/wasm-fetch-or-build\.mjs" --root/g) ?? []).length === 2,
  "both base worktrees must fetch or source-build unpublished pins");
check(size.includes("targets: wasm32-unknown-unknown"), "size-base source fallback needs the pinned wasm Rust target");

check(app.includes("cancel-in-progress: ${{ github.ref != 'refs/heads/master' && !startsWith(github.ref, 'refs/heads/track/') }}"),
  "started master and track app integration runs must not be cancelled");
const appChanges = app.slice(app.indexOf("\n  wasm-changes:\n"), app.indexOf("\n  wasm-modules:\n"));
const appModules = app.slice(app.indexOf("\n  wasm-modules:\n"), app.indexOf("\n  page:\n"));
for (const [name, section] of [["classifier", appChanges], ["builder", appModules]]) {
  check(section.includes("github.event_name == 'pull_request' || startsWith(github.ref, 'refs/heads/track/')"),
    `app wasm ${name} must use a same-run build on track refs`);
}
const release = app.slice(app.indexOf("\n  mac-release:\n"));
check(release.includes("github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/master' && inputs.sign"),
  "signing dispatch must require master exactly");
check(release.includes("github.event_name == 'push' && startsWith(github.ref, 'refs/tags/app-v')"),
  "a branch push, including track/**, must never enter the signing job");

console.log(`test-wasm-publish-workflow: ${passed} passed`);
