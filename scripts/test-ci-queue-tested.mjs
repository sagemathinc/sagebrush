// ci: checks.3 order=99
// A master push of the commit the merge queue tested runs no test again (scripts/ci-queue-tested.mjs, scripts/ci-paths.mjs
// CI_QUEUE_TESTED; the CI capacity ruling's second cut, Nov 22 2026).
// 1. The lookup: only a successful merge_group run of ci.yml on this exact commit, in this repository, counts; any
//    doubt (another event or ref, no token, an error, a timeout, a non-200 answer, a run that differs in anything) is
//    a full run.
// 2. ci.yml's own job conditions, evaluated on ci-paths' outputs (as GitHub does: a job whose `if` has no status
//    function is skipped when a job it needs didn't succeed): a queue-tested push runs exactly the jobs a push alone
//    needs; an untested push runs what it ran before; and everything an untested push runs, the merge_group run on
//    the same commit runs too (bar wasm-publish, a push's own), with every output at least as wide, so the skipped
//    push repeats nothing the queue didn't already run.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { queueTested, WORKFLOW } from "./ci-queue-tested.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
let n = 0;

// ---- 1. the lookup
const SHA = "a".repeat(40), REPO = "sagemathinc/sagebrush";
const ENV = { GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/heads/master", GITHUB_REPOSITORY: REPO, GITHUB_SHA: SHA, GH_TOKEN: "t" };
const RUN = { id: 7, head_sha: SHA, event: "merge_group", status: "completed", conclusion: "success", path: WORKFLOW, repository: { full_name: REPO }, head_repository: { full_name: REPO } };
const answer = (runs, status = 200) => async (url, init) => {
  answer.seen = [url, init];
  return new Response(JSON.stringify({ total_count: runs.length, workflow_runs: runs }), { status });
};
const tested = async (env, fetch) => (await queueTested({ env, fetch, sleep: async () => {} })).tested;
assert.equal(await tested(ENV, answer([RUN])), true, "a successful merge_group run of ci.yml on this commit");
assert.match(answer.seen[0], new RegExp(`/repos/${REPO}/actions/workflows/ci\\.yml/runs\\?head_sha=${SHA}&event=merge_group&per_page=100$`));
assert.equal(answer.seen[1].headers.authorization, "Bearer t");
n += 3;
for (const [what, run] of [
  ["another commit", { ...RUN, head_sha: "b".repeat(40) }], ["another event", { ...RUN, event: "push" }],
  ["a failure", { ...RUN, conclusion: "failure" }], ["not completed", { ...RUN, status: "in_progress" }],
  ["another workflow", { ...RUN, path: ".github/workflows/app.yml" }], ["another repository", { ...RUN, repository: { full_name: "x/y" } }],
  ["another head repository", { ...RUN, head_repository: { full_name: "x/y" } }],
]) {
  assert.equal(await tested(ENV, answer([run])), false, what);
  n++;
}
for (const [what, env] of [
  ["a pull request", { ...ENV, GITHUB_EVENT_NAME: "pull_request" }], ["a merge_group run", { ...ENV, GITHUB_EVENT_NAME: "merge_group" }],
  ["a track push", { ...ENV, GITHUB_REF: "refs/heads/track/math" }], ["no token", { ...ENV, GH_TOKEN: "" }], ["a bad commit", { ...ENV, GITHUB_SHA: "HEAD" }],
]) {
  let called = false;
  assert.equal(await tested(env, async () => ((called = true), new Response("{}"))), false, what);
  assert.equal(called, false, `${what}: no lookup`);
  n++;
}
assert.equal(await tested(ENV, answer([], 200)), false, "no runs");
// (a matching run still in progress is asked again: it passes, or the lookups run out, or it fails)
{
  const seq = (...states) => { let i = 0; const f = async () => { f.calls = ++i; const s = states[Math.min(i, states.length) - 1]; return new Response(JSON.stringify({ workflow_runs: [{ ...RUN, ...s }] })); }; return f; };
  const slept = [];
  const later = seq({ status: "in_progress", conclusion: null }, { status: "in_progress", conclusion: null }, {});
  assert.equal((await queueTested({ env: ENV, fetch: later, sleep: async (ms) => slept.push(ms) })).tested, true, "completes on the third lookup");
  assert.deepEqual([later.calls, slept], [3, [30000, 30000]]);
  const never = seq({ status: "in_progress", conclusion: null });
  const r = await queueTested({ env: ENV, fetch: never, sleep: async () => {}, tries: 7 });
  assert.deepEqual([r.tested, never.calls], [false, 7], "gives up after 7 lookups");
  const fails = seq({ status: "in_progress", conclusion: null }, { conclusion: "failure" });
  assert.deepEqual([await tested(ENV, fails), fails.calls], [false, 2], "a run that then fails");
  // (an in-progress run of another commit, event or workflow isn't waited for)
  const other = seq({ status: "in_progress", conclusion: null, head_sha: "b".repeat(40) });
  assert.deepEqual([await tested(ENV, other), other.calls], [false, 1]);
  n += 4;
}
assert.equal(await tested(ENV, answer([RUN], 403)), false, "403");
assert.equal(await tested(ENV, async () => { throw new TypeError("fetch failed"); }), false, "a network error");
assert.equal(await tested(ENV, async () => new Response("not json")), false, "not JSON");
assert.equal(await tested(ENV, async () => new Response(JSON.stringify({ workflow_runs: "x" }))), false, "not a list");
n += 5;
// (the command line prints the output line; any doubt is false)
const cli = spawnSync(process.execPath, [join(root, "scripts", "ci-queue-tested.mjs")], { encoding: "utf8", env: { PATH: process.env.PATH, GITHUB_EVENT_NAME: "pull_request" } });
assert.equal(cli.status, 0);
assert.equal(cli.stdout, "queue_tested=false\n");
n++;

// ---- 2. ci.yml's job conditions on ci-paths' outputs
const yml = readFileSync(join(root, ".github", "workflows", "ci.yml"), "utf8");
const jobs = new Map();
for (const block of yml.split("\njobs:\n")[1].split(/\n(?=  [a-z][a-z0-9-]*:\n)/)) {
  const name = /^  ([a-z][a-z0-9-]*):\n/.exec(block)?.[1];
  if (!name) continue;
  const cond = /\n    if: (.*)/.exec("\n" + block)?.[1] ?? "";
  let needs = [];
  const inline = /\n    needs: (.*)/.exec("\n" + block)?.[1];
  if (inline !== undefined && inline.trim() !== "") needs = inline.replace(/^\[|\]$/g, "").split(",").map((s) => s.trim()).filter(Boolean);
  else if (/\n    needs:\n/.test("\n" + block)) needs = [...block.split(/\n    needs:\n/)[1].matchAll(/^      - ([a-z][a-z0-9-]*)$/gm)].map((m) => m[1]);
  const matrix = /\n        (?:shard|backend|name|include|groups): \$\{\{ fromJSON\(needs\.changes\.outputs\.([a-z_]+)\) \}\}/.exec(block)?.[1]
    ?? /\n      matrix: \$\{\{ fromJSON\(needs\.changes\.outputs\.([a-z_]+)\) \}\}/.exec(block)?.[1] ?? /fromJSON\(needs\.changes\.outputs\.([a-z_]+)\)/.exec(block.split("\n    steps:")[0].split("\n    strategy:")[1] ?? "")?.[1];
  jobs.set(name, { cond, needs, matrix });
}
assert.ok(jobs.size > 30 && jobs.has("changes") && jobs.has("ci") && jobs.has("wasm-publish"), `ci.yml's jobs read: ${jobs.size}`);
function evaluate(cond, ctx) {
  let e = cond.trim().replace(/^\$\{\{\s*/, "").replace(/\s*\}\}$/, "");
  if (e === "") return true;
  const strings = [];
  e = e.replace(/'((?:[^']|'')*)'/g, (_, s) => `__S${strings.push(s.replace(/''/g, "'")) - 1}__`);
  e = e.replace(/needs\.changes\.outputs\.([a-z_]+)/g, (_, k) => `o(${JSON.stringify(k)})`)
    .replace(/needs\.([a-z][a-z0-9-]*)\.result/g, (_, j) => `r(${JSON.stringify(j)})`)
    .replace(/github\.(event_name|ref|repository)/g, (_, k) => `g(${JSON.stringify(k)})`)
    .replace(/vars\.CI_RUNNER/g, '""')
    .replace(/\balways\(\)/g, "true").replace(/\bcancelled\(\)/g, "false")
    .replace(/\bfromJSON\(/g, "JSON.parse(").replace(/\bcontains\(/g, "has(");
  e = e.replace(/__S(\d+)__/g, (_, i) => JSON.stringify(strings[Number(i)]));
  if (/[a-zA-Z_$][\w$]*\.(?!parse\b)/.test(e.replace(/JSON\.parse/g, ""))) throw new Error(`an expression this evaluator doesn't model: ${cond}`);
  const has = (a, v) => (Array.isArray(a) ? a.includes(v) : String(a).includes(v));
  return Boolean(Function("o", "r", "g", "has", `return (${e});`)(ctx.o, ctx.r, ctx.g, has));
}
const STATUS = /\b(always|cancelled|success|failure)\(\)/;
function runSet(outputs, github) {
  const result = new Map([["changes", "success"]]);
  const order = [...jobs.keys()];
  for (let pass = 0; pass < order.length && result.size < order.length; pass++) {
    for (const name of order) {
      if (result.has(name)) continue;
      const job = jobs.get(name);
      if (!job.needs.every((j) => result.has(j))) continue;
      const ctx = { o: (k) => { assert.ok(k in outputs, `${name}: no output ${k}`); return String(outputs[k]); }, r: (j) => result.get(j), g: (k) => github[k] };
      let runs = evaluate(job.cond, ctx) && (STATUS.test(job.cond) || job.needs.every((j) => result.get(j) === "success"));
      if (runs && job.matrix) runs = JSON.parse(outputs[job.matrix]).length > 0;
      result.set(name, runs ? "success" : "skipped");
    }
  }
  assert.equal(result.size, order.length, "every job resolved");
  return new Set([...result].filter(([, v]) => v === "success").map(([k]) => k));
}
const dir = mkdtempSync(join(tmpdir(), "ci-queue-tested-"));
function paths(event, files, env = {}) {
  const list = join(dir, "files.txt");
  writeFileSync(list, files.join("\n") + "\n");
  const r = spawnSync(process.execPath, [join(root, "scripts", "ci-paths.mjs")], {
    cwd: root, encoding: "utf8",
    env: { PATH: process.env.PATH, CI_PATHS_FILES: list, GITHUB_EVENT_NAME: event, GITHUB_REF: event === "merge_group" ? "refs/heads/gh-readonly-queue/master/pr-1-x" : "refs/heads/master", ...env },
  });
  assert.equal(r.status, 0, r.stderr);
  return Object.fromEntries(r.stdout.trim().split("\n").map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
}
const github = (event_name) => ({ event_name, ref: event_name === "merge_group" ? "refs/heads/gh-readonly-queue/master/pr-1-x" : "refs/heads/master", repository: REPO });
const PUSH_ONLY = new Set(["wasm-publish"]);
const LIGHT = ["changes", "ci", "size-gate", "wasm-modules", "wasm-publish"];
// (sample pushes: the runtime, web, the engine, a mode suite, prose, the CPython package's Python, a mix)
for (const files of [["src/compile.ts"], ["web/notebook/x.ts"], ["engine/poly/src/lib.rs"], ["magma-tests/x.m"], ["design/x.md"],
  ["engine/py/python/sagebrush/cli.py"], ["src/a.ts", "web/board/b.ts", "engine/mp/src/c.rs", "examples/board/hello/main.board.json"]]) {
  const tested = paths("push", files, { CI_QUEUE_TESTED: "true" }), untested = paths("push", files, { CI_QUEUE_TESTED: "false" });
  const before = paths("push", files), queue = paths("merge_group", files);
  assert.equal(tested.queue_tested, "true", files.join());
  assert.equal(untested.queue_tested, "false", files.join());
  assert.deepEqual([...runSet(tested, github("push"))].sort(), LIGHT, `${files.join()}: a queue-tested push runs only what a push alone needs`);
  const full = runSet(untested, github("push"));
  assert.deepEqual([...full].sort(), [...runSet(before, github("push"))].sort(), `${files.join()}: an untested push runs what it ran before`);
  assert.ok(full.size > 30, `${files.join()}: an untested push runs the full set (${full.size})`);
  const mg = runSet(queue, github("merge_group"));
  for (const job of full) if (!PUSH_ONLY.has(job)) assert.ok(mg.has(job), `${files.join()}: ${job} runs on a push, so the merge_group run must run it too`);
  // (and each of the untested push's outputs is no wider than the merge_group run's: a selection it makes, the queue made)
  for (const [k, v] of Object.entries(untested)) {
    if (k === "files" || k === "queue_tested") continue;
    if (v === "true") assert.equal(queue[k], "true", `${files.join()}: ${k}`);
    else if (v.startsWith("[")) {
      const a = JSON.parse(v).map((x) => JSON.stringify(x)), b = new Set(JSON.parse(queue[k]).map((x) => JSON.stringify(x)));
      for (const x of a) assert.ok(b.has(x), `${files.join()}: ${k} ${x} on a push, not in the merge_group run`);
    }
  }
  n += 6;
}
// ---- PR CI light (CI_PR_LIGHT, the repository variable PR_CI_LIGHT): a pull request runs only checks, the size gate
// with its size-base, and the modules' build when it needs one; queue groups, pushes and a full-ci label are untouched
{
  const pr = (files, env = {}) => paths("pull_request", files, { GITHUB_REF: "refs/pull/1/merge", ...env });
  const PR = { event_name: "pull_request", ref: "refs/pull/1/merge", repository: REPO };
  const LIGHT = ["changes", "checks", "ci", "size-base", "size-gate"];
  for (const files of [["src/compile.ts"], ["web/notebook/x.ts"], ["src/a.ts", "web/board/b.ts", "magma-tests/x.m"], ["engine/poly/src/lib.rs"], ["engine/mp/src/c.rs", "src/x.ts"]]) {
    const off = pr(files), on = pr(files, { CI_PR_LIGHT: "true" });
    assert.equal(on.pr_light, "true", files.join());
    // (checks and size-base where checks would have run anyway; a Rust-only change never ran them and still doesn't: its
    // engine suites are left to the merge_group run, like every other suite)
    const checks = [off.node, off.web, off.size_inputs].includes("true");
    const want = [...(checks ? LIGHT : ["changes", "ci", "size-gate"]), ...(off.wasm_build === "true" ? ["wasm-modules"] : [])].sort();
    assert.deepEqual([...runSet(on, PR)].sort(), want, `${files.join()}: light runs only checks, the size gate and the modules' build`);
    assert.ok(runSet(off, PR).size > want.length, `${files.join()}: off, the full PR set`);
    // (the switch off, unset or anything but "true": exactly the outputs of no switch)
    for (const v of ["false", "1", "TRUE", ""]) assert.deepEqual(pr(files, { CI_PR_LIGHT: v }), { ...off }, `${files.join()}: CI_PR_LIGHT=${JSON.stringify(v)}`);
    // (full-ci asks for everything: light doesn't apply)
    const label = pr(files, { CI_PR_LIGHT: "true", CI_PR_LABELS: "full-ci" });
    assert.equal(label.pr_light, "false");
    assert.deepEqual(label, pr(files, { CI_PR_LABELS: "full-ci" }));
    n += 5;
  }
  // (a docs-only pull request: light changes nothing it runs)
  assert.deepEqual([...runSet(pr(["design/x.md"], { CI_PR_LIGHT: "true" }), PR)].sort(), [...runSet(pr(["design/x.md"]), PR)].sort());
  // (never a queue group, a push or a track push: the full set, whatever the switch says)
  for (const [event, gh] of [["merge_group", github("merge_group")], ["push", github("push")]]) {
    const o = paths(event, ["src/compile.ts"], { CI_PR_LIGHT: "true" });
    assert.equal(o.pr_light, "false", event);
    assert.deepEqual([...runSet(o, gh)].sort(), [...runSet(paths(event, ["src/compile.ts"]), gh)].sort(), event);
  }
  assert.equal(paths("push", ["src/x.ts"], { CI_PR_LIGHT: "true", GITHUB_REF: "refs/heads/track/math" }).full, "true");
  // (ci.yml passes the variable to ci-paths, and nothing else reads it)
  assert.match(yml, /\n          CI_PR_LIGHT: \$\{\{ vars\.PR_CI_LIGHT \}\}\n/);
  assert.equal((yml.match(/PR_CI_LIGHT/g) ?? []).length, 1, "the env line only");
  n += 5;
}
// (a track push, or a dispatch on master, ignores CI_QUEUE_TESTED: the full set)
const track = paths("push", ["src/x.ts"], { CI_QUEUE_TESTED: "true", GITHUB_REF: "refs/heads/track/math" });
assert.equal(track.queue_tested, "false");
assert.equal(track.full, "true");
const dispatch = paths("workflow_dispatch", [], { CI_QUEUE_TESTED: "true" });
assert.equal(dispatch.queue_tested, "false");
assert.equal(paths("pull_request", ["src/x.ts"], { CI_QUEUE_TESTED: "true", GITHUB_BASE_REF: "master" }).queue_tested, "false");
n += 3;
// (ci.yml wires it: changes may read the runs (actions: read), the lookup's output reaches ci-paths)
const changes = yml.split("\n  changes:\n")[1].split(/\n  [a-z][a-z0-9-]*:\n/)[0];
assert.match(changes, /\n    permissions:\n      contents: read\n      actions: read\n/);
assert.match(changes, /- id: queue\n[\s\S]*?run: node scripts\/ci-queue-tested\.mjs >> "\$GITHUB_OUTPUT"/);
assert.match(changes, /CI_QUEUE_TESTED: \$\{\{ steps\.queue\.outputs\.queue_tested \}\}/);
n += 3;
// (size-gate's gate step, run as written with node stubbed: a queue-tested push passes without measuring, as its
// merge_group run measured and passed this commit; 74aee607's push failed closed in the docs-only branch before this)
{
  const ci = JSON.parse(execFileSync("bun", ["-e", "console.log(JSON.stringify(Bun.YAML.parse(await Bun.file(process.argv[1]).text())))", join(root, ".github", "workflows", "ci.yml")], { encoding: "utf8" }));
  const step = ci.jobs["size-gate"].steps.find((x) => x.name === "the gate");
  assert.ok(step && step.env.QUEUE_TESTED === "${{ needs.changes.outputs.queue_tested }}", "the gate reads changes' queue_tested");
  const stub = join(dir, "stub");
  mkdirSync(stub, { recursive: true });
  writeFileSync(join(stub, "node"), '#!/bin/sh\necho "$*" >> "$NODE_CALLS"\nexit "${NODE_EXIT:-0}"\n', { mode: 0o755 });
  const gate = (env) => {
    const calls = join(dir, "calls"), summary = join(dir, "summary");
    writeFileSync(calls, ""); writeFileSync(summary, "");
    const r = spawnSync("bash", ["-e", "-c", step.run], { encoding: "utf8", env: { PATH: `${stub}:${process.env.PATH}`, RUNNER_TEMP: dir, GITHUB_STEP_SUMMARY: summary, NODE_CALLS: calls,
      CHANGES: "success", CHECKS: "skipped", BASE: "skipped", SIZE_GATE_NODE: "false", SIZE_GATE_WEB: "false", SIZE_INPUTS: "false", TRACK_PULL: "false", ...env } });
    return { status: r.status, calls: readFileSync(calls, "utf8"), summary: readFileSync(summary, "utf8") };
  };
  const tested = gate({ QUEUE_TESTED: "true", NODE_EXIT: "1" });
  assert.equal(tested.status, 0, "a queue-tested push passes the gate");
  assert.equal(tested.calls, "", "and measures nothing");
  assert.match(tested.summary, /passed it in its merge_group run/);
  for (const q of ["false", "", "TRUE"]) {
    const docs = gate({ QUEUE_TESTED: q });
    assert.match(docs.calls, /size-measure\.mjs --gate --docs-only/, `QUEUE_TESTED=${JSON.stringify(q)}: the docs-only gate still runs`);
    assert.equal(gate({ QUEUE_TESTED: q, NODE_EXIT: "1" }).status, 1, `QUEUE_TESTED=${JSON.stringify(q)}: and its failure still fails`);
  }
  // (changes didn't succeed: never excused, whatever queue_tested says)
  assert.equal(gate({ QUEUE_TESTED: "true", CHANGES: "failure" }).status, 1);
  assert.equal(gate({ QUEUE_TESTED: "true", CHANGES: "skipped", CHECKS: "success", BASE: "failure" }).status, 1);
  n += 9;
}
rmSync(dir, { recursive: true, force: true });
console.log(`ci queue-tested: ${n} checks pass`);
