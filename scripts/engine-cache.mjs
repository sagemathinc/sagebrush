#!/usr/bin/env node
// This tree's four WebAssembly modules in wasm/, built at most once per engine source and shared between checkouts.
//
// The source of the modules is everything scripts/build-engine.mjs reads: engine/ (its toolchain file too) and the
// build scripts (SOURCE_PATHS).  Its key is the sha256 of their git object ids at HEAD, plus the bytes of any uncommitted
// change to them (a mutant under review is a source too) and $RUSTFLAGS.  Then:
//   - the source and the pins are those of the merge base with master (whose pins are always its own source's build,
//     check-fresh-wasm.mjs), and $RUSTFLAGS is unset: the pinned modules are fetched (wasm-fetch.mjs);
//   - otherwise, a cache entry for the key is copied in, after its bytes are checked against the entry's manifest;
//   - otherwise, the engine is built (build-engine.mjs, into one shared cargo target) and stored under the key.
// The modules a build or the cache put in wasm/ get their sidecars (wasm-modules.mjs) and wasm/engine-source.local.json,
// which names the key: --check fails when wasm/ isn't this tree's engine, so a test never runs a stale or borrowed one.
//
//   node scripts/engine-cache.mjs            make wasm/ this tree's engine (fetch, copy or build)
//   node scripts/engine-cache.mjs --check    exit 1 unless wasm/ is this tree's engine; prints the run mode
//   node scripts/engine-cache.mjs --key      print the key and whether it is the pinned source
// The cache is $SAGEBRUSH_ENGINE_CACHE (default ~/.cache/sagebrush/engine); the newest KEEP entries are kept.
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkModules, MODULES, ROOT, modulePath, sha256, writeJsonAtomic, writeSidecar } from "./wasm-modules.mjs";

export const SOURCE_PATHS = [
  "engine", // (with its rust-toolchain.toml)
  "scripts/build-engine.mjs",
  "scripts/build-nd.mjs",
  "scripts/build-raster.mjs",
  "scripts/build-mp.mjs",
  "scripts/install-engine-wasm.mjs",
];
const KEEP = 20;
export const cacheDir = (env = process.env) => env.SAGEBRUSH_ENGINE_CACHE || join(homedir(), ".cache", "sagebrush", "engine");
const markerPath = (root) => join(root, "wasm", "engine-source.local.json");

const gitIn = (root) => (args, opts = {}) =>
  execFileSync("git", ["-C", root, ...args], { encoding: opts.encoding ?? "utf8", maxBuffer: 1 << 30, stdio: ["ignore", "pipe", "pipe"] });

// The object id of each source path at `rev` ("-" when absent), in SOURCE_PATHS order.
export function sourceIds(root, rev) {
  const git = gitIn(root);
  return SOURCE_PATHS.map((p) => {
    try {
      return git(["rev-parse", "--verify", "--quiet", `${rev}:${p}`]).trim();
    } catch {
      return "-";
    }
  });
}

// The key of the working tree's source, and whether it has uncommitted changes.
export function sourceKey(root = ROOT, env = process.env) {
  const git = gitIn(root);
  const h = createHash("sha256");
  h.update("engine-source v1\n");
  h.update(`RUSTFLAGS ${env.RUSTFLAGS ?? ""}\n`); // (the builds pass it to rustc)
  sourceIds(root, "HEAD").forEach((id, i) => h.update(`${SOURCE_PATHS[i]} ${id}\n`));
  const diff = git(["diff", "HEAD", "--binary", "--", ...SOURCE_PATHS], { encoding: "buffer" });
  const untracked = git(["ls-files", "-z", "--others", "--exclude-standard", "--", ...SOURCE_PATHS]).split("\0").filter(Boolean).sort();
  h.update(diff);
  for (const f of untracked) h.update(`\0untracked ${f}\0`).update(readFileSync(join(root, f)));
  return { key: h.digest("hex"), dirty: diff.length > 0 || untracked.length > 0 };
}

