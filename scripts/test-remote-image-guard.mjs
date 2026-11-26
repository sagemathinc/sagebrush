// ci: checks.3 order=61
// The remote image's publishing (.github/workflows/remote-image.yml, publish) admits only code that reached protected
// master: in this repository, a manual run asking to push on refs/heads/master, or a push of a v-tag whose exact
// commit passed full CI on master (release.yml's check), with the tag naming the built image's own version.  Its `if:`
// is read from the workflow and evaluated over the events below (GitHub's expression syntax, only the parts it uses:
// anything else in it fails this test); its CI check and its version check are read from the workflow and run here
// against a stub `gh` (answering from fixed run lists, through the real jq) and a stub `docker`. 
//
//   node scripts/test-remote-image-guard.mjs
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const text = readFileSync(join(root, ".github", "workflows", "remote-image.yml"), "utf8");
let failed = 0, passed = 0;
const ok = (c, what) => (c ? passed++ : (failed++, console.log("FAIL " + what)));
const jobText = (name) => new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [A-Za-z0-9_-]+:\\n|(?![\\s\\S]))`, "m").exec(text)?.[1] ?? null;
const publish = jobText("publish"), image = jobText("image");
if (!publish || !image) {
  console.log("FAIL the image and publish jobs in .github/workflows/remote-image.yml");
  process.exit(1);
}

// GitHub's expression syntax, as much as the condition uses: context names, 'strings', ==, !=, &&, ||, !, ( ) and
// startsWith(a, b).  A job's `if:` with no status function is GitHub's `success() && (...)`: here `image` succeeded.
function evaluate(expr, ctx) {
  const toks = expr.match(/\s*(?:'(?:[^']|'')*'|[A-Za-z_][A-Za-z0-9_.-]*|==|!=|&&|\|\||[!(),])/gy);
  if (!toks || toks.join("").length !== expr.length) throw new Error("an expression this test doesn't read: " + expr);
  const t = toks.map((s) => s.trim());
  let i = 0;
  const peek = () => t[i], eat = (x) => { if (t[i] !== x) throw new Error(`expected ${x} at ${t[i]}`); i++; };
  const value = (name) => {
    if (name === "true") return true;
    if (name === "false") return false;
    const v = name.split(".").reduce((o, k) => (o == null ? undefined : o[k]), ctx);
    if (v === undefined && !name.startsWith("inputs.")) throw new Error("an unknown context value: " + name);
    return v ?? null;
  };
  const primary = () => {
    const x = t[i++];
    if (x === "(") { const v = or(); eat(")"); return v; }
    if (x === "!") return !primary();
    if (x?.startsWith("'")) return x.slice(1, -1).replace(/''/g, "'");
    if (x === "startsWith") {
      eat("(");
      const a = or();
      eat(",");
      const b = or();
      eat(")");
      return String(a ?? "").toLowerCase().startsWith(String(b ?? "").toLowerCase());
    }
    if (/^(success|failure|cancelled|always)$/.test(x ?? "")) throw new Error("a status function this test doesn't read: " + x);
    if (/^[A-Za-z_]/.test(x ?? "")) return value(x);
    throw new Error("unexpected " + x);
  };
  const cmp = () => {
    let v = primary();
    while (peek() === "==" || peek() === "!=") {
      const op = t[i++], w = primary();
      const eq = typeof v === "string" && typeof w === "string" ? v.toLowerCase() === w.toLowerCase() : v === w;
      v = op === "==" ? eq : !eq;
    }
    return v;
  };
  const and = () => { let v = cmp(); while (peek() === "&&") { i++; const w = cmp(); v = v ? w : v; } return v; };
  const or = () => { let v = and(); while (peek() === "||") { i++; const w = and(); v = v ? v : w; } return v; };
  const v = or();
  if (i !== t.length) throw new Error("left over: " + t.slice(i).join(" "));
  return !!v;
}

// 1. publish's if: over the events
const raw = /^    if: (.+)$/m.exec(publish)?.[1];
const cond = raw && /^\$\{\{\s*([\s\S]*?)\s*\}\}$/.exec(raw) ? /^\$\{\{\s*([\s\S]*?)\s*\}\}$/.exec(raw)[1] : raw;
ok(!!cond, "publish has an if: on one line");
ok(/^    needs: image$/m.test(publish), "publish needs image");
const REPO = "sagemathinc/sagebrush";
const cases = [
  // [what, event, ref, inputs, repository, publishes]
  ["a push of a v-tag", "push", "refs/tags/v0.10.3", {}, REPO, true],
  ["a dispatch asking to push, on master", "workflow_dispatch", "refs/heads/master", { push: true }, REPO, true],
  ["a dispatch asking to push, on a side branch", "workflow_dispatch", "refs/heads/remote-docker", { push: true }, REPO, false],
  ["a dispatch asking to push, on track/math", "workflow_dispatch", "refs/heads/track/math", { push: true }, REPO, false],
  ["a dispatch asking to push, on a v-tag (the tag path has its own check)", "workflow_dispatch", "refs/tags/v0.10.3", { push: true }, REPO, false],
  ["a dispatch not asking to push, on master", "workflow_dispatch", "refs/heads/master", { push: false }, REPO, false],
  ["a dispatch with no inputs", "workflow_dispatch", "refs/heads/master", {}, REPO, false],
  ["a push to master", "push", "refs/heads/master", {}, REPO, false],
  ["a push of a branch named like a tag", "push", "refs/heads/v0.10.3", {}, REPO, false],
  ["a push of another tag", "push", "refs/tags/app-v0.4.0", {}, REPO, false],
  ["a pull request", "pull_request", "refs/pull/1/merge", { push: true }, REPO, false],
  ["a pull request whose ref looks like a tag", "pull_request", "refs/tags/v0.10.3", {}, REPO, false],
  ["a fork's push of a v-tag", "push", "refs/tags/v0.10.3", {}, "someone/sagebrush", false],
  ["a fork's dispatch on master", "workflow_dispatch", "refs/heads/master", { push: true }, "someone/sagebrush", false],
];
for (const [what, event_name, ref, inputs, repository, want] of cases) {
  let got;
  try {
    got = evaluate(cond, { github: { event_name, ref, repository }, inputs });
  } catch (e) {
    got = "error: " + e.message;
  }
  ok(got === want, `${what}: publish ${want ? "runs" : "doesn't run"} (got ${got})`);
}

// The run script of a step, by the start of its name, de-indented
function stepRun(job, name) {
  const lines = job.split("\n");
  const at = lines.findIndex((l) => /^\s+- name: /.test(l) && l.trim().slice("- name: ".length).startsWith(name));
  if (at < 0) return null;
  const r = lines.findIndex((l, i) => i > at && /^\s+run: \|$/.test(l));
  const next = lines.findIndex((l, i) => i > at && /^\s+- (name|uses): /.test(l));
  if (r < 0 || (next >= 0 && r > next)) return null;
  const body = [];
  const ind = lines[r].search(/\S/) + 2;
  for (let i = r + 1; i < lines.length && (lines[i].trim() === "" || lines[i].search(/\S/) >= ind); i++) body.push(lines[i].slice(ind));
  return body.join("\n");
}
const stepNames = [...publish.matchAll(/^\s+- (?:name: (.+)|uses: (\S+))/gm)].map((m) => m[1] ?? m[2]);
const idx = (p) => stepNames.findIndex((n) => n.startsWith(p));
const iCI = idx("require green full CI on master"), iCheckout = idx("actions/checkout"), iBuild = idx("build"), iLogin = idx("log in to GHCR"), iV = idx("version"), iPush = idx("push");
ok(iCI === 0, `the CI check is publish's first step, before the checkout and any build (${stepNames.join(" | ")})`);
ok(iCI < iCheckout && iCheckout < iBuild && iV < iLogin && iLogin < iPush, "then the checkout, the build, the version, the login and the push, in that order");
ok(/- name: require green full CI on master[^\n]*\n\s+if: startsWith\(github\.ref, 'refs\/tags\/v'\)\n/.test(publish), "the CI check runs on every tag publish");
ok(/^      actions: read\b/m.test(publish) && /^      packages: write$/m.test(publish) && !/^      packages: write$/m.test(image), "publish alone writes packages; it reads actions for the CI check");

