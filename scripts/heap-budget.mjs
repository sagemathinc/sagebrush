#!/usr/bin/env node
// The load-heap budget: how much of a 96 MiB worker heap Magma mode uses
// once it has loaded, before a script runs.  What is left is the script's,
// and lib/_magma.py's comprehension bound _COLLECT_MAX is taken from it:
// (96 MiB - used, rounded up to a MiB) / _COLLECT_COST, used being V8's
// used_heap_size after a full collection at the end of _magma's import
// (_magma._COLLECT_USED).  Every feature that loads with Magma mode grows
// it a little (F2's finite fields: about 0.5 MB), so it is checked here,
// like the core's bytes in size-budget.json:
//   - each of `runs` fresh processes (node --max-old-space-size=96
//     dist/src/cli.js) reports _COLLECT_USED and _COLLECT_MAX;
//   - the largest used must not exceed heap-budget.json's ceiling, which
//     sits below the heap with explicit headroom; raising it is an edit to
//     heap-budget.json, made in review;
//   - the ceiling itself must leave _COLLECT_MAX at least collect_floor,
//     the size the tests rely on (test/magma.test.ts builds collections of
//     20000), so a budget that would break them can't be recorded.
// The used heap after a collection is the same under any CPU load, but it
// differs between V8 versions (Node 26 uses about 3 MB less than Node 24),
// so both modes refuse a Node other than the one recorded, which is ci.yml's
// pinned node-version for the checks job.  To move to a new Node, change the
// pin and re-record, in one PR.
//
//   node scripts/heap-budget.mjs --check      (after pnpm run build)
//   node scripts/heap-budget.mjs --update     record the measurement; the ceiling is kept
//   node scripts/heap-budget.mjs --measure    print the measurement under any Node
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const FILE = join(root, "heap-budget.json");
const MIB = 2 ** 20;
// (lib/_magma.py's _COLLECT_COST)
export const COLLECT_COST = 1024;

// _COLLECT_MAX for a used heap of `used` bytes in a heap of `heapMib` MiB, as lib/_magma.py's _collect_max
export function collectMax(used, heapMib) {
  const limit = heapMib * MIB;
  return Math.min(10 ** 6, Math.floor(limit / 2048), Math.floor(Math.max(0, limit - Math.ceil(used / MIB) * MIB) / COLLECT_COST));
}

export function median(xs) {
  const s = [...xs].sort((a, b) => a - b), n = s.length;
  return n % 2 ? s[(n - 1) / 2] : Math.floor((s[n / 2 - 1] + s[n / 2]) / 2);
}

// Why a budget can't be used, if it can't: its fields, and a ceiling that leaves the tests their collect_floor
export function budgetProblems(b) {
  const p = [];
  for (const k of ["heap_mib", "runs", "ceiling", "collect_floor"]) if (!Number.isSafeInteger(b?.[k]) || b[k] <= 0) p.push(`${k} must be a positive integer`);
  if (typeof b?.toolchain?.node !== "string") p.push("toolchain.node must be a Node version");
  if (p.length) return p;
  if (b.ceiling >= b.heap_mib * MIB) p.push(`the ceiling ${b.ceiling} is not below the ${b.heap_mib} MiB heap`);
  const floor = collectMax(b.ceiling, b.heap_mib);
  if (floor < b.collect_floor) p.push(`at the ceiling ${b.ceiling}, _COLLECT_MAX would be ${floor} < collect_floor ${b.collect_floor}, which the tests rely on`);
  return p;
}

// The verdict on one measurement ({used, max} per run) against a budget
export function verdict(b, samples) {
  const used = samples.map((s) => s.used), most = Math.max(...used);
  const out = {
    runs: samples.length,
    median: median(used),
    max: most,
    min: Math.min(...used),
    collect_max: [Math.min(...samples.map((s) => s.max)), Math.max(...samples.map((s) => s.max))],
    ceiling: b.ceiling,
    headroom: b.ceiling - most,
    collect_floor_at_ceiling: collectMax(b.ceiling, b.heap_mib),
    failures: [],
  };
  if (most > b.ceiling) out.failures.push(`the load heap ${most} > ceiling ${b.ceiling} (+${most - b.ceiling})`);
  for (const s of samples) if (s.max !== collectMax(s.used, b.heap_mib)) out.failures.push(`a run reported _COLLECT_MAX ${s.max} for used ${s.used}; expected ${collectMax(s.used, b.heap_mib)} (heap-budget.mjs and lib/_magma.py disagree)`);
  return out;
}

