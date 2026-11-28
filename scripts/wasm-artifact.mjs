#!/usr/bin/env node
// The five WebAssembly modules as one CI artifact (design/wasm-artifacts.md section 4).
//
//   node scripts/wasm-artifact.mjs pack <dir>     after a build: the five modules from wasm/ plus wasm-manifest.json
//                                                 (their sha256 and length, this run's id and head commit) into <dir>;
//                                                 prints the pins.json lines for this build
//   node scripts/wasm-artifact.mjs install <dir>  in a job that reads wasm/: checks the artifact (exactly those five
//                                                 files, this run's manifest, every module matching it), installs all
//                                                 five, and applies the pin policy (below)
//   node scripts/wasm-artifact.mjs policy         the pin policy on wasm/ as it is (the producer, after its build)
//
// The pin policy (design/wasm-artifacts.md section 13): a build that matches wasm/pins.json is pinned.  One that
// doesn't is labelled "fresh" and never recorded as pinned (only master's push publishes it, for its pin commit) when
// the pins are pending: they record another source than this tree's (wasm-modules.mjs's pinsState), which is every
// pull request and merge queue group that changes the engine, and master until its pin commit
// (scripts/wasm-pin-commit.mjs).  A pull request never carries a pin.  A mismatch fails when the pins record this very
// source (the build isn't reproducible, or the pins were edited by hand), and on a tag (a release builds only from a
// commit whose pins are its own build).
import { readdirSync, readFileSync, renameSync, rmSync, writeFileSync, mkdirSync, lstatSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { MODULES, ROOT, formatPins, loadPins, matches, modulePath, pinsState, recordInstalled, sha256, sourceOf } from "./wasm-modules.mjs";

export const MANIFEST = "wasm-manifest.json";
const MAX_BYTES = 64 * 1024 * 1024;

const runOf = (env) => ({ run_id: String(env.GITHUB_RUN_ID ?? "local"), sha: String(env.GITHUB_SHA ?? "local") });

function writeAtomic(path, bytes) {
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomBytes(4).toString("hex")}.part`);
  try {
    writeFileSync(tmp, bytes, { flag: "wx", mode: 0o644 });
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

const pinsLines = (modules, source = null) => formatPins(modules, source).trimEnd();

// The five modules of wasm/ into `dir`, with their manifest.  Returns the manifest.
export function pack(dir, { root = ROOT, env = process.env } = {}) {
  mkdirSync(dir, { recursive: true });
  const modules = {};
  for (const name of MODULES) {
    const bytes = readFileSync(modulePath(name, root));
    modules[name] = { sha256: sha256(bytes), bytes: bytes.length };
    writeAtomic(join(dir, name), bytes);
  }
  const manifest = { v: 1, ...runOf(env), modules };
  writeFileSync(join(dir, MANIFEST), JSON.stringify(manifest, null, 2) + "\n");
  return manifest;
}

// Check an artifact directory: exactly the five modules and the manifest, the manifest this run's, every module
// matching it.  Returns {manifest, bytes: {name: Buffer}}; throws naming every problem.
export function readArtifact(dir, { env = process.env } = {}) {
  const problems = [];
  const want = [...MODULES, MANIFEST].sort();
  const have = readdirSync(dir).sort();
  const extra = have.filter((f) => !want.includes(f)), missing = want.filter((f) => !have.includes(f));
  if (extra.length) problems.push(`unexpected files: ${extra.join(", ")}`);
  if (missing.length) problems.push(`missing: ${missing.join(", ")}`);
  let manifest = null;
  if (!missing.includes(MANIFEST)) {
    try {
      manifest = JSON.parse(readFileSync(join(dir, MANIFEST), "utf8"));
    } catch (e) {
      problems.push(`${MANIFEST} doesn't parse: ${e.message}`);
    }
  }
  const run = runOf(env);
  if (manifest) {
    if (manifest.v !== 1) problems.push(`${MANIFEST}: unknown version ${manifest.v}`);
    if (manifest.run_id !== run.run_id || manifest.sha !== run.sha) {
      problems.push(`${MANIFEST} is from run ${manifest.run_id} at ${manifest.sha}, not this run (${run.run_id} at ${run.sha})`);
    }
    const names = Object.keys(manifest.modules ?? {}).sort();
    if (names.join() !== [...MODULES].sort().join()) problems.push(`${MANIFEST} names ${names.join(", ") || "no modules"}, not exactly the five`);
  }
  const bytes = {};
  for (const name of MODULES) {
    if (missing.includes(name)) continue;
    const path = join(dir, name), st = lstatSync(path);
    if (!st.isFile() || st.size > MAX_BYTES) {
      problems.push(`${name}: not a regular file of at most 64 MiB`);
      continue;
    }
    const b = readFileSync(path), m = manifest?.modules?.[name];
    if (m && !matches(b, m)) problems.push(`${name}: ${b.length} bytes, sha256 ${sha256(b)}; the manifest says ${m.bytes} bytes, sha256 ${m.sha256}`);
    bytes[name] = b;
  }
  if (problems.length) throw new Error(`wasm artifact ${dir}:\n${problems.join("\n")}`);
  return { manifest, bytes };
}

