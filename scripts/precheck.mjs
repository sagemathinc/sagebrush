#!/usr/bin/env node
// CI's quick gates, run here before a head is sent for review or CI: the census, inventory, generated-file and
// discovery checks that a change most often fails on CI, each with the very command ci.yml runs (a step marked ci:
// is held to that by scripts/test-precheck.mjs, so the two can't drift), plus the test files the change touches.
// It runs every step and reports every failure at once, so one round fixes them all.  Not a substitute for CI: the
// engine, web, browser, size and long tiers run only there (scripts/ci-local.py runs CI's jobs here in full).
//
//   node scripts/precheck.mjs                 the quick gates, the build ones and the touched tests (a few minutes)
//   node scripts/precheck.mjs --quick         only the gates that need no build (about a minute)
//   node scripts/precheck.mjs --full          also the long census suites (limits, catalog: several minutes more)
//   node scripts/precheck.mjs --base REF      the branch's base, for the touched tests and git diff --check
//                                             (default: whichever of origin/master and origin/track/* is nearest)
//   node scripts/precheck.mjs --list          the steps, without running them
// The engine in wasm/ is made this tree's own first (scripts/engine-cache.mjs: fetched, copied or built once).
// When CI fails on a gate this could have run, add that gate here (a step with its ci.yml command).
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { check as checkEngine } from "./engine-cache.mjs";

const ROOT = join(fileURLToPath(import.meta.url), "..", "..");

// tier: quick (no build), build (after pnpm run build and the engine), full (long suites).  ci: the step is a line of
// a workflow's run: script, verbatim; a step without it is this script's own (the base-relative diff check).
export const STEPS = [
  { tier: "quick", ci: true, name: "whitespace (working tree)", run: "git diff --check" },
  { tier: "quick", name: "whitespace (the branch)", run: 'git diff --check "$PRECHECK_BASE" --' },
  { tier: "quick", ci: true, name: "test discovery", run: "node scripts/web-tests.mjs check" },
  { tier: "quick", ci: true, name: "core imports no server code", run: "bun scripts/test-check-no-server-imports.mjs && bun scripts/check-no-server-imports.mjs", needs: "bun" },
  { tier: "quick", ci: true, name: "actions pinned", run: "bun scripts/test-check-action-pins.mjs && bun scripts/check-action-pins.mjs", needs: "bun" },
  { tier: "quick", ci: true, name: "limits census", run: "python3 test/limit_sites.py --check > census.json || { cat census.json; exit 1; }", leaves: "census.json" },
  { tier: "quick", ci: true, name: "limits sweep manifest", run: "python3 test/limit_sweep.py verify" },
  { tier: "quick", ci: true, name: "census suites", run: "node scripts/web-tests.mjs run census" },
  { tier: "quick", ci: true, name: "unsafe inventory", run: "node scripts/unsafe-inventory.mjs --check" },
  { tier: "build", ci: true, name: "CLI build", run: "node scripts/build-cli.mjs" },
  { tier: "build", ci: true, name: "third-party notices", run: "node scripts/third-party-notices.mjs --check" },
  { tier: "build", ci: true, name: "packages", run: "node scripts/packages.mjs --check" },
  { tier: "build", ci: true, name: "Core API surface", run: "node scripts/core-api-surface.mjs --check" },
  { tier: "build", ci: true, name: "Sage names", run: "python3 scripts/sage_names.py --check" },
  { tier: "build", ci: true, name: "Sage shim index", run: "python3 test/sage_shim_index.py" },
  { tier: "build", ci: true, name: "PyPI import", run: "node scripts/pypi-import.mjs --check" },
  { tier: "build", ci: true, name: "tzdata import", run: "node scripts/tzdata-import.mjs --check" },
  { tier: "build", ci: true, name: "Python package sync and docs index", run: "scripts/sync-python-package.sh --check" },
  { tier: "build", ci: true, name: "viewer3d", run: "node scripts/gen-viewer3d.mjs --check" },
  { tier: "build", ci: true, name: "cdn", run: "node cdn/build.mjs --check" },
  { tier: "build", ci: true, name: "board format schema", run: "node scripts/board-format-schema.mjs --check" },
  { tier: "build", ci: true, name: "matrix checks", run: "node dist/src/cli.js engine/py/test_matrix_checks.py" },
  { tier: "build", ci: true, name: "Sage colors", run: "node dist/src/cli.js engine/py/test_sage_colors.py" },
  { tier: "build", name: "interrupt census", run: "node --test dist/test/interrupt-census.test.js", suite: "test/interrupt-census.test.ts" },
  { tier: "full", name: "limits suite", run: "node --test dist/test/limits.test.js", suite: "test/limits.test.ts" },
  { tier: "full", name: "catalog suite", run: "node --test dist/test/catalog.test.js", suite: "test/catalog.test.ts" },
];
const TIERS = { quick: ["quick"], default: ["quick", "build"], full: ["quick", "build", "full"] };

