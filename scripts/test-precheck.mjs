// ci: census order=40
// scripts/precheck.mjs runs CI's own commands: each step it marks ci: is a line of a workflow's run: script, verbatim,
// so a gate renamed or dropped in ci.yml fails here instead of passing locally while CI fails.  And
// scripts/engine-cache.mjs keys a build by its whole source (engine/, the build scripts, committed or not, and
// $RUSTFLAGS), fetches the pins only for their own source, builds once and copies from the cache after.
//   node scripts/test-precheck.mjs
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STEPS, workflowLines } from "./precheck.mjs";
import { SOURCE_PATHS, check, ensure, isPinnedSource, sourceKey } from "./engine-cache.mjs";
import { MODULES } from "./wasm-modules.mjs";

let failures = 0;
const ok = (c, what) => (c ? console.log("ok  ", what) : (failures++, console.log("FAIL", what)));

// every ci: step is a whole line of some workflow (its run: script's lines, trimmed)
const lines = workflowLines();
for (const s of STEPS.filter((s) => s.ci)) ok(lines.has(s.run), `a workflow runs precheck's "${s.name}": ${s.run}`);
ok(STEPS.filter((s) => s.ci).length >= 20, "precheck runs at least 20 of CI's commands");
ok(new Set(STEPS.map((s) => s.name)).size === STEPS.length, "precheck's step names are distinct");

// what scripts/build-engine.mjs reads besides engine/ (the test's own list: SOURCE_PATHS must cover it)
const BUILD_SCRIPTS = ["scripts/build-engine.mjs", "scripts/build-nd.mjs", "scripts/build-raster.mjs", "scripts/build-mp.mjs", "scripts/install-engine-wasm.mjs"];

// the engine key and the dispatch: a scratch repository with the source paths, a stub fetch and a stub build
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
  for (const p of BUILD_SCRIPTS) writeFileSync(join(repo, p), "// build\n");
  writeFileSync(join(repo, "wasm", "pins.json"), "{}\n");
  writeFileSync(join(repo, "README"), "a\n");
  git("add", "-A");
  git("commit", "-qm", "pins with their source");
  git("branch", "base");
  const cache = join(repo, ".cache");
  const E = { SAGEBRUSH_PINS_REF: "base", SAGEBRUSH_ENGINE_CACHE: cache, PATH: process.env.PATH };
  const F = { ...E, RUSTFLAGS: "-Cdebuginfo=2" };
  const pinned = (env = E) => isPinnedSource(repo, env);
  const calls = { fetch: 0, build: 0 };
  const stubs = {
    log: () => {},
    fetch: () => calls.fetch++,
    // (a build writes the four modules, its bytes naming the build)
    build: () => {
      calls.build++;
      for (const name of MODULES) writeFileSync(join(repo, "wasm", name), `${name} build ${calls.build}\n`);
    },
  };

  const k0 = sourceKey(repo, E);
  ok(!k0.dirty && pinned(), "a tree whose engine is the pins' commit's is the pinned source");
  writeFileSync(join(repo, "README"), "b\n");
  git("commit", "-qam", "not the engine");
  ok(sourceKey(repo, E).key === k0.key && pinned(), "a change outside the engine's source keeps its key and its pins");
  ok(sourceKey(repo, F).key !== k0.key, "RUSTFLAGS is part of the key");
  ok(!pinned(F), "with RUSTFLAGS set the source is never the pins' (CI builds them without)");

  // dispatch: pinned -> fetch; RUSTFLAGS -> build once, then the cache
  ok(ensure({ root: repo, env: E, ...stubs }) === "pinned" && calls.fetch === 1 && calls.build === 0, "no flags, the pins' source: the pinned modules are fetched, nothing is built");
  ok(ensure({ root: repo, env: F, ...stubs }) === "built" && calls.fetch === 1 && calls.build === 1, "non-default RUSTFLAGS: built, not fetched");
  const c1 = check({ root: repo, env: F });
  ok(c1.ok && c1.mode === "local", "after the build, --check finds wasm/ is this tree's engine (local)");
  for (const name of MODULES) writeFileSync(join(repo, "wasm", name), "something else\n");
  ok(!check({ root: repo, env: F }).ok, "a module replaced after the build fails --check");
  ok(ensure({ root: repo, env: F, ...stubs }) === "cached" && calls.build === 1, "the same source again: copied from the cache, not rebuilt");
  ok(check({ root: repo, env: F }).ok, "the cache's copy passes --check");
  ok(readFileSync(join(repo, "wasm", MODULES[0]), "utf8") === `${MODULES[0]} build 1\n`, "the cache's copy is the build's bytes");
  writeFileSync(join(cache, sourceKey(repo, F).key, MODULES[1]), "tampered\n");
  ok(ensure({ root: repo, env: F, ...stubs }) === "built" && calls.build === 2, "a cache entry whose bytes don't match its manifest is rebuilt, never installed");
  ok(check({ root: repo, env: F }).ok, "after the rebuild, wasm/ is this tree's engine");
  ok(MODULES.every((name) => readFileSync(join(repo, "wasm", name), "utf8") === `${name} build 2\n`), "the rebuild's bytes are installed, not the corrupt entry's");
  ok(ensure({ root: repo, env: F, ...stubs }) === "cached" && calls.build === 2 && check({ root: repo, env: F }).ok, "the repaired entry is reused");

  // the source: engine edits, committed or not
  writeFileSync(join(repo, "engine", "web", "src", "lib.rs"), "pub fn f() { g() }\n");
  const k1 = sourceKey(repo, E);
  ok(k1.dirty && k1.key !== k0.key && !pinned(), "an uncommitted engine edit (a mutant) is its own key, never the pins'");
  ok(!check({ root: repo, env: F }).ok, "an engine edit after the build fails --check (wasm/ is stale)");
  writeFileSync(join(repo, "engine", "web", "src", "new.rs"), "pub fn g() {}\n");
  const k2 = sourceKey(repo, E);
  ok(k2.dirty && k2.key !== k1.key, "an untracked engine file is part of the key");
  git("add", "-A");
  git("commit", "-qm", "engine moves");
  const k3 = sourceKey(repo, E);
  ok(!k3.dirty && k3.key !== k0.key && !pinned(), "a committed engine change leaves the pins' source (a track's engine)");

  // every build script is part of the key: each edited alone, on the same tree, committed
  for (const p of BUILD_SCRIPTS) {
    const before = sourceKey(repo, E).key;
    writeFileSync(join(repo, p), `// build, ${p} changed\n`);
    const dirtyKey = sourceKey(repo, E).key;
    git("commit", "-qam", `${p} changes`);
    ok(dirtyKey !== before && sourceKey(repo, E).key !== before, `${p} is part of the key (uncommitted and committed)`);
  }
  ok(["engine", ...BUILD_SCRIPTS].every((p) => SOURCE_PATHS.includes(p)), "the source paths name engine/ and every build script");

  git("checkout", "-q", "-b", "side", "base");
  writeFileSync(join(repo, "wasm", "pins.json"), '{"other": 1}\n');
  git("commit", "-qam", "a branch moves the pins");
  ok(!pinned(), "a branch whose pins differ from its base's is not the pinned source");
} finally {
  rmSync(repo, { recursive: true, force: true });
}

if (failures) {
  console.log(`${failures} failed`);
  process.exit(1);
}
