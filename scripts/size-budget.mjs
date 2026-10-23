#!/usr/bin/env node
// The core's size budget (plan-modular-packages-r4 §7.2; William, Oct 22:
// adding an optional package must not grow the core at all).  Compares the
// built core artifacts with size-budget.json, exact bytes:
//   - the engine's files (web/dist/engine/<latest>/manifest.json): the
//     worker, the Wasm modules, and each library group's chunks, by group
//     (lib/<group>.<kind>, the hash in the name dropped);
//   - the CLI bundle (build/cli/pyjs.cjs) and its generated library and
//     packages (build/cli/lib.gen.js, packages.gen.js);
//   - how many packages the core's registry has.
// Any increase fails unless this PR also updates size-budget.json (a core
// feature may grow the core on purpose, visibly, in review; a package
// never can).  A decrease passes with a reminder to lower the budget.
// Also: no optional package appears in any of these artifacts.
//
//   node scripts/size-budget.mjs --check     (the default tier, after bun web/build.ts and build-cli)
//   node scripts/size-budget.mjs --update    record the current sizes
//
// It reads files already built; it builds nothing. Exact bytes are only
// meaningful for one build, so both modes refuse a build made differently
// from CI's (ci.yml's checks job):
//   - the CLI bundle must be built AFTER the web app (bun web/build.ts, then
//     node scripts/build-cli.mjs), since it embeds the web app's files;
//   - the bun that built the web app must be the one recorded here, which is
//     ci.yml's pinned bun-version: bun's minifier changes bytes between
//     releases. To move to a new bun, change the pin and re-record, in one PR.
// And sizes are counted without the checkout's own absolute path, which the
// CLI bundle embeds (in its __dirname values): the same build in another
// directory (CI's, a VM's) then measures the same.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const FILE = join(root, "size-budget.json");

// a file's size without the bytes of the checkout's absolute path in it
function pathFreeSize(file, rootDir) {
  const bytes = readFileSync(file), needle = Buffer.from(rootDir);
  let n = 0;
  for (let i = bytes.indexOf(needle); i >= 0; i = bytes.indexOf(needle, i + needle.length)) n++;
  return bytes.length - n * needle.length;
}

export function measure(rootDir = root) {
  const out = {};
  const dist = join(rootDir, "web", "dist");
  const latest = JSON.parse(readFileSync(join(dist, "engine", "latest.json"), "utf8"));
  const engine = join(dist, "engine", latest.id);
  const manifest = JSON.parse(readFileSync(join(engine, "manifest.json"), "utf8"));
  for (const [name, f] of Object.entries(manifest.files)) {
    // (lib/<group>.<kind>.<16 hex>.json -> lib/<group>.<kind>, summed; the zone data's files by count and bytes)
    const m = /^lib\/(.+)\.(src|pre)\.[0-9a-f]{16}\.json$/.exec(name);
    const key = m ? `engine/lib/${m[1]}.${m[2]}` : name.startsWith("lib/tzdata/") ? "engine/lib/tzdata" : `engine/${name}`;
    const file = join(engine, name);
    out[key] = (out[key] ?? 0) + (existsSync(file) ? pathFreeSize(file, rootDir) : f.size);
  }
  for (const f of ["pyjs.cjs", "lib.gen.js", "packages.gen.js"]) out[`cli/${f}`] = pathFreeSize(join(rootDir, "build", "cli", f), rootDir);
  const reg = JSON.parse(readFileSync(join(rootDir, "packages", "registry.json"), "utf8"));
  out["registry/packages"] = Object.keys(reg.packages).length;
  return Object.fromEntries(Object.entries(out).sort((a, b) => a[0].localeCompare(b[0])));
}

