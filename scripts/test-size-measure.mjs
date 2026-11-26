// ci: checks.6 order=10
// Stateless size gate: boundary, record integrity, normalization and event binding.
// No build or network access.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluate, growthLimit, producerProblems, recordProblems, strictParse, measureFiles,
  examplesFiles, testedTransition, gateInputs, TOOLCHAIN, MAX_DEPTH, overCap, sha256,
  CONTENT_BUNDLES, CONTENT_ALLOWANCE, limitOf, welcomeDirs, targetBranch } from "./size-measure.mjs";

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
// The examples gallery's content (fetched only when the gallery is opened): its own limit, 256,000 B, failing above it,
// whatever its base; exactly these three bundles.  Every other bundle, examples/welcome included, keeps the backstop.
assert.deepEqual(CONTENT_BUNDLES, ["examples/corpus", "site/examples", "examples/index.json"]);
assert.equal(CONTENT_ALLOWANCE, 256000);
for (const b of CONTENT_BUNDLES) for (const [base, delta, ok] of [[0, 256000, true], [0, 256001, false], [1_000_000, 256000, true], [1_000_000, 256001, false], [50_000_000, 256001, false], [400000, -400000, true]]) {
  const r = compare({ [b]: base }, { [b]: base + delta });
  assert.equal(r.ok, ok, b + " " + base + "/" + delta);
  if (!ok) assert.match(r.problems[0], /the examples content limit, 256,000 B/);
}
for (const b of ["examples/welcome", "cli/pyjs.cjs", "engine/sagebrush-worker.js", "examples/corpusx", "site/examples/x"]) {
  assert.equal(limitOf(b, 0), 50000, b);
  assert.equal(compare({ [b]: 1000 }, { [b]: 1000 + 50001 }).ok, false, b);
  assert.match(compare({ [b]: 1000 }, { [b]: 1000 + 50001 }).problems[0], /both 2% and 50,000 B/);
}
// (a gallery change and a code change in one PR: the code bundle still fails at its own limit)
assert.equal(compare({ "examples/corpus": 100, "cli/pyjs.cjs": 1000 }, { "examples/corpus": 200100, "cli/pyjs.cjs": 52000 }).ok, false);
assert.equal(compare({ "examples/corpus": 100, "cli/pyjs.cjs": 1000 }, { "examples/corpus": 200100, "cli/pyjs.cjs": 51000 }).ok, true);
assert.equal(compare({ a: 1000 }, { a: 1000, added: 50000 }).ok, true);
assert.equal(compare({ a: 1000 }, { a: 1000, added: 50001 }).ok, true);
const split = compare({ "engine/lib/sage.pre": 1_000_000, "engine/lib/sage.src": 500_000 },
  { "engine/lib/sage.pre": 463_204, "engine/lib/sage.src": 381_687,
    "engine/lib/mod-sage-ffmat.pre": 538_944, "engine/lib/mod-sage-ffmat.src": 119_962 });
assert.equal(split.ok, true, "a lazy split reports new chunks without failing them");
assert.deepEqual(split.rows.find(r => r.bundle === "engine/lib/mod-sage-ffmat.pre"),
  { bundle: "engine/lib/mod-sage-ffmat.pre", base: 0, merge: 538944, delta: 538944, limit: 50000, note: "new" });
assert.equal(compare({}, { standalone: 999_999_999 }).ok, true, "all genuinely new bundles are report-only");
assert.equal(compare({ x: 0 }, { x: 50001 }).ok, false, "present zero-byte bundle is not new");
assert.equal(compare({ x: 1000 }, { x: 51001, added: 999999 }).ok, false, "new bundle cannot exempt existing growth");
assert.deepEqual(compare({ gone: 1000 }, {}).rows[0],
  { bundle: "gone", base: 1000, merge: 0, delta: -1000, limit: 50000, note: "removed" });
