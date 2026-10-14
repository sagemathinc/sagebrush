// TimeTravel's versions of a large board (history.ts BoardHistory, on
// patchflow), quickly and exactly: the first version, the whole board, not
// quadratic in its records; an edit's version quick, an item removed too
// (every later item's place changes); every version the board as it was.
//   bun web/board/test-history-speed.mjs
import { BoardHistory } from "./history.ts";
import { PatchHistory, createImmerDbCodec } from "../notebook/patch-history.js";
import { canonical, cleanDoc } from "./doc.ts";

const fails = [];
let checks = 0;
const check = (ok, what) => { checks++; if (!ok) fails.push(what); };
// (patches kept in memory, as IdbPatchStore keeps them in IndexedDB)
const memStore = () => { const ps = []; return { loadInitial: async () => ({ patches: ps.slice(), hasMore: false }), append: (env) => { ps.push(env); }, subscribe: () => () => {}, onClear: () => () => {} }; };

let s = 3;
const rand = () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 4294967296);
const N = 1000, S = 3000;
const nodes = Array.from({ length: N }, (_, i) => ({ id: "b" + i, title: "Note " + i, text: "Some text " + i, x: (i % 40) * 320, y: Math.floor(i / 40) * 260, w: 280 }));
for (let i = 0; i < S; i++) { const pts = []; for (let j = 0; j < 12; j++) pts.push(Math.round(rand() * 100), Math.round(rand() * 100), 0.5); nodes.push({ id: "s" + i, kind: "ink", x: Math.round(rand() * 9000), y: Math.round(rand() * 6000), points: pts, size: 2 }); }
const doc0 = cleanDoc({ title: "Big", nodes, edges: [{ from: "b1", to: "b2" }] });

const h = await new BoardHistory({ PatchHistory, createImmerDbCodec }, memStore()).init();
let t0 = performance.now();
h.record(doc0);
const first = performance.now() - t0;
const docs = [doc0];
let d = doc0, edits = 0, slowest = 0;
t0 = performance.now();
for (let i = 0; i < 10; i++) {
  const te = performance.now();
  d = structuredClone(d);
  d.nodes[i * 7].x += 10;
  if (i === 4) d.nodes.push({ id: "new", title: "Added" });
  if (i === 7) d.nodes = d.nodes.filter((n) => n.id !== "s5");
  h.record(d);
  slowest = Math.max(slowest, performance.now() - te);
  docs.push(d);
  edits++;
}
const each = (performance.now() - t0) / edits;
console.log(`the first version (${N + S} items): ${first.toFixed(0)} ms; an edit's: ${each.toFixed(0)} ms, the slowest ${slowest.toFixed(0)} ms`);
check(first < 1500, `the first version of a board of ${N + S} items in under 1.5 s (not quadratic): ${first.toFixed(0)} ms`);
check(each < 600 && slowest < 5000, `an edit's version in under 600 ms on average, the slowest (an item removed: every later one's place changed) under 5 s: ${each.toFixed(0)} ms, ${slowest.toFixed(0)} ms`);
const vs = h.versions();
check(vs.length === docs.length, `a version for each: ${vs.length} of ${docs.length}`);
const same = vs.every((v, i) => canonical(cleanDoc(h.docAt(v.time))) === canonical(cleanDoc(docs[i])));
check(same, "every version is the board as it was");
check(h.record(d) === null, "the same board again: no version");

console.log(`${checks - fails.length}/${checks} checks passed`);
for (const f of fails) console.log("FAIL", f);
process.exit(fails.length ? 1 : 0);