// The build the sizes come from, or why it isn't the CI build: the CLI after
// the web app, and the bun version (the one on PATH, which built the web app)
export function buildProblems(rootDir = root, recordedBun) {
  const problems = [];
  const index = join(rootDir, "web", "dist", "index.html"), cli = join(rootDir, "build", "cli", "pyjs.cjs");
  if (!existsSync(index)) problems.push("web/dist/index.html is missing: run bun web/build.ts, then node scripts/build-cli.mjs");
  else if (existsSync(cli) && statSync(cli).mtimeMs < statSync(index).mtimeMs) problems.push("build/cli/pyjs.cjs is older than web/dist: the CLI embeds the web app, so build it after bun web/build.ts (node scripts/build-cli.mjs), as CI does");
  const bun = bunVersion();
  if (recordedBun !== undefined && bun !== recordedBun) problems.push(`the web app was built with bun ${bun ?? "(none on PATH)"}, but size-budget.json was recorded with bun ${recordedBun} (ci.yml's pin): bun's output differs between releases. Build with bun ${recordedBun}, or move the pin and re-record`);
  return problems;
}
function bunVersion() {
  const r = spawnSync("bun", ["--version"], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

// No optional package's id or module in the core's artifacts (§7.2)
export function optionalLeaks(rootDir = root) {
  const odir = join(rootDir, "optional");
  if (!existsSync(odir)) return [];
  const leaks = [];
  const reg = readFileSync(join(rootDir, "packages", "registry.json"), "utf8");
  const gen = readFileSync(join(rootDir, "build", "cli", "packages.gen.js"), "utf8");
  const dist = join(rootDir, "web", "dist");
  const latest = JSON.parse(readFileSync(join(dist, "engine", "latest.json"), "utf8"));
  const manifest = readFileSync(join(dist, "engine", latest.id, "manifest.json"), "utf8");
  const worker = readFileSync(join(dist, "sagebrush-worker.js"), "utf8");
  for (const dir of readdirSync(odir)) {
    if (!existsSync(join(odir, dir, "sagebrush.json"))) continue;
    const m = JSON.parse(readFileSync(join(odir, dir, "sagebrush.json"), "utf8"));
    const id = `${m.name}@${m.version}`;
    for (const [what, text] of [["packages/registry.json", reg], ["build/cli/packages.gen.js", gen], ["the engine's manifest", manifest], ["the worker", worker]]) {
      if (text.includes(id) || text.includes(`"${dir}/`) || text.includes(`pkg-${dir}`)) leaks.push(`${id} appears in ${what}`);
    }
  }
  return leaks;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2];
  if (mode === "--update") {
    const problems = buildProblems(root);
    if (problems.length) {
      console.error("not recorded, since this isn't the CI build:\n  " + problems.join("\n  "));
      process.exit(1);
    }
    const now = measure();
    writeFileSync(FILE, JSON.stringify({ note: "exact bytes of the core's artifacts: scripts/size-budget.mjs; any increase must be made here, in review", toolchain: { bun: bunVersion() }, sizes: now }, null, 1) + "\n");
    console.log(`size-budget.json: ${Object.keys(now).length} artifacts recorded (bun ${bunVersion()})`);
  } else if (mode === "--check") {
    const recorded = JSON.parse(readFileSync(FILE, "utf8"));
    const problems = buildProblems(root, recorded.toolchain?.bun);
    if (problems.length) {
      console.error("the core's size budget can't be checked against this build:\n  " + problems.join("\n  "));
      process.exit(1);
    }
    const now = measure();
    const budget = recorded.sizes;
    const grew = [], shrank = [];
    for (const [k, v] of Object.entries(now)) {
      if (!Object.hasOwn(budget, k)) grew.push(`${k}: new (${v}); not in size-budget.json`);
      else if (v > budget[k]) grew.push(`${k}: ${v} > ${budget[k]} (+${v - budget[k]})`);
      else if (v < budget[k]) shrank.push(`${k}: ${v} < ${budget[k]} (-${budget[k] - v})`);
    }
    for (const k of Object.keys(budget)) if (!Object.hasOwn(now, k)) shrank.push(`${k}: gone`);
    const leaks = optionalLeaks();
    if (shrank.length) console.log("smaller than the budget (lower it with node scripts/size-budget.mjs --update):\n  " + shrank.join("\n  "));
    if (grew.length || leaks.length) {
      console.error("the core's size budget check failed:\n  " + [...grew, ...leaks].join("\n  ") + "\nAn intended core change updates size-budget.json in the same PR (node scripts/size-budget.mjs --update); an optional package never grows the core.");
      process.exit(1);
    }
    console.log(`the core is within its size budget (${Object.keys(now).length} artifacts)`);
  } else {
    console.error("usage: size-budget.mjs --check | --update");
    process.exit(2);
  }
}
