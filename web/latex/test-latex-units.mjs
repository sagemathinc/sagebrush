// The LaTeX editor's pure parts, without a browser: the bytes <-> text rules (save.ts), the image resolver and sniffer
// (images.ts), the chunk splitter (split.ts), the highlighter's tokenizer (highlight.ts), the flag (boot.ts) and the
// request gate (gate.ts); and the renderer's unclosed formulas (engine/render.mjs, KaTeX stubbed).
//   bun web/latex/test-latex-units.mjs
import { openBytes, encodeText, EDIT_MAX } from "./save.ts";
import { imageCandidates, sniffImage, admitImageBytes, IMAGE_BOUNDS } from "./images.ts";
import { splitChunk, PIECE_MAX, CHUNK_MAX, bytes } from "./split.ts";
import { tokenizeLine } from "./highlight.ts";
import { latexOn } from "./boot.ts";
import { RenderGate } from "./gate.ts";
import { boxClass } from "./boxclass.mjs";
import { previewHost } from "./preview-host.mjs";
import { Engine } from "./engine/pipeline.mjs";
import { coldRun, incremental } from "./engine/incremental-demo.mjs";
import { setKatex } from "./engine/render.mjs";

const results = [];
const check = (name, ok, detail) => { results.push([name, !!ok]); if (!ok) console.log("FAIL", name, JSON.stringify(detail)?.slice(0, 600)); };
// (bytes of strings and byte lists, joined without spreading: a fixture is 3 MiB)
const u8 = (...parts) => { const bs = parts.map((p) => (typeof p === "string" ? new TextEncoder().encode(p) : Uint8Array.from(p))); const out = new Uint8Array(bs.reduce((n, b) => n + b.length, 0)); let at = 0; for (const b of bs) { out.set(b, at); at += b.length; } return out; };
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

// ---- save.ts: the fixtures, each opened, its text encoded back unedited (the open-time assertion), then edited
const BOM = [0xef, 0xbb, 0xbf];
const FIXTURES = [
  ["lf", u8("\\documentclass{article}\n\\begin{document}\nx\n\\end{document}\n"), "\n"],
  ["crlf", u8("\\documentclass{article}\r\n\\begin{document}\r\nx\r\n\\end{document}\r\n"), "\r\n"],
  ["bom", u8(BOM, "\\begin{document}\nx\n\\end{document}\n"), "\n"],
  ["bom-crlf", u8(BOM, "a\r\nb\r\n"), "\r\n"],
  ["no-final-newline", u8("a\nb"), "\n"],
  ["large-3MiB", u8("x".repeat(3 * 2 ** 20 - 2) + "\n"), "\n"],
  ["non-ascii", u8("Résumé: ∑ 𝔸 € — ok\n"), "\n"],
];
for (const [name, b, eol] of FIXTURES) {
  const o = openBytes(b);
  check("open-" + name, o.kind === "text" && o.saveable && o.eol === eol && same(encodeText(o.text, o.eol), b), { kind: o.kind, saveable: o.saveable, why: o.why, eol: o.eol });
  // edited: a line appended, saved, read back
  if (o.kind === "text") {
    const edited = o.text + "added\n", out = encodeText(edited, o.eol);
    const back = openBytes(out);
    const bomCount = out.reduce((n, x, i) => n + (x === 0xef && out[i + 1] === 0xbb && out[i + 2] === 0xbf ? 1 : 0), 0);
    check("edit-" + name, back.kind === "text" && back.text === edited && back.eol === o.eol && bomCount === (b[0] === 0xef ? 1 : 0) && (b[0] !== 0xef || (out[0] === 0xef && out[1] === 0xbb && out[2] === 0xbf)), { bomCount });
  }
}
check("fixture-count-computed", FIXTURES.length === 7, FIXTURES.length);
check("open-mixed-endings-no-save", (() => { const o = openBytes(u8("a\r\nb\nc\r\n")); return o.kind === "text" && !o.saveable && /mixes/.test(o.why); })(), null);
check("open-lone-cr-no-save", (() => { const o = openBytes(u8("a\rb\n")); return o.kind === "text" && !o.saveable; })(), null);
check("open-nul-binary", openBytes(u8("a", [0], "b")).kind === "binary", null);
check("open-invalid-utf8-binary", openBytes(new Uint8Array([0x61, 0xff, 0x62])).kind === "binary", null);
check("open-over-4MiB-no-save", (() => { const o = openBytes(u8("y".repeat(EDIT_MAX + 1))); return o.kind === "text" && !o.saveable; })(), null);
check("encode-never-prepends-bom", same(encodeText("abc", "\n"), u8("abc")) && same(encodeText("\ufeffabc", "\n"), u8(BOM, "abc")), null);

