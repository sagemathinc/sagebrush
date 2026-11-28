// ci: checks.6 order=30
// scripts/check-fresh-wasm.mjs: a fresh build that differs from pins recording this tree's own source is an error on
// every event; one that differs from pending pins (they record another source, or none) is only reported, on every
// event; a pin that equals the fresh build passes everywhere.  And scripts/pin-policy.mjs's track rules.
//   node scripts/test-check-fresh-wasm.mjs
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkFreshWasm } from "./check-fresh-wasm.mjs";
import { onTrack, runRefs } from "./pin-policy.mjs";
import { installWasm } from "./install-engine-wasm.mjs";
import { MODULES, formatPins, pinsState, sha256, sourceOf } from "./wasm-modules.mjs";

let failures = 0;
const ok = (c, what) => (c ? console.log("ok  ", what) : (failures++, console.log("FAIL", what)));
const dir = mkdtempSync(join(tmpdir(), "check-fresh-wasm-"));
const pinned = Object.fromEntries(MODULES.map((n) => [n, Buffer.from(`\0asm\x01\0\0\0${n}`)]));
const pinsOf = (mods) => Object.fromEntries(MODULES.map((n) => [n, { sha256: sha256(mods[n]), bytes: mods[n].length }]));
const src = join(dir, "fresh.wasm"), path = (n) => join(dir, "wasm", n);
// a fresh build of `name` with these bytes, installed as build-engine.mjs does (it builds with mode 0755)
const build = (name, bytes) => {
  writeFileSync(src, bytes);
  chmodSync(src, 0o755);
  installWasm(src, path(name));
};
const git = (...a) => execFileSync("git", ["-C", dir, ...a], { stdio: "ignore", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
const pinsPath = join(dir, "wasm", "pins.json");
try {
  // a repository with an engine source; the modules aren't committed (wasm/*.wasm)
  mkdirSync(join(dir, "wasm"));
  mkdirSync(join(dir, "engine"));
  writeFileSync(join(dir, "engine", "lib.rs"), "fn main() {}\n");
  writeFileSync(join(dir, ".gitignore"), "wasm/*.wasm\nfresh.wasm\n");
  git("init", "-q");
  git("add", "-A");
  git("commit", "-qm", "engine");
  const source = sourceOf(dir);
  const current = () => writeFileSync(pinsPath, formatPins(pinsOf(pinned), source));
  const pending = (other = null) => writeFileSync(pinsPath, formatPins(pinsOf(pinned), other));
  current();
  ok(pinsState(dir) === "current", "pins recording this tree's committed source are current");
  pending("f".repeat(64));
  ok(pinsState(dir) === "pending", "pins recording another source are pending");
  pending();
  ok(pinsState(dir) === "pending", "pins recording no source are pending");
  for (const n of MODULES) build(n, pinned[n]);
  for (const state of ["current", "pending"]) {
    const r = checkFreshWasm({ cwd: dir, state });
    ok(r.status === 0 && !/::(error|warning|notice)::/.test(r.message), `the pinned bytes: pass, silently, with ${state} pins`);
  }
  // the control: the fresh build differs from the pins
  build(MODULES[0], Buffer.from("\0asm\x01\0\0\0FRESH-BUILD"));
  const cur = checkFreshWasm({ cwd: dir, state: "current" });
  ok(cur.status === 1 && cur.message.startsWith("::error::") && cur.message.includes(MODULES[0]) && /isn't reproducible/.test(cur.message), "a mismatch with pins of this very source: an ERROR, naming the module");
  const pen = checkFreshWasm({ cwd: dir, state: "pending" });
  ok(pen.status === 0 && pen.message.startsWith("::notice::") && /pending/.test(pen.message) && pen.message.includes(MODULES[0]), "a mismatch with pending pins: reported, not an error");
  // a mode-only difference counts too
  build(MODULES[0], pinned[MODULES[0]]);
  chmodSync(path(MODULES[0]), 0o755);
  if (process.platform !== "win32") ok(checkFreshWasm({ cwd: dir, state: "current" }).status === 1, "a mode-only difference (0755): an ERROR with current pins");
  chmodSync(path(MODULES[0]), 0o644);
  // every module is held to its pin: a stale PNG module is an ERROR, named
  build("sagebrush-raster.wasm", Buffer.from("\0asm\x01\0\0\0RASTER-FRESH"));
  const r = checkFreshWasm({ cwd: dir, state: "current" });
  ok(r.status === 1 && r.message.includes("sagebrush-raster.wasm") && !r.message.includes(`${MODULES[0]}:`), "a stale PNG module (sagebrush-raster.wasm): an ERROR, naming only it");
  build("sagebrush-raster.wasm", pinned["sagebrush-raster.wasm"]);
  // a missing module (nothing built) is an error either way, never a pass
  rmSync(path("sagebrush-nd.wasm"));
  ok(checkFreshWasm({ cwd: dir, state: "pending" }).status === 2, "a module that wasn't built: an error, even with pending pins");
  build("sagebrush-nd.wasm", pinned["sagebrush-nd.wasm"]);
  // pins it can't read are an error either way, never a pass: wasm/pins.json invalid, then missing
  writeFileSync(pinsPath, "{ not json");
  const bad = checkFreshWasm({ cwd: dir, state: "pending" });
  ok(bad.status === 2 && bad.message.startsWith("::error::wasm/pins.json"), "an invalid wasm/pins.json: an error");
  rmSync(pinsPath);
  ok(checkFreshWasm({ cwd: dir, state: "pending" }).status === 2, "a missing wasm/pins.json: an error");
  // the script as CI runs it, on this repository: the exit status follows the pins' source, never the event
  const cli = (event, refs = {}) => {
    try {
      execFileSync(process.execPath, [join(import.meta.dirname, "check-fresh-wasm.mjs")], { cwd: dir, env: { ...process.env, GITHUB_EVENT_NAME: event, ...refs }, stdio: "pipe" });
      return 0;
    } catch (e) {
      return e.status;
    }
  };
  build(MODULES[0], Buffer.from("\0asm\x01\0\0\0FRESH-BUILD"));
  const runs = [["push", { GITHUB_REF_NAME: "master" }], ["pull_request", { GITHUB_BASE_REF: "master", GITHUB_HEAD_REF: "x" }], ["merge_group", { GITHUB_REF_NAME: "gh-readonly-queue/master/pr-7-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }], ["push", { GITHUB_REF_NAME: "track/math" }], ["schedule", {}]];
  current();
  ok(runs.every(([e, refs]) => cli(e, refs) === 1), "the script: exit 1 on every event when the pins record this source");
  pending("f".repeat(64));
  ok(runs.every(([e, refs]) => cli(e, refs) === 0), "the script: exit 0 on every event when the pins are pending");
  // a change to the source makes its pins pending
  current();
  writeFileSync(join(dir, "engine", "lib.rs"), "fn main() { let _ = 1; }\n");
  git("commit", "-qam", "an engine change");
  ok(pinsState(dir) === "pending" && cli("push", { GITHUB_REF_NAME: "master" }) === 0, "an engine commit after the pin: pending, reported");
  // the track rules that remain (ci-paths.mjs and wasm-fetch-or-build.mjs build a track's engine)
  ok(onTrack({ event: "pull_request_target", baseRef: "track/math" }) && onTrack({ event: "push", ref: "refs/heads/track/math" }) && !onTrack({ event: "schedule", ref: "track/math" }) && !onTrack({ event: "pull_request", baseRef: "master", headRef: "track/math" }), "onTrack: a track's pushes and pull requests into it, never the pull into master or the schedule");
  ok(onTrack({ event: "merge_group", ref: "refs/heads/gh-readonly-queue/track/math/pr-7-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }) && !onTrack({ event: "merge_group", ref: "refs/heads/gh-readonly-queue/master/pr-7-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }), "onTrack: a queue group into a track, not one into master");
  ok(!onTrack({ event: "push", ref: "trackx" }), "onTrack: only the track/ prefix");
  ok(runRefs({ GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/heads/track/math" }).ref === "track/math", "runRefs: the branch from GITHUB_REF when GITHUB_REF_NAME is absent");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log(failures ? `${failures} failed` : "all passed");
process.exit(failures ? 1 : 0);
