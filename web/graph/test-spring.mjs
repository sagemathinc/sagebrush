// web/graph/spring.ts: a spring layout of boxes that no two overlap, fixed
// boxes stay put, the same input and seed give the same positions (here, under
// Node and Deno too), linked boxes end nearer than others, and past its caps
// it refuses. With bun:
//   bun web/graph/test-spring.mjs
import { springLayout, springSteps, gapViolations, springWork, WORK, MAX_NODES, MAX_EDGES, MAX_FRAMES, MIN_LENGTH, MAX_LENGTH, packRows, placeRows } from "./spring.ts";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
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
// the work, counted: never more pair evaluations than WORK, also when the
// final sweeps do not settle (HARD-2F4-1). One part of MAX_NODES boxes on a
// path, its iterations cut to fit the budget, with a fixed box as large as
// the whole layout under all of them, so the sweeps keep moving boxes.
{
  const nodes = pts(MAX_NODES, 60, 60);
  nodes[0] = { id: "v0", w: 4e5, h: 4e5, fixed: { x: -2e5, y: -2e5 } };
  const edges = Array.from({ length: MAX_NODES - 1 }, (_, i) => ["v" + i, "v" + (i + 1)]);
  springWork.pairs = springWork.sweeps = 0;
  const t = Date.now();
  const pos = springLayout(nodes, edges, { seed: 3, iterations: 1000 });
  const ms = Date.now() - t;
  console.log(`  forced: ${springWork.pairs} pair evaluations, ${springWork.sweeps} sweeps, ${ms} ms`);
  check(springWork.pairs <= WORK, `forced sweeps: ${springWork.pairs} pair evaluations, within WORK`);
  check(pos !== null && gapViolations(nodes, pos, 24).length === 0, "forced sweeps: still no two boxes closer than the gap");
}
// ... and with the links' forces counted (HARD-7C9-1): daybreak2's
// envelope, 550 boxes and MAX_EDGES links, iterations 1000 asked (cut to
// 870 by the budget), a fixed box under them as above
{
  const n = 550;
  const nodes = pts(n, 60, 60);
  nodes[0] = { id: "v0", w: 4e5, h: 4e5, fixed: { x: -2e5, y: -2e5 } };
  const edges = Array.from({ length: MAX_EDGES }, (_, k) => k < n - 1 ? ["v" + k, "v" + (k + 1)] : ["v" + (k % n), "v" + ((k * 7 + 3) % n)]);
  springWork.pairs = springWork.sweeps = 0;
  const pos = springLayout(nodes, edges, { seed: 3, iterations: 1000 });
  console.log(`  forced, ${MAX_EDGES} links: ${springWork.pairs} pair evaluations and link forces, ${springWork.sweeps} sweeps`);
  check(springWork.pairs <= WORK, `forced sweeps, ${MAX_EDGES} links: ${springWork.pairs} evaluations, within WORK`);
  check(pos !== null && gapViolations(nodes, pos, 24).length === 0, `forced sweeps, ${MAX_EDGES} links: no two boxes closer than the gap`);
}
// length: the edge-to-edge distance the forces aim at, in place of the
// mean size plus gap (the board's request): big notes on a cycle sit much
// closer with a short length; without it nothing changes; out of
// [MIN_LENGTH, MAX_LENGTH] or not a number, refused
{
  const notes = pts(8, 200, 120), ring = Array.from({ length: 8 }, (_, i) => ["v" + i, "v" + ((i + 1) % 8)]);
  const gapOf = (pos) => {
    const d = ring.map(([a, b]) => { const p = pos.get(a), q = pos.get(b); return Math.max(Math.abs(p.x - q.x) - 200, Math.abs(p.y - q.y) - 120); });
    return d.reduce((s, x) => s + x, 0) / d.length;
  };
  const wide = springLayout(notes, ring, { seed: 1 }), close = springLayout(notes, ring, { seed: 1, length: 36 });
  check(close !== null && gapOf(close) < gapOf(wide) / 2, `length 36: linked notes closer (mean edge gap ${gapOf(close).toFixed(0)} px, ${gapOf(wide).toFixed(0)} without)`);
  check(close !== null && gapViolations(notes, close, 24).length === 0, "length 36: still none closer than the gap");
  check(JSON.stringify([...springLayout(notes, ring, { seed: 1, length: undefined })]) === JSON.stringify([...wide]), "length undefined: the layout without it");
  for (const bad of [0, MIN_LENGTH - 0.5, -1, NaN, Infinity, MAX_LENGTH * 2, "36"])
    check(springLayout(notes, ring, { seed: 1, length: bad }) === null, `length ${String(bad)}: refused (null)`);
}
check(springLayout([], [], { seed: 1 }).size === 0, "no nodes: an empty layout");
// huge iterations, many parts: bounded (HARD-828-1)
{
  let t = Date.now();
  check(springLayout(pts(1, 10, 10), [], { seed: 1, iterations: 1e12 }).size === 1, "one node, iterations 1e12: laid out");
  check(Date.now() - t < 2000, `one node, iterations 1e12: at once (${Date.now() - t} ms)`);
  t = Date.now();
  const lone = springLayout(pts(MAX_NODES, 8, 8), [], { seed: 1, iterations: 1e12 });
  check(lone !== null && lone.size === MAX_NODES && overlap(pts(MAX_NODES, 8, 8), lone) === null, "MAX_NODES lone nodes: packed, no overlap");
  check(Date.now() - t < 30000, `MAX_NODES lone nodes: bounded (${Date.now() - t} ms)`);
  const [nodes, edges] = GRAPHS.cycle;
  t = Date.now();
  const frames = [...springSteps(nodes, edges, { seed: 1, iterations: 1e12 }, 1)];
  check(frames.length <= MAX_FRAMES + 1, `springSteps yields at most MAX_FRAMES + 1 snapshots (${frames.length})`);
  check(Date.now() - t < 10000, `springSteps with iterations 1e12: bounded (${Date.now() - t} ms)`);
  const pairs = pts(400, 4, 4), pe = Array.from({ length: 200 }, (_, i) => ["v" + 2 * i, "v" + (2 * i + 1)]);
  t = Date.now();
  check(springLayout(pairs, pe, { seed: 1, iterations: 1e12 }) !== null, "200 two-node parts, iterations 1e12: laid out");
  check(Date.now() - t < 30000, `200 two-node parts: bounded (${Date.now() - t} ms)`);
}
check(springLayout(pts(1, 10, 10), [["v0", "v0"], ["v0", "nobody"]], { seed: 1 }).size === 1, "a loop and an unknown end are ignored");