// ---- images.ts: the resolver (inside the opened file's folder only) and the sniffer
const doc = "/papers/a/main.tex";
const ok = (arg) => { const r = imageCandidates(arg, doc); return r.ok ? r.paths : r.why; };
check("img-plain", JSON.stringify(ok("fig.png")) === JSON.stringify(["/papers/a/fig.png"]), ok("fig.png"));
check("img-no-ext", ok("fig").length === 7 && ok("fig")[0] === "/papers/a/fig" && ok("fig")[1] === "/papers/a/fig.png", ok("fig"));
check("img-subfolder", ok("img/x.svg")[0] === "/papers/a/img/x.svg", ok("img/x.svg"));
for (const [n, a] of [["escape", "../fig.png"], ["abs", "/abs.png"], ["url", "https://x/y.png"], ["pct", "fig%2f..%2fx.png"], ["pct-dot", "%2e%2e/x.png"], ["backslash", "a\\b.png"], ["empty-seg", "a//b.png"], ["dot", "./x.png"], ["nul", "a\u0000b"], ["data", "data:image/png;base64,AAAA"]])
  check("img-refused-" + n, typeof ok(a) === "string", ok(a));
check("img-prefix-sibling", typeof imageCandidates("../ab/x.png", "/papers/a/main.tex") === "object" && !imageCandidates("../ab/x.png", "/papers/a/main.tex").ok, null);
const png = u8([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13], "IHDR", [0, 0, 0x10, 0, 0, 0, 0x10, 0, 8, 6, 0, 0, 0]);
check("sniff-png", (() => { const s = sniffImage(png); return s.ok && s.mime === "image/png" && s.pixels === 4096 * 4096; })(), sniffImage(png));
check("sniff-svg", sniffImage(u8('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"></svg>')).ok, null);
check("sniff-html-not-image", !sniffImage(u8("<html><script>x</script></html>")).ok, null);
// (the bytes actually read, checked before a blob is made: at the 64 MiB cap, a short or long read, an 8 MiB image)
const MiB = 2 ** 20;
check("img-bytes-at-cap", admitImageBytes(4 * MiB, 4 * MiB, 60 * MiB) === null, admitImageBytes(4 * MiB, 4 * MiB, 60 * MiB));
check("img-bytes-over-cap", admitImageBytes(4 * MiB, 4 * MiB, 60 * MiB + 1) === "too large", admitImageBytes(4 * MiB, 4 * MiB, 60 * MiB + 1));
check("img-bytes-not-the-stat", admitImageBytes(10, 9, 0) === "changed while it was read" && admitImageBytes(8, 9, 0) === "changed while it was read" && admitImageBytes(10, undefined, 0) === "changed while it was read", null);
check("img-bytes-per-image", admitImageBytes(IMAGE_BOUNDS.perImage, IMAGE_BOUNDS.perImage, 0) === null && admitImageBytes(IMAGE_BOUNDS.perImage + 1, IMAGE_BOUNDS.perImage + 1, 0) === "too large", null);
check("sniff-gif", (() => { const s = sniffImage(u8("GIF89a", [10, 0, 20, 0], [0, 0, 0])); return s.ok && s.pixels === 200; })(), null);