const PROBE = "import sys, _magma; print('HEAP', _magma._COLLECT_USED, _magma._COLLECT_MAX, sys._sagebrush_heap_limit)";

// One fresh process: Magma mode loaded in a heap of heapMib MiB
export function sample(heapMib, rootDir = root) {
  const r = spawnSync(process.execPath, [`--max-old-space-size=${heapMib}`, join(rootDir, "dist", "src", "cli.js"), "-c", PROBE], { encoding: "utf8", timeout: 120000 });
  const m = /^HEAP (\d+) (\d+) (\d+)$/m.exec(r.stdout ?? "");
  if (r.status !== 0 || !m) throw new Error(`the probe failed (status ${r.status}): ${(r.stderr || r.stdout || "").trim().slice(-500)}`);
  if (Number(m[3]) !== heapMib * MIB) throw new Error(`the probe ran with a heap limit of ${m[3]} bytes, not ${heapMib} MiB`);
  return { used: Number(m[1]), max: Number(m[2]) };
}

function report(v) {
  const mb = (n) => `${n} (${(n / MIB).toFixed(2)} MiB)`;
  console.log(`load heap over ${v.runs} runs: median ${mb(v.median)}, min ${v.min}, max ${mb(v.max)}`);
  console.log(`_COLLECT_MAX ${v.collect_max[0] === v.collect_max[1] ? v.collect_max[0] : v.collect_max.join("..")}; ceiling ${mb(v.ceiling)}, headroom ${v.headroom}; at the ceiling _COLLECT_MAX is ${v.collect_floor_at_ceiling}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2] ?? "--check";
  if (!["--check", "--update", "--measure"].includes(mode)) {
    console.error("usage: heap-budget.mjs --check | --update | --measure");
    process.exit(2);
  }
  const b = JSON.parse(readFileSync(FILE, "utf8"));
  const problems = budgetProblems(b);
  if (problems.length) {
    console.error("heap-budget.json can't be used:\n  " + problems.join("\n  "));
    process.exit(1);
  }
  const node = process.versions.node;
  if (mode !== "--measure" && node !== b.toolchain.node) {
    console.error(`the load heap can't be checked under Node ${node}: heap-budget.json was recorded with Node ${b.toolchain.node} (ci.yml's pin for the checks job), and V8's heap differs between versions. Run it under Node ${b.toolchain.node}, or move the pin and re-record`);
    process.exit(1);
  }
  const samples = [];
  for (let i = 0; i < b.runs; i++) samples.push(sample(b.heap_mib));
  const v = verdict(b, samples);
  report(v);
  if (mode === "--measure") process.exit(0);
  if (mode === "--update") {
    if (v.failures.length) {
      console.error("not recorded:\n  " + v.failures.join("\n  ") + "\nRaising the ceiling is an edit to heap-budget.json, made in review.");
      process.exit(1);
    }
    b.measured = { median: v.median, max: v.max, collect_max: v.collect_max };
    writeFileSync(FILE, JSON.stringify(b, null, 1) + "\n");
    console.log(`heap-budget.json: measurement recorded (Node ${node})`);
    process.exit(0);
  }
  if (v.failures.length) {
    console.error("the load-heap budget check failed:\n  " + v.failures.join("\n  ") + "\nAn intended growth raises the ceiling in heap-budget.json in the same PR, in review (the ceiling must keep _COLLECT_MAX at least collect_floor).");
    process.exit(1);
  }
  if (b.measured && v.median < b.measured.median - MIB) console.log(`the median is more than 1 MiB under the recorded ${b.measured.median}: record it with node scripts/heap-budget.mjs --update, and consider lowering the ceiling`);
  console.log("Magma mode's load heap is within its budget");
}
