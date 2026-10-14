// preview.ts (design/outputs.md, section 1): a slow item's preview is
// bounded (text cut to its head and tail, one picture, never SVG, HTML or
// scripts), read back only when well formed, and a board over its total
// drops the previews closest to the line first.   bun web/board/test-preview.mjs
import { CELL_MAX, DOC_MAX, bytes, cleanPreview, cut, imageSize, makePreview, overCap, previewLabel, sameOutputs } from "./preview.ts";
import { cleanDoc, canonical } from "./doc.ts";

let checks = 0;
const fails = [];
const check = (ok, what) => { checks++; if (!ok) fails.push(what); };
const at = "2026-10-13T12:00:00.000Z";
// pictures' headers, as they are written (a few bytes say how big they are)
const b64 = (bytes) => Buffer.from(bytes).toString("base64");
const be32 = (v) => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
const le24 = (v) => [v & 255, (v >> 8) & 255, (v >> 16) & 255];
const png = (w, h) => b64([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, ...be32(w), ...be32(h), 8, 2, 0, 0, 0, 0, 0, 0, 0]);
const webp = (w, h) => b64([...Buffer.from("RIFF"), 0, 0, 0, 0, ...Buffer.from("WEBPVP8X"), 10, 0, 0, 0, 0, 0, 0, 0, ...le24(w - 1), ...le24(h - 1)]);
const jpeg = (w, h) => b64([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, h >> 8, h & 255, w >> 8, w & 255, 3, 0, 0, 0]);
const raster = async (src, w) => (src.startsWith("data:image/svg+xml") ? ["image/webp", webp(640, 400)] : ["image/png", png(320, 200)]);

// text: head and tail, saying how many lines were left out
const long = Array.from({ length: 5000 }, (_, i) => `line ${i}`).join("\n");
const c = cut(long);
check(c.length < 4096 + 1024 + 64 && c.startsWith("line 0\n") && c.endsWith("line 4999") && /… \d+ lines …/.test(c), "a long text is cut to its head and tail: " + c.length);
check(cut("short") === "short", "a short text is kept");

const p = await makePreview([
  { output_type: "stream", name: "stdout", text: long },
  { output_type: "display_data", data: { "image/svg+xml": "<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>", "text/plain": "a figure" }, metadata: {} },
  { output_type: "display_data", data: { "image/png": png(10, 10), "text/plain": "a second figure" }, metadata: {} },
  { output_type: "display_data", data: { "text/html": "<img src=x onerror=alert(1)>", "text/plain": "a table" }, metadata: {} },
  { output_type: "display_data", data: { "application/vnd.sagebrush.scene3d+json": "{}", "image/png": png(10, 10) }, metadata: {} },
], { at, ms: 12345.6, total: 23456.7 }, raster);
const text = JSON.stringify(p);
check(p && p.ms === 12346 && p.total === 23457 && p.at === at, "when, and how long: " + JSON.stringify(p && [p.at, p.ms, p.total]));
check(p.outputs[0].text.length < 6000, "the stream is cut");
check(p.outputs[1].data["image/webp"] === webp(640, 400) && !text.includes("svg") && !text.includes("<script"), "an SVG picture is drawn again (WebP), never kept as SVG");
check(!p.outputs[2].data["image/png"] && p.outputs[2].data["text/plain"] === "a second figure", "one picture a preview: the second keeps its text");
const small = await makePreview([{ output_type: "display_data", data: { "image/png": png(100, 100) }, metadata: {} }], { at, ms: 1, total: 1 }, async (src, w) => (w === 640 ? ["image/webp", webp(100, 100)] : null));
check(small?.outputs[0].data["image/webp"] === webp(100, 100), "a picture, however small, is drawn again at most 640 wide");
const tooTall = await makePreview([{ output_type: "display_data", data: { "image/png": png(10, 10), "text/plain": "tall" }, metadata: {} }], { at, ms: 1, total: 1 }, async () => ["image/png", png(640, 5000)]);
check(tooTall && !tooTall.outputs[0].data["image/png"] && tooTall.outputs[0].data["text/plain"] === "tall", "a picture drawn too big is not kept");
// a picture's size from its header; a small file saying it is huge is refused (SEC-B00-1)
check(JSON.stringify([imageSize("image/png", png(8192, 8192)), imageSize("image/webp", webp(641, 2)), imageSize("image/jpeg", jpeg(300, 1300))]) === '[{"w":8192,"h":8192},{"w":641,"h":2},{"w":300,"h":1300}]', "sizes from PNG, WebP and JPEG headers");
check(imageSize("image/png", "iVBORw0KGgo=") === null && imageSize("image/jpeg", b64([0xff, 0xd8])) === null && imageSize("image/webp", "UklGRg==") === null, "a header that can't be read: no size");
const sizes = [[png(640, 1280), true], [png(8192, 8192), false], [png(641, 10), false], [png(10, 1281), false], [webp(640, 400), true], [webp(100, 30000), false], [jpeg(300, 200), true], [jpeg(300, 1300), false], ["iVBORw0KGgo=", false]];
const types = (b) => (b.startsWith("iVBOR") ? "image/png" : b.startsWith("UklG") ? "image/webp" : "image/jpeg");
const read = sizes.map(([b, ok]) => !!cleanPreview({ at, ms: 1, total: 1, outputs: [{ output_type: "display_data", data: { [types(b)]: b, "text/plain": "x" }, metadata: {} }] })?.outputs[0].data[types(b)] === ok);
check(read.every(Boolean), "a file's picture is read only if its header says at most 640 by 1280: " + read.join());
check(!text.includes("text/html") && !text.includes("onerror") && p.outputs[3].data["text/plain"] === "a table", "no HTML: its text instead");
check(!text.includes("scene3d"), "no 3D scene");
check(JSON.stringify(p.outputs).length <= CELL_MAX, "at most CELL_MAX");
check((await makePreview([], { at, ms: 1, total: 1 }, raster)) === null, "no output: no preview");
const huge = await makePreview(Array.from({ length: 40 }, (_, i) => ({ output_type: "display_data", data: { "text/plain": "x".repeat(3000) + i }, metadata: {} })), { at, ms: 1, total: 1 }, raster);
check(huge && bytes(huge.outputs) <= CELL_MAX && huge.outputs.length < 40, "many outputs: the last go, to fit");

