// ci: checks.3 order=106 runner=bun
// The LaTeX editor's pure parts, without a browser: the bytes <-> text rules (save.ts), the image resolver and sniffer
// (images.ts), the chunk splitter (split.ts), the highlighter's tokenizer (highlight.ts), the flag (boot.ts) and the
// request gate (gate.ts); and the renderer's unclosed formulas (engine/render.mjs, KaTeX stubbed).
//   bun web/latex/test-latex-units.mjs   (in CI since #622: the engine's render checks, short verbatim among them)
import { openBytes, encodeText, EDIT_MAX } from "./save.ts";
import { imageCandidates, graphicsPathOf, notFoundWhy, relativePath, sniffImage, admitImageBytes, IMAGE_BOUNDS } from "./images.ts";
import { splitChunk, PIECE_MAX, CHUNK_MAX, bytes, weight, tooLargeProblem } from "./split.ts";
import { autoClose } from "./envclose.ts";
import { tokenizeLine } from "./highlight.ts";
import { latexOn } from "./boot.ts";
import { RenderGate } from "./gate.ts";
import { boxClass } from "./boxclass.mjs";
import { previewHost } from "./preview-host.mjs";
import { EXAMPLES } from "./examples.ts";
import { makeAnchor, locate } from "./comments.ts";
import { Engine, withBeamer, once, declaresBeamer } from "./engine/pipeline.mjs";
import { coldRun, incremental } from "./engine/incremental-demo.mjs";
import { setKatex, render, installBeamer, NEWPAGE, BOX_MAX, BOX_KEY, boxCost, fitsBoxes, NAME_MAX, NAME_TOTAL } from "./engine/render.mjs";
import { itemKey } from "./engine/sagetex.mjs";
import * as beamerCode from "./engine/beamer.mjs";

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

// ---- images.ts: the resolver (as TeX: the file's folder, then \graphicspath's; up with ../, never above the top) and the sniffer
const doc = "/papers/a/main.tex";
const ok = (arg) => { const r = imageCandidates(arg, doc); return r.ok ? r.paths : r.why; };
check("img-plain", JSON.stringify(ok("fig.png")) === JSON.stringify(["/papers/a/fig.png"]), ok("fig.png"));
check("img-no-ext", ok("fig").length === 7 && ok("fig")[0] === "/papers/a/fig" && ok("fig")[1] === "/papers/a/fig.png", ok("fig"));
check("img-subfolder", ok("img/x.svg")[0] === "/papers/a/img/x.svg", ok("img/x.svg"));
for (const [n, a] of [["url", "https://x/y.png"], ["pct", "fig%2f..%2fx.png"], ["pct-dot", "%2e%2e/x.png"], ["backslash", "a\\b.png"], ["above-top", "../../../x.png"], ["nul", "a\u0000b"], ["data", "data:image/png;base64,AAAA"]])
  check("img-refused-" + n, typeof ok(a) === "string", ok(a));
// (William's L2, Nov 2: cv.tex in "LaTeX examples/", images.png at the top: TeX names it ../images.png)
check("img-parent", JSON.stringify(ok("../fig.png")) === JSON.stringify(["/papers/fig.png"]) && ok("../../top.png")[0] === "/top.png", [ok("../fig.png"), ok("../../top.png")]);
// (William, Nov 2: a leading "/" is the workspace's top folder, never the real filesystem's; searched alone, as TeX does)
check("img-leading-slash", JSON.stringify(ok("/abs.png")) === JSON.stringify(["/abs.png"]) && ok("/d/x")[0] === "/d/x" && imageCandidates("/x.png", doc, ["figs/"]).searched.join() === "/"
  && imageCandidates("/x.png", "/c/w/a.tex", [], "/c/w").paths[0] === "/c/w/x.png" && typeof ok("/../x.png") === "string" && !imageCandidates("/../x.png", "/c/w/a.tex", [], "/c/w").ok, [ok("/abs.png"), imageCandidates("/x.png", "/c/w/a.tex", [], "/c/w")]);
check("img-leading-slash-hint", notFoundWhy("/ex/cv.tex", ["/"], [], false, "/images.png") === "not found in the top folder (a leading / is the workspace's top folder)", notFoundWhy("/ex/cv.tex", ["/"], [], false, "/images.png"));
check("img-dot-and-sibling", ok("./x.png")[0] === "/papers/a/x.png" && ok("a//b.png")[0] === "/papers/a/a/b.png" && ok("../ab/x.png")[0] === "/papers/ab/x.png", [ok("./x.png"), ok("../ab/x.png")]);
{
  const r = imageCandidates("fig", doc, ["figs/", "../shared/", "/abs/", "../../../../up/"]);
  check("img-graphicspath", r.ok && r.paths[0] === "/papers/a/fig" && r.paths.includes("/papers/a/figs/fig.png") && r.paths.includes("/papers/shared/fig.png") && JSON.stringify(r.searched) === JSON.stringify(["/papers/a", "/papers/a/figs", "/papers/shared"]), r);
  const gp = graphicsPathOf("\\documentclass{article}\n% \\graphicspath{{no/}}\n\\graphicspath{ {figs/} {../shared/} }\n\\begin{document}\n\\graphicspath{{late/}}\n");
  check("graphicspath-of", JSON.stringify(gp) === JSON.stringify(["figs/", "../shared/"]) && graphicsPathOf("\\begin{document}x").length === 0, gp);
  const w = notFoundWhy("/LaTeX examples/cv.tex", ["/LaTeX examples"], ["/images.png"]);
  check("img-not-found-why", w === 'not found in "LaTeX examples/"; it is in the top folder: write {../images.png}, or move the file into "LaTeX examples/"' && notFoundWhy("/cv.tex", ["/"]) === "not found in the top folder"
    && notFoundWhy("/p/a/cv.tex", ["/p/a", "/p/a/figs"], ["/p/x.png"], true) === 'not found in this file\'s folder, "figs/"; it is in "../": write {../x.png}, or move the file into this file\'s folder', [w, notFoundWhy("/p/a/cv.tex", ["/p/a", "/p/a/figs"], ["/p/x.png"], true)]);
  check("not-found-top-relative", notFoundWhy("/ex/cv.tex", ["/ex"], ["/top.svg"], true) === 'not found in this file\'s folder; it is in "../": write {../top.svg}, or move the file into this file\'s folder', notFoundWhy("/ex/cv.tex", ["/ex"], ["/top.svg"], true));
  check("relative-path", relativePath("/a/b", "/a/c/x.png") === "../c/x.png" && relativePath("/", "/x.png") === "x.png" && relativePath("/a", "/a/x.png") === "x.png", null);
}
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
// (a beamer slide is one box: kept whole up to PIECE_MAX, however many paragraphs it has; over it, a placeholder)
{
  const slide = (k) => '<section class="slide" data-frame="1" id="frame-1" style="aspect-ratio:128/96;--sfs:3.032"><div class="slide-body">' + '<div class="p">' + "z ".repeat(400) + "</div>".repeat(1) + "".padEnd(0) + '<div class="p">w</div>'.repeat(k) + "</div></section>";
  const whole = splitChunk(slide(4000)), big = splitChunk(slide(40000));
  check("split-slide-kept-whole", whole.length === 1 && whole[0] === slide(4000) && bytes(slide(4000)) > 32 * 1024, bytes(slide(4000)));
  check("split-slide-over-max-placeholder", big.length === 1 && /this slide is too large/.test(big[0]) && bytes(slide(40000)) > PIECE_MAX, bytes(slide(40000)));
  // (the placeholder is still that slide, its own open tag: Present and the tools count every frame; and the warning
  //  latex check gives, at the chunk's place, with the size and the limit)
  const open = slide(0).slice(0, slide(0).indexOf("<div"));
  const told = []; const big2 = splitChunk(slide(40000), (why, size) => told.push(tooLargeProblem(why, size, 61)));
  check("split-slide-placeholder-is-the-slide", big2.length === 1 && big2[0].startsWith(open) && big2[0].endsWith("</section>") && /class="placeholder toolarge"/.test(big2[0]), big2[0].slice(0, 300));
  check("split-too-large-told", told.length === 1 && told[0].kind === "toolarge" && told[0].at === 61 && /^this slide is too large \(\d+ KiB, over 128 KiB\)$/.test(told[0].name), told);
  // (a \sageplot's data: URL over PIECE_MAX: not counted, the slide kept whole, nothing told; the same in a paragraph)
  const plot = '<img class="sageplot" alt="a plot" src="data:image/svg+xml;base64,' + "A".repeat(PIECE_MAX * 2) + '" style="width:50%">';
  const ps2 = slide(0).replace('<div class="slide-body">', '<div class="slide-body">' + plot), told2 = [];
  const kept = splitChunk(ps2, () => told2.push(1));
  check("split-slide-data-url-not-counted", bytes(ps2) > 2 * PIECE_MAX && kept.length === 1 && kept[0] === ps2 && told2.length === 0, { n: bytes(ps2), pieces: kept.length, told: told2.length });
  const pp = '<div class="p">a ' + plot + " b</div>";
  check("split-paragraph-data-url-not-counted", (() => { const t = splitChunk(pp); return t.length === 1 && t[0] === pp; })(), null);
  // (but the markup still counts: the same plot with a slide too large otherwise, a placeholder; and CHUNK_MAX counts it all)
  check("split-slide-data-url-markup-still-counted", /this slide is too large/.test(splitChunk(slide(40000).replace('<div class="slide-body">', '<div class="slide-body">' + plot))[0]), null);
  check("split-data-url-over-chunk-max-placeholder", (() => { const t = splitChunk('<div class="p"><img src="data:image/png;base64,' + "B".repeat(CHUNK_MAX) + '"></div>'); return t.length === 1 && /too large/.test(t[0]); })(), null);
  const over = slide(0).replace('<div class="slide-body">', '<div class="slide-body"><div class="p">' + "q ".repeat(CHUNK_MAX / 2 + 10) + "</div>"), told3 = [];
  const ov = splitChunk(over, (why, size) => told3.push(tooLargeProblem(why, size, 5)));
  check("split-slide-over-chunk-max-still-the-slide", bytes(over) > CHUNK_MAX && ov.length === 1 && ov[0].startsWith(open) && ov[0].endsWith("</section>") && /this slide is too large/.test(ov[0]) && /over 2048 KiB/.test(told3[0]?.name ?? ""), { head: ov[0].slice(0, 200), told3 });
  check("split-weight", weight('<div class="p"><img class="sageplot" src="data:abc" alt="x"> é</div>') === bytes('<div class="p"><img class="sageplot" src="data:abc" alt="x"> é</div>') - "data:abc".length && weight("src=\"data:zz\" text") === bytes("src=\"data:zz\" text"), null);
}
check("split-small-unchanged", splitChunk('<div class="p">hi</div>')[0] === '<div class="p">hi</div>', null);

// ---- highlight.ts: the tokenizer's states
const run = (line, st) => { const g = tokenizeLine(line, st); const toks = []; for (;;) { const r = g.next(); if (r.done) return { toks, end: r.value }; toks.push(r.value); } };
check("hl-normal", run("Hello \\emph{x} % c", "N").end === "N" && run("Hello \\emph{x} % c", "N").toks.some(([c, t]) => c === "c-cmt" && t === "% c"), null);
check("hl-math-open", run("text $x+1", "N").end === "M" && run("y$ more", "M").end === "N", null);
check("hl-verbatim-state", run("\\begin{verbatim}", "N").end === "V:verbatim" && run("$ % \\x", "V:verbatim").end === "V:verbatim" && run("\\end{verbatim} after", "V:verbatim").end === "N", null);
check("hl-display", run("\\[ a", "N").end === "D" && run("b \\]", "D").end === "N" && run("$$ a", "N").end === "D", null);
check("hl-mathenv", run("\\begin{align}", "N").end === "E:align" && run("\\end{align}", "E:align").end === "N", null);
// (a math environment's \begin and \end in the same color, math's, as $ and \[ \] are; a non-math environment's both
//  plain commands; one nested in math, both math)
{
  const cls = (line, st) => run(line, st).toks.find(([, t]) => t.startsWith("\\begin") || t.startsWith("\\end"))?.[0];
  check("hl-mathenv-begin-end-same-color", cls("\\begin{align}", "N") === "c-math c-cmd" && cls("\\end{align}", "E:align") === "c-math c-cmd" && cls("\\begin{itemize}", "N") === "c-cmd" && cls("\\end{itemize}", "N") === "c-cmd" && cls("\\begin{pmatrix}", "E:align") === "c-math c-cmd" && cls("\\end{pmatrix}", "E:align") === "c-math c-cmd",
    { begin: cls("\\begin{align}", "N"), end: cls("\\end{align}", "E:align") });
}
// (a blank line ends inline and display math, as in TeX; not a math environment, not verbatim)
check("hl-blank-ends-math", run("", "M").end === "N" && run("  \t", "D").end === "N" && run("", "E:align").end === "E:align" && run("", "V:verbatim").end === "V:verbatim" && run("% c", "M").end === "M", null);