// 2. the CI check, run against a stub gh answering from a run list through the real jq
const dir = mkdtempSync(join(tmpdir(), "sb-remote-image-guard-"));
try {
  const ci = stepRun(publish, "require green full CI on master");
  ok(!!ci && ci.includes("head_branch == \"master\""), "the CI check reads ci.yml's runs for this exact SHA on master");
  writeFileSync(join(dir, "gh"), `#!/bin/bash
# (a stub: gh api URL --jq FILTER, answered from runs.json, checking the URL names this SHA and ci.yml)
url=""; jq_filter=""
while [ $# -gt 0 ]; do case "$1" in api) shift; url="$1";; --jq) shift; jq_filter="$1";; esac; shift; done
case "$url" in "repos/$GITHUB_REPOSITORY/actions/workflows/ci.yml/runs?head_sha=$GITHUB_SHA&"*) ;; *) echo "unexpected url $url" >&2; exit 9;; esac
jq "$jq_filter" "$RUNS"
`);
  chmodSync(join(dir, "gh"), 0o755);
  const SHA = "a".repeat(40);
  const run = (conclusion, event, head_branch, head_sha = SHA) => ({ conclusion, event, head_branch, head_sha, status: "completed" });
  const ciCases = [
    ["a successful push run on master", [run("success", "push", "master")], true],
    ["a successful dispatch run on master", [run("success", "workflow_dispatch", "master")], true],
    ["a v-tag on a commit whose only green CI was on a side branch (a non-master tag)", [run("success", "push", "remote-docker")], false],
    ["a successful pull_request run reporting master", [run("success", "pull_request", "master")], false],
    ["a failed run on master", [run("failure", "push", "master")], false],
    ["a cancelled run on master", [run("cancelled", "push", "master")], false],
    ["no run at all", [], false],
  ];
  for (const [what, runs, want] of ciCases) {
    writeFileSync(join(dir, "runs.json"), JSON.stringify({ workflow_runs: runs }));
    const r = spawnSync("bash", ["-c", ci], { env: { PATH: `${dir}:${process.env.PATH}`, GITHUB_REPOSITORY: REPO, GITHUB_SHA: SHA, RUNS: join(dir, "runs.json") }, encoding: "utf8" });
    ok((r.status === 0) === want, `${what}: the tag ${want ? "is admitted" : "is refused"} (exit ${r.status}${r.stderr ? ", " + r.stderr.trim().slice(0, 120) : ""}${r.stdout ? ", " + r.stdout.trim().slice(0, 120) : ""})`);
  }

  // 3. the version: a tag publishes only the version it names
  const vs = stepRun(publish, "version");
  ok(!!vs, "publish has the version step");
  writeFileSync(join(dir, "docker"), `#!/bin/bash\necho "sagebrush $IMAGE_VERSION (Python 3.13.14 at /opt/sagebrush/tools/sagebrush/bin/python)"\n`);
  chmodSync(join(dir, "docker"), 0o755);
  for (const [what, ref, image_v, want] of [
    ["a tag naming the image's version", "refs/tags/v0.10.3", "0.10.3", true],
    ["a tag naming another version", "refs/tags/v0.10.4", "0.10.3", false],
    ["a tag that isn't vX.Y.Z of it", "refs/tags/v0.10.3-rc1", "0.10.3", false],
    ["a manual run on master (no tag to match)", "refs/heads/master", "0.10.3", true],
    ["an image whose version is malformed", "refs/heads/master", "0.10", false],
  ]) {
    const out = join(dir, "out");
    writeFileSync(out, "");
    const r = spawnSync("bash", ["-c", vs], { env: { PATH: `${dir}:${process.env.PATH}`, GITHUB_REF: ref, GITHUB_REF_NAME: ref.replace(/^refs\/(tags|heads)\//, ""), GITHUB_OUTPUT: out, IMAGE_VERSION: image_v }, encoding: "utf8" });
    ok((r.status === 0) === want && (!want || readFileSync(out, "utf8") === `version=${image_v}\n`), `${what}: ${want ? "published as " + image_v : "refused"} (exit ${r.status})`);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(failed ? `remote image guard: ${failed} failed, ${passed} passed` : `remote image guard: ${passed} checks pass`);
process.exit(failed ? 1 : 0);
