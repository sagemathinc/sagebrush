// bench/latex/tikz/run.mjs: the LaTeX preview's TikZ pictures (web/latex/engine/tikz.mjs) against TikZ itself, on the
// pictures of pictures.json. By hand or nightly, not in a PR's CI.
//   - TeX: every picture a page of one standalone document (border 0, so a page is the picture's bounding box), by
//     pdflatex, its box written to the log, its page rastered by pdftoppm at 300 dpi in gray;
//   - the preview: renderTikz's picture alone in a page of a headless Chrome at the same scale, screenshot, cropped to
//     its box.
// Compared: the box's size (within 3% each way) and the ink (any pixel visibly not white: darker than BG_INK) as an
// IoU, raw and after widening both by WIDEN px, 0.24 pt (where two rasterizers put a thin stroke's antialiased edge, or
// how dark they make it, isn't the drawing's error: pdftoppm draws a 0.4 pt line solid, Chrome spreads it); a picture
// passes if its box does and its widened IoU is at least its `iou` in pictures.json (IOU_MIN without one).
// Writes results.json and table.md.
//   node bench/latex/tikz/run.mjs [--only T01,T02] [--out DIR] [--keep]   (CHROME, default chromium; pdflatex, pdftoppm)
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import katex from "katex";
import { renderTikz } from "../../../web/latex/engine/tikz.mjs";
import { setKatex, tikzLabel } from "../../../web/latex/engine/render.mjs";
setKatex(katex.renderToString, katex.__renderToHTMLTree);
// (KaTeX's stylesheet and fonts, for the nodes' text in the preview's page)
const KATEX_CSS = "file://" + fileURLToPath(import.meta.resolve("katex/dist/katex.min.css"));

const here = new URL(".", import.meta.url).pathname;
const arg = (name, dflt) => { const i = process.argv.indexOf("--" + name); return i > 0 ? process.argv[i + 1] : dflt; };
const all = JSON.parse(readFileSync(arg("pictures", join(here, "pictures.json")), "utf8")).pictures;
const only = arg("only", null)?.split(",");
const pictures = only ? all.filter((p) => only.includes(p.id)) : all;
const OUT = arg("out", join(here, "..", "results", new Date().toISOString().slice(0, 10) + "-tikz"));
const CHROME = process.env.CHROME ?? "chromium";
const DPI = 300, PX = DPI / 72.27, BG_INK = 240, WIDEN = 2, IOU_MIN = 0.8, BOX_TOL = 0.03;
const work = mkdtempSync(join(tmpdir(), "sb-tikz-bench-"));
function fail(why) { console.error("run.mjs: " + why); process.exit(2); }

// ---- TeX: one document, a page and a logged box per picture
const tex = ["\\documentclass[tikz,border=0pt]{standalone}", "\\usetikzlibrary{arrows.meta,calc,positioning}",
  "\\newcommand\\bb[2]{\\begin{tikzpicture}#2\\pgfextractx{\\dimen0}{\\pgfpointanchor{current bounding box}{south west}}" +
  "\\pgfextracty{\\dimen2}{\\pgfpointanchor{current bounding box}{south west}}\\pgfextractx{\\dimen4}{\\pgfpointanchor{current bounding box}{north east}}" +
  "\\pgfextracty{\\dimen6}{\\pgfpointanchor{current bounding box}{north east}}\\immediate\\write16{BBOX #1 \\the\\dimen0\\space\\the\\dimen2\\space\\the\\dimen4\\space\\the\\dimen6}\\end{tikzpicture}}",
  "\\begin{document}", ...pictures.map((p) => "\\bb{" + p.id + "}{" + p.src + "}"), "\\end{document}", ""].join("\n");
writeFileSync(join(work, "pics.tex"), tex);
const t0 = Date.now();
const pdf = spawnSync("pdflatex", ["-interaction=nonstopmode", "-halt-on-error", "pics.tex"], { cwd: work, encoding: "utf8" });
if (pdf.status !== 0) fail("pdflatex failed:\n" + pdf.stdout.slice(-2000));
const texMs = Date.now() - t0;
const texBox = {};
for (const m of readFileSync(join(work, "pics.log"), "utf8").matchAll(/^BBOX (\S+) (-?[\d.]+)pt(-?[\d.]+)pt(-?[\d.]+)pt(-?[\d.]+)pt/gm)) texBox[m[1]] = m.slice(2, 6).map(Number);
const rp = spawnSync("pdftoppm", ["-r", String(DPI), "-gray", "pics.pdf", "page"], { cwd: work, encoding: "utf8" });
if (rp.status !== 0) fail("pdftoppm failed: " + rp.stderr);
const pages = readdirSync(work).filter((f) => /^page-\d+\.pgm$/.test(f)).sort((a, b) => parseInt(a.slice(5)) - parseInt(b.slice(5)));
if (pages.length !== pictures.length) fail(`${pages.length} pages for ${pictures.length} pictures`);