// The lines of this tree's workflows' run: scripts, trimmed: a ci: step runs only when its tree's CI runs it (a track
// behind master lacks master's newer gates, and CI there doesn't run them either).
export function workflowLines(root = ROOT) {
  const dir = join(root, ".github", "workflows");
  const lines = new Set();
  for (const f of readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)))
    for (const l of readFileSync(join(dir, f), "utf8").split("\n")) lines.add(l.trim().replace(/^(- )?run: /, ""));
  return lines;
}

const git = (args) => execFileSync("git", ["-C", ROOT, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const have = (cmd) => spawnSync("sh", ["-c", `command -v ${cmd}`], { stdio: "ignore" }).status === 0;

// The nearest of origin/master and the tracks: the fewest commits from it to HEAD.
export function nearestBase() {
  const refs = ["origin/master", ...git(["for-each-ref", "--format=%(refname:short)", "refs/remotes/origin/track/"]).split("\n").filter(Boolean)];
  let best = null;
  for (const ref of refs) {
    let n;
    try {
      n = Number(git(["rev-list", "--count", `${ref}..HEAD`]));
    } catch {
      continue;
    }
    if (best === null || n < best.n) best = { ref, n };
  }
  if (!best) throw new Error("precheck: no origin/master or origin/track/* to compare with: pass --base REF");
  return best.ref;
}

// The test files the branch (and the working tree) touches, as the commands CI's suites run them with.
export function touchedTests(base) {
  const files = new Set([
    ...git(["diff", "--name-only", "--diff-filter=AM", `${base}...HEAD`]).split("\n"),
    ...git(["diff", "--name-only", "--diff-filter=AM", "HEAD"]).split("\n"),
  ]);
  const out = [];
  for (const f of [...files].filter(Boolean).sort()) {
    let m;
    if ((m = /^test\/([^/]+)\.test\.ts$/.exec(f)) && !STEPS.some((s) => s.suite === f))
      out.push({ tier: "build", name: `touched: ${f}`, run: `node --test --test-timeout=300000 dist/test/${m[1]}.test.js` });
    else if (/^scripts\/test-[^/]+\.mjs$/.test(f)) out.push({ tier: "quick", name: `touched: ${f}`, run: `node ${f}` });
    else if (/^engine\/py\/test_[^/]+\.py$/.test(f)) out.push({ tier: "build", name: `touched: ${f}`, run: `node dist/src/cli.js ${f}` });
  }
  return out;
}

function main(argv) {
  let tier = "default", base = null, list = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--quick") tier = "quick";
    else if (a === "--full") tier = "full";
    else if (a === "--list") list = true;
    else if (a === "--base") base = argv[++i];
    else {
      console.error(`precheck: unknown argument ${a}\nusage: node scripts/precheck.mjs [--quick | --full] [--base REF] [--list]`);
      return 2;
    }
  }
  const ref = base ?? nearestBase();
  base = git(["merge-base", ref, "HEAD"]);
  const tiers = TIERS[tier];
  const steps = [...STEPS, ...touchedTests(base)].filter((s) => tiers.includes(s.tier));
  const order = (s) => ["quick", "build", "full"].indexOf(s.tier);
  steps.sort((a, b) => order(a) - order(b));
  if (list) {
    console.log(`base ${ref} (${base.slice(0, 12)})`);
    for (const s of steps) console.log(`${s.tier.padEnd(5)}  ${s.name.padEnd(38)}  ${s.run}`);
    return 0;
  }
  const logs = mkdtempSync(join(tmpdir(), "precheck-"));
  const env = { ...process.env, PRECHECK_BASE: base };
  const results = [];
  const ciLines = workflowLines();
  const run = (s) => {
    if (s.ci && !ciLines.has(s.run)) {
      results.push({ s, status: "SKIP", why: "this tree's workflows don't run it" });
      console.log(`skip         ${s.name} (this tree's workflows don't run it)`);
      return;
    }
    if (s.needs && !have(s.needs)) {
      results.push({ s, status: "SKIP", why: `${s.needs} not found` });
      console.log(`SKIP         ${s.name} (${s.needs} not found: CI runs it)`);
      return;
    }
    const log = join(logs, `${results.length}.log`);
    const left = s.leaves && !existsSync(join(ROOT, s.leaves)) ? join(ROOT, s.leaves) : null;
    const t0 = Date.now();
    const r = spawnSync("bash", ["-o", "pipefail", "-c", `(${s.run}) > '${log}' 2>&1`], { cwd: ROOT, env, stdio: "inherit" });
    if (left) rmSync(left, { force: true }); // (CI's command writes it; a checkout here shouldn't keep it)
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    const status = r.status === 0 ? "ok" : "FAIL";
    console.log(`${status.padEnd(4)} ${secs.padStart(6)}s  ${s.name}`);
    results.push({ s, status, log });
  };
  console.log(`precheck: base ${ref} (${base.slice(0, 12)}), tier ${tier}, logs in ${logs}`);
  for (const s of steps.filter((s) => s.tier === "quick")) run(s);
  if (tiers.includes("build")) {
    let ready = true;
    // (a checkout sharing another's node_modules through a symlink is never given to pnpm, which would purge it)
    const shared = lstatSync(join(ROOT, "node_modules"), { throwIfNoEntry: false })?.isSymbolicLink();
    for (const s of [
      shared
        ? { name: "TypeScript build (node_modules is shared: no pnpm)", run: "node node_modules/typescript/bin/tsc -p ." }
        : { name: "pnpm install", run: "pnpm install --frozen-lockfile" },
      ...(shared ? [] : [{ name: "TypeScript build", run: "pnpm run build" }]),
      { name: "this tree's engine (scripts/engine-cache.mjs)", run: "node scripts/engine-cache.mjs && node scripts/engine-cache.mjs --check" },
    ]) {
      run(s);
      if (results.at(-1).status !== "ok") ready = false;
      if (!ready) break;
    }
    if (ready) {
      // (a local build is this tree's engine, and the tests read it only when told to)
      if (checkEngine({ root: ROOT, env }).mode === "local") env.SAGEBRUSH_WASM_LOCAL = "1";
      for (const s of steps.filter((s) => s.tier !== "quick")) run(s);
    } else console.log("     (the build failed: the build-tier steps were not run)");
  }
  const bad = results.filter((r) => r.status !== "ok");
  for (const r of bad.filter((r) => !(r.s.ci && !ciLines.has(r.s.run)))) {
    console.log(`\n=== ${r.status}: ${r.s.name}\n$ ${r.s.run}`);
    if (r.why) console.log(r.why);
    else if (existsSync(r.log)) console.log(readFileSync(r.log, "utf8").split("\n").slice(-25).join("\n"));
  }
  const failed = bad.filter((r) => r.status === "FAIL").length;
  console.log(`\nprecheck: ${results.length - bad.length} ok, ${failed} failed, ${bad.length - failed} skipped (logs in ${logs})`);
  return failed ? 1 : 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