assert.equal(compare({ a: 100000, b: 100000 }, { a: 0, b: 150001 }).ok, false, "shrink cannot offset another bundle");
const count = compare({ "registry/packages": 300 }, { "registry/packages": 50300 });
assert.equal(count.ok, true);
assert.deepEqual(count.rows, [], "package counts are not gated or reported as bytes");
assert.deepEqual(evaluate({ mode: "absolute", merge: { record: record({ "registry/packages": 50300 }) } }).rows, []);
assert.equal(compare({ x: 1 }, { "\n| forged |": 1 }).ok, false);
// A master merge into a track (design/size-gate.md): also compared with the master commit merged in, its side; a
// bundle fails only when it is over the limit against both the track's base and the side.
const sided = (base, side, merge, k = key) => evaluate({ merge: { record: record(merge, "merge", k) },
  base: { commit: "base", record: record(base, "base") }, side: { commit: "side".padEnd(40, "0"), record: record(side, "side".padEnd(40, "0")) } });
{
  // (#2200's shape: the track is far behind master; the growth is master's, within the limit against master)
  const r = sided({ "engine/lib/sci.pre": 2_046_211 }, { "engine/lib/sci.pre": 2_190_000 }, { "engine/lib/sci.pre": 2_193_988 });
  assert.equal(r.ok, true, "master's own growth passes");
  assert(r.notes.some((n) => /engine\/lib\/sci\.pre: \+147777 over the track's base, but \+3988 against master side0/.test(n)), r.notes.join("; "));
  assert(r.notes.some((n) => /A master merge into a track/.test(n)));
  assert.deepEqual(r.rows[0], { bundle: "engine/lib/sci.pre", base: 2_046_211, merge: 2_193_988, delta: 147777, limit: 50000, note: "" });
}
for (const [base, side, merge, ok, why] of [
  [1000, 1000, 51001, false, "over against both: the track's own growth fails"],
  [1000, 1001, 51001, true, "exactly the limit against the side passes"],
  [1000, 1000, 50999 + 2, false, "one byte over against both fails"],
  [1000, 900_000, 950_000, true, "within against the side"],
  [1000, 900_000, 950_001, false, "one byte over against the side too"],
  [1000, 1000, 1000, true, "no growth"],
]) assert.equal(sided({ x: base }, { x: side }, { x: merge }).ok, ok, why);
assert.equal(sided({ x: 1000 }, {}, { x: 900_000 }).ok, false, "a bundle the side doesn't have: the track's own, gated against the base alone");
assert.equal(sided({ x: 1000 }, { x: 900_000 }, { x: 900_000 }, { ...key, bun: "wrong" }).ok, false, "the merge's toolchain still checked");
assert.equal(evaluate({ merge: { record: record({ x: 900_000 }) }, base: { commit: "base", record: record({ x: 1000 }, "base") },
  side: { commit: "side", record: { ...record({ x: 900_000 }, "side"), key: { ...key, measure_sha256: "c".repeat(64) } } } }).ok, false, "a side under another recipe fails closed");
assert.equal(evaluate({ merge: { record: record({ x: 900_000 }) }, base: { commit: "base", record: record({ x: 1000 }, "base") },
  side: { commit: "side", record: undefined } }).ok, false, "a missing side record fails closed");
{
  // (the side excuses growth only bundle by bundle: another bundle over against both still fails, in the
  //  track-pull wording)
  const r = sided({ a: 1000, b: 1000 }, { a: 900_000, b: 1000 }, { a: 900_000, b: 60_000 });
  assert.equal(r.ok, false);
  assert.deepEqual(r.problems, ["b: growth +59000 exceeds 50000 bytes (both 2% and 50,000 B)"]);
}
assert.equal(targetBranch("pull_request", { pull_request: { base: { ref: "track/numeric" } } }), "track/numeric");
assert.equal(targetBranch("merge_group", { merge_group: { base_ref: "refs/heads/track/math" } }), "track/math");
assert.equal(targetBranch("push", { ref: "refs/heads/track/numeric" }), "track/numeric");
assert.equal(targetBranch("push", {}, "refs/heads/master"), "master");
assert.equal(targetBranch("schedule", {}), null);
for (const name of ["x\ry", "x\ty", "x\u001by", "x|y", "x y"])
  assert(recordProblems(record({ [name]: 1 })).length, name);
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
  assert.equal(examplesFiles(dir)["examples/welcome"], undefined, "no welcome.ts: no welcome bundle");
  // (the first-visit notebooks web/examples/welcome.ts names: their own bundle, out of the corpus)
  mkdirSync(join(dir, "web", "examples"), { recursive: true });
  for (const s of ["welcome", "sage-first-steps", "welcome-extra", "other"]) {
    mkdirSync(join(dir, "examples", "notebook", s), { recursive: true });
    writeFileSync(join(dir, "examples", "notebook", s, "main.ipynb"), s);
  }
  writeFileSync(join(dir, "web", "examples", "welcome.ts"), 'const WELCOME: Record<string, string> = { Welcome: "welcome", Sage: "sage-first-steps" };\n');
  const ex = examplesFiles(dir);
  assert.deepEqual(ex["examples/welcome"].map((f) => f.slice(dir.length + 1)), ["examples/notebook/sage-first-steps/main.ipynb", "examples/notebook/welcome/main.ipynb"]);
  assert.deepEqual(ex["examples/corpus"].map((f) => f.slice(dir.length + 1)).sort(), ["examples/notebook/other/main.ipynb", "examples/notebook/welcome-extra/main.ipynb", "examples/x.txt"], "a prefix-named sibling stays in the corpus");
  // (fail closed: a map that can't be read is an error, never "no welcome notebooks")
  for (const bad of ["const WELCOME = {};\n", 'const WELCOME: Record<string, string> = { Welcome: welcomeSlug };\n', 'const WELCOME: Record<string, string> = { Welcome: "welcome", Sage: SAGE };\n', "// nothing\n",
    // (an expression is valid TypeScript, but names a slug the reading can't see: refused, never its literal prefix)
    'const WELCOME: Record<string, string> = { Welcome: "welcome" + "-extra", Sage: "sage-first-steps" };\n',
    'const WELCOME: Record<string, string> = { Welcome: `welcome`, Sage: "sage-first-steps" };\n',
    'const WELCOME: Record<string, string> = { Welcome: "welcome".concat("-extra") };\n',
    'const WELCOME: Record<string, string> = { Welcome: "welcome" /* x */ };\n',
    'const WELCOME: Record<string, string> = { "Welcome": "welcome", , Sage: "sage-first-steps" };\n',
    'const WELCOME: Record<string, string> = { ...OTHER, Sage: "sage-first-steps" };\n',
    'const WELCOME: Record<string, string> = { Welcome: "Welcome" };\n']) {
    writeFileSync(join(dir, "web", "examples", "welcome.ts"), bad);
    assert.throws(() => welcomeDirs(dir), /WELCOME map can't be read/, bad);
  }
  // (a trailing comma is fine)
  writeFileSync(join(dir, "web", "examples", "welcome.ts"), 'const WELCOME: Record<string, string> = { Welcome: "welcome", Sage: "sage-first-steps", };\n');
  assert.deepEqual(welcomeDirs(dir).map((d) => d.slice(dir.length + 1)), ["examples/notebook/welcome", "examples/notebook/sage-first-steps"]);
  // (the real welcome.ts reads, and names the corpus's own first-visit notebooks)
  assert.deepEqual(welcomeDirs(join(import.meta.dirname, "..")).map((d) => d.split("/").slice(-1)[0]), ["welcome", "sage-first-steps"]);
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
  // a queue group: head_sha is the tested commit, base_sha the queue's base, a different commit
  assert.deepEqual(testedTransition({ cwd: dir, name: "merge_group", ev: { merge_group: { base_sha: base, head_sha: merge } } }),
    { mode: "transition", merge, base, head: merge });
  assert.throws(() => testedTransition({ cwd: dir, name: "merge_group", ev: { merge_group: { base_sha: base } } }), /head_sha/);
  assert.throws(() => testedTransition({ cwd: dir, name: "merge_group", ev: { merge_group: { base_sha: base, head_sha: head } } }), /head_sha/);
  assert.throws(() => testedTransition({ cwd: dir, name: "merge_group", ev: { merge_group: { base_sha: merge, head_sha: merge } } }));
  // a later entry of a cumulative queue: HEAD^1 is the earlier entry, and the whole group is one transition from the base
  git("checkout", "-qb", "feature2", base);
  writeFileSync(join(dir, "feature2"), "feature2"); git("add", "."); git("commit", "-qm", "feature2");
  const head2 = git("rev-parse", "HEAD");
  git("checkout", "-qb", "queue", merge); git("merge", "--no-ff", "-qm", "second queue entry", head2);
  const merge2 = git("rev-parse", "HEAD");
  assert.equal(git("rev-parse", "HEAD^1"), merge);
  assert.deepEqual(testedTransition({ cwd: dir, name: "merge_group", ev: { merge_group: { base_sha: base, head_sha: merge2 } } }),
    { mode: "transition", merge: merge2, base, head: merge2 });
  assert.equal(testedTransition({ cwd: dir, name: "schedule" }).mode, "absolute");
  git("checkout", "-qb", "new-master", base);
  writeFileSync(join(dir, "unrelated"), "master moved"); git("add", "."); git("commit", "-qm", "master move");
  const tip = git("rev-parse", "HEAD"); git("checkout", "-q", "feature");
  assert.equal(testedTransition({ cwd: dir, name: "workflow_dispatch", master: tip }).base, base, "no forced master merge");
  git("checkout", "-q", "queue");
  assert.throws(() => testedTransition({ cwd: dir, name: "merge_group", ev: { merge_group: { base_sha: tip, head_sha: merge2 } } }), /merge-base|ancestor|Command failed/, "a base that isn't an ancestor");
  // A change into a track: when it merges master commits the track doesn't have, the master commit merged in (the
  // merge-base of the tested commit and master) is its side; otherwise there is none.
  let trackCase;
  {
    git("checkout", "-qb", "track-x", base);
    writeFileSync(join(dir, "track-work"), "track"); git("add", "."); git("commit", "-qm", "track work");
    const trackTip = git("rev-parse", "HEAD");
    git("checkout", "-qb", "sync", trackTip); git("merge", "--no-ff", "-qm", "Merge master into the track", tip);
    const syncHead = git("rev-parse", "HEAD");
    git("checkout", "-qb", "sync-pr", trackTip); git("merge", "--no-ff", "-qm", "tested merge of the sync", syncHead);
    const syncMerge = git("rev-parse", "HEAD");
    trackCase = { trackTip, syncHead, syncMerge };
    const pr = (ref, head = syncHead) => ({ pull_request: { head: { sha: head }, base: { ref } } });
    assert.deepEqual(testedTransition({ cwd: dir, name: "pull_request", ev: pr("track/x"), master: tip }),
      { mode: "transition", merge: syncMerge, base: trackTip, head: syncHead, side: tip, master: tip }, "a sync into a track: master's commit is the side");
    // (master has moved on since: the side is still the commit the change merges, not today's tip)
    git("checkout", "-qb", "master-later", tip);
    writeFileSync(join(dir, "later"), "later"); git("add", "."); git("commit", "-qm", "master later");
    const later = git("rev-parse", "HEAD");
    git("checkout", "-q", "sync-pr");
    assert.equal(testedTransition({ cwd: dir, name: "pull_request", ev: pr("track/x"), master: later }).side, tip);
    assert.equal(testedTransition({ cwd: dir, name: "pull_request", ev: pr("master"), master: tip }).side, undefined, "a pull request into master has no side");
    assert.equal(testedTransition({ cwd: dir, name: "merge_group", ev: { merge_group: { base_sha: trackTip, head_sha: syncMerge, base_ref: "refs/heads/track/x" } }, master: tip }).side, tip, "the track's queue too");
    assert.equal(testedTransition({ cwd: dir, name: "push", ev: { before: trackTip, ref: "refs/heads/track/x" }, master: tip }).side, tip, "the track's push too");
    // (a change into the track that brings no new master commits: no side)
    git("checkout", "-qb", "track-only", syncMerge);
    writeFileSync(join(dir, "more-track"), "more"); git("add", "."); git("commit", "-qm", "more track work");
    const plainHead = git("rev-parse", "HEAD");
    git("checkout", "-qb", "plain-pr", syncMerge); git("merge", "--no-ff", "-qm", "tested merge of track work", plainHead);
    const plain = testedTransition({ cwd: dir, name: "pull_request", ev: pr("track/x", plainHead), master: tip });
    assert.equal(plain.side, undefined, "no new master commits: gated against the track alone");
    assert.equal(plain.base, syncMerge);
    assert.equal(plain.master, tip, "master as resolved, kept even without a side, for the gate job");
    // (master merging the track change's own head, resolving its growth away there, doesn't make that head a side:
    //  the side is on master's first-parent line, and here the change brings no new master commit)
    git("checkout", "-qb", "master-took-track", tip); git("merge", "--no-ff", "-qm", "master merges the track work", plainHead);
    const masterTook = git("rev-parse", "HEAD");
    git("checkout", "-q", "plain-pr");
    assert.equal(testedTransition({ cwd: dir, name: "pull_request", ev: pr("track/x", plainHead), master: masterTook }).side, undefined,
      "the track's own head, reached by master through a second parent, is never the side");
    // (and when the change also merges a newer master commit, the side is that commit)
    git("checkout", "-qb", "sync2", plainHead); git("merge", "--no-ff", "-qm", "merge master again", masterTook);
    const sync2Head = git("rev-parse", "HEAD");
    git("checkout", "-qb", "sync2-pr", syncMerge); git("merge", "--no-ff", "-qm", "tested merge of the second sync", sync2Head);
    assert.equal(testedTransition({ cwd: dir, name: "pull_request", ev: pr("track/x", sync2Head), master: masterTook }).side, masterTook);
    git("checkout", "-q", "plain-pr");
    // (no origin/master and none given: refused, never silently gated against the track alone)
    assert.throws(() => testedTransition({ cwd: dir, name: "pull_request", ev: pr("track/x", plainHead), master: "" }), /refs\/remotes\/origin\/master/);
  }
  git("checkout", "-q", "feature");

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
  writeFileSync(join(dir, "merge-record.json"), JSON.stringify(make({ x: 1_000_000, lazy: 538_944 }, merge, "checks")));
  assert.equal(run().status, 0, "actual gate accepts a new chunk");
  assert.match(readFileSync(summary, "utf8"), /\| lazy \| 0 \| 538944 \| \+538944 \| 50000 \| new \|/);
  assert.equal(run(["--docs-only"]).status, 0);
  assert.equal(run(["--docs-only"], { SIZE_GATE_NODE: "true" }).status, 1);
  const bad = make({ x: 1 }, merge, "checks"); bad.key.measure_sha256 = "a".repeat(64);
  writeFileSync(join(dir, "merge-record.json"), JSON.stringify(bad));
  assert.match(run().stdout, /recipe is not this run/);
  writeFileSync(join(dir, "merge-record.json"), JSON.stringify(make({ "\n| forged |": 1 }, merge, "checks")));
  const forged = run();
  assert.equal(forged.status, 1);
  assert.match(forged.stdout, /printable path-like/);
  assert(!forged.stdout.includes("\n| forged |"), "untrusted bundle names cannot inject summary rows");
  writeFileSync(join(dir, "merge-record.json"), " ".repeat(262145));
  assert.match(run().stdout, /refused before parsing/);
  // (the real gate on a master merge into a track: the base and the master side, both from size-base)
  {
    const { trackTip, syncHead, syncMerge } = trackCase;
    git("checkout", "-q", "sync-pr");
    writeFileSync(script, source);
    const trackEvent = join(dir, "track-event.json");
    writeFileSync(trackEvent, JSON.stringify({ pull_request: { head: { sha: syncHead }, base: { ref: "track/x" } } }));
    writeFileSync(join(dir, "base-record.json"), JSON.stringify(make({ x: 1_000_000 }, trackTip, "size-base")));
    writeFileSync(join(dir, "merge-record.json"), JSON.stringify(make({ x: 1_200_000 }, syncMerge, "checks")));
    const trackRun = () => run([], { GITHUB_EVENT_PATH: trackEvent, SIZE_DISPATCH_MASTER: tip });
    assert.equal(trackRun().status, 1, "no side record: fails closed");
    writeFileSync(join(dir, "side-record.json"), JSON.stringify(make({ x: 1_190_000 }, tip, "size-base")));
    const ok = trackRun();
    assert.equal(ok.status, 0, "master's own growth passes: " + ok.stdout);
    assert.match(readFileSync(summary, "utf8"), /master side /);
    assert.match(readFileSync(summary, "utf8"), /x: \+200000 over the track's base, but \+10000 against master/);
    writeFileSync(join(dir, "side-record.json"), JSON.stringify(make({ x: 1_100_000 }, tip, "size-base")));
    assert.equal(trackRun().status, 1, "over against both fails");
    writeFileSync(join(dir, "side-record.json"), JSON.stringify(make({ x: 1_190_000 }, trackTip, "size-base")));
    assert.equal(trackRun().status, 1, "a side record of another commit is refused");
    writeFileSync(join(dir, "side-record.json"), JSON.stringify(make({ x: 1_190_000 }, tip, "checks")));
    const wrongJob = trackRun();
    assert.equal(wrongJob.status, 1, "a side record from another job is refused");
    assert.match(wrongJob.stdout, /record producer does not match this run, attempt and size-base job/);
    rmSync(join(dir, "side-record.json"));
    writeFileSync(join(dir, "base-record.json"), JSON.stringify(make({ x: 1_000_000 }, base, "size-base")));
    git("checkout", "-q", "integration");
    writeFileSync(script, source);
  }
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
// (the master side of a master merge into a track: built and recorded by size-base, read by the gate as side-record.json)
assert.equal(ci.split("if: steps.resolve.outputs.side != ''").length - 1, 4, "size-base's four side steps (worktree, install, build, record) run when there is a side");
assert(ci.includes('--root "$RUNNER_TEMP/size-side" --out "$RUNNER_TEMP/size-records/side-record.json"'), "the side's record");
assert(ci.includes("for w in size-base size-side; do"), "both worktrees removed");
assert(readFileSync(new URL("./size-measure.mjs", import.meta.url), "utf8").includes('readRecord(dir, "side-record.json")'));
// A track pull (design/size-gate.md, "Track pulls"): the workflow excuses growth only when every problem
// matches this pattern, so evaluate's growth wording is pinned here; drift fails closed.
const TRACK_PULL_GROWTH = "/: growth \\+\\d+ exceeds \\d+ bytes/";
assert(ci.includes(TRACK_PULL_GROWTH + ".test(p)"), "the track-pull filter in ci.yml is this pattern");
const trackGrowth = new RegExp(": growth \\+\\d+ exceeds \\d+ bytes");
for (const r of [compare({ x: 1000 }, { x: 51001 }), compare({ "examples/corpus": 100 }, { "examples/corpus": 300000 })]) {
  assert.equal(r.ok, false); assert(r.rows.length > 0);
  assert(r.problems.every((q) => trackGrowth.test(q)), "growth wording matches the track-pull filter: " + r.problems);
}
assert(!recordProblems(undefined).some((q) => trackGrowth.test(q)), "a record problem is never excused as growth");
console.log("test-size-measure: stateless boundaries, records, normalization, transitions and CI all pass");
