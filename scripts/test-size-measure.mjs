// ci: checks.6 order=10
// Stateless size gate: boundary, record integrity, normalization and event binding.
// No build or network access.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluate, growthLimit, producerProblems, recordProblems, strictParse, measureFiles,
  examplesFiles, testedTransition, gateInputs, TOOLCHAIN, MAX_DEPTH, overCap, sha256 } from "./size-measure.mjs";

const key = { ...TOOLCHAIN, measure_sha256: "a".repeat(64) };
const record = (sizes, commit = "merge", k = key) => ({
  format: "sagebrush-size-record", v: 1, repo: "sagemathinc/sagebrush",
  commit, tree: "tree", key: k, bundles: Object.keys(sizes).sort(), sizes, neutral: {},
  run: { id: "7", attempt: "2", job: "checks" },
});
const compare = (base, merge, k = key) => evaluate({ merge: { record: record(merge, "merge", k) },
  base: { commit: "base", record: record(base, "base") } });
assert.equal(growthLimit(0), 50000);
assert.equal(growthLimit(2_500_000), 50000);
for (const [base, delta, ok] of [
  [0, 50000, true], [0, 50001, false], [1000, 50000, true], [1000, 50001, false],
  [2_500_000, 50000, true], [2_500_000, 50001, false],
  [10_000_000, 200000, true], [10_000_000, 200001, false],
  [10_000_049, 200000, true], [10_000_049, 200001, false],
  [100000, 0, true], [100000, -100000, true],
]) assert.equal(compare({ x: base }, { x: base + delta }).ok, ok, base + "/" + delta);
assert.equal(compare({ a: 1000 }, { a: 1000, added: 50000 }).ok, true);
assert.equal(compare({ a: 1000 }, { a: 1000, added: 50001 }).ok, false);
assert.deepEqual(compare({ gone: 1000 }, {}).rows[0],
  { bundle: "gone", base: 1000, merge: 0, delta: -1000, limit: 50000, note: "removed" });
assert.equal(compare({ a: 100000, b: 100000 }, { a: 0, b: 150001 }).ok, false, "shrink cannot offset another bundle");
assert.equal(compare({ x: 1 }, { x: 1 }, { ...key, bun: "wrong" }).ok, false);
assert.equal(compare({ x: 1 }, { x: 1 }, { ...key, node: "wrong" }).ok, false);
assert.equal(compare({ x: 1 }, { x: 1 }, { ...key, measure_sha256: "b".repeat(64) }).ok, false);
assert.equal(evaluate({ merge: { record: record({ x: 1 }) } }).ok, false, "missing base fails closed");
assert.equal(evaluate({ mode: "absolute", merge: { record: record({ x: 999999999 }) } }).ok, true);
for (const sizes of [{ x: -1 }, { x: 0.1 }, { x: Number.MAX_SAFE_INTEGER + 1 }])
  assert(recordProblems(record(sizes)).length);
assert(recordProblems({ ...record({ x: 1 }), bundles: ["x", "x"] }).length);
assert(recordProblems({ ...record({ x: 1 }), bundles: [] }).length);
assert(recordProblems({ ...record({ x: 1 }), repo: "wrong" }).length);
const env = { GITHUB_RUN_ID: "7", GITHUB_RUN_ATTEMPT: "2" };
assert.deepEqual(producerProblems(record({ x: 1 }), "merge", "tree", "checks", env), []);
assert(producerProblems(record({ x: 1 }), "wrong", "tree", "checks", env).length);
assert(producerProblems(record({ x: 1 }), "merge", "wrong", "checks", env).length);
assert(producerProblems(record({ x: 1 }), "merge", "tree", "size-base", env).length);
assert(producerProblems(record({ x: 1 }), "merge", "tree", "checks", { ...env, GITHUB_RUN_ATTEMPT: "3" }).length);
assert.throws(() => strictParse('{"a":1,"a":2}'), /duplicate/);
assert.throws(() => strictParse('{"a":1e3}'), /integer/);
assert.throws(() => strictParse("[".repeat(MAX_DEPTH + 1) + "0" + "]".repeat(MAX_DEPTH + 1)), /nesting/);
assert(overCap("record", 262145, 262144));
assert.equal(overCap("record", 262144, 262144), null);
assert.equal(gateInputs(["scripts/size-measure.mjs"]).length, 1);
assert.equal(gateInputs(["README.md"]).length, 0);

