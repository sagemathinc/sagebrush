// The package fixtures (test/fixtures/latex/packages/<name>/): small documents, each using one family of commands
// arXiv papers use most (tables, front matter, algorithms, subfigures, boxes, headers, footnotes), with TeX's text
// for each as the oracle. A fixture's folder has:
//   - main.tex: the document;
//   - tex.txt: its PDF's text, `pdftotext -enc UTF-8 main.pdf tex.txt` after `latexmk -pdf main.tex` (TeX Live 2025);
//   - expect.json: what the preview must reach, a ratchet: {"recall": the least share of TeX's tokens the preview shows,
//     "stray": the most tokens the preview shows that TeX's PDF doesn't (a chip's name, an argument shown as text),
//     "problems": the most problems check says, "note": why, where one isn't 1, 0 and 0}.
// The tokens are bench/latex/fidelity.mjs's (words of letters or digits, lowercased, one-letter words dropped); TeX's
// page number, a line of digits alone at the end, is not one.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import katex from "katex";
import { Engine } from "./engine/pipeline.mjs";
import { setKatex } from "./engine/render.mjs";
import { tokens, compare, htmlText } from "../../bench/latex/fidelity.mjs";

export const FIXTURES = new URL("../../test/fixtures/latex/packages/", import.meta.url).pathname;

/** The fixtures' names. */
export const fixtureNames = () => readdirSync(FIXTURES, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();

/** A fixture's TeX text as tokens, its page number dropped. */
export function texTokens(name) {
  const txt = readFileSync(join(FIXTURES, name, "tex.txt"), "utf8").replace(/\f/g, "\n").replace(/\n\s*\d+\s*\n*$/, "\n");
  return tokens(txt);
}

/** A fixture rendered by the preview's engine, with KaTeX's HTML (not its MathML, which would count math twice). */
export function renderFixture(name) {
  setKatex((src, o) => katex.renderToString(src, { ...o, output: "html" }), katex.__renderToHTMLTree);
  const r = new Engine().update(readFileSync(join(FIXTURES, name, "main.tex"), "utf8"));
  const html = r.chunks.join("\n");
  return { html, text: htmlText(html), problems: r.problems };
}

/** How near the preview is to TeX for a fixture: recall of TeX's tokens, the stray tokens (the preview's that TeX's
 * PDF lacks, with their counts), and the problems. */
export function measure(name) {
  const r = renderFixture(name), tex = texTokens(name), prev = tokens(r.text);
  const c = compare(tex, prev);
  const stray = [];
  for (const [w, k] of prev) { const j = tex.get(w) ?? 0; if (k > j) stray.push([w, k - j]); }
  return { recall: c.recall, missing: c.missing, stray, strayCount: stray.reduce((n, [, k]) => n + k, 0), problems: r.problems, html: r.html };
}

export const expectOf = (name) => JSON.parse(readFileSync(join(FIXTURES, name, "expect.json"), "utf8"));
