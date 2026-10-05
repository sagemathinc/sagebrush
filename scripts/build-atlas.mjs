// node scripts/build-atlas.mjs SPACES.jsonl [LMFDB.json]  ->  web/dist/atlas/data/
//
// The atlas's stored data (served at https://sagebrush.space/atlas/data/):
//   mf/K/N.json   the newspace N.K.a: dimensions, orbits, characteristic
//                 polynomials, traces a_1..a_1000 (web/atlas/model.ts: Space)
//   index.json    one row per newform orbit, for search
//   stats.json    what is stored, and counts
//
// SPACES.jsonl comes from the engine (cargo run --release -p sagebrush-web
// --example atlas -- 1-1000:2,1-250:4,1-111:6,1-62:8,1-40:10,1-27:12 1000 16).
// LMFDB.json (optional) is {lmfdb: {label: [dim, trace_ap]}, iso: {label:
// isogeny class}} for weight 2 from the LMFDB mirror (atlas/, M0): every
// weight-2 orbit is compared with it.  Elliptic curves are Cremona's
// (lib/_cremona_small.py), matched to the dimension-1 orbits by a_p, p < 1000,
// computed here with the engine.
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { execSync } from "node:child_process";
import { spaceFromEngine, derive, primesUpTo, BOUND, RANGES } from "../web/atlas/model.ts";

const root = join(dirname(new URL(import.meta.url).pathname), "..");
const [spacesFile, lmfdbFile, costFile] = process.argv.slice(2);
if (!spacesFile) throw new Error("usage: node scripts/build-atlas.mjs SPACES.jsonl [LMFDB.json [COST-MODEL.json]]");
const out = join(root, "web", "dist", "atlas", "data");

const wasm = new WebAssembly.Instance(new WebAssembly.Module(readFileSync(join(root, "wasm", "sagebrush-engine.wasm"))), {}).exports;
function engine(req) {
  const b = new TextEncoder().encode(JSON.stringify(req));
  const p = wasm.sb_alloc(b.length);
  new Uint8Array(wasm.memory.buffer, p, b.length).set(b);
  const r = wasm.sb_call(p, b.length);
  const reply = JSON.parse(new TextDecoder().decode(new Uint8Array(wasm.memory.buffer, r, wasm.sb_reply_len())));
  wasm.sb_free(p, b.length);
  if (reply.error) throw new Error(reply.error);
  return reply.ok;
}

