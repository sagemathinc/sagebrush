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
// It reads files already built; it builds nothing.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const FILE = join(root, "size-budget.json");

export function measure(rootDir = root) {
  const out = {};
  const dist = join(rootDir, "web", "dist");
  const latest = JSON.parse(readFileSync(join(dist, "engine", "latest.json"), "utf8"));
  const manifest = JSON.parse(readFileSync(join(dist, "engine", latest.id, "manifest.json"), "utf8"));
  for (const [name, f] of Object.entries(manifest.files)) {
    // (lib/<group>.<kind>.<16 hex>.json -> lib/<group>.<kind>, summed; the zone data's files by count and bytes)
    const m = /^lib\/(.+)\.(src|pre)\.[0-9a-f]{16}\.json$/.exec(name);
    const key = m ? `engine/lib/${m[1]}.${m[2]}` : name.startsWith("lib/tzdata/") ? "engine/lib/tzdata" : `engine/${name}`;
    out[key] = (out[key] ?? 0) + f.size;
  }
  for (const f of ["pyjs.cjs", "lib.gen.js", "packages.gen.js"]) out[`cli/${f}`] = statSync(join(rootDir, "build", "cli", f)).size;
  const reg = JSON.parse(readFileSync(join(rootDir, "packages", "registry.json"), "utf8"));
  out["registry/packages"] = Object.keys(reg.packages).length;
  return Object.fromEntries(Object.entries(out).sort((a, b) => a[0].localeCompare(b[0])));
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
  const now = measure();
  if (mode === "--update") {
    writeFileSync(FILE, JSON.stringify({ note: "exact bytes of the core's artifacts: scripts/size-budget.mjs; any increase must be made here, in review", sizes: now }, null, 1) + "\n");
    console.log(`size-budget.json: ${Object.keys(now).length} artifacts recorded`);
  } else if (mode === "--check") {
    const budget = JSON.parse(readFileSync(FILE, "utf8")).sizes;
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