// ---- split.ts: pieces of at most PIECE_MAX; containers copied; tables and huge inline elements as placeholders
const para = '<div class="p">' + Array.from({ length: 12000 }, (_, k) => "word" + k + " <b>b</b> ").join("") + "</div>";
const ps = splitChunk(para);
check("split-paragraph", bytes(para) > PIECE_MAX && ps.length > 1 && ps.every((p) => bytes(p) <= PIECE_MAX) && ps[0].startsWith('<div class="p">') && ps.slice(1).every((p) => p.startsWith('<div class="p cont">')) && ps.map((p) => p.replace(/^<div class="p( cont)?">|<\/div>$/g, "")).join("") === para.replace(/^<div class="p">|<\/div>$/g, ""), { n: ps.length });
const list = '<ol class="list enum d1">' + Array.from({ length: 3000 }, (_, k) => '<li id="i' + k + '"><span class="lbl">' + (k + 1) + ".</span>" + "item text ".repeat(6) + "</li>").join("") + "</ol>";
const ls = splitChunk(list);
check("split-list-container-copied-labels-kept", ls.length > 1 && ls.every((p) => bytes(p) <= PIECE_MAX) && ls.slice(1).every((p) => p.startsWith('<ol class="list enum d1 cont">')) && (ls.join("").match(/<span class="lbl">/g) || []).length === 3000, { n: ls.length, heads: ls.map((p) => p.slice(0, 40)) });
const thm = '<div class="thm thm-plain" id="t1"><div class="thmhead">Theorem 1.</div>' + Array.from({ length: 2500 }, () => '<div class="p">' + "x ".repeat(30) + "</div>").join("") + "</div>";
const ts = splitChunk(thm);
check("split-theorem-container-copied", ts.length > 1 && ts.every((p) => bytes(p) <= PIECE_MAX) && ts.slice(1).every((p) => p.startsWith('<div class="thm thm-plain cont">')) && ts[0].includes("thmhead") && !ts.slice(1).some((p) => p.includes("thmhead")), { n: ts.length });
const table = '<table class="tabular"><tbody>' + Array.from({ length: 6000 }, () => "<tr><td>aaaaaaaaaaaaaaaa</td><td>b</td></tr>").join("") + "</tbody></table>";
check("split-table-placeholder", (() => { const t = splitChunk(table); return t.length === 1 && /too large/.test(t[0]); })(), null);
const huge = '<div class="p"><span class="katex">' + "x".repeat(PIECE_MAX + 10) + "</span></div>";
check("split-one-huge-inline-placeholder", (() => { const t = splitChunk(huge); return t.length === 1 && /too large/.test(t[0]); })(), null);
check("split-over-2MiB-placeholder", (() => { const t = splitChunk('<div class="p">' + "y ".repeat(CHUNK_MAX) + "</div>"); return t.length === 1 && /too large/.test(t[0]); })(), null);
check("split-small-unchanged", splitChunk('<div class="p">hi</div>')[0] === '<div class="p">hi</div>', null);

// ---- highlight.ts: the tokenizer's states
const run = (line, st) => { const g = tokenizeLine(line, st); const toks = []; for (;;) { const r = g.next(); if (r.done) return { toks, end: r.value }; toks.push(r.value); } };
check("hl-normal", run("Hello \\emph{x} % c", "N").end === "N" && run("Hello \\emph{x} % c", "N").toks.some(([c, t]) => c === "c-cmt" && t === "% c"), null);
check("hl-math-open", run("text $x+1", "N").end === "M" && run("y$ more", "M").end === "N", null);
check("hl-verbatim-state", run("\\begin{verbatim}", "N").end === "V:verbatim" && run("$ % \\x", "V:verbatim").end === "V:verbatim" && run("\\end{verbatim} after", "V:verbatim").end === "N", null);
check("hl-display", run("\\[ a", "N").end === "D" && run("b \\]", "D").end === "N" && run("$$ a", "N").end === "D", null);
check("hl-mathenv", run("\\begin{align}", "N").end === "E:align" && run("\\end{align}", "E:align").end === "N", null);
// (a blank line ends inline and display math, as in TeX; not a math environment, not verbatim)
check("hl-blank-ends-math", run("", "M").end === "N" && run("  \t", "D").end === "N" && run("", "E:align").end === "E:align" && run("", "V:verbatim").end === "V:verbatim" && run("% c", "M").end === "M", null);

