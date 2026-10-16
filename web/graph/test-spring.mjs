// web/graph/spring.ts: a spring layout of boxes that no two overlap, fixed
// boxes stay put, the same input and seed give the same positions (here, under
// Node and Deno too), linked boxes end nearer than others, and past its caps
// it refuses. With bun:
//   bun web/graph/test-spring.mjs
import { springLayout, springSteps, MAX_NODES, MAX_EDGES } from "./spring.ts";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const fails = [];
let checks = 0;
const check = (ok, what) => { checks++; if (!ok) fails.push(what); };

const GAP = 24;
const overlap = (nodes, pos, gap = GAP) => {
  for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
    const a = nodes[i], b = nodes[j], p = pos.get(a.id), q = pos.get(b.id);
    if (p.x < q.x + b.w + gap - 1e-3 && q.x < p.x + a.w + gap - 1e-3 && p.y < q.y + b.h + gap - 1e-3 && q.y < p.y + a.h + gap - 1e-3) return [a.id, b.id];
  }
  return null;
};
const centre = (nd, pos) => { const p = pos.get(nd.id); return [p.x + nd.w / 2, p.y + nd.h / 2]; };
const dist = (a, b, pos) => { const [x1, y1] = centre(a, pos), [x2, y2] = centre(b, pos); return Math.sqrt((x1 - x2) ** 2 + (y1 - y2) ** 2); };
const pts = (n, w = 0, h = 0) => Array.from({ length: n }, (_, i) => ({ id: "v" + i, w, h }));

const GRAPHS = {
  path: [pts(8), Array.from({ length: 7 }, (_, i) => ["v" + i, "v" + (i + 1)])],
  cycle: [pts(10), Array.from({ length: 10 }, (_, i) => ["v" + i, "v" + ((i + 1) % 10)])],
  k5: [pts(5), [0, 1, 2, 3, 4].flatMap((i) => [0, 1, 2, 3, 4].filter((j) => j > i).map((j) => ["v" + i, "v" + j]))],
  tree: [pts(15, 30, 20), Array.from({ length: 14 }, (_, i) => ["v" + Math.floor(i / 2), "v" + (i + 1)])],
  boxes: [[{ id: "a", w: 200, h: 80 }, { id: "b", w: 120, h: 120 }, { id: "c", w: 60, h: 40 }, { id: "d", w: 300, h: 30 }, { id: "e", w: 10, h: 10 }], [["a", "b"], ["b", "c"], ["c", "a"], ["d", "e"]]],
  parts: [pts(20, 40, 30), [["v0", "v1"], ["v1", "v2"], ["v3", "v4"], ["v5", "v6"], ["v6", "v7"], ["v7", "v5"]]],
  petersen: [pts(10), [[0, 1], [1, 2], [2, 3], [3, 4], [4, 0], [0, 5], [1, 6], [2, 7], [3, 8], [4, 9], [5, 7], [7, 9], [9, 6], [6, 8], [8, 5]].map(([a, b]) => ["v" + a, "v" + b])],
};

for (const [name, [nodes, edges]] of Object.entries(GRAPHS)) {
  const pos = springLayout(nodes, edges, { seed: 7 });
  check(pos !== null && pos.size === nodes.length, `${name}: every node placed`);
  if (!pos) continue;
  const o = overlap(nodes, pos);
  check(o === null, `${name}: no two boxes closer than the gap (${o})`);
  check(nodes.every((nd) => Number.isFinite(pos.get(nd.id).x) && Number.isFinite(pos.get(nd.id).y)), `${name}: finite positions`);
  const again = springLayout(nodes, edges, { seed: 7 });
  check(JSON.stringify([...again]) === JSON.stringify([...pos]), `${name}: the same seed, the same layout`);
  // (linked boxes nearer than the average pair)
  const by = new Map(nodes.map((n) => [n.id, n]));
  const el = edges.map(([a, b]) => dist(by.get(a), by.get(b), pos));
  const all = [];
  for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) all.push(dist(nodes[i], nodes[j], pos));
  const mean = (xs) => xs.reduce((s, v) => s + v, 0) / xs.length;
  // (not where every pair is linked, as in K5, nor among boxes of mixed sizes)
  const complete = edges.length >= (nodes.length * (nodes.length - 1)) / 2;
  if (name !== "boxes" && !complete) check(mean(el) < mean(all), `${name}: edges shorter than the average pair (${mean(el).toFixed(1)} vs ${mean(all).toFixed(1)})`);
  // the steps end where the layout does
  const steps = [...springSteps(nodes, edges, { seed: 7 }, 25)];
  check(JSON.stringify([...steps.at(-1)]) === JSON.stringify([...pos]), `${name}: springSteps ends at springLayout's result`);
  check(steps.length > 2, `${name}: springSteps yields along the way (${steps.length})`);
}