// ---- beamer's code, a chunk of its own (engine/beamer.mjs; first here, as installing it is for the process): until it is
//      installed, a document that needs it (the class beamer, or an overlay command in any class) says so and renders
//      without it; installed, the same text renders its frames and steps, without being expanded again
{
  setKatex((src) => src);
  const beamerDoc = "\\documentclass{beamer}\n\\begin{document}\n\\begin{frame}{T}\nA \\pause B\n\\end{frame}\n\\end{document}\n";
  const e = new Engine(), before = e.update(beamerDoc);
  const overlay = new Engine().update("\\documentclass{article}\n\\begin{document}\nX \\only<2>{Y}\n\\end{document}\n");
  const plain = new Engine().update("\\documentclass{article}\n\\begin{document}\nX \\alert{Y}\n\\end{document}\n");
  // (a beamer document's frame environment, \frame{} and blocks, before the chunk: rendered as unknown ones, no error)
  const early = new Engine().update("\\documentclass{beamer}\n\\begin{document}\n\\frame{F}\n\\begin{frame}G\\end{frame}\n\\begin{block}{T}H\\end{block}\n\\end{document}\n");
  const eh = early.chunks.join("");
  check("beamer-chunk-before-install", early.needBeamer && early.stats.outcome === "ok" && ["F", "G", "H"].every((x) => eh.includes(x)) && !eh.includes('class="slide') && !eh.includes("bblock"), eh.slice(0, 400));
  check("beamer-chunk-needed", before.needBeamer && !before.chunks.join("").includes('class="slide') && overlay.needBeamer && !plain.needBeamer, { before: before.needBeamer, overlay: overlay.needBeamer, plain: plain.needBeamer });
  // (needed however the overlay command or the class is reached: from a macro, from an \input file, the class with options)
  const needs = (doc, ei) => new Engine().update(doc, ei ? { inputs: { files: ei.files, resolve: ei.resolve, version: 1 } } : {}).needBeamer;
  const art = (body) => "\\documentclass{article}\n\\begin{document}\n" + body + "\n\\end{document}\n";
  const viaInput = (await import("./inputs.ts")).engineInputs("/b/doc.tex", new Map([["/b/part.tex", { text: "P \\uncover<2>{Q}\n" }]]));
  const ways = { macro: needs(art("\\newcommand{\\later}[1]{\\pause #1}\\later{Z}")), input: needs(art("\\input{part}"), viaInput),
    options: needs("\\documentclass[handout,aspectratio=169,11pt]{beamer}\n\\begin{document}\nX\n\\end{document}\n"), preamble: needs("\\documentclass{article}\n\\only<1>{}\n\\begin{document}\nX\n\\end{document}\n"),
    each: ["only", "uncover", "visible", "invisible", "pause", "onslide", "alt"].every((c) => needs(art("\\" + c + "<2>{A}{B}"))) };
  check("beamer-chunk-needed-every-way", Object.values(ways).every(Boolean), ways);
  // (a chunk that can't be loaded: the render without it, saying why; one that can: the render again)
  const failed = await withBeamer(new Engine().update(beamerDoc), () => Promise.reject(new Error("HTTP 404")), () => null);
  check("beamer-chunk-load-failed", failed.chunks[0].includes("could not be loaded (HTTP 404); reload the page to try again.") && failed.problems.some((p) => p.kind === "beamer" && p.name === "HTTP 404")
    && failed.chunkPos[0] === -1 && failed.chunkPos.length === failed.chunks.length, { first: failed.chunks[0], pos: failed.chunkPos.length, chunks: failed.chunks.length });
  // (the reason is the error's text: escaped in the notice, and cut at 200 characters)
  const tagged = await withBeamer(new Engine().update(beamerDoc), () => Promise.reject(new Error("<b>x</b>")), () => null);
  const long = await withBeamer(new Engine().update(beamerDoc), () => Promise.reject(new Error("y".repeat(300))), () => null);
  const longWhy = long.problems.find((p) => p.kind === "beamer")?.name;
  check("beamer-chunk-load-failed-why", tagged.chunks[0].includes("(&lt;b&gt;x&lt;/b&gt;)") && !tagged.chunks[0].includes("<b>x") && longWhy === "y".repeat(200) && long.chunks[0].includes("(" + "y".repeat(200) + ")"), { tagged: tagged.chunks[0], longWhy: longWhy?.length });
  let again = 0, plainLoads = 0; const ok = await withBeamer(new Engine().update(beamerDoc), async () => {}, () => (again++, "again")), none = await withBeamer(plain, async () => { plainLoads++; }, () => "again");
  check("beamer-chunk-loaded-renders-again", ok === "again" && again === 1 && none === plain && plainLoads === 0, { ok, again, plainLoads });
  // (the worker's fetch, once(): one load for every caller, a failed one too; each later render says reload)
  let loads = 0; const fail = once(() => (++loads, Promise.reject(new Error("x")))), good = once(() => (++loads, Promise.resolve("m")));
  const r1 = await fail().catch((e) => e.message), r2 = await fail().catch((e) => e.message), r3 = await good(), r4 = await good();
  const again1 = await withBeamer(new Engine().update(beamerDoc), fail, () => null);
  check("beamer-chunk-once", r1 === "x" && r2 === "x" && r3 === "m" && r4 === "m" && loads === 2 && again1.chunks[0].includes("(x); reload the page to try again."), { r1, r2, r3, r4, loads });
  // (the worker's early fetch: a source that declares beamer, with options, spaces, after blank or comment lines, its first
  //  \documentclass the one read (a later one is text, here in \verb); not one in a
  //  comment, another class, or beamer only mentioned)
  const decl = ["\\documentclass{beamer}", "\n  \\documentclass[handout, 11pt] {beamer}\n", "\\documentclass [t]{beamer}", "\\documentclass{beamer}\n\\begin{document}\nWrite \\verb|\\documentclass{article}| for a paper.",
    "% a talk\n\n  %% (draft)\n\\documentclass{beamer}", "\ufeff\\documentclass{beamer}",
    "\\RequirePackage{fix-cm}\n\\PassOptionsToClass{t}{beamer} % for the slides\n\\RequirePackage[l2tabu]{nag}\n\\documentclass{beamer}",
    "% my talk\n\\documentclass{beamer}", "\\documentclass{beamer} % x"].map(declaresBeamer);
  // (and daybreak3's, BEAMER641-DECL-1: a declaration quoted or stored before the file's own, or after a \\; anything
  //  else first (\listfiles), or on \RequirePackage's line, isn't known either: needBeamer's; nor a class beamerx, nor {beamer}
  //  later after another class (grader S7), nor { beamer }, which TeX's own reading fails (it looks for "beamer .cls"))
  const notDecl = ["% \\documentclass{beamer}", "\\documentclass{article}\n\\usepackage{beamerarticle}", "\\documentclass{beamerposter}", "beamer", "x % y \\documentclass{beamer}",
    "\\verb|\\documentclass{beamer}|\n\\documentclass{article}", "\\newcommand{\\x}{%\n\\documentclass{beamer}}\n\\documentclass{article}", "\\\\documentclass{beamer}",
    "x\\\\\n\\documentclass{beamer}", "\\begin{verbatim}\n\\documentclass{beamer}\n\\end{verbatim}\n\\documentclass{article}", "%\\documentclass{beamer}",
    "\\listfiles\n\\documentclass{beamer}", "\\RequirePackage{fix-cm}\\documentclass{beamer}", "\\documentclass{beamerx}",
    "\\verb|\\documentclass{beamer}|", "\\begin{verbatim}\n\\documentclass{beamer}\n\\end{verbatim}", "\\newcommand{\\x}{%\n\\documentclass{beamer}}",
    "\\\\documentclass{beamer}\n\\documentclass{article}", "\\documentclass{article}\\title{beamer}", "\\documentclass{article}\n\\title{beamer}",
    "\\documentclass{ beamer }"].map(declaresBeamer);
  check("beamer-chunk-declared", decl.every(Boolean) && !notDecl.some(Boolean), { decl, notDecl });
  // (linear on malformed declarations a MiB long (astra BEAMER641-SCAN-1: the regex before was quadratic in them, over 3 s
  //  at 64 KiB): spaces with no class, an option list never closed, a class brace never closed)
  const MiB = 1 << 20, bad = ["\n".repeat(MiB) + "x\\documentclass{beamer}", "%\n".repeat(MiB / 2) + "\\documentclass" + " ".repeat(MiB), "\\documentclass" + " ".repeat(MiB) + "x", "\\documentclass[" + "a ".repeat(MiB / 2), "\\documentclass  {" + " ".repeat(MiB), " ".repeat(MiB) + "\\documentclass" + " \t".repeat(MiB / 2)];
  const t0 = performance.now(), badRes = bad.map(declaresBeamer), scanMs = performance.now() - t0;
  check("beamer-chunk-declared-linear", !badRes.some(Boolean) && scanMs < 250, { badRes, scanMs });
  // (the window: a class past 1 KiB after \documentclass isn't looked for (needBeamer finds it); within it, it is)
  check("beamer-chunk-declared-window", !declaresBeamer("\\documentclass" + " ".repeat(2000) + "{beamer}") && declaresBeamer("\\documentclass" + " ".repeat(900) + "{beamer}"));
  installBeamer(beamerCode);
  const after = e.update(beamerDoc);
  check("beamer-chunk-installed", !after.needBeamer && after.stats.mode === "unchanged" && after.frames.length === 1 && after.frames[0].steps === 2 && after.chunks.join("").includes('class="slide'), { need: after.needBeamer, mode: after.stats.mode, frames: after.frames });
}

// ---- saved boxes (astra4's fidelity digest, gap 3: \sbox, \savebox and \usebox were dropped, with no problem said). The
//      first is astra4's M14 as is; TeX's text for it: "VisibleText"
{
  setKatex((src) => src);
  const run = (body, pre = "") => new Engine().update("\\documentclass{article}\n" + pre + "\\begin{document}\n" + body + "\n\\end{document}\n");
  const text = (r) => r.chunks.join("").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const m14 = run("\\newsavebox{\\saved}\\sbox{\\saved}{VisibleText}\\usebox{\\saved}");
  check("savebox-m14", text(m14) === "VisibleText" && !m14.problems.length, [text(m14), m14.problems]);
  // (each \usebox shows it again; saved in the preamble, shown in the body; nothing where it's saved)
  const twice = run("A \\usebox{\\bx} B \\usebox{\\bx}", "\\newsavebox{\\bx}\\sbox{\\bx}{\\textbf{Kept}}\n");
  check("savebox-reused-from-preamble", text(twice) === "A Kept B Kept", text(twice));
  // (\savebox's width and position as \makebox's; lrbox's body; a box never saved: nothing shown, a problem said)
  const sb = run("\\newsavebox{\\w}\\savebox{\\w}[3cm][r]{Wide}[\\usebox{\\w}]").chunks.join("");
  const lr = run("\\newsavebox{\\l}\\begin{lrbox}{\\l}Inside \\emph{it}\\end{lrbox}Out: \\usebox{\\l}");
  const none = run("X \\usebox{\\nothere} Y");
  check("savebox-width-lrbox-unsaved", /<span class="mkbox" style="width:[^"]*;text-align:right">Wide<\/span>/.test(sb) && /\[<span class="mkbox"/.test(sb) && text(lr) === "Out: Inside it"
    && text(none) === "X Y" && none.problems.some((p) => p.kind === "box" && p.name.includes("\\nothere")), [sb.slice(0, 300), text(lr), text(none), none.problems]);
  // (a minipage, and beamer's column (which shares its code), still show their content: lrbox is a case of its own)
  const mp = text(run("\\begin{minipage}{3cm}InMini\\end{minipage}"));
  const col = new Engine().update("\\documentclass{beamer}\n\\begin{document}\n\\begin{frame}{F}\\begin{columns}\\begin{column}{0.5\\textwidth}InColumn\\end{column}\\end{columns}\\end{frame}\n\\end{document}\n").chunks.join("");
  check("savebox-minipage-column-unchanged", mp === "InMini" && /class="minipage[^"]*"[^>]*>[\s\S]*InColumn/.test(col), [mp, col.slice(0, 300)]);
  // (a box's SageTeX: shown where the box is used, hidden (as before) if it never is)
  const sageBox = (use) => run("\\newsavebox{\\sb}\\sbox{\\sb}{\\sage{1+1}}" + (use ? "\\usebox{\\sb}" : "Z"), "\\usepackage{sagetex}\n").sageItems.map((x) => x.err ?? "ok");
  check("savebox-sage", sageBox(true).join() === "ok" && sageBox(false).join() === "hidden", [sageBox(true), sageBox(false)]);
  // (a box's SageTeX is shown only where the box is: not by a \usebox inside a box never used, nor in a title never
  //  printed, nor in the preamble (daybreak3 BOX653-SAGE-CAPTURE-1, astra BOX653-HIDDEN-2); controls: used in the body,
  //  in a printed title)
  const sageOf = (pre, body) => run(body, "\\usepackage{sagetex}\n\\newsavebox{\\a}\\newsavebox{\\b}\\sbox{\\a}{\\sage{1+1}}\n" + pre).sageItems.map((x) => x.err ?? "ok").join();
  const capture = { nested: sageOf("", "\\sbox{\\b}{\\usebox{\\a}}Z"), nestedUsed: sageOf("", "\\sbox{\\b}{\\usebox{\\a}}\\usebox{\\b}"),
    title: sageOf("\\title{\\usebox{\\a}}\n", "Z"), titlePrinted: sageOf("\\title{\\usebox{\\a}}\n", "\\maketitle Z"), preamble: sageOf("\\usebox{\\a}\n", "Z") };
  // (a box saved again holds its new content, as in TeX, and the old content's SageTeX isn't shown by its use (grader
  //  X7); the name as written, spaces around it aside (X3))
  const redef = run("\\newsavebox{\\s}\\sbox{\\s}{\\sage{1+1}A}\\sbox{\\s}{B}\\usebox{\\s}", "\\usepackage{sagetex}\n");
  const trim = text(run("\\newsavebox{\\saved}\\sbox{\\saved}{T}\\usebox{ \\saved }"));
  const body = (r) => r.chunks.filter((c) => !c.includes('class="sagestate"')).join("").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  check("savebox-redefined-and-trimmed", body(redef) === "B" && redef.sageItems.map((x) => x.err).join() === "hidden" && trim === "T", [body(redef), redef.sageItems.map((x) => x.err), trim]);
  check("savebox-sage-where-shown", capture.nested === "hidden" && capture.nestedUsed === "ok" && capture.title === "hidden" && capture.titlePrinted === "ok" && capture.preamble === "hidden", capture);
  // (the copies' budget (astra BOX653-EXPAND-1): exactly BOX_MAX fits, one over doesn't; a box doubled into itself 12
  //  times (16.8M characters before) stops within it, said once; repeated uses count too)
  check("savebox-budget-edge", fitsBoxes(BOX_MAX - 10, 10) && !fitsBoxes(BOX_MAX - 10, 11) && fitsBoxes(0, BOX_MAX) && !fitsBoxes(0, BOX_MAX + 1));
  const dbl = run("\\newsavebox{\\s}\\sbox{\\s}{" + "x".repeat(4096) + "}" + "\\sbox{\\s}{\\usebox{\\s}\\usebox{\\s}}".repeat(12) + "\\usebox{\\s}");
  const many = run("\\newsavebox{\\s}\\sbox{\\s}{" + "y".repeat(4096) + "}" + "\\usebox{\\s} ".repeat(300) + "End.");
  const dblH = dbl.chunks.join(""), manyH = many.chunks.join(""), over = (r) => r.problems.filter((p) => p.kind === "box" && /over the budget/.test(p.name)).length;
  check("savebox-budget-copies", dbl.stats.outcome === "ok" && dblH.length < 2 * 2 ** 20 && over(dbl) === 1 && manyH.length < 2 * 2 ** 20 && over(many) === 1 && manyH.includes("End.") && (manyH.match(/y{4096}/g) || []).length === Math.floor(BOX_MAX / 4096),
    { dbl: dblH.length, many: manyH.length, copies: (manyH.match(/y{4096}/g) || []).length, overs: [over(dbl), over(many)] });
  // (a box's SageTeX items count too, each once in the box (astra, BOX653-EXPAND-1's residual): a box with no HTML, a
  //  completed sagesilent in an lrbox, doubled into itself 18 times held 262,144 keys before, and now holds 1. A key
  //  costs BOX_KEY: 256 completed items in a box, no HTML, cost exactly 4,096, so 256 uses fit BOX_MAX exactly and a 257th
  //  is left out, said once)
  check("savebox-key-cost", BOX_KEY === 16 && boxCost({ h: "ab", keys: [1, 2, 3] }) === 2 + 3 * BOX_KEY && boxCost({ h: "", keys: [] }) === 0);
  const sdoc = (body) => "\\documentclass{article}\n\\usepackage{sagetex}\n\\newsavebox{\\kb}\n\\begin{document}\n" + body + "\n\\end{document}\n";
  // (the items run, as a Run leaves them: their states from the box used once, before any copies)
  const okRun = (box, uses) => {
    const d = sdoc(box + uses), states = new Engine().update(sdoc(box + "\\usebox{\\kb}Z")).sageItems.map((it) => ({ s: "ok", key: itemKey(it) })), kept = [], set = Map.prototype.set;
    // (each box as saved, seen as the renderer's map stores it: its HTML and its keys' count)
    Map.prototype.set = function (k, v) { if (v && typeof v.h === "string" && Array.isArray(v.keys)) kept.push([v.h.length, v.keys.length]); return set.call(this, k, v); };
    try { return { r: new Engine({ sage: { states } }).update(d), kept }; } finally { Map.prototype.set = set; }
  };
  const silent = (i) => "\\begin{sagesilent}\nx" + i + " = " + i + "\n\\end{sagesilent}\n";
  const zero = okRun("\\begin{lrbox}{\\kb}" + silent(0) + "\\end{lrbox}", "\\sbox{\\kb}{\\usebox{\\kb}\\usebox{\\kb}}".repeat(18) + "\\usebox{\\kb}Z");
  const keysAt = (n) => okRun("\\begin{lrbox}{\\kb}" + Array.from({ length: 256 }, (_, i) => silent(i)).join("") + "\\end{lrbox}", "\\usebox{\\kb}".repeat(n) + "Z");
  const fit = keysAt(256), past = keysAt(257);
  check("savebox-keys-zero-html-doubling", zero.r.stats.outcome === "ok" && zero.kept.length === 19 && zero.kept.every(([h, k]) => h === 0 && k === 1)
    && zero.r.sageItems.every((x) => !x.err) && over(zero.r) === 0, { kept: zero.kept.slice(-3), n: zero.kept.length, items: zero.r.sageItems.map((x) => x.err), overs: over(zero.r) });
  check("savebox-keys-budget-edge", fit.kept.length === 1 && fit.kept[0][0] === 0 && fit.kept[0][1] === 256 && over(fit.r) === 0 && over(past.r) === 1
    && fit.r.sageItems.length === 256 && fit.r.sageItems.every((x) => !x.err), { kept: [fit.kept, past.kept], overs: [over(fit.r), over(past.r)], errs: [...new Set(fit.r.sageItems.map((x) => x.err))] });
}

