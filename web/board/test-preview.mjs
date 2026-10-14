// preview.ts (design/outputs.md, section 1): a slow item's preview is
// bounded (text cut to its head and tail, one picture, never SVG, HTML or
// scripts), read back only when well formed, and a board over its total
// drops the previews closest to the line first.   bun web/board/test-preview.mjs
import { CELL_MAX, DOC_MAX, cleanPreview, cut, makePreview, overCap, previewLabel, sameOutputs } from "./preview.ts";
import { cleanDoc, canonical } from "./doc.ts";

let checks = 0;
const fails = [];
const check = (ok, what) => { checks++; if (!ok) fails.push(what); };
const at = "2026-10-13T12:00:00.000Z";
const raster = async (src, w) => (src.startsWith("data:image/svg+xml") ? ["image/webp", "UklGRg=="] : ["image/png", "iVBORw0KGgo="]);

// text: head and tail, saying how many lines were left out
const long = Array.from({ length: 5000 }, (_, i) => `line ${i}`).join("\n");
const c = cut(long);
check(c.length < 4096 + 1024 + 64 && c.startsWith("line 0\n") && c.endsWith("line 4999") && /… \d+ lines …/.test(c), "a long text is cut to its head and tail: " + c.length);
check(cut("short") === "short", "a short text is kept");

const p = await makePreview([
  { output_type: "stream", name: "stdout", text: long },
  { output_type: "display_data", data: { "image/svg+xml": "<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>", "text/plain": "a figure" }, metadata: {} },
  { output_type: "display_data", data: { "image/png": "iVBORw0KGgoAAAA=", "text/plain": "a second figure" }, metadata: {} },
  { output_type: "display_data", data: { "text/html": "<img src=x onerror=alert(1)>", "text/plain": "a table" }, metadata: {} },
  { output_type: "display_data", data: { "application/vnd.sagebrush.scene3d+json": "{}", "image/png": "iVBORw0KGgo=" }, metadata: {} },
], { at, ms: 12345.6, total: 23456.7 }, raster);
const text = JSON.stringify(p);
check(p && p.ms === 12346 && p.total === 23457 && p.at === at, "when, and how long: " + JSON.stringify(p && [p.at, p.ms, p.total]));
check(p.outputs[0].text.length < 6000, "the stream is cut");
check(p.outputs[1].data["image/webp"] === "UklGRg==" && !text.includes("svg") && !text.includes("<script"), "an SVG picture is drawn again (WebP), never kept as SVG");
check(!p.outputs[2].data["image/png"] && p.outputs[2].data["text/plain"] === "a second figure", "one picture a preview: the second keeps its text");
check(!text.includes("text/html") && !text.includes("onerror") && p.outputs[3].data["text/plain"] === "a table", "no HTML: its text instead");
check(!text.includes("scene3d"), "no 3D scene");
check(JSON.stringify(p.outputs).length <= CELL_MAX, "at most CELL_MAX");
check((await makePreview([], { at, ms: 1, total: 1 }, raster)) === null, "no output: no preview");
const huge = await makePreview(Array.from({ length: 40 }, (_, i) => ({ output_type: "display_data", data: { "text/plain": "x".repeat(3000) + i }, metadata: {} })), { at, ms: 1, total: 1 }, raster);
check(huge && JSON.stringify(huge.outputs).length <= CELL_MAX && huge.outputs.length < 40, "many outputs: the last go, to fit");

// reading one back: only as written
check(JSON.stringify(cleanPreview(p)) === JSON.stringify(p), "a preview reads back as it was");
const bad = [
  { ...p, at: "yesterday" },
  { ...p, ms: -1 },
  { ...p, outputs: [{ output_type: "display_data", data: { "text/html": "<b>x</b>" }, metadata: {} }] },
  { ...p, outputs: [{ output_type: "display_data", data: { "image/png": "not base64!<script>" }, metadata: {} }] },
  { ...p, outputs: [{ output_type: "execute_result", data: { "text/plain": "1" } }] },
  { ...p, outputs: [{ output_type: "stream", name: "stdout", text: "x".repeat(CELL_MAX + 1) }] },
  "a string", null,
];
check(bad.every((b) => cleanPreview(b) === undefined), "a malformed or unbounded preview is dropped: " + bad.map((b) => !!cleanPreview(b)).join());
const mixed = cleanPreview({ ...p, outputs: [{ output_type: "display_data", data: { "text/plain": "ok", "text/html": "<i>x</i>", "image/svg+xml": "<svg/>" }, metadata: {} }] });
check(mixed && Object.keys(mixed.outputs[0].data).join() === "text/plain", "only text and raster pictures are read");

// in a board's file: on code notes only, last in the node
const doc = cleanDoc({ nodes: [{ id: "a", code: "x = 1", preview: p, x: 1, y: 2 }, { id: "b", text: "no code", preview: p }] });
check(doc.nodes[0].preview && !doc.nodes[1].preview, "a preview is kept on a code note only");
const file = canonical(doc);
check(Object.keys(JSON.parse(file).nodes[0]).at(-1) === "preview" && canonical(JSON.parse(file)) === file, "last in its node, and the file reads back the same");

// a board's total: those closest to the line go first
const sized = (total, n) => ({ at, ms: 1, total, outputs: [{ output_type: "stream", name: "stdout", text: "x".repeat(n) }] });
const many = new Map([["a", sized(50_000, 30_000)], ...Array.from({ length: 20 }, (_, i) => [`n${i}`, sized(11_000 + i, 30_000)])]);
const drop = overCap(many);
let left = 0;
for (const [id, v] of many) if (!drop.includes(id)) left += JSON.stringify(v).length;
check(drop.length > 0 && left <= DOC_MAX && !drop.includes("a") && drop[0] === "n0", "over the board's total: the fastest go first: " + drop.slice(0, 3));
check(overCap(new Map([["a", sized(1, 10)]])).length === 0, "under it: none");
check(sameOutputs(p, { ...p, at: "2026-10-14T00:00:00.000Z", ms: 1 }) && !sameOutputs(p, huge), "the same outputs, whenever computed");
check(/^Preview, computed .+ \(23 s\)\. Run to update\.$/.test(previewLabel(p)), "its label: " + previewLabel(p));

if (fails.length) {
  console.log(`${fails.length} of ${checks} checks failed:\n  ` + fails.join("\n  "));
  process.exit(1);
}
console.log(`${checks}/${checks} checks passed`);