// every frame of the animation places each node once, and the connected
// parts side by side, never drawn over each other (William's X3: two parts
// iterated in the same place looked like one graph drawn twice until the
// last frame)
{
  const house = (o) => [[0, 1], [1, 2], [2, 0], [2, 3], [3, 4], [4, 0]].map(([a, b]) => ["v" + (a + o), "v" + (b + o)]);
  const pinnedOne = pts(10).map((n, i) => (i === 0 ? { ...n, fixed: { x: 40, y: -30 } } : n));
  const cases = {
    "two houses": [pts(10), [...house(0), ...house(5)]],
    parts: GRAPHS.parts,
    "pairs and a triangle": [pts(9, 20, 20), [["v0", "v1"], ["v2", "v3"], ["v4", "v5"], ["v6", "v7"], ["v7", "v8"], ["v8", "v6"]]],
    // (python's note: a part with a fixed node; the free parts go below it)
    "two houses, one with a fixed node": [pinnedOne, [...house(0), ...house(5)]],
  };
  for (const [name, [nodes, edges]] of Object.entries(cases)) {
    // (the parts: union-find over the edges)
    const up = new Map(nodes.map((n) => [n.id, n.id]));
    const find = (x) => { while (up.get(x) !== x) x = up.get(x); return x; };
    for (const [a, b] of edges) up.set(find(a), find(b));
    const partOf = new Map(nodes.map((n) => [n.id, find(n.id)]));
    const frames = [...springSteps(nodes, edges, { seed: 3 }, 1)];
    let counted = true, apart = true, where = "", rowsKept = true, rowsWhere = "";
    const pinnedParts = new Set(nodes.filter((n) => n.fixed).map((n) => partOf.get(n.id)));
    let rows0 = null;
    frames.forEach((f, k) => {
      if (f.size !== nodes.length || nodes.some((n) => !f.has(n.id))) counted = false;
      const bb = new Map();
      for (const n of nodes) {
        const p = f.get(n.id), r = partOf.get(n.id), b = bb.get(r) ?? [Infinity, Infinity, -Infinity, -Infinity];
        bb.set(r, [Math.min(b[0], p.x), Math.min(b[1], p.y), Math.max(b[2], p.x + n.w), Math.max(b[3], p.y + n.h)]);
      }
      const boxes = [...bb.values()];
      for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
        const [a, b] = [boxes[i], boxes[j]];
        if (a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3] && apart) { apart = false; where = `frame ${k} of ${frames.length}`; }
      }
      // (the free parts' rows: parts of a row share their box's top; the
      // rows, and each row's order left to right, kept until the last frame)
      if (k < frames.length - 1) {
        const free = [...bb.entries()].filter(([r]) => !pinnedParts.has(r)).sort((a, b) => a[1][1] - b[1][1] || a[1][0] - b[1][0]);
        const rows = [];
        for (const [r, b] of free) {
          const last = rows.at(-1);
          if (last && Math.abs(last.top - b[1]) < 1e-3) last.parts.push(r);
          else rows.push({ top: b[1], parts: [r] });
        }
        const shape = JSON.stringify(rows.map((x) => x.parts));
        if (rows0 === null) rows0 = shape;
        else if (shape !== rows0 && rowsKept) { rowsKept = false; rowsWhere = `frame ${k}: ${shape} after ${rows0}`; }
      }
    });
    check(counted, `${name}: every frame places each node exactly once`);
    check(apart, `${name}: in every frame the parts' boxes are apart (${where})`);
    check(rowsKept, `${name}: no part changes row, nor its place in it, before the last frame (${rowsWhere})`);
  }
}

