// How long the Worker spends rendering each stored page (KaTeX included):
//   node web/atlas/render-cost.mjs      (after scripts/build-atlas.mjs)
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { orbitBody, spaceBody, page } from "./render.ts";

const data = join(import.meta.dirname, "..", "dist", "atlas", "data", "mf");
const rows = [];
for (const k of readdirSync(data))
  for (const f of readdirSync(join(data, k))) {
    const sp = JSON.parse(readFileSync(join(data, k, f), "utf8"));
    let t = performance.now();
    const html = page({ title: sp.label, description: "", path: "/", crumbs: [], body: spaceBody(sp) });
    rows.push([performance.now() - t, sp.label, html.length]);
    for (const o of sp.newforms) {
      t = performance.now();
      const h = page({ title: o.label, description: "", path: "/", crumbs: [], body: orbitBody(sp, o) });
      rows.push([performance.now() - t, o.label, h.length]);
    }
  }
rows.sort((a, b) => b[0] - a[0]);
const q = (x) => rows[Math.floor(rows.length * x)][0].toFixed(2);
console.log(`${rows.length} pages; render ms: median ${q(0.5)}, 90% ${q(0.1)}, 99% ${q(0.01)}, max ${rows[0][0].toFixed(1)}`);
console.log("slowest:", rows.slice(0, 6).map(([t, l, b]) => `${l} ${t.toFixed(1)} ms ${(b / 1024) | 0} KB`).join("; "));
console.log("largest:", rows.sort((a, b) => b[2] - a[2]).slice(0, 4).map(([t, l, b]) => `${l} ${(b / 1024) | 0} KB`).join("; "));
