// ci: checks.6 order=37
// .github/workflows/engine-publish.yml: the bucket credential is reached only after ci succeeded for a push to master in
// this repository, or a dispatch on master, and only by the publish job, which installs nothing and runs only
// scripts/engine-publish.mjs; the build job holds no secret and pins CI's Bun and Node (an engine's id is its bytes).
//   node scripts/test-engine-publish-workflow.mjs
import { readFileSync } from "node:fs";

const wf = readFileSync(".github/workflows/engine-publish.yml", "utf8");
let passed = 0;
function check(condition, message) {
  if (!condition) throw new Error(`test-engine-publish-workflow: ${message}`);
  passed++;
}
const jobOf = (name, next) => {
  const start = wf.indexOf(`\n  ${name}:\n`);
  const end = next ? wf.indexOf(`\n  ${next}:\n`, start) : wf.length;
  check(start >= 0 && end > start, `cannot isolate the ${name} job`);
  return wf.slice(start, end);
};
const head = wf.slice(0, wf.indexOf("\njobs:\n"));
const build = jobOf("build", "publish"), publish = jobOf("publish");

// (the triggers: ci's completion on master, and a dispatch; nothing a pull request or a fork can start)
check(/\non:\n  workflow_run:\n    workflows: \[ci\]\n    types: \[completed\]\n    branches: \[master\]\n  workflow_dispatch:\n\n/.test(wf), "triggers must be exactly ci's completion on master and a dispatch");
for (const t of ["pull_request", "pull_request_target", "merge_group", "push:", "schedule", "workflow_call", "repository_dispatch"])
  check(!head.includes(t), `no ${t} trigger`);
check(/\npermissions: \{\}\n/.test(head), "the workflow's default permissions are none");
check(head.includes("group: engine-publish") && head.includes("cancel-in-progress: false"), "one publish at a time, never cancelled");

// (the gate, on the job every other job needs)
for (const c of [
  "github.repository == 'sagemathinc/sagebrush'",
  "github.event.workflow_run.conclusion == 'success'",
  "github.event.workflow_run.event == 'push'",
  "github.event.workflow_run.head_branch == 'master'",
  "github.event.workflow_run.head_repository.full_name == 'sagemathinc/sagebrush'",
  "(github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/master')",
]) check(build.includes(c), `build must require ${c}`);
check(publish.includes("needs: build"), "publish runs only after build (and so only through build's gate)");

// (no secret outside the publish job's one step; the publish job installs nothing and runs only the publisher)
check(!/secrets\./.test(head) && !/secrets\./.test(build), "no secret in the workflow's header or the build job");
check(!/environment:/.test(build), "the build job has no environment");
check(publish.includes("environment: wasm-publish"), "publish uses the wasm-publish environment (deployment branches: master)");
const secretLines = publish.split("\n").filter((l) => l.includes("secrets."));
check(secretLines.length === 3 && secretLines.every((l) => /^ {10}(R2_ACCOUNT_ID|AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY): \$\{\{ secrets\.R2_(ACCOUNT_ID|ACCESS_KEY_ID|SECRET_ACCESS_KEY) \}\}$/.test(l)),
  "exactly the three R2 names, as step env");
const runs = publish.split("\n").filter((l) => /^\s+(- )?run:/.test(l)).map((l) => l.trim());
check(JSON.stringify(runs) === JSON.stringify(['run: node scripts/engine-publish.mjs "$RUNNER_TEMP/engine"']), `publish runs exactly the publisher: ${JSON.stringify(runs)}`);
check(!/pnpm|npm |bun /.test(publish), "publish installs and builds nothing");
check((wf.match(/persist-credentials: false/g) ?? []).length === 2, "neither checkout keeps the token");
check(publish.includes("permissions:\n      contents: read") && build.includes("permissions:\n      contents: read"), "each job reads contents only");

// (the engine's bytes: CI's Bun and Node, the commit ci ran)
check(build.includes('bun-version: "1.4.4"') && build.includes('node-version: "24.21.0"'), "build pins Bun 1.4.4 and Node 24.21.0");
check(build.includes("github.event.workflow_run.head_sha") && build.includes("ref: ${{ steps.sha.outputs.sha }}"), "build checks out the commit ci ran");
check(publish.includes("ref: ${{ needs.build.outputs.sha }}"), "publish's publisher is that commit's");

console.log(`test-engine-publish-workflow: ${passed} passed`);