const raw = readFileSync(spacesFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const newDims = new Map(raw.map((x) => [`${x.n}:${x.k}`, x.dims.ok.new]));
const commit = execSync("git rev-parse HEAD", { cwd: root }).toString().trim();
const spaces = [];
for (const x of raw) {
  if (x.newforms.error || x.dims.error) throw new Error(`${x.n}.${x.k}: ${x.newforms.error ?? x.dims.error}`);
  const nd = (m) => newDims.get(`${m}:${x.k}`) ?? engine({ fn: "dims", n: m, k: x.k }).new;
  const sp = spaceFromEngine(x.n, x.k, x.dims.ok, x.newforms.ok, nd, x.seconds);
  sp.computed = "atlas";
  // what recomputing it in a browser should take (the engine's cost model)
  const e = engine({ fn: "estimate_newforms", n: x.n, k: x.k, bound: BOUND });
  sp.estimate = { seconds: +e.seconds.toFixed(3), low: +e.seconds_low.toFixed(3), high: +e.seconds_high.toFixed(3), bytes: Math.round(e.bytes) };
  spaces.push(sp);
}
spaces.sort((a, b) => a.weight - b.weight || a.level - b.level);

// ---- LMFDB, weight 2
let agree = 0, differ = [];
if (lmfdbFile) {
  const { lmfdb, iso } = JSON.parse(readFileSync(lmfdbFile, "utf8"));
  const ps = primesUpTo(BOUND);
  const ours = new Set();
  for (const sp of spaces) {
    if (sp.weight !== 2) continue;
    for (const f of sp.newforms) {
      ours.add(f.label);
      const l = lmfdb[f.label];
      const ok = l && l[0] === f.dim && l[1] && l[1].length === ps.length && ps.every((p, i) => String(l[1][i]) === f.traces[p - 1]);
      f.lmfdb = ok ? "agrees" : "differs";
      if (ok) agree++;
      else differ.push(f.label);
      if (f.dim === 1 && iso[f.label] && iso[f.label] !== `${sp.level}.${f.letter}`) throw new Error(`${f.label}: isogeny class ${iso[f.label]}`);
    }
  }
  for (const l of Object.keys(lmfdb)) if (!ours.has(l)) differ.push(l + " (LMFDB only)");
  console.log(`LMFDB, weight 2: ${agree} orbits agree, ${differ.length} differ${differ.length ? ": " + differ.slice(0, 10).join(", ") : ""}`);
}

// ---- Cremona's curves (conductor < 1000), matched by a_p
const cremona = readFileSync(join(root, "lib", "_cremona_small.py"), "utf8").split('DATA = """\\\n')[1].split('"""')[0].trim().split("\n");
const byLevel = new Map(spaces.filter((s) => s.weight === 2).map((s) => [s.level, s]));
let matched = 0;
const ps = primesUpTo(BOUND);
for (const line of cremona) {
  const [label, a, rank, torsion] = line.split(" ");
  if (!/^\d+[a-z]+1$/.test(label)) continue; // the optimal curve of each class
  const N = +label.match(/^\d+/)[0];
  const ainvs = a.split(",").map(Number);
  const ap = new Map(engine({ fn: "aplist", a: ainvs, n: BOUND }).map(([p, x]) => [p, x]));
  const sp = byLevel.get(N);
  const f = sp?.newforms.find((f) => f.dim === 1 && ps.every((p) => N % p === 0 || String(ap.get(p)) === f.traces[p - 1]));
  if (!f) throw new Error(`no newform for ${label}`);
  f.curve = { cremona: label, lmfdb: `${N}.${f.letter}`, ainvs, rank: +rank, torsion: +torsion };
  matched++;
}
const unmatched = spaces.filter((s) => s.weight === 2).flatMap((s) => s.newforms.filter((f) => f.dim === 1 && !f.curve).map((f) => f.label));
console.log(`Cremona: ${matched} isogeny classes matched; rational newforms without a curve: ${unmatched.length}`);
if (unmatched.length) throw new Error("unmatched: " + unmatched.slice(0, 10).join(", "));

// ---- write
rmSync(out, { recursive: true, force: true });
const index = [];
const stats = { commit, bound: BOUND, built: new Date().toISOString().slice(0, 10), weights: {}, orbits: 0, spaces: spaces.length, lmfdb: { agree, differ: differ.length } };
for (const sp of spaces) {
  const dir = join(out, "mf", String(sp.weight));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${sp.level}.json`), JSON.stringify(sp));
  const w = (stats.weights[sp.weight] ??= { maxLevel: 0, spaces: 0, orbits: 0, dims: {}, grid: RANGES.map(() => 0) });
  w.grid[RANGES.findIndex(([a, b]) => a <= sp.level && sp.level <= b)] += sp.newforms.length;
  w.maxLevel = Math.max(w.maxLevel, sp.level);
  w.spaces++;
  for (const f of sp.newforms) {
    const d = derive(sp, f);
    // [label, level, weight, dim, cm, sign, tr a_1..a_10, curve, LMFDB comparison]
    index.push([f.label, sp.level, sp.weight, f.dim, d.cm ?? 0, d.sign ?? 0, f.traces.slice(0, 10), f.curve ? [f.curve.cremona, f.curve.rank, f.curve.torsion] : 0, f.lmfdb === "agrees" ? 1 : f.lmfdb ? -1 : 0]);
    w.orbits++;
    stats.orbits++;
    w.dims[f.dim] = (w.dims[f.dim] ?? 0) + 1;
  }
}
writeFileSync(join(out, "index.json"), JSON.stringify(index));
// predicted against measured (web/atlas/fit-cost.py), for the About page
if (costFile) writeFileSync(join(out, "cost-model.json"), readFileSync(costFile));
writeFileSync(join(out, "stats.json"), JSON.stringify(stats));
console.log(`web/dist/atlas/data: ${spaces.length} spaces, ${stats.orbits} orbits; index ${(JSON.stringify(index).length / 1e6).toFixed(2)} MB`);