// ---- beamer's furniture (engine/beamer.mjs): what each theme draws around a frame, against TeX Live's beamer. The
//      words of frame 2's headline, sidebar and footline in the probe deck below are those of TeX's page 2 (pdftotext),
//      for a theme of each kind (probed 2026-11-04, all 27 themes the chunk knows of, TeX Live 2025)
{
  const deck = (pre, frames) => "\\documentclass{beamer}\n" + pre + "\\title[ShortTitle]{LongTitleWords}\n\\author[ShortAuthor]{LongAuthorName}\n" +
    "\\institute[ShortInst]{LongInstituteName}\n\\date[ShortDate]{LongDateText}\n\\begin{document}\n" + (frames ?? "\\begin{frame}\\titlepage\\end{frame}\n" +
    "\\section[SecOneShort]{SectionOneLong}\n\\subsection{SubOneA}\n\\begin{frame}{FrameTwo}BodyTwo\\end{frame}\n\\section{SectionTwo}\n" +
    "\\subsection{SubTwoA}\n\\begin{frame}{FrameThree}BodyThree\\end{frame}\n") + "\\end{document}\n";
  const html = (src) => new Engine().update(src).chunks.join("");
  const frameOf = (h, k) => (new RegExp('<section class="slide[^"]*" data-frame="' + k + '"[\\s\\S]*?</section>').exec(h) ?? [""])[0];
  const words = (h) => (h.replace(/<header class="slide-title">[\s\S]*?<\/header>|<div class="slide-body">[\s\S]*?<\/div><\/div>(?=<div class="slide-foot|<\/section>)/g, " ").replace(/<[^>]+>/g, " ").match(/[A-Za-z0-9]+|\//g) ?? []).sort().join(" ");
  const tex = { // (TeX's page 2, less FrameTwo and BodyTwo)
    Madrid: "/ 2 3 ShortAuthor ShortDate ShortInst ShortTitle", AnnArbor: "/ 2 3 SecOneShort ShortAuthor ShortDate ShortInst ShortTitle SubOneA",
    Antibes: "SecOneShort ShortTitle SubOneA", Berkeley: "SecOneShort SectionTwo ShortAuthor ShortTitle SubOneA SubTwoA",
    Berlin: "SecOneShort SectionTwo ShortAuthor ShortInst ShortTitle SubOneA", Darmstadt: "SecOneShort SectionTwo SubOneA",
    Szeged: "SecOneShort SectionTwo ShortInst ShortTitle SubOneA", Frankfurt: "SecOneShort SectionTwo",
    Warsaw: "SecOneShort SectionTwo ShortAuthor ShortTitle SubOneA", default: "", Rochester: "" };
  const got = Object.fromEntries(Object.keys(tex).map((t) => [t, words(frameOf(html(deck("\\usetheme{" + t + "}\n")), 2))]));
  check("beamer-furniture-as-tex", Object.keys(tex).every((t) => got[t] === tex[t]), Object.fromEntries(Object.keys(tex).filter((t) => got[t] !== tex[t]).map((t) => [t, got[t]])));
  // (the current section and subsection marked; the sidebar's room; an outer theme by name; frame 3 in its own section)
  const darm = html(deck("\\usetheme{Darmstadt}\n")), berk = html(deck("\\usetheme{Berkeley}\n"));
  check("beamer-furniture-current", /<span class="cur">SecOneShort<\/span> <span>SectionTwo<\/span>/.test(frameOf(darm, 2)) && /<span>SecOneShort<\/span> <span class="cur">SectionTwo<\/span>/.test(frameOf(darm, 3))
    && frameOf(berk, 2).startsWith('<section class="slide sbar"') && !frameOf(darm, 2).includes("sbar"), [frameOf(darm, 3).slice(0, 400), frameOf(berk, 2).slice(0, 80)]);
  const outer = words(frameOf(html(deck("\\useoutertheme{infolines}\n")), 3));
  check("beamer-furniture-outer-theme", outer === "/ 3 3 SectionTwo ShortAuthor ShortDate ShortInst ShortTitle SubTwoA", outer);
  // (the title page: the long forms, the short ones only in the furniture; \title[..] once showed "[")
  const tp = frameOf(html(deck("\\usetheme{Madrid}\n")), 1);
  check("beamer-short-forms-title-page", /<div class="title">LongTitleWords<\/div>/.test(tp) && tp.includes("LongAuthorName") && tp.includes("LongInstituteName") && tp.includes("LongDateText") && !/>\[</.test(tp) && tp.includes("ShortAuthor (ShortInst)"), tp.slice(0, 600));
  // (none on a plain frame; none of ours where the document sets the template; [frame number]: the number)
  const one = "\\begin{frame}[plain]{P}Q\\end{frame}\n\\begin{frame}{R}S\\end{frame}\n";
  const plain = html(deck("\\usetheme{Warsaw}\n", one));
  check("beamer-furniture-plain-frame", !/slide-(head|foot)/.test(frameOf(plain, 1)) && /slide-head/.test(frameOf(plain, 2)) && /slide-foot/.test(frameOf(plain, 2)), frameOf(plain, 1).slice(0, 300));
  const own = html(deck("\\usetheme{Warsaw}\n\\setbeamertemplate{footline}{mine}\n\\setbeamertemplate{headline}{mine too}\n", one)), num = html(deck("\\usetheme{Madrid}\n\\setbeamertemplate{footline}[frame number]\n", one));
  check("beamer-furniture-own-templates", !/slide-(head|foot)/.test(frameOf(own, 2)) && !own.includes("mine") && words(frameOf(num, 2)) === "/ 2 2", [frameOf(own, 2).slice(0, 300), words(frameOf(num, 2))]);
  const side = html(deck("\\usetheme{Berkeley}\n\\setbeamertemplate{sidebar left}{}\n", one));
  check("beamer-furniture-own-sidebar", !/slide-side|sbar/.test(frameOf(side, 2)), frameOf(side, 2).slice(0, 200));
  // (starred sections listed too, as TeX's beamer lists them (not in the contents); a short form's markup dropped, as
  //  TeX's text of it; a frame before any section: every section, none marked. TeX's: "Hidden Sh ort" on both frames)
  const secs = html(deck("\\usetheme{Frankfurt}\n", "\\begin{frame}{A}a\\end{frame}\n\\section*{Hidden}\n\\section[Sh \\emph{ort}]{Long}\n\\begin{frame}{B}b\\end{frame}\n"));
  check("beamer-furniture-sections", words(frameOf(secs, 1)) === "Hidden Sh ort" && !frameOf(secs, 1).includes('class="cur"') && /<span>Hidden<\/span> <span class="cur">Sh ort<\/span>/.test(frameOf(secs, 2)), [frameOf(secs, 1).slice(0, 300), frameOf(secs, 2).slice(0, 300)]);
  // (a section's second subsection: the current one, and split's list of them; a frame before the first: none current)
  const two = "\\section{A}\n\\begin{frame}{F0}x\\end{frame}\n\\subsection{A1}\n\\begin{frame}{F1}x\\end{frame}\n\\subsection{A2}\n\\begin{frame}{F2}x\\end{frame}\n";
  const dar2 = html(deck("\\usetheme{Darmstadt}\n", two)), war2 = html(deck("\\usetheme{Warsaw}\n", two));
  check("beamer-furniture-subsections", words(frameOf(dar2, 1)) === "A" && words(frameOf(dar2, 3)) === "A A2" && words(frameOf(war2, 3)) === "A A1 A2 ShortAuthor ShortTitle"
    && /<span>A1<\/span> <span class="cur">A2<\/span>/.test(frameOf(war2, 3)), [words(frameOf(dar2, 1)), words(frameOf(dar2, 3)), words(frameOf(war2, 3))]);
  // (the names read as words, as the page's text and a copy read them (innerText): spaced, not only apart)
  const text = (h) => h.replace(/<\/?(div|section|header)\b[^>]*>/g, "\n").replace(/<[^>]+>/g, "");   // (blocks a line apart, as innerText)
  check("beamer-furniture-words-spaced", text(frameOf(darm, 2)).includes("SecOneShort SectionTwo") && text(frameOf(berk, 2)).includes("SubOneA") && !/SubOneASectionTwo|SecOneShortSectionTwo/.test(text(frameOf(berk, 2) + frameOf(war2, 3))) && text(frameOf(war2, 3)).includes("A1 A2")
    && text(frameOf(html(deck("\\usetheme{Berkeley}\n", two)), 3)).includes("A1 A2"), [text(frameOf(darm, 2)), text(frameOf(berk, 2))]);
  // (a template set in the document's body: its argument read, not shown)
  const body = html(deck("\\usetheme{Warsaw}\n", "\\setbeamertemplate{footline}{mine}\n" + one));
  check("beamer-furniture-template-in-body", !body.includes("mine") && !/slide-foot/.test(frameOf(body, 2)), frameOf(body, 2).slice(0, 300));
  // (SageTeX in the furniture's fields (daybreak3, FURN644-SAGE-1): a field the furniture shows, long or short, is shown,
  //  not hidden, and its saved result drawn; one the theme doesn't draw stays hidden, as before)
  const sageDeck = (theme, title) => "\\documentclass{beamer}\n\\usetheme{" + theme + "}\n\\usepackage{sagetex}\n" + title + "\n\\begin{document}\n\\begin{frame}{F}x\\end{frame}\n\\end{document}\n";
  const sageRun = (src) => { const it = new Engine().update(src).sageItems; return new Engine({ sage: { saved: it.map((x) => ({ key: itemKey(x), s: "ok", latex: "42" })) } }).update(src); };
  const longF = sageRun(sageDeck("Madrid", "\\title{Long \\sage{6*7}}")), shortF = sageRun(sageDeck("Madrid", "\\title[Short \\sage{6*7}]{Long}")), unused = sageRun(sageDeck("Rochester", "\\title{Long \\sage{6*7}}"));
  const hiddenNote = (r) => /class="sagestate"><span class="sagechip s-error">\d+ Sage code item/.test(r.chunks.join(""));
  check("beamer-furniture-sage-shown", !hiddenNote(longF) && !hiddenNote(shortF) && /slide-foot[\s\S]*42/.test(frameOf(longF.chunks.join(""), 1)) && /slide-foot[\s\S]*Short[\s\S]*42/.test(frameOf(shortF.chunks.join(""), 1))
    && longF.sageItems.every((x) => x.err !== "hidden") && shortF.sageItems.every((x) => x.err !== "hidden") && hiddenNote(unused) && unused.sageItems.every((x) => x.err === "hidden"),
    { long: [hiddenNote(longF), longF.sageItems.map((x) => x.err)], short: [hiddenNote(shortF), shortF.sageItems.map((x) => x.err)], unused: [hiddenNote(unused), unused.sageItems.map((x) => x.err)] });
  // (the frame number is beamer's counter, which [noframenumbering] doesn't step (daybreak3, FURN644-FRAME-NO-1): TeX's
  //  1/2, 1/2, 2/2; a plain frame steps it, unless [noframenumbering] too; data-frame stays the frame's index)
  const nums = (src) => [...html(src).matchAll(/<span class="fno">([^<]*)<\/span>/g)].map((m) => m[1]);
  const nf = nums(deck("\\usetheme{Madrid}\n", "\\begin{frame}{A}a\\end{frame}\n\\begin{frame}[noframenumbering]{B}b\\end{frame}\n\\begin{frame}{C}c\\end{frame}\n"));
  const pf = nums(deck("\\usetheme{Madrid}\n", "\\begin{frame}[plain]{A}a\\end{frame}\n\\begin{frame}[plain,noframenumbering]{B}b\\end{frame}\n\\begin{frame}{C}c\\end{frame}\n"));
  const ids = html(deck("\\usetheme{Madrid}\n", "\\begin{frame}{A}a\\end{frame}\n\\begin{frame}[noframenumbering]{B}b\\end{frame}\n")).match(/data-frame="\d+"/g);
  check("beamer-furniture-frame-numbers", nf.join(",") === "1 / 2,1 / 2,2 / 2" && pf.join(",") === "2 / 2" && ids.join(",") === 'data-frame="1",data-frame="2"', { nf, pf, ids });
  // (the furniture's budget (astra, BEAMER644-FURN-1): exactly FURN_MAX fits, one byte over doesn't; a deck whose full
  //  headlines would be frames x sections of long names gets the short form, a problem saying so, its HTML bounded)
  check("beamer-furniture-budget-edge", beamerCode.fitsFurniture(beamerCode.FURN_MAX / 4, 4) && !beamerCode.fitsFurniture(beamerCode.FURN_MAX / 4 + 1, 4) && beamerCode.fitsFurniture(1, beamerCode.FURN_MAX) && !beamerCode.fitsFurniture(1, beamerCode.FURN_MAX + 1));
  const big = Array.from({ length: 384 }, (_, k) => "\\section{" + ("Section" + k + " ").padEnd(128, "x") + "}\n\\begin{frame}{F" + k + "}b\\end{frame}\n").join("");
  const bigR = new Engine().update(deck("\\usetheme{Berlin}\n", big)), bigH = bigR.chunks.join(""), small = html(deck("\\usetheme{Berlin}\n"));
  const f1 = frameOf(bigH, 1).match(/<div class="slide-head[^"]*"><div>([\s\S]*?)<\/div>/)?.[1] ?? "";
  check("beamer-furniture-budget-short-form", bigR.stats.outcome === "ok" && bigH.length < 3 * 2 ** 20 && (f1.match(/<span/g) || []).length === 1 && /Section0 x+\u2026/.test(f1)
    && bigR.problems.some((p) => p.kind === "furniture") && !new Engine().update(deck("\\usetheme{Berlin}\n")).problems.some((p) => p.kind === "furniture") && /SecOneShort<\/span> <span>SectionTwo/.test(small),
    { len: bigH.length, f1: f1.slice(0, 300), problems: bigR.problems.filter((p) => p.kind === "furniture") });
  // (the furniture's budget is for all of it, as built, escaping included (astra, FURN-1 residual): 10,000 Madrid frames
  //  with four fields of 80 "&" each was 19 MB; now the furniture stops within FURN_MAX, one problem saying from which
  //  frame. And SageTeX in a field the short form cuts stays hidden, the notice said (daybreak3, FURN644-SAGE-CUT-1); one
  //  within the cut is shown)
  const amp = "&".repeat(80), tenK = "\\title{" + amp + "}\\author{" + amp + "}\\institute{" + amp + "}\\date{" + amp + "}\n";
  const huge = new Engine().update(deck("\\usetheme{Madrid}\n" + tenK, "\\begin{frame}{F}Body\\end{frame}\n".repeat(10000))), hugeH = huge.chunks.join("");
  const furnBytes = (hugeH.match(/<div class="slide-foot">[\s\S]*?<\/div><\/div>/g) || []).join("").length, left = huge.problems.filter((p) => p.kind === "furniture" && /left out from frame \d+ on/.test(p.name));
  check("beamer-furniture-budget-all", huge.stats.outcome === "ok" && furnBytes <= beamerCode.FURN_MAX && left.length === 1 && hugeH.length < 4 * 2 ** 20 && /slide-foot/.test(frameOf(hugeH, 1)) && !/slide-foot/.test(frameOf(hugeH, 10000)),
    { furnBytes, html: hugeH.length, left });
  const bigSecs = Array.from({ length: 384 }, (_, k) => "\\section{" + ("S" + k).padEnd(128, "x") + "}\n\\begin{frame}{F}b\\end{frame}\n").join("");
  const cutDeck = (title) => "\\documentclass{beamer}\n\\usetheme{Madrid}\n\\usepackage{sagetex}\n" + title + "\n\\begin{document}\n" + bigSecs + "\\end{document}\n";
  // (a plain frame's furniture isn't drawn, so its fields' SageTeX stays hidden)
  const plainOnly = sageRun("\\documentclass{beamer}\n\\usetheme{Madrid}\n\\usepackage{sagetex}\n\\title{T \\sage{6*7}}\n\\begin{document}\n\\begin{frame}[plain]{F}x\\end{frame}\n\\end{document}\n");
  check("beamer-furniture-sage-plain", plainOnly.sageItems.every((x) => x.err === "hidden") && !/slide-foot/.test(plainOnly.chunks.join("")), plainOnly.sageItems.map((x) => x.err));
  const cutR = sageRun(cutDeck("\\title{" + "A".repeat(100) + " \\sage{6*7}}")), inR = sageRun(cutDeck("\\title{Short \\sage{6*7}}"));
  check("beamer-furniture-sage-cut", cutR.problems.some((p) => p.kind === "furniture") && cutR.sageItems.every((x) => x.err === "hidden") && hiddenNote(cutR) && !/42/.test(frameOf(cutR.chunks.join(""), 1)) && /A{70,}\u2026/.test(frameOf(cutR.chunks.join(""), 1))
    && inR.sageItems.every((x) => x.err !== "hidden") && !hiddenNote(inR) && /slide-foot[\s\S]*Short[\s\S]*42/.test(frameOf(inR.chunks.join(""), 1)),
    { cut: [cutR.sageItems.map((x) => x.err), hiddenNote(cutR)], within: [inR.sageItems.map((x) => x.err), hiddenNote(inR)], f1: frameOf(cutR.chunks.join(""), 1).slice(-300) });
  // (the footline templates' numbers as TeX's (TeX Live 2025): [frame number] "0/1" then "1/1" after a [noframenumbering]
  //  frame; [page number] each overlay step a page: "1/4", "2/4", "4/4" for frames of 1, 2 and 1 steps)
  const fnums = (src) => [...html(src).matchAll(/<div class="fno">([^<]*)<\/div>/g)].map((m) => m[1]).join(",");
  const fno = fnums(deck("\\setbeamertemplate{footline}[frame number]\n", "\\begin{frame}[noframenumbering]{A}a\\end{frame}\n\\begin{frame}{B}b\\end{frame}\n"));
  // ([page number] on a frame of 2 steps: "2/4" on step 1 and "3/4" on step 2, each an overlay of its step, as Present
  //  and each step's picture show them (daybreak3, PAGE644-OVERLAY-1))
  const pnoH = html(deck("\\setbeamertemplate{footline}[page number]\n", "\\begin{frame}[noframenumbering]{A}a\\end{frame}\n\\begin{frame}{B}b \\pause c\\end{frame}\n\\begin{frame}{C}d\\end{frame}\n"));
  const pno = [...pnoH.matchAll(/<div class="fno">([\s\S]*?)<\/div>/g)].map((m) => m[1]).join(",");
  check("beamer-furniture-number-templates", fno === "0/1,1/1" && pno === '1/4,<span class="ov" data-ov="1" data-ovm="only">2/4</span> <span class="ov" data-ov="2" data-ovm="only">3/4</span>,4/4', { fno, pno });
  // (the pages counted once a render, not once a frame (astra): 10,000 frames of [page number] take about as long as of
  //  [frame number]; counted per frame they took about 3 times as long)
  const tenKFrames = "\\begin{frame}{F}b\\end{frame}\n".repeat(10000), timeOf = (tpl) => { const t0 = performance.now(); new Engine().update(deck("\\setbeamertemplate{footline}[" + tpl + "]\n", tenKFrames)); return performance.now() - t0; };
  timeOf("frame number");
  const msFrame = timeOf("frame number"), msPage = timeOf("page number");
  check("beamer-furniture-page-numbers-linear", msPage < 1.6 * msFrame + 100, { frameMs: Math.round(msFrame), pageMs: Math.round(msPage) });
  // (the short form's cut text is escaped (grader F8: a field over the cut, decoded to measure it, is never HTML again)
  //  and cut to exactly 80 characters, the last "\u2026" (F10))
  const evil = "\\title{<img src=x onerror=alert(1)> \\& " + "B".repeat(100) + "}\\author{" + "C".repeat(100) + "}\n";
  const evilH = new Engine().update("\\documentclass{beamer}\n\\usetheme{Madrid}\n" + evil + "\\begin{document}\n" + bigSecs + "\\end{document}\n").chunks.join(""), evilF = frameOf(evilH, 1);
  const cells = [...(evilF.match(/<div class="slide-foot">([\s\S]*?)<\/div><\/div>/)?.[1] ?? "").matchAll(/<div>([\s\S]*?)<\/div>/g)].map((m) => m[1]);
  const visible = (h) => h.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  check("beamer-furniture-short-form-escaped", !/<img/.test(evilH) && /&lt;img src=x onerror=alert\(1\)&gt; &amp; B+\u2026/.test(evilF) && visible(cells[1] ?? "").length === 80 && visible(cells[0] ?? "") === "C".repeat(79) + "\u2026",
    { title: cells[1], author: cells[0], lens: cells.map((c) => visible(c).length) });
  // (in another class: \usetheme's and \setbeamertemplate's arguments read and dropped, \title[..] as TeX reads it there:
  //  its argument the "[")
  const art = new Engine().update("\\documentclass{article}\n\\usetheme{Madrid}\\setbeamertemplate{footline}{F}\n\\title[S]{T}\n\\begin{document}\n\\maketitle X \\only<2>{Y}\n\\end{document}\n").chunks.join("");
  check("beamer-furniture-other-class", !/Madrid|>F</.test(art) && !/slide-(head|foot)/.test(art) && art.includes("X") && /<div class="title">\[<\/div>/.test(art), art.slice(0, 300));
}

// ---- counters (astra4's fidelity digest, gap 1: the renderer's numbering ignored \setcounter and \footnote[n], silently).
//      M01..M06 as astra4 reduced them, with TeX Live's text for each; then \addtocounter, enumii, a footnote after [n]
{
  setKatex((src, o) => '<span class="K' + (o.displayMode ? "D" : "I") + '">' + src + "</span>");
  const text = (body) => new Engine().update("\\documentclass{article}\n\\begin{document}\n" + body + "\n\\end{document}\n").chunks.join("").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const cases = [
    ["ctr-m01-footnote-optional", "X\\footnote[7]{NoteText.}", (t) => /^X 7 .*7 NoteText\.$/.test(t)],
    ["ctr-m02-footnote-counter", "\\setcounter{footnote}{4}X\\footnote{NoteText.}", (t) => /^X 5 .*5 NoteText\.$/.test(t)],
    ["ctr-m03-figure", "\\setcounter{figure}{7}\\begin{figure}\\caption{CaptionText.}\\end{figure}", (t) => t.includes("Figure 8: CaptionText.")],
    ["ctr-m04-equation", "\\setcounter{equation}{9}\\begin{equation}1=1\\end{equation}", (t) => /\\tag\{10\}/.test(t) && !/\\tag\{1\}/.test(t)],
    ["ctr-m05-section", "\\setcounter{section}{4}\\section{HeadingText}", (t) => t === "5 HeadingText"],
    ["ctr-m06-enumerate", "\\begin{enumerate}\\setcounter{enumi}{3}\\item EntryText.\\end{enumerate}", (t) => t === "4. EntryText."],
    ["ctr-addtocounter", "\\section{A}\\addtocounter{section}{2}\\section{B}", (t) => t === "1 A 4 B"],
    ["ctr-enumii", "\\begin{enumerate}\\item P\\begin{enumerate}\\setcounter{enumii}{2}\\item Q\\end{enumerate}\\end{enumerate}", (t) => t === "1. P (c) Q"],
    ["ctr-enumi-from-inner", "\\begin{enumerate}\\item P\\begin{enumerate}\\item Q\\setcounter{enumi}{5}\\end{enumerate}\\item R\\end{enumerate}", (t) => /^1\. P .*Q .*6\. R$/.test(t) && !/2\. Q/.test(t)],
    ["ctr-footnote-after-optional", "A\\footnote[7]{N7.}B\\footnote{N1.}", (t) => /A 7 B 1 .*7 N7\. .*1 N1\./.test(t)],
  ];
  for (const [name, body, ok] of cases) { const t = text(body); check(name, ok(t), t); }
  // (#673 r2, each against TeX Live 2025's text for it: daybreak3 CTR673-FOOTNOTE-SIGNED-1, a signed \footnote[n] and the
  //  ordinary one after it, not stepped by it; CTR673-SECNUMDEPTH-1, secnumdepth both ways; grader's R7, enumi from an
  //  enumerate inside an itemize; enumiii and enumiv; TeX's limit: 99999999999 is "Number too big", 2147483647, and the
  //  \section's step after it wraps as TeX's does)
  const texCases = [
    ["ctr-footnote-signed", "A\\footnote[-2]{Neg}B\\footnote{Next}", "A -2 B 1 -2 Neg 1 Next"],
    ["ctr-secnumdepth-0", "\\setcounter{secnumdepth}{0}\\section{Sec}\\subsection{Sub}", "Sec Sub"],
    ["ctr-secnumdepth-4", "\\setcounter{secnumdepth}{4}\\section{Sec}\\subsection{Sub}\\subsubsection{SubSub}\\paragraph{Para} text", "1 Sec 1.1 Sub 1.1.1 SubSub 1.1.1.1 Para text"],
    ["ctr-secnumdepth-5", "\\setcounter{secnumdepth}{5}\\section{S}\\subsection{T}\\subsubsection{U}\\paragraph{P} x \\subparagraph{Q} y", "1 S 1.1 T 1.1.1 U 1.1.1.1 P x 1.1.1.1.1 Q y"],
    ["ctr-secnumdepth-default", "\\section{A}\\paragraph{P} x", "1 A P x"],
    ["ctr-secnumdepth-add", "\\addtocounter{secnumdepth}{-2}\\section{A}\\subsection{B}", "1 A B"],
    ["ctr-enumi-in-itemize", "\\begin{itemize}\\item A\\begin{enumerate}\\setcounter{enumi}{3}\\item B\\end{enumerate}\\end{itemize}", "\u2022 A 4. B"],
    ["ctr-enumiii", "\\begin{enumerate}\\item P\\begin{enumerate}\\item Q\\begin{enumerate}\\setcounter{enumiii}{3}\\item R\\end{enumerate}\\end{enumerate}\\end{enumerate}", "1. P (a) Q iv. R"],
    ["ctr-enumiv", "\\begin{enumerate}\\item P\\begin{enumerate}\\item Q\\begin{enumerate}\\item R\\begin{enumerate}\\setcounter{enumiv}{1}\\item S\\end{enumerate}\\end{enumerate}\\end{enumerate}\\end{enumerate}", "1. P (a) Q i. R B. S"],
    ["ctr-number-too-big", "\\setcounter{section}{99999999999}\\section{Big}", "-2147483648 Big"],
    ["ctr-number-too-big-negative", "\\setcounter{section}{-99999999999}\\section{BigNeg}", "-2147483646 BigNeg"],
  ];
  for (const [name, body, want] of texCases) { const t = text(body); check(name, t === want, [t, want]); }
  // (#673 r3, against TeX Live 2025: daybreak3 CTR673-CLASS-DEPTH-2, secnumdepth from the class (book, report 2, memoir
  //  1), so \addtocounter on it starts there; CTR673-PART-STEP-2, \part's step wraps as TeX's, and a part numbered 0 or
  //  less says "Part" with no numeral)
  const clsText = (cls, body) => new Engine().update("\\documentclass{" + cls + "}\n\\begin{document}\n" + body + "\n\\end{document}\n").chunks.join("").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const clsCases = [
    ["ctr-class-depth-book-add", "book", "\\addtocounter{secnumdepth}{-1}\\chapter{C}\\section{S}\\subsection{T}", "Chapter 1 C 1.1 S T"],
    ["ctr-class-depth-report-add", "report", "\\addtocounter{secnumdepth}{-1}\\chapter{C}\\section{S}\\subsection{T}", "Chapter 1 C 1.1 S T"],
    ["ctr-class-depth-book", "book", "\\chapter{C}\\section{S}\\subsection{T}\\subsubsection{U}", "Chapter 1 C 1.1 S 1.1.1 T U"],
    ["ctr-class-depth-memoir", "memoir", "\\chapter{C}\\section{S}\\subsection{T}", "Chapter 1 C 1.1 S T"],
    ["ctr-part-wrap", "article", "\\setcounter{part}{2147483647}\\part{P}", "Part P"],
    ["ctr-part-negative", "article", "\\setcounter{part}{-1}\\part{Q}", "Part Q"],
    ["ctr-part-too-big", "article", "\\setcounter{part}{99999999999}\\part{R}", "Part R"],
    ["ctr-part-starred", "article", "\\part{One}\\part*{Star}", "Part I One Star"],
  ];
  for (const [name, cls, body, want] of clsCases) { const t = clsText(cls, body); check(name, t === want, [t, want]); }
  // (grader's r2 pins: \footnote[n] past TeX's limit is "Number too big", clamped both ways, as TeX Live 2025 sets it; and a
  //  fragment with no \documentclass starts from article's secnumdepth, 3)
  check("ctr-footnote-too-big", text("A\\footnote[99999999999]{Big.}") === "A 2147483647 2147483647 Big.", text("A\\footnote[99999999999]{Big.}"));
  check("ctr-footnote-too-big-negative", text("A\\footnote[-99999999999]{Neg.}") === "A -2147483647 -2147483647 Neg.", text("A\\footnote[-99999999999]{Neg.}"));
  const frag = new Engine().update("\\addtocounter{secnumdepth}{-2}\\section{A}\\subsection{B}\n").chunks.join("").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  check("ctr-secnumdepth-no-class", frag === "1 A B", frag);
  // (grader K6: KOMA's scrbook and scrreprt are 2 deep too: TeX's "1 C 1.1 S 1.1.1 T U". The numbering only: KOMA's chapter
  //  heading has no "Chapter" word, which the preview still prints, a separate gap)
  for (const c of ["scrbook", "scrreprt"]) { const t = clsText(c, "\\chapter{C}\\section{S}\\subsection{T}\\subsubsection{U}"); check("ctr-class-depth-" + c, t.endsWith("1 C 1.1 S 1.1.1 T U"), t); }
  // (grader's R6: an optional argument that isn't a whole signed number is the counter, as before, and check says so; TeX
  //  would read its leading digits, \footnote[2a] as 2, and set the "a" as text)
  const notNum = new Engine().update("\\documentclass{article}\n\\begin{document}\nA\\footnote[2a]{X}B\n\\end{document}\n");
  const notNumT = notNum.chunks.join("").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  check("ctr-footnote-not-a-number", notNumT === "A 1 B 1 X" && notNum.problems.filter((p) => p.kind === "footnote" && /\\footnote\[2a\]: not a number/.test(p.name)).length === 1, [notNumT, notNum.problems]);
}

// ---- references (astra4's fidelity digest, gap 2: \\nameref gave a number, \\cref{a,b} and a \\label after \\section* gave ??,
//      silently). astra4's M07..M09, then two documents' every reference against TeX Live 2025's text for them (hyperref,
//      cleveref with its defaults; pdftotext, 2026-11-04)
{
  setKatex((src) => src);
  const text = (src) => new Engine().update(src).chunks.join("").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
  const art = (body, pre = "") => "\\documentclass{article}\n" + pre + "\\begin{document}\n" + body + "\n\\end{document}\n";
  const spaced = (src) => new Engine().update(src).chunks.join("").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const m07 = spaced(art("\\section{HeadingText}\\label{s}\\nameref{s}")), m08 = spaced(art("\\section{Alpha}\\label{a}\\section{Beta}\\label{b}\\cref{a,b}")), m09 = spaced(art("\\section{Alpha}\\section*{Beta}\\label{b}\\ref{b}"));
  check("ref-m07-m08-m09", m07 === "1 HeadingText HeadingText" && m08 === "1 Alpha 2 Beta sections 1 and 2" && m09 === "1 Alpha Beta 1", [m07, m08, m09]);
  const tex = { // (each document, then TeX's text from its "A[" on)
    c: ["\\documentclass{article}\n\\usepackage{hyperref}\n\\usepackage{cleveref}\n\\pagestyle{empty}\n\\begin{document}\n\\section{Alpha}\\label{s1}\n\\begin{equation}x\\label{e1}\\end{equation}\n\\begin{equation}y\\label{e2}\\end{equation}\n\\begin{figure}\\caption{Cap}\\label{f1}\\end{figure}\n\\section{Beta}\\label{s2}\n\\section{Gamma}\\label{s3}\n\\section*{Starred}\\label{st}\n\\subsection{Sub}\\label{ss}\nA[\\cref{s1}] B[\\cref{e1}] C[\\cref{f1}] D[\\cref{s1,s2}] E[\\cref{s1,s2,s3}] F[\\cref{e1,e2}] G[\\cref{s1,f1}] H[\\Cref{e1}] I[\\Cref{s1,s3}] J[\\cref{ss}] K[\\nameref{st}] L[\\ref{st}] M[\\nameref{e1}] N[\\nameref{f1}] O[\\cref{s3,s1}] P[\\cref{s1,nokey}]\n\\end{document}\n", "A[section 1] B[eq. (1)] C[fig. 1] D[sections 1 and 2] E[sections 1 to 3] F[eqs. (1) and (2)] G[section 1 and fig. 1] H[Equation (1)] I[Sections 1 and 3] J[section 3.1] K[Starred] L[3] M[Alpha] N[Cap] O[sections 1 and 3] P[section 1 and ??]"],
    d: ["\\documentclass{article}\n\\usepackage{hyperref}\n\\usepackage{cleveref}\n\\pagestyle{empty}\n\\begin{document}\n\\section{Alpha}\\label{s1}\n\\begin{equation}x\\label{e1}\\end{equation}\n\\begin{equation}y\\label{e2}\\end{equation}\n\\begin{equation}z\\label{e3}\\end{equation}\n\\begin{table}\\caption{T}\\label{t1}\\end{table}\n\\begin{figure}\\caption{Cap}\\label{f1}\\end{figure}\n\\section{Beta}\\label{s2}\n\\begin{enumerate}\\item a\\label{i1}\\item b\\label{i2}\\end{enumerate}\nA[\\Cref{s1,f1}] B[\\cref{e1,e2,e3}] C[\\cref{t1}] D[\\cref{s1,e2,s2}] E[\\cref{i1,i2}] F[\\Cref{t1,f1,s2}] G[\\cref{nokey}] H[\\cref{e3,e1}]\n\\end{document}\n", "A[Section 1 and fig. 1] B[eqs. (1) to (3)] C[table 1] D[sections 1 and 2 and eq. (2)] E[items 1 and 2] F[Table 1, fig. 1, and section 2] G[??] H[eqs. (1) and (3)]"],
  };
  tex.e = ["\\documentclass{article}\n\\usepackage{hyperref}\n\\usepackage{cleveref}\n\\pagestyle{empty}\n\\begin{document}\n\\section{S1}\\label{s1}\\subsection{A}\\subsection{B}\\label{ss12}\\subsubsection{C}\\paragraph{D}\\label{p}\n\\section{S2}\\label{s2}\\subsection{E}\\subsection{F}\\subsection{G}\\label{ss23}\\subsection{H}\\label{ss24}\n\\section{S3}\\label{s3}\\section{S4}\\section{S5}\\label{s5}\nA[\\cref{s1,s3,s5}] B[\\cref{nokey,nokey2}] C[\\ref{p}] D[\\cref{ss12,ss23,ss24}] E[$\\cref{zz}$]\n\\end{document}\n", "A[sections 1, 3 and 5] B[????] C[1.2.1] D[sections 1.2, 2.3 and 2.4] E[??]"];
  // (and a \\ref's link goes to the numbered heading it names, not to a starred one after it)
  const link = new Engine().update(art("\\section{Alpha}\\section*{Beta}\\label{b}\\ref{b}")).chunks.join("");
  check("ref-starred-link", /<h2 id="(sec-\d+)">[\s\S]*<a class="ref" href="#\1">1<\/a>/.test(link), link.slice(0, 400));
  // (a reference in math: KaTeX stubbed, so its source, \\text{..})
  for (const [k, [src, want]] of Object.entries(tex)) { const t = text(src).replace(/\\text\{([^}]*)\}/g, "$1"); check("ref-as-tex-" + k, t.slice(t.indexOf("A[")) === want, t.slice(t.indexOf("A["))); }
  // (#682 r2, each against TeX Live 2025 with hyperref and cleveref: daybreak3, a heading with a \ref in it, named by
  //  \nameref: its reference resolved ("See 1"), no placeholder left; a nested \nameref ("Cf. Beta"); a title that names
  //  itself is "??" (TeX: the heading "Loop ??", the \nameref "??"))
  const refDoc = (pre, body) => new Engine().update("\\documentclass{article}\n\\usepackage{hyperref}\n\\usepackage{cleveref}\n" + pre + "\n\\begin{document}\n" + body + "\n\\end{document}\n");
  const refText = (r) => r.chunks.join("").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  for (const [name, body, want] of [
    ["ref-nameref-with-ref", "\\section{Alpha}\\label{a}\\section{See \\ref{a}}\\label{b}X \\nameref{b} Y", "1 Alpha 2 See 1 X See 1 Y"],
    ["ref-nameref-nested", "\\section{Beta}\\label{a}\\section{Cf.\\ \\nameref{a}}\\label{b}X \\nameref{b} Y", "1 Beta 2 Cf. Beta X Cf. Beta Y"],
    ["ref-nameref-cycle", "\\section{Loop \\nameref{c}}\\label{c}X \\nameref{c} Y", "1 Loop ?? X ?? Y"],
  ]) { const r = refDoc("", body), h = r.chunks.join(""); check(name, refText(r) === want && !/[\u0001\u0002]/.test(h), [refText(r), want, /[\u0001\u0002]/.test(h)]); }
  // (and the text a \nameref brings in is escaped as the rest: "A \& B" named through another title)
  { const r = refDoc("", "\\section{A \\& B}\\label{a}\\section{Cf.\\ \\nameref{a}}\\label{b}X \\nameref{b} Y"), h = r.chunks.join("");
    check("ref-nameref-nested-escaped", refText(r).replace(/&amp;/g, "&") === "1 A & B 2 Cf. A & B X Cf. A & B Y" && !/A & B/.test(h), [refText(r), h.match(/Cf\.[^<]{0,20}/g)]); }
  // (astra REF682-EXPAND-1: \nameref's titles within bounds. Titles naming the one before twice each would double per level
  //  (depth 18: 3.1 MB before): each title at most NAME_MAX, cut and said once; titles that stay empty are worked out
  //  once each (depth 20: about 4 s without that, milliseconds with it); a chain of titles naming titles deeper than
  //  NAME_DEPTH is refused by name, and one within it resolves; all of a document's \nameref's together at most
  //  NAME_TOTAL characters, said once)
  {
    const dbl = (n, leaf, sep) => { let b = "\\section{" + leaf + "}\\label{s0}"; for (let k = 1; k <= n; k++) b += "\\section{\\nameref{s" + (k - 1) + "}" + sep + "\\nameref{s" + (k - 1) + "}}\\label{s" + k + "}"; return b + "X \\nameref{s" + n + "} Y"; };
    const fwd = (n) => { let b = ""; for (let k = 0; k < n; k++) b += "\\section{\\nameref{f" + (k + 1) + "}}\\label{f" + k + "}"; return b + "\\section{End}\\label{f" + n + "}X \\nameref{f0} Y"; };
    const said = (r, re) => r.problems.filter((p) => p.kind === "expansion" && re.test(p.name)).length;
    const d18 = refDoc("", dbl(18, "Leaf", " and ")), d18h = d18.chunks.join("");
    check("ref-nameref-doubling-bounded", d18.stats.outcome === "ok" && d18h.length < 25 * (NAME_MAX + 200) && said(d18, /a title past 4096 characters, cut/) === 1, { len: d18h.length, problems: d18.problems.map((p) => p.name) });
    const t0 = performance.now(), d20 = refDoc("", dbl(20, "", "")), ms = performance.now() - t0;
    check("ref-nameref-empty-titles-once", ms < 1500 && refText(d20).endsWith("X Y"), { ms: Math.round(ms), tail: refText(d20).slice(-20) });
    const deep = refDoc("", fwd(100)), within = refDoc("", fwd(63));
    // (the boundary (grader #682 R7): the first heading works its title out from the next label down, so a chain of 64
    //  below it is 64 titles deep, resolved, nothing said; 65 is one past the cut, refused there and said once)
    const at64 = refDoc("", fwd(64)), at65 = refDoc("", fwd(65));
    check("ref-nameref-depth-boundary", !at64.problems.length && refText(at64).endsWith("X End Y") && said(at65, /titles naming titles past 64 deep/) === 1 && !within.problems.length,
      [at64.problems.map((p) => p.name), at65.problems.map((p) => p.name)]);
    // (the cut is met, and said once, where the first heading works its title out from the top; the body's \nameref{f0},
    //  worked out after the headings below it have their titles whole, is "End", as TeX gives it: a title cut by depth
    //  is never kept for a shallower use (#682 r3, daybreak3))
    check("ref-nameref-deep-refused", refText(deep).endsWith("X End Y") && said(deep, /titles naming titles past 64 deep/) === 1 && refText(within).endsWith("X End Y") && !within.problems.length,
      [refText(deep).slice(-12), deep.problems.map((p) => p.name), refText(within).slice(-12), within.problems]);
    // (daybreak3, #682 r3: a title worked out where the depth cut met it is kept only for that depth: the first heading's
    //  chain reaches x with one level left and cuts x's own \nameref{y} (??); x named directly afterwards is only two
    //  titles deep, so it is x's whole title, "End", as TeX gives it (with the cut kept for every depth: "P ?? Q");
    //  the other order too)
    const chain = (first) => { let b = ""; for (let k = 0; k < 64; k++) b += "\\section{\\nameref{" + (k < 63 ? "c" + (k + 1) : "x") + "}}\\label{c" + k + "}";
      b += "\\section{\\nameref{y}}\\label{x}\\section{End}\\label{y}"; const deepRef = "D \\nameref{c0} E", direct = "P \\nameref{x} Q"; return b + (first === "deep" ? deepRef + " " + direct : direct + " " + deepRef); };
    const dFirst = refText(refDoc("", chain("deep"))), sFirst = refText(refDoc("", chain("direct")));
    check("ref-nameref-depth-cut-not-kept", /D End E P End Q$/.test(dFirst) && /P End Q D End E$/.test(sFirst), [dFirst.slice(-24), sFirst.slice(-24)]);
    // (daybreak3 R29, #682 r4: a hit on a title kept for its depth is depth-bound for the title that used it too. p0,
    //  the first heading, reaches x with one level left, its \nameref{y} cut, x kept for that depth; the q chain's
    //  heading, next, reaches x through b at that same depth and hits it, so b's title is kept for that depth only, not
    //  as b's whole title; b named directly is "End" (b kept as clean: "Q ?? R"). The lengths are exact: p0..p63 to x,
    //  q0..q62 to b, so both chains meet x with one level left)
    const r29 = (() => { const p = (k) => "\\section{\\nameref{" + (k < 63 ? "p" + (k + 1) : "x") + "}}\\label{p" + k + "}"; let b = p(0);
      for (let k = 0; k < 63; k++) b += "\\section{\\nameref{" + (k < 62 ? "q" + (k + 1) : "b") + "}}\\label{q" + k + "}";
      for (let k = 1; k < 64; k++) b += p(k);
      return refDoc("", b + "\\section{\\nameref{y}}\\label{x}\\section{End}\\label{y}\\section{\\nameref{x}}\\label{b}Q \\nameref{b} R"); })();
    check("ref-nameref-depth-hit-taints-caller", refText(r29).endsWith("Q End R") && said(r29, /titles naming titles past 64 deep/) === 1, [refText(r29).slice(-12), r29.problems.map((p) => p.name)]);
    const many = refDoc("", "\\section{" + "W ".repeat(3000) + "}\\label{w}" + "\\nameref{w} ".repeat(400)), manyH = many.chunks.join("");
    // (a literal title past NAME_MAX, no reference in it: shown cut, as said (astra, #682 r3))
    const lit = refDoc("", "\\section{" + "L".repeat(6000) + "}\\label{l}X \\nameref{l} Y"), litA = (lit.chunks.join("").match(/<a class="ref"[^>]*>([^<]*)<\/a>/) || [])[1] ?? "";
    check("ref-nameref-literal-cut-shown", litA.length === NAME_MAX + 1 && litA.endsWith("\u2026") && said(lit, /a title past 4096 characters, cut/) === 1, { len: litA.length, problems: lit.problems.map((p) => p.name) });
    check("ref-nameref-total-bounded", manyH.length < NAME_TOTAL + 64 * 1024 && said(many, /past 1048576 characters of titles in all/) === 1, { len: manyH.length, problems: many.problems.map((p) => p.name) });
  }
  // (a title naming another that has markup: the outer one's text is the inner's text, its markup stripped, never its
  //  HTML escaped as text (grader #682 R13))
  { const h = refDoc("", "\\section{An \\emph{Em} title}\\label{a}\\section{Cf.\\ \\nameref{a}}\\label{b}Z \\nameref{b} Q").chunks.join("");
    check("ref-nameref-nested-markup-stripped", /Z <a class="ref" href="#[^"]+">Cf\. An Em title<\/a> Q/.test(h) && !/&lt;span/.test(h), h.match(/Z .{0,120}/)); }
  // (and a title with no references in it keeps its markup in \nameref's link, as hyperref keeps it: \emph's italic)
  { const h = refDoc("", "\\section{An \\emph{Em} title}\\label{e}X \\nameref{e} Y").chunks.join("");
    check("ref-nameref-keeps-markup", /<a class="ref" href="#[^"]+">An <span class="it">Em<\/span> title<\/a>/.test(h), h.match(/X .{0,120}/)); }
  // (astra REF682-HTML-1: a theorem's name is the document's own text, escaped wherever \cref and \Cref name it, singular
  //  and plural; and a plain one named as TeX names it ("lemma 1", "Lemma 1", "lemmas 1 and 2", "Lemmas 1 and 2"))
  const evil = refDoc("\\newtheorem{evil}{<img src=x onerror=alert(1)>}", "\\begin{evil}\\label{x}A\\end{evil}\\begin{evil}\\label{y}B\\end{evil}P \\cref{x} Q \\Cref{x} R \\cref{x,y} S \\Cref{x,y}").chunks.join("");
  const lem = refText(refDoc("\\newtheorem{lemma}{Lemma}", "\\begin{lemma}\\label{l}A\\end{lemma}\\begin{lemma}\\label{m}B\\end{lemma}P \\cref{l} Q \\Cref{l} R \\cref{l,m} S \\Cref{l,m}"));
  check("ref-cref-theorem-name-escaped", !/<img/i.test(evil) && (evil.match(/&lt;img src=x onerror=alert\(1\)&gt;/g) || []).length >= 4, (evil.match(/&lt;img[^&]*/g) || []).length);
  check("ref-cref-theorem-name-plain", lem.endsWith("P lemma 1 Q Lemma 1 R lemmas 1 and 2 S Lemmas 1 and 2"), lem);
}

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
    // (Codex W05: a page break, as TeX's: \newpage, \clearpage, \cleardoublepage, \pagebreak (and [4]) each end the page
    //  there, the paragraph too; \pagebreak[n] below 4 is a hint: nothing, its [n] not shown as text; \nopagebreak nothing)
    ["newpage-breaks", "One.\\newpage Two.\n\n\\clearpage Three.\\cleardoublepage Four.\n\n\\pagebreak Five.\n\n\\pagebreak[4] Six.", (h) => count(h, NEWPAGE) === 5 && h.includes('One.</div>' + NEWPAGE + '<div class="p">Two.') && h.includes("Six.")],
    // (TeX: \pagebreak within a paragraph breaks the page after its line, the paragraph whole (TeX Live: "One.\pagebreak
    //  Two.\clearpage Three." is 2 pages, "One.Two." on the first: the space after a control word skipped))
    ["pagebreak-in-par", "One.\\pagebreak Two.\\clearpage Three.", (h) => count(h, NEWPAGE) === 1 && h.includes('One.Two.</div>' + NEWPAGE + '<div class="p">Three.')],
    // (no blank page: a break before anything, two in a row, or one after everything, is none, as in TeX)
    ["newpage-collapse", "\\newpage\\clearpage A.\\newpage\\newpage\n\n\\clearpage B.\\newpage", (h) => count(h, NEWPAGE) === 1 && h.includes('A.</div>' + NEWPAGE + '<div class="p">B.</div>') && !h.trimEnd().endsWith(NEWPAGE)],
    // (grader's #816 pins, each page layout TeX Live 2025's (pdflatex): "One.\pagebreak Two." then "Three." is 2 pages,
    //  "One.Two." | "Three." (N5); "A." then a paragraph of a tie and \pagebreak, then "B.", is 2 pages, "A." | "B.": the
    //  paragraph left empty, its break kept (N6); \mbox{C\pagebreak D}: one page, no break (N9). \newpage in a box
    //  isn't pinned: TeX errs ("Missing } inserted") and then breaks, which this doesn't (a known gap, in #816's body))
    ["pagebreak-par-only", "One.\\pagebreak Two.\n\nThree.", (h) => count(h, NEWPAGE) === 1 && h.includes('One.Two.</div>' + NEWPAGE + '<div class="p">Three.')],
    ["pagebreak-empty-par", "A.\n\n~\\pagebreak\n\nB.", (h) => count(h, NEWPAGE) === 1 && h.includes('A.</div>' + NEWPAGE + '<div class="p">B.')],
    ["pagebreak-in-mbox", "Before.\n\n\\mbox{C\\pagebreak D}\n\nAfter.", (h) => count(h, "newpage") === 0 && /C\s*D/.test(h.replace(/<[^>]+>/g, ""))],
    ["newpage-said", "A.\\newpage B.", (h) => h.includes('<div class="newpage" role="separator" aria-label="Page break"></div>')],
    ["pagebreak-hint", "A.\\pagebreak[2] B.\\nopagebreak C.\\pagebreak[0]D.\n\n\\pagebreak[3]\n\nE.", (h) => count(h, "newpage") === 0 && !h.includes("[2]") && !h.includes("[0]") && !h.includes("[3]") && /A\.\s*B\.\s*C\.\s*D\.\s*E\./.test(h.replace(/<[^>]+>/g, ""))],
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
  // short verbatim (#622): "|" made \verb by \MakeShortVerb or by the class (amsldoc's |\begin{aligned}| opened an
  // environment that took the rest of the document); \index reads "|" as makeindex's; plain "|" stays a character
  const V = (s) => '<code class="verb">' + s + "</code>";
  const shortv = [
    ["shortverb-class-amsldoc", "\\documentclass{amsldoc}\n", "using |\\!\\begin{aligned}| as before.\n\nAfter para.", (h) => h.includes(V("\\!\\begin{aligned}")) && h.includes("After para.")],
    ["shortverb-class-ltxdoc", "\\documentclass{ltxdoc}\n", "Text |x y| end.", (h) => h.includes(V("x y")) && h.includes("end.")],
    ["shortverb-class-l3doc-quote", "\\documentclass{l3doc}\n", 'A "\\cs_new:Npn" b.', (h) => h.includes(V("\\cs_new:Npn")) && h.includes("b.")],
    ["shortverb-make", "\\documentclass{article}\n\\usepackage{shortvrb}\\MakeShortVerb{\\|}\n", "A |\\begin{x}| b.\n\nNext.", (h) => h.includes(V("\\begin{x}")) && h.includes("Next.")],
    ["shortverb-make-bare-cs", "\\documentclass{article}\n\\MakeShortVerb\\+\n", "A +\\end{x}+ b.", (h) => h.includes(V("\\end{x}")) && h.includes("b.")],
    ["shortverb-define-fancyvrb", "\\documentclass{article}\n\\DefineShortVerb[commandchars=\\\\\\{\\}]{\\|}\n", "A |\\x| b.", (h) => h.includes(V("\\x")) && h.includes("b.")],
    ["shortverb-delete", "\\documentclass{article}\n\\MakeShortVerb{\\|}\n", "A |a| \\DeleteShortVerb{\\|}$|x|$ c.", (h) => h.includes(V("a")) && !h.includes(V("x")) && h.includes("c.")],
    ["shortverb-undefine", "\\documentclass{article}\n\\def\\p#1|{[#1]}\\DefineShortVerb{\\|}\n", "\\UndefineShortVerb{\\|}A|b| \\p cd|e.", (h) => !h.includes('class="verb"') && h.includes("A|b| [cd]e.")],
    ["shortverb-unterminated-line", "\\documentclass{ltxdoc}\n", "A |open to the line end\n\nNext para.", (h) => h === doc("\\documentclass{ltxdoc}\n", "A \\verb|open to the line end\n\nNext para.") && h.includes("Next para.")],
    ["shortverb-in-argument", "\\documentclass{ltxdoc}\n", "\\section{Use |\\foo|}\nText.", (h) => h.includes('class="verb"') && h.includes("\\foo") && h.includes("Text.")],
    ["shortverb-index-makeindex-bar", "\\documentclass{amsldoc}\n", "One.\\index{amsmath@\\texttt{amsmath} package|(}\n\nTwo |\\foo| x.", (h) => h.includes("One.") && h.includes(V("\\foo")) && h.includes("x.") && !h.includes("package|(")],
    ["shortverb-make-star", "\\documentclass{article}\n\\MakeShortVerb*{\\|}\n", "A |a b| c.", (h) => h.includes(V("a b")) && h.includes("c.") && !h.includes("*")],
    ["shortverb-make-twice-delete", "\\documentclass{article}\n\\MakeShortVerb{\\|}\\MakeShortVerb{\\|}\n", "A |a| \\DeleteShortVerb{\\|}b|c|d.", (h) => h.includes(V("a")) && !h.includes(V("c")) && h.includes("b|c|d.")],
    ["shortverb-arg-not-one-char", "\\documentclass{article}\n\\MakeShortVerb{\\foo}\n", "fine |text| here.", (h) => !h.includes('class="verb"') && h.includes("fine |text| here.")],
    ["shortverb-delete-restores-catcode", "\\documentclass{article}\n\\catcode`\\!=13 \\def!{BANG}\\DeleteShortVerb{\\!}\n", "x!y \\MakeShortVerb{\\!}\\DeleteShortVerb{\\!}\\MakeShortVerb{\\!}\\DeleteShortVerb{\\!}z!w", (h) => h.includes("xBANGy") && h.includes("zBANGw")],
    ["shortverb-remake-after-catcode", "\\documentclass{article}\n\\catcode`\\!=13 \\def!{BANG}\n", "\\MakeShortVerb{\\!}\\DeleteShortVerb{\\!}\\catcode`\\!=12 \\MakeShortVerb{\\!}\\DeleteShortVerb{\\!}a!b.", (h) => h.includes("a!b.") && !h.includes("BANG")],
    ["shortverb-macro-body", "\\documentclass{ltxdoc}\n", "\\newcommand{\\x}{A |q r| B}\\x.", (h) => h.includes(V("q r")) && h.includes("B.")],
    ["shortverb-macro-body-par", "\\documentclass{ltxdoc}\n", "\\long\\def\\y{|q\\par Z}\\y", (h) => h.includes(V("q")) && h.includes("Z") && !h.includes(V("q Z")) && !h.includes(V("q\\par Z"))],
    ["atbegindocument-deferred", "\\documentclass{article}\n\\usepackage{doc}\\AtBeginDocument{\\MakeShortVerb{\\|}}\\def\\q{a|b}\n", "\\q{} |x| y.", (h) => h.includes("a|b") && h.includes(V("x")) && h.includes("y.")],
    ["atbegindocument-in-order", "\\documentclass{article}\n\\AtBeginDocument{Hook1 }\\AtBeginDocument{Hook2 }\n", "Body.", (h) => /Hook1 Hook2 Body\./.test(h)],
    ["atbegindocument-in-document", "\\documentclass{article}\n", "Before \\AtBeginDocument{Now }after.", (h) => h.includes("Before Now after.")],
    ["atbegindocument-global-brace", "\\documentclass{article}\n{\\AtBeginDocument{Hook }}\n", "Body.", (h) => h.includes("Hook Body.")],
    ["atbegindocument-global-begingroup", "\\documentclass{article}\n\\begingroup\\AtBeginDocument{Hook }\\endgroup\n", "Body.", (h) => h.includes("Hook Body.")],
    ["atbegindocument-grouped-then-ungrouped", "\\documentclass{article}\n{\\AtBeginDocument{Hook1 }}\\AtBeginDocument{Hook2 }\n", "Body.", (h) => h.includes("Hook1 Hook2 Body.")],
    ["shortverb-make-global", "\\documentclass{article}\n{\\MakeShortVerb{\\|}}\n", "A |\\x| b.", (h) => h.includes(V("\\x")) && h.includes("b.")],
    ["shortverb-delete-global", "\\documentclass{article}\n\\def\\p#1|{[#1]}\\MakeShortVerb{\\|}\n", "{\\DeleteShortVerb{\\|}}A|b| \\p cd|e.", (h) => !h.includes('class="verb"') && h.includes("A|b| [cd]e.")],
    ["shortverb-none-plain-bar", "\\documentclass{article}\n", "Plain $|x|$ and a|b.", (h) => !h.includes('class="verb"') && h.includes("a|b.")],
  ];
  for (const [name, pre, body, ok] of shortv) { const h = doc(pre, body); check(name, ok(h), h.slice(0, 600)); }
  // \AtBeginDocument's hook is one token list (#631 LATEX631-HOOK-1): bounded as one, a refusal keeping the hook before;
  // each append's copy charged as work
  {
    const hookRun = (hooks, limits) => coldRun(new Map([["main.tex", "\\documentclass{article}\n" + hooks.map((x) => "\\AtBeginDocument{" + x + "}").join("") + "\n\\begin{document}\nBody.\n\\end{document}\n"]]), "main.tex", { Tmin: 100, limits });
    const hookLen = (r) => r.m.getS("m:sb@bdhook")?.body.length;
    const at = hookRun(["abcd", "efgh"], { tokenList: 8 }), over = hookRun(["abcd", "efghi"], { tokenList: 8 });
    check("atbegindocument-hook-at-bound", at.outcome === "ok" && hookLen(at) === 8, { outcome: at.outcome, len: hookLen(at) });
    check("atbegindocument-hook-one-over", over.outcome === "E-BOUND-TOKENS" && hookLen(over) === 4, { outcome: over.outcome, len: hookLen(over) });
    const many = Array.from({ length: 300 }, () => "x"), one = hookRun([many.join("")]), each = hookRun(many);
    const extra = each.counters.work - one.counters.work;   // (the 300 copies: 1 + 2 + ... + 300, less the one of 300)
    check("atbegindocument-hook-copies-charged", one.outcome === "ok" && each.outcome === "ok" && extra >= 300 * 301 / 2 - 300, { extra });
    // (memory: checked before the store, setS's 64 bytes included, so a refusal keeps the hook before; each
    //  document ends with its last append, so its run's total is exactly what that append needs)
    const bare = (hooks, limits) => coldRun(new Map([["main.tex", hooks.map((x) => "\\AtBeginDocument{" + x + "}").join("")]]), "main.tex", { Tmin: 100, limits });
    const memAll = bare(["abcd", "efgh"]).counters.memBytes, memOk = bare(["abcd", "efgh"], { memBytes: memAll }), memShort = bare(["abcd", "efgh"], { memBytes: memAll - 1 });
    check("atbegindocument-hook-memory-exact", memOk.outcome === "ok" && hookLen(memOk) === 8, { outcome: memOk.outcome, len: hookLen(memOk) });
    check("atbegindocument-hook-memory-one-short", memShort.outcome === "E-BOUND-MEMORY" && hookLen(memShort) === 4, { outcome: memShort.outcome, len: hookLen(memShort) });
    const capped = hookRun(many, { safetyWork: one.counters.work + 1000 });
    check("atbegindocument-hook-work-budget", capped.outcome === "E-BOUND-SAFETY" && hookRun([many.join("")], { safetyWork: one.counters.work + 1000 }).outcome === "ok", { outcome: capped.outcome });
  }
  // \long commands keep paragraphs (the kernel's \@footnotetext, \@caption, \thanks are \long); a short one with a
  // literal \par is a runaway, as in TeX; a short command that runs away is dropped before any effect
  const longs = [
    ["long-footnote-two-paragraphs", "Text\\footnote{First fn para.\n\nSecond fn para.} after.", (h) => !h.includes("not finished") && h.includes("First fn para.") && h.includes("Second fn para.") && h.includes("after.")],
    ["long-footnote-literal-par", "Text\\footnote{Alpha \\par Beta} after.", (h) => !h.includes("not finished") && h.includes("Beta") && h.includes("after.")],
    ["long-caption-two-paragraphs", "\\begin{figure}\\caption{Cap one.\n\nCap two.}\\end{figure}\nAfter.", (h) => !h.includes("not finished") && h.includes("Cap two.") && h.includes("After.")],
    ["long-thanks-two-paragraphs", "Text\\thanks{Th one.\n\nTh two.} After.", (h) => !h.includes("not finished") && h.includes("After.")],
    ["short-section-literal-par", "\\section{A \\par B}\nAfter.", (h) => h.includes("\\section{A") && h.includes("not finished") && h.includes("After.")],
    // (a counter of the test's own, read with \number: the renderer keeps its own section numbers, and \arabic and \the aren't
    // shown by this prototype; the two closed controls show the reading works)
    ["counter-stepcounter-control", "\\stepcounter{foo}Value: \\number\\csname c@foo\\endcsname.", (h) => !h.includes("not finished") && h.includes("Value: 1.")],
    ["counter-stepcounter-no-effect", "\\stepcounter{foo\n\nValue: \\number\\csname c@foo\\endcsname.", (h) => h.includes("\\stepcounter{foo not finished") && h.includes("Value: 0.")],
    ["counter-setcounter-control", "\\setcounter{foo}{5}Value: \\number\\csname c@foo\\endcsname.", (h) => !h.includes("not finished") && h.includes("Value: 5.")],
    ["counter-setcounter-multiarg-no-effect", "\\setcounter{foo\n\n{5}Value: \\number\\csname c@foo\\endcsname.", (h) => h.includes("\\setcounter{foo not finished") && h.includes("Value: 0.")],
    ["opt-newcounter-runaway", "\\newcounter{bar}[sec\n\nAfter opt.", (h) => h.includes("\\newcounter[sec") && h.includes("not finished") && h.includes("After opt.")],
    // (per argument, as the kernel reads them: a footnote's [n] is short, its text long; a \newenvironment's name, [n]
    // and [default] short, its bodies long; a \newcommand's name and [n] short, its [default] and body long)
    ["opt-footnote-runaway", "Before.\\footnote[1\n\nAfter words.\n\\section{Later}\nEnd text. Fn: \\number\\csname c@footnote\\endcsname.", (h) => h.includes("\\footnote[1 not finished") && h.includes("After words.") && h.includes("Later") && h.includes("Fn: 0.")],
    ["footnote-counter-control", "Before.\\footnote{Note.} Fn: \\number\\csname c@footnote\\endcsname.", (h) => !h.includes("not finished") && h.includes("Fn: 1.")],
    ["newenv-name-runaway", "\\newenvironment{boxy\n\nAfter env.", (h) => h.includes("\\newenvironment{boxy not finished") && h.includes("After env.")],
    ["newenv-default-runaway", "\\newenvironment{boxy}[1][x\n\nAfter env.", (h) => h.includes("\\newenvironment[x not finished") && h.includes("After env.")],
    ["newenv-long-bodies", "\\newenvironment{boxy}{Begin one.\n\nBegin two.}{End mark.}\\begin{boxy}Inside.\\end{boxy} After env.", (h) => !h.includes("not finished") && h.includes("Begin two.") && h.includes("Inside.") && h.includes("End mark.") && h.includes("After env.")],
    ["newcmd-name-runaway", "\\newcommand{\\foo\n\nAfter cmd.", (h) => h.includes("\\newcommand{\\foo") && h.includes("not finished") && h.includes("After cmd.")],
    ["newcmd-count-runaway", "\\newcommand{\\foo}[1\n\nAfter cmd.", (h) => h.includes("\\newcommand[1 not finished") && h.includes("After cmd.")],
    ["newcmd-long-default", "\\newcommand{\\foo}[1][Def one.\n\nDef two.]{(#1)}\\foo After cmd.", (h) => !h.includes("not finished") && h.includes("Def two.") && h.includes("After cmd.")],
    ["caption-long-optional", "\\begin{figure}\\caption[Short one.\n\nShort two.]{Cap text.}\\end{figure}\nAfter.", (h) => !h.includes("not finished") && h.includes("Cap text.") && h.includes("After.")],
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
  // the combination (astra4 POS-A4-1): the main file reads itself once, the inner read takes in many lines and returns
  // by \endinput (no \end{document} inside it), and the outer continuation reads those lines again. An edit then
  // resumes (A) from a checkpoint in the outer second pass, behind the lines the inner read marked; (B) from a
  // checkpoint inside the inner read. (Edits of the same length: offsets after them don't move, so reused events
  // compare with a cold run's as they are.) Each: the resume reached (the checkpoint's main readers as named), ok, no line
  // marked twice, and the same markers as a cold run of the edited text
  const P = Array.from({ length: 200 }, (_, k) => "Para " + k + " with several words.").join("\n\n");
  const self = "\\ifx\\sbdone\\undefined\\documentclass{article}\\fi\n\\ifx\\sbdone\\undefined\\begin{document}\\fi\nOuter start.\n" +
    // (the \input runs after its \fi, as \sbnext: no conditional is open during the inner read, so it has checkpoints)
    "\\ifx\\sbdone\\undefined\\def\\sbnext{\\input{main.tex}}\\else\\def\\sbnext{}\\fi\\def\\sbdone{}\\sbnext\n" + P + "\n\\ifx\\sbback\\undefined\\def\\sbback{}\\endinput\\fi\nOuter tail.\n\\end{document}\n";
  const c3 = coldRun(new Map([["main.tex", self]]), "main.tex", { Tmin: 100 });
  const a3 = posAts(c3);
  check("pos-reread-cold", c3.outcome === "ok" && dups(a3).length === 0 && a3.includes(self.indexOf("Para 150 ")) && a3.includes(self.indexOf("Outer tail.")), { outcome: c3.outcome, dups: dups(a3).slice(0, 5), n: a3.length });
  const mains = (ck) => ck.readers.filter((r) => r.path === "main.tex").length;
  const sorted = (a) => a.slice().sort((x, y) => x - y).join(",");
  for (const [name, word, repl, want] of [["pos-reread-resume-outer-pass", "Outer tail.", "Outer tall.", 1], ["pos-reread-resume-inner", "Para 150 ", "Pxra 150 ", 2]]) {
    const at = self.indexOf(word);
    const r = incremental(c3, { start: at, end: at + word.length, text: repl });
    const edited = self.slice(0, at) + repl + self.slice(at + word.length);
    const cold = coldRun(new Map([["main.tex", edited]]), "main.tex", { Tmin: 100 });
    const ai = posAts(r.res), ac = posAts(cold);
    const ck = r.stats.resumedFrom >= 0 ? c3.checkpoints[r.stats.resumedFrom] : null;
    check(name, r.stats.mode !== "full" && ck && mains(ck) === want && r.res.outcome === "ok" && cold.outcome === "ok" && dups(ai).length === 0 && sorted(ai) === sorted(ac),
      { mode: r.stats.mode, resumedFrom: r.stats.resumedFrom, mains: ck && mains(ck), outcome: r.res.outcome, dups: dups(ai).slice(0, 5), n: [ai.length, ac.length] });
  }
  // (astra4 POS-A4-2) the resume base must precede the END of the main file's consumed source, not the start of its
  // last token. Two edits in the inner pass, each just before a checkpoint, compared by rendered HTML with a cold run:
  //   - inside a control word (\oldname -> \olxname): astra4's case. In this core a line ending in a control word (or
  //     a comment) loads the next line inside readTok, so no checkpoint follows it: the case is guarded but not
  //     reachable, and the r3 guard passes it too (run-mutations.txt)
  //   - inside a line's trailing spaces: loadLine trims them, so the line-end token's offset is before them and
  //     before the newline; a space made "X" there passes seen < edit.start, and the r3 guard resumes after the line
  //     was read (reachable: the r3-guard mutation fails this case)
  {
    const html = (res) => render(res.units.flatMap((u) => u.ev || []), res.intern, {}).chunks.join("");
    const head = "\\ifx\\sbdone\\undefined\\documentclass{article}\\fi\n\\ifx\\sbdone\\undefined\\begin{document}\\fi\n" +
      "\\ifx\\sbdone\\undefined\\def\\oldname{OLD}\\def\\olxname{NEW}\\fi\nOuter start.\n" +
      "\\ifx\\sbdone\\undefined\\def\\sbnext{\\input{main.tex}}\\else\\def\\sbnext{}\\fi\\def\\sbdone{}\\sbnext\n";
    const tail = "After word.\n\n\\ifx\\sbback\\undefined\\def\\sbback{}\\endinput\\fi\nOuter tail.\n\\end{document}\n";
    for (const [name, mid, find, off, repl, want, gone] of [
      ["pos-reread-edit-inside-control-word", "Inner para one.\n\nInner para two.\n\n\\oldname\n\n", "\\oldname\n\n", 3, "x", "NEW", "OLD"],
      ["pos-reread-edit-in-trailing-spaces", "Inner para one.\n\nInner para two.   \n\n", "Inner para two.   \n", 16, "X", "two. X", null]]) {
      const cw = head + mid + tail;
      const c4 = coldRun(new Map([["main.tex", cw]]), "main.tex", { Tmin: 1 });
      const at = cw.indexOf(find) + off;
      const r = incremental(c4, { start: at, end: at + 1, text: repl });
      const edited = cw.slice(0, at) + repl + cw.slice(at + 1);
      const cold = coldRun(new Map([["main.tex", edited]]), "main.tex", { Tmin: 1, intern: c4.intern });
      const ck = r.stats.resumedFrom >= 0 ? c4.checkpoints[r.stats.resumedFrom] : null;
      const hi = html(r.res), hc = html(cold);
      check(name, c4.outcome === "ok" && r.stats.mode !== "full" && ck && mains(ck) === 2 && r.res.outcome === "ok" && cold.outcome === "ok" &&
        hi === hc && hc.split(want).length - 1 === 2 && (gone === null || !hc.includes(gone)) && dups(posAts(r.res)).length === 0,
        { mode: r.stats.mode, resumedFrom: r.stats.resumedFrom, mains: ck && mains(ck), outcome: r.res.outcome, same: hi === hc, inc: hi.slice(0, 260), cold: hc.slice(0, 260) });
    }
  }
  // (daybreak2 DB2-UX2-R4-1) many checkpoints whose high-water mark is on one long main line (an \input at its start
  // reads a file with many paragraphs): the line's end is found once per edit, not once per checkpoint
  {
    const longLine = "\\input{b}" + " word".repeat(100000);
    const sub2 = Array.from({ length: 300 }, (_, k) => "B para " + k + ".").join("\n\n") + "\n";
    const doc = "\\documentclass{article}\n\\begin{document}\n" + longLine + "\nTail line.\n\\end{document}\n";
    const c5 = coldRun(new Map([["main.tex", doc], ["b.tex", sub2]]), "main.tex", { Tmin: 1 });
    const at = doc.indexOf("Tail line.");
    const r = incremental(c5, { start: at, end: at + 4, text: "Tall" });
    const shared = c5.checkpoints.filter((k) => { const v = k.srcSeen.get("main.tex"); return v !== undefined && v > doc.indexOf("\\input{b}") && v < at; }).length;
    check("pos-guard-line-end-scanned-once", c5.outcome === "ok" && r.res.outcome === "ok" && shared >= 100 && r.stats.lineEndScans <= 3 && r.stats.lineEndScanned <= doc.length,
      { ckpts: c5.checkpoints.length, shared, scans: r.stats.lineEndScans, scanned: r.stats.lineEndScanned, n: doc.length, mode: r.stats.mode });
  }
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
    // (grader's N12: a page break's chunk begins where its \newpage is)
    {
      const t = "\\documentclass{article}\n\\begin{document}\nFirst words.\n\n\\newpage\nSecond words.\n\\end{document}\n";
      const r = new Engine().update(t), k = r.chunks.findIndex((c) => c === NEWPAGE);
      check("pos-newpage", k > 0 && r.chunkPos[k] === t.indexOf("\\newpage") && r.chunkPos[k + 1] === t.indexOf("Second words."), { k, pos: r.chunkPos[k], want: t.indexOf("\\newpage"), next: r.chunkPos[k + 1], chunks: r.chunks.length });
    }
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

// ---- boot.ts: on by default, on the hosts that serve the editor (William, Nov 2: no flag)
const SITE = ["sagebrush.space", "dev.sagebrush.space"];   // (the site build's hosts, as web/build.ts defines them)
check("on-site-hosts", latexOn("sagebrush.space", SITE) && latexOn("dev.sagebrush.space", SITE), null);
check("off-elsewhere", !latexOn("127.0.0.1", SITE) && !latexOn("localhost", SITE) && !latexOn("tauri.localhost", SITE), null);
check("off-lookalike-hosts", !latexOn("x.dev.sagebrush.space", SITE) && !latexOn("dev.sagebrush.space.evil", SITE) && !latexOn("sagebrush.space.evil", SITE), null);
check("test-hosts-only-in-list", latexOn("127.0.0.1", [...SITE, "127.0.0.1"]) && !latexOn("127.0.0.1", SITE), null);

// ---- the examples (examples.ts; William, Oct 29: "good tests to illustrate the breadth of editor support"): each one
// rendered by the pipeline the page uses, and its result recorded (one line each): it renders (outcome ok), with no
// command unknown to the preview and no "not finished" note, its key text shown, and what it can't do said in the
// document itself (sagetex: its code items found, not run; pythontex: the "not run" chip; tikz: the placeholder);
// the figure's image named and a real PNG
{
  setKatex((src, o) => '<span class="K' + (o.displayMode ? "D" : "I") + '">' + src.replace(/[&<>]/g, "") + "</span>");
  const want = {
    article: ["Sums of Squares", "Contents", "Theorem", "Proof"], beamer: ["A Short Talk", "Overlays", "Two columns", "A math slide"],
    sagetex: ["In this preview", "sagebrush latex run"], pythontex: ["In this preview", "Python item 2: not run"],
    matlab: ["MATLAB in LaTeX", "eig(A)"], figure: ["Figure 1", "The function"], cv: ["Ada Example", "Education", "Publications"],
    tikz: ["not rendered in this prototype"], bibliography: ["[1]", "Diamond"], homework: ["Homework 3", "(10 points)"],
  };
  const record = [];
  for (const ex of EXAMPLES) {
    const r = new Engine().update(ex.files[0][1]);
    const h = r.chunks.join(""), text = h.replace(/<[^>]+>/g, "").replace(/\s+/g, " ");
    const missing = (want[ex.id] ?? ["(no expectations)"]).filter((w) => !text.includes(w));
    const res = { id: ex.id, outcome: r.stats.outcome, unknown: r.stats.unknownCommands, notFinished: (h.match(/not finished/g) || []).length, sage: r.sageItems.length, images: r.imageRefs, missing };
    record.push(res);
    let ok = res.outcome === "ok" && res.unknown === 0 && res.notFinished === 0 && missing.length === 0;
    if (ex.id === "sagetex") ok &&= res.sage === 8;
    if (ex.id === "figure") {
      const png = ex.files.find(([n]) => n === "plot.png");
      const sn = png && sniffImage(Uint8Array.from(atob(png[1]), (c) => c.charCodeAt(0)));
      ok &&= JSON.stringify(res.images) === JSON.stringify(["plot.png"]) && !!png?.[2] && !!sn?.ok && sn.mime === "image/png";
    }
    check("example-" + ex.id, ok, res);
  }
  console.log("examples:", JSON.stringify(record));
  check("examples-ten", EXAMPLES.length === 10 && new Set(EXAMPLES.map((e) => e.id)).size === 10, EXAMPLES.map((e) => e.id));
}

// ---- comments.ts (cut 1): an anchor's quote and context; located at its offsets while they hold its quote, else at
// the nearest occurrence of the quote, else nowhere (null)
{
  const T = "Let n be even. Then n squared is even. Then we are done.";
  const a = makeAnchor(T, T.indexOf("Then"), T.indexOf("Then") + 4, "Then");
  check("cm-anchor", a.quote === "Then" && a.prefix === T.slice(Math.max(0, a.start - 32), a.start) && a.suffix === T.slice(a.end, a.end + 32) && a.shown === undefined, a);
  check("cm-anchor-shown", makeAnchor(T, 0, 3, "rendered math").shown === "rendered math" && makeAnchor("x".repeat(400), 0, 400).quote.length === 300);
  check("cm-locate-frozen", JSON.stringify(locate(a, T)) === JSON.stringify({ start: a.start, end: a.end }));
  const moved = "Intro. " + T;
  check("cm-locate-nearest", JSON.stringify(locate(a, moved)) === JSON.stringify({ start: moved.indexOf("Then"), end: moved.indexOf("Then") + 4 }), locate(a, moved));
  const far = makeAnchor(T, T.lastIndexOf("Then"), T.lastIndexOf("Then") + 4);
  check("cm-locate-nearest-of-two", locate(far, "x" + T).start === ("x" + T).lastIndexOf("Then"), locate(far, "x" + T));
  check("cm-locate-gone", locate(a, "Nothing of it here.") === null);
}

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

// ---- our stylesheets never style KaTeX's own classes (William, Nov 2: $n \neq 0$ with its slash below the "="; the
// preview's .rlap rule, for LaTeX's \rlap, also matched the .rlap KaTeX builds \not from): the classes the real KaTeX
// emits for math touching its boxes, against every class the preview's, the print and the standalone CSS select
{
  const { default: katex } = await import("katex");
  const { PAGE_CSS } = await import("./style.ts");
  const { readFileSync } = await import("node:fs");
  const literal = (file, name) => readFileSync(new URL(file, import.meta.url), "utf8").match(new RegExp("const " + name + " = `([^`]*)`"))?.[1] ?? "";
  const css = [PAGE_CSS, literal("./page.ts", "PRINT_CSS"), literal("../../src/latex-cli.ts", "STANDALONE_CSS")];
  const math = String.raw`a \neq b \not\in \notin \not= \not\subset \nleq \ne \boxed{x} \fbox{y} \cancel{x} \sout{x} \xrightarrow{a} \overbrace{ab}^c \sqrt[3]{x} \frac12 \binom{a}{b} \left(\frac ab\right) \widehat{xy} \vec v \overline{x} \colorbox{red}{x} \fcolorbox{red}{blue}{x} \mathbb{R} \text{hi} \operatorname{sp} \sum_{i=1}^n \int_0^1 \rlap{x} \llap{y} \mathrlap{z} \clap{z} \phantom{x} \smash{y} \raisebox{2pt}{x} \rule{1em}{1pt} \tag{1} \begin{matrix}a&b\\c&d\end{matrix} \begin{array}{|c|}a\\\hline b\end{array} \begin{cases}a\\b\end{cases} \begin{aligned}a&=b\\&=c\end{aligned} \stackrel{a}{=} \hspace{1em} \quad`;
  const emitted = new Set();
  for (const displayMode of [false, true]) for (const m of katex.renderToString(math, { displayMode, throwOnError: false, strict: false }).matchAll(/class="([^"]*)"/g)) for (const c of m[1].split(/\s+/)) if (c) emitted.add(c);
  const selected = new Set(css.flatMap((s) => [...s.replace(/\{[^}]*\}/g, "{}").matchAll(/\.([A-Za-z][\w-]*)/g)].map((m) => m[1])));
  // (the wrappers on purpose: .katex's size and color, .katex-display's margins, .katex-error's color)
  const allowed = new Set(["katex", "katex-display", "katex-error"]);
  const clash = [...emitted].filter((c) => selected.has(c) && !allowed.has(c));
  check("css-not-katex-classes", emitted.has("rlap") && emitted.has("fbox") && selected.has("tex-rlap") && clash.length === 0, { clash, emitted: emitted.size });
  // (and the renderer's own boxes use the prefixed classes)
  const h = new Engine().update("\\documentclass{article}\n\\begin{document}\n\\rlap{a}\\llap{b}\\fbox{c}\\framebox[2cm]{d}\n\\end{document}\n").chunks.join("");
  check("tex-boxes-prefixed", /class="tex-rlap"/.test(h) && /class="tex-llap"/.test(h) && /class="tex-fbox"/.test(h) && !/class="(fbox|rlap|llap)[ "]/.test(h), h.slice(0, 600));
}

// ---- \input and \include (William's L4, Nov 2: silently ignored, which broke his shared macros file): found as TeX
// finds them (inputs.ts, images.ts texCandidates), read from the host's snapshot; macros from them apply everywhere
// after; a file not read is a visible note, in the body or (from the preamble) at the top; a cycle stops with a note
{
  const { engineInputs, admitInput, INPUT_BOUNDS } = await import("./inputs.ts");
  const { texCandidates } = await import("./images.ts");
  const tc = texCandidates("macros", "/ex/doc.tex"), tc2 = texCandidates("../shared/defs.tex", "/ex/doc.tex"), tc3 = texCandidates("/top", "/ex/doc.tex");
  check("tex-candidates", tc.ok && tc.paths.join() === "/ex/macros.tex,/ex/macros" && tc2.ok && tc2.paths.join() === "/shared/defs.tex" && tc3.ok && tc3.paths[0] === "/top.tex" && !texCandidates("../../x", "/ex/doc.tex").ok, [tc, tc2, tc3]);
  const enc = (t) => new TextEncoder().encode(t);
  const known = new Map([
    ["/shared/macros.tex", admitInput(enc("\\newcommand{\\RR}{\\mathbb{R}}\n\\input{../shared/more}\n"), 0, 0)],
    ["/shared/more.tex", { text: "\\newcommand{\\NN}{\\mathbb{N}}\n" }],
    ["/ex/body.tex", { text: "Included body text $\\NN$.\n" }],
    ["/ex/loop.tex", { text: "x\\input{loop}" }],
    ["/ex/nope.tex", { absent: true }], ["/ex/nope", { absent: true }],
    ["/ex/gone.tex", { absent: true }], ["/ex/gone", { absent: true }],
    ["/ex/big.tex", { why: "too large" }],
  ]);
  const ei = engineInputs("/ex/doc.tex", known);
  const doc = "\\documentclass{article}\n\\input{../shared/macros}\n\\input{gone}\n\\begin{document}\nReals $\\RR$.\n\\include{body}\n\\input{nope}\n\\input{big}\n\\input{loop}\n\\end{document}\n";
  const r = new Engine().update(doc, { cold: true, inputs: { files: ei.files, resolve: ei.resolve, version: 1 } });
  const h = r.chunks.join("");
  check("input-macros-apply", /\\mathbb ?\{R\}/.test(h) && h.includes("Included body text") && /\\mathbb ?\{N\}/.test(h), h.slice(0, 900));
  check("input-missing-visible", h.includes("[input: nope: not found in &quot;ex/&quot;]") && h.includes("[input: big: too large]") && /Not read: \\input\{gone\}: not found in &quot;ex\/&quot;/.test(h), h.slice(0, 900));
  check("input-cycle-stopped", h.includes("an \\input cycle: stopped 16 deep") && r.stats.outcome === "ok", { outcome: r.stats.outcome, h: h.slice(-600) });
  check("input-problems", r.problems.some((p) => p.kind === "input" && p.name === "nope") && r.problems.some((p) => p.kind === "input" && p.name === "gone"), r.problems);
  check("input-refs", ["../shared/macros", "../shared/more", "body", "nope", "gone"].every((n) => r.inputRefs.includes(n)), r.inputRefs);
  // (what the host reads next: an unknown candidate, for each name, up to the first that might be it)
  const e2 = engineInputs("/ex/doc.tex", new Map([["/ex/a.tex", { absent: true }]]));
  check("input-wanted", JSON.stringify(e2.wanted(["a", "b", "../x/c.tex", "doc"])) === JSON.stringify(["/ex/a", "/ex/b.tex", "/x/c.tex"]) && e2.resolve("doc").key === "main.tex" && e2.resolve("b").why === "not read yet", e2.wanted(["a", "b", "../x/c.tex", "doc"]));
  check("input-admit", "why" in admitInput(new Uint8Array([0, 1]), 0, 0) && admitInput(enc("x"), INPUT_BOUNDS.total, 0).why === "too large" && /too many/.test(admitInput(enc("x"), 0, INPUT_BOUNDS.files).why), null);
  // (the same text, the inputs changed: expanded again from the start, with the new macro)
  const k2 = new Map(known); k2.set("/shared/more.tex", { text: "\\newcommand{\\NN}{\\mathbb{Z}}\n" });
  const ei2 = engineInputs("/ex/doc.tex", k2), eng = new Engine();
  eng.update(doc, { inputs: { files: ei.files, resolve: ei.resolve, version: 1 } });
  const r2 = eng.update(doc, { inputs: { files: ei2.files, resolve: ei2.resolve, version: 2 } });
  check("input-change-rerenders", r2.stats.mode === "cold" && /\\mathbb ?\{Z\}/.test(r2.chunks.join("")), r2.stats.mode);
}

// ---- envclose.ts (P1a): the close a "}" typed after \begin{X} adds, or none
{
  const at = (t) => [t.replace("|", ""), t.indexOf("|")];
  const ac = (t) => autoClose(...at(t));
  check("envclose-basic", ac("\\begin{itemize}|\n") === "\n\\end{itemize}", ac("\\begin{itemize}|\n"));
  check("envclose-indent-starred", ac("x\n  \\begin{align*}|") === "\n  \\end{align*}", ac("x\n  \\begin{align*}|"));
  check("envclose-trailing-blank-ok", ac("\\begin{enumerate}|   \nmore") === "\n\\end{enumerate}", null);
  check("envclose-not-before-text", ac("\\begin{itemize}|x") === null, null);
  check("envclose-not-a-comment", ac("% \\begin{itemize}|") === null && ac("a % b \\begin{x}|") === null, null);
  check("envclose-escaped-percent-is-not-a-comment", ac("50\\% \\begin{x}|") === "\n\\end{x}", ac("50\\% \\begin{x}|"));
  check("envclose-not-after-a-line-break", ac("a\\\\begin{x}|") === null && ac("\\\\\\begin{x}|") === "\n\\end{x}", [ac("a\\\\begin{x}|"), ac("\\\\\\begin{x}|")]);
  check("envclose-not-in-verbatim", ac("\\begin{verbatim}\n\\begin{x}|\n\\end{verbatim}") === null && ac("\\begin{sageblock}\n\\begin{x}|") === null, null);
  check("envclose-after-a-closed-verbatim", ac("\\begin{verbatim}\nv\n\\end{verbatim}\n\\begin{x}|") === "\n\\end{x}", null);
  check("envclose-existing-close-kept", ac("\\begin{x}|\n\n  \\end{x}") === null && ac("\\begin{x}|\n\\end{y}") === "\n\\end{x}", null);
  check("envclose-names-as-latex", ac("\\begin{foo2}|") === "\n\\end{foo2}" && ac("\\begin{foo-bar}|") === "\n\\end{foo-bar}" && ac("\\begin{foo:bar*}|") === "\n\\end{foo:bar*}" && ac("\\begin{a b}|") === null, [ac("\\begin{foo2}|"), ac("\\begin{foo-bar}|")]);
  check("envclose-commented-literal-is-text", ac("% \\begin{verbatim}\n\\begin{x}|") === "\n\\end{x}" && ac("a % b \\begin{lstlisting}\n\\begin{x}|") === "\n\\end{x}", ac("% \\begin{verbatim}\n\\begin{x}|"));
  check("envclose-escaped-literal-is-text", ac("\\\\begin{verbatim}\n\\begin{x}|") === "\n\\end{x}" && ac("\\\\\\begin{verbatim}\n\\begin{x}|") === null, [ac("\\\\begin{verbatim}\n\\begin{x}|"), ac("\\\\\\begin{verbatim}\n\\begin{x}|")]);
  // (DB3-P1A-2b: a % after an even run of backslashes starts a comment, after an odd run it is text: 0..5)
  {
    const got = [0, 1, 2, 3, 4, 5].map((k) => ac("\\".repeat(k) + "% \\begin{verbatim}\n\\begin{x}|"));
    check("envclose-comment-backslash-parity", JSON.stringify(got) === JSON.stringify(["\n\\end{x}", null, "\n\\end{x}", null, "\n\\end{x}", null]), got);
  }
  check("envclose-percent-inside-verbatim-is-text", ac("\\begin{verbatim}\n% \\end{verbatim}\n\\begin{x}|") === "\n\\end{x}", null);
  check("envclose-only-on-brace", autoClose("\\begin{x", 8) === null && ac("\\begin{x}{cc}|") === null && ac("\\end{x}|") === null, null);
}

// ---- doc.ts's readCapped (#656, astra DOC656-FETCH-1): a published document's body read at most `max` bytes, chunk by
//      chunk, cancelled at the chunk that crosses it, never read whole first; Content-Length an early refusal only.
//      Each case: what it returns, how many chunks were pulled, and whether the stream was cancelled
{
  const { readCapped } = await import("./doc.ts");
  // (a body of `chunks` chunks of `size` bytes, its pulls counted, its cancel seen; `len`: a Content-Length to claim)
  const body = (chunks, size, len) => {
    const st = { pulled: 0, cancelled: false };
    const stream = new ReadableStream({
      pull(c) { if (st.pulled === chunks) return c.close(); st.pulled++; c.enqueue(new Uint8Array(size).fill(65)); },
      cancel() { st.cancelled = true; },
    }, { highWaterMark: 0 });
    return { st, r: new Response(stream, len === undefined ? {} : { headers: { "content-length": String(len) } }) };
  };
  const at = async (chunks, size, max, len) => { const b = body(chunks, size, len), got = await readCapped(b.r, max); return { n: got ? got.length : null, ...b.st }; };
  const exact = await at(4, 256, 1024), over = await at(4, 256, 1023);
  check("doc-read-capped-exact-and-one-over", exact.n === 1024 && exact.pulled === 4 && !exact.cancelled && over.n === null && over.pulled === 4 && over.cancelled, { exact, over });
  // (16 chunks of 1 MiB with no Content-Length, against 4 MiB: stopped at the 5th, cancelled, the rest never pulled)
  const chunked = await at(16, 2 ** 20, 4 * 2 ** 20);
  check("doc-read-capped-chunked-no-length", chunked.n === null && chunked.pulled === 5 && chunked.cancelled, chunked);
  // (a header that understates the body: counted, not trusted; one over the cap: refused before any pull; one exactly at
  //  it: read (grader C5))
  const lies = await at(16, 2 ** 20, 4 * 2 ** 20, 1000), says = await at(16, 2 ** 20, 4 * 2 ** 20, 16 * 2 ** 20), atCap = await at(4, 256, 1024, 1024);
  check("doc-read-capped-false-and-oversize-header", lies.n === null && lies.pulled === 5 && lies.cancelled && says.n === null && says.pulled === 0 && says.cancelled && atCap.n === 1024 && !atCap.cancelled, { lies, says, atCap });
  // (the bytes kept, in order, across chunks; an empty body)
  const two = await readCapped(new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array([1, 2])); c.enqueue(new Uint8Array([3])); c.close(); } })), 3), none = await readCapped(new Response(null), 3);
  check("doc-read-capped-bytes", JSON.stringify(Array.from(two ?? [])) === "[1,2,3]" && none?.length === 0, [two, none]);
}

