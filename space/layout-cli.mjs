// Lay a space out once and keep it: writes each node's "position" (3D) and "position2d" (the same, on a plane) into
// the file, so the space looks the same at every visit and whoever reads it builds a memory of where things are.
// A node that already has a position keeps it; a new one is placed by its links, its group, and its "near" (another
// node's id), around what is there.
//   node layout-cli.mjs FILE.space.json [--again]     (--again: forget every position and lay out afresh)
import { readFileSync, writeFileSync } from "node:fs";
import { layout } from "./src/layout.js";

const [file, flag] = process.argv.slice(2);
const space = JSON.parse(readFileSync(file, "utf8"));
const nodes = space.nodes;
if (flag === "--again") for (const n of nodes) (delete n.position, delete n.position2d);
const spacing = nodes.length > 60 ? 5 : 9;
const round = (v) => Math.round(v * 100) / 100;
const t0 = Date.now();
const P3 = layout(nodes, space.edges ?? [], { dims: 3, spacing });
// (the plane: its own run, from the nodes' own 2D positions where they have them)
const flat = nodes.map((n) => ({ ...n, position: n.position2d }));
const P2 = layout(flat, space.edges ?? [], { dims: 2, spacing });
nodes.forEach((n, i) => {
  n.position = [round(P3[3 * i]), round(P3[3 * i + 1]), round(P3[3 * i + 2])];
  n.position2d = [round(P2[3 * i]), round(P2[3 * i + 1])];
});
writeFileSync(file, JSON.stringify(space) + "\n");
console.log(file + ":", nodes.length, "nodes laid out in", Date.now() - t0, "ms");