// the animation's packing slides, never jumps (astra2's review of #240):
// two parts of 100 x h; between h = 148.22 and 148.23 the packing's own row
// break moves the second part to the other row, but with the rows kept, as
// the animation keeps them, its offset moves by about the 0.01 of growth, in
// both directions
{
  const free = (h) => [0, 1].map(() => ({ boxes: 2, bb: { x0: 0, y0: 0, x1: 100, y1: h } }));
  const bbs = (h) => free(h).map((f) => f.bb);
  const [lo, hi] = [148.22, 148.23];
  check(JSON.stringify(packRows(free(lo), 24)) !== JSON.stringify(packRows(free(hi), 24)), `the control crosses the packing's row break (${JSON.stringify(packRows(free(lo), 24))} vs ${JSON.stringify(packRows(free(hi), 24))})`);
  for (const [from, to] of [[lo, hi], [hi, lo]]) {
    const rows = packRows(free(from), 24);
    const a = placeRows(bbs(from), rows, 24, null), b = placeRows(bbs(to), rows, 24, null);
    const jump = Math.max(...a.flatMap((p, i) => [Math.abs(p[0] - b[i][0]), Math.abs(p[1] - b[i][1])]));
    check(jump <= Math.abs(to - from) + 1e-9, `h ${from} -> ${to} with ${from}'s rows: each part moves by at most the growth (${jump.toFixed(4)})`);
  }
}

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

