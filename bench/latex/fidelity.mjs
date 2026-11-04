// bench/latex/fidelity.mjs: how much of what TeX typeset the preview shows, for each document run.mjs kept
// (DIR/<id>.pdf from latexmk, DIR/<id>.preview.txt the preview's innerText, DIR/<id>.check.json check's report):
//   - text: the PDF's words (pdftotext) and the preview's, as multisets of tokens (a word of letters or digits,
//     lowercased; each Han, kana or hangul character its own token; a word of one letter is not a token, as most are
//     math variables and list labels, which the two sides show differently; one digit is): recall (the PDF's tokens the preview has),
//     precision (the preview's the PDF has) and their Dice similarity. Math, page furniture and TikZ labels differ
//     on both sides, so 1.0 is not expected: a low number is the signal, and the words it lacks are listed.
//   - structure: PDF pages; for beamer, the preview's frames and their overlay steps (each step is a PDF page).
//   - unsupported: check's problems, by kind.
// Without the browser part (no <id>.preview.txt), the preview's text is the CLI's HTML (<id>.html) as text, marked "ᶜ":
// near the browser's innerText, not the same (the HTML's math is its source and its rendering both, for one).
//   node bench/latex/fidelity.mjs DIR [--docs C0,C2]
//   node bench/latex/fidelity.mjs --self-test     (tokens(), compare() and htmlText() on small cases)
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

/** An HTML page's text, roughly: its style, script and head dropped, tags as spaces, entities decoded. */
export function htmlText(html) {
  const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
  return html.replace(/<(style|script|head)\b[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]*>/g, " ")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (e, n) => n[0] === "#" ? String.fromCodePoint(n[1] === "x" || n[1] === "X" ? parseInt(n.slice(2), 16) : +n.slice(1)) : named[n.toLowerCase()] ?? e);
}

/** The fidelity table of DIR's documents, as Markdown. */
export function fidelity(dir, docs) {
  const rows = [], notes = [];
  for (const d of docs) {
    const pdf = join(dir, `${d.id}.pdf`), txt = join(dir, `${d.id}.preview.txt`), html = join(dir, `${d.id}.html`), chk = join(dir, `${d.id}.check.json`);
    // (the browser's text; else the CLI's HTML as text, marked)
    const fromCli = !existsSync(txt) && existsSync(html), text = existsSync(txt) ? readFileSync(txt, "utf8") : fromCli ? htmlText(readFileSync(html, "utf8")) : null;
    let check = null;
    try { check = JSON.parse(readFileSync(chk, "utf8")); } catch {}
    const pages = existsSync(pdf) ? Number(/Pages:\s+(\d+)/.exec(spawnSync("pdfinfo", [pdf], { encoding: "utf8" }).stdout ?? "")?.[1] ?? NaN) : NaN;
    const c = existsSync(pdf) && text !== null ? compare(tokens(spawnSync("pdftotext", ["-enc", "UTF-8", pdf, "-"], { encoding: "utf8", maxBuffer: 256 << 20 }).stdout ?? ""), tokens(text)) : null;
    const frames = check?.class === "beamer" ? `${check.frames.length} frames, ${check.frames.reduce((s, f) => s + (f.steps || 1), 0)} steps` : "–";
    const kinds = {};
    for (const p of check?.problems ?? []) kinds[p.kind] = (kinds[p.kind] ?? 0) + 1;
    const unsup = Object.entries(kinds).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(", ") || (check ? "none" : "–");
    const f = (x) => x.toFixed(3);
    rows.push(`| ${d.id} ${d.name} | ${c ? `${f(c.recall)} / ${f(c.precision)} / ${f(c.dice)}${fromCli ? " ᶜ" : ""}` : "–"} | ${c ? `${c.pdf_tokens} / ${c.preview_tokens}` : "–"} | ${Number.isFinite(pages) ? pages : "–"} | ${frames} | ${unsup} |`);
    if (c?.missing.length) notes.push(`- ${d.id}: the PDF's tokens the preview lacks most: ${c.missing.map(([w, k]) => `${w} (${k})`).join(", ")}`);
  }
  return [
    "Fidelity: text recall / precision / Dice against the PDF's text (pdftotext; ᶜ: the preview's text from the CLI's HTML, the browser part not run); tokens PDF / preview; PDF pages; the preview's beamer frames and overlay steps; check's problems by kind.",
    "",
    "| document | text R / P / Dice | tokens | PDF pages | preview frames | check problems |",
    "|---|---:|---:|---:|---:|---|",
    ...rows,
    "",
    ...notes,
    "",
  ].join("\n");
}