const dir = mkdtempSync(join(tmpdir(), "stateless-size-"));
try {
  mkdirSync(join(dir, "examples"));
  writeFileSync(join(dir, "examples", "x.txt"), "x");
  assert.equal(examplesFiles(dir)["examples/corpus"].length, 1);
  const f = join(dir, "bundle.js");
  writeFileSync(f, 'globalThis.__SAGEBRUSH_VERSION__="1";globalThis.__SAGEBRUSH_BUILD_ID__="id";' + dir);
  const values = { VERSION: "1", BUILD_ID: "id" };
  const files = Object.fromEntries(["cli/pyjs.cjs", "cli/lib.gen.js", "engine/sagebrush-worker.js"].map(k => [k, [f]]));
  const a = measureFiles(files, dir, values);
  assert.deepEqual(a.problems, []);
  writeFileSync(f, 'globalThis.__SAGEBRUSH_VERSION__="0.10.222";globalThis.__SAGEBRUSH_BUILD_ID__="long-id";' + dir);
  const b = measureFiles(files, dir, { VERSION: "0.10.222", BUILD_ID: "long-id" });
  assert.deepEqual(b.problems, []);
  assert.equal(a.sizes["cli/pyjs.cjs"], b.sizes["cli/pyjs.cjs"]);
  writeFileSync(f, "");
  assert(measureFiles({ "cli/pyjs.cjs": [f] }, dir, values).problems.length);

  const git = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-q"); git("config", "user.email", "size@test"); git("config", "user.name", "size");
  git("add", "."); git("commit", "-qm", "base");
  const base = git("rev-parse", "HEAD");
  git("checkout", "-qb", "feature");
  writeFileSync(join(dir, "feature"), "feature"); git("add", "."); git("commit", "-qm", "feature");
  const head = git("rev-parse", "HEAD");
  git("checkout", "-qb", "integration", base); git("merge", "--no-ff", "-qm", "tested merge", head);
  const merge = git("rev-parse", "HEAD");
  const t = testedTransition({ cwd: dir, name: "pull_request", ev: { pull_request: { head: { sha: head } } } });
  assert.deepEqual(t, { mode: "transition", base, head, merge });
  assert.throws(() => testedTransition({ cwd: dir, name: "pull_request", ev: { pull_request: { head: { sha: base } } } }));
  assert.equal(testedTransition({ cwd: dir, name: "push", ev: { before: base } }).base, base);
  assert.equal(testedTransition({ cwd: dir, name: "merge_group", ev: { merge_group: { base_sha: base } } }).base, base);
  assert.throws(() => testedTransition({ cwd: dir, name: "merge_group", ev: { merge_group: { base_sha: head } } }));
  assert.equal(testedTransition({ cwd: dir, name: "schedule" }).mode, "absolute");
  git("checkout", "-qb", "new-master", base);
  writeFileSync(join(dir, "unrelated"), "master moved"); git("add", "."); git("commit", "-qm", "master move");
  const tip = git("rev-parse", "HEAD"); git("checkout", "-q", "feature");
  assert.equal(testedTransition({ cwd: dir, name: "workflow_dispatch", master: tip }).base, base, "no forced master merge");

  // Exercise the actual CLI, record admission, exit status and summary output.
  git("checkout", "-q", "integration");
  mkdirSync(join(dir, "scripts"));
  const source = readFileSync(new URL("./size-measure.mjs", import.meta.url));
  const script = join(dir, "scripts", "size-measure.mjs");
  writeFileSync(script, source);
  const eventPath = join(dir, "event.json"), summary = join(dir, "summary.md");
  writeFileSync(eventPath, JSON.stringify({ pull_request: { head: { sha: head } } }));
  const make = (sizes, commit, job) => ({ ...record(sizes, commit, { ...key, measure_sha256: sha256(source) }),
    tree: git("rev-parse", commit + "^{tree}"), event: "pull_request", run: { id: "123", attempt: "1", job } });
  writeFileSync(join(dir, "base-record.json"), JSON.stringify(make({ x: 1_000_000 }, base, "size-base")));
  const put = n => writeFileSync(join(dir, "merge-record.json"), JSON.stringify(make({ x: n }, merge, "checks")));
  const run = (extra = [], overrides = {}) => spawnSync(process.execPath, [script, "--gate", "--records", dir, ...extra], {
    encoding: "utf8", env: { ...process.env, GITHUB_EVENT_NAME: "pull_request", GITHUB_EVENT_PATH: eventPath,
      GITHUB_RUN_ID: "123", GITHUB_RUN_ATTEMPT: "1", GITHUB_STEP_SUMMARY: summary, ...overrides },
  });
  put(1_050_000);
  assert.equal(run().status, 0);
  assert.equal(run([], { GITHUB_RUN_ATTEMPT: "2" }).status, 1, "another attempt's record is rejected");
  assert.match(readFileSync(summary, "utf8"), /\| x \| 1000000 \| 1050000 \| \+50000 \| 50000 \|/);
  put(1_050_001);
  assert.equal(run().status, 1);
  assert.equal(run(["--docs-only"]).status, 0);
  assert.equal(run(["--docs-only"], { SIZE_GATE_NODE: "true" }).status, 1);
  const bad = make({ x: 1 }, merge, "checks"); bad.key.measure_sha256 = "a".repeat(64);
  writeFileSync(join(dir, "merge-record.json"), JSON.stringify(bad));
  assert.match(run().stdout, /recipe is not this run/);
  writeFileSync(join(dir, "merge-record.json"), " ".repeat(262145));
  assert.match(run().stdout, /refused before parsing/);
  rmSync(join(dir, "base-record.json"));
  assert.equal(run().status, 1, "missing records fail closed");
} finally { rmSync(dir, { recursive: true, force: true }); }

// Workflow wiring: base always rebuilt under this run's recipe/pins, no epochs,
// and advice must not read the removed budget file.
const ci = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
assert(!ci.includes("need_old")); assert(!ci.includes("--legacy")); assert(!ci.includes("size-advice.mjs --core"));
for (const [name, pin] of [["bun-version", TOOLCHAIN.bun], ["node-version", TOOLCHAIN.node]])
  assert(ci.includes(name + ': "' + pin + '"'));
assert(!readFileSync(new URL("./size-measure.mjs", import.meta.url), "utf8").includes("function epochReset"));
console.log("test-size-measure: stateless boundaries, records, normalization, transitions and CI all pass");