// Is the working tree's source the one its committed pins were built from?  Master's pins are always its own source's
// build (check-fresh-wasm.mjs is strict there), so they are when the source and the pins are those of the branch's
// merge base with master, and $RUSTFLAGS is unset as when CI builds them.  (A track's engine moves ahead of its pins:
// it is built.)
export function isPinnedSource(root = ROOT, env = process.env, dirty = sourceKey(root, env).dirty) {
  if (dirty || env.RUSTFLAGS) return false;
  const master = env.SAGEBRUSH_PINS_REF || "origin/master";
  const git = gitIn(root);
  let base;
  try {
    base = git(["merge-base", master, "HEAD"]).trim();
  } catch {
    return false;
  }
  const ids = (rev) => [...sourceIds(root, rev), git(["rev-parse", `${rev}:wasm/pins.json`]).trim()].join(" ");
  return ids(base) === ids("HEAD");
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

// The entry's modules, each checked against its manifest; null when absent or not intact.
function entryModules(dir) {
  const manifest = readJson(join(dir, "manifest.json"));
  if (!manifest?.modules) return null;
  for (const name of MODULES) {
    const want = manifest.modules[name];
    const path = join(dir, name);
    if (!want || !existsSync(path)) return null;
    const bytes = readFileSync(path);
    if (bytes.length !== want.bytes || sha256(bytes) !== want.sha256) return null;
  }
  return manifest;
}

function installFrom(dir, manifest, root, key) {
  for (const name of MODULES) {
    const tmp = `${modulePath(name, root)}.${process.pid}.tmp`;
    copyFileSync(join(dir, name), tmp);
    renameSync(tmp, modulePath(name, root));
    writeSidecar(name, root);
  }
  writeJsonAtomic(markerPath(root), { key, modules: manifest.modules, builtAt: manifest.commit });
}

function store(root, key, cache) {
  mkdirSync(cache, { recursive: true });
  const tmp = join(cache, `.${key}.${process.pid}.tmp`);
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp);
  const modules = {};
  for (const name of MODULES) {
    const bytes = readFileSync(modulePath(name, root));
    copyFileSync(modulePath(name, root), join(tmp, name));
    modules[name] = { sha256: sha256(bytes), bytes: bytes.length };
  }
  const commit = gitIn(root)(["rev-parse", "HEAD"]).trim();
  writeJsonAtomic(join(tmp, "manifest.json"), { key, commit, modules });
  const dest = join(cache, key);
  // (an entry that isn't intact is replaced; an intact one another checkout stored first is kept, and installed)
  if (existsSync(dest) && !entryModules(dest)) rmSync(dest, { recursive: true, force: true });
  try {
    renameSync(tmp, dest);
  } catch {
    rmSync(tmp, { recursive: true, force: true });
  }
  const stored = entryModules(dest);
  if (!stored) throw new Error(`engine-cache: the cache entry ${dest} isn't intact after storing it`);
  const entries = readdirSync(cache)
    .filter((n) => /^[0-9a-f]{64}$/.test(n))
    .map((n) => ({ n, t: statSync(join(cache, n)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  for (const { n } of entries.slice(KEEP)) if (n !== key) rmSync(join(cache, n), { recursive: true, force: true });
  return stored;
}

const fetchPinned = (root, env) =>
  execFileSync(process.execPath, [join(root, "scripts", "wasm-fetch.mjs"), "--force"], { cwd: root, stdio: "inherit", env });
const buildEngine = (root, env) =>
  execFileSync(process.execPath, [join(root, "scripts", "build-engine.mjs")], { cwd: root, stdio: "inherit", env });

// Make wasm/ this tree's engine.  Returns how: "pinned", "cached" or "built".
export function ensure({ root = ROOT, env = process.env, log = console.log, fetch = fetchPinned, build = buildEngine } = {}) {
  const { key, dirty } = sourceKey(root, env);
  if (isPinnedSource(root, env, dirty)) {
    fetch(root, env);
    rmSync(markerPath(root), { force: true });
    log(`engine: the pinned modules (this tree's engine source is the pins' own)`);
    return "pinned";
  }
  const cache = cacheDir(env);
  const dir = join(cache, key);
  const manifest = entryModules(dir);
  if (manifest) {
    installFrom(dir, manifest, root, key);
    const now = new Date();
    utimesSync(dir, now, now);
    log(`engine: from the cache (${key.slice(0, 12)}, built at ${manifest.commit.slice(0, 12)})`);
    return "cached";
  }
  log(`engine: building this tree's engine (${key.slice(0, 12)}${dirty ? ", with uncommitted changes" : ""})`);
  const target = env.CARGO_TARGET_DIR || join(cache, "target");
  build(root, { ...env, CARGO_TARGET_DIR: target });
  // (the key again: a source edited during the build must not be stored under the old one)
  if (sourceKey(root, env).key !== key) throw new Error("engine-cache: the engine source changed during the build; run it again");
  const stored = store(root, key, cache);
  installFrom(join(cache, key), stored, root, key);
  return "built";
}

// Whether wasm/ is this tree's engine: { ok, mode } (the run mode its tests need), or { ok: false, why }.
export function check({ root = ROOT, env = process.env } = {}) {
  const { key, dirty } = sourceKey(root, env);
  if (isPinnedSource(root, env, dirty)) {
    try {
      checkModules({ root, mode: "pinned" });
      return { ok: true, mode: "pinned" };
    } catch (e) {
      return { ok: false, why: `${e.message}\n(this tree's engine is the pinned one: node scripts/engine-cache.mjs fetches it)` };
    }
  }
  const marker = readJson(markerPath(root));
  if (!marker || marker.key !== key)
    return {
      ok: false,
      why: `wasm/ is not this tree's engine: its source (${key.slice(0, 12)}${dirty ? ", uncommitted changes" : ""}) differs from the pinned one${marker ? ` and from the build in wasm/ (${marker.key.slice(0, 12)})` : ""}.\nRun node scripts/engine-cache.mjs (copies it from the cache, or builds it once).`,
    };
  for (const name of MODULES) {
    const want = marker.modules?.[name];
    const bytes = existsSync(modulePath(name, root)) ? readFileSync(modulePath(name, root)) : null;
    if (!want || !bytes || bytes.length !== want.bytes || sha256(bytes) !== want.sha256)
      return { ok: false, why: `wasm/${name} isn't the module engine-source.local.json names: run node scripts/engine-cache.mjs` };
  }
  return { ok: true, mode: "local" };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const arg = process.argv[2];
  if (arg === "--check") {
    const r = check();
    if (!r.ok) {
      console.error(r.why);
      process.exit(1);
    }
    console.log(`engine: wasm/ is this tree's engine (${r.mode}${r.mode === "local" ? ": run tests with SAGEBRUSH_WASM_LOCAL=1" : ""})`);
  } else if (arg === "--key") {
    const { key, dirty } = sourceKey();
    console.log(JSON.stringify({ key, dirty, pinned: isPinnedSource(ROOT, process.env, dirty) }));
  } else if (arg === undefined) {
    ensure();
  } else {
    console.error("usage: node scripts/engine-cache.mjs [--check | --key]");
    process.exit(2);
  }
}