// a different seed may differ, but stays valid
{
  const [nodes, edges] = GRAPHS.petersen;
  const p = springLayout(nodes, edges, { seed: 8 });
  check(p !== null && overlap(nodes, p) === null, "another seed: no overlap");
}

// fixed boxes stay where they are, and the others move around them
{
  const nodes = pts(12, 40, 30);
  nodes[0].fixed = { x: 100, y: 50 };
  nodes[5].fixed = { x: 400, y: 50 };
  const edges = Array.from({ length: 11 }, (_, i) => ["v" + i, "v" + (i + 1)]);
  const pos = springLayout(nodes, edges, { seed: 3 });
  check(pos.get("v0").x === 100 && pos.get("v0").y === 50 && pos.get("v5").x === 400 && pos.get("v5").y === 50, "fixed boxes do not move");
  check(overlap(nodes, pos) === null, "no overlap with fixed boxes");
}

// caps: refused past them (null), within them finished in bounded time
check(springLayout(pts(MAX_NODES + 1), [], { seed: 1 }) === null, "more than MAX_NODES nodes: refused");
check(springLayout(pts(10), Array.from({ length: MAX_EDGES + 1 }, () => ["v0", "v1"]), { seed: 1 }) === null, "more than MAX_EDGES edges: refused");
{
  const nodes = pts(MAX_NODES, 6, 6);
  const edges = Array.from({ length: MAX_NODES - 1 }, (_, i) => ["v" + i, "v" + (i + 1)]);
  const t = Date.now();
  const pos = springLayout(nodes, edges, { seed: 1 });
  const ms = Date.now() - t;
  check(pos !== null && pos.size === MAX_NODES, "MAX_NODES nodes: laid out");
  check(ms < 60000, `MAX_NODES nodes: within a minute (${ms} ms)`);
  console.log(`  ${MAX_NODES} nodes in ${ms} ms`);
}
check(springLayout([], [], { seed: 1 }).size === 0, "no nodes: an empty layout");
check(springLayout(pts(1, 10, 10), [["v0", "v0"], ["v0", "nobody"]], { seed: 1 }).size === 1, "a loop and an unknown end are ignored");

// the same on Node and Deno as here (Bun)
{
  const [nodes, edges] = GRAPHS.tree;
  const here = JSON.stringify([...springLayout(nodes, edges, { seed: 42 })]);
  // (Node reads it as an ES module from a .mts copy: the repository's
  // package type would make the .ts CommonJS)
  const dir = mkdtempSync(join(tmpdir(), "sb-spring-"));
  copyFileSync(new URL("./spring.ts", import.meta.url), join(dir, "spring.mts"));
  const code = (file) => `import { springLayout } from ${JSON.stringify("file://" + file)};\nconst [nodes, edges] = ${JSON.stringify([nodes, edges])};\nconsole.log(JSON.stringify([...springLayout(nodes, edges, { seed: 42 })]));`;
  for (const [cmd, args, file] of [["node", ["--input-type=module", "-e"], join(dir, "spring.mts")], ["deno", ["eval"], new URL("./spring.ts", import.meta.url).pathname]]) {
    let there = null;
    try {
      there = execFileSync(cmd, [...args, code(file)], { encoding: "utf8", timeout: 60000 }).trim();
    } catch (e) {
      there = "error: " + String(e.message).slice(0, 200);
    }
    check(there === here, `the same layout under ${cmd} (${there.slice(0, 80)})`);
  }
  rmSync(dir, { recursive: true, force: true });
}

console.log(`${checks - fails.length}/${checks} checks passed`);
for (const f of fails) console.log("FAIL " + f);
process.exit(fails.length ? 1 : 0);