// ---- render.mjs: an unclosed formula ends at a blank line (KaTeX stubbed: each formula drawn as its source)
{
  setKatex((src, o) => '<span class="K' + (o.displayMode ? "D" : "I") + '">' + src.replace(/[&<>]/g, "") + "</span>");
  const html = (body) => new Engine().update("\\documentclass{article}\n\\begin{document}\n" + body + "\n\\end{document}\n").chunks.join("");
  const count = (h, s) => h.split(s).length - 1;
  const cases = [
    ["math-dd-open", "$$x^\n\nAfter text here.\n\n$$y$$", (h) => count(h, "$$ not closed") === 1 && h.includes("After text here.") && count(h, 'class="KD"') === 2 && h.includes('<span class="KD">y</span>')],
    ["math-d-open", "A $x+\n\nNext para $z$.", (h) => count(h, "$ not closed") === 1 && h.includes("Next para") && h.includes('<span class="KI">z</span>')],
    ["math-bracket-open", "\\[ a\n\nB text", (h) => count(h, "\\[ not closed") === 1 && h.includes("B text")],
    ["math-paren-open", "\\( a\n\nC text", (h) => count(h, "\\( not closed") === 1 && h.includes("C text")],
    ["math-explicit-par", "A $a \\par Text after.", (h) => count(h, "$ not closed") === 1 && h.includes("Text after.") && h.includes('<span class="KI">a </span>')],
    ["math-group-end", "{$a} after group", (h) => count(h, "$ not closed") === 1 && h.includes("after group") && h.includes('<span class="KI">a</span>')],
    ["math-list-item", "\\begin{itemize}\\item $a\n\n\\item b text\\end{itemize}", (h) => count(h, "$ not closed") === 1 && h.includes("b text") && count(h, "<li") === 2],
    ["math-grouped-closed", "{$a$} and {$$b$$}", (h) => !h.includes("mathopen") && count(h, 'class="KI"') === 1 && count(h, 'class="KD"') === 1],
    ["math-closed-unchanged", "$a$ and $$b$$ and \\[c\\] \\(d\\) and $$\ne\n$$", (h) => !h.includes("mathopen") && count(h, 'class="KI"') === 2 && count(h, 'class="KD"') === 3],
  ];
  for (const [name, body, ok] of cases) { const h = html(body); check(name, ok(h), h.slice(0, 600)); }
  // half-typed arguments (as TeX: a blank line ends a name, an optional [...] or a section title; the command is
  // dropped with a note, and everything after the blank line renders)
  const doc = (pre, body) => new Engine().update(pre + "\\begin{document}\n" + body + "\n\\end{document}\n").chunks.join("");
  const half = [
    ["half-begin", "\\begin{\n\nAfter text here.\n\n\\section{Later}\nMore.", (h) => h.includes("\\begin{ not finished") && h.includes("After text here.") && h.includes("Later") && h.includes("More.")],
    ["half-begin-partial", "\\begin{itemiz\n\\item gone\n\nAfter text.", (h) => h.includes("\\begin{itemiz") && h.includes("not finished") && h.includes("After text.") && !h.includes("<li")],
    ["half-section", "\\section{Half title\n\nBody text.", (h) => h.includes("\\section{Half title") && h.includes("not finished") && h.includes("Body text.") && !h.includes("<h2")],
    ["half-label", "Text \\label{sec\n\nNext para.", (h) => h.includes("\\label{sec") && h.includes("Next para.")],
    ["half-end", "\\begin{center}\nX\n\\end{cen\n\nAfter.", (h) => h.includes("\\end{cen") && h.includes("not finished") && h.includes("After.")],
    ["closed-env-unchanged", "\\begin{itemize}\n\\item one\n\\end{itemize}\nAfter.", (h) => !h.includes("not finished") && h.includes("one") && h.includes("After.") && count(h, "<li") === 1],
    ["open-env-still-shows", "\\begin{itemize}\n\\item one\n\nStill here.", (h) => !h.includes("not finished") && h.includes("one") && h.includes("Still here.")],
  ];
  for (const [name, body, ok] of half) { const h = doc("\\documentclass{article}\n", body); check(name, ok(h), h.slice(0, 600)); }
  { const h = doc("\\documentclass[a4paper\n\n", "Body survives."); check("half-documentclass-opt", h.includes("Body survives."), h.slice(0, 600)); }
  // \long commands keep paragraphs (the kernel's \@footnotetext, \@caption, \thanks are \long); a short one with a
  // literal \par is a runaway, as in TeX; a short command that runs away is dropped before any effect
  const longs = [
    ["long-footnote-two-paragraphs", "Text\\footnote{First fn para.\n\nSecond fn para.} after.", (h) => !h.includes("not finished") && h.includes("First fn para.") && h.includes("Second fn para.") && h.includes("after.")],
    ["long-footnote-literal-par", "Text\\footnote{Alpha \\par Beta} after.", (h) => !h.includes("not finished") && h.includes("Beta") && h.includes("after.")],
    ["long-caption-two-paragraphs", "\\begin{figure}\\caption{Cap one.\n\nCap two.}\\end{figure}\nAfter.", (h) => !h.includes("not finished") && h.includes("Cap two.") && h.includes("After.")],
    ["long-thanks-two-paragraphs", "Text\\thanks{Th one.\n\nTh two.} After.", (h) => !h.includes("not finished") && h.includes("After.")],
    ["short-section-literal-par", "\\section{A \\par B}\nAfter.", (h) => h.includes("\\section{A") && h.includes("not finished") && h.includes("After.")],
    // (a counter of the test's own, read with \the: the renderer keeps its own section numbers, and \arabic isn't
    // shown by this prototype; the two closed controls show the reading works)
    ["counter-stepcounter-control", "\\stepcounter{foo}Value: \\the\\csname c@foo\\endcsname.", (h) => !h.includes("not finished") && h.includes("Value: 1.")],
    ["counter-stepcounter-no-effect", "\\stepcounter{foo\n\nValue: \\the\\csname c@foo\\endcsname.", (h) => h.includes("\\stepcounter{foo not finished") && h.includes("Value: 0.")],
    ["counter-setcounter-control", "\\setcounter{foo}{5}Value: \\the\\csname c@foo\\endcsname.", (h) => !h.includes("not finished") && h.includes("Value: 5.")],
    ["counter-setcounter-multiarg-no-effect", "\\setcounter{foo\n\n{5}Value: \\the\\csname c@foo\\endcsname.", (h) => h.includes("\\setcounter{foo not finished") && h.includes("Value: 0.")],
    ["opt-newcounter-runaway", "\\newcounter{bar}[sec\n\nAfter opt.", (h) => h.includes("\\newcounter[sec") && h.includes("not finished") && h.includes("After opt.")],
    ["opt-cite-runaway", "See \\cite[page\n\nNext para.", (h) => h.includes("\\cite[page") && h.includes("not finished") && h.includes("Next para.")],
  ];
  for (const [name, body, ok] of longs) { const h = doc("\\documentclass{article}\n\\newcounter{foo}\n", body); check(name, ok(h), h.slice(0, 700)); }
}

