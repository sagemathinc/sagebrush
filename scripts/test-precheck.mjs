// ci: census order=40
// scripts/precheck.mjs runs CI's own commands: each step it marks ci: is a line of a workflow's run: script, verbatim,
// so a gate renamed or dropped in ci.yml fails here instead of passing locally while CI fails.  And
// scripts/engine-cache.mjs keys a build by its whole source: engine/ and the build scripts, committed or not.
//   node scripts/test-precheck.mjs
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STEPS, workflowLines } from "./precheck.mjs";
import { SOURCE_PATHS, sourceKey, isPinnedSource } from "./engine-cache.mjs";

let failures = 0;
const ok = (c, what) => (c ? console.log("ok  ", what) : (failures++, console.log("FAIL", what)));

// every ci: step is a whole line of some workflow (its run: script's lines, trimmed)
const lines = workflowLines();
for (const s of STEPS.filter((s) => s.ci)) ok(lines.has(s.run), `a workflow runs precheck's "${s.name}": ${s.run}`);
ok(STEPS.filter((s) => s.ci).length >= 20, "precheck runs at least 20 of CI's commands");
ok(new Set(STEPS.map((s) => s.name)).size === STEPS.length, "precheck's step names are distinct");

// the engine key: a scratch repository with the source paths
const repo = mkdtempSync(join(tmpdir(), "engine-cache-test-"));
try {
  const git = (...a) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  mkdirSync(join(repo, "engine", "web", "src"), { recursive: true });
  mkdirSync(join(repo, "scripts"));
  mkdirSync(join(repo, "wasm"));
  writeFileSync(join(repo, "engine", "web", "src", "lib.rs"), "pub fn f() {}\n");
  for (const p of SOURCE_PATHS.filter((p) => p.startsWith("scripts/"))) writeFileSync(join(repo, p), "// build\n");
  writeFileSync(join(repo, "wasm", "pins.json"), "{}\n");
  writeFileSync(join(repo, "README"), "a\n");
  git("add", "-A");
  git("commit", "-qm", "pins with their source");
  git("branch", "base");
  const pinned = () => isPinnedSource(repo, sourceKey(repo, {}).dirty, "base");
  const k0 = sourceKey(repo, {});
  ok(!k0.dirty && pinned(), "a tree whose engine is the pins' commit's is the pinned source");
  writeFileSync(join(repo, "README"), "b\n");
  git("commit", "-qam", "not the engine");
  ok(sourceKey(repo, {}).key === k0.key && pinned(), "a change outside the engine's source keeps its key and its pins");
  ok(sourceKey(repo, { RUSTFLAGS: "-Cdebuginfo=2" }).key !== k0.key, "RUSTFLAGS is part of the key");
  writeFileSync(join(repo, "engine", "web", "src", "lib.rs"), "pub fn f() { g() }\n");
  const k1 = sourceKey(repo, {});
  ok(k1.dirty && k1.key !== k0.key && !pinned(), "an uncommitted engine edit (a mutant) is its own key, never the pins'");
  writeFileSync(join(repo, "engine", "web", "src", "new.rs"), "pub fn g() {}\n");
  const k2 = sourceKey(repo, {});
  ok(k2.dirty && k2.key !== k1.key, "an untracked engine file is part of the key");
  git("add", "-A");
  git("commit", "-qm", "engine moves");
  const k3 = sourceKey(repo, {});
  ok(!k3.dirty && k3.key !== k0.key && !pinned(), "a committed engine change leaves the pins' source (a track's engine)");
  git("checkout", "-q", "-b", "side", "base");
  writeFileSync(join(repo, "wasm", "pins.json"), '{"other": 1}\n');
  git("commit", "-qam", "a branch moves the pins");
  ok(!pinned(), "a branch whose pins differ from its base's is not the pinned source");
  writeFileSync(join(repo, "scripts", "build-mp.mjs"), "// build, changed\n");
  ok(sourceKey(repo, {}).key !== k3.key, "a build script is part of the key");
} finally {
  rmSync(repo, { recursive: true, force: true });
}

if (failures) {
  console.log(`${failures} failed`);
  process.exit(1);
}