// ---- images as {w, h, g} (gray 0..255)
function readPgm(file) {
  const b = readFileSync(file);
  let i = 0; const tok = () => { while (/\s/.test(String.fromCharCode(b[i]))) i++; const s = i; while (!/\s/.test(String.fromCharCode(b[i]))) i++; return b.toString("latin1", s, i); };
  if (tok() !== "P5") fail("not a binary PGM: " + file);
  const w = +tok(), h = +tok(), max = +tok(); i++;
  if (max !== 255) fail("a PGM not of 8 bits: " + file);
  return { w, h, g: b.subarray(i, i + w * h) };
}
// (Chrome's screenshots: 8-bit RGB or RGBA, not interlaced)
function readPng(file) {
  const b = readFileSync(file);
  let p = 8, w, h, type, idat = [];
  while (p < b.length) {
    const len = b.readUInt32BE(p), kind = b.toString("latin1", p + 4, p + 8), d = b.subarray(p + 8, p + 8 + len);
    if (kind === "IHDR") { w = d.readUInt32BE(0); h = d.readUInt32BE(4); type = d[9]; if (d[8] !== 8 || d[12] !== 0 || (type !== 2 && type !== 6)) fail("a PNG this reader doesn't read: " + file); }
    else if (kind === "IDAT") idat.push(d);
    p += 12 + len;
  }
  const bpp = type === 6 ? 4 : 3, row = w * bpp, raw = inflateSync(Buffer.concat(idat)), px = Buffer.alloc(row * h);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (row + 1)], src = raw.subarray(y * (row + 1) + 1, (y + 1) * (row + 1)), out = px.subarray(y * row, (y + 1) * row), up = y ? px.subarray((y - 1) * row, y * row) : null;
    for (let x = 0; x < row; x++) {
      const a = x >= bpp ? out[x - bpp] : 0, u = up ? up[x] : 0, c = up && x >= bpp ? up[x - bpp] : 0;
      let v = src[x];
      if (f === 1) v += a; else if (f === 2) v += u; else if (f === 3) v += (a + u) >> 1;
      else if (f === 4) { const q = a + u - c, pa = Math.abs(q - a), pb = Math.abs(q - u), pc = Math.abs(q - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? u : c; }
      out[x] = v & 255;
    }
  }
  const g = Buffer.alloc(w * h);
  for (let k = 0; k < w * h; k++) g[k] = Math.round(0.299 * px[k * bpp] + 0.587 * px[k * bpp + 1] + 0.114 * px[k * bpp + 2]);
  return { w, h, g };
}
const mask = (im, w, h) => { const m = new Uint8Array(w * h); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) m[y * w + x] = im.g[y * im.w + x] < BG_INK ? 1 : 0; return m; };
const widen = (m, w, h) => { const o = new Uint8Array(w * h); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (m[y * w + x]) for (let dy = -WIDEN; dy <= WIDEN; dy++) for (let dx = -WIDEN; dx <= WIDEN; dx++) { const X = x + dx, Y = y + dy; if (X >= 0 && Y >= 0 && X < w && Y < h) o[Y * w + X] = 1; } return o; };
const iou = (a, b) => { let i = 0, u = 0; for (let k = 0; k < a.length; k++) { i += a[k] & b[k]; u += a[k] | b[k]; } return u ? i / u : 1; };

