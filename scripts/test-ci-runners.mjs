// ci: checks.3 order=146
// Which runner each job takes (William, Nov 22 2026: self-hosted runners labelled sagebrush-ci, the repository variable
// SB_CI_RUNNER their switch; @sagebrush's ruling on astra4's review of the runner plan).  Every workflow is read as
// GitHub reads it, and every job's runs-on evaluated for every event:
// - with SB_CI_RUNNER set, exactly the jobs scripts/ci-runner-jobs.json names take it, and only for a merge-queue group
//   or a push to master (not a track: track branches have no ruleset, SEC Nov 28 2026); every pull request (this repository's too, a fork's, a deleted fork's), the
//   schedule and a dispatch stay on GitHub's runners; wasm-modules stays there on master's push (wasm-publish
//   publishes its modules);
// - no named job holds a secret, an environment, an OIDC token or a write permission; the jobs not named (wasm-publish,
//   macOS, Windows) don't move; no other workflow names the variable;
// - with SB_CI_RUNNER unset, every job runs where it ran before (vars.CI_RUNNER, else GitHub's).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const dir = join(root, ".github", "workflows");
const parse = (file) => JSON.parse(execFileSync("bun", ["-e", "console.log(JSON.stringify(Bun.YAML.parse(await Bun.file(process.argv[1]).text())))", file], { encoding: "utf8" }));
const spec = JSON.parse(readFileSync(join(root, "scripts", "ci-runner-jobs.json"), "utf8"));
let n = 0;

// ---- the list itself
assert.equal(spec.repository, "sagemathinc/sagebrush");
assert.equal(spec.workflow, ".github/workflows/ci.yml");
assert.deepEqual(spec.events, ["merge_group", "push refs/heads/master"]);
assert.deepEqual(spec.not_for, { "wasm-modules": ["push refs/heads/master"] });
assert.deepEqual(spec.jobs, [...new Set(spec.jobs)].sort(), "the jobs, sorted, once each");
n += 5;

const T = "vars.SB_CI_RUNNER != '' && (github.event_name == 'merge_group' || (github.event_name == 'push' && github.ref == 'refs/heads/master'))";
const TW = "vars.SB_CI_RUNNER != '' && github.event_name == 'merge_group'";
const RULE = { default: `\${{ ${T} && vars.SB_CI_RUNNER || vars.CI_RUNNER || 'ubuntu-24.04' }}`, "wasm-modules": `\${{ ${TW} && vars.SB_CI_RUNNER || vars.CI_RUNNER || 'ubuntu-24.04' }}` };