// ---- src/latex-cli.ts's removeTemp: the CLI's scratch folders (the browser's profile, a run's folder) removed, retried, and
//      never an error, so a render that worked isn't reported failed because a helper process still wrote into its
//      profile (a CI flake on #672: png_error "ENOTEMPTY, Directory not empty")
{
  const { removeTemp } = await import("../../src/latex-cli.ts");
  const { mkdtempSync, writeFileSync, existsSync, mkdirSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  let opts = null, threw = false, ok;
  try { ok = removeTemp("/nowhere", (d, o) => { opts = o; const e = new Error("ENOTEMPTY: directory not empty"); e.code = "ENOTEMPTY"; throw e; }); } catch { threw = true; }
  check("cli-remove-temp-never-throws", !threw && ok === false && opts?.recursive === true && opts?.force === true && opts?.maxRetries > 0, { threw, ok, opts });
  const d = mkdtempSync(join(tmpdir(), "sb-rt-")); mkdirSync(join(d, "sub")); writeFileSync(join(d, "sub", "f"), "x");
  check("cli-remove-temp-removes", removeTemp(d) === true && !existsSync(d), existsSync(d));
  // (and every scratch folder of the CLI goes through it: no direct rmSync of the profile or a run's folder left)
  const src = (await import("node:fs")).readFileSync(new URL("../../src/latex-cli.ts", import.meta.url), "utf8");
  check("cli-remove-temp-used", !/rmSync\((tmp|profile)\b/.test(src) && (src.match(/removeTemp\((tmp|profile)\)/g) || []).length === 3, src.match(/rmSync\([a-z]+/g));
}

const failed = results.filter(([, ok]) => !ok).map(([n]) => n);
console.log(failed.length ? `FAIL: ${failed.length} of ${results.length}: ${failed.join(", ")}` : `ok: the LaTeX editor's units, ${results.length} checks`);
process.exit(failed.length ? 1 : 0);