// reading one back: only as written
check(JSON.stringify(cleanPreview(p)) === JSON.stringify(p), "a preview reads back as it was");
const bad = [
  { ...p, at: "yesterday" },
  { ...p, ms: -1 },
  { ...p, outputs: [{ output_type: "display_data", data: { "text/html": "<b>x</b>" }, metadata: {} }] },
  { ...p, outputs: [{ output_type: "display_data", data: { "image/png": "not base64!<script>" }, metadata: {} }] },
  { ...p, outputs: [{ output_type: "execute_result", data: { "text/plain": "1" } }] },
  { ...p, outputs: Array.from({ length: 12 }, () => ({ output_type: "display_data", data: { "text/plain": "é".repeat(2000) }, metadata: {} })) },
  "a string", null,
];
check(bad.every((b) => cleanPreview(b) === undefined), "a malformed or unbounded preview is dropped: " + bad.map((b) => !!cleanPreview(b)).join());
const mixed = cleanPreview({ ...p, outputs: [{ output_type: "display_data", data: { "text/plain": "ok", "text/html": "<i>x</i>", "image/svg+xml": "<svg/>" }, metadata: {} }] });
check(mixed && Object.keys(mixed.outputs[0].data).join() === "text/plain", "only text and raster pictures are read");
// read back held to what is written: texts cut, one picture (SEC-14C-2)
const wide = cleanPreview({ ...p, outputs: [{ output_type: "stream", name: "stdout", text: "y".repeat(20000) }, { output_type: "display_data", data: { "image/png": png(20, 20) }, metadata: {} }, { output_type: "display_data", data: { "image/jpeg": jpeg(20, 20), "text/plain": "two" }, metadata: {} }] });
check(wide && wide.outputs[0].text.length < 6000 && wide.outputs[1].data["image/png"] && !wide.outputs[2].data["image/jpeg"] && wide.outputs[2].data["text/plain"] === "two", "a file's preview: its text cut, its second picture dropped: " + JSON.stringify(wide).length);
check(bytes("é") === 4 && bytes("e") === 3, "sizes are bytes of UTF-8");

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
// and a file over it: cleanDoc holds it to DOC_MAX, on every page and in groups
// (7 outputs of 4,000 characters: about 28 KB, under CELL_MAX, and not cut)
const fat = (total) => ({ at, ms: 1, total, outputs: Array.from({ length: 7 }, () => ({ output_type: "display_data", data: { "text/plain": "z".repeat(4000) }, metadata: {} })) });
const heavy = cleanDoc({ pages: [
  { nodes: [{ id: "a", code: "1", preview: fat(50_000) }, { id: "g", kind: "group", children: Array.from({ length: 9 }, (_, i) => ({ id: `g${i}`, code: "1", preview: fat(11_000 + i) })) }] },
  { nodes: Array.from({ length: 10 }, (_, i) => ({ id: `q${i}`, code: "1", preview: fat(12_000 + i) })) },
] });
const kept = [heavy.pages[0].nodes[0], ...heavy.pages[0].nodes[1].children, ...heavy.pages[1].nodes].filter((n) => n.preview);
check(kept.reduce((s, n) => s + bytes(n.preview), 0) <= DOC_MAX && heavy.pages[0].nodes[0].preview && !heavy.pages[0].nodes[1].children[0].preview && kept.length < 20, "a file over the board's total is held to it when read: " + kept.length);
check(overCap(new Map([["a", sized(1, 10)]])).length === 0, "under it: none");
check(sameOutputs(p, { ...p, at: "2026-10-14T00:00:00.000Z", ms: 1 }) && !sameOutputs(p, huge), "the same outputs, whenever computed");
check(/^Preview, computed .+ \(23 s\)\. Run to update\.$/.test(previewLabel(p)), "its label: " + previewLabel(p));

if (fails.length) {
  console.log(`${fails.length} of ${checks} checks failed:\n  ` + fails.join("\n  "));
  process.exit(1);
}
console.log(`${checks}/${checks} checks passed`);