// ---- an evaluator of exactly these expressions (GitHub's && and || yield an operand, as JavaScript's do)
function runner(expr, ctx) {
  const m = /^\$\{\{\s*([\s\S]*?)\s*\}\}$/.exec(expr);
  if (!m) return expr;
  let e = m[1];
  const strings = [];
  e = e.replace(/'((?:[^']|'')*)'/g, (_, s) => `__S${strings.push(s.replace(/''/g, "'")) - 1}__`);
  e = e.replace(/vars\.([A-Z_]+)/g, (_, k) => `v[${JSON.stringify(k)}]`).replace(/github\.(event_name|ref)\b/g, (_, k) => `c.${k}`).replace(/\bstartsWith\(/g, "sw(");
  if (/\b(?!v\b|c\b|sw\b)[A-Za-z_]\w*\s*[.(]/.test(e.replace(/\bc\.(event_name|ref)\b/g, ""))) throw new Error(`an expression this evaluator doesn't model: ${expr}`);
  e = e.replace(/__S(\d+)__/g, (_, i) => JSON.stringify(strings[Number(i)]));
  const sw = (a, b) => String(a ?? "").toLowerCase().startsWith(String(b).toLowerCase());
  return Function("c", "v", "sw", `return (${e});`)(ctx, { SB_CI_RUNNER: "", CI_RUNNER: "", ...ctx.vars }, sw);
}
const EVENTS = {
  "merge_group": [{ event_name: "merge_group", ref: "refs/heads/gh-readonly-queue/master/pr-1-abc" }, "trusted"],
  "push master": [{ event_name: "push", ref: "refs/heads/master" }, "master"],
  "push track": [{ event_name: "push", ref: "refs/heads/track/math" }, "hosted"],
  "push other branch": [{ event_name: "push", ref: "refs/heads/feature" }, "hosted"],
  "push tag": [{ event_name: "push", ref: "refs/tags/app-v0.9.0" }, "hosted"],
  "pull_request (this repository)": [{ event_name: "pull_request", ref: "refs/pull/1/merge" }, "hosted"],
  "pull_request into a track": [{ event_name: "pull_request", ref: "refs/pull/2/merge" }, "hosted"],
  "pull_request_target": [{ event_name: "pull_request_target", ref: "refs/heads/master" }, "hosted"],
  "schedule": [{ event_name: "schedule", ref: "refs/heads/master" }, "hosted"],
  "workflow_dispatch on master": [{ event_name: "workflow_dispatch", ref: "refs/heads/master" }, "hosted"],
  "workflow_run": [{ event_name: "workflow_run", ref: "refs/heads/master" }, "hosted"],
  "a lookalike ref": [{ event_name: "push", ref: "refs/heads/master-x" }, "hosted"],
  "a lookalike track": [{ event_name: "push", ref: "refs/heads/tracking/x" }, "hosted"],
};

for (const file of readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort()) {
  const text = readFileSync(join(dir, file), "utf8");
  if (`.github/workflows/${file}` !== spec.workflow) {
    assert.ok(!text.includes("SB_CI_RUNNER"), `${file} doesn't name SB_CI_RUNNER`);
    n++;
    continue;
  }
  const w = parse(join(dir, file));
  const routed = [];
  for (const [name, job] of Object.entries(w.jobs)) {
    const on = String(job["runs-on"]);
    if (!on.includes("SB_CI_RUNNER")) {
      assert.ok(!spec.jobs.includes(name), `${file} ${name}: named in ci-runner-jobs.json, so it follows SB_CI_RUNNER`);
      continue;
    }
    routed.push(name);
    assert.ok(spec.jobs.includes(name), `${file} ${name}: not named in ci-runner-jobs.json, so it can't follow SB_CI_RUNNER`);
    // (nothing a named job holds is worth a runner's taking: no secret, environment, OIDC token or write permission)
    const json = JSON.stringify(job);
    assert.ok(!json.includes("secrets.") && job.environment === undefined, `${file} ${name}: holds a secret or an environment`);
    for (const [scope, level] of Object.entries(job.permissions ?? {})) assert.ok(level === "read" && scope !== "id-token", `${file} ${name}: ${scope}: ${level}`);
    assert.equal(on, RULE[name] ?? RULE.default, `${file} ${name}: its runs-on is the rule, exactly`);
    const notFor = spec.not_for[name] ?? [];
    for (const [label, [ev, kind]] of Object.entries(EVENTS)) {
      const moves = kind === "trusted" || (kind === "master" && !notFor.includes("push refs/heads/master"));
      assert.equal(runner(on, { ...ev, vars: { SB_CI_RUNNER: "sagebrush-ci" } }), moves ? "sagebrush-ci" : "ubuntu-24.04", `${name}, ${label}, switch on`);
      assert.equal(runner(on, { ...ev }), "ubuntu-24.04", `${name}, ${label}, switch off`);
      assert.equal(runner(on, { ...ev, vars: { CI_RUNNER: "other" } }), "other", `${name}, ${label}, CI_RUNNER alone`);
      assert.equal(runner(on, { ...ev, vars: { SB_CI_RUNNER: "sagebrush-ci", CI_RUNNER: "other" } }), moves ? "sagebrush-ci" : "other", `${name}, ${label}, both`);
      n++;
    }
  }
  assert.deepEqual(routed.sort(), spec.jobs, `${file}: exactly the named jobs follow the switch`);
  n++;
}
// (the publisher and the platforms stay where they are)
const ci = parse(join(dir, "ci.yml"));
assert.equal(ci.jobs["wasm-publish"]["runs-on"], "ubuntu-24.04");
assert.equal(ci.jobs["engine-nd-neon"]["runs-on"], "macos-15");
assert.equal(ci.jobs["windows-smoke"]["runs-on"], "windows-latest");
assert.ok(!spec.jobs.includes("wasm-publish") && spec.jobs.length === Object.keys(ci.jobs).length - 3);
n += 4;
console.log(`ci runners: ${n} checks pass`);
