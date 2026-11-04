// bench/latex/fidelity.mjs: how much of what TeX typeset the preview shows, for each document run.mjs kept
// (DIR/<id>.pdf from latexmk, DIR/<id>.preview.txt the preview's innerText, DIR/<id>.check.json check's report):
//   - text: the PDF's words (pdftotext) and the preview's, as multisets of tokens (a word of letters or digits,
//     lowercased; each Han, kana or hangul character its own token): recall (the PDF's tokens the preview has),
//     precision (the preview's the PDF has) and their Dice similarity. Math, page furniture and TikZ labels differ
//     on both sides, so 1.0 is not expected: a low number is the signal, and the words it lacks are listed.
//   - structure: PDF pages; for beamer, the preview's frames and their overlay steps (each step is a PDF page).
//   - unsupported: check's problems, by kind.
//   node bench/latex/fidelity.mjs DIR [--docs C0,C2]
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
/** The tokens of a text, counted. */
export function tokens(text) {
  const m = new Map();
  const t = text.normalize("NFKC").replace(/(\p{L})-\n(\p{L})/gu, "$1$2").toLowerCase();
  for (const w of t.match(/[\p{L}\p{N}]+/gu) ?? []) {
    if (CJK.test(w)) { for (const c of w) m.set(c, (m.get(c) ?? 0) + 1); }
    else if (w.length > 1 || /\d/.test(w)) m.set(w, (m.get(w) ?? 0) + 1);
  }
  return m;
}
/** Recall, precision and Dice of two token multisets (a: the reference), and a's tokens b lacks most. */
export function compare(a, b) {
  let na = 0, nb = 0, both = 0;
  const missing = [];
  for (const [w, k] of a) { na += k; const j = b.get(w) ?? 0; both += Math.min(k, j); if (k > j) missing.push([w, k - j]); }
  for (const k of b.values()) nb += k;
  missing.sort((x, y) => y[1] - x[1]);
  return { pdf_tokens: na, preview_tokens: nb, recall: na ? both / na : 0, precision: nb ? both / nb : 0, dice: na + nb ? (2 * both) / (na + nb) : 0, missing: missing.slice(0, 12) };
}

/** The fidelity table of DIR's documents, as Markdown. */
export function fidelity(dir, docs) {
  const rows = [], notes = [];
  for (const d of docs) {
    const pdf = join(dir, `${d.id}.pdf`), txt = join(dir, `${d.id}.preview.txt`), chk = join(dir, `${d.id}.check.json`);
    let check = null;
    try { check = JSON.parse(readFileSync(chk, "utf8")); } catch {}
    const pages = existsSync(pdf) ? Number(/Pages:\s+(\d+)/.exec(spawnSync("pdfinfo", [pdf], { encoding: "utf8" }).stdout ?? "")?.[1] ?? NaN) : NaN;
    const c = existsSync(pdf) && existsSync(txt) ? compare(tokens(spawnSync("pdftotext", ["-enc", "UTF-8", pdf, "-"], { encoding: "utf8", maxBuffer: 256 << 20 }).stdout ?? ""), tokens(readFileSync(txt, "utf8"))) : null;
    const frames = check?.class === "beamer" ? `${check.frames.length} frames, ${check.frames.reduce((s, f) => s + (f.steps || 1), 0)} steps` : "–";
    const kinds = {};
    for (const p of check?.problems ?? []) kinds[p.kind] = (kinds[p.kind] ?? 0) + 1;
    const unsup = Object.entries(kinds).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(", ") || (check ? "none" : "–");
    const f = (x) => x.toFixed(3);
    rows.push(`| ${d.id} ${d.name} | ${c ? `${f(c.recall)} / ${f(c.precision)} / ${f(c.dice)}` : "–"} | ${c ? `${c.pdf_tokens} / ${c.preview_tokens}` : "–"} | ${Number.isFinite(pages) ? pages : "–"} | ${frames} | ${unsup} |`);
    if (c?.missing.length) notes.push(`- ${d.id}: the PDF's tokens the preview lacks most: ${c.missing.map(([w, k]) => `${w} (${k})`).join(", ")}`);
  }
  return [
    "Fidelity: text recall / precision / Dice against the PDF's text (pdftotext); tokens PDF / preview; PDF pages; the preview's beamer frames and overlay steps; check's problems by kind.",
    "",
    "| document | text R / P / Dice | tokens | PDF pages | preview frames | check problems |",
    "|---|---:|---:|---:|---:|---|",
    ...rows,
    "",
    ...notes,
    "",
  ].join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = process.argv[2];
  if (!dir) { console.error("usage: node bench/latex/fidelity.mjs DIR [--docs C0,C2]"); process.exit(2); }
  const all = JSON.parse(readFileSync(new URL("corpus.json", import.meta.url), "utf8")).docs;
  const i = process.argv.indexOf("--docs"), want = i > 0 ? process.argv[i + 1].split(",") : null;
  process.stdout.write(fidelity(dir, want ? all.filter((d) => want.includes(d.id)) : all));
}