// ---- source position markers: each main-file line is marked at most once (a resume inside an \input that a main
// line started in the middle; the main file read again)
{
  const posAts = (res) => res.units.flatMap((u) => (u.ev || []).filter((e) => typeof e !== "number" && e.k === "pos").map((e) => e.at));
  const dups = (a) => a.filter((x, i) => a.indexOf(x) !== i);
  const sub = Array.from({ length: 120 }, (_, k) => "Sub paragraph " + k + " with several words here.").join("\n\n") + "\n";
  const main = "\\documentclass{article}\n\\begin{document}\nBefore \\input{b} after on the same line.\n\nTail para.\n\\end{document}\n";
  const files = new Map([["main.tex", main], ["b.tex", sub]]);
  const c0 = coldRun(files, "main.tex", { Tmin: 100 });
  const a0 = posAts(c0);
  check("pos-unique-cold", c0.outcome === "ok" && dups(a0).length === 0 && a0.filter((x) => x === main.indexOf("Before")).length === 1, { outcome: c0.outcome, dups: dups(a0) });
  const s = main.indexOf("Tail para.");
  const r1 = incremental(c0, { start: s, end: s + 10, text: "Tail para changed." });
  const main2 = main.slice(0, s) + "Tail para changed." + main.slice(s + 10);
  const a1 = posAts(r1.res);
  check("pos-unique-after-resume-in-input", r1.res.outcome === "ok" && dups(a1).length === 0 && a1.filter((x) => x === main2.indexOf("Before")).length === 1, { mode: r1.stats.mode, resumedFrom: r1.stats.resumedFrom, dups: dups(a1) });
  const reread = "\\documentclass{article}\n\\begin{document}\n\\ifx\\sbdone\\undefined\\def\\sbdone{}\\input{main.tex}\\fi\nPara once.\n\\end{document}\n";
  const c2 = coldRun(new Map([["main.tex", reread]]), "main.tex", { Tmin: 100 });
  const a2 = posAts(c2);
  check("pos-unique-main-reread", dups(a2).length === 0, { outcome: c2.outcome, dups: dups(a2) });
}
{
  // source positions (sync): each chunk's pos is the offset of the line where it begins; after an edit above them
  // (incremental: the later units' events are reused), the positions follow the text
  {
    const paras = Array.from({ length: 400 }, (_, k) => "Paragraph number " + k + " with some words in it.");
    const text = "\\documentclass{article}\n\\begin{document}\n\\section{Start}\n" + paras.join("\n\n") + "\n\\end{document}\n";
    const eng = new Engine();
    const where = (r, t, word) => { const k = r.chunks.findIndex((c) => c.includes(word)); return { k, pos: k >= 0 ? r.chunkPos[k] : -2, want: t.indexOf(word) }; };
    const r1 = eng.update(text);
    const a = where(r1, text, "Paragraph number 300 "), b = where(r1, text, "Start");
    check("pos-aligned", Array.isArray(r1.chunkPos) && r1.chunkPos.length === r1.chunks.length, { n: r1.chunks.length, p: r1.chunkPos?.length });
    check("pos-paragraph", a.k >= 0 && a.pos === a.want, a);
    check("pos-heading", b.k >= 0 && b.pos === text.indexOf("\\section{Start}"), b);
    const text2 = text.replace("Paragraph number 0 ", "Inserted words here.\n\nParagraph number 0 ");
    const r2 = eng.update(text2);
    const c = where(r2, text2, "Paragraph number 300 "), d = where(r2, text2, "Inserted words");
    check("pos-after-edit", c.k >= 0 && c.pos === c.want && d.pos === d.want, { c, d, mode: r2.stats.mode, reused: r2.stats.reused });
    check("pos-edit-reused-units", r2.stats.reused > 0, { mode: r2.stats.mode, reused: r2.stats.reused });
    const text3 = text2.replace("Inserted words here.\n\n", "");
    const r3 = eng.update(text3);
    const e = where(r3, text3, "Paragraph number 300 ");
    check("pos-after-delete", e.k >= 0 && e.pos === e.want, { e, mode: r3.stats.mode });
  }
}