// never a layout with two boxes closer than gap (CORR-828-1): astra's two
// cases (web/graph/spring-cases.json), and many random graphs, with fixed
// boxes, mixed sizes and seeds; checked strictly, after rounding
const strict = (nodes, pos, gap) => {
  for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
    const a = nodes[i], b = nodes[j];
    if (a.fixed && b.fixed) continue;
    const p = pos.get(a.id), q = pos.get(b.id);
    if (p.x < q.x + b.w + gap && q.x < p.x + a.w + gap && p.y < q.y + b.h + gap && q.y < p.y + a.h + gap) return [a.id, b.id];
  }
  return null;
};
const CASES = JSON.parse(readFileSync(new URL("./spring-cases.json", import.meta.url), "utf8"));
for (const c of CASES) {
  const pos = springLayout(c.nodes, c.edges, c.opts);
  check(pos !== null && strict(c.nodes, pos, c.opts.gap ?? 24) === null, `${c.label}: no two boxes closer than the gap`);
  check(pos !== null && c.nodes.every((n) => !n.fixed || (pos.get(n.id).x === n.fixed.x && pos.get(n.id).y === n.fixed.y)), `${c.label}: fixed boxes exactly where given`);
}
{
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  let bad = 0, refused = 0, runs = 0;
  for (let t = 0; t < 300; t++) {
    const n = 2 + Math.floor(rnd() * 40);
    const nodes = Array.from({ length: n }, (_, i) => ({ id: "n" + i, w: Math.floor(rnd() * 160), h: Math.floor(rnd() * 120) }));
    // (fixed boxes well apart, so that the promise can be kept)
    for (let i = 0; i < n; i++) if (rnd() < 0.15) nodes[i].fixed = { x: i * 400, y: Math.floor(rnd() * 3) * 400 + 0.123456789 };
    const edges = [];
    for (let k = 0; k < n * 1.5; k++) edges.push(["n" + Math.floor(rnd() * n), "n" + Math.floor(rnd() * n)]);
    const gap = [0, 8, 24, 40][Math.floor(rnd() * 4)];
    const pos = springLayout(nodes, edges, { seed: Math.floor(rnd() * 1e9), iterations: [10, 50, 300][Math.floor(rnd() * 3)], gap });
    runs++;
    if (pos === null) { refused++; continue; }
    if (strict(nodes, pos, gap) !== null || gapViolations(nodes, pos, gap).length) bad++;
    if (nodes.some((nd) => nd.fixed && (pos.get(nd.id).x !== nd.fixed.x || pos.get(nd.id).y !== nd.fixed.y))) bad++;
  }
  check(bad === 0 && refused === 0, `300 random graphs: none closer than the gap, fixed boxes exact, none refused (${bad} bad, ${refused} refused)`);
}

// the same in Python (lib/_graph_spring.py, which Graph.plot uses): under
// CPython and under Sagebrush's own runtime (dist/, when built)
{
  const root = new URL("../..", import.meta.url).pathname;
  const cases = Object.entries(GRAPHS).map(([name, [nodes, edges]]) => [name, nodes, edges]);
  const fixedCase = pts(12, 40, 30);
  fixedCase[0].fixed = { x: 100, y: 50 };
  cases.push(["fixed", fixedCase, Array.from({ length: 11 }, (_, i) => ["v" + i, "v" + (i + 1)])]);
  cases.push(["lone", pts(6, 10, 10), [["v0", "v1"]]]);
  for (const c of CASES) cases.push([c.label, c.nodes, c.edges, c.opts]);
  cases.push(["length", pts(8, 200, 120), Array.from({ length: 8 }, (_, i) => ["v" + i, "v" + ((i + 1) % 8)]), { seed: 1, length: 36 }]);
  const want = cases.map(([, nodes, edges, opts]) => Object.fromEntries([...springLayout(nodes, edges, opts ?? { seed: 5 })].map(([k, v]) => [k, [v.x, v.y]])));
  const py = [
    "import json, sys",
    "sys.path.insert(0, sys.argv[1] + '/lib')",
    "import _graph_spring as g",
    "cases = json.loads(sys.stdin.read())",
    "out = []",
    "for case in cases:",
    "    name, nodes, edges = case[:3]",
    "    opts = case[3] if len(case) > 3 and case[3] else {'seed': 5}",
    "    ns = [(n['id'], n['w'], n['h'], (n['fixed']['x'], n['fixed']['y']) if n.get('fixed') else None) for n in nodes]",
    "    out.append({k: list(v) for k, v in g.spring_layout(ns, [tuple(e) for e in edges], opts['seed'], opts.get('iterations'), opts.get('gap', 24), opts.get('length')).items()})",
    "print(json.dumps(out))",
  ].join("\n");
  const input = JSON.stringify(cases);
  const runs = [["CPython", "python3", ["-c", py, root]]];
  if (existsSync(root + "dist/src/cli.js")) runs.push(["Sagebrush", "node", [root + "dist/src/cli.js", "-c", py, root]]);
  for (const [label, cmd, args] of runs) {
    let got = null;
    try {
      got = JSON.parse(execFileSync(cmd, args, { input, encoding: "utf8", timeout: 300000 }));
    } catch (e) {
      got = String(e.message).slice(0, 300);
    }
    cases.forEach(([name], i) => check(JSON.stringify(got?.[i]) === JSON.stringify(want[i]), `Python under ${label} gives spring.ts's layout of ${name}${typeof got === "string" ? ": " + got : ""}`));
  }
}

console.log(`${checks - fails.length}/${checks} checks passed`);
for (const f of fails) console.log("FAIL " + f);
process.exit(fails.length ? 1 : 0);
