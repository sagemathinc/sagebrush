#!/usr/bin/env node
// size-base's fail-closed acquisition of a base commit's WebAssembly modules.  Published pins are fetched normally.
// Only when every fetch failure is an HTTP 404 is the base commit built from its own source; all five resulting
// modules must then match that base's pins exactly.  Network errors, corrupt objects and build/pin mismatches fail.
// On a track (scripts/pin-policy.mjs: a pull request into track/*, a push or dispatch on it) the base's pin can lag
// its engine (the pin moves only with the track's pull into master), so its published modules may not be its
// engine at all: the base is always built from its own source, and the result is labelled pinned or fresh.
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchModules } from "./wasm-fetch.mjs";
import { existsSync } from "node:fs";
import { checkModules, MODULES, ROOT, modulePath, writeSidecar } from "./wasm-modules.mjs";
import { onTrack, runRefs } from "./pin-policy.mjs";

const escaped = MODULES.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
const NOT_FOUND = new RegExp(`^(${escaped}): \\S+: 404(?:\\s|$)`);

export function unpublishedOnly(error) {
  const lines = String(error?.message ?? error).split("\n");
  const header = /^wasm-fetch: ([1-4]) of 4 modules failed:$/.exec(lines[0]);
  if (!header) return false;
  const count = Number(header[1]);
  const failures = lines.slice(1);
  if (failures.length !== count || !failures.every((line) => NOT_FOUND.test(line))) return false;
  return new Set(failures.map((line) => NOT_FOUND.exec(line)[1])).size === count;
}

function buildBase(root) {
  execFileSync(process.execPath, [join(root, "scripts", "build-engine.mjs")], {
    cwd: root,
    env: process.env,
    stdio: "inherit",
  });
}

export async function fetchOrBuild({
  root = ROOT,
  fetch = fetchModules,
  build = buildBase,
  check = checkModules,
  mark = (root) => { for (const name of MODULES) if (existsSync(modulePath(name, root))) writeSidecar(name, root); },
  log = (line) => console.log(line),
  env = process.env,
} = {}) {
  if (onTrack(runRefs(env))) {
    log("a track's base: building it from its own source (its pin may lag its engine)");
    build(root);
    // (each module this build wrote gets its sidecar; then a module built here or a pinned one passes, and a
    // missing or unidentified one fails)
    mark(root);
    const lines = check({ root, mode: "local" });
    for (const line of lines) log(line);
    if (lines.every((line) => line.endsWith(": pinned"))) {
      log("base WebAssembly source build matches every pin");
      return "built";
    }
    log("::warning::the track base's fresh build differs from its pins (expected on a track): measured as built");
    return "built-fresh";
  }
  try {
    await fetch({ root, log });
    return "fetched";
  } catch (error) {
    if (!unpublishedOnly(error)) throw error;
    log("::warning::a base WebAssembly pin is unpublished (404); building the base commit from source");
  }
  build(root);
  const lines = check({ root, mode: "pinned" });
  for (const line of lines) log(line);
  log("base WebAssembly source build matches every pin");
  return "built";
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const i = args.indexOf("--root");
  if (i < 0 || i + 2 !== args.length) {
    console.error("usage: node scripts/wasm-fetch-or-build.mjs --root DIR");
    process.exit(2);
  }
  try {
    await fetchOrBuild({ root: args[i + 1] });
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