// ---- boxclass.mjs: the page test's box class; the packet's frozen BOXCLASS wins over an inherited LATEX_BOX_CLASS
check("box-file-wins-timing", boxClass("build", "timing\n").box === "timing" && /ignored/.test(boxClass("build", "timing\n").note), boxClass("build", "timing\n"));
check("box-file-wins-build", boxClass("timing", "build\n").box === "build" && /ignored/.test(boxClass("timing", "build\n").note), boxClass("timing", "build\n"));
check("box-file-same-env", boxClass("timing", "timing").box === "timing" && boxClass("timing", "timing").note === "", null);
check("box-file-bad-refused-even-with-env", !!boxClass("timing", "fast\n").error && !boxClass("timing", "fast\n").box, boxClass("timing", "fast\n"));
check("box-no-file-env", boxClass("build", null).box === "build" && boxClass("timing", null).box === "timing", null);
check("box-none-refused", !!boxClass(undefined, null).error && !!boxClass("", null).error && !!boxClass("fast", null).error, null);

// ---- boot.ts: the flag
const DEV = ["dev.sagebrush.space"];   // (the DEV build's hosts, as web/build.ts defines them)
const on = (host, search, stored) => latexOn(host, new URLSearchParams(search).get("latex") == "1", () => stored, DEV);
check("flag-dev-url", on("dev.sagebrush.space", "?latex=1", null) && on("dev.sagebrush.space", "", "1"), null);
check("flag-off-without", !on("dev.sagebrush.space", "", null) && !on("dev.sagebrush.space", "?latex=0", "0"), null);
check("flag-prod-never", !on("sagebrush.space", "?latex=1", "1"), null);
check("flag-lookalike-hosts", !on("x.dev.sagebrush.space", "?latex=1", "1") && !on("dev.sagebrush.space.evil", "?latex=1", "1"), null);
check("flag-test-hosts-only-in-list", latexOn("127.0.0.1", true, () => null, ["dev.sagebrush.space", "127.0.0.1"]) && !latexOn("127.0.0.1", true, () => null, ["dev.sagebrush.space"]), null);

