#!/usr/bin/env node
// Master's pin commit (design/wasm-artifacts.md section 13): after a push to master whose pins are pending (they
// record another source than this commit's), CI's wasm-pins job commits wasm/pins.json for this run's build, so that
// master's pins are again its own source's build.  A pull request never carries a pin.
//
//   node scripts/wasm-pin-commit.mjs <artifact dir>
//
// Checks, in order, each a refusal naming what failed:
//   - this is a push to master (GITHUB_EVENT_NAME push, GITHUB_REF refs/heads/master), and the checkout is that commit;
//   - the artifact is this run's (wasm-artifact.mjs's readArtifact: this run id and commit, five modules matching it);
//   - the pins don't already record this source with this build (then there is nothing to commit);
//   - the pins don't record this source with other bytes (the build isn't reproducible: a person must look);
//   - the commit changes exactly wasm/pins.json, and its parent is this run's commit.
// Then it pushes the commit as a fast-forward of master, never forced: when master has moved past this run's commit,
// the push is refused and nothing is committed, and the newer commit's own run pins its source.
// wasm-publish published these modules first (the job needs it), so the pin never names unpublished bytes.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readArtifact } from "./wasm-artifact.mjs";
import { MODULES, ROOT, formatPins, loadPins, loadPinsSource, pinsPath, sourceOf } from "./wasm-modules.mjs";

const realGit = (root) => (args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

// Returns { action: "pinned" | "current" | "moved", lines }; throws on any refusal.  (`git`: the runner, a test's
// stand-in; `push`: how the fast-forward is pushed)
export function pinCommit(dir, { root = ROOT, env = process.env, git = realGit(root), push = () => git(["push", "origin", "HEAD:refs/heads/master"]) } = {}) {
  if (env.GITHUB_EVENT_NAME !== "push" || env.GITHUB_REF !== "refs/heads/master") throw new Error(`wasm-pin-commit: only on a push to master (this run: ${env.GITHUB_EVENT_NAME ?? "?"} ${env.GITHUB_REF ?? "?"})`);
  const sha = env.GITHUB_SHA ?? "";
  if (!/^[0-9a-f]{40}$/.test(sha) || git(["rev-parse", "HEAD"]) !== sha) throw new Error(`wasm-pin-commit: the checkout isn't this run's commit ${sha}`);
  if (git(["status", "--porcelain", "--untracked-files=no"])) throw new Error("wasm-pin-commit: the checkout has uncommitted changes");
  const { manifest } = readArtifact(dir, { env });
  const source = sourceOf(root);
  if (!source) throw new Error("wasm-pin-commit: this commit's source can't be read");
  const pins = loadPins(root), recorded = loadPinsSource(root);
  const same = MODULES.every((n) => pins[n].sha256 === manifest.modules[n].sha256 && pins[n].bytes === manifest.modules[n].bytes);
  if (recorded === source && same) return { action: "current", lines: ["wasm/pins.json already records this source's build: nothing to commit"] };
  if (recorded === source) throw new Error("wasm-pin-commit: wasm/pins.json records this source with other bytes than this run's build: the build isn't reproducible, or the pins were edited by hand (not committed over; look)");
  writeFileSync(pinsPath(root), formatPins(manifest.modules, source));
  const changed = git(["diff", "--name-only"]);
  if (changed !== "wasm/pins.json") throw new Error(`wasm-pin-commit: the change isn't exactly wasm/pins.json: ${changed.split("\n").join(", ")}`);
  git(["commit", "-q", "-m", `wasm/pins.json: the build of ${sha.slice(0, 12)} (CI run ${env.GITHUB_RUN_ID ?? "?"})`, "--", "wasm/pins.json"]);
  if (git(["rev-parse", "HEAD^"]) !== sha) throw new Error("wasm-pin-commit: the pin commit's parent isn't this run's commit");
  const files = git(["diff", "--name-only", "HEAD^", "HEAD"]);
  if (files !== "wasm/pins.json") throw new Error(`wasm-pin-commit: the pin commit changes ${files.split("\n").join(", ")}, not only wasm/pins.json`);
  const lines = [`pin commit ${git(["rev-parse", "HEAD"])} on ${sha}:`, readFileSync(pinsPath(root), "utf8").trimEnd()];
  try {
    push();
  } catch (e) {
    // (refused because master moved on: a fast-forward of this run's commit no longer applies.  Anything else fails.)
    const remote = git(["ls-remote", "origin", "refs/heads/master"]).split(/\s/)[0];
    if (remote && remote !== sha) return { action: "moved", lines: [`master moved past ${sha.slice(0, 12)} (now ${remote.slice(0, 12)}): not pushed; that commit's own run pins its source`] };
    throw new Error(`wasm-pin-commit: the push failed: ${String(e.stderr ?? e.message).trim().slice(0, 500)}`);
  }
  return { action: "pinned", lines };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2];
  if (!dir) {
    console.error("usage: node scripts/wasm-pin-commit.mjs <artifact dir>");
    process.exit(2);
  }
  try {
    const r = pinCommit(dir);
    for (const l of r.lines) console.log(l);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
