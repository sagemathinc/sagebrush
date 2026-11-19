#!/usr/bin/env node
// size-base's fail-closed acquisition of a base commit's WebAssembly modules.  Published pins are fetched normally.
// Only when every fetch failure is an HTTP 404 is the base commit built from its own source; all four resulting
// modules must then match that base's pins exactly.  Network errors, corrupt objects and build/pin mismatches fail.
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchModules } from "./wasm-fetch.mjs";
import { checkModules, MODULES, ROOT } from "./wasm-modules.mjs";

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
  log = (line) => console.log(line),
} = {}) {
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