// A run on a tag: a release, which uses only a commit whose pins are its own source's build
export const isTagRun = (env = process.env) => env.GITHUB_REF_TYPE === "tag" || String(env.GITHUB_REF ?? "").startsWith("refs/tags/");

// The pin policy on a set of modules ({name: {sha256, bytes}}).  Returns the mode ("pinned" or "fresh") and the lines
// to print; throws when a mismatch isn't allowed here.  `source` stands in for this tree's (a self-test's fixture).
export function policy(modules, { root = ROOT, env = process.env, source = sourceOf(root) } = {}) {
  const pins = loadPins(root);
  const stale = MODULES.filter((n) => modules[n].sha256 !== pins[n].sha256 || modules[n].bytes !== pins[n].bytes);
  if (!stale.length) return { mode: "pinned", lines: MODULES.map((n) => `${n}: pinned`) };
  const lines = MODULES.map((n) => stale.includes(n)
    ? `${n}: fresh build (pin mismatch): sha256 ${modules[n].sha256}, ${modules[n].bytes} bytes; pinned ${pins[n].sha256}, ${pins[n].bytes} bytes`
    : `${n}: pinned`);
  if (pinsState(root, { source }) === "current") {
    throw new Error(`${lines.join("\n")}\nwasm/pins.json records this very source (${source.slice(0, 12)}), but this build differs from it: the build isn't reproducible here (the toolchain, engine/rust-toolchain.toml, or an input that SOURCE_PATHS in scripts/wasm-modules.mjs misses), or the pins were edited by hand`);
  }
  if (isTagRun(env)) {
    throw new Error(`${lines.join("\n")}\na release builds only from a commit whose pins are its own source's build, and this commit's pin is pending: tag the commit after master's pin commit (wasm/pins.json records the source then)`);
  }
  return { mode: "fresh", lines: [...lines, "(this source's pin is pending: wasm/pins.json records another source's build, so every reader here uses this run's build, labelled, never recorded as pinned. A pull request never carries a pin: master's CI commits it after the merge, scripts/wasm-pin-commit.mjs)"] };
}

export function install(dir, { root = ROOT, env = process.env, source = sourceOf(root) } = {}) {
  const { manifest, bytes } = readArtifact(dir, { env });
  const result = policy(manifest.modules, { root, env, source });
  for (const name of MODULES) {
    writeAtomic(modulePath(name, root), bytes[name]);
    if (result.mode === "pinned") recordInstalled(name, manifest.modules[name], root);
  }
  return result;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [cmd, dir, ...rest] = process.argv.slice(2);
  try {
    if (cmd === "pack" && dir) {
      const m = pack(dir);
      for (const n of MODULES) console.log(`${n}: sha256 ${m.modules[n].sha256}, ${m.modules[n].bytes} bytes`);
      console.log(`the wasm/pins.json for this build (run ${m.run_id}, ${m.sha}):\n${pinsLines(m.modules, sourceOf())}`);
    } else if (cmd === "install" && dir) {
      const r = install(dir);
      for (const l of r.lines) console.log(l);
      console.log(`wasm/: this run's build installed (${r.mode})`);
    } else if (cmd === "policy") {
      const modules = Object.fromEntries(MODULES.map((n) => {
        const b = readFileSync(modulePath(n));
        return [n, { sha256: sha256(b), bytes: b.length }];
      }));
      for (const l of policy(modules).lines) console.log(l);
    } else {
      console.error("usage: node scripts/wasm-artifact.mjs pack <dir> | install <dir> | policy");
      process.exit(2);
    }
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