// ---- each picture
const rows = [];
for (const [n, p] of pictures.entries()) {
  const tb = texBox[p.id]; if (!tb) fail("no box in the log for " + p.id);
  const tW = tb[2] - tb[0], tH = tb[3] - tb[1];
  let html, why = null;
  try { html = renderTikz(p.src, { label: (t, f) => tikzLabel(t, f) }, { colors: {}, idn: 0 }); } catch (e) { why = e.why ?? e.message; }
  const row = { id: p.id, name: p.name, tex: { w: +tW.toFixed(2), h: +tH.toFixed(2) } };
  if (why) { rows.push({ ...row, ok: false, why }); continue; }
  const ob = /data-box="([^"]+)"/.exec(html)[1].split(" ").map(Number), oW = ob[2] - ob[0], oH = ob[3] - ob[1];
  row.ours = { w: +oW.toFixed(2), h: +oH.toFixed(2) };
  row.box = +Math.max(Math.abs(oW - tW) / Math.max(tW, 1), Math.abs(oH - tH) / Math.max(tH, 1)).toFixed(4);
  // (the page: the picture at its top left, white. The preview writes TeX's pt as CSS pt, 1/72 in, not TeX's 1/72.27 (as
  // the rest of the page does), so its pictures are 0.375% larger than TeX's: the scale here takes that out, so a TeX pt
  // is the same pixels on both sides and the comparison is of the drawing, not of the page's unit)
  const page = join(work, p.id + ".html"), shot = join(work, p.id + ".png");
  writeFileSync(page, '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="' + KATEX_CSS + '"></head><body style="margin:0;background:#fff">' + html + "</body></html>");
  const cw = Math.ceil((oW * 96) / 72.27) + 4, ch = Math.ceil((oH * 96) / 72.27) + 4;
  const sc = spawnSync(CHROME, ["--headless", "--no-sandbox", "--disable-gpu", "--hide-scrollbars", `--force-device-scale-factor=${(DPI / 96) * (72 / 72.27)}`,
    `--window-size=${Math.max(cw, 64)},${Math.max(ch, 64)}`, `--screenshot=${shot}`, "file://" + page], { encoding: "utf8", timeout: 60_000 });
  if (sc.status !== 0) fail("chrome failed on " + p.id + ": " + (sc.stderr || "").slice(-500));
  const A = readPgm(join(work, pages[n])), B = readPng(shot);
  const w = Math.min(A.w, B.w, Math.round(oW * PX)), h = Math.min(A.h, B.h, Math.round(oH * PX));
  const ma = mask(A, w, h), mb = mask(B, w, h);
  row.px = [w, h];
  row.iou = +iou(ma, mb).toFixed(3);
  row.iou1 = +iou(widen(ma, w, h), widen(mb, w, h)).toFixed(3);
  row.min = p.iou ?? IOU_MIN;
  row.ok = row.box <= BOX_TOL && row.iou1 >= row.min;
  rows.push(row);
  if (process.env.BENCH_VERBOSE) console.error(p.id, JSON.stringify(row));
}

// ---- results
mkdirSync(OUT, { recursive: true });
const versions = {
  pdflatex: spawnSync("pdflatex", ["--version"], { encoding: "utf8" }).stdout.split("\n")[0],
  pgf: /^Package: pgf \S+ v(\S+)/m.exec(readFileSync(join(work, "pics.log"), "utf8"))?.[1] ?? null,
  chrome: spawnSync(CHROME, ["--version"], { encoding: "utf8" }).stdout?.trim(),
};
const passed = rows.filter((r) => r.ok).length;
writeFileSync(join(OUT, "results.json"), JSON.stringify({ date: new Date().toISOString(), dpi: DPI, ink: BG_INK, widen_px: WIDEN, box_tolerance: BOX_TOL, iou_min: IOU_MIN, versions, tex_ms: texMs, passed, pictures: rows }, null, 1) + "\n");
const table = ["| id | picture | TeX box (pt) | preview box (pt) | box diff | IoU | IoU, 0.24 pt | held to | |", "|---|---|---|---|---|---|---|---|---|",
  ...rows.map((r) => r.why ? `| ${r.id} | ${r.name} | ${r.tex.w} × ${r.tex.h} | not drawn: ${r.why} | | | | | ✗ |`
    : `| ${r.id} | ${r.name} | ${r.tex.w} × ${r.tex.h} | ${r.ours.w} × ${r.ours.h} | ${(r.box * 100).toFixed(2)}% | ${r.iou.toFixed(3)} | ${r.iou1.toFixed(3)} | ${r.min} | ${r.ok ? "✓" : "✗"} |`),
  "", `${passed} of ${rows.length} pictures pass (box within ${BOX_TOL * 100}% each way, IoU within 0.24 pt at least the picture's own minimum). ${versions.pdflatex}; pgf ${versions.pgf}; ${versions.chrome}; ${DPI} dpi.`, ""];
writeFileSync(join(OUT, "table.md"), table.join("\n"));
if (!process.argv.includes("--keep")) rmSync(work, { recursive: true, force: true }); else console.error("kept " + work);
console.log(table.slice(-2).join("").trim());
process.exit(passed === rows.length ? 0 : 1);