/** tokens(), compare() and htmlText() on small cases: the failures, none if all hold. */
export function selfTest() {
  const t = (s) => Object.fromEntries(tokens(s)), eq = (a, b) => JSON.stringify(a) === JSON.stringify(b), bad = [];
  const ck = (name, ok, got) => { if (!ok) bad.push(`${name}: ${JSON.stringify(got)}`); };
  ck("tokens: words lowercased, counted", eq(t("The cat, the CAT."), { the: 2, cat: 2 }), t("The cat, the CAT."));
  ck("tokens: one letter is no token, one digit is", eq(t("a x I 7 42"), { 7: 1, 42: 1 }), t("a x I 7 42"));
  ck("tokens: a word hyphenated at a line's end joined", eq(t("fide-\nlity"), { fidelity: 1 }), t("fide-\nlity"));
  ck("tokens: each CJK character a token", eq(t("中文字体 中"), { 中: 2, 文: 1, 字: 1, 体: 1 }), t("中文字体 中"));
  ck("tokens: NFKC (ﬁ is fi)", eq(t("ﬁne"), { fine: 1 }), t("ﬁne"));
  const same = compare(tokens("alpha beta gamma"), tokens("gamma beta alpha"));
  ck("compare: identical texts", same.recall === 1 && same.precision === 1 && same.dice === 1 && same.missing.length === 0, same);
  const half = compare(tokens("alpha beta gamma delta"), tokens("alpha beta"));
  ck("compare: half the reference", half.recall === 0.5 && half.precision === 1 && Math.abs(half.dice - 2 / 3) < 1e-12 && eq(half.missing, [["gamma", 1], ["delta", 1]]), half);
  const multi = compare(tokens("the the the cat"), tokens("the cat cat"));
  ck("compare: multisets (min of the counts)", multi.recall === 0.5 && multi.precision === 2 / 3 && eq(multi.missing, [["the", 2]]), multi);
  const none = compare(tokens("alpha beta beta beta"), tokens(""));
  ck("compare: an empty preview, the missing most first", none.recall === 0 && none.precision === 0 && none.dice === 0 && eq(none.missing, [["beta", 3], ["alpha", 1]]), none);
  const empty = compare(tokens(""), tokens(""));
  ck("compare: both empty", empty.recall === 0 && empty.precision === 0 && empty.dice === 0, empty);
  const h = htmlText('<html><head><title>T</title></head><style>.x{}</style><p>A&amp;B &lt;c&gt; &#233;t&#xE9;</p><script>s()</script></html>');
  ck("htmlText: style, script, head dropped, entities decoded", h.replace(/\s+/g, " ").trim() === "A&B <c> été", h);
  return bad;
}

if (import.meta.url === `file://${process.argv[1]}` && process.argv[2] === "--self-test") {
  const bad = selfTest();
  for (const b of bad) console.error("FAIL " + b);
  console.log(bad.length ? `FAIL: fidelity.mjs's self-test, ${bad.length} failed` : "ok: fidelity.mjs's self-test");
  process.exit(bad.length ? 1 : 0);
} else if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = process.argv[2];
  if (!dir) { console.error("usage: node bench/latex/fidelity.mjs DIR [--docs C0,C2]"); process.exit(2); }
  const all = JSON.parse(readFileSync(new URL("corpus.json", import.meta.url), "utf8")).docs;
  const i = process.argv.indexOf("--docs"), want = i > 0 ? process.argv[i + 1].split(",") : null;
  process.stdout.write(fidelity(dir, want ? all.filter((d) => want.includes(d.id)) : all));
}
