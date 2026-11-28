// ci: checks.6 order=37
// scripts/wasm-pin-commit.mjs, master's pin commit (design/wasm-artifacts.md section 13), on a scratch repository
// whose origin is a local bare repository: it commits exactly wasm/pins.json for this run's build with this source,
// as a fast-forward of the run's commit; does nothing when the pins already are that; refuses another event, another
// checkout, another run's artifact and pins of this source with other bytes; and pushes nothing when master moved.
//   node scripts/test-wasm-pin-commit.mjs
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pack } from "./wasm-artifact.mjs";
import { pinCommit } from "./wasm-pin-commit.mjs";
import { MODULES, formatPins, loadPinsSource, sha256, sourceOf } from "./wasm-modules.mjs";

let failures = 0;
const ok = (c, what) => (c ? console.log("ok  ", what) : (failures++, console.log("FAIL", what)));
const refused = (fn, pattern, what) => {
  try {
    fn();
    ok(false, `${what} (no error)`);
  } catch (e) {
    ok(pattern.test(e.message), `${what}${pattern.test(e.message) ? "" : `: wrong error: ${e.message}`}`);
  }
};
const dir = mkdtempSync(join(tmpdir(), "wasm-pin-commit-"));
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const gitIn = (cwd) => (...a) => execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: gitEnv }).trim();
try {
  const remote = join(dir, "origin.git"), repo = join(dir, "repo"), other = join(dir, "other");
  execFileSync("git", ["init", "-q", "--bare", "-b", "master", remote]);
  mkdirSync(join(repo, "wasm"), { recursive: true });
  mkdirSync(join(repo, "engine"));
  const git = gitIn(repo);
  git("init", "-q", "-b", "master");
  git("remote", "add", "origin", remote);
  const old = Object.fromEntries(MODULES.map((n) => [n, { sha256: "0".repeat(64), bytes: 1 }]));
  writeFileSync(join(repo, "engine", "lib.rs"), "fn f() {}\n");
  writeFileSync(join(repo, ".gitignore"), "wasm/*.wasm\n");
  writeFileSync(join(repo, "wasm", "pins.json"), formatPins(old, "f".repeat(64)));
  git("add", "-A");
  git("commit", "-qm", "an engine change, its pins pending");
  git("push", "-q", "origin", "HEAD:refs/heads/master");
  const sha = git("rev-parse", "HEAD");
  // this run's build: the modules, packed as the wasm-modules job does
  const mods = Object.fromEntries(MODULES.map((n) => [n, Buffer.from(`\0asm\x01\0\0\0 ${n} build`)]));
  const run = { GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/heads/master", GITHUB_SHA: sha, GITHUB_RUN_ID: "41" };
  const artifact = (env) => {
    const src = mkdtempSync(join(dir, "build-")), out = join(src, "artifact");
    mkdirSync(join(src, "wasm"));
    for (const n of MODULES) writeFileSync(join(src, "wasm", n), mods[n]);
    pack(out, { root: src, env });
    return out;
  };
  const art = artifact(run);
  const source = sourceOf(repo);

  refused(() => pinCommit(art, { root: repo, env: { ...run, GITHUB_EVENT_NAME: "pull_request" } }), /only on a push to master/, "a pull request's run: refused");
  refused(() => pinCommit(art, { root: repo, env: { ...run, GITHUB_REF: "refs/heads/track/math" } }), /only on a push to master/, "a track's push: refused");
  refused(() => pinCommit(art, { root: repo, env: { ...run, GITHUB_SHA: "e".repeat(40) } }), /isn't this run's commit/, "a checkout that isn't the run's commit: refused");
  refused(() => pinCommit(artifact({ ...run, GITHUB_RUN_ID: "40" }), { root: repo, env: run }), /not this run/, "another run's artifact: refused");
  ok(git("rev-parse", "HEAD") === sha && gitIn(remote)("rev-parse", "master") === sha, "...and none of them committed or pushed anything");

  const r = pinCommit(art, { root: repo, env: run });
  const pin = git("rev-parse", "HEAD");
  const want = Object.fromEntries(MODULES.map((n) => [n, { sha256: sha256(mods[n]), bytes: mods[n].length }]));
  ok(r.action === "pinned" && gitIn(remote)("rev-parse", "master") === pin, "pending pins: the pin commit is pushed to master");
  ok(git("rev-parse", "HEAD^") === sha && git("diff", "--name-only", "HEAD^", "HEAD") === "wasm/pins.json", "...a fast-forward of the run's commit, changing exactly wasm/pins.json");
  ok(readFileSync(join(repo, "wasm", "pins.json"), "utf8") === formatPins(want, source) && loadPinsSource(repo) === sourceOf(repo), "...whose pins are this run's build, recording this source (unchanged by the commit)");

  // the pin commit's own run: nothing to do
  const again = pinCommit(artifact({ ...run, GITHUB_SHA: pin }), { root: repo, env: { ...run, GITHUB_SHA: pin } });
  ok(again.action === "current" && git("rev-parse", "HEAD") === pin, "the pin commit's own run: already current, nothing committed");

  // pins that record this source with other bytes: never committed over
  writeFileSync(join(repo, "wasm", "pins.json"), formatPins(old, source));
  git("commit", "-qam", "pins of this source edited by hand");
  git("push", "-q", "origin", "HEAD:refs/heads/master");
  const edited = git("rev-parse", "HEAD");
  refused(() => pinCommit(artifact({ ...run, GITHUB_SHA: edited }), { root: repo, env: { ...run, GITHUB_SHA: edited } }), /records this source with other bytes/, "pins of this source with other bytes: refused, not committed over");
  ok(git("rev-parse", "HEAD") === edited, "...and nothing committed");

  // master moved past the run's commit: the push is refused, and nothing reaches master
  writeFileSync(join(repo, "wasm", "pins.json"), formatPins(old, "f".repeat(64)));
  writeFileSync(join(repo, "engine", "lib.rs"), "fn f() { 2; }\n");
  git("commit", "-qam", "another engine change");
  git("push", "-q", "origin", "HEAD:refs/heads/master");
  const behind = git("rev-parse", "HEAD");
  execFileSync("git", ["clone", "-q", remote, other], { env: gitEnv });
  const g2 = gitIn(other);
  writeFileSync(join(other, "README"), "moved\n");
  g2("add", "-A");
  g2("commit", "-qm", "master moves on");
  g2("push", "-q", "origin", "HEAD:refs/heads/master");
  const moved = g2("rev-parse", "HEAD");
  const m = pinCommit(artifact({ ...run, GITHUB_SHA: behind }), { root: repo, env: { ...run, GITHUB_SHA: behind } });
  ok(m.action === "moved" && gitIn(remote)("rev-parse", "master") === moved, "master moved on: not pushed, master untouched (the newer commit's run pins it)");

  // a push that fails for another reason fails the job
  git("reset", "-q", "--hard", behind);
  git("fetch", "-q", "origin");
  refused(() => pinCommit(artifact({ ...run, GITHUB_SHA: behind }), { root: repo, env: { ...run, GITHUB_SHA: behind }, push: () => { throw Object.assign(new Error("x"), { stderr: "remote: denied by a rule" }); }, git: (a) => (a[0] === "ls-remote" ? `${behind}\trefs/heads/master` : gitIn(repo)(...a)) }), /the push failed: remote: denied by a rule/, "a push refused for another reason (master not moved): the job fails");
  // a change besides wasm/pins.json is never committed
  git("reset", "-q", "--hard", behind);
  writeFileSync(join(repo, "engine", "lib.rs"), "fn f() { 3; }\n");
  refused(() => pinCommit(artifact({ ...run, GITHUB_SHA: behind }), { root: repo, env: { ...run, GITHUB_SHA: behind } }), /uncommitted changes/, "a checkout with another change: refused before writing");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log(failures ? `${failures} failed` : "all passed");
process.exit(failures ? 1 : 0);