// ---- preview-host.mjs: the preview deploy's one extra host (web/build.ts), only under .sagebrush.cloud, only with =1
{
  check("host-preview", previewHost("1", "latex.sagebrush.cloud") === "latex.sagebrush.cloud");
  check("host-unset", previewHost("1", undefined) === null && previewHost("1", "") === null);
  check("host-ignored-without-1", previewHost("", "latex.sagebrush.cloud") === null && previewHost("test", "latex.sagebrush.cloud") === null && previewHost("test", "evil.example") === null);
  const bad = ["sagebrush.cloud", ".sagebrush.cloud", "dev.sagebrush.space", "latex.sagebrush.space", "cocalc.com", "x.cocalc.com", "*.sagebrush.cloud", "Latex.sagebrush.cloud",
    "latex.sagebrush.cloud.", "latex.sagebrush.cloud:443", "https://latex.sagebrush.cloud", "latex.sagebrush.cloud/x", "a..sagebrush.cloud", "-a.sagebrush.cloud", "a-.sagebrush.cloud",
    "latex.sagebrush.cloud,evil.com", "latex.sagebrush.cloud evil.com", "evilsagebrush.cloud", "latex.sagebrush.cloud.evil.com", "a".repeat(64) + ".sagebrush.cloud"];
  const passed = bad.filter((h) => { try { previewHost("1", h); return true; } catch { return false; } });
  check("host-refused", passed.length === 0, passed);
}

// ---- gate.ts
{
  const g = new RenderGate();
  const a = g.load(); check("gate-no-send-while-loading", !g.canSend(), null);
  const b = g.load(); check("gate-stale-load-not-loaded", !g.loaded(a) && g.loaded(b) && g.canSend(), null);
  const t = g.token(); g.edit();
  check("gate-reply-other-revision", g.accept({ doc: t.doc, rev: t.rev }).patch && !g.accept({ doc: t.doc, rev: t.rev }).current && !g.accept({ doc: a.doc, rev: a.rev }).patch, null);
}

const failed = results.filter(([, ok]) => !ok).map(([n]) => n);
console.log(failed.length ? `FAIL: ${failed.length} of ${results.length}: ${failed.join(", ")}` : `ok: the LaTeX editor's units, ${results.length} checks`);
process.exit(failed.length ? 1 : 0);
